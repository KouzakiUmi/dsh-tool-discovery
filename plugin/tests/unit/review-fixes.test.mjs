// functions-approach-review 的回归测试：#1 reset 只清本会话 pending、#2 guard 文案遵循 locale、
// #3 预算字节单一口径、#4 generation 不依赖墙钟、#5 ref / cursor 在 issue 时清扫过期项。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, fakeClock, fakeRandom, SCOPE_A, SCOPE_B, nextOpId, commitLoad, sampleBindings } from './helpers.mjs';
import { createRefStore } from '../../domain/candidate-refs.mjs';
import { createCursorStore } from '../../domain/list.mjs';
import { canonicalJson, utf8Bytes } from '../../domain/index.mjs';
import { createText } from '../../domain/locale.mjs';

test('R01 resetCacheEpoch 只丢弃本会话的未决 load，其它会话的 pending 保留', async () => {
  const { engine } = await makeEngine();
  const opA = nextOpId();
  const opB = nextOpId();
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: opA })).response.ok, true);
  assert.equal((await engine.handleLoad({ names: ['grep'] }, SCOPE_B, { operationId: opB })).response.ok, true);
  assert.equal(engine.getPendingSize(), 2);

  const before = engine.getState(SCOPE_A).epoch;
  const out = engine.resetCacheEpoch(SCOPE_A, 'compaction-end');

  assert.equal(out.epoch, before + 1);
  assert.equal(engine.getState(SCOPE_A).epoch, before + 1, '返回值与存入状态是同一个 epoch');
  assert.equal(engine.getPendingSize(), 1, '只剩 B 的未决 load');
  assert.equal(engine.cancelOperation(opA), false, 'A 的 pending 已被清掉');
  assert.equal(engine.cancelOperation(opB), true, 'B 的 pending 仍在');
});

test('R02 engine.evaluateCall 的拒绝文案遵循 config.locale', async () => {
  const call = { name: 'glob', requestId: 'req_1' };
  const zh = await makeEngine({ engineConfig: { locale: 'zh' } });
  const en = await makeEngine({ engineConfig: { locale: 'en' } });
  const zhRes = zh.engine.evaluateCall(SCOPE_A, call);
  const enRes = en.engine.evaluateCall(SCOPE_A, call);
  assert.equal(zhRes.allowed, false);
  assert.equal(zhRes.reason, createText('zh').t(['error', 'TOOL_NOT_LOADED']));
  assert.equal(enRes.reason, createText('en').t(['error', 'TOOL_NOT_LOADED']));
  assert.notEqual(zhRes.reason, enRes.reason);
});

test('R03 catalog 条目的 wireBytes 与冻结 wire 的 bytes 使用同一口径（canonical）', async () => {
  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_files_glob');
  assert.equal(entry.wireBytes, utf8Bytes(canonicalJson(entry.wire)));

  // 对象里值为 undefined 的键：JSON.stringify 与 canonical 都忽略，但 canonical 是冻结时的口径，
  // 这里用含 CJK 的 wire 确认字节数按 UTF-8 而非字符数核算
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
      // 现在是快路径(身份指纹相同就不升代次),连刷同一份绑定不再产生新 generation。
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
  const loadOp = nextOpId();
  const loadRes = await engine.handleLoad({ candidates: [{ ref: cand.ref }] }, SCOPE_A, { operationId: loadOp });
  assert.equal(loadRes.response.ok, true, JSON.stringify(loadRes.response.error));
  assert.equal(loadRes.response.data.receipt.selected[0].name, cand.name);
  assert.equal(loadRes.response.data.receipt.selected[0].revision, cand.revision);

  // 2) 若显式传错 revision，仍然严格拒绝 STALE_CANDIDATE
  const badOp = nextOpId();
  const badRes = await engine.handleLoad({ candidates: [{ ref: cand.ref, revision: 'r_wrong' }] }, SCOPE_A, { operationId: badOp });
  assert.equal(badRes.response.ok, false);
  assert.equal(badRes.response.error.code, 'STALE_CANDIDATE');
});

test('R10 优化点B: 重复 load 已激活且同版本的工具不重复回灌 skills，节省上下文 token', async () => {
  const { engine } = await makeEngine();
  // 首次加载 glob 并提交折叠
  const load1 = await commitLoad(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(load1.response.ok, true);
  assert.equal(load1.applied, true);
  assert.equal(load1.response.data.skills.length, 1, '首次加载返回使用指南');

  // 再次重复加载 glob
  const op2 = nextOpId();
  const res2 = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op2 });
  assert.equal(res2.response.ok, true);
  assert.equal(res2.response.data.skills.length, 0, '已处于 selected 的同版本工具不再重复灌入 skills');

  // 混合批量加载：已有的 glob + 新的 grep
  const op3 = nextOpId();
  const res3 = await engine.handleLoad({ names: ['glob', 'grep'] }, SCOPE_A, { operationId: op3 });
  assert.equal(res3.response.ok, true);
  assert.equal(res3.response.data.skills.length, 1, '只为新加入的 grep 返回 skills，glob 不重复回灌');
  assert.equal(res3.response.data.skills[0].toolId, 't_files_grep');
});

test('R11 重构与状态纯度: setSessionMode 纯函数不可变、mintOpaqueId 格式正确、isListView 无冗余包装', async () => {
  const { createState, setSessionMode } = await import('../../domain/state.mjs');
  const { mintOpaqueId } = await import('../../domain/util.mjs');
  const { isListView } = await import('../../domain/list.mjs');

  // 状态不可变
  const s1 = createState('test_sess');
  assert.equal(s1.mode, 'restoring');
  const s2 = setSessionMode(s1, 'ready');
  assert.equal(s1.mode, 'restoring', '原 state 未被修改');
  assert.equal(s2.mode, 'ready', '新 state 获得新 mode');
  assert.notEqual(s1, s2);

  // 相同 mode 幂等返回原对象引用
  const s3 = setSessionMode(s2, 'ready');
  assert.equal(s2, s3);

  // mintOpaqueId
  const rand = fakeRandom();
  const id = mintOpaqueId(rand, 'test_');
  assert.ok(id.startsWith('test_'));
  assert.equal(id.length, 5 + 32);

  // isListView
  assert.equal(isListView('available'), true);
  assert.equal(isListView('loaded'), true);
  assert.equal(isListView('categories'), true);
  assert.equal(isListView('state'), true);
  assert.equal(isListView('unknown'), false);
  assert.equal(isListView(null), false);
  assert.equal(isListView({}), false);
});

test('R12 审查报告#8: recomputeSelectionIdentity 复用 recomputeIdentity，无双重维护 drift', async () => {
  const { recomputeSelectionIdentity } = await import('../../domain/state.mjs');
  const { recomputeIdentity } = await import('../../domain/catalog.mjs');

  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_files_glob');
  assert.ok(entry);

  const direct = recomputeIdentity(entry);
  const claimed = {
    toolId: entry.toolId,
    name: entry.name,
    revision: entry.revision,
    schemaDigest: entry.schemaDigest,
    skillRevision: entry.skillRevision,
  };
  const selection = recomputeSelectionIdentity(entry, claimed);

  assert.equal(selection.ok, true);
  assert.equal(selection.computed.revision, direct.revision);
  assert.equal(selection.computed.schemaDigest, direct.schemaDigest);
});
