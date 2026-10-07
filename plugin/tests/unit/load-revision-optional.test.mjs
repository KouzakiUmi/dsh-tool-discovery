// load 候选的 revision 可选化:ref 是版本权威,revision 只是"把它回写一遍"。
// 模型对可选字段的常见写法是省略或填空值,这些都必须等同于"未给出";
// 真正类型不对的写法仍然拒绝;重复 ref 的冲突判据不得被削弱。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLoadRequest } from '../../domain/protocol.mjs';
import { resolveBudgets } from '../../domain/budgets.mjs';
import { makeEngine, SCOPE_A, nextOpId, sampleBindings } from './helpers.mjs';

const B = resolveBudgets({});

const searchGlob = (engine) => engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
const loadWith = (engine, candidates) => engine.handleLoad({ candidates }, SCOPE_A, { operationId: nextOpId() });

test('LR1 仅凭 ref 的候选加载成功,选中的是 ref 绑定的那个版本', async () => {
  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  const res = await loadWith(engine, [{ ref: c.ref }]);
  assert.equal(res.response.ok, true, JSON.stringify(res.response.error));
  assert.equal(res.response.data.receipt.selectionSource, 'candidate');
  assert.equal(res.response.data.receipt.selected[0].revision, c.revision);
});

test('LR2 ref + revision(显式回写同一版本)仍然成功', async () => {
  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  const res = await loadWith(engine, [{ ref: c.ref, revision: c.revision }]);
  assert.equal(res.response.ok, true, JSON.stringify(res.response.error));
  assert.equal(res.response.data.receipt.selected[0].revision, c.revision);
});

test('LR3 revision 为空串或 null 时按"未给出"处理(协议层不留键,engine 取 ref 绑定版本)', async () => {
  // 规范化请求里不得留下 revision 键,否则 engine 的 `??` 会被 '' 抢先。
  assert.deepEqual(validateLoadRequest({ candidates: [{ ref: 'c1' }] }, B).candidates, [{ ref: 'c1' }]);
  assert.deepEqual(validateLoadRequest({ candidates: [{ ref: 'c1', revision: '' }] }, B).candidates, [{ ref: 'c1' }]);
  assert.deepEqual(validateLoadRequest({ candidates: [{ ref: 'c1', revision: null }] }, B).candidates, [{ ref: 'c1' }]);

  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  for (const revision of ['', null]) {
    const res = await loadWith(engine, [{ ref: c.ref, revision }]);
    assert.equal(res.response.ok, true, `revision=${JSON.stringify(revision)} → ${JSON.stringify(res.response.error)}`);
    assert.equal(res.response.data.receipt.selected[0].revision, c.revision, '不得回退到空串/null 当版本');
  }
});

test('LR4 revision 类型真的不对时仍然是参数错误', () => {
  for (const revision of [7, 0, true, false, {}, [], ['r1'], () => 'r1']) {
    assert.throws(
      () => validateLoadRequest({ candidates: [{ ref: 'c1', revision }] }, B),
      (e) => e.code === 'INVALID_ARGS',
      `revision=${String(revision)} 不得被当作"未给出"`,
    );
  }
});

test('LR5 同 ref 不同 revision 仍是冲突参数错误(不得因可选而削弱)', () => {
  assert.throws(
    () => validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }, { ref: 'c1', revision: 'r2' }] }, B),
    (e) => e.code === 'INVALID_ARGS',
  );
});

test('LR6 同 ref 且其中一个 revision 为空值时放行(空值不参与冲突比较)', () => {
  const out = validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }, { ref: 'c1', revision: '' }] }, B);
  assert.deepEqual(out.candidates, [{ ref: 'c1', revision: 'r1' }, { ref: 'c1' }]);
  const rev = validateLoadRequest({ candidates: [{ ref: 'c1', revision: null }, { ref: 'c1', revision: 'r2' }] }, B);
  assert.deepEqual(rev.candidates, [{ ref: 'c1' }, { ref: 'c1', revision: 'r2' }]);
});

test('LR7 同 ref 两项(其一 revision 为空)的候选加载成功且只选中一次', async () => {
  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  const res = await loadWith(engine, [{ ref: c.ref, revision: c.revision }, { ref: c.ref }]);
  assert.equal(res.response.ok, true, JSON.stringify(res.response.error));
  assert.equal(res.response.data.receipt.selected.length, 1, '同一 ref 不得重复选中');
});

test('LR8 ref 签发后工具定义变化:旧 ref 加载仍被拒,不静默升级到新定义', async () => {
  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  const oldRevision = c.revision;
  // 只改 glob 的 wire → 该条目的 revision 随之变化
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } } }
    : b));
  engine.refreshCatalog(changed);

  for (const candidates of [[{ ref: c.ref }], [{ ref: c.ref, revision: oldRevision }]]) {
    const res = await loadWith(engine, candidates);
    assert.equal(res.response.ok, false, '陈旧 ref 不得加载');
    assert.equal(
      res.response.error.code,
      'CANDIDATE_UNAVAILABLE',
      '目录刷新升资格代次,代次作废先于 revision 比对命中(两者都是拒)',
    );
    assert.equal(engine.getState(SCOPE_A).selected.size, 0, '不得半批激活');
  }

  // 重新检索后的新 ref 加载的是新定义 —— 旧的失效不能变成永久不可加载
  const fresh = searchGlob(engine);
  assert.notEqual(fresh.revision, oldRevision);
  const okRes = await loadWith(engine, [{ ref: fresh.ref }]);
  assert.equal(okRes.response.ok, true, JSON.stringify(okRes.response.error));
  assert.equal(okRes.response.data.receipt.selected[0].revision, fresh.revision);
});

test('LR9 ref 仍有效但回写的版本与 ref 绑定的不一致 → STALE_CANDIDATE', async () => {
  const { engine } = await makeEngine();
  const c = searchGlob(engine);
  // 显式给出版本与 ref 绑定版本不符:ref 才是权威,必须拒而不是采用调用方的版本
  const res = await loadWith(engine, [{ ref: c.ref, revision: 'r_not_the_bound_one' }]);
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'STALE_CANDIDATE');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});