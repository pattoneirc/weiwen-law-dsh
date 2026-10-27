// 量具自指（self-reference）回归锁 —— 2026-10-27 · 小D 实测评测逼出
//
// 病灶：`query_conduction_chain` 读的是 `engine.conduction`（只存"最近一次裁决"）。
//   但查询工具**自己也要过闸** ⇒ 它那一次裁决会覆盖"最近一次" ⇒ 它读到的是**自己**。
//   实测序列（小D）：glob → deny/R，紧接着查链，报出的是 allow / law:推演 / layer=file-read / vacuum。
//   ⇒ 那不是上一次的链，是查询自己这一次的链。**所有"看链"的自查在修前都是自拍自照。**
//
// 修法（结构，不是止血）：
//   · 引擎侧存**裁决史**（含被裁工具名 + seq + 时间），不只存最近一次；
//   · `lastConductionExcluding(excludeTools)` 取"最近一条不属于 excludeTools 的裁决"；
//   · "哪些工具算自查类"是**插件注册时才知道的知识**，故由 index.js 显式登记（SELF_AUDIT_TOOL_NAMES），
//     引擎侧不认 `query_` 前缀（词形判据＝枚举，将来加 get_/inspect_ 就漏）。
//
// ⚠️ 本文件的第 ❷ 组是**反例锁**：它证明"不排除时会读到自己"。
//   去掉 ❷，❶ 就可能是假绿 —— 万一哪天历史只存了一条，❶ 也会碰巧通过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeiwenLawEngine, DEFAULT_RIGID_ANCHORS } from '../src/core/engine.mjs';

const ENG = () => new WeiwenLawEngine({ rigidAnchors: DEFAULT_RIGID_ANCHORS });

/** 能稳定判 deny 的调用（刚性锚 R 域，客观规则，证也买不通） */
const DENY_CALL = { name: 'run_task', args: { command: 'rm -rf /etc' } };
/** 自查类工具的典型调用（只读，通常 allow） */
const AUDIT_CALL = { name: 'query_conduction_chain', args: {} };
const AUDIT_SET = new Set(['query_conduction_chain']);

/** 造出"先一个真动作，再一个自查动作"的序列 —— 自指只在两连发时显形 */
function twoStep() {
  const eng = ENG();
  const action = eng.decideToolCall({ ...DENY_CALL });
  const audit = eng.decideToolCall({ ...AUDIT_CALL });
  return { eng, action, audit };
}

// ─────────────────────────────────────────────────────────────
// ❶ 主效力：排除自查后，读到的是**上一次真动作**，不是自查自己
// ─────────────────────────────────────────────────────────────
test('❶ 排除自查工具后，取到的是上一个真动作的裁决（deny），不是查询自己（allow）', () => {
  const { eng, action, audit } = twoStep();

  // 前提断言：两步的判决必须真的不同，否则这条测试没有鉴别力
  assert.equal(action.kind, 'deny', '前提：真动作应为 deny');
  assert.equal(audit.kind, 'allow', '前提：自查工具应为 allow');
  assert.notEqual(action.kind, audit.kind, '前提：两者判决必须不同，测试才有鉴别力');

  const sub = eng.lastConductionExcluding(AUDIT_SET);
  assert.ok(sub, '应取到一条裁决');
  assert.equal(sub.tool, 'run_task', `取到的应是真动作，实际 ${sub.tool}`);
  assert.equal(sub.kind, 'deny', `判决应是 deny，实际 ${sub.kind}`);
  assert.ok(Array.isArray(sub.conduction) && sub.conduction.length > 0, '应带回完整链落点');
});

// ─────────────────────────────────────────────────────────────
// ❷ 反例锁：同一个引擎、同一段历史，只要不排除，就会读到自查自己
//    —— 这一条一旦失败，说明"自指"已经不在（或历史只剩一条），❶ 的绿不再有意义
// ─────────────────────────────────────────────────────────────
test('❷ 反例锁：不排除自查工具时会读到查询自己（allow）—— 证明确有自指，❶ 不是假绿', () => {
  const { eng } = twoStep();
  const raw = eng.lastConductionExcluding(new Set());
  assert.ok(raw, '应取到一条裁决');
  assert.equal(raw.tool, 'query_conduction_chain', `不排除时应读到自己，实际 ${raw.tool}`);
  assert.equal(raw.kind, 'allow');

  // 且它与 ❶ 的读数必须不同 —— 差异只来自"接法"，不来自"能力"
  const sub = eng.lastConductionExcluding(AUDIT_SET);
  assert.notEqual(raw.kind, sub.kind, '同一段历史，两种取法必须给出不同结论');
});

// ─────────────────────────────────────────────────────────────
// ❸ null 是正向读数，不许兜底成"最近一条"
// ─────────────────────────────────────────────────────────────
test('❸ 空历史返回 null（不是错误、不兜底）', () => {
  const eng = ENG();
  assert.equal(eng.lastConductionExcluding(AUDIT_SET), null);
  assert.equal(eng.lastConductionExcluding(new Set()), null);
});

test('❹ 历史里全是自查工具时返回 null —— 绝不退化成"那就返回自己"', () => {
  const eng = ENG();
  eng.decideToolCall({ ...AUDIT_CALL });
  eng.decideToolCall({ ...AUDIT_CALL });
  assert.equal(eng.lastConductionExcluding(AUDIT_SET), null, '全是自查时必须返回 null，而不是最后一条');
});

// ─────────────────────────────────────────────────────────────
// ❺ 历史是"只增不覆盖"的账，不是"最近一次"的替换
// ─────────────────────────────────────────────────────────────
test('❺ 裁决史只增不覆盖：seq 单调递增，tool 名如实记录（不做词形判断）', () => {
  const eng = ENG();
  eng.decideToolCall({ ...DENY_CALL });
  eng.decideToolCall({ ...AUDIT_CALL });
  eng.decideToolCall({ name: 'read_file', args: { path: '/tmp/a.txt' } });

  const hist = eng.conductionHistory;
  assert.equal(hist.length, 3, `应记 3 条，实际 ${hist.length}`);
  assert.deepEqual(hist.map((e) => e.seq), [1, 2, 3], 'seq 必须单调递增且从 1 起');
  assert.deepEqual(
    hist.map((e) => e.tool),
    ['run_task', 'query_conduction_chain', 'read_file'],
    'tool 名必须原样记录 —— 引擎不判断谁算"自查类"',
  );
  // 每条的 kind 与当时那次 decide 的返回一致（不是被后续覆盖）
  assert.equal(hist[0].kind, 'deny');
  assert.equal(hist[1].kind, 'allow');
});

// ─────────────────────────────────────────────────────────────
// ❻ 环形上限：超 32 条后仍能取到"最近一条非自查"，且不无限涨内存
// ─────────────────────────────────────────────────────────────
test('❻ 环形上限 32：超出后仍取得到最近的自查工具之后的目标，内存不无限涨', () => {
  const eng = ENG();
  eng.decideToolCall({ ...DENY_CALL });                       // seq 1：真动作
  for (let i = 0; i < 40; i += 1) eng.decideToolCall({ ...AUDIT_CALL }); // 40 条自查

  const hist = eng.conductionHistory;
  assert.equal(hist.length, 32, `历史应被截到 32，实际 ${hist.length}`);
  // seq 1 已被挤出窗口 ⇒ 此时应返回 null，而不是"随便给一条"
  assert.equal(
    eng.lastConductionExcluding(AUDIT_SET),
    null,
    '窗口内已无真动作时必须返回 null（如实说"看不见了"，不编）',
  );
  // 但窗口一滚动，新的真动作立刻可见
  eng.decideToolCall({ ...DENY_CALL });
  const sub = eng.lastConductionExcluding(AUDIT_SET);
  assert.ok(sub);
  assert.equal(sub.tool, 'run_task');
});

// ─────────────────────────────────────────────────────────────
// ❼ 多工具排除集：登记了几个就跳过几个（不按名，按集合）
// ─────────────────────────────────────────────────────────────
test('❼ 排除集是集合语义：登记几个自查工具就跳几个，与名字形态无关', () => {
  const eng = ENG();
  eng.decideToolCall({ ...DENY_CALL });
  eng.decideToolCall({ name: 'query_steady_state', args: {} });
  eng.decideToolCall({ name: 'inspect_something_new', args: {} }); // 名字不带 query_，照样能排除

  const skip = new Set(['query_steady_state', 'inspect_something_new']);
  const sub = eng.lastConductionExcluding(skip);
  assert.equal(sub.tool, 'run_task', '应跳过两个登记项，回到真动作');
  assert.equal(sub.kind, 'deny');

  // 数组形式也接受（便于调用方传字面量）
  const sub2 = eng.lastConductionExcluding(['query_steady_state', 'inspect_something_new']);
  assert.equal(sub2.tool, 'run_task');
});
