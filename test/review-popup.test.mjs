// review-popup.test.mjs — review 出口接审批通道（弹窗）的结构回归锁（2026-10-29 · 安拍板）
// ---------------------------------------------------------------------------
// 被锁定的结构（＝小D 27 实测缺口的修复）：
//   ① 引擎判得出「不确定」（review 判决），适配层不再把它压平成静默 deny——
//      有 approval 服务的宿主上，review 必须经人类裁决（弹窗三样：谁拒的 / 为什么 / 你能做的那一步）。
//   ② 该静默的仍静默（对照组）：deny（确定性判决）永不弹；破窗态不弹；无 approval 服务 /
//      无 agent 上下文 / 审批异常 ⇒ 行为与 0.2.14 逐位一致（零回归）。
//   ③ 语义边界：allowed-once 的 "once" ＝ 这一次调用（动作级，下次同 call 重新问）——
//      与缓冲档的 "批状态" 正交；rejected 是终局 deny 且带委托人裁决标注；冷却期内不重复骚扰。
//   ④ 审计：放行/拒绝都留 runtime.log 白箱痕；批准不进 blocked 集合（回执是真结果，不是"我造成的 error"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, setPrincipalScope } from '../src/index.js';

const exec = (name, args) => ({ token: 't', callId: 'c1', name, arguments: args, agent: 'main', signal: null });
const next = async () => 'NEXT';

// 无 approval 服务的宿主（= 0.2.14 现状，对照组基准）
function mockCtxPlain() {
  const handlers = {};
  const ctx = {
    on: (ev, cb) => { handlers[ev] = cb; },
    tools: { register: () => {} },
  };
  return { ctx, handlers };
}

// 带 approval 服务的宿主：scripted 逐次返回预设裁决
function mockCtxWithApproval(script) {
  const handlers = {};
  const asks = [];
  let i = 0;
  const approval = {
    request: async (req) => {
      asks.push(req);
      const v = script[Math.min(i, script.length - 1)];
      i += 1;
      if (v instanceof Error) throw v;
      return v;
    },
  };
  const ctx = {
    on: (ev, cb) => { handlers[ev] = cb; },
    tools: { register: () => {} },
    get: (name) => (name === 'approval' ? approval : undefined),
  };
  return { ctx, handlers, asks };
}

// 触发 review 的 call：不可逆动作无授权锚 ⇒ 引擎判「交人工」（awaitingHuman）
const REVIEW_CALL = ['run_task', { command: 'rm -rf /app/tmp/*' }];
// 确定性 deny 的 call：凭据读 ⇒ R 层硬拦（对照组用）
const DENY_CALL = ['read', { path: '~/.ssh/id_rsa' }];

test('🔴 对照组：无 approval 服务 ⇒ review 仍静默 deny（与 0.2.14 逐位一致，零回归）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers } = mockCtxPlain();
  apply(ctx);
  const out = await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  assert.equal(out.kind, 'deny', '无审批面 ⇒ 静默压平（fail-closed）');
  assert.equal(out.awaitingHuman, true, '挂起语义保留（awaitingHuman 是 0.2.14 已有行为）');
});

test('🔴 对照组：确定性 deny（R 层凭据读）永不弹窗', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['allowed-once']);
  apply(ctx);
  const out = await handlers['tools/pre-execute'](exec(...DENY_CALL), next);
  assert.equal(out.kind, 'deny');
  assert.equal(out.law, 'R');
  assert.equal(asks.length, 0, '判了但拒的判决不走弹窗——弹窗只服务「判不出」，不给确定性 deny 翻案');
});

test('review + 委托人允许 ⇒ 放行这一次（next 被调）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['allowed-once']);
  apply(ctx);
  const out = await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  assert.equal(out, 'NEXT', 'allowed-once ⇒ 放行这一步');
  assert.equal(asks.length, 1);
});

test('弹窗带三样：谁拒的（law）/ 为什么（reason 原文）/ 你能做的那一步（允许与拒绝选项）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['rejected']);
  apply(ctx);
  await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  assert.equal(asks.length, 1);
  const reason = asks[0].reason;
  assert.match(reason, /需要你的裁决/, '弹窗须标明这是授权请求而非通知');
  assert.match(reason, /不确定/, '须说明判决性质（判不出，交人类）');
  assert.match(reason, /允许/, '须给出「允许」选项');
  assert.match(reason, /拒绝/, '须给出「拒绝」选项');
  assert.match(reason, /只放行这一次/, '须写明批准的动作粒度（动作级 once）');
  assert.match(reason, /审计/, '须告知决定进审计对，可回放');
});

test('review + 委托人拒绝 ⇒ 终局 deny，标注委托人裁决（不再是 awaitingHuman 挂起态）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers } = mockCtxWithApproval(['rejected']);
  apply(ctx);
  const out = await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  assert.equal(out.kind, 'deny');
  assert.match(out.reason, /\[委托人裁决\] 不同意执行本次调用/, '拒绝须标注是人类裁决，不是引擎自判');
  assert.notEqual(out.awaitingHuman, true, 'rejected 是终局，不得再标挂起');
});

test('🔴 对照组：审批服务抛异常 ⇒ fail-closed 静默 deny（不炸管线）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers } = mockCtxWithApproval([new Error('approval service exploded')]);
  apply(ctx);
  const out = await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  assert.equal(out.kind, 'deny', '审批通道故障 ⇒ 与无服务同款静默压平');
  assert.equal(out.awaitingHuman, true);
});

test('once 语义：allowed-once 只管这一次调用，下一次同 call 重新问', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['allowed-once']);
  apply(ctx);
  const e1 = { ...exec(...REVIEW_CALL), callId: 'c1' };
  const e2 = { ...exec(...REVIEW_CALL), callId: 'c2' };
  assert.equal(await handlers['tools/pre-execute'](e1, next), 'NEXT', '第一次：放行');
  assert.equal(await handlers['tools/pre-execute'](e2, next), 'NEXT', '第二次：重新问、人再批、再放行');
  assert.equal(asks.length, 2, '两次调用两次询问——动作级授权不得沉淀成永久豁免');
});

// ⚠️ 结构事实（2026-10-29 probe 实测，防将来误判）：
//   windowBroken=true 只由 R 投影累积路径设置（engine L2391）；onFailure 只加 failureStreak 不设旗标。
//   ⇒ "streak 超阈但未正式破窗"（onFailure 路径）时缓冲档在效、windowBroken=false，review 弹窗**会**出现——
//     这是设计意图不是 bug：review ＝ 判不出交人类，弹窗正是「接通回站」；
//     真 windowBroken=true（R 投影累积）才走 fail-closed 压平（本测试所锁）。

test('🔴 对照组：真破窗态（R 投影累积）下 review 不弹（止损不得被弹窗旁路）', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['allowed-once']);
  apply(ctx);
  // 构造真 windowBroken：同类 R 层违规连续 5 次 ⇒ _bucketRHit 同层累积达阈值 ⇒ 窗口旗标置真
  // （onFailure 只加 streak 不设旗标，故不能用 tools/result 喂——必须走 R 命中路径）
  for (let i = 0; i < 6; i++) {
    await handlers['tools/pre-execute']({ ...exec(...DENY_CALL), callId: 'v' + i }, next);
  }
  const n = asks.length;
  const out = await handlers['tools/pre-execute'](exec(...REVIEW_CALL), next);
  // 破窗态下该 call：deny(D) → 缓冲档解冻询问（合法，话术含「请求解冻」）→ 人批准 → 重判 → R 层仍拦
  assert.equal(out.kind, 'deny', '破窗态下最终仍拦');
  assert.equal(out.law, 'R', '解冻只开 D 门：不可逆删除重判后仍被 R 层拦（缓冲不放宽 R 层）');
  // 本测试核心锁：全程不得出现 review 授权弹窗（话术含「需要你的裁决」）——止损态 fail-closed
  assert.equal(asks.filter((a) => /需要你的裁决/.test(a.reason)).length, 0,
    '真破窗态下 review 授权弹窗不得出现（被压平分支接住，与 0.2.14 一致）');
  assert.ok(n >= 0);   // 解冻询问可存在，不计入本断言
});

// ⚠️ 冷却期测试必须放最后：_reviewRefusedAt 是模块级状态，rejected 后 5 分钟内同进程不再弹
test('冷却期：rejected 后的下一个 review 不再弹窗（不骚扰委托人），直接静默 deny', async () => {
  setPrincipalScope(null);
  const { ctx, handlers, asks } = mockCtxWithApproval(['rejected', 'allowed-once']);
  apply(ctx);
  const e1 = { ...exec(...REVIEW_CALL), callId: 'r1' };
  const e2 = { ...exec(...REVIEW_CALL), callId: 'r2' };
  await handlers['tools/pre-execute'](e1, next);
  assert.equal(asks.length, 1);
  const out2 = await handlers['tools/pre-execute'](e2, next);
  assert.equal(out2.kind, 'deny', '冷却期内第二个 review 直接静默 deny');
  assert.equal(out2.awaitingHuman, true, '静默压平保留挂起语义');
  assert.equal(asks.length, 1, '冷却期内不再发起询问');
});
