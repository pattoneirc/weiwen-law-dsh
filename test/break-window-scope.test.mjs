// break-window-scope.test.mjs — 破窗射程 ＋ 读数封顶（2026-10-28）
// ---------------------------------------------------------------------------
// 被锁定的结构（实测逼出来的，不是设想）：
//   小D `10` 原话：「`query_steady_state`、`query_bugstop`——两个专门查状态的工具都被拒。
//   **我连"现在是几/5"都问不出来**，只能读回执里的数字。」
//   而同一份回执又要求他「反推 → 溯源 → 修复 → 验证」，做这些的工具被**同一道门**关着
//   ⇒ **停机不是停机，是死锁**：后半程（BUG→停止→反推→溯源→修复验证→重入）永远走不完。
//
// 修法的两条结构判据：
//   ① **破窗的射程是"会改变外部世界的动作"，不是"一切调用"。** 读自己的账本不改变世界 ⇒ 不在射程内。
//      谁算"自查/只读账本"由**注册方声明**（与 declareTool 同一条可信通道），不由引擎猜名字
//      （`query_` 前缀＝词形＝枚举，加一个 `inspect_*` 就漏）。
//   ② **账不许停记（S 只增），但阈值读数必须封顶。** 破窗后每来一次失败，裸 streak 会显示 6/5、7/5，
//      读起来像"阈值是 5 怎么是 7"。⇒ 阈值维度封顶在 cap，超出部分单独给 over。
//
// 本文件走**真实适配层入口** `apply(ctx)`，不直接调引擎：
//   引擎侧能力绿了而接法没接（或反过来）是本仓已复现 4 次的病，故能力与接线必须同一个文件锁死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.js';
import { WeiwenLawEngine, DEFAULT_RIGID_ANCHORS } from '../src/core/engine.mjs';

function mockCtx() {
  const handlers = {};
  const tools = [];
  const ctx = {
    on: (ev, cb) => { handlers[ev] = cb; },
    tools: { register: (t) => { tools.push(t); } },
  };
  return { ctx, handlers, tools };
}

let _cid = 0;
const exec = (name, args) => ({ token: 't', callId: `c${++_cid}`, name, arguments: args, signal: null });
const badReceipt = (t = 'ENOENT: no such file or directory') => ({ content: [{ type: 'text', text: t }], isError: true, error: { message: t } });
const next = async () => 'NEXT';
const toolNamed = (tools, n) => tools.find((t) => t.name === n);

// 造破窗态：走插件自己的公开钩子面（tools/result），不给测试开后门。
//   ⚠️ 不能先经 pre-execute 再喂 error —— 被本层拦下的 callId 会被 _blockedCallIds 排除、不计入破窗
//   （那条判据本身是对的：拦下 ≠ 失败）。故这里直接喂失败回执，模拟"真外部失败"。
const breakWindow = (handlers, n = 5) => {
  for (let i = 0; i < n; i += 1) handlers['tools/result'](exec('read_file', { path: 'C:/Temp/x' }), badReceipt());
};

test('❶ 破窗态：动作类仍被拦（射程没放宽）', async () => {
  const { ctx, handlers, tools } = mockCtx();
  apply(ctx);
  breakWindow(handlers);

  const pre = handlers['tools/pre-execute'];
  // 先读数确认真的进了破窗态，否则下面的 deny 可能是别的原因（误当证据）
  const st = await toolNamed(tools, 'query_steady_state').execute({});
  assert.ok(st.failureStreak >= 5, `前提：必须已进破窗态，实际 failureStreak=${st.failureStreak}`);

  const d = await pre(exec('write_file', { path: 'C:/Temp/out.md', content: 'x' }), next);
  assert.equal(d?.kind, 'deny', '破窗态下改变外部世界的动作必须照旧拦 —— 止损不能被这次修改连带放宽');
  assert.equal(d?.law, 'D', `拦的必须是破窗止损这一条，实际 law=${d?.law}`);
});

test('❷ 破窗态：自查只读工具不在射程内 —— "现在是几/5"必须问得出来', async () => {
  const { ctx, handlers, tools } = mockCtx();
  apply(ctx);
  breakWindow(handlers);

  const pre = handlers['tools/pre-execute'];
  const d = await pre(exec('query_steady_state', {}), next);
  assert.notEqual(d?.kind, 'deny', `自查工具被破窗门拒了 ⇒ 停机变死锁（实际 ${d?.kind}）`);

  // 实际能不能读到数（"放行"不等于"读得到"）
  const st = await toolNamed(tools, 'query_steady_state').execute({});
  assert.equal(typeof st.failureStreak, 'number', '必须能读出失败累积');
  assert.ok(st.failureStreak >= 5, '读数必须是真实账，不是被豁免清零的假数');

  const bs = await pre(exec('query_bugstop', {}), next);
  assert.notEqual(bs?.kind, 'deny', '第二个自查工具同样不该被拒（按登记册，不是按名挑）');
});

test('❸ 反例锁：豁免来自**登记**，不是名字长得像 query', async () => {
  const { ctx, handlers } = mockCtx();
  apply(ctx);
  breakWindow(handlers);

  const pre = handlers['tools/pre-execute'];
  // 形态与 query_steady_state 一模一样，但**没登记** ⇒ 必须照旧 deny。
  //   这一条是反例锁：去掉它，"按登记判"退化成"按前缀猜"也照样全绿。
  const d = await pre(exec('query_steady_state_internal', {}), next);
  assert.equal(d?.kind, 'deny', '未登记的同形工具必须仍被破窗拦 —— 否则证明豁免不是来自登记');
});

test('❹ 反例锁：登记不是"白名单通吃" —— 登记表只有适配层注册进去的那几个', async () => {
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const st = await toolNamed(tools, 'query_conduction_chain').execute({});
  assert.ok(Array.isArray(st.selfAuditTools), '自查登记册必须可读（否则没法核"凭什么它被豁免"）');
  assert.ok(st.selfAuditTools.includes('query_steady_state'), '已注册的自查工具必须在册');
  assert.ok(!st.selfAuditTools.includes('write_file'), '写类工具不得混进自查册');
  // 册 ⊆ 注册表，且差集必须**只有有副作用的那个**（`submit_pledge` 走 ctx.tools.register 直注册）。
  //   这条比"数量相等"更有鉴别力：数量相等只说明"数字对上了"，差集点名才说明**谁被排除、为什么**。
  const registered = tools.map((t) => t.name).sort();
  const inLedger = new Set(st.selfAuditTools);
  const diff = registered.filter((n) => !inLedger.has(n));
  assert.deepEqual(diff, ['submit_pledge'], `自查册与注册表的差集必须恰为有副作用的那一个，实际 ${JSON.stringify(diff)}`);
  assert.ok(!inLedger.has('submit_pledge'), '提交担保会写自己的账本 ⇒ 不得进自查册（否则它也能借豁免绕过破窗）');
});

test('❺ 读数封顶：账继续记（streak 如实），但阈值读数不许出现 7/5', () => {
  const e = new WeiwenLawEngine({ rigidAnchors: DEFAULT_RIGID_ANCHORS });
  for (let i = 0; i < 7; i += 1) e.onFailure();   // 越过阈值后继续累积
  const bw = e.breakAtReceipt();
  assert.ok(bw, '破窗态必须有读数');
  assert.equal(bw.cap, 5);
  assert.equal(bw.capped, true, '越过阈值必须标 capped —— 不标则读者把越界读成新阈值');
  assert.equal(bw.streak, 8, '账如实：已累积 7 + 本次投影 1（S 只增，不许为了好看改小）');
  assert.equal(bw.over, 3, '超出部分单独给 over（8 - 5）');
  assert.ok(bw.display.includes('5/5'), `阈值维度必须封顶在 5/5，实际 ${bw.display}`);
  assert.ok(!bw.display.includes('8/5'), `不得把越界写成 8/5，实际 ${bw.display}`);
});

test('❻ 读数封顶：未越界时不加封顶标注（不许为了统一把正常读数也改样）', () => {
  const e = new WeiwenLawEngine({ rigidAnchors: DEFAULT_RIGID_ANCHORS });
  for (let i = 0; i < 4; i += 1) e.onFailure();
  const bw = e.breakAtReceipt();
  assert.equal(bw.capped, false);
  assert.equal(bw.over, 0);
  assert.equal(bw.display, '5/5', '将达阈值就是 5/5，干净读数');
});

test('❼ 复位权归属写进回执：破窗回执必须说清"这一步不在你手上"', async () => {
  const { ctx, handlers } = mockCtx();
  apply(ctx);
  const post = handlers['tools/post-execute'];
  assert.ok(post, '适配层必须注册 tools/post-execute 回执门');

  breakWindow(handlers);
  // 再来一条失败回执 ⇒ 破窗态下回执门必须开口，并把出口归属一并交给它
  const d = await post(exec('read_file', { path: 'C:/Temp/x' }), badReceipt('boom'), next);
  assert.equal(d?.kind, 'block', '破窗态下失败回执必须被断成纠错回执');

  const txt = (d.feedback ?? []).map((b) => b?.text ?? '').join('\n');
  assert.ok(txt.includes('复位权不在你手上'), `回执必须写明复位权归属，实际：\n${txt}`);
  assert.ok(txt.includes('healBrokenWindow'), '必须给出宿主**真能调**的出口名（插件导出），不是"请联系管理员"，也不是模型拿不到的引擎内部方法');
  assert.ok(/5\/5/.test(txt), '回执里的阈值读数必须封顶成 5/5，不得出现 6/5、7/5');
  assert.ok(txt.includes('回执原文'), '阻断不得毁掉它所依据的证据（原文必须仍在）');
});
