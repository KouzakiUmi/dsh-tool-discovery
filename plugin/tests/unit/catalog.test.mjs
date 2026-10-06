// 目录快照、分类、预算与不可变性测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, resolveByName, resolveByToolId, recomputeIdentity, hasNameConflict } from '../../domain/catalog.mjs';
import { classifyBinding, buildCategoryCards, nameSegments } from '../../domain/categories.mjs';
import { DomainError } from '../../domain/errors.mjs';
import { CATEGORY_CONFIG, sampleBindings, binding, fakeClock } from './helpers.mjs';

const now = () => 1_700_000_000_000;
const snap = (bindings) => buildCatalog(bindings, { now: now(), generation: 'g1' });

test('schemaDigest 只覆盖有效 wire 字段,键序不影响', () => {
  const a = snap([binding({ name: 'alpha', toolId: 't_a', params: { type: 'object', properties: { x: { type: 'string' } } } })]);
  const b = snap([binding({ name: 'alpha', toolId: 't_a', params: { properties: { x: { type: 'string' } }, type: 'object' } })]);
  assert.equal(
    resolveByToolId(a, 't_a').schemaDigest,
    resolveByToolId(b, 't_a').schemaDigest,
    'wire 键序变化不应改变 digest',
  );
});

test('参数数组顺序变化必须改变 digest(schema 不被规范化吞掉)', () => {
  const a = snap([binding({ name: 'alpha', toolId: 't_a', params: { required: ['x', 'y'] } })]);
  const b = snap([binding({ name: 'alpha', toolId: 't_a', params: { required: ['y', 'x'] } })]);
  assert.notEqual(resolveByToolId(a, 't_a').schemaDigest, resolveByToolId(b, 't_a').schemaDigest);
});

test('revision 同时覆盖 schemaDigest / skillRevision / bindingGeneration', () => {
  const base = snap([binding({ name: 'alpha', toolId: 't_a' })]);
  const e0 = resolveByToolId(base, 't_a');
  const skillChanged = snap([binding({ name: 'alpha', toolId: 't_a', skillRevision: 's2' })]);
  const genChanged = snap([binding({ name: 'alpha', toolId: 't_a', generation: 'gen2' })]);
  assert.notEqual(e0.revision, resolveByToolId(skillChanged, 't_a').revision, '技能版本应进入 revision');
  assert.notEqual(e0.revision, resolveByToolId(genChanged, 't_a').revision, '绑定代次应进入 revision');
  assert.ok(recomputeIdentity(e0).matches);
});

test('description 是有效 wire 字段:变化必须改变 schemaDigest 与 searchDocumentId', () => {
  const a = snap([binding({ name: 'alpha', toolId: 't_a', description: 'A' })]);
  const b = snap([binding({ name: 'alpha', toolId: 't_a', description: 'B very different' })]);
  assert.notEqual(resolveByToolId(a, 't_a').schemaDigest, resolveByToolId(b, 't_a').schemaDigest);
  assert.notEqual(resolveByToolId(a, 't_a').searchDocumentId, resolveByToolId(b, 't_a').searchDocumentId);
});

test('非 wire 字段(技能正文)不进入 schemaDigest,只进入 revision/searchDocumentId', () => {
  const a = snap([binding({ name: 'alpha', toolId: 't_a', skill: { skillRevision: 's1', usage: 'u1', limitations: ['l1'] } })]);
  const b = snap([binding({ name: 'alpha', toolId: 't_a', skill: { skillRevision: 's1', usage: 'totally different guidance', limitations: ['z'] } })]);
  assert.equal(resolveByToolId(a, 't_a').schemaDigest, resolveByToolId(b, 't_a').schemaDigest, 'schemaDigest 只覆盖有效 wire 字段');
  assert.equal(resolveByToolId(a, 't_a').revision, resolveByToolId(b, 't_a').revision, '同 skillRevision 则 revision 不变');
  assert.notEqual(resolveByToolId(a, 't_a').searchDocumentId, resolveByToolId(b, 't_a').searchDocumentId);
});

test('快照不可变:条目、wire 与 Map 内容都被冻结', () => {
  const s = snap(sampleBindings());
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.entries));
  const e = resolveByToolId(s, 't_files_glob');
  assert.ok(Object.isFrozen(e), 'Map 内的条目对象也必须被冻结');
  assert.throws(() => { e.name = 'mutated'; }, TypeError);
  assert.throws(() => { e.wire.parameters = {}; }, TypeError);
  // 冻结容器不可 set
  assert.throws(() => s.entries.set('x', e), TypeError);
  assert.throws(() => s.entries.delete('t_files_glob'), TypeError);
});

test('名称与 ID 绝不截断', () => {
  const longName = 'a'.repeat(500);
  const s = snap([binding({ name: longName, toolId: `t_${longName}` })]);
  assert.equal(resolveByToolId(s, `t_${longName}`).name.length, 500);
});

test('绑定形状非法时拒绝而不是静默修正', () => {
  assert.throws(() => snap([{ toolId: 't', name: 'x' }]), DomainError); // 缺 description/wire
  assert.throws(() => snap([binding({ name: 'x', toolId: 't' }).clone ? binding({ name: 'x', toolId: 't' }) : null]), DomainError);
  const dup = [binding({ name: 'x', toolId: 't_same' }), binding({ name: 'y', toolId: 't_same' })];
  assert.throws(() => snap(dup), (e) => e.code === 'INCOMPATIBLE_COMPOSITION');
});

test('wire.name 与绑定名称不一致时拒绝', () => {
  const b = binding({ name: 'alpha', toolId: 't_a' });
  b.wire.name = 'beta';
  assert.throws(() => snap([b]), DomainError);
});

test('同名多绑定:不猜,交由调用方按 toolId 消歧', () => {
  const s = snap([
    binding({ name: 'dup', toolId: 't_dup_a' }),
    binding({ name: 'dup', toolId: 't_dup_b' }),
  ]);
  assert.equal(s.byName.get('dup').length, 2);
  assert.throws(() => resolveByName(s, 'dup'), (e) => e.code === 'TOOL_UNAVAILABLE');
  assert.equal(resolveByToolId(s, 't_dup_b').name, 'dup');
});

test('未知名称解析为 null(统一 TOOL_UNAVAILABLE 语义)', () => {
  const s = snap(sampleBindings());
  assert.equal(resolveByName(s, 'does_not_exist'), null);
  assert.equal(resolveByToolId(s, 'nope'), null);
});

test('分类:可信 override 优先,再 namespace,再结构性规则,最后 other', () => {
  assert.deepEqual(
    classifyBinding(binding({ name: 'mystery', toolId: 't1', override: 'web' })),
    ['web'],
  );
  assert.deepEqual(classifyBinding(binding({ name: 'x', toolId: 't', namespace: 'github' })), ['github']);
  assert.deepEqual(classifyBinding(binding({ name: 'glob', toolId: 't' })), ['files']);
  assert.deepEqual(classifyBinding(binding({ name: 'totally_unrelated', toolId: 't' })), ['other']);
});

test('分类支持多类别数组', () => {
  const cats = classifyBinding(binding({ name: 'github_glob_helper', toolId: 't' }));
  assert.ok(cats.includes('github'));
  assert.ok(cats.includes('files'));
  assert.ok(Array.isArray(cats));
});

test('分类不读 description(不可信文本不驱动控制配置)', () => {
  const evil = binding({ name: 'totally_unrelated', toolId: 't', description: 'files shell web browser github documents data agents images integrations' });
  assert.deepEqual(classifyBinding(evil), ['other'], '描述中的注入文本不得改变分类');
});

test('nameSegments 处理驼峰与分隔符', () => {
  assert.deepEqual(nameSegments('github_list_pullRequests'), ['github', 'list', 'pull', 'requests']);
  assert.deepEqual(nameSegments('a.b-c'), ['a', 'b', 'c']);
});

test('类别卡片有界:只含可信配置声明且有候选的类别', () => {
  const s = snap(sampleBindings());
  const cards = buildCategoryCards(s, CATEGORY_CONFIG, { limit: 12 });
  assert.ok(cards.length > 0 && cards.length <= 12);
  for (const c of cards) {
    assert.ok(CATEGORY_CONFIG[c.id], '未在可信配置声明的类别不得出现');
    assert.ok(c.eligibleCount > 0);
    assert.ok(Array.from(c.capabilitySummary).length <= 96);
  }
  // 未在可信配置里声明的类别不展示
  const partial = buildCategoryCards(s, { files: CATEGORY_CONFIG.files }, { limit: 12 });
  assert.equal(partial.length, 1);
});

test('同名定义冲突可被检测', () => {
  const same = snap([binding({ name: 'd', toolId: 'a' }), binding({ name: 'd', toolId: 'b' })]);
  assert.equal(hasNameConflict(same, 'd'), false, 'wire 相同不算冲突');
  const diff = snap([
    binding({ name: 'd', toolId: 'a', params: { required: ['x'] } }),
    binding({ name: 'd', toolId: 'b', params: { required: ['y'] } }),
  ]);
  assert.equal(hasNameConflict(diff, 'd'), true);
});

test('buildCatalog 使用传入的 now/generation', () => {
  const c = fakeClock(123);
  const s = buildCatalog(sampleBindings(), { now: c.now(), generation: 'gX' });
  assert.equal(s.generation, 'gX');
  assert.equal(s.builtAt, 123);
});
