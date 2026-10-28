// audit-selfref-wiring.test.mjs — 自指锁的「接线」那一半（2026-10-28）
// ---------------------------------------------------------------------------
// 为什么要有这个文件（实测逼出来的，不是设想）：
//   `audit-selfref.test.mjs` 锁的是引擎侧**能力**（`lastConductionExcluding`），
//   但它**锁不住适配层有没有调它**。变异实测证明了这道缺口：
//   把 index.js 里的 `lastConductionExcluding(SELF_AUDIT_TOOL_NAMES)` 改回 `new Set()`
//   （即把修复回退），引擎侧那 7 条测试**全绿**。
//   ⇒ 「判据在场」≠「判据被调用」。能力缺失与接法错误是两种病，此前只覆盖了一种。
//
// 本文件锁的两条，都走真实适配层入口 `apply(ctx)`：
//   ❶ 真动作（deny）之后、审计工具自己也过了一次闸，它报出的必须是**真动作**的链，
//     而且必须**点名**；把排除去掉，它就会报自己。
//   ❷ 注册与登记是同一个动作：实际注册了几个工具，自查登记册里就有几个
//     （"注册了但忘了登记"结构上不可能发生），且被排除几条是**可见**的，不是悄悄处理。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';

function mockCtx() {
  const handlers = {};
  const tools = [];
  const ctx = {
    on: (ev, cb) => { handlers[ev] = cb; },
    tools: { register: (t) => { tools.push(t); } },
  };
  return { ctx, handlers, tools };
}

const exec = (name, args) => ({ token: 't', callId: 'c1', name, arguments: args, signal: null });
const next = async () => 'NEXT';
const toolNamed = (tools, n) => tools.find((t) => t.name === n);

test('❶ 接线锁：链查询报出的是上一个真动作并点名；把排除去掉它就报自己', async () => {
  const { ctx, handlers, tools } = mockCtx();
  apply(ctx);
  const pre = handlers['tools/pre-execute'];
  assert.ok(pre, '适配层必须注册 tools/pre-execute 闸门');

  // 第一步：一个会被引擎拒绝的真动作（刚性锚，R 域）
  const d1 = await pre(exec('run_task', { command: 'rm -rf /etc' }), next);
  assert.equal(d1?.kind, 'deny', '前提：真动作必须被 deny，否则这条测试没有鉴别力');

  // 第二步：审计工具自己也过一次闸 —— 这正是制造自指那一下
  //   关于放行的返回形状：放行时闸门返回的是 `next()` 的值，不是 decision 对象。
  //   这里原本断言 `kind === 'allow'` 是错的，被测试打回后改成更弱但为真的断言。
  const d2 = await pre(exec('query_conduction_chain', {}), next);
  assert.notEqual(d2?.kind, 'deny', '前提：只读审计调用必须过闸');

  // 第三步：它到底报出谁
  const out = await toolNamed(tools, 'query_conduction_chain').execute({});

  assert.ok(out.lastConductionSubject, '主体必须点名 —— 不标"这是谁的链"，读者分不清读到的是动作还是量具自己');
  assert.equal(
    out.lastConductionSubject.tool,
    'run_task',
    `必须报出真动作，而不是查询自己（实际报了 ${out.lastConductionSubject.tool}）`,
  );
  assert.equal(out.lastConductionSubject.kind, 'deny', '报出的判决必须是真动作那次的 deny');

  // 链本体也要带回来，不能只给个标签
  assert.ok(Array.isArray(out.lastConduction) && out.lastConduction.length > 0, '必须带回完整链落点');
  assert.ok(out.selfAuditExcluded >= 1, '排除了几条必须可见，不能被悄悄处理');
  assert.ok(out.selfAuditTools.includes('query_conduction_chain'), '登记册里必须有审计工具自己');
});

test('❷ 注册即登记：实际注册的工具集合，与自查登记册完全相等', async () => {
  const { ctx, tools } = mockCtx();
  apply(ctx);
  assert.ok(tools.length > 0, '适配层必须注册工具');

  const out = await toolNamed(tools, 'query_conduction_chain').execute({});
  const registered = tools.map((t) => t.name).sort();
  const recorded = [...out.selfAuditTools].sort();

  assert.deepEqual(
    recorded,
    registered,
    '自查登记册必须与已注册工具集合完全相等 —— 注册了没登记的工具，就是一次看不见的自指',
  );
});

test('❸ 历史里全是自查调用时，答案是 null 并如实说明 —— 绝不编一条链出来', async () => {
  const { ctx, handlers, tools } = mockCtx();
  apply(ctx);
  const pre = handlers['tools/pre-execute'];

  await pre(exec('query_steady_state', {}), next);
  await pre(exec('query_conduction_chain', {}), next);

  const out = await toolNamed(tools, 'query_conduction_chain').execute({});
  assert.equal(out.lastConductionSubject, null, '尚无「非自查工具」的裁决 ⇒ 主体必须是 null');
  assert.deepEqual(out.lastConduction, [], '链必须是空数组，而不是从别处借一条');
  assert.match(out.lastConductionNote, /正向读数/, '说明里必须写清这是正向读数，不是错误');
});
