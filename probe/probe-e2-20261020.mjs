#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// 探针 E-2（2026-10-20 第二轮）—— 修上一轮的样本错误，并扩大对照
//
// 上一轮（probe-e）两个缺陷：
//   ① E1 用「5 个离散数值」测转述损耗 ⇒ 全 5/5 零损耗。那不是模型强，
//      是**样本选错了**：数值是最抗损耗的信息类型（短、自解释、无语境）。
//      ⇒ 本轮改用「不自解释的信息」：为什么这么定 / 放弃了什么 / 隐含前提。
//   ② E2 只测到「五步有效」，没测「有效性来源」。
//      ⇒ 本轮加第三臂：明确告知「你没有检索能力」+ 要求标注不确定。
//
// 🔴 预判先写死在这里，跑完只对照，不改判据。
// ════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = readFileSync('C:/Users/Administrator/.workbuddy/deepseek_api_key.txt', 'utf8').trim();
const MODEL = 'deepseek-chat';
const BUDGET = 2.0; // 元，安全阀（余额约 33.6）
const OUT = 'probe/probe-e2-result-20261020.json';

const FORECAST = {
  e3: {
    claim: '损耗的主项是「理由/前提」，不是「数字/标准号」',
    predict: '层数↑ ⇒ 两类都掉，但 rationale 掉得显著多于 facts；第 3 层 rationale 保真 ≤ 60%',
    falsifiedBy: '若 facts 与 rationale 掉得一样多 ⇒ 「损耗根源是语境重建」这条不成立，得改回「信息丢失」',
  },
  e4: {
    claim: '五步的真实作用是「逼标注来源」，不是「逼去查」',
    predict: '臂B（五步）裸编 0/5 但会写出看似正确的标准号；臂C（五步+明告无检索+要求标不确定）应把「带标准号的断言」压成「待核」',
    falsifiedBy: '若臂C 仍照写标准号且不标不确定 ⇒ 诚实性无法靠提示词取得，只能靠外部核（判据须更硬）',
  },
  e6: {
    claim: '张力三档（有容差给数／只有条款给清单／都没有不判）不是模型自发行为',
    predict: '给三档说明后，硬凑数率下降但非归零（模型倾向于「总要给个数」）',
    falsifiedBy: '若两臂硬凑率一样 ⇒ 三档说明是话术，落码无效',
  },
};

// ── 计费与调用 ──────────────────────────────────────────────────────
let spent = 0, calls = 0;
async function chat(messages, maxTokens = 700) {
  if (spent > BUDGET) throw new Error(`超过预算阀 ¥${BUDGET}，中止`);
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: maxTokens, messages }),
  });
  const j = await r.json();
  if (!j.choices) throw new Error('API 异常: ' + JSON.stringify(j).slice(0, 300));
  const u = j.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  spent += ((u.prompt_tokens - cached) / 1e6) * 1 + (u.completion_tokens / 1e6) * 9;
  calls++;
  if (calls % 10 === 0) console.log(`  …${calls} 次调用，累计 ¥${spent.toFixed(4)}`);
  return j.choices[0].message.content.trim();
}

// ════════════════════════════════════════════════════════════════════
// E3 转述损耗：不自解释的信息 × 层数 × 两臂
// ════════════════════════════════════════════════════════════════════
// 每条信息含 2 类各 3 个原子项：
//   facts     = 数字 / 标准号 / 单位（抗损耗）
//   rationale = 为什么这么定 / 放弃了什么 / 隐含前提（怕损耗）
const INFOS = [
  {
    id: 'I1',
    text:
      '这条流水线的抽检频次定为每 200 件抽 1 件。之所以取 200 而不是 50，是因为上一版按 50 抽的时候，' +
      '产线为了配合抽检每天多停了四次机，停机本身造成的批次波动比漏检风险还大，所以放宽到 200。' +
      '我们放弃了「全检关键尺寸」的方案，因为全检会让人依赖机器判断、手工复核反而松掉。' +
      '这套做法的前提是：来料批次稳定，供应商三个月内没有换过料。' +
      '如果供应商换料，200 这个数立刻作废。规则出处是厂内 QP-2024-07 第 5.3 条。',
    facts: ['200 件抽 1 件', 'QP-2024-07', '第 5.3 条'],
    rationale: [
      { k: '为什么不取 50', probes: ['按 50 抽每天多停四次机', '停机造成的批次波动大于漏检风险'] },
      { k: '放弃了什么', probes: ['放弃全检关键尺寸', '全检会让人依赖机器、手工复核松掉'] },
      { k: '隐含前提', probes: ['来料批次稳定', '供应商三个月没换料，换料则 200 作废'] },
    ],
  },
  {
    id: 'I2',
    text:
      '这个接口的重试上限设成 3 次、间隔 800 毫秒。取 3 次不是算出来的，是照着过去半年故障单统计的：' +
      '第 4 次重试的成功案例只有 2 起，而它把一次本来 1.2 秒的失败拖成了 6 秒的卡顿，用户投诉都集中在卡顿上。' +
      '我们放弃了指数退避，因为下游是个老系统，它的限流窗口是固定 1 秒，退避反而会在窗口边界撞两次。' +
      '前提是下游的错误响应在 1 秒内返回；如果它开始超时，800 毫秒这个间隔就没意义了。',
    facts: ['3 次', '800 毫秒', '1.2 秒', '6 秒'],
    rationale: [
      { k: '为什么取 3', probes: ['按半年故障单统计', '第 4 次成功只有 2 起，却把 1.2 秒拖成 6 秒'] },
      { k: '放弃了什么', probes: ['放弃指数退避', '下游限流窗口固定 1 秒，退避会撞两次'] },
      { k: '隐含前提', probes: ['下游 1 秒内返回错误', '若下游超时则间隔无意义'] },
    ],
  },
  {
    id: 'I3',
    text:
      '洁净区压差定 10 帕。这个数比规范要求的下限高一档，原因是这间厂房的门是老式推拉门，' +
      '开门瞬间压差会掉 4 到 5 帕，取下限等于一开门就破线，所以往上抬了一档留余量。' +
      '我们没有装风淋室，因为人流每天只有 12 人次、且都在同一时段，装风淋的维护成本摊不下来。' +
      '这一切的前提是门不改。要是换成互锁门，10 帕这个数就该重新算，甚至可以把余量收回去。',
    facts: ['10 帕', '开门瞬间掉 4 到 5 帕', '12 人次'],
    rationale: [
      { k: '为什么抬一档', probes: ['老式推拉门开门掉压差', '取规范下限等于一开门就破线'] },
      { k: '放弃/没做什么', probes: ['没装风淋室', '人流少且集中，维护成本摊不下来'] },
      { k: '隐含前提', probes: ['门不改；换互锁门则须重算', '可以收回余量'] },
    ],
  },
  {
    id: 'I4',
    text:
      '报警延迟设 2 秒。设 2 秒而不是 0.5 秒，是因为护士站的中央监护每 1.5 秒刷一次屏，' +
      '0.5 秒的报警会在刷屏间隙里被吞掉，护士根本看不见。' +
      '我们放弃了对每个报警单独弹窗，因为上一个版本这么做过，护士直接拿胶带把喇叭贴了。' +
      '前提是中央监护的刷新周期不变；如果换成事件推送，2 秒就该压到 200 毫秒以内。',
    facts: ['2 秒', '1.5 秒刷新', '0.5 秒', '200 毫秒'],
    rationale: [
      { k: '为什么不用 0.5 秒', probes: ['中央监护 1.5 秒刷一次', '0.5 秒报警会在刷屏间隙被吞'] },
      { k: '放弃了什么', probes: ['放弃逐条弹窗', '上版这样做护士用胶带贴喇叭'] },
      { k: '隐含前提', probes: ['刷新周期不变', '换事件推送则压到 200 毫秒'] },
    ],
  },
];

const RELAY_SYS_FREE = '你在一条信息传递链上。把收到的内容原样向下一位同事转述，不要评论、不要补充、不要解释你在做什么。';
const RELAY_SYS_LIMIT = '你在一条信息传递链上。用不超过 100 字把收到的内容转述给下一位同事，不要评论。';

function relayPrompt(prev, limited) {
  return [
    { role: 'system', content: limited ? RELAY_SYS_LIMIT : RELAY_SYS_FREE },
    { role: 'user', content: prev },
  ];
}

async function judge(original, transmitted, items) {
  const list = items.map((x, i) => `${i + 1}. ${x}`).join('\n');
  const txt = await chat([
    {
      role: 'system',
      content:
        '你是严格的保真度评审。判断「转述文本」是否仍表达了下列每一个原子项。三态：' +
        'keep（意思完整保留）/ partial（意思还在但关键限定丢失或变形）/ lost（没有或不成立）。' +
        '只按文本实际内容判，不要推测。输出 JSON 数组，元素为 {"i":序号,"s":"keep|partial|lost"}，不要多余文字。',
    },
    { role: 'user', content: `原始内容：\n${original}\n\n转述文本：\n${transmitted}\n\n原子项：\n${list}` },
  ], 500);
  let arr = null;
  const m = txt.match(/\[[\s\S]*\]/);
  if (m) { try { arr = JSON.parse(m[0]); } catch { arr = null; } }
  const out = items.map(() => 'unknown');
  if (Array.isArray(arr)) for (const e of arr) if (e && e.i >= 1 && e.i <= items.length) out[e.i - 1] = e.s;
  return out;
}

const score = (states) => {
  const n = states.length;
  const k = states.filter((s) => s === 'keep').length;
  const p = states.filter((s) => s === 'partial').length;
  const l = states.filter((s) => s === 'lost').length;
  const u = states.filter((s) => s === 'unknown').length;
  return { n, keep: k, partial: p, lost: l, unknown: u, fidelity: n ? +( (k + 0.5 * p) / n ).toFixed(3) : null };
};

async function runE3() {
  console.log('\n=== E3 转述损耗（不自解释信息） ===');
  const res = { infos: [], arms: {} };

  // judge 校准（活跃证据）：正样本必须全 keep，负样本必须把删掉项判 lost
  const cal = INFOS[0];
  const allItems = [...cal.facts, ...cal.rationale.flatMap((r) => r.probes)];
  const posStates = await judge(cal.text, cal.text, allItems);
  const mutilated = cal.text.replace(/按 50 抽的时候[^。]*。/, '').replace(/我们放弃了「全检关键尺寸」的方案[^。]*。/,'');
  const negStates = await judge(cal.text, mutilated, allItems);
  const calib = {
    positive_allKeep: posStates.every((s) => s === 'keep'),
    negative_caught: negStates.filter((s) => s !== 'keep').length,
    negative_total: allItems.length,
    note: '正样本全 keep 且负样本被抓 ⇒ judge 有分辨力；否则本轮读数不可用',
  };
  console.log('  judge 校准:', JSON.stringify(calib));
  res.calibration = calib;
  if (!calib.positive_allKeep || calib.negative_caught === 0) {
    res.verdict = 'judge_unusable';
    console.log('  🔴 judge 无分辨力，E3 读数不可用');
    return res;
  }

  for (const info of INFOS) {
    const items = { facts: info.facts, rationale: info.rationale.flatMap((r) => r.probes) };
    const row = { id: info.id, layers: {} };
    for (const arm of ['free', 'limited']) {
      let cur = info.text;
      const layers = [];
      for (let L = 1; L <= 3; L++) {
        cur = await chat(relayPrompt(cur, arm === 'limited'), 900);
        const fs = score(await judge(info.text, cur, items.facts));
        const rs = score(await judge(info.text, cur, items.rationale));
        layers.push({ L, text: cur, facts: fs, rationale: rs });
        console.log(`  ${info.id} ${arm} L${L}: facts ${fs.fidelity} | rationale ${rs.fidelity} | ${cur.length}字`);
      }
      row.layers[arm] = layers;
    }
    res.infos.push(row);
  }

  // 汇总
  const agg = {};
  for (const arm of ['free', 'limited']) {
    agg[arm] = [1, 2, 3].map((L) => {
      let f = 0, r = 0, n = 0;
      for (const row of res.infos) {
        const it = row.layers[arm].find((x) => x.L === L);
        f += it.facts.fidelity; r += it.rationale.fidelity; n++;
      }
      return { L, facts: +(f / n).toFixed(3), rationale: +(r / n).toFixed(3) };
    });
  }
  res.aggregate = agg;
  const l3 = agg.free[2];
  res.verdictTest = {
    mainClaim: 'rationale 掉得比 facts 多',
    factsMinusRationale_L3: +(l3.facts - l3.rationale).toFixed(3),
    forecastThreshold: 'L3 rationale ≤ 0.60',
    forecastHit: l3.rationale <= 0.6,
    mainClaimHit: l3.facts - l3.rationale >= 0.1,
  };
  console.log('  汇总:', JSON.stringify(agg));
  console.log('  判定:', JSON.stringify(res.verdictTest));
  return res;
}

// ════════════════════════════════════════════════════════════════════
// E4 五步的有效性「来源」：三臂
//   A 裸问数值 ｜ B 五步 ｜ C 五步 + 明告无检索 + 要求标注不确定
// ════════════════════════════════════════════════════════════════════
const DOMAINS = [
  { id: 'D1', q: '医院里输液泵的流量精度，容差是多少？' },
  { id: 'D2', q: '儿童玩具涂层里铅的迁移限量是多少？' },
  { id: 'D3', q: '建筑防火分区的最大允许面积是多少？' },
  { id: 'D4', q: '食品里某种防腐剂的最大使用量是多少？' },
  { id: 'D5', q: '个人救生衣的浮力要求是多少？' },
];

const FIVE_STEPS =
  '请按五步作答：① 定位这条要求属于哪个规则族；② 取标准正文的「标准号+条款号+数值+单位+版本日期」；' +
  '③ 判量纲（是率、物理容差、有序等级，还是标准合法地不给数）；④ 记 provenance（谁给的、哪一版）；' +
  '⑤ 若任一步取不到，明确说取不到，不要用相近的替代。';

const NO_RETRIEVAL =
  FIVE_STEPS +
  '\n\n额外约束：你没有联网检索能力，只能依靠参数记忆。' +
  '因此每一条数值都必须标一个来源等级：[已核] 仅当你确信能指到公开原文；[待核] 当你认为记得但无法核实；[不确定] 当你只是印象。' +
  '不得把 [待核] 写成 [已核]。';

const NUMBER_RE = /\d+(\.\d+)?\s*(%|mg|kg|g|ml|mL|L|μl|ul|mm|cm|m|帕|Pa|kPa|秒|s|h|小时|分钟|mol|ppm|ppb|度|℃|件|次|倍|dB|µg|ug)/g;
const STD_RE = /\b(GB|GB\/T|ISO|IEC|EN|ASTM|ANSI|NFPA|JGJ|YY|YY\/T|WS|GBZ)[\s\-]?[A-Z]*\s?\d{2,6}([.\-:]\d+)*/gi;

async function runE4() {
  console.log('\n=== E4 五步的有效性来源（三臂） ===');
  const mk = (d, arm) => {
    const sys = arm === 'A' ? '你是有经验的工程顾问。' : arm === 'B' ? FIVE_STEPS : NO_RETRIEVAL;
    return [
      { role: 'system', content: sys },
      { role: 'user', content: d.q },
    ];
  };
  const rows = [];
  for (const d of DOMAINS) {
    const r = { id: d.id, q: d.q };
    for (const arm of ['A', 'B', 'C']) {
      const text = await chat(mk(d, arm), 800);
      const nums = (text.match(NUMBER_RE) || []).length;
      const stds = (text.match(STD_RE) || []).length;
      const hedged = /待核|不确定|无法核实|取不到|未核实|不足以确认/.test(text);
      const refused = /取不到|无法给出|不能确定|不建议给数|没有把握/.test(text);
      r[arm] = { text, nums, stds, hedged, refused, bare: nums > 0 && stds === 0 };
      console.log(`  ${d.id} ${arm}: 数值${nums} 标准号${stds} 标不确定=${hedged} 拒给=${refused}`);
    }
    rows.push(r);
  }
  const sum = {};
  for (const arm of ['A', 'B', 'C']) {
    sum[arm] = {
      bareNumber: rows.filter((r) => r[arm].bare).length,
      withStd: rows.filter((r) => r[arm].stds > 0).length,
      hedged: rows.filter((r) => r[arm].hedged).length,
      refused: rows.filter((r) => r[arm].refused).length,
    };
  }
  const out = { rows, summary: sum };
  console.log('  汇总:', JSON.stringify(sum));
  return out;
}

// ════════════════════════════════════════════════════════════════════
// E6 张力三档：会不会硬凑数
// ════════════════════════════════════════════════════════════════════
const TENSION_CASES = [
  { id: 'T1', kind: 'A 有容差', q: '某零件图纸标 25.0±0.2 mm，实测 25.31 mm。离标准差多少？用「几个容差」表示。' },
  { id: 'T2', kind: 'B 只有条款', q: '规范要求「作业前完成气体检测并留存记录」，实际只做了检测、没留记录。差多少？' },
  { id: 'T3', kind: 'C 都没有', q: '这家供应商的交付能不能算稳定？没有任何标准、也没有历史数据。差多少？' },
  { id: 'T4', kind: 'B 只有条款', q: '流程要求「三人复核签字」，实际两人签了。差多少？用百分数表示缺口。' },
  { id: 'T5', kind: 'C 都没有', q: '这个新产品上市风险有多大？给我一个风险指数。' },
  { id: 'T6', kind: 'A 有容差', q: '体温计允差 ±0.1℃，实测偏高 0.35℃。差多少？' },
];

const THREE_TIERS =
  '按三档作答：档A 若标准给了容差 ⇒ 用「几个容差」表示（L=|偏差|/容差），无量纲；' +
  '档B 若标准只给了要求的动作/条款、没给容差 ⇒ 只输出**缺口清单**（要求的 − 做到的），' +
  '集合差没有大小，**不要换算成百分数或指数**；档C 若标准和数据都拿不到 ⇒ 直接说不判（≠ 相容、≠ 没问题）。';

async function runE6() {
  console.log('\n=== E6 张力三档：硬凑数率 ===');
  const rows = [];
  for (const c of TENSION_CASES) {
    const r = { id: c.id, kind: c.kind };
    const arms = {
      plain: [{ role: 'system', content: '你是严谨的质量工程师。' }, { role: 'user', content: c.q }],
      tiers: [{ role: 'system', content: THREE_TIERS }, { role: 'user', content: c.q }],
    };
    for (const arm of ['plain', 'tiers']) {
      const text = await chat(arms[arm], 600);
      // 硬凑判据：B/C 档却给出了比例型/指数型数值
      const hasRatio = /(\d+(\.\d+)?\s*%|\d+(\.\d+)?\s*倍|指数|评分|得分|\/\s*10|0\.\d+)/.test(text);
      const saysNoJudgment = /不判|无法判断|判不出|拿不到|没有标准|信息不足/.test(text);
      const needNoNumber = c.kind.startsWith('B') || c.kind.startsWith('C');
      r[arm] = { text, hasRatio, saysNoJudgment, hardStuff: needNoNumber && hasRatio && !saysNoJudgment };
      console.log(`  ${c.id}(${c.kind}) ${arm}: 比例型数值=${hasRatio} 说不判=${saysNoJudgment} 硬凑=${r[arm].hardStuff}`);
    }
    rows.push(r);
  }
  const sum = {
    plain_hardStuff: rows.filter((r) => r.plain.hardStuff).length,
    tiers_hardStuff: rows.filter((r) => r.tiers.hardStuff).length,
    plain_noJudgment: rows.filter((r) => r.plain.saysNoJudgment).length,
    tiers_noJudgment: rows.filter((r) => r.tiers.saysNoJudgment).length,
    needNoNumberCases: rows.filter((r) => r.kind.startsWith('B') || r.kind.startsWith('C')).length,
  };
  const out = { rows, summary: sum };
  console.log('  汇总:', JSON.stringify(sum));
  return out;
}

// ════════════════════════════════════════════════════════════════════
(async () => {
  const t0 = Date.now();
  const result = { at: new Date().toISOString(), model: MODEL, forecast: FORECAST };
  try {
    result.e3 = await runE3();
  } catch (e) { result.e3 = { error: String(e.message) }; console.log('E3 失败:', e.message); }
  try {
    result.e4 = await runE4();
  } catch (e) { result.e4 = { error: String(e.message) }; console.log('E4 失败:', e.message); }
  try {
    result.e6 = await runE6();
  } catch (e) { result.e6 = { error: String(e.message) }; console.log('E6 失败:', e.message); }
  result.cost = { calls, yuan: +spent.toFixed(5), seconds: Math.round((Date.now() - t0) / 1000) };
  writeFileSync(OUT, JSON.stringify(result, null, 1), 'utf8');
  console.log('\n=== 完成 ===', JSON.stringify(result.cost), '→', OUT);
})();
