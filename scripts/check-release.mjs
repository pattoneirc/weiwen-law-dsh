#!/usr/bin/env node
// check-release.mjs — 源场（仓库） × 分发场（npm）的对账闸门
// ---------------------------------------------------------------------------
// 为什么需要它（安 2026-10-27 定的规矩）：**仓库和 npm 各做各的事，场域干净，
//   出了问题要好排查。**
//
// 但"干净"不等于"两边内容必须一样"——开发中两边本来就该不一样（我改代码时仓库先
//   前进，npm 还停在上一个发版点）。所以这里查的不是"相等"，是**分叉必须可查**：
//
//   ① npm 上此刻能装到的那一份，指纹是多少（真下载包来算，不看自报）；
//   ② 它对应哪个 git 提交（RELEASES.md 的记账）；
//   ③ 那个提交是否真在 main 上（不能是本地未推的提交）；
//   ④ 用那个提交的代码重算指纹，是否与 ① 一致（记账有没有记错）。
//
// 四条全过 ⇒ 「装的人拿到的 = 我记账的那份 = main 上那一份」，出问题能倒查到行。
// 任一条不过 ⇒ 打叉并退出码 1。**只出读数，不自动修**。
//
// ⚠️ 两个已踩过的坑（改本文件时别再犯）：
//   1. `git show` 的返回值**不能 trim** —— 文件尾部换行是内容的一部分，trim 掉再哈希
//      ⇒ 每个文件都"不一致"，一次误报 13 条。
//   2. Windows 下 `tar -xzf C:\...` 会把 `C:` 当成远程主机 ⇒ 必须在目标目录里用相对文件名。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'dsh-weiwen-law';
const WIN = process.platform === 'win32';

/** 跑命令，返回值已 trim（只用于"短输出"，如版本号、sha） */
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: WIN, ...opts }).trim();
/** 跑 git 并保留原始输出（文件内容不能 trim） */
const gitRaw = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: WIN, maxBuffer: 1 << 28 });

const CORE = (dir) => readdirSync(dir)
  .filter((n) => n.endsWith('.mjs') && !n.startsWith('_engine_base_'))
  .map((n) => [n, readFileSync(join(dir, n)).toString('utf8')]);

// ── 记账本：取最后一条 ────────────────────────────────────────────────────
function lastRecord() {
  const txt = readFileSync(join(ROOT, 'RELEASES.md'), 'utf8');
  const rows = [...txt.matchAll(/^\|\s*`?(0\.\d+\.\d+)`?\s*\|\s*`?([0-9a-f]{7,40})`?\s*\|\s*`?([0-9a-f]{12})`?\s*\|\s*`?([0-9a-f]{40})`?\s*\|\s*([\d-]+)\s*\|/gm)];
  if (!rows.length) throw new Error('RELEASES.md 里没有可解析的发布记录');
  const r = rows[rows.length - 1];
  return { version: r[1], gitSha: r[2], buildId: r[3], shasum: r[4], date: r[5] };
}

// ── ① npm 上此刻的那一份（真下载，不看自报）───────────────────────────────
const latest = run('npm', ['view', PKG, 'version']);
const rec = lastRecord();

const tmp = mkdtempSync(join(tmpdir(), 'ww-check-'));
let pkgBuildId, pkgShasum;
try {
  const packed = run('npm', ['pack', `${PKG}@${latest}`, '--pack-destination', tmp, '--loglevel=error'])
    .split('\n').pop().trim();
  execFileSync('tar', ['-xzf', packed, '-C', '.'], { cwd: tmp, shell: WIN });
  const tgz = join(tmp, packed);
  pkgShasum = execFileSync('node', ['-e',
    "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha1').update(f.readFileSync(process.argv[1])).digest('hex'))",
    tgz], { encoding: 'utf8' }).trim();
  pkgBuildId = computeBuildId(CORE(join(tmp, 'package', 'src', 'core')));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── ④ 用记账的提交重算指纹 ────────────────────────────────────────────────
let shaBuildId;
try {
  const files = gitRaw(['ls-tree', '-r', '--name-only', rec.gitSha, '--', 'src/core'])
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => f.endsWith('.mjs') && !f.includes('_engine_base_'));
  shaBuildId = computeBuildId(files.map((f) => [f.replace('src/core/', ''), gitRaw(['show', `${rec.gitSha}:${f}`])]));
} catch { shaBuildId = '<提交不存在>'; }

// ── ③ 那个提交在不在 main 上 ───────────────────────────────────────────────
let inMain = false;
try { run('git', ['merge-base', '--is-ancestor', rec.gitSha, 'origin/main']); inMain = true; } catch { inMain = false; }

// ── 出读数 ────────────────────────────────────────────────────────────────
const head = run('git', ['rev-parse', '--short', 'HEAD']);
const originHead = run('git', ['rev-parse', '--short', 'origin/main']);
const rows = [
  ['npm latest 版本', latest, rec.version, latest === rec.version],
  ['npm 包实测指纹', pkgBuildId, rec.buildId, pkgBuildId === rec.buildId],
  ['npm 包 shasum(前12)', pkgShasum.slice(0, 12), rec.shasum.slice(0, 12), pkgShasum === rec.shasum],
  ['记账提交重算指纹', shaBuildId, rec.buildId, shaBuildId === rec.buildId],
  ['记账提交在 main 上', String(inMain), 'true', inMain],
  ['仓库 HEAD / origin', head, originHead, null],
];

const bad = [];
const w = (i) => Math.max(14, ...rows.map((r) => String(r[i]).length)) + 2;
console.log('\n源场（仓库） × 分发场（npm）对账\n');
for (const [k, got, want, good] of rows) {
  const mark = good === null ? '（只报，不判）' : good ? 'PASS' : 'FAIL';
  if (good === false) bad.push(k);
  console.log('  ' + k.padEnd(22) + String(got).padEnd(w(1)) + String(want).padEnd(w(2)) + mark);
}

console.log('');
if (bad.length) {
  console.log(`结论：分叉且不可对账 —— ${bad.join(' / ')}`);
  console.log('处理：核对 RELEASES.md 最后一条记录；若是新发版，补记账后重跑。不要改已发版本。');
  process.exit(1);
}
const ahead = run('git', ['rev-list', '--count', `${rec.gitSha}..HEAD`]);
console.log(`结论：对得上。npm latest 可倒查到 ${rec.gitSha}（在 main 上）。`);
console.log(`　　　仓库比该发版点多 ${ahead} 个提交 —— 这是正常开发态，不影响分发；`);
console.log('　　　要分发就发新版本号，别动已经发出去的版本。');
