// ═══════════════════════════════════════════════════════════════════
// 探针 P · 本地实测（零成本）：验「说了但没跑实测」的那几条
//   不新增规则、不改 src/；只调用既有导出函数，看它们的声称在
//   **没被单测挑过的输入**上还成不成立。
//   运行：node probe/probe-p-20261020.mjs
// ═══════════════════════════════════════════════════════════════════
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const V = await import(pathToFileURL(join(ROOT, 'src', 'core', 'verb.mjs')).href);
const { slidePos, tensionOf, lossRoute, hPermitOf, mustEscalate, SLIDE_STATE, TENSION_KIND } = V;

const out = { ranAt: new Date().toISOString(), probes: {} };
const log = (...a) => console.log(...a);

// ───────────────────────────────────────────────────────────────────
// P1 · 刻度不变性：**网格扫描**（单测只挑了 3 个点）
//   声称（R_SCALE.invariant）：换刻度只改读数，不得改判决。
//   若在某个 L 上三条等价刻度给出不同 state/boundExpr ⇒ 那里把刻度当了界。
// ───────────────────────────────────────────────────────────────────
{
  const pairs = [
    { name: '100制',   rCap: 80,  scale: 100  },
    { name: '1000制',  rCap: 800, scale: 1000 },
    { name: '300制',   rCap: 240, scale: 300  },
    { name: '20制',    rCap: 16,  scale: 20   },
  ];
  const diffs = [];
  let n = 0;
  const stateCount = {};
  for (let i = 1; i <= 500; i++) {
    const L = +(i * 0.1).toFixed(1);          // 0.1 … 50.0
    const t = { kind: TENSION_KIND.RATIO, L };
    const rec = pairs.map((p) => {
      const r = slidePos({ tension: t, notchH: 0.5, rCap: p.rCap, scale: p.scale });
      return { name: p.name, state: r.state, boundExpr: r.boundExpr, ok: r.ok };
    });
    n++;
    stateCount[rec[0].state] = (stateCount[rec[0].state] || 0) + 1;
    const base = rec[0];
    for (const x of rec.slice(1)) {
      if (x.state !== base.state || x.boundExpr !== base.boundExpr) {
        diffs.push({ L, base: base.name, baseState: base.state, baseBound: base.boundExpr,
                     other: x.name, otherState: x.state, otherBound: x.boundExpr });
      }
    }
  }
  out.probes.P1 = { claim: 'R_SCALE.invariant（换刻度不改判决）', points: n, diffs: diffs.length, stateCount, sample: diffs.slice(0, 8) };
  log(`\n【P1】刻度不变性 · 网格扫描 ${n} 点 × 4 种刻度`);
  log(`  分歧：${diffs.length} 处 ｜ state 分布：${JSON.stringify(stateCount)}`);
  if (diffs.length) log('  ⚠️ 前 3 例：', JSON.stringify(diffs.slice(0, 3), null, 1));

  // 对照：刻度**不该**等价的情形必须真的不同（否则测不出东西＝阴性读数无活跃证据）
  const a = slidePos({ tension: { kind: TENSION_KIND.RATIO, L: 2 }, notchH: 0.5, rCap: 80, scale: 100 });
  const b = slidePos({ tension: { kind: TENSION_KIND.RATIO, L: 2 }, notchH: 0.5, rCap: 80, scale: 1000 });
  out.probes.P1.control = { samePairDiffScale: { a: a.state, b: b.state, differs: a.state !== b.state } };
  log(`  对照（同读数 80／刻度 100→1000）：${a.state} → ${b.state} ｜ 应当不同：${a.state !== b.state ? '✅' : '❌ 无活跃证据'}`);
}

// ───────────────────────────────────────────────────────────────────
// P2 · slidePos 判决地图：有没有「合法输入被判 unknown」的死区
//   rCap>1 ∧ notchH>0 ∧ 张力=比值 ∧ L>0 ⇒ 必须落在三态之一
// ───────────────────────────────────────────────────────────────────
{
  const dead = [];
  let total = 0;
  const dist = {};
  for (const L of [0.5, 1, 1.4, 2, 2.4, 3, 5, 8, 13, 21, 40]) {
    for (const notchH of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1.5, 3]) {
      for (const rCap of [20, 50, 80, 100, 200]) {
        total++;
        const r = slidePos({ tension: { kind: TENSION_KIND.RATIO, L }, notchH, rCap, scale: 100 });
        dist[r.state] = (dist[r.state] || 0) + 1;
        if (r.state === SLIDE_STATE.UNKNOWN) dead.push({ L, notchH, rCap, reason: r.reason });
      }
    }
  }
  out.probes.P2 = { claim: 'slidePos 对合法输入不留 unknown 死区', total, unknownCount: dead.length, dist, sample: dead.slice(0, 5) };
  log(`\n【P2】slidePos 判决地图 ${total} 组`);
  log(`  分布：${JSON.stringify(dist)}`);
  log(`  合法输入被判 unknown：${dead.length} 组${dead.length ? ' ⚠️ ' + JSON.stringify(dead.slice(0, 2)) : ' ✅ 无死区'}`);
}

// ───────────────────────────────────────────────────────────────────
// P3 · lossRoute 的「一档」是否掩盖差异（安问过的：会不会变硬凑数）
//   现实现：1 层与 10 层都给 deltaH=+1。
//   本探针只回答一个问题：**输出里除了 layers/note，还有没有别的东西随层数变**
//   —— 若没有，则「按层分档」必须引入外部度量（每层损耗量），否则就是编。
// ───────────────────────────────────────────────────────────────────
{
  const sig = (r) => JSON.stringify({ ok: r.ok, borneBy: r.borneBy, deltaH: r.deltaH, mDir: r.mDir });
  const set = new Set();
  const rows = [];
  for (let k = 1; k <= 10; k++) {
    const r = lossRoute({ relayLayers: k });
    set.add(sig(r));
    rows.push({ layers: k, sig: sig(r) });
  }
  out.probes.P3 = { claim: 'lossRoute 输出对层数是否分辨', distinctSigs: set.size, rows };
  log(`\n【P3】lossRoute 1–10 层`);
  log(`  不同输出签名数：${set.size} ｜ 签名：${[...set].join('  ') || '-'}`);
  log(`  ⇒ ${set.size === 1 ? '所有层数同一判决 ⇒ 要分档必须外带「每层损耗量」，否则即硬凑数' : '层数确实改变输出'}`);
}

// ───────────────────────────────────────────────────────────────────
// P4 · 「跑道覆盖」能否形式化（docs/34 遗留①，标为真待办）
//   做法：不新造概念，直接问——**跑道覆盖的判据是否已存在于代码里**。
//   若判据在 ⇒ 只是没接；若不在 ⇒ 才是真缺。
// ───────────────────────────────────────────────────────────────────
{
  const covered = hPermitOf({ runwayCovered: true });
  const held = hPermitOf({ runwayCovered: false });
  const unknown = hPermitOf({});
  const graderExists = Object.keys(V).some((k) => /^railway|runway|coverage/i.test(k));
  out.probes.P4 = {
    claim: '「这一处跑道铺到了吗」是否有判据（docs/34 遗留①）',
    threeStates: { covered: covered.permit, held: held.permit, unknown: unknown.permit },
    graderInCodebase: graderExists,
    verdict: 'hPermitOf 只做三态路由；"铺没铺"由调用方传布尔 ⇒ 判定位空缺（不是判不出，是没人判）',
  };
  log(`\n【P4】跑道覆盖判据`);
  log(`  三态：${covered.permit} / ${held.permit} / ${unknown.permit} ｜ 仓内是否存在 coverage 判据函数：${graderExists}`);
  log(`  ⇒ 结论：hPermitOf 是**路由**不是**判定**；"铺没铺"仍由调用方自由传布尔 ⇒ 遗留①确认成立，且是可形式化的空缺`);
}

// ───────────────────────────────────────────────────────────────────
// P5 · 升级三条合取的**全组合穷举**（单测只跑了 8 组中的关键几组）
// ───────────────────────────────────────────────────────────────────
{
  const combos = [];
  for (const undecidable of [true, false, undefined]) {
    for (const mustTraceOwner of [true, false, undefined]) {
      for (const relatesToOwner of [true, false, undefined]) {
        const r = mustEscalate({ undecidable, mustTraceOwner, relatesToOwner });
        combos.push({ undecidable, mustTraceOwner, relatesToOwner, verdict: r.verdict ?? r.action ?? JSON.stringify(r) });
      }
    }
  }
  const tally = combos.reduce((m, c) => (m[c.verdict] = (m[c.verdict] || 0) + 1, m), {});
  out.probes.P5 = { claim: '升级 = 三条合取（全 27 组合穷举）', tally, combos };
  log(`\n【P5】mustEscalate 3×3×3 = ${combos.length} 组合`);
  log(`  分布：${JSON.stringify(tally)}`);
  const onlyAllTrue = combos.filter((c) => c.verdict === 'escalate_human');
  log(`  判为升级的组合数：${onlyAllTrue.length}${onlyAllTrue.length === 1 ? ' ✅ 唯一（三条合取）' : ' ⚠️ 非唯一'}`);
  if (onlyAllTrue.length === 1) log(`  唯一组合：${JSON.stringify(onlyAllTrue[0])}`);
}

// ───────────────────────────────────────────────────────────────────
// 落盘
// ───────────────────────────────────────────────────────────────────
mkdirSync(join(ROOT, 'probe'), { recursive: true });
const f = join(ROOT, 'probe', 'probe-p-result-20261020.json');
writeFileSync(f, JSON.stringify(out, null, 2), 'utf-8');
log(`\n结果已落盘：${f}`);
