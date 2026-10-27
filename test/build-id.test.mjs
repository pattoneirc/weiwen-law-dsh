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
import { computeBuildId } from '../src/index.js';

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
