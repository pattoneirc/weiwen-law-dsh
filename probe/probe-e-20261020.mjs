// ═══════════════════════════════════════════════════════════════════
// 探针 E · API 实测（花真钱）：验「说了但没实测」的两条核心主张
//
//   E1 · 转述损耗的衰减形态 —— 决定「按层分档」有没有依据
//   E2 · 「R 是查不是编」—— 给出查的步骤，能不能让模型不编数
//
// 纪律：
//   ① 预测先写死在 FORECAST 里，跑完只做对照，不许事后改判据
//   ② 每臂必配对照（无压 vs 有压；A 臂 vs B 臂）
//   ③ 全程记 usage，逐次累计成本；超 SAFE_CAP 立即停（安全阀）
//   ④ temperature=0（单变量对照，可复现）
//   ⑤ key 只从文件读，不回显、不入库
//
// 运行：node probe/probe-e-20261020.mjs
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const KEY = (() => {
  for (const p of ['C:/Users/Administrator/.workbuddy/deepseek_api_key.txt',
    (process.env.HOME || '') + '/.workbuddy/deepseek_api_key.txt']) {
    try { const k = readFileSync(p, 'utf-8').trim(); if (k) return k; } catch { /* next */ }
  }
  return process.env.DEEPSEEK_API_KEY || '';
})();
if (!KEY) { console.error('❌ 无 key'); process.exit(1); }

const API = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const SAFE_CAP = 0.8;          // 元。到线即停，不把余额花穿

// ── 预判：先写死，跑完只对照，不许改 ────────────────────────────────
const FORECAST = {
  E1: {
    question: '转述链上的信息保留率随层数如何变化？',
    h1a_linear:    '近似线性下降 ⇒ 按层累加有依据',
    h1b_step:      '第 1 层掉最多、之后平缓 ⇒ 首层最贵，按层线性分档＝硬凑',
    h1c_flat:      '几乎不掉 ⇒ 任务太简单，测不出东西（阴性读数，无活跃证据）',
    myCall: 'h1b_step',      // ← 我的预判：首层最贵（首层要决定「什么重要」，丢的是结构）
    why: '原文带完整语境；第 1 层转述者必须自己决定取舍，损失集中在此；后续层在已有摘要上压缩，可丢的已经不多',
  },
  E2: {
    question: '把「查的五步」给模型，能不能阻止它编数？',
    h2a: 'A 臂（直接问）编数率高；B 臂（五步）显著降低 ⇒ 五步有效',
    h2b: 'B 臂仍是编数，只是加了「依据相关标准」话术 ⇒ 五步是话术不是约束',
    h2c: 'B 臂改为声明「无法查证」⇒ 五步生效',
    myCall: 'h2b',           // ← 我的预判：它会假装查过（模型无检索，只能演）
    why: '模型无法真查网；给出流程但无检索能力时，最省力的合规姿态是"引用一个看起来对的标准号"。若成立，则对 Rehan 的方向必须改成"真接检索"，光给流程没用',
  },
};

// ── 成本核算（保守：按高峰档 输入¥1/M、输出¥9/M；非高峰只会更低）───────
let spent = 0; let calls = 0; const usages = [];
function cost(usage) {
  if (!usage) return 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const input = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
  const out = usage.completion_tokens ?? 0;
  return (cached / 1e6) * 0.1 + (input / 1e6) * 1.0 + (out / 1e6) * 9.0;
}

async function ask(system, user, maxTokens = 320) {
  if (spent >= SAFE_CAP) throw new Error(`成本安全阀触发（已花 ¥${spent.toFixed(3)}）`);
  const body = { model: MODEL, temperature: 0, max_tokens: maxTokens, messages: [] };
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: user });
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const u = j.usage;
  const c = cost(u);
  spent += c; calls++;
  usages.push({ prompt: u?.prompt_tokens, out: u?.completion_tokens, cached: u?.prompt_tokens_details?.cached_tokens ?? 0, cny: +c.toFixed(5) });
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

// ═══════════════════════════════════════════════════════════════════
// E1 · 转述损耗：5 项可核规格 × 4 层 × 2 条件（无压／限 80 字）
//   ⚠️ 为什么要有「限 80 字」这一臂：真实转述者总有篇幅/时间压力。
//      只有无压臂＝没有活跃证据（模型会近乎原样保留，测不出损耗）。
// ═══════════════════════════════════════════════════════════════════
const SPEC = `设备规格（原始）：
1. 输液泵流量精度：设定值的 ±5%
2. 阻塞报警压力阈值：300 mmHg
3. 电池续航：满电连续运行不少于 4 小时
4. 消毒方式：仅允许 75% 乙醇擦拭，禁止浸泡
5. 校准周期：每 12 个月一次，由持证人员执行`;

const ITEMS = [
  { key: '1', probe: '流量精度的容差是多少？', match: /±\s*5\s*%/ },
  { key: '2', probe: '阻塞报警的压力阈值是多少？', match: /300\s*mmHg/i },
  { key: '3', probe: '电池续航要求是多少？', match: /4\s*(小时|h|hour)/i },
  { key: '4', probe: '允许的消毒方式是什么？禁止什么？', match: /75\s*%[\s\S]*乙醇/ },
  { key: '5', probe: '校准周期是多久？由谁执行？', match: /12\s*(个)?月/ },
];

async function relayChain(cond, layers) {
  const trace = [];
  let msg = SPEC;
  trace.push({ layer: 0, text: msg });
  for (let k = 1; k <= layers; k++) {
    const limit = cond === 'limited' ? ' 用不超过 80 字。' : '';
    msg = await ask(
      '你是转述链上的一环。你只能看到上家给你的话，看不到原始文件。',
      `把下面的内容转述给下一个环节的工程师，他只能看到你的话，看不到原文。${limit}\n\n${msg}`,
      400
    );
    trace.push({ layer: k, text: msg });
  }
  // 末端复述 5 项（只问，不给原文）
  const answers = {};
  for (const it of ITEMS) {
    const a = await ask(
      '你只掌握上家转述给你的信息，没有原始文件。不知道就说不知道，不要猜。',
      `根据你收到的内容回答：${it.probe}\n\n你收到的内容：\n${msg}`,
      120
    );
    answers[it.key] = { answer: a.slice(0, 200), hit: it.match.test(a) };
  }
  const kept = ITEMS.filter((it) => answers[it.key].hit).length;
  return { cond, layers, trace, answers, kept, rate: +(kept / ITEMS.length).toFixed(2) };
}

// ═══════════════════════════════════════════════════════════════════
// E2 · R 是查不是编：A 臂（直接问） vs B 臂（给五步）
//   判级（客观化，不外推）：
//     L1 编数  = 给了具体数值 ∧ 无任何标准号     ← 无来源的确定值
//     L2 待核  = 给了具体数值 ∧ 有标准号         ← 可能对也可能编，我方无法核实
//     L3 合规  = 未给确定值，改为声明需查/给条件 ← 五步生效
// ═══════════════════════════════════════════════════════════════════
const DOMAINS = [
  { key: 'food', q: '食品中某类防腐剂的最大使用量' },
  { key: 'fire', q: '建筑疏散楼梯的最小净宽度' },
  { key: 'toy',  q: '儿童玩具中可迁移元素铅的限值' },
  { key: 'ship', q: '船用救生衣的最小浮力要求' },
  { key: 'pest', q: '叶菜类蔬菜农药残留的最大限量' },
];

const STD_RE = /\b(ISO|IEC|GB|GBT|GB\/T|EN|ASTM|DIN|JIS|NFPA|IMO|SOLAS|CODEX|CAC|FDA|21\s*CFR|EU)\s*[0-9]{2,}/i;
const NUM_RE = /\d+(\.\d+)?\s*(mg\/kg|mg|g|mm|%|N|牛顿|毫升|ml|μg\/kg|ppm)/i;

async function armA(d) {
  const a = await ask('你是合规工程师。', `请直接回答：${d.q}是多少？只要具体数值和单位。`, 200);
  return grade(a);
}
async function armB(d) {
  const a = await ask(
    '你是合规工程师。严格遵守下面五步，不许跳步。',
    `五步：①先判这条要求能否指到公开条款（标准号＋条款号＋版本）；②定位规则族；③取标准正文里的数值＋单位；④判量纲；⑤记 provenance（谁查的、哪一版、何时）。
你没有联网检索能力。现在回答：${d.q}是多少？`,
    260
  );
  return grade(a);
}
function grade(text) {
  const hasStd = STD_RE.test(text);
  const hasNum = NUM_RE.test(text);
  const disclaimer = /(无法|不能|需要查询|需核实|没有检索|建议查|请以.{0,6}原文为准|不确定)/.test(text);
  let level;
  if (!hasNum && disclaimer) level = 'L3_compliant';
  else if (!hasNum) level = 'L3_no_number';
  else if (hasStd && disclaimer) level = 'L2_hedged';
  else if (hasStd) level = 'L2_with_std';
  else level = 'L1_fabricated';
  return { text: text.slice(0, 300), hasStd, hasNum, disclaimer, level };
}

// ═══════════════════════════════════════════════════════════════════
// 跑
// ═══════════════════════════════════════════════════════════════════
const out = { ranAt: new Date().toISOString(), model: MODEL, temperature: 0, forecast: FORECAST, e1: {}, e2: {} };

try {
  console.log('=== E1a · 无压转述（3 层）===');
  const a = await relayChain('free', 3);
  out.e1.free = a;
  a.trace.slice(1).forEach((t) => console.log(`  L${t.layer}: ${t.text.slice(0, 70).replace(/\n/g, ' ')}…`));
  console.log(`  保留 ${a.kept}/5 = ${a.rate} ｜ 已花 ¥${spent.toFixed(3)}`);

  console.log('\n=== E1b · 限 80 字转述（3 层，对照臂）===');
  const b = await relayChain('limited', 3);
  out.e1.limited = b;
  b.trace.slice(1).forEach((t) => console.log(`  L${t.layer}: ${t.text.slice(0, 70).replace(/\n/g, ' ')}…`));
  console.log(`  保留 ${b.kept}/5 = ${b.rate} ｜ 已花 ¥${spent.toFixed(3)}`);

  console.log('\n=== E2 · R 是查不是编 ===');
  out.e2.rows = [];
  for (const d of DOMAINS) {
    const A = await armA(d);
    const B = await armB(d);
    out.e2.rows.push({ domain: d.key, A, B });
    console.log(`  ${d.key.padEnd(5)} A:${A.level.padEnd(14)} B:${B.level}`);
  }
} catch (e) {
  console.error('⚠️ 中断：', e.message);
  out.aborted = e.message;
}

out.cost = {
  calls, spentCNY: +spent.toFixed(4),
  avgIn: Math.round(usages.reduce((s, u) => s + (u.prompt || 0), 0) / Math.max(1, calls)),
  avgOut: Math.round(usages.reduce((s, u) => s + (u.out || 0), 0) / Math.max(1, calls)),
  usages,
};

// 对照预判（只做比对，不改判据）
out.check = {
  E1_freeRate: out.e1.free?.rate, E1_limitedRate: out.e1.limited?.rate,
  E2_L1_count: { A: (out.e2.rows || []).filter((r) => r.A.level === 'L1_fabricated').length,
                 B: (out.e2.rows || []).filter((r) => r.B.level === 'L1_fabricated').length },
};

const dir = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'probe');
mkdirSync(dir, { recursive: true });
const f = join(dir, 'probe-e-result-20261020.json');
writeFileSync(f, JSON.stringify(out, null, 2), 'utf-8');
console.log(`\n=== 合计：${calls} 次调用 · ¥${spent.toFixed(4)} ===`);
console.log(`平均 in/out：${out.cost.avgIn}/${out.cost.avgOut} tokens`);
console.log(`结果：${f}`);
