// 第三轮独立审查修复的回归门禁（纯 domain + 适配层边界，不需要宿主 SDK）。
//
// 覆盖四项：
//   1. category 的"纯空白不算给出值"口径（此前是唯一漏网的字段）；
//   2. search 词干后门：s/es/ies 剥离结果落在停用词表上必须拒绝；
//   3. registry 对畸形绑定的隔离（否则一个坏定义毒化整张目录）；
//   4. validateConfig 解包 volatile 引用（新增 volatile 字段时漏解包会拒绝激活）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateListRequest, validateSearchRequest } from '../../domain/protocol.mjs';
import { tokenize } from '../../domain/search.mjs';
import { createRegistryAdapter } from '../../adapters/dsh/registry.mjs';
import { validateConfig } from '../../adapters/dsh/index.mjs';

test('R3-1 category 纯空白与空串同义：list/search 都在协议层拒绝', () => {
  // 此前 `{category:'   '}` 能过校验，到下游 resolveCategory 才报 CATEGORY_UNAVAILABLE，
  // 把"字段畸形"说成"类别不存在"，recovery 还把模型引去列类别。
  for (const category of ['', '   ', '\t']) {
    assert.throws(() => validateListRequest({ view: 'available', category }), /category/i,
      `list category=${JSON.stringify(category)} 必须被拒`);
    assert.throws(() => validateSearchRequest({ category, query: 'read' }), /category/i,
      `search category=${JSON.stringify(category)} 必须被拒`);
  }
  // 合法类别与非字符串类型错误保持原判据。
  assert.equal(validateListRequest({ view: 'available', category: 'files' }).category, 'files');
  assert.throws(() => validateListRequest({ view: 'available', category: 42 }), /must be a string/i);
  // 对照：同批其它字段本来就是同一口径。
  assert.throws(() => validateSearchRequest({ category: 'files', query: '   ' }), /query is required/i);
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', cursor: '   ' }), /empty string/i);
});

test('R3-2 词干剥离结果落在停用词表上必须拒绝（s/es/ies 不得绕过守卫）', () => {
  // 此前只有 ing/ed 分支（pushWithUnwrap）有守卫，s/es/ies 直通：
  // tokenize('notes') 会产出停用词 'not'，于是含 " not " 的文档被召回。
  const notes = tokenize('notes');
  assert.equal(notes.includes('not'), false, "'notes' 不得产出停用词 'not'");
  assert.ok(notes.includes('note'), '正常词干仍应保留');

  // 正常词干仍要保留：'files' → ['files','fil','file']（都不是停用词）。
  // 注意 'others' → 'other' 里的 'other' 本身就是停用词，被拒是正确的。
  assert.deepEqual(tokenize('files'), ['files', 'fil', 'file'], '非停用词的剥离结果不受影响');

  // 对照：ing 路径的守卫本来就生效。
  assert.equal(tokenize('inning').includes('in'), false);
});

test('R3-3 registry 跳过畸形绑定，不让一个坏定义毒化整张目录', () => {
  const good = { name: 'good_tool', description: 'ok', parameters: { type: 'object' } };
  const bad = { name: 'bad_tool', description: 'broken', parameters: [] };
  const ctx = {
    tools: {
      view: () => ({ visible: new Map([['good_tool', good], ['bad_tool', bad]]), restrictableNames: new Set(['good_tool', 'bad_tool']) }),
    },
  };
  const logs = [];
  const registry = createRegistryAdapter({ ctx, log: (event, payload) => logs.push([event, payload]) });
  const view = registry.bindingsFor(undefined, ctx.tools.view());
  const names = view.bindings.map(b => b.name);
  assert.deepEqual(names, ['good_tool'], '坏绑定必须被跳过，好绑定仍进入目录');
  assert.equal(logs.filter(([e]) => e === 'registry:invalid-binding-skipped').length, 1, '跳过应记一次日志');

  // 再取一次：同名只报告一次，不随每次 tools/change 刷屏。
  registry.bindingsFor(undefined, ctx.tools.view());
  assert.equal(logs.filter(([e]) => e === 'registry:invalid-binding-skipped').length, 1, '同类重复出现不得重复记日志');
});

test('R3-4 validateConfig 解包 volatile 引用，且不因空白条目拒绝激活', () => {
  // 宿主会先按 schema 解析再交给 apply：volatile 字段在这里是 {get()} 引用。
  const ref = (value) => ({ get: () => value });
  const out = validateConfig({
    initialToolsEnabled: ref(false),
    gateOwnScopeTools: ref(false),
    disabledPresets: ref(['minimal']),
    tolerantLoadProtected: ref(false),
    respectAlwaysVisible: ref(true),
    budgets: ref({ maxActiveTools: 3 }),
    locale: ref('zh'),
    categoryConfig: ref({ files: { title: 'F', capabilitySummary: 'S' } }),
  });
  assert.equal(out.initialToolsEnabled, false);
  assert.equal(out.gateOwnScopeTools, false);
  assert.equal(out.tolerantLoadProtected, false);
  assert.equal(out.respectAlwaysVisible, true);
  assert.equal(out.locale, 'zh');
  assert.deepEqual(out.budgets, { maxActiveTools: 3 }, 'budgets 必须解包成普通对象，否则会被当成含 get 键的预算');
  assert.deepEqual([...out.disabledPresets], ['minimal']);
  assert.equal(out.categoryConfig.files.title, 'F', 'categoryConfig 必须解包，否则 Object.keys 会读到 get');

  // 空白条目：热改路径本来就接受并归一，激活期必须同判据，否则会出现
  // "热改写入成功、下次重载拒绝激活"，插件再也起不来。
  assert.deepEqual([...validateConfig({ disabledPresets: ['minimal', '   '] }).disabledPresets], ['minimal']);
  // 形状错误仍拒绝。
  assert.throws(() => validateConfig({ disabledPresets: ['minimal', 1] }), /disabledPresets/);
});
