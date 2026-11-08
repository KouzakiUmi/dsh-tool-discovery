// functions-approach-review 的回归测试（rc.1 重设计后仍有效的部分）：
// 预算字节单一口径、generation 不依赖墙钟、ref / cursor 在 issue 时清扫过期项、
// 同义词词边界、配置错误本地化、ref-only load、skills 去重、destroySession 资源回收。
//
// 已删除用例（对应子系统已不存在，产品目标由新语义覆盖）：
//   * R01 resetCacheEpoch 清理 pending —— 无 pending/epoch；会话隔离由 load/unload 测试覆盖。
//   * R02 engine.evaluateCall 文案随 locale —— evaluateCall 已删；执行拒绝统一由
//     adapters/dsh/guard.mjs 产生（固定英文一句话），见 design-invariants.test.mjs。
//   * R12 recomputeSelectionIdentity 复用 —— canonical 身份重算已删；resume 以
//     name+schemaDigest 对齐，见 state.test.mjs 的 seedSelection 用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEngine, fakeClock, fakeRandom, SCOPE_A, SCOPE_B, loadTools, sampleBindings,
} from './helpers.mjs';
import { createRefStore } from '../../domain/candidate-refs.mjs';
import { createCursorStore } from '../../domain/list.mjs';
import { canonicalJson, utf8Bytes } from '../../domain/index.mjs';
import { createState } from '../../domain/state.mjs';

test('R01 tool_unload 只影响本会话：另一个会话的同名选择保持有效', async () => {
  const { engine } = await makeEngine();
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  assert.equal((await loadTools(engine, SCOPE_B, { names: ['glob'] })).response.ok, true);
  assert.equal((await engine.handleUnload({ names: ['glob'] }, SCOPE_A)).response.ok, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(engine.getState(SCOPE_B).selected.size, 1, '别的会话不被卸载');
});

test('R03 catalog 条目的 wireBytes 与冻结 wire 的 bytes 使用同一口径（canonical）', async () => {
  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_files_glob');
  assert.equal(entry.wireBytes, utf8Bytes(canonicalJson(entry.wire)));

  // 对象里值为 undefined 的键：JSON.stringify 与 canonical 都忽略，含 CJK 的 wire
  // 确认字节数按 UTF-8 而非字符数核算。
  const wire = { name: 'x', description: '查找文件', parameters: {}, extra: undefined };
  assert.equal(utf8Bytes(canonicalJson(wire)), utf8Bytes('{"description":"查找文件","name":"x","parameters":{}}'));
});

test('R04 refreshCatalog 的 generation 确定且逐次不同，不读墙钟', async () => {
  const gens = [];
  for (let run = 0; run < 2; run += 1) {
    const { engine } = await makeEngine({ clock: fakeClock(123) });
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      // 每轮换一份**真的不同**的绑定(改 wire)→ 走重建路径。内容一致的 refresh
      // 是快路径(身份指纹相同就不升代次)。
      engine.refreshCatalog(sampleBindings().map((b) => (b.toolId === 't_files_glob'
        ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: [`round_${i}`] } } }
        : b)));
      seen.push(engine.getCatalog().generation);
    }
    assert.equal(new Set(seen).size, 3, '冻结时钟下连刷也必须产生不同 generation');
    gens.push(seen);
  }
  assert.deepEqual(gens[0], gens[1], '两次独立运行结果一致（可复现）');
});

test('R05 candidate ref 在 issue 时清扫已过期条目', () => {
  const clock = fakeClock();
  const store = createRefStore({ clock, random: fakeRandom(), ttlMs: 1000 });
  store.issue('s', 1, 't1', 'r1');
  store.issue('s', 1, 't2', 'r2');
  assert.equal(store.size(), 2);
  clock.advance(1000);
  store.issue('s', 1, 't3', 'r3');
  assert.equal(store.size(), 1, '两个过期 ref 被清扫，只剩新签发的');
});

test('R06 list cursor 在 issue 时清扫已过期条目', () => {
  const clock = fakeClock();
  const store = createCursorStore({ clock, random: fakeRandom(), ttlMs: 1000 });
  const rec = { sessionId: 's', view: 'names', category: 'all', eligibilityGeneration: 1, offset: 0, orderDigest: 'd' };
  store.issue(rec);
  store.issue(rec);
  assert.equal(store.size(), 2);
  clock.advance(1000);
  store.issue(rec);
  assert.equal(store.size(), 1);
});

test('R07 同义词按词边界匹配，不再被拉丁子串误触发', async () => {
  const { synonymConcepts } = await import('../../domain/search.mjs');
  const has = (text, concept) => synonymConcepts(text).has(concept);
  // 误命中：'edit'⊂credit, 'cli'⊂click/client, 'word'⊂keyword, 'unit'⊂community, 'prs'⊂express
  assert.equal(has('check my credit score', 'modify-file'), false);
  assert.equal(has('click the submit button', 'run-command'), false);
  assert.equal(has('connect the client', 'run-command'), false);
  assert.equal(has('keyword frequency', 'office-docs'), false);
  assert.equal(has('community forum', 'data-query'), false);
  assert.equal(has('express server', 'github-api'), false);
  // 正命中：整词、屈折形式、多词短语、驼峰/下划线、CJK 子串
  assert.equal(has('edit the config', 'modify-file'), true);
  assert.equal(has('editing files', 'modify-file'), true);
  assert.equal(has('click the submit button', 'browser-control'), true);
  assert.equal(has('use the CLI', 'run-command'), true);
  assert.equal(has('web_search', 'web-search'), true, '下划线分隔的工具名等价于空格短语');
  assert.equal(has('generate_image', 'generate-image'), true);
  assert.equal(has('desktopControl on the desktop', 'desktop-control'), true);
  assert.equal(has('帮我修改文件', 'modify-file'), true);
});

test('R08 配置类 DomainError 文案随激活语言，不再硬编码中文', async () => {
  const { resolveBudgets } = await import('../../domain/budgets.mjs');
  const { setDomainLocale } = await import('../../domain/locale.mjs');
  try {
    setDomainLocale('en');
    assert.throws(() => resolveBudgets({ nope: 1 }), (e) => e.message === 'Unknown budget key: nope');
    assert.throws(() => resolveBudgets({ defaultListLimit: 0 }), (e) => e.message === 'Budget key defaultListLimit must be a positive integer.');
    setDomainLocale('zh');
    assert.throws(() => resolveBudgets({ nope: 1 }), (e) => e.message === '未知预算项: nope');
  } finally {
    setDomainLocale('en');
  }
});

test('R09 优化点A: tool_load candidates 支持省略 revision，仅凭 ref 即可正确加载', async () => {
  const { engine } = await makeEngine();
  const searchRes = engine.handleSearch({ category: 'all', query: 'find files' }, SCOPE_A);
  assert.equal(searchRes.ok, true);
  const cand = searchRes.data.candidates[0];
  assert.ok(cand && cand.ref);

  // 1) 仅传 ref，省略 revision
  const loadRes = await loadTools(engine, SCOPE_A, { candidates: [{ ref: cand.ref }] });
  assert.equal(loadRes.response.ok, true, JSON.stringify(loadRes.response.error));
  assert.deepEqual(loadRes.response.data.loaded, [cand.name]);
  assert.equal(engine.getState(SCOPE_A).selected.get(cand.toolId).revision, cand.revision);

  // 2) 若显式传错 revision，仍然严格拒绝 STALE_CANDIDATE
  const badRes = await loadTools(engine, SCOPE_A, { candidates: [{ ref: cand.ref, revision: 'r_wrong' }] });
  assert.equal(badRes.response.ok, false);
  assert.equal(badRes.response.error.code, 'STALE_CANDIDATE');
});

test('R10 优化点B: 重复 load 已激活且同版本的工具不重复回灌 skills，节省上下文 token', async () => {
  const { engine } = await makeEngine();
  const load1 = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(load1.response.ok, true);
  assert.equal(load1.response.data.skills.length, 1, '首次加载返回使用指南');

  const res2 = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(res2.response.ok, true);
  assert.equal(res2.response.data.skills.length, 0, '已处于 selected 的同版本工具不再重复灌入 skills');

  // 混合批量加载：已有的 glob + 新的 grep
  const res3 = await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  assert.equal(res3.response.ok, true);
  assert.equal(res3.response.data.skills.length, 1, '只为新加入的 grep 返回 skills，glob 不重复回灌');
  assert.equal(res3.response.data.skills[0].toolId, 't_files_grep');
});

test('R11 状态纯函数与工具函数：createState ready、mintOpaqueId 格式、isListView 判据', async () => {
  const { mintOpaqueId } = await import('../../domain/util.mjs');
  const { isListView } = await import('../../domain/list.mjs');

  const s1 = createState('test_sess');
  assert.equal(s1.mode, 'ready', '会话创建即 ready，没有 restoring/incompatible 终态');
  assert.ok(s1.selected instanceof Map);

  const rand = fakeRandom();
  const id = mintOpaqueId(rand, 'test_');
  assert.ok(id.startsWith('test_'));
  assert.equal(id.length, 5 + 32);

  assert.equal(isListView('available'), true);
  assert.equal(isListView('loaded'), true);
  assert.equal(isListView('categories'), true);
  assert.equal(isListView('state'), true);
  assert.equal(isListView('unknown'), false);
  assert.equal(isListView(null), false);
  assert.equal(isListView({}), false);
});

test('R13 destroySession 回收本会话的 ref 与 cursor（不留残留，也不误杀别的会话）', async () => {
  const { engine } = await makeEngine();
  const refA = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0].ref;
  const pageA = engine.handleList({ view: 'available', category: 'all', limit: 1 }, SCOPE_A);
  assert.equal(typeof pageA.data.nextCursor, 'string', '前置：必须有第二页才能拿到游标');
  // 正控制：另一个会话的条目必须原样活着。
  const refB = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_B).data.candidates[0].ref;
  const pageB = engine.handleList({ view: 'available', category: 'all', limit: 1 }, SCOPE_B);
  assert.equal(typeof pageB.data.nextCursor, 'string');

  engine.destroySession(SCOPE_A.sessionId);

  const load = await loadTools(engine, SCOPE_A, { candidates: [{ ref: refA }] });
  assert.equal(load.response.ok, false, '销毁后旧 ref 不得继续可用');
  assert.equal(load.response.error.code, 'CANDIDATE_UNAVAILABLE');
  const page2 = engine.handleList({ view: 'available', category: 'all', cursor: pageA.data.nextCursor }, SCOPE_A);
  assert.equal(page2.ok, false, '销毁后旧游标不得继续可用');
  assert.equal(page2.error.code, 'CURSOR_UNAVAILABLE');

  // 正控制：B 的 ref 与游标不受影响。
  assert.equal((await loadTools(engine, SCOPE_B, { candidates: [{ ref: refB }] })).response.ok, true);
  assert.equal(engine.handleList({ view: 'available', category: 'all', cursor: pageB.data.nextCursor }, SCOPE_B).ok, true);
});
