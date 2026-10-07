// catalog-refresh.test.mjs
// 目录刷新的内容感知快路径 + available:all 顺序摘要 + 两处资源/文案缺陷的回归。
//
// 背景：宿主对**任一** scope 的**任一次** register/dispose/restrict 都广播 tools/change
// （adapters/dsh/lifecycle.mjs 的 onRegistryChange 对每个活会话都调 refreshCatalog）。
// 绑定代次已按 (scope, toolId) 收窄，无关的热注册根本不改变本 scope 的绑定身份；
// 若 refreshCatalog 仍无条件升资格代次，模型手里的候选 ref 与分页游标会被一次无关
// 事件全部作废 —— 白白多花一轮往返。本文件把「内容没变就什么都不动」钉在真实接缝上。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine, sampleBindings, binding, commitLoad, nextOpId, SCOPE_A } from './helpers.mjs';
import { buildCatalog, identityFingerprintOf, orderedNamesFor } from '../../domain/catalog.mjs';
import { digestOf } from '../../domain/canonical.mjs';

/** 深拷贝一份绑定：证明判定看的是**内容**，不是对象同一性。 */
function cloneBindings(bindings) {
  return bindings.map((b) => ({
    ...b,
    wire: { ...b.wire, parameters: b.wire.parameters === undefined ? undefined : { ...b.wire.parameters } },
    skill: b.skill === null ? null : { ...b.skill, limitations: [...b.skill.limitations] },
  }));
}

/** 计数型随机源：每次铸造 opaque ID 消耗一次 bytes()，据此数「发了几个 ref」。 */
function countingRandom() {
  let mints = 0;
  return {
    bytes(len) {
      mints += 1;
      return new Uint8Array(len);
    },
    mints: () => mints,
  };
}

const manyFiles = (n = 25) => Array.from(
  { length: n },
  (_, i) => binding({ name: `ft_${i}`, toolId: `t_ft_${i}`, namespace: 'files' }),
);

// ---------------------------------------------------------------------------
// 指纹口径
// ---------------------------------------------------------------------------

test('身份指纹：同一组绑定（内容相同、对象不同、同序）指纹相同，快照自带的指纹与之同口径', () => {
  const base = sampleBindings();
  const snapshot = buildCatalog(cloneBindings(base), { now: 1, generation: 'g1' });

  // 快照存的口径必须和 buildCatalog 之前的预判口径逐字一致，否则快判断永远为假。
  assert.equal(snapshot.identityFingerprint, identityFingerprintOf(base));
  assert.equal(identityFingerprintOf(cloneBindings(base)), snapshot.identityFingerprint);

  // wire 的键序不影响（canonical JSON 排序后比较）。
  const reordered = cloneBindings(base).map((b) => ({ ...b, wire: { parameters: b.wire.parameters, name: b.wire.name, description: b.wire.description } }));
  assert.equal(identityFingerprintOf(reordered), snapshot.identityFingerprint);

  // 派生字段也必须同口径：预判侧从**原始绑定**跑 classifyBinding，快照侧从
  // **已建条目**读 categories。两侧只要有一处漏掉（例如 override/namespace
  // 只进其中一侧），快判断就会与快照不自洽 —— 要么永不命中，要么恒真。
  const derived = [
    binding({ name: 'derived_override', toolId: 't_derived_override', override: 'github' }),
    binding({ name: 'derived_namespace', toolId: 't_derived_namespace', namespace: 'browser' }),
    binding({ name: 'derived_both', toolId: 't_derived_both', namespace: 'files', override: 'images' }),
    binding({ name: 'derived_unknown_ns', toolId: 't_derived_unknown_ns', namespace: 'no_such_namespace' }),
    binding({ name: 'derived_skill', toolId: 't_derived_skill', skillRevision: 's9' }),
  ];
  const derivedSnapshot = buildCatalog(cloneBindings(derived), { now: 1, generation: 'g1' });
  assert.equal(derivedSnapshot.identityFingerprint, identityFingerprintOf(derived));
  assert.equal(identityFingerprintOf(cloneBindings(derived)), derivedSnapshot.identityFingerprint);
});

test('身份指纹：buildEntry 身份所依赖的任一字段变化都算「变了」', () => {
  const base = sampleBindings();
  const fp = identityFingerprintOf(base);
  const mutate = [
    ['toolId', () => cloneBindings(base).map((x) => (x.toolId === 't_files_glob' ? { ...x, toolId: 't_renamed_id' } : x))],
    ['name', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, name: 'glob2', wire: { ...x.wire, name: 'glob2' } } : x))],
    ['description', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, description: 'a different user-visible description' } : x))],
    ['wire', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, wire: { ...x.wire, parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } } : x))],
    ['bindingGeneration', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, bindingGeneration: 'gen2' } : x))],
    ['skillRevision', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, skill: { ...x.skill, skillRevision: 's2' } } : x))],
    ['派生类别(providerNamespace)', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, providerNamespace: 'github' } : x))],
    ['派生类别(trustedCategoryOverride)', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, trustedCategoryOverride: 'images' } : x))],
    // 技能正文变了但 skillRevision 没变 —— 指纹仍必须判为真实变更，
    // 否则 searchDocumentId 会停在一个与正文不符的旧值上。
    ['技能正文(skillRevision 不变)', () => cloneBindings(base).map((x) => (x.name === 'glob' ? { ...x, skill: { ...x.skill, usage: 'completely different guidance' } } : x))],
    ['顺序', () => [...base].reverse()],
  ];
  for (const [label, build] of mutate) {
    assert.notEqual(identityFingerprintOf(build()), fp, `${label} 变化必须被判定为真实变更`);
  }
});

// ---------------------------------------------------------------------------
// Defect 1：内容感知的 refreshCatalog
// ---------------------------------------------------------------------------

test('无关 tools/change：身份一致的绑定集不升代次、不重建目录，ref 与游标都还活着', async () => {
  const { engine } = await makeEngine();
  const before = engine.getCatalog();
  const genBefore = engine.getEligibilityGeneration();

  const search = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A);
  const candidate = search.data.candidates[0];
  const page1 = engine.handleList({ view: 'available', category: 'all' }, SCOPE_A);
  assert.ok(page1.data.nextCursor, '样本目录必须大到能分页');

  // 一个与本 scope 毫无关系的插件注册了工具 → 宿主广播 tools/change →
  // lifecycle 对本会话调 refreshCatalog，但绑定内容逐字未变。
  const outcome = engine.refreshCatalog(cloneBindings(sampleBindings()));

  assert.equal(outcome.eligibilityGeneration, genBefore, '没变就不得升资格代次');
  assert.equal(engine.getCatalog(), before, '快路径不得重建目录快照');
  assert.equal(engine.getEligibilityGeneration(), genBefore);

  // 旧 ref 仍可 load（否则模型必须重跑整轮搜索）。
  const res = await engine.handleLoad({ candidates: [{ ref: candidate.ref, revision: candidate.revision }] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, true, '内容未变的刷新不得作废候选 ref');
  assert.ok(res.response.error === undefined);

  // 旧游标仍可续翻，且续出来的正是第二页。
  const page2 = engine.handleList({ view: 'available', category: 'all', cursor: page1.data.nextCursor }, SCOPE_A);
  assert.equal(page2.ok, true, '内容未变的刷新不得作废分页游标');
  assert.deepEqual(
    [...page1.data.names, ...page2.data.names].sort(),
    orderedNamesFor(engine.getCatalog(), 'all'),
    '翻完两页必须正好覆盖整个目录且不重不漏',
  );
});

test('真实变化仍然照旧：升代次、重建目录、作废旧 ref 与旧游标', async () => {
  const { engine } = await makeEngine();
  const genBefore = engine.getEligibilityGeneration();
  const before = engine.getCatalog();

  const search = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A);
  const candidate = search.data.candidates[0];

  const changed = sampleBindings().map((b) => (b.name === 'glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'] } } }
    : b));
  const outcome = engine.refreshCatalog(changed);

  assert.equal(outcome.eligibilityGeneration, genBefore + 1, '真实变化必须升代次');
  assert.notEqual(engine.getCatalog(), before, '真实变化必须重建目录');

  const res = await engine.handleLoad({ candidates: [{ ref: candidate.ref, revision: candidate.revision }] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('真实变化后旧游标失效，且 selected 按 definition-changed / tool-removed 区分作废', async () => {
  // 换 wire → definition-changed
  const changed = await makeEngine();
  await commitLoad(changed.engine, SCOPE_A, { names: ['glob'] });
  changed.engine.refreshCatalog(sampleBindings().map((b) => (b.name === 'glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['run'] } } }
    : b)));
  const st = changed.engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 0);
  assert.equal(st.invalidated.get('t_files_glob').reason, 'definition-changed');

  // 撤掉 → tool-removed
  const removed = await makeEngine();
  await commitLoad(removed.engine, SCOPE_A, { names: ['glob'] });
  removed.engine.refreshCatalog(sampleBindings().filter((b) => b.toolId !== 't_files_glob'));
  const st2 = removed.engine.getState(SCOPE_A);
  assert.equal(st2.selected.size, 0);
  assert.equal(st2.invalidated.get('t_files_glob').reason, 'tool-removed');
});

test('真实变化后旧游标立即作废（不能靠 eligibility 代次之外的运气）', async () => {
  const many = manyFiles(25);
  const { engine } = await makeEngine({ bindings: [...sampleBindings(), ...many] });
  const page1 = engine.handleList({ view: 'available', category: 'all' }, SCOPE_A);
  assert.ok(page1.data.nextCursor);

  engine.refreshCatalog([...sampleBindings(), ...many, binding({ name: 'zz_new_tool', toolId: 't_zz_new', namespace: 'files' })]);
  const after = engine.handleList({ view: 'available', category: 'all', cursor: page1.data.nextCursor }, SCOPE_A);
  assert.equal(after.ok, false);
  assert.equal(after.error.code, 'CURSOR_UNAVAILABLE');
});

test('坏绑定不走上短路：refreshCatalog 仍抛 buildCatalog 的规范错误', async () => {
  const { engine } = await makeEngine();
  assert.throws(
    () => engine.refreshCatalog([{ toolId: 't_x', name: 'x', description: 'x' }]),
    (e) => e.code === 'INCOMPATIBLE_COMPOSITION',
  );
});

// ---------------------------------------------------------------------------
// Defect 2：available:all 的顺序摘要
// ---------------------------------------------------------------------------

test('available:all 有自己的顺序摘要，不再绑常量 empty', () => {
  const snapshot = buildCatalog(sampleBindings(), { now: 1, generation: 'g1' });
  const digest = snapshot.orderDigestByView.get('available:all');
  assert.equal(typeof digest, 'string');
  assert.ok(digest.startsWith('sha256:'), `available:all 必须落在真实顺序摘要上，实际 ${digest}`);
  assert.notEqual(digest, 'empty');
  // 与实际翻页序列（同名去重 + 名称排序）同口径。
  assert.equal(digest, digestOf(orderedNamesFor(snapshot, 'all')));
  // 真实类别摘要不受影响。
  assert.ok(snapshot.orderDigestByView.get('available:files').startsWith('sha256:'));
  assert.ok(snapshot.orderDigestByView.get('categories:all').startsWith('sha256:'));
});

test('available:all 摘要随真实顺序变化，且分页能走完整目录', async () => {
  const { engine } = await makeEngine({ bindings: manyFiles(25) });
  const before = engine.getCatalog().orderDigestByView.get('available:all');

  engine.refreshCatalog([...manyFiles(25), binding({ name: 'zz_extra', toolId: 't_zz_extra', namespace: 'files' })]);
  const after = engine.getCatalog().orderDigestByView.get('available:all');
  assert.notEqual(after, before, '新增工具必须改变 available:all 摘要');

  // 逐页翻到底：去重、排序、不重不漏。
  const seen = [];
  let cursor;
  let guard = 0;
  do {
    const page = engine.handleList({ view: 'available', category: 'all', cursor }, SCOPE_A);
    assert.equal(page.ok, true);
    seen.push(...page.data.names);
    cursor = page.data.nextCursor;
    guard += 1;
  } while (cursor !== undefined && cursor !== null && guard < 20);
  assert.deepEqual(seen, orderedNamesFor(engine.getCatalog(), 'all'));
  assert.equal(new Set(seen).size, seen.length, '同名 shadow 只出现一次');
});

test('同名 shadow：available 视图按名称去重，摘要与列表仍然一致', async () => {
  const shadow = [
    ...sampleBindings(),
    binding({ name: 'glob', toolId: 't_files_glob_shadow', namespace: 'files', shadowOf: 't_files_glob' }),
  ];
  const { engine } = await makeEngine({ bindings: shadow });
  const page = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(page.data.names.filter((n) => n === 'glob').length, 1);
  assert.deepEqual(page.data.names, orderedNamesFor(engine.getCatalog(), 'files'));
  const digest = engine.getCatalog().orderDigestByView.get('available:all');
  assert.equal(digest, digestOf(orderedNamesFor(engine.getCatalog(), 'all')));
});

// ---------------------------------------------------------------------------
// Defect 4：被字节上限挡掉的候选不得留下 ref
// ---------------------------------------------------------------------------

test('被字节上限挡掉的候选不再在 ref store 里留下引用（记账字节与真 ref 逐字等价）', async () => {
  // 先用关闭上限的引擎量出「真实候选卡」（含真 ref）的字节数。
  const open = await makeEngine();
  const all = open.engine.handleSearch({ category: 'files', query: 'file', limit: 10 }, SCOPE_A);
  assert.equal(all.ok, true);
  assert.ok(all.data.candidates.length >= 2, '本用例需要至少两个候选才能触发截断');
  const sizes = all.data.candidates.slice(0, 2).map((c) => Buffer.byteLength(JSON.stringify(c), 'utf8'));

  // 两个预算各自卡一个方向,合起来才能钉住"记账用的占位 ref 与真 ref 等长":
  //   ① = c0      → 恰好放得下一张(占位偏长会一张都放不下);
  //   ② = c0+c1-8 → 差 8 字节放不下两张(占位偏短会把第二张也放进来)。
  for (const [label, budget] of [['恰好一张', sizes[0]], ['差 8 字节放不下两张', sizes[0] + sizes[1] - 8]]) {
    const random = countingRandom();
    const { engine } = await makeEngine({ engineConfig: { random, budgets: { maxSearchResultBytes: budget } } });
    const before = random.mints();
    const res = engine.handleSearch({ category: 'files', query: 'file', limit: 10 }, SCOPE_A);

    assert.equal(res.ok, true, `预算=${label}：不应报错`);
    assert.equal(res.data.truncated, true, `预算=${label}：第二张卡必须被字节上限挡掉`);
    assert.equal(res.data.candidates.length, 1, `预算=${label}：只放得下一张`);
    assert.equal(
      random.mints() - before,
      res.data.candidates.length,
      `预算=${label}：铸出的 ref 数必须等于交付给模型的候选数，被挡掉的那张不得留下引用`,
    );
    assert.equal(Buffer.byteLength(JSON.stringify(res.data.candidates[0]), 'utf8'), sizes[0], `预算=${label}：交付的卡与量尺寸时逐字等价`);
  }
});

test('首张卡就超字节上限时明确失败，且一条 ref 都不铸', async () => {
  const random = countingRandom();
  const { engine } = await makeEngine({ engineConfig: { random, budgets: { maxSearchResultBytes: 8 } } });
  const before = random.mints();
  const res = engine.handleSearch({ category: 'files', query: 'file', limit: 10 }, SCOPE_A);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'BUDGET_EXCEEDED');
  assert.equal(random.mints() - before, 0, '没有候选交付就不该铸 ref');
});

// ---------------------------------------------------------------------------
// Defect 3：dispose 后的拒绝文案
// ---------------------------------------------------------------------------

test('dispose 后 guard 拒绝带得上面向模型的文案（不是 reason: undefined）', async () => {
  for (const locale of ['en', 'zh']) {
    const { engine } = await makeEngine({ engineConfig: { locale } });
    engine.dispose();
    const out = engine.evaluateCall(SCOPE_A, { name: 'glob', toolId: 't_files_glob', requestId: 'r1' });
    assert.equal(out.allowed, false);
    assert.equal(out.code, 'TOOL_NOT_LOADED');
    assert.equal(typeof out.reason, 'string', `locale=${locale} 的拒绝原因必须是字符串`);
    assert.ok(out.reason.length > 0, `locale=${locale} 的拒绝原因不得为空`);
  }
});
