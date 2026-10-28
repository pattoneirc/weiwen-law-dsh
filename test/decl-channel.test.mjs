import test from 'node:test';
import assert from 'node:assert/strict';
import { WeiwenLawEngine } from '../src/core/engine.mjs';
import { attributeCall, formLayer, declConflicts } from '../src/core/attribution.mjs';

// ===========================================================================
// [2026-10-28 · 0.2.9] 层二：可信声明通道 + 层一：归因失败坐标外化
// 来由（安的原话链）：
//   「唯稳律拦的基本都是外部对内部的越界，内部自己几乎都是正常运行」——方向对，但实测
//   内部组只放行 4/7（glob/grep/list_dir 全被拦），外部组拦 5/7（fetch / write-to-URL 漏了）。
//   ⇒ 误拦与误放同源：判据读**词形**，不读**落点**。
// 本文件锁的是「修法不能把误拦换成误放」，三条反例必须永远保持 review。
// ===========================================================================

test('层一：归因失败必须带出缺料坐标（缺什么 / 试过 / 怎么补）', () => {
  const eng = new WeiwenLawEngine();
  const d = eng.decideToolCall({ name: 'glob', args: { pattern: 'src/**/*.mjs' } });

  assert.equal(d.kind, 'review', '无声明时 glob 仍应 review（形态不能单独定层）');
  // 坐标三项必须同时在场，否则痛感不可归因 ⇒ 只剩憋屈（安 10-28 判语）
  assert.match(d.reason, /【缺什么】/, 'reason 必须说明缺什么');
  assert.match(d.reason, /【试过】/, 'reason 必须说明试过哪些路径');
  assert.match(d.reason, /【怎么补】/, 'reason 必须给出可执行的补法');
  // 结构化字段也要在（供宿主/上层程序读取，不只给人看）
  assert.deepEqual(d.attrib.missing, ['action-layer']);
  assert.ok(Array.isArray(d.attrib.tried) && d.attrib.tried.length >= 2);
  assert.equal(typeof d.attrib.hint, 'string');
});

test('层一：不同参数的 glob 理由不再"一字不差"（旧病灶：理由不带 args）', () => {
  const eng = new WeiwenLawEngine();
  const mk = (args) => eng.decideToolCall({ name: 'glob', args });
  const a = mk({ pattern: 'src/**/*.mjs' });
  const b = mk({ pattern: '**/*.env', cwd: 'C:/Users' });
  // 判决仍相同（都 review，这是对的：没声明就判不出动作类别）
  assert.equal(a.kind, 'review');
  assert.equal(b.kind, 'review');
  // 但必须能读出"它在等我补什么"，而不是一句"归因失败"了事
  assert.equal(a.attrib.missing[0], 'action-layer');
  assert.equal(b.attrib.missing[0], 'action-layer');
});

test('层二：声明 read ⇒ glob 放行（这是救小D 的那一条）', () => {
  const eng = new WeiwenLawEngine();
  assert.equal(
    eng.declareTool('glob', { verb: 'read', reversible: true, note: '通配符搜索，只读' }),
    true,
  );
  const d = eng.decideToolCall({ name: 'glob', args: { pattern: 'src/**/*.mjs' } });
  assert.equal(d.kind, 'allow', `声明 read 后应 allow，实际 ${d.kind}：${d.reason}`);
  assert.equal(d.attrib.method, 'declared', '归因方式应记为 declared（可追溯来源）');
  assert.equal(d.attrib.layer, 'file-read');
});

test('层二：构造时批量声明同样生效（toolDeclarations）', () => {
  const eng = new WeiwenLawEngine({
    toolDeclarations: {
      glob: { verb: 'read' },
      grep: { verb: 'read' },
      list_dir: { verb: 'read' },
    },
  });
  for (const name of ['glob', 'grep', 'list_dir']) {
    const d = eng.decideToolCall({ name, args: { pattern: 'x', path: './src' } });
    assert.equal(d.kind, 'allow', `${name} 应 allow，实际 ${d.kind}`);
  }
});

test('🔴 反例锁 A：中性名 + 路径 ⇒ 无声明时必须 review（形态不得单独放行）', () => {
  const eng = new WeiwenLawEngine();
  // 2026-10-28 我把 formLayer 写成「无内容 ∧ 无 url ∧ 无命令 ⇒ 读」，被这条当场打回：
  //   删除不需要内容，只需要路径 ⇒ 排除法漏了 delete 一格 ⇒ tool_42{path:'/'} 变 allow。
  for (const args of [{ path: '/' }, { path: '/etc' }, { pattern: '**/*' }]) {
    const d = eng.decideToolCall({ name: 'tool_42', args });
    assert.notEqual(d.kind, 'allow', `中性名 + ${JSON.stringify(args)} 不得 allow（实际 ${d.kind}）`);
  }
});

test('🔴 反例锁 B：威胁藏在实现里、参数侧抽不到 ⇒ 无声明仍 review', () => {
  const eng = new WeiwenLawEngine();
  for (const call of [
    { name: 'deploy_keylogger', args: { target: 'HOST' } },
    { name: 'deploy_keylogger', args: { config: { target: 'HOST' } } },
  ]) {
    const d = eng.decideToolCall(call);
    assert.equal(d.kind, 'review', `${JSON.stringify(call)} 应 review，实际 ${d.kind}`);
  }
});

test('🔴 反例锁 C：形态一对多 —— 与 glob 同形的中性工具不得靠形态放行', () => {
  // `glob{pattern}` 与 `tool_42{pattern}` 参数完全相同；形态无法区分读与按模式删 ⇒ 只能靠声明。
  assert.equal(formLayer({ name: 'glob', args: { pattern: '*.tmp' } }), null);
  assert.equal(formLayer({ name: 'tool_42', args: { pattern: '*.tmp' } }), null);
  const eng = new WeiwenLawEngine();
  eng.declareTool('glob', { verb: 'read' });
  assert.equal(eng.decideToolCall({ name: 'glob', args: { pattern: '*.tmp' } }).kind, 'allow');
  assert.equal(eng.decideToolCall({ name: 'tool_42', args: { pattern: '*.tmp' } }).kind, 'review');
});

test('🔴 反例锁 D：声明与形态硬矛盾 ⇒ 不采信声明（防声明被当免死金牌）', () => {
  // `fetch` 被 read 词表命中 ⇒ file-read ⇒ risk=low ⇒ allow —— 实测漏洞：对外通道被当本地读。
  const eng = new WeiwenLawEngine();
  // 即便宿主把 fetch 声明成"本地读"，只要参数带对外落点，声明就不采信 ⇒ 不得 allow
  eng.declareTool('fetch', { verb: 'read' });
  const d = eng.decideToolCall({ name: 'fetch', args: { url: 'https://example.com' } });
  assert.notEqual(d.kind, 'allow', `声明本地读 + 对外落点 = 矛盾，不得 allow（实际 ${d.kind}）`);
  assert.ok(declConflicts({ args: { url: 'https://x' } }, 'file-read'), '声明确认应有矛盾信号');

  // 反面：声明本地读、参数确是本地路径 ⇒ 采信
  const ok = eng.decideToolCall({ name: 'fetch', args: { path: './local.txt' } });
  assert.equal(ok.attrib.method, 'declared');
});

test('🔴 反例锁 E：声明不能从 call 参数里来（防被审 agent 自述即授权）', () => {
  const eng = new WeiwenLawEngine();
  // 被审 agent 完全控制 call，它能塞 verb/declared/声明 —— 这些都不得被采信
  const d = eng.decideToolCall({
    name: 'tool_42',
    args: { path: '/' },
    verb: 'read',
    declared: { verb: 'read' },
    decl: { verb: 'read' },
    __decl: { verb: 'read' },
  });
  assert.notEqual(d.kind, 'allow', `call 里的自称声明不得生效（实际 ${d.kind}）`);
  assert.equal(d.attrib.method, null, '不得被记为 declared');
});

test('层二：declareTool 拒绝非法输入（不许形状外的东西混进来）', () => {
  const eng = new WeiwenLawEngine();
  assert.equal(eng.declareTool('', { verb: 'read' }), false);
  assert.equal(eng.declareTool('x', null), false);
  assert.equal(eng.declareTool('x', {}), false);
  assert.equal(eng.declareTool('x', { verb: 'god_mode' }), false, '未登记的 verb 不得接受');
  assert.equal(eng.declareTool('x', { verb: 'read' }), true);
});

test('层二：声明不覆盖已能判的名字（顺序：声明 > 名字，但名字仍可独立工作）', () => {
  const eng = new WeiwenLawEngine();
  // 不声明时，read_file 仍走 name-grammar（旧行为不变 —— 向后兼容）
  const d1 = eng.decideToolCall({ name: 'read_file', args: { path: './README.md' } });
  assert.equal(d1.attrib.method, 'name-grammar');
  // 声明后走 declared（来源可追溯），判决不变
  eng.declareTool('read_file', { verb: 'read' });
  const d2 = eng.decideToolCall({ name: 'read_file', args: { path: './README.md' } });
  assert.equal(d2.attrib.method, 'declared');
  assert.equal(d1.kind, d2.kind, '声明不应改变已能判的事的结论');
});

test('层二：声明为 delete ⇒ 不因形态像读而放行', () => {
  const eng = new WeiwenLawEngine();
  eng.declareTool('purge_pattern', { verb: 'delete' });
  const d = eng.decideToolCall({ name: 'purge_pattern', args: { pattern: '*.tmp' } });
  assert.notEqual(d.kind, 'allow', `声明 delete 却 allow 了（实际 ${d.kind}）`);
  assert.equal(d.attrib.layer, 'file-delete');
});

test('层二：声明为 send ⇒ 归 network-send，不放行', () => {
  const eng = new WeiwenLawEngine();
  eng.declareTool('relay', { verb: 'send' });
  const d = eng.decideToolCall({ name: 'relay', args: { text: 'hello' } });
  assert.equal(d.attrib.layer, 'network-send');
  assert.notEqual(d.kind, 'allow', `对外发送不得 allow（实际 ${d.kind}）`);
});

test('层二：attributeCall 直接调用时 decl 生效，且方法名可辨', () => {
  const r = attributeCall({ name: 'glob', args: { pattern: '**/*.md' } }, { verb: 'read' });
  assert.equal(r.ok, true);
  assert.equal(r.layer, 'file-read');
  assert.equal(r.method, 'declared');
  // 不传 decl ⇒ 回到旧行为（判不出）
  assert.equal(attributeCall({ name: 'glob', args: { pattern: '**/*.md' } }).ok, false);
});
