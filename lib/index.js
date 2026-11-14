/**
 * dsh-session-rotate 鈥斺€?涓婁笅鏂囪嚜鍔ㄨ疆鎹? *
 * 涓轰粈涔堥渶瑕佸畠锛欴SH 鐨勪細璇濇槸銆屼竴鏉℃棩蹇楀悆鍒版銆嶇殑锛屾ā鍨嬫瘡璧颁竴姝ラ兘浼氭妸鍓嶉潰鐨勪笂涓嬫枃閲嶅彂涓€閬嶃€? * billion-context 鍙兘鍘嬬缉銆屽凡缁忚亰杩囩殑閮ㄥ垎銆嶏紝涓€鏃︽棩蹇楁湰韬暱鍒版帴杩戠獥鍙ｄ笂闄愶紝杩炲帇缂╄姹傝嚜宸遍兘瓒呯獥锛? * 浼氳瘽灏辨閿佷簡锛?026-11-14 鐨?session-f27e88f8 灏辨槸杩欎箞搴熸帀鐨勶級銆? * 鍞竴绋冲Ε鐨勫姙娉曟槸锛氬湪杩樻病鎾戠垎涔嬪墠锛屾妸涓婁笅鏂囨惉鍒颁竴涓柊浼氳瘽閲岋紝鏃х殑鍘熸牱灏佸瓨銆? *
 * 鏈彃浠跺仛鐨勪簨锛堟瘡涓?intervalMs 鎵竴閬嶏級锛? *   1. 浼扮畻姣忎釜浼氳瘽鐨?token 閲忥紙缁撴瀯鍖栨棩蹇楁槸 zstd 鍘嬬缉鐨勶紝鐢ㄥ瓧鑺傛暟 脳 绯绘暟鎹㈢畻锛夛紱
 *   2. 瓒呰繃 warnTokens锛氬彧璁颁竴鏉℃棩蹇楋紝鎻愰啋璇ユ崲浼氳瘽浜嗭紱
 *   3. 瓒呰繃 rotateTokens 涓旇浼氳瘽宸茬粡瀹夐潤浜嗕竴娈垫椂闂达紙涓嶅湪姝ｅ湪璺戠殑杞閲岋級锛? *        a. 瑙ｅ嚭浼氳瘽澶达紙cwd / agentPreset锛夛紝鍐欎竴浠戒氦鎺ユ枃浠?handoffs/<sid>-<ts>.md锛? *        b. 鎶婃暣涓細璇濈洰褰曞浠藉埌 backups/<sid>-<ts>/锛? *        c. 鐢?sessionController.agents.createSession() 鍦ㄥ師鐩綍寮€涓€涓柊浼氳瘽锛? *        d. 寰€鏂颁細璇濋噷濉炰竴鏉″紑灞€娑堟伅锛屽憡璇夊畠浜ゆ帴鏂囦欢鍦ㄥ摢銆佽鎺ョ潃骞蹭粈涔堬紱
 *        e. 鐢?workspaceController.archiveSession() 鎶婃棫浼氳瘽褰掓。锛堝交搴曞仠鐢紝涓嶅啀鍑虹幇鍦ㄤ晶鏍忥級銆? *   4. 鍏ㄨ繃绋嬪啓 audit.log锛屽嚭閿欏彧璁版棩蹇楋紝缁濅笉鎶?Host 鎷栧灝銆? *
 * 鎵€鏈夊姩浣滈兘鍦?try/catch 閲岋紱apply() 鏈韩涓嶄細鎶涘紓甯搞€? */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile, cp, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createZstdDecompress } from 'node:zlib';

export const name = 'session-rotate';
export const inject = ['sessionController', 'workspaceController'];

/** 榛樿閰嶇疆锛沺atch 閲岀殑 config 浼氳鐩栬繖閲屻€?*/
const DEFAULTS = {
  enabled: true,
  intervalMs: 60_000,
  warnTokens: 200_000,
  rotateTokens: 350_000,
  /** zstd 鏃ュ織瀛楄妭 鈫?token 鐨勭粡楠岀郴鏁帮紙鐢ㄤ粖澶╃殑鐪熷疄鏁版嵁鏍囧畾锛?5,598,487 瀛楄妭 鈮?1,746,361 tokens锛夈€?*/
  tokensPerByte: 0.112,
  /** 浼氳瘽鏂囦欢鍦ㄨ繖涔堝姣鍐呰鍐欒繃锛屽氨璁や负姝ｅ湪瀵硅瘽涓紝杩欒疆鍏堜笉鍔ㄥ畠銆?*/
  activeGraceMs: 600_000,
  /** true锛氳嚜鍔ㄥ紑鏂颁細璇濆苟褰掓。鏃х殑锛沠alse锛氬彧鍐欎氦鎺?+ 澶囦唤锛堟紨缁冿級銆?*/
  autoRotate: true,
  /** true锛氬彧绠椾笉钀界洏锛岀敤鏉ヨ瀵熼槇鍊兼槸鍚﹀悎鐞嗐€?*/
  dryRun: false,
  /** 杩欎簺 sessionId 姘镐笉杞崲銆?*/
  exclude: [],
  /** 鏁版嵁鏍圭洰褰曪紝榛樿 ~/.dsh/session-rotate銆?*/
  root: null,
  /** 浼氳瘽鏍圭洰褰曪紝榛樿 ~/.dsh/sessions锛堜竴鑸笉鐢ㄦ敼锛屾祴璇曟椂鎵嶆湁鐢級銆?*/
  sessionsRoot: null,
};

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 璇讳細璇濇棩蹇楃殑澶撮儴锛堢涓€琛?JSON锛夛紝鍙В鍘嬪墠 64KB锛岃涓嶅埌灏辫繑鍥?null銆?*/
async function readSessionHeader(file) {
  let head;
  try {
    head = (await readFile(file)).subarray(0, 1 << 16);
  } catch {
    return null;
  }
  const text = await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(out);
    };
    try {
      const d = createZstdDecompress();
      d.on('data', (chunk) => {
        out += chunk.toString('utf8');
        if (out.includes('\n') || out.length > 200_000) {
          try { d.destroy(); } catch { /* ignore */ }
          finish();
        }
      });
      d.on('error', finish);
      d.on('end', finish);
      d.end(head);
    } catch {
      finish();
    }
  });
  const line = text.split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function handoffText({ sessionId, header, tokens, newSessionId, ts }) {
  const lines = [
    `# 浼氳瘽浜ゆ帴锛堣嚜鍔ㄨ疆鎹?${ts}锛塦,
    '',
    `- 鏃т細璇濓細\`${sessionId}\``,
    `- 浼扮畻涓婁笅鏂囷細绾?${tokens.toLocaleString('en-US')} tokens`,
    `- 宸ヤ綔鐩綍锛歕`${header?.cwd ?? '(鏈煡)'}\``,
    `- 浜鸿棰勮锛歕`${header?.agentPreset ?? '(榛樿)'}\``,
    `- 鏂颁細璇濓細\`${newSessionId ?? '(鏈垱寤?'}\``,
    '',
    '## 鎺ユ墜椤荤煡',
    '',
    '1. 鏃т細璇濆凡鍘熸牱澶囦唤骞跺綊妗ｏ紝璁板綍涓嶄細涓紝浣?*涓嶈**鍐嶅幓缁亰瀹冿紙瀹冨凡缁忚秴鍑哄彲鐢ㄧ獥鍙ｏ級銆?,
    '2. 闇€瑕佹棫缁嗚妭鏃惰澶囦唤鏃ュ織锛屼笉瑕佸嚟璁板繂缂栵細',
    '   `~/.dsh/session-rotate/backups/` 涓嬫槸鏁寸洰褰曞壇鏈紙鍙敤 `bili export` 瀵煎嚭鎴?Markdown锛夈€?,
    '3. 鍏堣窡鐢ㄦ埛纭杩樿缁х画鍋氱殑浜嬶紝鍐嶅姩鎵嬶紱涓嶇‘瀹氱殑鍘婚棶锛屼笉瑕佺寽銆?,
    '',
    '## 鏃т細璇濋兘鑱婁簡浠€涔?,
    '',
    '锛堟妸杩欎竴鑺傝ˉ涓婏細鐢ㄦ埛鐨勭洰鏍囥€佸凡缁忔敼杩囩殑鏂囦欢銆佽繕娌″仛瀹岀殑 TODO銆傚啓寰楄秺鍏蜂綋锛屾帴鎵嬭秺鐪佷簨銆傦級',
    '',
  ];
  return lines.join('\n');
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
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
  }

  async function saveState() {
    try {
      await writeFile(dirs.state, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`state 鍐欏叆澶辫触锛?{String(error)}`);
    }
  }

  /** 鍒楀嚭鐜板瓨浼氳瘽锛殈/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd */
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
          } catch { /* 鎹笅涓€涓€欓€夋枃浠跺悕 */ }
        }
      }
    }
    return found;
  }

  /** 杞崲涓€涓細璇濄€備换浣曚竴姝ュけ璐ラ兘鍙褰曪紝涓嶆姏銆?*/
  async function rotate(item, tokens) {
    const { sessionId, dir, file } = item;
    const ts = stamp();
    const header = (await readSessionHeader(file)) ?? {};
    const cwd = header.cwd || process.cwd();
    const agentPreset = header.agentPreset;

    if (cfg.dryRun) {
      log(`[dry-run] ${sessionId} 绾?${tokens} tokens锛?= ${cfg.rotateTokens}锛屾湰搴旇疆鎹);
      return;
    }

    // a. 浜ゆ帴鏂囦欢
    await mkdir(dirs.handoffs, { recursive: true });
    const handoffPath = path.join(dirs.handoffs, `${sessionId}-${ts}.md`);
    await writeFile(handoffPath, handoffText({ sessionId, header, tokens, newSessionId: null, ts }), 'utf8');

    // b. 鏁寸洰褰曞浠斤紙鍘熸牱鍓湰锛屼笉鍒犲師鏂囦欢锛?    await mkdir(dirs.backups, { recursive: true });
    const backupDir = path.join(dirs.backups, `${sessionId}-${ts}`);
    await cp(dir, backupDir, { recursive: true, force: true });
    log(`${sessionId} 宸插浠藉埌 ${backupDir}锛堜氦鎺?${handoffPath}锛塦);

    if (!cfg.autoRotate) {
      state.warned[sessionId] = { ts, tokens, handoff: handoffPath };
      await saveState();
      log(`${sessionId} 鍙仛浜嗕氦鎺?澶囦唤锛坅utoRotate=false锛夛紝娌℃湁鍔ㄤ細璇濇湰韬玚);
      return;
    }

    // c. 寮€鏂颁細璇濓紙鍚屼竴鐩綍銆佸悓涓€浜鸿棰勮锛?    let newSessionId = null;
    try {
      const created = await ctx.sessionController.agents.createSession({ cwd, agentPreset });
      newSessionId = created?.agent?.session?.id ?? null;
      if (!newSessionId) throw new Error('createSession 娌℃湁杩斿洖 session id');
      log(`宸叉柊寤轰細璇?${newSessionId}锛坈wd=${cwd}锛塦);
    } catch (error) {
      log(`鏂板缓浼氳瘽澶辫触锛屼繚鐣欐棫浼氳瘽涓嶅姩锛?{String(error)}`);
      await saveState();
      return;
    }

    // d. 鎶婁氦鎺ヤ俊鎭杩涙柊浼氳瘽
    try {
      const text = [
        `銆愯嚜鍔ㄨ疆鎹?${ts}銆戣繖涓細璇濇槸浠庢棫鐨?\`${sessionId}\` 鎺ユ墜鐨勩€俙,
        `鏃т細璇濅笂涓嬫枃宸插埌绾?${tokens.toLocaleString('en-US')} tokens锛屽凡澶囦唤骞跺綊妗ｏ紝鍒啀鍘荤画瀹冦€俙,
        `浜ゆ帴鏂囦欢锛?{handoffPath}`,
        `鏃ф棩蹇楀浠斤細${backupDir}`,
        '',
        '鍏堣浜ゆ帴鏂囦欢锛堝伐浣滅洰褰曢噷鎴栦笂闈㈣繖涓矾寰勶級锛岃窡鐢ㄦ埛纭鎺ョ潃鍋氫粈涔堬紝鍐嶅紑濮嬪姩鎵嬨€?,
      ].join('\n');
      await ctx.sessionController.prompt({
        sessionId: newSessionId,
        mode: 'queue',
        requestId: randomUUID(),
        clientTimeZone: 'Asia/Shanghai',
        content: [{ type: 'text', text }],
      });
      log(`宸插悜 ${newSessionId} 鎶曢€掑紑灞€浜ゆ帴娑堟伅`);
    } catch (error) {
      log(`寮€灞€娑堟伅鎶曢€掑け璐ワ紙鏂颁細璇濆凡寤哄ソ锛屽彲鎵嬪姩寮€鑱婏級锛?{String(error)}`);
    }

    // e. 褰掓。鏃т細璇?= 褰诲簳鍋滅敤
    try {
      await ctx.workspaceController.archiveSession({ sessionId, stopActivity: true });
      log(`宸插綊妗ｆ棫浼氳瘽 ${sessionId}`);
    } catch (error) {
      log(`褰掓。澶辫触锛堝浠藉凡鍦紝鍙墜鍔ㄥ鐞嗭級锛?{String(error)}`);
    }

    state.rotated[sessionId] = { ts, tokens, newSessionId, handoff: handoffPath, backup: backupDir };
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
        const tokens = Math.round(item.bytes * cfg.tokensPerByte);
        if (tokens >= cfg.rotateTokens) {
          if (Date.now() - item.mtimeMs < cfg.activeGraceMs) {
            state.warned[sessionId] = { ts: stamp(), tokens, pending: true };
            continue;
          }
          await rotate(item, tokens);
        } else if (tokens >= cfg.warnTokens && !state.warned[sessionId]) {
          state.warned[sessionId] = { ts: stamp(), tokens };
          log(`鎻愰啋锛?{sessionId} 宸茬害 ${tokens.toLocaleString('en-US')} tokens锛堥槇鍊?${cfg.warnTokens}锛夛紝涓嬫绌洪棽灏变細杞崲`);
        }
      }
      await saveState();
    } catch (error) {
      log(`鎵弿澶辫触锛?{String(error)}`);
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => {
    let timer = null;
    let disposed = false;
    const start = async () => {
      await mkdir(dirs.root, { recursive: true });
      log(`宸插惎鍔細闃堝€?${cfg.rotateTokens} tokens / 姣?${Math.round(cfg.intervalMs / 1000)}s 鎵弿涓€娆?{cfg.dryRun ? '锛坉ry-run锛? : ''}`);
      // 棣栨寤惰繜涓€鐐癸紝鍒拰 Host 鍚姩鎶?IO
      setTimeout(() => { if (!disposed) tick(); }, 5_000).unref?.();
      timer = setInterval(() => tick(), cfg.intervalMs);
      timer.unref?.();
    };
    start().catch((error) => log(`鍚姩澶辫触锛?{String(error)}`));
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, 'session-rotate: 瀹氭椂鎵弿');
}

