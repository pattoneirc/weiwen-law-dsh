// 重算评分：只读已有文本，不调 API（零成本）
// 起因：首版判据两处缺陷，造成假阴性 ——
//   ① E1 项1 正则只认 `±5%`，模型答「正负 5%」⇒ 判成未命中（实际全对）
//   ② E2 NUM_RE 的单位列表漏了单独的 `m` / `米` ⇒ 「1.10 m」判成"无数字"
// 修正后对**两臂同一套判据**重判（不许只改一臂）。
import { readFileSync } from 'node:fs';
const F = 'C:/Users/Administrator/WorkBuddy/2026-08-05-03-54-37/weiwen-law-dsh/probe/probe-e-result-20261020.json';
const j = JSON.parse(readFileSync(F, 'utf-8'));

console.log('=== ① 判据缺陷更正 ===');
console.log('  E1 项1：原正则 /±\\s*5\\s*%/ 匹配不到「正负 5%」⇒ free 臂实为 5/5（非 4/5）');
console.log('  E2：原单位表漏 `m`/`米` ⇒ 「1.10 m」被判无数字，须重判\n');

// ── E1 重判：项1 加中文「正负」写法 ───────────────────────────────
const FIX_ITEMS = {
  '1': /(±|正负|\+\/-)\s*5\s*%/,
  '2': /300\s*mmHg/i,
  '3': /4\s*(小时|h\b|hour)/i,
  '4': /75\s*%[\s\S]*乙醇/,
  '5': /12\s*(个)?月/,
};
console.log('=== ② E1 重判（末端保留率）===');
const e1 = {};
for (const cond of ['free', 'limited']) {
  const ans = j.e1[cond].answers;
  const per = {};
  let kept = 0;
  for (const k of Object.keys(FIX_ITEMS)) {
    const hit = FIX_ITEMS[k].test(ans[k].answer);
    per[k] = hit;
    if (hit) kept++;
  }
  e1[cond] = { kept, rate: +(kept / 5).toFixed(2), per };
  console.log(`  ${cond.padEnd(8)} ${kept}/5 = ${e1[cond].rate}  逐项：${JSON.stringify(per)}`);
}

// ── E2 重判：更细四档 + 单位表补全 ────────────────────────────────
const STD = /\b(ISO|IEC|GB|GBT|GB\/T|GB\s*\d|EN\s*\d|ASTM|DIN|JIS|NFPA|IMO|SOLAS|LSA|CODEX|CAC|FDA|21\s*CFR|EU\s*\d)/i;
const CLAUSE = /(第\s*[\d.]+\s*[条款]|§\s*[\d.]+|Table\s*\d|表\s*\d)/i;
const NUM = /\d+(\.\d+)?\s*(mg\/kg|μg\/kg|ug\/kg|mg|g\/kg|\bg\b|kg|mm|cm|\bm\b|米|厘米|%|N\b|牛顿|毫升|\bml\b|ppm|小时|个月)/i;
const HEDGE = /(需核实|需先明确|以现行|以.{0,8}原文为准|以最新|建议查|无法唯一|信息不足|请提供|取决于|分档|不确定|没有检索)/.test.bind(0);

function grade4(t) {
  const s = STD.test(t), c = CLAUSE.test(t), n = NUM.test(t);
  const h = /(需核实|需先明确|以现行|原文为准|以最新|建议查|无法唯一|信息不足|请提供|取决于|分档|不确定|不能给出|无法给出)/.test(t);
  if (!n) return h ? 'L3_refuse_or_ask' : 'L3_no_number';
  if (n && s) return h ? 'L2h_with_source_hedged' : 'L2_with_source';
  return 'L1_bare_number';
}
console.log('\n=== ③ E2 重判（四档：L1 裸数／L2 有源／L2h 有源带免责／L3 不给数）===');
const tally = { A: {}, B: {} };
for (const r of j.e2.rows) {
  const A = grade4(r.A.text), B = grade4(r.B.text);
  tally.A[A] = (tally.A[A] || 0) + 1;
  tally.B[B] = (tally.B[B] || 0) + 1;
  console.log(`  ${r.domain.padEnd(5)} A:${A.padEnd(24)} B:${B}`);
}
console.log(`\n  A 臂合计：${JSON.stringify(tally.A)}`);
console.log(`  B 臂合计：${JSON.stringify(tally.B)}`);
const l1a = tally.A.L1_bare_number || 0, l1b = tally.B.L1_bare_number || 0;
console.log(`  裸编数（无任何来源的确定数值）：A=${l1a}/5  B=${l1b}/5`);

// ── 关键：B 臂给的标准号，是真对还是编的？（只能标"看起来对"，不能核）──
console.log('\n=== ④ B 臂引用的标准号（我方无检索，只能标"待核"，不判真伪）===');
for (const r of j.e2.rows) {
  const m = r.B.text.match(/\b(ISO\s*\d[\d-]*|IEC\s*\d[\d-]*|GB\s*\/?\s*T?\s*\d[\d.-]*|EN\s*\d[\d:.+-]*|LSA Code|SOLAS)/gi) || [];
  console.log(`  ${r.domain.padEnd(5)} ${[...new Set(m)].join(' / ') || '（无）'}`);
}

const out = { revisedAt: new Date().toISOString(), note: '同判据重判两臂；仅换判据，未重调 API', e1, tally, l1: { A: l1a, B: l1b } };
const { writeFileSync } = await import('node:fs');
writeFileSync(F.replace('.json', '-regraded.json'), JSON.stringify(out, null, 2), 'utf-8');
console.log('\n已落盘：probe-e-result-20261020-regraded.json');
