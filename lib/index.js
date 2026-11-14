/**
 * dsh-session-rotate —— 上下文自动轮换（安全阀）
 *
 * 为什么需要它：DSH 的会话是「一条日志吃到死」的，模型每走一步都会把前面的上下文重发一遍。
 * billion-context 只能压缩「已经聊过的部分」，一旦日志本身长到接近窗口上限，连压缩请求自己都超窗，
 * 会话就死锁了（2026-11-14 的 session-f27e88f8 就是这么废掉的）。
 * 唯一稳妥的办法是：在还没撑爆之前，把上下文搬到一个新会话里，旧的照样封存。
 *
 * 本插件做的事（每 intervalMs 扫一遍）：
 *   1. 先按字节粗估水位；超过 warnTokens 才做一次精确读数（流式解压日志，取最后一次 usage.totalTokens）；
 *   2. 超过 warnTokens：只记一条日志，提示该换会话了；
 *   3. 超过 rotateTokens 且会话已经安静 activeGraceMs（不在正在跑的轮次里）：
 *        a. 扫日志尾部，自动摘录「用户说过什么 / 助手最后说了什么 / 动过哪些文件 / 跑过哪些命令」，
 *           写成交接文件 handoffs/<sid>-<ts>.md；
 *        b. 把整个会话目录备份到 backups/<sid>-<ts>/；
 *        c. （可选）先让压缩器小切一次 precut，水位回落就放弃轮换；
 *        d. 用 sessionController.agents.createSession() 在原目录开一个新会话；
 *        e. 往新会话里塞一条开局消息，告诉它交接文件在哪、要接着干什么；
 *        f. 用 workspaceController.archiveSession() 把旧会话归档（彻底停用，不再出现在侧栏）。
 *   4. 全过程写 audit.log，出错只记日志，绝不把 Host 拖垮。
 *
 * 所有动作都在 try/catch 里；apply() 本身不会抛异常。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile, cp, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'session-rotate';
export const inject = ['sessionController', 'workspaceController'];

/** 默认配置；patch 里的 config 会覆盖这里。 */
const DEFAULTS = {
  enabled: true,
  intervalMs: 60_000,
  warnTokens: 200_000,
  rotateTokens: 350_000,
  /** zstd 日志字节 → token 的兜底系数（用 2026-11-14 的真实数据标定：15,598,487 字节 ≈ 1,746,361 tokens）。 */
  tokensPerByte: 0.112,
  /** 文件在这段时间内被写过，就认为正在对话中，这轮先不动它。 */
  activeGraceMs: 600_000,
  /** true：自动开新会话并归档旧的；false：只写交接 + 备份（演练）。 */
  autoRotate: true,
  /** true：只算不落盘，用来观察阈值是否合理。 */
  dryRun: false,
  /** 这些 sessionId 永不轮换。 */
  exclude: [],
  /** 数据根目录，默认 ~/.dsh/session-rotate。 */
  root: null,
  /** 会话根目录，默认 ~/.dsh/sessions（一般不用改，测试时才有用）。 */
  sessionsRoot: null,
  /** 精确读数：超过这个字节数才去解压日志（解压 47MB 约几百毫秒，贵，所以先按字节挡一道）。 */
  accurateScanMinBytes: 1_500_000,
  /** 历史峰值超过这个数也轮换：这种会话已经证明自己压不动了，留着就是等死锁。 */
  peakRotateTokens: 525_000,
  /** 启动后首次扫描的延迟，默认 5s，别和 Host 启动抢 IO。 */
  initialDelayMs: 5_000,
  /** 交接文件里保留多少条最近消息/文件/命令。 */
  handoff: { messages: 5, files: 10, commands: 5, chars: 240 },
  /**
   * 轮换前先让压缩器小切一次。装了 Live-Compact / billion-context 之类的压缩器后，
   * 把 service / method 指过去；水位回落到 rotateTokens × precut.acceptRatio 以下就放弃轮换。
   */
  precut: { enabled: false, service: null, method: null, timeoutMs: 90_000, acceptRatio: 0.85 },
};

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 从工具参数里挑出文件路径（file_path / path / 命令里的盘符路径）。 */
function pickFiles(argText) {
  const out = [];
  let args = null;
  try { args = JSON.parse(argText); } catch { /* 不是 JSON 就算了 */ }
  if (args && typeof args === 'object') {
    for (const key of ['file_path', 'filePath', 'path', 'target', 'output', 'to', 'from']) {
      if (typeof args[key] === 'string') out.push(args[key]);
    }
  }
  const text = String(argText ?? '').replace(/\\\\/g, '\\');
  const win = /[A-Za-z]:\\[^\s"'<>|]*?\.[A-Za-z0-9]{1,5}\b/g;
  const posix = /(?<![\w:/])\/[^\s"'<>|:]*?\.[A-Za-z0-9]{1,5}\b/g;
  for (const m of text.matchAll(win)) out.push(m[0]);
  for (const m of text.matchAll(posix)) out.push(m[0]);
  return out.map((p) => p.replace(/\\\\/g, '\\')).filter((p) => !p.startsWith('//'));
}

/** 运行时注入的噪声（不是用户真的说的话），摘交接时跳过。 */
const NOISE = [/^Current runtime context/i, /^Time sampled while preparing/i, /^Browser time zone for this request/i];

/**
 * 流式读一遍会话日志，收集交接需要的材料。
 * 返回 { header, tokens, usage, turns, users[], assistant, files[], commands[], events }
 */
async function scanSession(file) {
  // 整份解压：zstd 流式解压会在第一个 frame 结束时就收尾，读不全（实测只拿到 1/8 的日志）。
  // 阈值触发时一次性解压，代价几百毫秒，按 size+mtime 缓存，不会反复付。
  let text;
  try {
    text = zstdDecompressSync(await readFile(file)).toString('utf8');
  } catch {
    try { text = (await readFile(file)).toString('utf8'); } catch { text = ''; }
  }

  let header = null;
  const state = {
    header,
    usage: null,
    tokens: 0,
    peak: 0,
    turns: 0,
    events: 0,
    users: [],
    assistant: null,
    files: [],
    commands: [],
  };

  const lines = text.split('\n');
  if (lines.length) {
    try { header = JSON.parse(lines[0]); } catch { header = null; }
  }
  state.header = header ?? state.header;

  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    state.events += 1;
    const t = e.type;
    if (t === 'turn/start') state.turns += 1;
    if (e.data?.usage) {
      state.usage = e.data.usage;
      const total = Number(e.data.usage.totalTokens)
        || (Number(e.data.usage.inputTokens) || 0) + (Number(e.data.usage.cacheReadTokens) || 0) + (Number(e.data.usage.cacheWriteTokens) || 0);
      if (total > state.peak) state.peak = total;
    }
    if (t === 'user/message') {
      const msg = (e.data?.content ?? []).map((p) => p?.text ?? '').join('\n').trim();
      if (msg && !NOISE.some((re) => re.test(msg))) {
        state.users.push(msg);
        if (state.users.length > 30) state.users.shift();
      }
    } else if (t === 'assistant/message') {
      const msg = (e.data?.message?.content ?? []).filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('\n');
      if (msg) state.assistant = msg;
    } else if (t === 'tool/call') {
      const name = e.data?.name ?? '';
      const argText = typeof e.data?.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data?.arguments ?? '');
      for (const f of pickFiles(argText)) {
        state.files.push(f);
        if (state.files.length > 60) state.files.shift();
      }
      if (name) {
        let brief = '';
        try {
          const a = JSON.parse(argText);
          brief = a?.description ?? a?.command ?? a?.pattern ?? a?.query ?? '';
        } catch { /* ignore */ }
        state.commands.push({ name, brief: clip(brief, 160) });
        if (state.commands.length > 40) state.commands.shift();
      }
    }
  }

  const u = state.usage;
  state.tokens = u ? (Number(u.totalTokens) || (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0)) : 0;
  return state;
}

function handoffText({ sessionId, scan, tokens, newSessionId, ts, cfg }) {
  const h = scan.header ?? {};
  const n = cfg.handoff;
  const users = scan.users.slice(-n.messages).map((t) => `- ${clip(t, n.chars)}`);
  const files = [...new Set(scan.files)].slice(-n.files).map((f) => `- \`${f}\``);
  const cmds = scan.commands.slice(-n.commands).map((c) => `- \`${c.name}\`${c.brief ? `：${c.brief}` : ''}`);
  const lines = [
    `# 会话交接（自动轮换 ${ts}）`,
    '',
    `- 旧会话：\`${sessionId}\``,
    `- 上下文水位：最近一次请求约 ${tokens.toLocaleString('en-US')} tokens，历史峰值 ${
      (scan.peak ?? 0).toLocaleString('en-US')
    } tokens（日志 ${scan.events} 条事件 / ${scan.turns} 个轮次）`,
    `- 工作目录：\`${h.cwd ?? '(未知)'}\``,
    `- 人设预设：\`${h.agentPreset ?? '(默认)'}\``,
    `- 新会话：\`${newSessionId ?? '(未创建)'}\``,
    '',
    '## 接手须知',
    '',
    '1. 旧会话已原样备份并归档，记录不会丢，但**不要**再去续聊它（它已经超出可用窗口）。',
    '2. 需要旧细节时读备份目录（`~/.dsh/session-rotate/backups/<会话>-<时间>/`），也可用 `bili export` 导出成 Markdown。',
    '3. 下面是自动摘录，**不是**模型总结：可能缺上下文、也可能过时。动手前先跟用户确认。',
    '',
    '## 用户最近说过什么（从旧到新）',
    '',
    ...(users.length ? users : ['(没摘到用户消息)']),
    '',
    '## 助手最后说的话',
    '',
    scan.assistant ? clip(scan.assistant, n.chars * 3) : '(没摘到助手消息)',
    '',
    '## 最近动过的文件',
    '',
    ...(files.length ? files : ['(没摘到文件路径)']),
    '',
    '## 最近跑过的命令/工具',
    '',
    ...(cmds.length ? cmds : ['(没摘到工具调用)']),
    '',
    '## 下一步',
    '',
    '先跟用户确认要接着做什么，再动手；不确定就问，不要猜。',
    '',
  ];
  return lines.join('\n');
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}), handoff: { ...DEFAULTS.handoff, ...(config?.handoff ?? {}) }, precut: { ...DEFAULTS.precut, ...(config?.precut ?? {}) } };
  const root = cfg.root || path.join(homedir(), '.dsh', 'session-rotate');
  const dirs = {
    root,
    handoffs: path.join(root, 'handoffs'),
    backups: path.join(root, 'backups'),
    state: path.join(root, 'state.json'),
    audit: path.join(root, 'audit.log'),
  };
  const excluded = new Set(cfg.exclude ?? []);
  let state = { rotated: {}, warned: {} };
  let busy = false;
  /** 精确读数缓存：file -> { key, tokens, scan } */
  const scanCache = new Map();

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try { ctx.logger?.info?.(`session-rotate: ${msg}`); } catch { /* ignore */ }
    appendFile(dirs.audit, line + '\n', 'utf8').catch(() => {});
  };

  async function loadState() {
    try {
      state = JSON.parse(await readFile(dirs.state, 'utf8'));
    } catch {
      state = { rotated: {}, warned: {} };
    }
    state.rotated ??= {};
    state.warned ??= {};
  }

  async function saveState() {
    try {
      await writeFile(dirs.state, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`state 写入失败：${String(error)}`);
    }
  }

  /** 列出吊销会话：~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd */
  async function listSessions() {
    const sessionsRoot = cfg.sessionsRoot || path.join(homedir(), '.dsh', 'sessions');
    const found = [];
    let workspaces = [];
    try {
      workspaces = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      let entries = [];
      try {
        entries = await readdir(path.join(sessionsRoot, ws.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(sessionsRoot, ws.name, entry.name);
        for (const fileName of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          const file = path.join(dir, fileName);
          try {
            const info = await stat(file);
            found.push({ sessionId: entry.name, dir, file, bytes: info.size, mtimeMs: info.mtimeMs });
            break;
          } catch { /* 换下一个候选文件名 */ }
        }
      }
    }
    return found;
  }

  /**
   * 粗估水位；需要时才做精确扫描。
   * tokens = 最近一次请求的真实上下文；peak = 历史峰值（压缩请求自身也会推高它）。
   * 字节粗估只在没有 usage 时兜底——压缩过的会话，字节数会远高于真实水位。
   */
  async function measure(item) {
    const coarse = Math.round(item.bytes * cfg.tokensPerByte);
    if (item.bytes < cfg.accurateScanMinBytes) return { tokens: coarse, peak: 0, scan: null };
    const key = `${item.bytes}:${item.mtimeMs}`;
    const cached = scanCache.get(item.file);
    if (cached && cached.key === key) return cached;
    const scan = await scanSession(item.file);
    const tokens = scan.tokens || coarse;
    const value = { tokens, peak: scan.peak || 0, scan, key };
    scanCache.set(item.file, value);
    return value;
  }

  /** 需要轮换吗：最近水位过线，或历史峰值过高（一次没压好就会死锁）。 */
  function needsRotate({ tokens, peak, scan }) {
    if (tokens >= cfg.rotateTokens) return true;
    if (!scan) return false;
    return peak >= cfg.peakRotateTokens;
  }

  /** 轮换前试着让压缩器小切一次；回落到可接受水位就放弃轮换。 */
  async function tryPrecut(sessionId, tokens) {
    const p = cfg.precut ?? {};
    if (!p.enabled || !p.service || !p.method) return null;
    const svc = ctx[p.service];
    const fn = svc?.[p.method];
    if (typeof fn !== 'function') {
      log(`precut：ctx.${p.service}.${p.method} 不存在，跳过小切`);
      return null;
    }
    try {
      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), p.timeoutMs).unref?.());
      const run = Promise.resolve(fn.call(svc, { sessionId })).then((r) => r ?? 'ok', (e) => `error:${String(e)}`);
      const result = await Promise.race([run, timeout]);
      log(`precut：${p.service}.${p.method} => ${typeof result === 'string' ? result : 'ok'}`);
      return result;
    } catch (error) {
      log(`precut 失败：${String(error)}`);
      return null;
    }
  }

  /** 轮换一个会话。任何一步失败都只记日志，不抛。 */
  async function rotate(item, tokens, scan) {
    const { sessionId, dir } = item;
    const ts = stamp();

    if (cfg.dryRun) {
      log(`[dry-run] ${sessionId} 约 ${tokens} tokens（阈值 ${cfg.rotateTokens}），本该轮换`);
      return;
    }

    // 先试小切
    if (cfg.precut?.enabled) {
      await tryPrecut(sessionId, tokens);
      try {
        const fresh = await stat(item.file).catch(() => null);
        const again = fresh
          ? await measure({ ...item, bytes: fresh.size, mtimeMs: fresh.mtimeMs })
          : { tokens };
        const floor = Math.round(cfg.rotateTokens * (cfg.precut.acceptRatio ?? 0.85));
        if (again.tokens <= floor) {
          log(`${sessionId} 小切后水位降到约 ${again.tokens} tokens（≤ ${floor}），本轮不轮换`);
          state.warned[sessionId] = { ts, tokens: again.tokens, precut: true };
          await saveState();
          return;
        }
        log(`${sessionId} 小切后仍是约 ${again.tokens} tokens（> ${floor}），继续轮换`);
      } catch (error) {
        log(`precut 后复测失败，继续轮换：${String(error)}`);
      }
    }

    const info = scan ?? (await measure(item)).scan;

    // a. 交接文件
    await mkdir(dirs.handoffs, { recursive: true });
    const handoffPath = path.join(dirs.handoffs, `${sessionId}-${ts}.md`);
    await writeFile(handoffPath, handoffText({ sessionId, scan: info ?? {}, tokens, newSessionId: null, ts, cfg }), 'utf8');

    // b. 整目录备份（原样副本，不动原文件）
    await mkdir(dirs.backups, { recursive: true });
    const backupDir = path.join(dirs.backups, `${sessionId}-${ts}`);
    await cp(dir, backupDir, { recursive: true, force: true });
    log(`${sessionId} 已备份到 ${backupDir}（交接 ${handoffPath}）`);

    if (!cfg.autoRotate) {
      state.warned[sessionId] = { ts, tokens, handoff: handoffPath };
      await saveState();
      log(`${sessionId} 只做了交接 + 备份（autoRotate=false），没动会话本身`);
      return;
    }

    const cwd = info?.header?.cwd || process.cwd();
    const agentPreset = info?.header?.agentPreset;

    // c. 开新会话（同一目录、同一人设预设）
    let newSessionId = null;
    try {
      const created = await ctx.sessionController.agents.createSession({ cwd, agentPreset });
      newSessionId = created?.agent?.session?.id ?? null;
      if (!newSessionId) throw new Error('createSession 没有返回 session id');
      log(`已新建会话 ${newSessionId}（cwd=${cwd}）`);
    } catch (error) {
      log(`新建会话失败，保留旧会话不动：${String(error)}`);
      await saveState();
      return;
    }

    // d. 把交接信息塞进新会话
    try {
      const text = [
        `【自动轮换 ${ts}】这个会话是从旧的 \`${sessionId}\` 接手的。`,
        `旧会话上下文已到约 ${tokens.toLocaleString('en-US')} tokens，已备份并归档，别再去找它续聊。`,
        `交接文件：${handoffPath}`,
        `旧日志备份：${backupDir}`,
        '',
        '先读交接文件（路径见上），跟用户确认接着做什么，再开始动手。',
      ].join('\n');
      await ctx.sessionController.prompt({
        sessionId: newSessionId,
        mode: 'queue',
        requestId: randomUUID(),
        clientTimeZone: 'Asia/Shanghai',
        content: [{ type: 'text', text }],
      });
      log(`已向 ${newSessionId} 投递开局交接消息`);
    } catch (error) {
      log(`开局消息投递失败（新会话已建好，可手动开聊）：${String(error)}`);
    }

    // e. 归档旧会话 = 彻底停用
    try {
      await ctx.workspaceController.archiveSession({ sessionId, stopActivity: true });
      log(`已归档旧会话 ${sessionId}`);
    } catch (error) {
      log(`归档失败（备份已在，可手动处理）：${String(error)}`);
    }

    state.rotated[sessionId] = { ts, tokens, peak: scan?.peak ?? 0, newSessionId, handoff: handoffPath, backup: backupDir };
    delete state.warned[sessionId];
    await saveState();
  }

  async function tick() {
    if (busy || !cfg.enabled) return;
    busy = true;
    try {
      await loadState();
      const sessions = await listSessions();
      for (const item of sessions) {
        const { sessionId } = item;
        if (excluded.has(sessionId) || state.rotated[sessionId]) continue;
        let measured;
        try {
          measured = await measure(item);
        } catch (error) {
          log(`${sessionId} 读数失败，按字节粗估：${String(error)}`);
          measured = { tokens: Math.round(item.bytes * cfg.tokensPerByte), peak: 0, scan: null };
        }
        const { tokens, peak, scan } = measured;
        const pressure = Math.max(tokens, peak);
        if (needsRotate(measured)) {
          if (Date.now() - item.mtimeMs < cfg.activeGraceMs) {
            state.warned[sessionId] = { ts: stamp(), tokens, peak, pending: true };
            continue;
          }
          const why = tokens >= cfg.rotateTokens ? '最近水位' : '历史峰值';
          log(`${sessionId} 触发轮换（${why}：最近 ${tokens} / 峰值 ${peak}）`);
          await rotate(item, tokens, scan);
        } else if (pressure >= cfg.warnTokens && !state.warned[sessionId]) {
          state.warned[sessionId] = { ts: stamp(), tokens, peak };
          log(`提醒：${sessionId} 已到 ${pressure.toLocaleString('en-US')} tokens（最近 ${tokens.toLocaleString('en-US')} / 峰值 ${peak.toLocaleString('en-US')}，阈值 ${cfg.warnTokens}），下次空闲就会轮换`);
        }
      }
      await saveState();
    } catch (error) {
      log(`扫描失败：${String(error)}`);
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => {
    let timer = null;
    let disposed = false;
    const start = async () => {
      await mkdir(dirs.root, { recursive: true });
      log(`已启动：阈值 ${cfg.rotateTokens} tokens / 每 ${Math.round(cfg.intervalMs / 1000)}s 扫描一次${cfg.dryRun ? '（dry-run）' : ''}${cfg.precut?.enabled ? `；轮换前先试 ${cfg.precut.service}.${cfg.precut.method}` : ''}`);
      // 首次延迟一点，别和 Host 启动抢 IO
      setTimeout(() => { if (!disposed) tick(); }, cfg.initialDelayMs).unref?.();
      timer = setInterval(() => tick(), cfg.intervalMs);
      timer.unref?.();
    };
    start().catch((error) => log(`启动失败：${String(error)}`));
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, 'session-rotate: 定时扫描');
}
