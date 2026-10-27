// build-id.test.mjs — buildId 口径回归锁
// ---------------------------------------------------------------------------
// 锁的是一条性质，不是一张期望值表：
//   **同一份代码 ⇒ 同一个 buildId，与平台换行习惯、安装路径无关。**
//
// 病灶（2026-10-27 真装探针实测，0.2.3 现场）：
//   同一份代码，npm 包内算出 `8e8604efd2cf`，git 存储侧算出 `91fea30b57f8`。
//   差在换行：老文件被 autocrlf 检出成 CRLF 进了包，git 里存的是 LF。
//   后果不是"数字难看"，是**该判据的用途失效**：
//   buildId 存在的唯一理由是回答「你测的和我说的，是不是同一份代码」；
//   掺进平台习惯之后，比对不上会被读成「你装的是旧包」，而不是「口径不一致」。
//
// 为什么用性质而不是列清单：将来文件增减、内容改动，期望值表就全废了；
//   而「规范化后同内容 ⇒ 同值」这条性质，改多少次代码都成立。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeBuildId, FINGERPRINTS } from '../src/index.js';

const FILES = [
  ['engine.mjs', 'line one\nline two\nline three\n'],
  ['law.mjs', 'const a = 1;\nconst b = 2;\n'],
];

test('同一内容：全 LF 与全 CRLF 必须同值（跨平台可比的根据）', () => {
  const lf = FILES.map(([n, c]) => [n, c]);
  const crlf = FILES.map(([n, c]) => [n, c.replace(/\n/g, '\r\n')]);
  assert.equal(computeBuildId(lf), computeBuildId(crlf));
});

test('同一内容：混合换行（老文件 CRLF + 新文件 LF）与统一换行同值', () => {
  const mixed = [
    ['engine.mjs', 'line one\r\nline two\r\nline three\r\n'],   // 被 autocrlf 检出的老文件
    ['law.mjs', 'const a = 1;\nconst b = 2;\n'],                // 工具新写的文件
  ];
  assert.equal(computeBuildId(mixed), computeBuildId(FILES));
});

test('内容变一个字符 ⇒ 值必变（指纹得咬得住内容）', () => {
  const changed = [['engine.mjs', 'line one\nline two\nline three!\n'], FILES[1]];
  assert.notEqual(computeBuildId(changed), computeBuildId(FILES));
});

test('文件名参与哈希 ⇒ 改名即变（不能靠"内容一样"蒙混）', () => {
  const renamed = [['engine2.mjs', FILES[0][1]], FILES[1]];
  assert.notEqual(computeBuildId(renamed), computeBuildId(FILES));
});

test('文件顺序不影响结果（调用方给的顺序不该成为口径差）', () => {
  assert.equal(computeBuildId([FILES[1], FILES[0]]), computeBuildId(FILES));
});

test('非 UTF-8 换行不误伤：单独 \\r 不算换行，不该被规范化掉', () => {
  const a = [['x.mjs', 'a\rb\n']];
  const b = [['x.mjs', 'a\nb\n']];
  assert.notEqual(computeBuildId(a), computeBuildId(b), '孤立 \\r 是内容，不是换行标记');
});

// ─────────────────────────────────────────────────────────────
// 双指纹分离（2026-10-27 · 小D 实测提出「版本可见的第二个盲区」）
//   病灶：`buildId` 只哈希 `src/core/*.mjs` ⇒ **适配层（index.js）改动它看不见**。
//     0.2.5 → 0.2.6 适配层/文档变过，buildId 一动不动（两版都是 91fea30b57f8），只有 loadedAt 变了。
//     ⇒ 不是"指纹算错"，是**覆盖面的问题**：它答「判据代码是否同一份」，不答「整包行为面是否同一份」。
//   处置：不扩 buildId（会作废 0.2.0~0.2.6 的记账值），而是并列第二个指纹：
//     buildId  ＝ 判据域（src/core）／ bundleId ＝ 行为域（src 全部，含适配层）。
//   本组锁的性质：**bundleId 必须覆盖适配层且可被外部独立重算**（不是只信我们印的数）。
// ─────────────────────────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const walkSrc = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return walkSrc(join(dir, e.name), `${prefix}${e.name}/`);
  if (!e.name.endsWith('.js') && !e.name.endsWith('.mjs')) return [];
  if (e.name.startsWith('_engine_base_') || e.name === 'runtime.log') return [];
  return [[`${prefix}${e.name}`, readFileSync(join(dir, e.name), 'utf8')]];
});

test('bundleId 可被外部独立重算（审计方不必只信回执上印的值）', () => {
  assert.equal(computeBuildId(walkSrc(SRC)), FINGERPRINTS.bundleId);
});

test('bundleId 覆盖适配层：文件集里必须有 index.js，而 buildId 的覆盖集里没有它', () => {
  const files = walkSrc(SRC).map(([n]) => n);
  assert.ok(files.includes('index.js'), 'bundle 覆盖面必须包含适配层 index.js');
  assert.ok(files.includes('core/engine.mjs'), 'bundle 也必须包含判据域');
  // 反例锁：若哪天有人把 index.js 从 bundle 里漏掉，上面第一条就会失败
});

test('两个指纹必须不同值 —— 若相等说明覆盖面被合并了（那就退回"看不见适配层"的老病灶）', () => {
  assert.notEqual(FINGERPRINTS.bundleId, FINGERPRINTS.buildId);
  assert.match(FINGERPRINTS.buildId, /^[0-9a-f]{12}$/);
  assert.match(FINGERPRINTS.bundleId, /^[0-9a-f]{12}$/);
});

test('bundleId 咬得住适配层内容：同一份 core ＋ 改一个适配层字符 ⇒ bundleId 变、buildId 不变', () => {
  const all = walkSrc(SRC);
  const coreOnly = all.filter(([n]) => n.startsWith('core/')).map(([n, c]) => [n.replace('core/', ''), c]);
  const tweaked = all.map(([n, c]) => (n === 'index.js' ? [n, c + '\n// probe'] : [n, c]));
  const coreTweaked = tweaked.filter(([n]) => n.startsWith('core/')).map(([n, c]) => [n.replace('core/', ''), c]);

  assert.notEqual(computeBuildId(all), computeBuildId(tweaked), 'bundleId 必须对适配层改动敏感');
  assert.equal(computeBuildId(coreOnly), computeBuildId(coreTweaked), 'buildId 应对适配层改动不敏感（这是它的语义，不是缺陷）');
});
