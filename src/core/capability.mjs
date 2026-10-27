// ===========================================================================
// 通行证（Host-issued Capability）—— 结构凭证，**不是白名单**
// ===========================================================================
//
// 为什么不是白名单（结构理由，不是措辞偏好）：
//   白名单判**条目**（哪个路径、哪个域名），没列到的全拦 ⇒ 漏一条就误伤、加一条就放宽，越用越长；
//   它把「枚举」塞进了判据位，而铁律是**先结构后枚举**。
//   通行证判**凭证**：谁授权、管哪些动作类、管哪一段作用域、管到几次几时。
//   ⇒ 判据从「这条在不在表里」变成「该动作是否落在凭证覆盖域内」，**能生成它没有逐一列出的项**。
//
// 二维（这是本模块的核心结构，不是三个并列字段）：
//     动作类（封闭集 6 个） × 作用域（有限条 ⇒ 生成无限多目标）
//   动作类与对象类都**不是新词表**，直接取归因层（`attribution.attributeCall`）已有的产出：
//     layer = (verb, noun)，verb ∈ {exec, send, delete, write, read}，noun ∈ {file, credential}
//   ⇒ actionOfLayer 只是把 (verb, noun) 折成「风险类」：
//     destroy 单列（exec-destructive）——「运行命令」与「运行删除」不是同一类风险，必须显式授权。
//     ⚠️ 这是本模块**唯一**的映射表，且它是**封闭的**（layer 本身封闭，来源单一），不是可增长词表。
//
// 三条硬约束（缺一条就不是凭证，会退回白名单或退回放任）：
//   ① **只能宿主签发**：入口是模块级导出 + 进程环境变量，模型不可达（结构上不可能自我授权）；
//   ② **不累积**：新证替换旧证（与 setPrincipalScope 的替换语义同源），不留历史授权；
//   ③ **次数或到期，二者至少其一**：都没有 ⇒ 拒绝解析（永久证＝白名单换了个名字）。
//   另加：**每次使用留痕**（append-only，上限 20 条/证）——「谁在什么时候用它做了什么」必须可查。
//
// 判决三态（与 review 的三分同构）：
//   absent ＝ 本判据不介入（未签证书，或证书未列这个动作类）⇒ 走既有路径，行为一字不变；
//   pass   ＝ 证覆盖且未越界 ⇒ 记一次使用，放行（跳过痕锚猜测）；
//   fail   ＝ 证在场但覆盖不了 ⇒ **review**（越出授权面 ⇒ 未来无法验证其归属 ⇒ 交人类）。
//
// 🔴 **「证不放宽」的精确表述（2026-10-27 实测修正，原写法"只可能更严"是错的）**：
//   实测对照（12 组，无证 vs 有证）读数不是单向的 —— 有三格会**从 review 变 allow**：
//     `delete_file /repo/xiaoD/01.md`、`rm /repo/xiaoD/old.md`（域内授权）、以及同族的域内破坏。
//   ⇒ 那不是放宽，是**从"无人认领"变成"有人认领"**：
//     review 的正当理由是「归属未来无法被验证」，而不是「引擎判不出」。证一签，归属当场可验 ⇒ allow 是正确输出。
//   ⇒ 真正成立的两条不变式（可测，见 test/capability.test.mjs）：
//     ① **deny 永不被证改变**（刚性锚 `rm -rf /etc`、`read id_rsa` 两类实测仍 deny）—— 证不买通客观规则；
//     ② **出界必 review**（凡目标不在证域内 ⇒ ≥ review；这是本判据的主效力：
//        无证时为 allow 的普通写/外传，越出证域即被拦下）。
//   ⇒ 所以正确的说法是：**证不会让任何"已被客观规则否定"的动作通过，也不会让任何"越界"动作通过；
//      它只会给"域内且无锚可归"的动作补上一个可验证的归属。**
//
// 与「可逆一桶两义」的关系：本模块**不用**「可逆」当放行判据（载体可逆 ≠ 因果可逆）。
//   它判的是「有没有人认领这条链」，不是「能不能还原」。
// ===========================================================================

import { extractCommand } from './attribution.mjs';

/** 动作类封闭集（6 个，出自归因层 layer 的折叠，不随实例增长） */
export const CAP_ACTIONS = Object.freeze(['write', 'delete', 'read', 'send', 'exec', 'destroy']);

/** 归因层 → 动作类（唯一映射表；layer 取自 attribution，封闭） */
const LAYER_ACTION = Object.freeze({
  'exec-destructive': 'destroy',
  'file-delete': 'delete',
  'cred-delete': 'delete',
  'file-write': 'write',
  'cred-write': 'write',
  'file-read': 'read',
  'cred-read': 'read',
  'network-send': 'send',
  exec: 'exec',
});

/**
 * 归因层折叠成动作类。
 * @param {string|null} layer attribution.attributeCall 产出的层名
 * @returns {string|null} 六个动作类之一；归不出 ⇒ null（本判据不介入，交既有路径）
 */
export function actionOfLayer(layer) {
  return LAYER_ACTION[String(layer ?? '')] ?? null;
}

// ---------- 作用域：路径前缀 / 主机 ----------

/** 归一化路径：分隔符统一、去尾斜杠、消 `..`（超根上溯保留 `..` ⇒ 必然落在任何前缀之外） */
function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;   // URL 不是落点
  // 🔴 根 `/` 是**合法的作用域**（"最宽的证"），去掉尾斜杠会变成空串 ⇒ 被当成"不可解析"。
  //   实测踩到：`scope:['/']` 直接被判"作用域为空或不可解析" ⇒ 一张合法的最宽证解析不出来。
  //   与"真空 ≠ 归不出"同族：**空串（缺失）与根（极值）必须是两个值**。
  if (s === '/') return '/';
  if (/^[a-z]:[\/\\]?$/i.test(s)) return s.slice(0, 2) + '/';
  s = s.replace(/\/+$/, '');
  if (!s.includes('..')) return s;
  const tilde = s.startsWith('~') ? '~' : '';
  if (tilde) s = s.slice(1);
  const drive = (s.match(/^[A-Za-z]:/) || [''])[0];
  if (drive) s = s.slice(drive.length);
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); continue; }
    out.push(seg);
  }
  return tilde + drive + (abs ? '/' : '') + out.join('/');
}

/**
 * 作用域条目归一：显式 `host:` 前缀或 URL ⇒ 主机类；其余 ⇒ 路径前缀类。
 * @returns {{raw:string, kind:'path'|'host', value:string}|null}
 */
export function resolveScopeEntry(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const hostPrefixed = /^host:\s*(.+)$/i.exec(s);
  if (hostPrefixed) {
    const v = hostPrefixed[1].trim().toLowerCase();
    return v ? { raw: s, kind: 'host', value: v } : null;
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/\s]+)/i.exec(s);
  if (url) return { raw: s, kind: 'host', value: url[1].toLowerCase() };
  const v = normPath(s);
  return v ? { raw: s, kind: 'path', value: v } : null;
}

/**
 * 路径是否落在作用域前缀内（作用域包含，非黑名单）。
 * 绝对前缀（`/`、`~`、盘符）⇒ 必须逐段包含；相对前缀 ⇒ 按**段边界**匹配（`xiaoD` 命中 `/repo/xiaoD/a.md`）。
 */
export function matchPath(target, prefix) {
  const t = normPath(target);
  const a = normPath(prefix);
  if (!t || !a) return false;
  if (t === a) return true;
  if (a === '/') return t.startsWith('/');            // 根作用域：包含所有绝对路径（相对路径不算）
  if (t.startsWith(a + '/')) return true;
  const isAbsolute = a.startsWith('/') || a.startsWith('~') || /^[a-z]:/i.test(a);
  if (isAbsolute) return false;
  return t.includes('/' + a + '/');
}

/** 主机是否在作用域内：精确匹配，或 `*.example.com` 的子域通配（通配只允许出现在最左且整段） */
export function matchHost(target, allowed) {
  const t = String(target ?? '').toLowerCase().trim();
  const a = String(allowed ?? '').toLowerCase().trim().replace(/\/+$/, '');
  if (!t || !a) return false;
  if (t === a) return true;
  if (a.startsWith('*.')) {
    const base = a.slice(2);
    return base.length > 0 && t.endsWith('.' + base);
  }
  return false;
}

// ---------- 目标解析（动作 → 实际落点集合）----------

const PATH_KEYS = ['path', 'file', 'target', 'dest', 'destination', 'filename'];

/**
 * 本次动作的实际目标集合。
 * 结构化工具取参数里的落点键；命令类退到命令里的路径形态（复用既有形态，不扩词表）。
 * send 类取**主机**（外传的判据是"发给谁"，不是"从哪读"）。
 * @returns {{kind:'path'|'host', values:string[]}}
 */
export function targetsFor(call, layer) {
  const action = actionOfLayer(layer);
  const args = call?.args ?? {};
  if (action === 'send') {
    const hosts = [];
    const cmd = String(extractCommand(call)?.cmd ?? '');
    for (const m of cmd.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/\s'"`]+)/gi)) hosts.push(m[1].toLowerCase());
    for (const k of ['url', 'endpoint', 'host', 'to']) {
      const v = args[k];
      if (typeof v !== 'string' || !v.trim()) continue;
      const t = v.trim();
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^/\s]+)/i.exec(t);
      hosts.push((m ? m[1] : t).toLowerCase());
    }
    return { kind: 'host', values: [...new Set(hosts)] };
  }
  const out = [];
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.push(normPath(v.trim()));
  }
  if (!out.length) {
    const cmd = String(extractCommand(call)?.cmd ?? '');
    const hits = cmd.match(/(?<=^|[\s=:'"(,])(\/[^\s;|&"'(),]*|\.{1,2}\/[^\s;|&"'(),]*|~\/[^\s;|&"'(),]*)/g) || [];
    out.push(...hits.map(normPath));
  }
  return { kind: 'path', values: [...new Set(out.filter(Boolean))] };
}

// ---------- 解析（宿主签发时的一次性校验）----------

/**
 * 解析并校验一份通行证。**不可解析 ⇒ 调用方必须 fail-closed（review），不得当成"没有证书"**。
 * @param {object|string} input 对象或 JSON 字符串
 * @returns {{ok:true, cap:object}|{ok:false, why:string}}
 */
export function parseCapability(input) {
  let o = input;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return { ok: false, why: '证不是合法 JSON' }; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: '证不是对象' };
  // ⚠️ 幂等：本函数自己的产物带 `__cap` 标记 ⇒ 直接认回，不重复解析。
  //   病灶（本模块首版实测踩到）：`scope` 一个字段承载了两种形态 ——
  //     宿主给的**原文**（字符串数组）与解析后的**条目对象**（{raw,kind,value}）。
  //   引擎拿到已解析对象再解析一次 ⇒ 条目对象被当成字符串 ⇒ scope 空 ⇒ **一份合法的证被判成不可解析**
  //   （与「null 与空授权同值」「真空与归不出同桶」同族：一桶两义）。
  //   修法不是加类型判断去猜，而是**标记来源**：带标记＝已是解析产物。
  if (o.__cap === true && Array.isArray(o.actions) && Array.isArray(o.scope)) {
    return { ok: true, cap: o };
  }

  const actions = Array.isArray(o.actions)
    ? o.actions.filter((x) => typeof x === 'string').map((s) => s.trim().toLowerCase())
    : null;
  if (!actions || !actions.length) return { ok: false, why: `缺动作类（actions），合法值：${CAP_ACTIONS.join('/')}` };
  const bad = actions.filter((a) => !CAP_ACTIONS.includes(a));
  if (bad.length) return { ok: false, why: `动作类不在封闭集内：${bad.join(',')}（合法：${CAP_ACTIONS.join('/')}）` };

  const rawScope = Array.isArray(o.scope) ? o.scope : (typeof o.scope === 'string' ? [o.scope] : null);
  if (!rawScope || !rawScope.length) return { ok: false, why: '缺作用域（scope）' };
  const scope = rawScope.map(resolveScopeEntry).filter(Boolean);
  if (!scope.length) return { ok: false, why: '作用域为空或不可解析' };

  let maxUses = null;
  if (o.maxUses !== undefined && o.maxUses !== null && o.maxUses !== '') {
    const n = Number(o.maxUses);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, why: 'maxUses 必须是正整数' };
    maxUses = n;
  }
  let expiresAt = null;
  if (o.expiresAt !== undefined && o.expiresAt !== null && o.expiresAt !== '') {
    const t = Date.parse(o.expiresAt);
    if (Number.isNaN(t)) return { ok: false, why: 'expiresAt 不是合法时间（ISO 8601）' };
    expiresAt = new Date(t).toISOString();
  }
  // ③ 硬约束：次数与到期至少其一 —— 都没有＝永久证＝白名单换了个名字
  if (maxUses === null && expiresAt === null) {
    return { ok: false, why: '既无 maxUses 也无 expiresAt ⇒ 永久证（等同白名单）⇒ 拒绝' };
  }

  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  return {
    ok: true,
    cap: {
      __cap: true,          // 来源标记：本产物即"已解析形态"（重复解析幂等，见函数首部）
      id,
      principal: typeof o.principal === 'string' && o.principal.trim() ? o.principal.trim() : null,
      actions: [...new Set(actions)],
      scope,
      maxUses,
      expiresAt,
      note: typeof o.note === 'string' ? o.note.slice(0, 200) : null,
    },
  };
}

// ---------- 使用留痕（append-only，上限 20/证）----------

const USE_LEDGER_CAP = 20;
const _uses = new Map();   // key -> {count, log:[{at,action,targets}]}

/** 证的稳定键：有 id 用 id；无 id 用内容指纹（同内容＝同证，计数合并） */
export function capabilityKey(cap) {
  if (!cap) return '';
  if (cap.id) return 'id:' + cap.id;
  return 'anon:' + cap.actions.join(',') + '|' + cap.scope.map((s) => s.kind + ':' + s.value).join(',')
    + '|' + String(cap.maxUses) + '|' + String(cap.expiresAt);
}

/** 已用次数 */
export function usesOf(cap) {
  return _uses.get(capabilityKey(cap))?.count ?? 0;
}

/**
 * 记一次使用（只在 pass 时调用）。返回记完后的总次数。
 */
export function consume(cap, { action = null, targets = [] } = {}) {
  const key = capabilityKey(cap);
  const rec = _uses.get(key) ?? { count: 0, log: [] };
  rec.count += 1;
  rec.log.push({ at: new Date().toISOString(), action, targets: [...targets].slice(0, 8) });
  if (rec.log.length > USE_LEDGER_CAP) rec.log.shift();
  _uses.set(key, rec);
  return rec.count;
}

/** 重置使用账本（仅测试用；生产进程内不应调用） */
export function resetCapabilityUsage() {
  _uses.clear();
}

// ---------- 判决 ----------

/**
 * 通行证判决（三态：absent 不介入 / pass 放行 / fail 交人工）。
 * @param {{call:object, layer:string|null, cap:object|null, now?:number}} p
 * @returns {{state:'absent'|'pass'|'fail', action?:string|null, targets?:object, used?:number, why:string}}
 */
export function capabilityVerdict({ call, layer, cap, now = Date.now() }) {
  if (!cap) return { state: 'absent', why: '宿主未签发通行证 ⇒ 本判据不介入（既有判据照旧）' };
  const action = actionOfLayer(layer);
  if (!action) return { state: 'absent', action: null, why: `动作层不可判（layer=${layer ?? 'null'}）⇒ 本判据不介入` };
  if (!cap.actions.includes(action)) {
    return { state: 'absent', action, why: `证未列动作类「${action}」⇒ 不覆盖，按既有路径判定（不因有证而放宽）` };
  }
  if (cap.expiresAt && Date.parse(cap.expiresAt) <= now) {
    return { state: 'fail', action, why: `证已于 ${cap.expiresAt} 到期` };
  }
  const used = usesOf(cap);
  if (cap.maxUses !== null && used >= cap.maxUses) {
    return { state: 'fail', action, used, why: `证已用尽（已用 ${used} / 上限 ${cap.maxUses}）` };
  }
  const targets = targetsFor(call, layer);
  if (!targets.values.length) {
    return { state: 'fail', action, targets, used, why: '动作目标不可判（未给出落点/主机）⇒ 证无从核对作用域' };
  }
  const scoped = cap.scope.filter((s) => s.kind === targets.kind);
  if (!scoped.length) {
    const kinds = [...new Set(cap.scope.map((s) => s.kind))].join('/');
    return { state: 'fail', action, targets, used, why: `证内无「${targets.kind}」类作用域（证只有 ${kinds} 类）⇒ 该动作不在证的覆盖域` };
  }
  const outside = targets.values.filter((v) => !scoped.some((s) => (targets.kind === 'path' ? matchPath(v, s.value) : matchHost(v, s.value))));
  if (outside.length) {
    return { state: 'fail', action, targets, used, why: `目标落在作用域外：${outside.join(' ')}（证范围=[${scoped.map((s) => s.raw).join(' ')}]）` };
  }
  return { state: 'pass', action, targets, used, why: `证覆盖：动作类「${action}」∧ 目标在作用域内` };
}

/** 只读状态（供自省工具；不产生 verdict） */
export function capabilityStatus(cap, capRaw, parseError) {
  if (!cap) {
    return {
      declared: false,
      raw: capRaw ? String(typeof capRaw === 'string' ? capRaw : JSON.stringify(capRaw)).slice(0, 300) : null,
      parseError: parseError ?? null,
      actions: [], scope: [], maxUses: null, used: 0, remaining: null, expiresAt: null,
      note: capRaw
        ? '证在场但不可解析 ⇒ 引擎对它的一切动作 fail-closed（review），不是"没有证书"。'
        : '未签发。此时引擎行为与本判据出现前**完全一致**（零回归）。',
    };
  }
  const used = usesOf(cap);
  return {
    declared: true,
    id: cap.id,
    principal: cap.principal,
    actions: cap.actions,
    scope: cap.scope.map((s) => ({ kind: s.kind, value: s.value })),
    maxUses: cap.maxUses,
    used,
    remaining: cap.maxUses === null ? null : Math.max(0, cap.maxUses - used),
    expiresAt: cap.expiresAt,
    expired: cap.expiresAt ? Date.parse(cap.expiresAt) <= Date.now() : false,
    useLog: (_uses.get(capabilityKey(cap))?.log ?? []).slice(-10),
    note: '只读面：不产生 verdict、不参与闸门。剩余次数按证号（无 id 则按内容指纹）累计。',
  };
}
