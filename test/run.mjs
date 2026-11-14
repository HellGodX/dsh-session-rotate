// 离线自测：用假 ctx 跑一遍轮换逻辑，验证交接/备份/新会话/归档四步都发生。
import { mkdir, cp, utimes, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { apply } from '../lib/index.js';

const base = path.resolve('_tmp_sr');
const sessionsRoot = path.join(base, 'sessions');
const root = path.join(base, 'rotate');
await rm(base, { recursive: true, force: true });

const slug = '--D-DOC-Documents-deepseek-harness-default-workspace--';
const sid = 'session-test1234-0000-0000-0000-000000000000';
const dir = path.join(sessionsRoot, slug, sid);
await mkdir(dir, { recursive: true });
await cp(
  'D:\\DOC\\Documents\\deepseek-harness\\default-workspace\\_archive\\sessions\\session-f27e88f8\\session.v4.jsonl.zstd',
  path.join(dir, 'session.v4.jsonl.zstd'),
);
const past = new Date(Date.now() - 10 * 60 * 1000);
await utimes(path.join(dir, 'session.v4.jsonl.zstd'), past, past);

const calls = [];
const ctx = {
  effect: (fn) => { fn(); },
  logger: { info: (m) => console.log('LOG', m) },
  sessionController: {
    agents: {
      createSession: async (req) => { calls.push(['createSession', req]); return { agent: { session: { id: 'session-NEW000000-0000-0000-0000-000000000000' } } }; },
    },
    prompt: async (req) => { calls.push(['prompt', req]); },
  },
  workspaceController: {
    archiveSession: async (req) => { calls.push(['archiveSession', req]); },
  },
};

apply(ctx, { sessionsRoot, root, intervalMs: 60_000, warnTokens: 1000, rotateTokens: 100_000, autoRotate: true });

await new Promise((r) => setTimeout(r, 12_000));

console.log('\n--- calls ---');
for (const [n, payload] of calls) {
  console.log(n, JSON.stringify(n === 'prompt' ? { sid: payload.sessionId, len: payload.content?.[0]?.text?.length } : payload).slice(0, 300));
}
const files = await readdir(root, { recursive: true });
console.log('\n--- files under rotate root ---');
console.log(files.filter((f) => !f.includes('backups\\') || f.endsWith('.zstd')).slice(0, 15));
const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
console.log('\nstate.rotated:', JSON.stringify(state.rotated));
const audit = await readFile(path.join(root, 'audit.log'), 'utf8');
console.log('\n--- audit ---\n' + audit);
