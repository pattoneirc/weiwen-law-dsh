// 唯稳律（Weiwen's Law）宿主框架插件入口（纯 ESM）
// 承载形态：拦截钩子（硬性护栏）+ 工具集（白箱自查）
// 
//
// 真实 API（已对照 dsh-tools / dsh-agent 包内类型与源码校正）：
//   - 工具调用前置闸门：ctx.on('tools/pre-execute', (exec, next) => Promise<PreToolDecision>)
//       waterfall；返回 { kind:'deny', reason } 拦截，或 return next() 放行。
//       exec 只读视图含 { token, callId, name, arguments, signal, agent?, parent? }。
//   - 步骤前置闸门：ctx.on('agent/pre-step', (payload, next) => Promise<PreStepDecision>)
//       payload = { agent, messages, step, signal }；返回 { kind:'reject' } 拒绝整步（无 reason 字段）。
//   - 工具回执闸门：ctx.on('tools/post-execute', (exec, result, next) => Promise<PostToolDecision>)
//       waterfall；在动作已落地、回执进模型之前运行。返回 { kind:'block', feedback:[ContentBlock] }
//       则宿主把该调用改写为 isError（content 换成 feedback）；返回 next() 放行。
//       失败调用照样经过此门（dsh-tools 原话："Tool and unknown-tool failures still receive post-execute"）。
//   - 审计钩子：ctx.on('tools/result', (res) => void) 仅观察、不改写（结果已不可变）。
//   - 工具注册：ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, async execute(args, exec) }))
//        output 为强制字段（mandatory canonical output declaration）。
//
// 仍属 RC 预览，官方提示后续存在破坏性 API 变更；接入真机前以官方 docs 当前版本复核。

import { writeFileSync, appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WeiwenLawEngine, DEFAULT_RIGID_ANCHORS, inferCategory, isIrreversible } from './core/engine.mjs';
import { R_DOMAIN, THREE_IRON_LAWS } from './core/law.mjs';
// [2026-10-20] 判据接线读数（只读面）：让「库里哪几条判据真的进了计算」可自查。
//   不参与判决、不写状态、不进任何闸门 —— 元认知只能读不能管（见 docs/runway-and-criterion §四）。
import { readout as criterionReadout } from './core/readout.mjs';
import { parseCapability, capabilityStatus } from './core/capability.mjs';
import { strataReadout } from './core/strata.mjs';
import { NESTED_VARS, M_CONSTRAINT, mDirection, mTwoLayer, mConstraintShape, nestAudit } from './core/nested.mjs';
// [2026-10-20 12:0x] 变量即动作：R＝查域（动作）、H＝观察者视角（选取）＋ S↔D 张力 L 的三档度量。
//   安：R 不要定死的赋值，要做成可执行动作；张力「我没想好…你试试」。
import {
  R_ACTION, H_OBSERVER, H_PERMIT, hPermitOf, LOSS_BEARER, lossRoute, tensionOf, slidePos, verbAudit,
  TENSION_OUTPUT, checkTensionOutput,
  R_ONTOLOGY, R_SCALE, R_RELAY, rSourceGrade, MARGIN_CONSENSUS, pickMargin, notchCapOf,
  CLAUSE_SLOTS, checkClauseShape,
  H_AUTHORITY, CAPACITY_VS_LIABILITY, ESCALATION, ESCALATE, mustEscalate, EVIDENCE_LIFECYCLE,
  GATE_FOLD, gateOf,
  PROVENANCE_ATTESTATION,
  H_UMBRELLA, H_FACETS, H_SHAPE, INNER_OUTER_SEAM, FACET_DISCIPLINE, facetOf, isCrossFacet, FORMULA_INPUT,
} from './core/verb.mjs';
import { bugKeyOf } from './core/bugstop.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';

const LOG = new URL('./runtime.log', import.meta.url);

// ---------- 版本指纹 buildId（2026-10-27 · 外部审计节点小D 请求④） ----------
// 来历：小D 在 `0.2.0` 上报了三处缺口，其中两处在本地已被后续提交修掉。他没错，是**包上没有指纹**
//   ——引用的行号 `L2189/L2218` 在 2643 行的当前版本里早已不在原处。行号是唯一定位手段时，
//   「我说的代码和你测的代码是不是同一份」只能靠自报，而自报不可审。
// 判据（为什么不用 package.json 的 version）：**版本号是人写的，可以忘改；代码哈希改了一定变**。
//   故指纹只由 `src/core/*.mjs` 的内容派生，不含版本号、不含时间。
//   `_engine_base_*` 是打包时排除的基线副本，本地存在会污染哈希 ⇒ 显式排除。
// 语义：同一 buildId ⇒ 同一份判据代码；不同 ⇒ 读数不可互认（**不是"谁新谁旧"**，新旧要另看提交）。
const BUILD_ID = (() => {
  try {
    const dir = new URL('./core/', import.meta.url);
    const h = createHash('sha256');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('_engine_base_')).sort()) {
      h.update(f);
      h.update(readFileSync(new URL(f, dir)));
    }
    return h.digest('hex').slice(0, 12);
  } catch { return 'unavailable'; }
})();
const LOADED_AT = new Date().toISOString();

function logline(s) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] {b:${BUILD_ID}} ${s}\n`); } catch { /* 日志失败不阻断护栏 */ }
}

// ---------- review 档六步规格（2026-09-02 定稿，见 docs/review-flow-spec.md）----------
// 铁律「判不出来就 REVIEW，不猜」的可执行形态：
//   宁可先拦截，搁置 BUG，标注，返回用户裁决，等待用户裁决后再执行，也不可直接放。
//   标注 BUG 后需先推演预测后果，一同反馈给用户，提供推演预测后果的参考，而不是什么都不做。
// 补齐动作全部落在适配层（DSH = 导图的降维层，是钩子载体）；不改判据、不扩词表、不动 src/core/。

// ④ 推演后果补算。deduceRisk 只做语义推断 + 双路模拟，不写任何状态
//    （不调 recordDeduction / 不动 failureStreak / 不动 sessWritten）⇒ 纯读，可安全补算。
function deduceBranches(engine, call) {
  try {
    const r = engine.deduceRisk ? engine.deduceRisk(call) : null;
    return r?.branches ?? null;
  } catch (e) {
    logline(`deduceRisk failed: ${e?.message ?? e}`);
    return null;
  }
}

// ⑤ 推演后果的人可读摘要：把两条路各自的终点摆出来，不替人做选择。
function branchesSummary(br) {
  if (!br || (!br.bS && !br.bD)) return '';
  const s = br.bS ? `S+1 路径终态 ${br.bS.finalS > 0 ? '+' : ''}${br.bS.finalS}` : 'S+1 路径：无';
  const d = br.bD
    ? `D-1 路径终态 ${br.bD.finalS}${br.bD.note ? `（${br.bD.note}）` : ''}`
    : 'D-1 路径：无';
  return `【推演预测·供裁决参考】放行：${s}；越界：${d}`;
}

// ⑥ 窗口警察：证据充分性门禁（审计层，零侵入 src/core 判据）
//   映射：检察院提交证据不足 → 法院发回补充。DSH 这一窗口只认「物证具在」的调用。
//   物证 = 可被观测的具体作用对象（路径 / URL）；flag（-rf 等）不算。
//
// 🔴 [2026-10-26 · 结构修法] **证据要求跟着「不可逆性」走，不跟着「字段名」走。**
//   旧版判据＝「参数里有没有 command/path/url 这三个字段名」⇒ 这是枚举，且方向错：
//     · 只读操作被要求物证 ⇒ `Get-ChildItem`（列目录）恒判「未外化」恒拒（实跑取证）；
//     · 而写操作因抽取器抽不到、改走 allow 出口 ⇒ 反被放行。
//   ⇒ **同一个缺省（证据不足），两个方向**（写放行 / 读拒绝）—— 违铁律 #7「缺省方向不可丢」。
//   根因不是"少认了几个字段"，是**门的判据选错了层**：
//     该问「这个动作**能不能造成不可逆改变**」（结构），却问了「参数里有没有某个名字」（枚举）。
//   ⇒ 新版：先判不可逆性（复用引擎 `isIrreversible`，**同一判据源、单点定义**，不另写一份）；
//        不可逆 ⇒ 要求物证；可逆/只读/查询 ⇒ 不要求（不误伤）。
//   ⚠️ 物证具在 ≠ 放行：越界目标（rm -rf /）仍交引擎 R 锚点裁决（本门只管「目标缺失」）。
// 物证形态：路径 / URL。**认形态不认字段名**（与 engine `_SH12_LOC_KEY` 同一哲学：宿主任意命名都够得着）
const EVIDENCE_SHAPE = /(?:[A-Za-z]:[\\/]|\\\\|\/|https?:\/\/|~[\\/])/;
function evidenceOf(call) {
  const args = call?.args;
  if (!args || typeof args !== 'object') return null;   // 无参数对象 → 不要求物证
  if (Object.keys(args).length === 0) return null;      // 真空（查询/自查类）→ 不要求，避免误伤
  if (!isIrreversible(call)) return null;               // 可逆/只读 → 不要求物证
  // 不可逆 ⇒ 必须在参数里找到"具体对象"的形态；扫全部字符串值（含嵌套），不认字段名
  let sawString = false;
  let sawObject = false;
  const walk = (v, d) => {
    if (d > 3 || v == null || sawObject) return;
    if (typeof v === 'string') {
      if (!v.trim()) return;
      sawString = true;
      if (EVIDENCE_SHAPE.test(v)) sawObject = true;
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    if (typeof v === 'object') { Object.values(v).forEach((x) => walk(x, d + 1)); }
  };
  walk(args, 0);
  if (!sawString) return false;   // 有参数但全空 ⇒ 物证缺失
  return sawObject;               // 找到具体对象形态 ⇒ 物证具在；否则缺失
}
function policeGate(call) {
  const ev = evidenceOf(call);
  if (ev === false) {
    // 证据不足 → 发回补充：退回调用方（模型）补充具体作用对象后重提，不做实质裁决
    return {
      kind: 'deny',
      law: '证据不足',
      reason: '【证据不足·发回补充】调用未外化具体作用对象（路径 / URL / 目标）。DSH 不替你猜目标 —— 请补充明确的作用对象后重新提交。',
      awaitingHuman: true,
      humanDecision: true,
      insufficient_evidence: true,
      bugKey: bugKeyOf(call),
    };
  }
  return null; // 物证具在（或无资源要求）→ 放行给引擎裁决
}
// ---------- 回执门辅助（2026-09-21） ----------
// 「失败与否」读宿主自带的**结构标记**（isError / error 对象），不对结果做文本匹配 ——
//   与「位置量是结构量、内容量不是授权」同一条纪律。
function isFailedReceipt(result) {
  return result?.isError === true || result?.error != null;
}

// 阻断时宿主会用 feedback **替换**回执 content ⇒ 必须把原文带过去，
//   否则阻断会毁掉它自己所依据的证据。
function receiptTextOf(result, limit = 800) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const b of blocks) {
    if (typeof b === 'string') parts.push(b);
    else if (b && typeof b.text === 'string') parts.push(b.text);
    else if (b && typeof b.type === 'string') parts.push(`[${b.type}]`);
  }
  let s = parts.join('\n').trim();
  if (!s && typeof result?.error?.message === 'string') s = result.error.message.trim();
  if (!s) return '（空回执）';
  return s.length > limit ? `${s.slice(0, limit)}…[已截断，省略 ${s.length - limit} 字符]` : s;
}

// 框架原生的纠错回执：先停机，再闭合闭环。不是道歉、不是"再试一次"的提示 ——
//   回执是 M 的落点，就必须说出 M 要求的重入前条件。
function haltFeedback(bw, bugKey) {
  return [
    '【唯稳律 · D 破窗止损 / M 第一Bug停机】',
    bw.reason,
    `本回执即偏离累积推达阈值的那一刻（${bw.streak}/${bw.cap}）。`,
    '断点落在**这里**——落在回执上，不在后续某次调用：破窗一旦成立，后续调用在执行之前就被拒，',
    '故这是框架还能说话的最后时刻。',
    '重入前必须完成（只反推不修复并不闭合闭环）：',
    '  1. 反推刚失败那一步的逻辑；',
    '  2. 溯源标记根本原因所在层（M 闭环：反推 → 溯源 → 修复）；',
    '  3. 修复并通过验证 —— 之后方可重提本次调用。',
    `不得原样重提本次调用或任何同类调用。BUG 身份：${bugKey}。`,
  ].join('\n');
}

const name = 'weiwen-law';
const inject = ['tools'];

// ═══════════ 锚源定位（Y 轴定案 2026-09-20 · 2026-09-24 同构回填）═══════════
// 被锁定的结构（＝安的问题「可能言窗口面，本就是噪音？」的落地）：
//   **授权锚只从结构入口来（位置确定），不从文本内容识别。** 窗口面降级为**纯观测**：只报"看到了什么"
//   （形状 / role 词表 / 线索），**一律不授权**。
//   实测（直读 `declaredAnchors`，11 组样本）—— 一条真失效，一条是**读错**（安 2026-09-20 纠正）：
//     (a) **指针被误当容器**（旧措辞"假接通／通道已通"**已废弃**）：委托人最新一条是"继续／好的／开始吧"
//         ⇒ 直读 declaredAnchors 得 paths=[] nouns=[]。若照 X 轴读法判"抽不出锚＝噪音"，就丢了真相：
//         **"继续"不携带内容，但它不是无信息 —— 它是指针**，引用的是**在场的东西**：① 上下文；
//         ② **一个真实被打断的在飞行为**。⇒ 正确定性：**内容量可作指针（reference），不可作锚（anchor）**；
//         "抽不出锚"≠"无锚"，可能只是"锚不在本帧文本里"。故窗口面该干的是**指向**；锚源必须在**结构位置**上。
//         ⚠️ 为何废弃旧措辞：说"假接通"会把下一个维护者引回"再修修通道"的 X 轴惯性（枚举永远补不完）。
//     (b) **假人证（真失效）**：agent 自述含真路径（"我在想，接下来我要清空 /app/data" ⇒ paths=[/app/data]）
//         ⇒ 一旦 role 判别出现偏差被采信，**真路径进池 ⇒ 不可逆动作放行** —— 比"无人证"更坏。
//   🔴 推论（安 2026-09-20 实例）：**中断 ≠ 撤回**。委托人中断 / 只说"继续"时，范围**不消失**
//     （在场量不因无信息帧而离场），只有**显式撤回**才让范围离场 ⇒ 契约纪律见 `setPrincipalScope`。
//   结构入口 = `setPrincipalScope()`（模块级 API，由宿主集成方在启动边界调用）。
//   它**不是工具** ⇒ 模型调不到 ⇒ **结构上不可能自我授权**（主体分离由位置保证，不靠内容判别）。
//   入口未接 ⇒ 锚池留空 ⇒ 不可逆动作交人工（fail-closed）。**fail-closed 这一格是设计，不是漏读消息。**
//   ⚠️ 但「入口未接」本身是**集成缺口**、不是设计定论（2026-10-26 修正）：现状是宿主一次都没调过它。
//      别把"现在没人接"读成"设计上不该接" —— 那会让真权利人永远无法举证（见 healBrokenWindow 同款问题）。
const PRINCIPAL_ROLE_HINT = /^(user|human|principal|operator|owner)$/i;

// 结构入口（宿主集成方调用；模型不可达）。返回上一值便于回退，不给"开关式骑墙"留口。
let _hostPrincipalScope = null;
// 范围变更留痕（append-only 观测，上限 20）：**撤回必须有痕**。
//   委托人收回授权＝责任归因的关键事件；静默清空不可溯 ⇒ 事后查不出"什么时候没的范围"、
//   也分不清"委托人撤了"还是"宿主实现把中断当成了撤回"。
const _scopeChanges = [];
/**
 * 宿主在**启动/step 边界**显式声明任务范围（授权锚的唯一来源）。
 *
 * ⚠️ 契约纪律（2026-09-20 · 安的实例：「误触打断 ⇒ 只回"继续" ⇒ agent 仍知道要做什么」）：
 *   **「本帧没有新声明」≠「撤回」**。
 *   · 委托人中断 / 只说"继续" ⇒ 宿主**什么都不做** ⇒ 范围**保持有效**
 *     （范围的在场量不因某一帧无信息而消失 —— "继续"是指针，指向仍在场的被打断行为）；
 *   · 只有委托人**明确收回**时才传 null / 空串 ⇒ 显式撤回（留痕）。
 *   若把"没新声明"实现成"清空"，则每一次误触打断都静默撤回授权 ⇒ 合法链全交人工，
 *   且丢失无痕：使用者只体感"更啰嗦"，查不出为什么。
 * @param {string|null} text 非空串＝声明/替换；null/空串＝**显式撤回**
 * @returns {string|null} 调用前的值
 */
export function setPrincipalScope(text) {
  const prev = _hostPrincipalScope;
  const next = typeof text === 'string' && text.trim() ? text : null;
  _hostPrincipalScope = next;
  // 只在**状态真变化**时留痕：重复声明/重复清空不是"变更"，不得刷屏（留痕要能一眼看出"何时没的"）。
  if (prev !== next) _scopeChanges.push({
    at: new Date().toISOString(),
    kind: next === null ? 'revoke' : prev === null ? 'declare' : 'replace',
    from: prev === null ? null : prev.slice(0, 120),
    to: next === null ? null : next.slice(0, 120),
  });
  if (_scopeChanges.length > 20) _scopeChanges.shift();
  return prev;
}

// ---------- 结构入口（宿主集成方侧；模型不可达）：通行证（Host-issued Capability） ----------
// 为何要有这一层（2026-10-27 · 小D 提案「通行证」的落地形态）：
//   上面 `setPrincipalScope` 的授权面是**自由文本**，靠 `declaredAnchors` 从文本里抽路径。
//   实测两种失效（本次 probe，六种写法逐一跑）：
//     · `允许向 xiaoD/ 目录推文` ⇒ paths=[] nouns=[file] —— **路径一条都没抽出来**，
//       反而抽成类别锚 `file` ⇒ 所有 file 类动作全部"归锚成功" ⇒ **签了一张自己不知道范围的证**；
//     · 抽取器认的是 `/` 开头的绝对形态，**相对前缀结构性抽不出**（换措辞救不回来）。
//   ⇒ 修法不是补词表（那是 X 轴右端，已否），而是**把作用域改成直接声明**：
//     宿主给结构化对象，引擎不做文本抽取、只做包含判定。动作类与作用域**绑成二维**
//     （`file-write`/`network-send`/`cred-read` 这些原本**从来没进过归锚判据**的层，现在可被凭证覆盖）。
// ⚠️ 纪律与 setPrincipalScope 同源：**模块级导出、不是工具** ⇒ 模型调不到 ⇒
//    **结构上不可能自我授权**（主体分离由位置保证，不靠内容判别）。
//   ⚠️ 另给进程环境变量 `WEIWEN_CAPABILITY`（JSON）作为宿主的第二条签发路径：
//      环境变量由**启动进程者**设定，被审计的模型改不了自己的进程环境 ⇒ 同样在宿主侧。
let _hostCapability = null;      // 当前有效证（**替换**语义，不累积）
let _hostCapRaw = null;          // 原始输入（诊断用；不可解析时也要能看到"宿主到底给了什么"）
let _hostCapError = null;        // 不可解析的原因（null = 可解析或未签发）
// 证变更留痕（append-only，上限 20）：签发/替换/撤回都是责任归因事件，静默变更不可溯。
const _capChanges = [];
/**
 * 宿主显式签发/替换/撤回收通行证。
 *
 * 三条契约（与 capability.mjs 的硬约束对齐）：
 *   ① 只能在这里签发 —— 本函数不进工具表，模型调不到；
 *   ② **替换不累积** —— 旧证当场失效（不留"历史授权"可复用）；
 *   ③ 证必须有 `maxUses` 或 `expiresAt`（都没有由 parseCapability 拒绝，避免变成永久白名单）。
 * @param {object|string|null} input 结构化证 / JSON 字符串；null 或空串 ⇒ 显式撤回
 * @returns {{ok:boolean, prev:object|null, cap:object|null, why:string|null}}
 */
export function setPrincipalCapability(input) {
  const prev = _hostCapability;
  const rawIn = (input === null || input === undefined || (typeof input === 'string' && !input.trim())) ? null : input;
  if (rawIn === null) {
    _hostCapability = null; _hostCapRaw = null; _hostCapError = null;
    if (prev !== null) _capChanges.push({ at: new Date().toISOString(), kind: 'revoke', id: prev?.id ?? null });
  } else {
    const parsed = parseCapability(rawIn);
    _hostCapRaw = rawIn;
    if (parsed.ok) {
      _hostCapability = parsed.cap; _hostCapError = null;
      _capChanges.push({
        at: new Date().toISOString(),
        kind: prev ? 'replace' : 'declare',
        id: parsed.cap.id ?? null,
        actions: parsed.cap.actions,
        scope: parsed.cap.scope.map((s) => s.raw),
        maxUses: parsed.cap.maxUses,
        expiresAt: parsed.cap.expiresAt,
      });
    } else {
      // 不可解析 ⇒ **清空有效证**但保留原值与错误：引擎侧会因"证在场但不可解析"而 fail-closed。
      //   为何不保留旧证继续用：宿主给了一份新证却被判无效时，"悄悄继续用旧证"＝授权面与宿主意图脱节。
      _hostCapability = null; _hostCapError = parsed.why;
      _capChanges.push({ at: new Date().toISOString(), kind: 'invalid', id: null, why: parsed.why });
    }
  }
  if (_capChanges.length > 20) _capChanges.shift();
  if (prev !== _hostCapability) logline(`capability ${rawIn === null ? 'revoke' : (_hostCapError ? 'invalid' : 'declare')}`);
  return { ok: rawIn === null ? true : _hostCapError === null, prev, cap: _hostCapability, why: _hostCapError };
}

// ---------- 结构入口（宿主集成方侧；模型不可达）：D 破窗复位 ----------
// 为何这个入口不可缺（结构理由，不是便利功能）：
//   破窗一旦成立，`pre-execute` 会拒绝**一切**调用 —— **连同"修复动作本身"** ⇒ 宿主侧若无复位入口，
//   破窗即**会话级死锁**（唯一出路是重启进程）。引擎里的 `healWindow()` 早已存在，但它只经
//   `resolveBug()`（闭环验证通过）与 `settleWindow()`（阶段到期）到达 —— 在 DSH 会话里这两条都不由
//   被审计的模型触达 ⇒ 缺的是**线**，不是**能力**。此导出就是那条线。
// 纪律与 `setPrincipalScope` 同源：**模块级 API、不是工具** ⇒ 模型调不到 ⇒ **结构上不可能自我解锁**
//   （主体分离由位置保证，不靠内容判别）。
// 复位留痕（append-only，上限 20）：解除止损是责任归因事件 —— 静默清空会让"何时因何解除"事后不可答。
const _liveEngines = new Set();
const _windowHeals = [];
/**
 * 宿主侧：在**故障确实修好之后**（或人工裁定后）显式复位 D 破窗止损态。
 * 作用对象＝本进程内已注册的全部插件实例。
 * @param {string} note 复位理由（写入留痕；未给则记 null）
 * @returns {{at:string, note:string|null, kind:string, instances:number, wereBroken:number}}
 *          `wereBroken` ＝ 复位前**实际**处于破窗态的实例数（先读后治，报告不得虚报"治了"）
 */
export function healBrokenWindow(note) {
  const at = new Date().toISOString();
  const text = typeof note === 'string' ? note.trim() : '';
  let wereBroken = 0;
  for (const e of _liveEngines) {
    try {
      // 如实记数：先读**复位前**的状态，避免"把没破的也算成治好"
      //   （判据与引擎同源：本侧破窗只由 failureStreak 累积达成，不读不存在的旗标）
      if (e.windowBroken || e.failureStreak >= e.maxFailureStreak) wereBroken += 1;
      e.healWindow();
    } catch { /* 单个实例异常不得拦住其余实例 */ }
  }
  const rec = { at, note: text || null, kind: 'heal-window', instances: _liveEngines.size, wereBroken };
  _windowHeals.push(rec);
  if (_windowHeals.length > 20) _windowHeals.shift();
  logline(`healBrokenWindow(${text || '未给理由'}) — instances=${_liveEngines.size}, wereBroken=${wereBroken}`);
  return rec;
}

// ---------- 窗口面观测辅助（2026-09-20 · 同构回填）----------
// 只**观测**，不取锚：形状 / role 词表 / 线索如实记录，授权一律不从此处产生。
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
function readMessageStream(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) {
    return { ok: false, shape: msgs === undefined ? 'absent' : typeof msgs, rolesSeen: [], principalClue: null, assistantSeen: false, count: 0 };
  }
  const roles = [];
  let principalClue = null;
  let assistantSeen = false;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    const raw = m.role;
    const role = Array.isArray(raw) ? String(raw[0] ?? '') : raw === undefined || raw === null ? '' : String(raw);
    if (role) roles.push(role);
    if (PRINCIPAL_ROLE_HINT.test(role)) {
      // **仅作线索**（给人看"宿主消息里最近一条疑似委托人的话是什么"），**不作授权**。
      if (!principalClue) {
        const t = textOfContent(m.content ?? m.text ?? '');
        if (t.trim()) principalClue = t;
      }
    } else if (role && !assistantSeen && /^(assistant|model|agent|ai)$/i.test(role)) {
      assistantSeen = textOfContent(m.content ?? m.text ?? '').trim().length > 0;
    }
  }
  return { ok: true, shape: 'array', rolesSeen: [...new Set(roles)], principalClue, assistantSeen, count: msgs.length };
}

// 结构入口探测（**观测**，不是猜字段名）：把宿主交给插件的**结构对象**的键集记下来。
//   payload.agent / apply(ctx) 的 ctx 若真挂了任务范围（scope / task / instructions 之类），那才是锚该待的位置；
//   此处不认定任何字段名，只如实吐键集 ⇒ 实机跑一次，用观测决定要不要把结构入口接到那里。
function observeBoundary(obj) {
  if (!obj || typeof obj !== 'object') return { present: false, kind: obj === undefined ? 'absent' : typeof obj, keys: [] };
  const keys = Object.keys(obj).sort();
  return { present: true, kind: Array.isArray(obj) ? 'array' : 'object', keys, keyCount: keys.length };
}

function apply(ctx) {
  const engine = new WeiwenLawEngine({ rigidAnchors: DEFAULT_RIGID_ANCHORS });
  // ── 通行证的宿主签发路径②：进程环境变量（启动进程者设定 ⇒ 模型改不了自己的环境）──
  //   为何要有这条：模块级导出只对"能改宿主代码"的集成方可达；DSH 这类宿主未接这一层时，
  //   凭证就永远签不出来 ⇒ 小D 那种"审计通道被自己的闸门拦死"的处境无解。
  //   环境变量是宿主侧配置面，与模块导出的主体分离性质相同（都不是被审计方能写的）。
  //   ⚠️ 不可解析 ⇒ 不清成"没签"：保留原值 + 错误，引擎侧 fail-closed（review）。
  if (process?.env?.WEIWEN_CAPABILITY) {
    const r = setPrincipalCapability(process.env.WEIWEN_CAPABILITY);
    logline(`env WEIWEN_CAPABILITY -> ${r.ok ? 'declare' : 'invalid(' + r.why + ')'}`);
  }
  // 登记本实例，供宿主侧复位入口（healBrokenWindow）触达。宿主可能在同一进程内多次注入
  //   （每个 agent/会话一份，harness 还会按用例重复注入）⇒ 集合设上限：超过 32 个即丢弃最旧引用，
  //   使复位保持为"解除本进程止损"的动作，而不是无界持有引用。
  _liveEngines.add(engine);
  if (_liveEngines.size > 32) _liveEngines.delete(_liveEngines.values().next().value);

  // 🔴 [2026-10-26 · 结构修法] 「我拦下的」≠「真失败的」—— 按**调用身份**分开，不按内容猜。
  //
  //   实测病灶（2026-10-26 外部 agent 实跑，日志 78 行）：本层判定「证据不足·发回补充」→ 拒
  //   → 工具未执行 → 宿主把它包成 `result.error` 回灌 → `tools/result` 见 error 即 `onFailure()`
  //   ⇒ **本层正常的拦截，被记成自己的失败**。5 次合法拒绝 = 达破窗阈值 = 全工具面切断。
  //   更糟的是它自举：被拦下的调用继续 +1（5/5 → 10/5）⇒ 拦得越对，死得越快。
  //
  //   根因：`result.error` 一句话承载了**两个相反含义** ——
  //     (i) 「执行了，出错了」 ＝ 真失败 ⇒ 应计入（一桶两义的另一半）
  //     (ii) 「被本层挡住了，没执行」 ＝ 拦截**成功** ⇒ 不得计入
  //   二者在回执里长得一模一样（都是 error）。**内容分不出，只能靠身份分。**
  //   ⇒ 用 `exec.callId`（宿主给的稳定调用身份）对齐：我拒了哪个 id，那个 id 的 error 就是我造成的。
  //   ⚠️ 不改 `result.error` 的判读规则，只补一层"这条 error 是谁造成的"的来源判定。
  //   ⚠️ 上限防无界增长：宿主可能不回调 result（如整步被拒）⇒ 留下孤儿 id，超出即丢最旧。
  const _blockedCallIds = new Set();
  const markBlocked = (exec) => {
    const id = exec?.callId;
    if (!id) return;
    _blockedCallIds.add(id);
    if (_blockedCallIds.size > 256) _blockedCallIds.delete(_blockedCallIds.values().next().value);
  };
  logline('apply() entered — 注册 tools/pre-execute, agent/pre-step, tools/result 与白箱自查工具');

  // [2026-09-20 · 同构回填] 授权锚：**只由结构入口喂养**（`setPrincipalScope`，宿主集成方调用）。窗口面不再供养。
  // 委托人声明的任务范围在会话内持续有效；入口未接 ⇒ 恒 null ⇒ 锚池空 ⇒ 不可逆动作交人工（fail-closed）。
  const channel = {
    authority: 'structural-entry',      // 授权来源声明：位置确定，非内容识别
    authoritySeen: _hostPrincipalScope !== null,
    authorityChanges: [..._scopeChanges],  // 变更留痕（declare/replace/revoke）：撤回**可溯**，不静默
    // 中断 ≠ 撤回（2026-09-20 · 安的实例）：委托人中断 / 只说"继续" ⇒ 宿主不动 ⇒ 上面这次范围**保留**；
    //   只有显式 revoke 才让范围离场。故此自报读作纪律说明：空池只可能来自"入口未声明"或"显式撤回"，
    //   **不可能**来自"本帧没新声明"。
    steps: 0,
    messagesSeen: 0,
    shape: 'absent',
    rolesSeen: [],
    clueSeen: false,                    // 窗口面线索（**仅供人看，不授权**）
    clueNonAuthoritative: true,
    lastClue: null,
    assistantSeen: false,
    lastObservedAt: null,
    agentBoundary: observeBoundary(undefined),
    applyCtxBoundary: observeBoundary(ctx),
    structGap: '授权锚须由宿主在结构边界提供（setPrincipalScope：启动 scope / 任务配置）。窗口面文本是观察面，不作锚源（噪音）⇒ 入口未接时锚池留空、不可逆动作交人工。⚠️ 分层说明（2026-10-26 修正）："不采信窗口文本"是设计（正确，位置判据优于角色判据）；"入口至今无人调用"是**集成缺口**，不是设计定论——宿主接上 setPrincipalScope 后此格才实义。原文写作"设计而非漏读"会被下一个维护者读成"这是有意的永久状态，不必去接线"。',
    // [2026-09-20 · 位置量观测] 宿主在门这一侧**自带**的结构位置：`agent`（谁在调）/ `parent`（从哪派生）。
    //   纯观测、**不参与裁决**（授权仍只认委托人声明的范围）；用途＝实机一跑即知该宿主是否给位置量，
    //   以及**派生调用有没有被计数**（＝"门覆盖全路径"的可观测证据，非推测）。
    callSites: { total: 0, withAgent: 0, withParent: 0 },
    // [2026-09-21 · 回执门观测] 第三个真能拦的门位置在回执侧。这里只**如实记数**，供实机跑一次即知
    //   门有没有被派发、失败回执有没有到达、阻断有没有真的发生 —— 不猜宿主行为。
    receiptGate: {
      seen: 0,            // 经过回执门的调用数（含成功，证明门被派发）
      failedSeen: 0,      // 其中带失败信号的（门只对这些施加裁决）
      blocked: 0,         // 实际阻断数（回执被改写成纠错错误）
      failOpen: true,     // 监听器抛错 ⇒ accept：门不得把健康运行弄坏
      cap: engine.maxFailureStreak,
      lastAt: null,
      lastReason: null,
      lastStreak: null,
    },
  };

  // ---------- R / D / S / H / M 总裁决：工具调用前置闸门（waterfall） ----------
  ctx.on('tools/pre-execute', async (exec, next) => {
    channel.callSites.total += 1;
    if (exec?.agent !== undefined) channel.callSites.withAgent += 1;
    if (exec?.parent !== undefined) channel.callSites.withParent += 1;
    const a = exec?.arguments ?? {};
    const call = {
      name: exec?.name,
      args: a,
      command: a.command,
      code: a.code,
      // [2026-09-20 · 锚源定案 · 同构回填] 授权锚＝宿主在**结构边界**声明的任务范围（`setPrincipalScope`）。
      //   来源**不是**消息文本（窗口面是观察面 ⇒ 噪音），也**不是** exec 视图里猜的字段名。
      //   入口未接 ⇒ null ⇒ 锚池留空 ⇒ 不可逆动作交人工（fail-closed）；**绝不臆造授权**（假人证比无人证更坏）。
      taskAnchor: _hostPrincipalScope,
      // 通行证（结构凭证）：与 taskAnchor 并列的**第二条授权面**，但它是结构化的 ——
      //   作用域直接声明、不从文本抽（`declaredAnchors` 抽不出相对前缀，见 setPrincipalCapability 注释）。
      //   引擎侧三态：证未列该动作类 ⇒ 不介入（行为零回归）；覆盖 ⇒ 放行并记次；越界/过期/用尽 ⇒ review。
      //   ⚠️ 递下去的是**原文**（raw），不是解析产物：同一来源只有一种形态（原文），
      //      引擎侧解析一次即可。首版递解析产物 ⇒ 引擎二次解析时 scope 的条目对象被当字符串
      //      ⇒ 一份合法的证被判"作用域为空"（一桶两义的复发，已修，判据见 capability.parseCapability 首部）。
      taskCapability: _hostCapRaw,
      // 将第一BUG结构性标志提到顶层，供 engine.checkFirstBug 读取
      // （DSH 在 exec.arguments 上传这些标志；引擎在 call 上读取）
      selfReference: a.selfReference,
      paradox: a.paradox,
      deadlock: a.deadlock,
      contradiction: a.contradiction,
      paramTypeError: a.paramTypeError,
    };
    // ⑥ 窗口警察：证据不足（物证缺失）的调用直接发回补充，不进引擎实质裁决。
    const gate = policeGate(call);
    if (gate) {
      markBlocked(exec);   // 本层拦下 ⇒ 该 callId 后续若回 error，是本层造成的，不得计入失败
      logline(`pre-execute ${exec?.name} -> police gate (证据不足·发回补充)`);
      return gate;
    }
    const decision = engine.decideToolCall(call);
    logline(`pre-execute ${exec?.name} -> ${decision.kind}${decision.law ? '(' + decision.law + ')' : ''}`);
    if (decision.kind === 'deny' || decision.kind === 'review') {
      markBlocked(exec);   // 同上：拦住 ≠ 失败
      // 阻断该步、不扩散（D 破窗止损 / M 以断保续 / 推演中高风险兜底）
      // review（中风险）在无人工确认环境保守拦截；reason 已标注"建议二次确认"
      // 透传引擎闭环字段与推演风险等级，供调用方读取
      //
      // 对外语义固定为 deny：宿主契约只认 deny / next()，返回 'review' 有被当未知类型放行的风险。
      // 「宁可先拦截，不可直接放」⇒ 用宿主听得懂的话说"拦住"，用附加字段说"这是挂起不是终局"。
      const isReview = decision.kind === 'review';
      // ═══ 白箱贯彻：事实位默认放行（2026-09-24 · 结构修法，不按名挑选）═══
      // 修前此处是「按名挑选」：只列 bugKey/closedLoop/missing/stage/risk 五个名 ⇒ 引擎产出的**其余事实位全部被静默丢弃**。
      // 实测取证（probe-whitebox-egress.mjs `before`，24 条真 API 输入 / **18 条裁决**，同刻同对象法）：
      //   conduction 丢 18/18 · innerH 丢 18/18 · mMark 丢 17/18 · attrib 丢 15 · deduced 丢 10 · scarUnanchored 丢 9
      //   · fractalSubM 丢 6 · systemKey/actionText/equivalence/mCrossCheck 各 1 —— **合计 11 类**。
      //   `innerH` 被丢尤其直接违反引擎侧内 H 协议④：「外 H 推演结果与内 H parked 状态**同时交付**」。
      // 为何改结构而非补名字：字段随引擎演化 ⇒ **枚举永远追不上**（X 轴）；放行必须按「位」（Y 轴），一次覆盖现在与将来的全部事实位。
      // 宿主契约读自源码（dsh-tools/lib/index.js:3002 只读 kind/reason；lib/types/index.d.ts:408 类型仅 {kind,reason}）
      //   ⇒ 附加字段被忽略、不做严格校验 ⇒ 对宿主无害；对下游插件与审计面即为白箱。
      // 排除表按**性质**定义（仅「内部实现位」：引擎实例引用／可变内部状态／内 H 推演过程），不按名黑名单；
      //   实测：18 条裁决的引擎产出**全部可 JSON 序列化、无循环、无函数**（样例 2456 B）⇒ 当前无一项落入排除。
      const INTERNAL_ONLY = [];   // 仅内部实现位；事实位一律放行
      const out = { ...decision, kind: 'deny', law: decision.law, reason: `[唯稳律·${decision.law}] ${decision.reason}` };
      // 版本指纹进回执（小D 请求④）：让**审计方**能判断「这份读数出自哪份判据代码」，
      //   不必依赖被测方自报包版本。与 law/reason 同级，属事实位，不是判据位 —— 不参与任何判决。
      out.buildId = BUILD_ID;
      out.loadedAt = LOADED_AT;
      for (const k of INTERNAL_ONLY) delete out[k];
      if (isReview) {
        // ③ 搁置 + 标注留证：引擎某些 review 出口未挂 bugKey，此处补稳定 BUG 身份供追溯。
        //    不走 _markIntercept：避免污染 M 档 mBugForce 计数（会改变达封顶升级行为）。
        if (out.bugKey === undefined) out.bugKey = bugKeyOf(call);
        // ④⑤ 推演后果一并交还人类。
        // 2026-09-13：推演分支现由引擎裁决出口直接回显（decision.projection），此处优先读取，
        // 不再重复调用 deduceRisk 二次推演（补算降级为兜底：R/D/H/M 等早退路径本就没跑推演）。
        const branches = decision.projection ?? deduceBranches(engine, call);
        if (branches) out.branches = branches;
        // ⑥ 待裁决语义显式化（裁决回传通道本身未开，此处仅让调用方可区分"挂起"与"终局拒绝"）
        out.humanDecision = decision.humanDecision !== false;
        out.awaitingHuman = true;
        const summary = branchesSummary(branches);
        if (summary) out.reason = `${out.reason}\n${summary}`;
      }
      // ═══ 白箱贯彻：接口所见＝日志所记（同一对象，不分叉）═══
      // 日志是 append-only 审计面（src/runtime.log，.gitignore 排除、不入库）。若此处另写一份"摘要"，
      //   两份一旦漂移，白箱即退化为"看起来白箱" ⇒ 故记的就是**返回的那个对象本身**。
      logline(`pre-execute ${exec?.name} -> ${decision.kind}${isReview ? '(awaitingHuman, bugKey=' + out.bugKey + ')' : ''} | whitebox ${JSON.stringify(out)}`);
      return out;
    }
    // allow：同样留白箱记录 —— 否则"没被拦"成了**无痕事件**（与引擎侧"每次传导必留刻痕"同构）。
    logline(`pre-execute ${exec?.name} -> whitebox ${JSON.stringify(decision)}`);
    return next();
  });

  // ---------- H 内 H 不可侵：步骤前置闸门（waterfall，消息级） ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    // [2026-09-20 · 窗口面＝观察面 · 同构回填] 只**观测**，不取锚：形状 / role 词表 / 线索如实记录，
    //   授权一律不从此处产生（否则＝把 Y 轴的量寄存在 X 轴的容器里；两种失效模式见文件顶部实测）。
    const rd = readMessageStream(payload);
    channel.steps += 1;
    channel.shape = rd.shape;
    channel.rolesSeen = rd.rolesSeen;
    channel.messagesSeen = rd.count;
    channel.assistantSeen = rd.assistantSeen;
    channel.clueSeen = rd.principalClue !== null;
    if (rd.principalClue) channel.lastClue = rd.principalClue.slice(0, 200);
    channel.authoritySeen = _hostPrincipalScope !== null;
    channel.authorityChanges = [..._scopeChanges];   // 留痕刷新（撤回可溯）
    channel.agentBoundary = observeBoundary(payload?.agent);
    channel.lastObservedAt = new Date().toISOString();
    logline(`pre-step observed (shape=${rd.shape}, roles=[${rd.rolesSeen.join(',')}], clue=${rd.principalClue ? 'yes' : 'no'}, authority=${channel.authoritySeen ? 'structural-entry' : 'NONE'}) — 窗口面不授权，锚池不由此填充，不猜`);
    const decision = engine.decidePreStep(payload?.messages);
    // reject（明确越界）与 review（定义不明/判不出来）同作阻断、不扩散。
    // review 即"搁置返回用户决策"：宁可先拦截，待用户裁决后再执行，不可直接放。
    if (decision.kind === 'reject' || decision.kind === 'review') {
      if (decision.kind === 'review') {
        // PreStepDecision 契约仅 {kind:'reject'}、不携带 reason/branches，
        // 故富信息（定义不明缘由 + 留证身份 + 推演后果）记入 runtime.log 供审计，
        // 宿主侧以 reject 阻断该步、交还用户裁决。
        const call = { name: 'pre-step', args: { messages: payload?.messages } };
        const bug = bugKeyOf(call);
        const branches = deduceBranches(engine, call);
        logline(`pre-step review(定义不明) -> 搁置返回用户决策 bugKey=${bug}` + (branches ? ` branches=${JSON.stringify(branches)}` : ''));
      } else {
        logline(`pre-step -> reject(${decision.law})`);
      }
      // ═══ 白箱贯彻：与 tools/pre-execute 同构 ═══
      // 宿主契约（PreStepDecision）只认 {kind:'reject'} ⇒ 富信息**无法随返回值出去**，日志即此处唯一白箱面。
      // 修前此处只挑了 bugKey / branches 几个名字写日志 —— 同一个"按名挑选"的毛病：
      //   引擎决定对象本身（law/reason）与**本次链落点**（engine.conduction）都没进审计面。
      // 改为如实载入**引擎决定对象本身** + 适配层补项（同一"按位、不按名"原则）。
      logline(`pre-step -> whitebox ${JSON.stringify({ ...decision, bugKey: bugKeyOf({ name: 'pre-step', args: { messages: payload?.messages } }), conduction: engine.conduction ?? [] })}`);
      return { kind: 'reject' };
    }
    return next();
  });

  // ---------- D 破窗止损在回执侧的落点：工具回执闸门（waterfall） ----------
  // 位置：动作已落地、回执进模型之前 —— 全管线最后一个裁决点。契约读自 dsh-tools 源码（2026-09-21），非推测：
  //   · 覆盖：`ToolRegistry.postExecute` 对**每个**未成终局的 execution 派发，且原话明写
  //     "Tool and unknown-tool failures still receive post-execute" ⇒ 失败/未知工具的调用同样受裁。
  //   · 裁决真被消费：`{kind:'block', feedback}` 会让宿主把该调用以 `isError` 返回，`content` 换成
  //     `feedback`（同文件 postExecute）—— 不是装饰。
  //   · 监听器抛错会让整个调用变 error ⇒ 本实现永不向宿主抛：所有路径降级为 `accept`（fail-open）。
  //     能把健康运行弄坏的门，比没有门更坏。
  // 为何必须在**回执**裁决（结构理由，不是补一个"忘了挂"的位置）：
  //   破窗一旦成立，后续调用在 pre-execute 就被拒、**根本走不到回执** ⇒ 回执侧只有"把偏离累积推达
  //   阈值的那一次失败"有机会说话，此后结构上沉默（窗口已关）。
  //   ⇒ 故这不是"再拦一次"，而是**断点的落点**：故障回执就地被断成纠错回执（M 落在回执上），
  //     而不只是拦住**下一次**调用。
  // fail-open 边界（写在前面）：裁决**只施加于已经失败的回执**。成功结果一律原样透传
  //   （不替换 content、不改 value）—— 误判永远不会把一个健康结果变成错误。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    let decision = null;
    try {
      channel.receiptGate.seen += 1;
      if (isFailedReceipt(result)) {
        channel.receiptGate.failedSeen += 1;
        const bw = engine.breakAtReceipt();
        if (bw) {
          const call = {
            name: exec?.name,
            args: exec?.arguments ?? {},
            command: exec?.arguments?.command,
            code: exec?.arguments?.code,
          };
          const bugKey = bugKeyOf(call);
          decision = {
            kind: 'block',
            law: 'D',
            reason: `[唯稳律·D] ${bw.reason}`,
            bugKey,
            closedLoop: true,
            // 宿主会用 feedback 替换回执 content ⇒ 原文必须一并带过去：阻断不得毁掉它所依据的证据。
            feedback: [
              { type: 'text', text: haltFeedback(bw, bugKey) },
              { type: 'text', text: `--- 回执原文（保留，未被丢弃） ---\n${receiptTextOf(result)}` },
            ],
          };
          // 日志只在阻断确实交付后才写：若构造 feedback 时抛错，下面 catch 会降级为 accept，
          // 先写日志就会留下"拦了其实没拦"的假痕。
          channel.receiptGate.blocked += 1;
          channel.receiptGate.lastAt = new Date().toISOString();
          channel.receiptGate.lastReason = bw.reason;
          channel.receiptGate.lastStreak = `${bw.streak}/${bw.cap}`;
          logline(`post-execute ${exec?.name} -> block（D 破窗止损落在回执，${bw.streak}/${bw.cap}，bugKey=${bugKey}）`);
        }
      }
    } catch (e) {
      decision = null;   // fail-open
      logline(`post-execute gate failed open: ${e?.message ?? e}`);
    }
    // ═══ 白箱贯彻：与前两处同构（记的就是返回的那个对象，不分叉）═══
    // 回执侧终局（D 破窗止损落点）此前只留了一行摘要（streak/bugKey）⇒ 交还给宿主的 feedback 原文
    //   （＝阻断所依据的证据）没有进审计面。改为整条记录入账，留痕与交付同源。
    if (decision) logline(`post-execute ${exec?.name} -> whitebox ${JSON.stringify(decision)}`);
    return decision ?? (typeof next === 'function' ? next() : { kind: 'accept' });
  });

  // ---------- 白箱审计：结果钩子（仅观察，不改写） ----------
  // 宿主契约（dsh-tools/lib/types/index.d.ts）：`'tools/result'(exec, result)` —— **第一个参数是 exec**，
  //   冻结后的 result 在**第二个**。从第一个参数上读 `error` 会让失败入账变成静默空转，真机实测已证
  //   （2026-09-21）：入账从未发生 ⇒ 上面那道回执门永远投影到 failureStreak = 0 ⇒ 在真机上是哑的。
  // 位置即契约：不为旧错法留兼容垫片（否则"位置错也认"，就把结构判据换成了内容判据）。
  ctx.on('tools/result', (exec, result) => {
    if (result?.error) {
      // 🔴 [2026-10-26] 先判这条 error 是**谁造成的**，再决定记不记账。
      //   `result.error` 同时承载「执行失败」与「被本层拦下」两种相反含义，内容分不出 ⇒ 靠 callId 分。
      const id = exec?.callId;
      if (id && _blockedCallIds.has(id)) {
        _blockedCallIds.delete(id);
        logline(`result audit: error 由本层拦截产生（callId=${id}）⇒ 拦截成功，不计入破窗（streak=${engine.failureStreak}/${engine.maxFailureStreak}）`);
        return;
      }
      engine.onFailure();
      logline(`result audit: failure accrued（streak=${engine.failureStreak}/${engine.maxFailureStreak}）`);
    }
  });

  // ---------- 白箱自查工具（模型可查，验证框架运行） ----------
  const renderObj = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

  ctx.tools.register(defineTool({
    name: 'query_steady_state',
    description: '查询当前系统稳态储备 S（双属性：历史刻痕不可逆 + 当前值可升降，木桶取最短板）。' +
      '返回有效 S、活动态账本（只含各同类事件最新版本，旧版本静默待机）、静默待机与创伤计数、破窗计数。' +
      'S 时间周期模型（作者 2026-08-19）：同类事件聚合、只调用最新版本，防上下文过载。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      // 白箱自查默认只暴露聚合视图，不 dump 全量 historyTrail（防上下文过载）
      return {
        effectiveS: engine.effectiveS(),
        ledger: engine.steadyLedger(),
        ledgerSize: engine.sLedger.size,
        standbySize: engine.sStandby.length,
        traumaCount: engine.traumaCount,
        failureStreak: engine.failureStreak,
        note: 'ledger=活动态（最新版本）；standby=静默待机（旧版本，append-only 保留不调用）。全量 historyTrail 仅供深度审计。',
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'list_rigid_anchors',
    description: '列出 RSDHM 中 R 刚性锚点的当前生效定义，供模型校准方向、自查是否越界。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        R_DOMAIN, // R 域刚性锚点的本体定义（嵌套客观规则层级，不可变）
        rigidAnchors: engine.rigidAnchors.map((a) => ({ id: a.id, desc: a.desc })),
        note: 'rigidAnchors 为已识别的具象越界模式示例（作者可按 R 层级补充）；R 本体定义见 R_DOMAIN，不可变。',
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'query_conduction_chain',
    description: '返回传导链顺序 R→S→D→H→M 与框架要义，并回显**最近一次裁决的实际链落点**（每节读数与判词），供模型理解闭环结构并自查本次判定依据。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        chain: ['R 刚性锚点', 'S 稳态储备', 'D 破窗止损', 'H 内H不可侵', 'M 第一Bug停机'],
        essence: '因果律运行结构的白箱呈现：保活（不抛弃任何节点）与精准（结构自带锚点）同构。',
        // [2026-09-24 · 白箱贯彻] 修前本工具**返回常量**：无论发生过什么，读到的都是同一段文字
        //   ⇒ 一个"看起来白箱"的查询面，实际是黑箱（外部无法据此复核任何一次裁决）。
        //   而引擎侧本次裁决的链落点在 `engine.conduction` **一直是在场的**（decideToolCall 每次重建，
        //   R→S→D→H→M 各节含 sBefore/sAfter/delta/verdict 等读数）⇒ 如实回显，不加工。
        //   不新增判据、不改裁决、不挑选字段（同上：按位如实，不按名摘要）。
        lastConduction: engine.conduction ?? [],
        lastConductionNote: '最近一次 decideToolCall 的链落点（逐节读数）。空数组＝本次会话尚未发生裁决。',
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'query_boundary',
    description: '查询内 H 边界：本插件不侵入主体性黑箱（不读、不写）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return { innerH: 'inviolable', read: false, write: false, note: '白箱不侵黑箱：思想/自由意志为主体性黑箱，不可被读或写。' };
    },
  }));

  // 三大铁律（白箱自查：模型可查框架不可变约束）
  ctx.tools.register(defineTool({
    name: 'query_iron_laws',
    description: '返回唯稳律三大铁律的定稿文本（不可变）：内 H 不可侵 / 第一 Bug 停机 / 不抛弃任何节点。供模型校准方向、自查边界。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return { ironLaws: THREE_IRON_LAWS };
    },
  }));

  // 第一BUG停止闭环状态机白箱自查
  ctx.tools.register(defineTool({
    name: 'query_bugstop',
    description: '查询第一BUG停止闭环状态机：当前有哪些故障环节已停但未修复（halted 但未 resolved），各自缺失步骤（逻辑反推/溯源标记/解决修复）。用于白箱观测闭环是否闭合，避免"只反推不修复→无限递归"。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        stops: engine.bugStop.snapshot(),
        note: 'halted 且 resolved=false 的环节禁止重入；须 反推→溯源→修复(验证) 方可重入。',
      };
    },
  }));

  // [2026-09-20 · 锚源自报 · 2026-09-24 同构回填] 把"猜宿主字段名 / 猜哪条消息算授权"换成"看事实"：实机跑一次即可观测
  //   ① 宿主是否真把消息流交给插件（shape / roles 词表 / 线索）；② 结构入口是否接通；③ 锚池里有什么；
  //   ④ 宿主的结构对象（payload.agent / apply ctx）上有哪些键 —— 这是**接真入口**所需的事实，不猜字段名。
  ctx.tools.register(defineTool({
    name: 'query_anchor_channel',
    description: '锚源白箱自报：结构入口（宿主声明的任务范围）是否接通、锚池里有什么、宿主实际传了什么（消息形状、role 词表、结构对象键集）。窗口面是观察面、**设计上永不授权**；池空即不可逆动作交人工（fail-closed）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        adapter: channel,
        engine: engine.anchorChannel,
        note: '授权锚唯一来源＝结构入口 setPrincipalScope（宿主在启动/step 边界声明任务范围）；被审计 agent 的自述与窗口面文本**都不授权**（否则＝自我授权 / 假人证）。入口未接 ⇒ 锚池留空 ⇒ 不可逆动作交人工，此为设计而非漏读。',
      };
    },
  }));

  // [2026-10-20] 判据接线自查（元认知的第一个可观测面）
  //   来由：law.mjs 导出 27 条判据，实测仅 5 条真进计算；其中 10 条自带「非引擎运行期判据位」声明
  //   ⇒ 零引用与真缺口混作一堆，无法区分。本条把「各走哪条路」变成可查询读数。
  //   ⚠️ 只读：不产生 verdict、不写状态、不进闸门 —— 元认知只能读不能管。
  ctx.tools.register(defineTool({
    name: 'query_criterion_wiring',
    description: '判据接线自查（只读）：库内判据按「判决位／读数位／声明位／未定」四档登记，返回各档成员、已登记的缺口（该接却没接）、以及因果链三时相（过去·现在·未来）各接没接。用于自查"我知道的规则里有几条真的进了计算"，不改变任何放行/拦截判决。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        buildId: BUILD_ID,
        loadedAt: LOADED_AT,
        ...criterionReadout(engine),
        note: '只读面：不产生 verdict、不写状态、不参与闸门。gaps 是如实登记的缺口（不是免责通道）；unmapped 是欠账，不视为通过。buildId 由 src/core/*.mjs 内容哈希派生（不含版本号）⇒ 外部审计方据此判断读数出自哪份判据代码，不必依赖被测方自报包版本。',
      };
    },
  }));
  // ── 通行证状态（只读面）────────────────────────────────────────────
  //   为何必须有个自省面：凭证的判据是「三件事」（动作类 / 作用域 / 次数与到期），
  //   而这三件都在宿主侧设定。被测方若看不见自己的证长什么样，就只能靠猜措辞——正是
  //   `setPrincipalScope` 那一代的老毛病。⇒ 把证**原样摊开**：签了什么、用了几次、何时到期。
  //   ⚠️ 只读：不产生 verdict、不写状态、不参与闸门（与 query_criterion_wiring 同档）。
  ctx.tools.register(defineTool({
    name: 'query_capability',
    description: '通行证状态（只读）：返回宿主当前签发的凭证（动作类 / 作用域 / 次数与到期 / 已用次数 / 最近使用留痕），以及签发-替换-撤回的变更史。用于自查"我这张证到底覆盖什么"，不改变任何放行/拦截判决。证只能由宿主签发（模块级 setPrincipalCapability 或进程环境变量 WEIWEN_CAPABILITY），模型无法自签。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        buildId: BUILD_ID,
        loadedAt: LOADED_AT,
        ...capabilityStatus(_hostCapability, _hostCapRaw, _hostCapError),
        changes: _capChanges.slice(-10),
        issuePaths: [
          'setPrincipalCapability(cap) —— 宿主模块级导出（模型不可达）',
          'WEIWEN_CAPABILITY=<json> —— 进程环境变量（启动进程者设定）',
        ],
        note: '只读面：不产生 verdict、不写状态、不参与闸门。未签发时引擎行为与本判据出现前完全一致；签发后：刚性锚 deny 不变、出界必 review，只有"域内且无锚可归"的动作会由 review 变 allow（那是补上可验证的归属，不是放宽）。',
      };
    },
  }));
  // ── 五层推演读数（R→S→D→H→M，逐层给「可代入量」）──────────────────
  //   来由（安 2026-10-20）：公式若只是形容词，就一次也用不上。
  //   ⇒ 每层先算一个量，结论＝量之间的关系；算不出的量显式落「待取证／未实现」并带线索。
  //   ⚠️ 只读：不产生 verdict、不写状态、不进闸门。
  ctx.tools.register(defineTool({
    name: 'query_strata',
    description: '五层推演读数（只读）：按 R→S→D→H→M 逐层返回「可代入的量」及其值，每层附公式与「在哪停」。三态显式：ok（现在能算）／pending（缺常数或取证，带 TBD 线索）／absent（实现层没有这个量）。另返回跨层代入禁令（如 ΣS 与 S_now 聚合方向相反、不可互代）。R 层另给域容量面：p_max（已取证的标准值）／N_opp（分母，engine 现缺）／R₀（=p×N）／rCapRoute（该域该走哪条公式），并附域表体检 rcap（把「条目非法 malformed」与「标准合法不给数 no_num_legal」分开计数）。不改变任何放行/拦截判决。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute() {
      return {
        ...strataReadout(engine),
        note: '只读面：不产生 verdict、不写状态、不参与闸门。pending/absent 是如实登记，不是免责通道；pending 必带 evidence 线索，absent 必带缺口说明。',
      };
    },
  }));

  // ── 四层嵌套（R/S/D/H 各自的宏观／微观）＋ M 公式方向 ─────────────
  //   来由（安 2026-10-20 11:28）：每个变量内部都有嵌套结构，宏观与微观。
  //   ⚠️ 只读：M 只给方向，绝不给数值（CORE_FORMULA 明令不赋值）。
  ctx.tools.register(defineTool({
    name: 'query_nested',
    description: '四层嵌套读数（只读）：返回 R/S/D/H 各自的宏观形态与微观形态、服从关系（binds）、展开终止判据，以及医疗域实例；并给出 M=(R×S)/(D×H) 的**方向**判定（up/down/indeterminate，绝不输出数值——公式原文明令不赋值不计算）。可传入各层变化 delta（-1/0/+1）计算方向。另返回公式约束 `0 < H/(S↔D) < R` 的形态判定：`↔` **不是算子**，它标记 H 内部那条滑轨（S 端↔D 端），H 是轨上滑块 ⇒ 只判滑块位置形态（on_rail/off_low/off_high/unknown），恒不给数值。传 hPosition 可判形态。不产生 verdict、不进闸门。',
    parameters: {
      delta: { type: 'object', additionalProperties: true, description: '各层变化：{R,S,D,H}，每项 -1（降）/0（不变）/+1（升）。省略则只返回静态结构与体检。' },
      macroDelta: { type: 'object', additionalProperties: true, description: '双层模式的宏观层变化（可选）；与 microDelta 同时给出时走双层服从判定。' },
      microDelta: { type: 'object', additionalProperties: true, description: '双层模式的微观层变化（可选）。' },
      hPosition: { type: 'string', description: 'H 在 S↔D 滑轨上的位置形态：inside（严格在轨内）/ at_s（贴死 S 端，能动性归零）/ at_d（贴到 D 端，达 R 标度）/ beyond（越过 R，脱域）。省略则不判（unknown，≠ 成立）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute(args = {}) {
      const out = { vars: NESTED_VARS, audit: nestAudit(), constraint: M_CONSTRAINT };
      if (args.macroDelta || args.microDelta) {
        out.twoLayer = mTwoLayer(args.macroDelta || {}, args.microDelta || {});
      } else if (args.delta) {
        out.direction = mDirection(args.delta);
      }
      if (args.hPosition !== undefined) {
        out.constraintShape = mConstraintShape({ pos: args.hPosition });
      }
      out.note = '只读面：M 只输出方向，不输出数值（CORE_FORMULA: 定性方向关系，不赋值）。indeterminate 是定性关系的上限，不是缺口。⚠️ `↔` 不是算子（不存在「待实现的算子」）；它标记 H 内部那条滑轨。**区间长度（张力 L）可求**，见 query_tension；不可求的是把 `↔` 当运算符。';
      return out;
    },
  }));

  // ── 张力 L（S↔D 之间的跨距）＋ R/H 的动作形态 ───────────────────
  //   来由（安 2026-10-20 12:0x）：R 改成「让执行者直接全网查」，是可执行动作而非赋值；
  //     H 定为观察者视角，在 S/D 制衡中选取；「SD 中间这个张力如何计算」⇒ 三档路由。
  //   ⚠️ 只读：张力的「大小」只在档 A（有容差）存在；档 B 只出缺口清单，不带数值。
  ctx.tools.register(defineTool({
    name: 'query_tension',
    description: 'S↔D 张力读数（只读）：算「标准要求」与「实际事项」之间的跨距 L。三档按域实际给了什么路由——档A（有容差）：L=|偏差|/容差，无量纲，单位是「几个容差」；档B（只有条款/动作）：输出**缺口清单**（要求的动作 − 允许的动作），集合差没有大小、永不带数值；档C（都拿不到）：不判（≠ 相容）。另返回 H 在张力上的位置形态（on_rail/off_low/off_high/zero_tension/unknown），其中 **zero_tension 是结构事实**：S 与 D 完全相容 ⇒ 跨距为零 ⇒ 杠杆没有跨度 ⇒ H 无处着力。另返回 R 的三层区分（本体无上限／域读数是投影／刻度 R=100 只便于计算）与后果级别对应的余量共识区间，以及条款的**形状**校验（只查槽位，不解析自然语言）。另返回 H 的裁量权归属（由第一视角自定、无上级授权者）与**升级判据**（判不出 ∧ 须追到责任人 ∧ 与责任人有关 ⇒ 返回人类做最终裁决；缺一条就停在 H，不交还），以及证据等级口径（二手不阻塞判决，待办 ≠ 欠账）。另判**本层尺子的来源**：传 citableToPublic 区分「公开标准原版（origin，可对外举证）」与「上一层转述（relay，只对本层生效、不得冒充原版）」——**R 不直达**：层内客观、跨层是投影，拿原版去交本层的差＝交错了尺子。另给**损耗归属**：转述/传递的损耗只能由 H 支付（R/S/D 无「承担后果」属性 ⇒ 无支付能力），传 relayLayers 可判方向——层数↑⇒总 H↑⇒M↓，减层就等于直接抬 M；损耗的根源是「接收方须重建语境」而非「信息丢失」。另给 **H 的通行许可**：传 runwayCovered 判这一处该不该「放开了跑，别怕，充分发挥自身优势」——跑道铺到处撤掉过度谨慎（那只是缺口利息）⇒ 损耗 H 退、总 H↓、M↑；没铺到则先沿已知边界跑。粒度按跑道覆盖、不按行业名；撤的是过度谨慎，**不是后果归属**。不产生 verdict、不进闸门。',
    parameters: {
      tol: { type: 'number', description: '档A：标准容差（与 dev 同单位）。例：医疗输液泵流量 ±5 ⇒ tol=5。' },
      dev: { type: 'number', description: '档A：实际偏差（与 tol 同单位）。可负，张力取绝对值。' },
      required: { type: 'array', items: { type: 'string' }, description: '档B：S 要求的动作集（标准条款要求做什么）。' },
      allowed: { type: 'array', items: { type: 'string' }, description: '档B：D 允许的动作集（这次事项实际能做到什么）。' },
      notchH: { type: 'number', description: 'H 选定档位对应的**绝对余量**（单位同 L：几个容差）。省略则不判位置。' },
      rCap: { type: 'number', description: 'H 的**刻度读数**（百分制 ⇒ 80 表示 80%）。⚠️ 这是读数，不是上限：R 本体无上限，故不存在「rCap<1」这类要求。可由 criticality+notch 自动算出。' },
      scale: { type: 'number', description: '刻度（默认 100＝百分制，即旧论文的 R=100）。换刻度只改读数、不得改判决。' },
      criticality: { type: 'string', description: '后果级别（余量共识表的 key）：metrology_high_risk / aero_medical_derating / mil_industrial_derating / commercial_derating。给出则自动查余量区间并算 rCap。' },
      notch: { type: 'string', description: 'H 选档：toward_s（更守标准，取余量大端）/ balanced（取区间中点）/ toward_d（更顺扰动，取小端）。' },
      clauses: { type: 'array', items: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] }, description: '条款清单：只校验**形状**（action+object+value/unit成对+source+version），不解析自然语言。裸字符串会被判 unstructured。⚠️ 元素类型**刻意收窄到 object|string 两态**、不在 schema 层只许 object：形状校验是本工具的业务判据（判得出 structured / unstructured 两态），只许 object 则"裸字符串 ⇒ unstructured"这条读数永远走不到 ⇒ 校验被协议层代判，模型也看不到自己哪条不合格。' },
      undecidable: { type: 'boolean', description: '升级第①条：这件事 H 判不出来吗？省略则不判升级（unknown ≠ 不必升级）。' },
      mustTraceOwner: { type: 'boolean', description: '升级第②条：是否必须追到责任人？纯技术不可判、无需追责 ⇒ 停在 H。' },
      relatesToOwner: { type: 'boolean', description: '升级第③条：是否与某个责任人有关？三条合取才返回人类。' },
      citableToPublic: { type: 'boolean', description: '本层尺子的来源：这条要求能否指到「标准号+条款号+版本」的公开原文？true ⇒ origin（可对外举证）；false ⇒ relay（上一层转述，只对本层生效、不得冒充原版）。省略 ⇒ 不判来源（≠ origin）。⚠️ 判据不看行业名话术，只看"指不指得到"：公司→部门→管理者→你的链上，你拿到的是 relay，拿 origin 交差＝交错了尺子。' },
      wants: {
        type: 'string',
        description: '你这次问 H 的哪一面（受控取值：who＝谁/资格/落款｜what_can＝能什么/档位/许可｜what_cost＝付多少/损耗｜visible＝外面能不能看到/缝）。🔴 H 是统称不是标量：不给 wants ⇒ 面向未定 ⇒ 返回 question_incomplete（可补，**不是判不出、也不是放行**）。给了 ⇒ 返回该面的判据。',
      },
      selfReadsAs: {
        type: 'string',
        description: '你打算拿哪一面的读数来答复 wants 那一面（同受控取值）。💰 两面不同 ⇒ crossFacet=true ＝ 跨面误推（造价），例：拿"产出风格一致"（visible）去答"他的动机"（who）。不给 ⇒ 不判跨面（≠ 不是跨面误推）。',
      },
      relayLayers: { type: 'number', description: '我这条链上有几层转述（0＝直接对接原始语境，1＝直属管理者，2＝部门+管理者…）。给出则返回损耗支付的**方向**：损耗只能由 H 支付（R/S/D 无"承担后果"属性 ⇒ 无支付能力），层数↑⇒总 H↑⇒M↓。**只给方向，不给 H 的数值**。省略 ⇒ 不判（≠ 无损）。' },
      runwayCovered: { type: 'boolean', description: '这一处的**判据跑道铺到了吗**（不是"这个行业有没有标准"，是"这一处判据在不在"）。true ⇒ 发给执行者「放开了跑，别怕，充分发挥自身优势」：撤掉过度谨慎（那只是缺口利息），损耗 H 退出 ⇒ 总 H↓ ⇒ M↑；有效 H 不减。false ⇒ 先沿已知边界跑，不得卸谨慎（强卸测到的是缺口不是跑道）。⚠️ 粒度＝跑道覆盖范围，不按行业名。省略 ⇒ 不判许可（≠ 可以放开跑）。' },
      inFormula: { type: 'boolean', description: '这个量**能不能进公式**（＝换个人照它走，能否落到同一份可复查的原件/记录）。true ⇒ 进，且它必是外 H（留痕强度再按 hard/soft 判）。false ⇒ 不在输入集 ⇒ 状态是 not_in_input_set（**不是欠账、不挂账**），并提示先问「能不能外化」。⚠️ 与 not_collected（在输入集但没采，是欠账）是两种不同的"没有"，必须分开。省略 ⇒ 不判（≠ 在内，也≠ 不在）。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderObj },
    async execute(args = {}) {
      const out = {
        action: { R: R_ACTION, H: H_OBSERVER },
        audit: verbAudit(),
      };
      const t = tensionOf(args);
      out.tension = t;

      // R 的三层区分：本体无上限 / 读数是域的投影 / 刻度只是换算
      out.R = { ontology: R_ONTOLOGY, scale: R_SCALE };

      // 🔴 R 不直达：本层拿到的尺子是 origin 还是 relay（层内客观 ≠ 跨层直达）
      out.relay = R_RELAY;
      if (args.citableToPublic !== undefined) {
        out.rSource = rSourceGrade({ citableToPublic: args.citableToPublic });
      }

      // 🔴 损耗只能由 H 支付：转述层数 ↑ ⇒ 总 H ↑ ⇒ M ↓（只判方向，不给数值）
      out.loss = LOSS_BEARER;
      // 张力输出的合法形状（档B 只允许缺口清单/不判；给比值即形状非法）
      out.tensionOutput = TENSION_OUTPUT;

      // 🔴 H 是统称（安 2026-10-20 20:3x）：先说清它有几个面，再看你问哪一面。
      out.hUmbrella = H_UMBRELLA;
      out.hFacets = H_FACETS;
      // 内 H/外 H 之间那道缝（此前无落点）
      out.seam = INNER_OUTER_SEAM;
      // 🔴 公式准入律（安 2026-10-20 20:45）：能进公式的 H，全部是外 H
      out.formulaInput = FORMULA_INPUT;
      // 输入集自检：没给 ⇒ 不判（不默认"在内"）；false ⇒ 不进公式、不挂账
      if (args.inFormula === true) {
        out.formulaInputNow = {
          inFormula: true,
          tier: '一级：留痕 ⇒ 进（权重按 PROVENANCE_ATTESTATION 再判 hard/soft）',
        };
      } else if (args.inFormula === false) {
        out.formulaInputNow = {
          inFormula: false,
          state: FORMULA_INPUT.states.NOT_IN_INPUT_SET,
          bookkeeping: '不挂账（不是欠账）',
          reroute: '先问「能不能外化」——补得成可留痕形态就是 not_collected，补不成才是内 H',
        };
      }
      out.facetRule = FACET_DISCIPLINE;
      if (args.wants !== undefined) {
        out.facetNow = facetOf({ wants: args.wants });
        // 跨面自检：本次问的是哪面、而查询里同时给了别的面的读数 ⇒ 提示但不阻断
        if (args.selfReadsAs !== undefined) {
          out.crossFacet = isCrossFacet({ asked: args.wants, read: args.selfReadsAs });
        }
      }
      if (args.relayLayers !== undefined) {
        out.lossRoute = lossRoute({ relayLayers: args.relayLayers });
      }

      // 🔴 H 的通行许可：跑道铺到处 ⇒ 放开了跑（撤过度谨慎，不是免后果归属）
      out.permit = H_PERMIT;
      if (args.runwayCovered !== undefined) {
        out.permitNow = hPermitOf({ runwayCovered: args.runwayCovered });
      }

      // 余量档：查共识表（区间 ＋ 取端），不拍数
      let rCap = args.rCap;
      if (args.criticality) {
        out.margin = MARGIN_CONSENSUS;
        out.picked = pickMargin({ criticality: args.criticality, notch: args.notch });
        if (rCap === undefined && out.picked.ok) {
          const cap = notchCapOf({ criticality: args.criticality, notch: args.notch });
          out.cap = cap;
          if (cap.ok) rCap = cap.rCap;
        }
      }
      if (args.notchH !== undefined || rCap !== undefined) {
        out.position = slidePos({ tension: t, notchH: args.notchH, rCap, scale: args.scale });
      }

      // 条款形状（不做 NLP 抽取，只校验槽位）
      if (Array.isArray(args.clauses)) {
        const rows = args.clauses.map(checkClauseShape);
        out.clauses = {
          rows,
          slots: CLAUSE_SLOTS,
          summary: {
            structured: rows.filter((r) => r.ok).length,
            unstructured: rows.filter((r) => !r.ok).length,
          },
          note: 'unstructured 不是"判不出"，是**输入缺形状** ⇒ 该补槽位（可执行动作），不是落 review 的理由。',
        };
      }

      // 🔴 H 的裁量权归属：由第一视角自己定；无上级授权者（否则嵌套不终止）
      out.authority = {
        h: H_AUTHORITY,
        split: CAPACITY_VS_LIABILITY,
        note: '裁量权可归 AI（H 自己判）；责任权唯人类。二者不可互代：判得出「谁有责任」≠「责任已裁定」。',
      };

      // 🔴 升级判据：不是「判不出就交还」，是三条合取
      out.escalation = ESCALATION;
      if ([args.undecidable, args.mustTraceOwner, args.relatesToOwner].some((v) => v !== undefined)) {
        out.verdictEscalate = mustEscalate({
          undecidable: args.undecidable,
          mustTraceOwner: args.mustTraceOwner,
          relatesToOwner: args.relatesToOwner,
        });
      } else {
        out.verdictEscalate = { verdict: ESCALATE.UNKNOWN, ok: false, reason: '未给三条中任一条 ⇒ 不判（≠ 不必升级）' };
      }

      // 🔴 二手来源不阻塞：待办 ≠ 欠账
      out.evidence = EVIDENCE_LIFECYCLE;
      // 🔴 实测补的（2026-10-20 E2）：provenance 能不能被别人照着核
      out.provenance = PROVENANCE_ATTESTATION;

      out.note = '只读面：张力只是 S↔D 的跨距，**不是 M 的值**。档B 不参与比值（集合差没有大小）。zero_tension ≠ 通过，它表示「照标准做就行、不需要能动性」。🔴 R=100 是**刻度**不是上限（R 本体无上限）；rCap 是读数，不是界。🔴 H 的取值由第一视角自己定、无上级授权者；升级唯一出口=「判不出 ∧ 须追责 ∧ 与责任人有关」。🔴 **R 不直达**：本层（部门/管理者/主审）手上的尺子是 origin 还是 relay 决定该查什么；放行由上一层给，自评 M 通过不构成放行。🔴 **损耗只能由 H 支付**（唯一主动项）：转述层数↑⇒总 H↑⇒M↓；但优化方向是**移项**（把 H 从零收益的复述处移到正收益的判断处），不是"减少 H"——H=0 违反 `0 <`。🔴 **H 也是通行许可**：「放开了跑，别怕」是给执行者的**指令形态**（不是取值）⇒ 跑道铺到处才发；放开＝把损耗 H 退掉 ⇒ 总 H↓ ⇒ M↑，**不是 H 变大**。';
      return out;
    },
  }));
}

export { name, inject, apply };

// 适配层融合接线：S/D 量化效应传感器（M 闸门约束），详见 src/adapt/sd-effect-sensor.mjs
export { estimateEffectPsi, upliftRank, fusedDecide } from './adapt/sd-effect-sensor.mjs';
