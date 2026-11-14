// 离线自测：两个场景，全部带断言。
//   场景 1：真实的大会话（1.7M tokens）→ 应精确读数、交接文件写到内容、备份、开新会话、投递、归档。
//   场景 2：开了 precut，压缩器把日志改小 → 水位回落到可接受区间 → 不该轮换。
import { mkdir, cp, utimes, readFile, rm, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import { apply } from '../lib/index.js';

const FIXTURE = 'D:\\DOC\\Documents\\deepseek-harness\\default-workspace\\_archive\\sessions\\session-f27e88f8\\session.v4.jsonl.zstd';
const base = path.resolve('_tmp_sr');
const slug = '--D-DOC-Documents-deepseek-harness-default-workspace--';
const sid = 'session-test1234-0000-0000-0000-000000000000';
const NEW_ID = 'session-NEW000000-0000-0000-0000-000000000000';

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`PASS ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${extra ? ` :: ${extra}` : ''}`); }
};

async function prepare(dir, name) {
  const sessionDir = path.join(dir, slug, name);
  await mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  await cp(FIXTURE, file);
  const past = new Date(Date.now() - 20 * 60 * 1000);
  await utimes(file, past, past);
  return { sessionDir, file };
}

function makeCtx(calls, extra = {}) {
  return {
    effect: (fn) => { fn(); },
    logger: { info: () => {} },
    sessionController: {
      agents: { createSession: async (req) => { calls.push(['createSession', req]); return { agent: { session: { id: NEW_ID } } }; } },
      prompt: async (req, signal) => { calls.push(['prompt', req, signal]); },
    },
    workspaceController: { archiveSession: async (req) => { calls.push(['archiveSession', req]); } },
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 场景 1 ─────────────────────────
console.log('=== 场景 1：完整轮换 ===');
await rm(base, { recursive: true, force: true });
{
  const s1 = path.join(base, 's1');
  const sessionsRoot = path.join(s1, 'sessions');
  const root = path.join(s1, 'rotate');
  const { file } = await prepare(sessionsRoot, sid);

  const calls = [];
  apply(makeCtx(calls), {
    sessionsRoot, root, initialDelayMs: 100, intervalMs: 60_000,
    warnTokens: 100_000, rotateTokens: 350_000, autoRotate: true, activeGraceMs: 600_000,
  });
  await sleep(9_000);

  const names = calls.map((c) => c[0]);
  ok(names.includes('createSession'), '开了新会话', names.join(','));
  ok(names.includes('prompt'), '投递了开局消息');
  ok(names.includes('archiveSession'), '归档了旧会话');

  const created = calls.find((c) => c[0] === 'createSession')?.[1];
  ok(created?.cwd === 'D:\\DOC\\Documents\\deepseek-harness\\default-workspace', '新会话沿用原 cwd', JSON.stringify(created));

  const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
  const rec = state.rotated[sid];
  ok(!!rec, 'state 记录了轮换');
  ok((rec?.peak ?? 0) > 900_000, '峰值水位来自真实 usage（>90 万 tokens）', String(rec?.peak));
  ok((rec?.tokens ?? 0) > 100_000, '最近水位也是真实读数', String(rec?.tokens));

  const handoff = await readFile(rec.handoff, 'utf8');
  ok(handoff.includes('## 用户最近说过什么'), '交接文件有「用户最近说过什么」');
  const userLines = handoff.split('## 用户最近说过什么')[1]?.split('##')[0]?.split('\n').filter((l) => l.trim().startsWith('- ')) ?? [];
  ok(userLines.length >= 1, '交接文件摘到了用户消息', `lines=${userLines.length}`);
  ok(userLines.some((l) => l.replace(/^- /, '').trim().length > 5), '用户消息不是空壳');
  ok(/## 最近动过的文件[\s\S]*?- `/.test(handoff), '交接文件摘到了文件路径');
  ok(/## 最近跑过的命令\/工具[\s\S]*?- `/.test(handoff), '交接文件摘到了工具调用');

  const promptText = calls.find((c) => c[0] === 'prompt')?.[1]?.content?.[0]?.text ?? '';
  ok(promptText.includes(rec.handoff), '开局消息指向交接文件');
  ok(promptText.includes(rec.backup), '开局消息指向备份目录');

  // prompt(request, signal)：真机上缺 signal 会 TypeError: 'throwIfAborted' of undefined
  const promptSignal = calls.find((c) => c[0] === 'prompt')?.[2];
  ok(promptSignal instanceof AbortSignal, '给 prompt 传了 AbortSignal');
  ok(typeof promptSignal?.throwIfAborted === 'function' && !promptSignal.aborted, 'signal 可用且未中止');
  ok((await readFile(file)).length > 1_000_000, '原日志没被删掉');

  const audit = await readFile(path.join(root, 'audit.log'), 'utf8');
  ok(audit.includes('已备份到'), 'audit 记了备份');
}

// ───────────────────────── 场景 2 ─────────────────────────
console.log('\n=== 场景 2：precut 小切后水位回落 → 不轮换 ===');
{
  const s2 = path.join(base, 's2');
  const sessionsRoot = path.join(s2, 'sessions');
  const root = path.join(s2, 'rotate');
  const { file } = await prepare(sessionsRoot, sid);

  const calls = [];
  let compactCalled = 0;
  const compactor = {
    compact: async ({ sessionId }) => {
      compactCalled += 1;
      if (sessionId !== sid) throw new Error(`unexpected sessionId ${sessionId}`);
      // 模拟「小切」：把日志压成一条很小的合法会话
      const small = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', data: { version: 4, id: sid, cwd: 'D:\\tmp' } })}\n`));
      await writeFile(file, small);
      return { ok: true };
    },
  };
  apply(makeCtx(calls, { compactor }), {
    sessionsRoot, root, initialDelayMs: 100, intervalMs: 60_000,
    warnTokens: 100_000, rotateTokens: 350_000, autoRotate: true,
    precut: { enabled: true, service: 'compactor', method: 'compact', timeoutMs: 20_000, acceptRatio: 0.85 },
  });
  await sleep(9_000);

  ok(compactCalled >= 1, 'precut 被调用');
  const names = calls.map((c) => c[0]);
  ok(!names.includes('createSession'), '水位回落后没有开新会话', names.join(','));
  const audit = await readFile(path.join(root, 'audit.log'), 'utf8');
  ok(audit.includes('小切后水位降到'), 'audit 记了小切回落', audit.split('\n').slice(-4).join(' / '));
}

await rm(base, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
