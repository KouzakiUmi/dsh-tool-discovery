// domain review 回归：取消防重放、未决快照隔离与完整类别分页。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, SCOPE_B, nextOpId, pair } from './helpers.mjs';

async function admit(engine, scope = SCOPE_A, names = ['glob']) {
  const operationId = nextOpId();
  const input = { names };
  const outcome = await engine.handleLoad(input, scope, { operationId });
  assert.equal(outcome.response.ok, true, JSON.stringify(outcome.response.error));
  return { outcome, canonical: pair({ seq: 1, operationId, input, payload: outcome.response.data.receipt }) };
}

for (const boundary of ['cancel', 'reset', 'destroy']) {
  test(`取消防重放：${boundary} 超过 256 次后，最早回执在原会话 / 跨 scope 都不得激活`, async () => {
    const { engine } = await makeEngine();
    let oldest;
    for (let i = 0; i < 300; i += 1) {
      const { canonical } = await admit(engine);
      if (i === 0) oldest = canonical;
      if (boundary === 'cancel') assert.equal(engine.cancelOperation(canonical.call.operationId), true);
      else if (boundary === 'reset') engine.resetCacheEpoch(SCOPE_A, 'compaction-end');
      else engine.destroySession(SCOPE_A.sessionId);
    }
    assert.equal(engine.getPendingSize(), 0, '收口后不保留预算预留');
    for (const scope of [SCOPE_A, SCOPE_B]) {
      const out = engine.applyCanonicalPair(oldest, scope);
      assert.deepEqual(out, { applied: false, reason: 'operation-closed' });
      assert.equal(engine.getState(scope).selected.size, 0);
    }
    // 正控制：同一 engine 仍能接纳新的正常提交。
    const { canonical } = await admit(engine);
    assert.equal(engine.applyCanonicalPair(canonical, SCOPE_A).applied, true);
    engine.dispose();
  });
}

test('热态无 pending 不接纳新 seq；成功重复仍走 resultSeq 的 stale-seq，冷恢复独立可用', async () => {
  const { engine } = await makeEngine();
  const { canonical } = await admit(engine);
  canonical.resultSeq = 10;
  assert.equal(engine.applyCanonicalPair(canonical, SCOPE_A).applied, true);
  assert.deepEqual(engine.applyCanonicalPair(canonical, SCOPE_A), { applied: false, reason: 'stale-seq' });
  assert.equal(engine.getState(SCOPE_A).integrity.duplicatesIgnored, 1);
  assert.deepEqual(engine.applyCanonicalPair({ ...canonical, resultSeq: 9 }, SCOPE_A), {
    applied: false, reason: 'stale-seq',
  });
  assert.equal(engine.getState(SCOPE_A).integrity.outOfOrderIgnored, 1);
  assert.equal(engine.applyCanonicalPair(canonical, SCOPE_B).applied, false, '成功回执也不能跨 scope 新激活');
  engine.resetCacheEpoch(SCOPE_A, 'compaction-end');
  assert.equal(engine.applyCanonicalPair({ ...canonical, resultSeq: 11 }, SCOPE_A).applied, false);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);

  const { engine: cold } = await makeEngine({ newSessionMode: 'restoring' });
  assert.equal(cold.applyCanonicalPair(canonical, SCOPE_A).applied, false, '热态入口不是冷回放旁路');
  const restored = cold.restore([canonical], SCOPE_A);
  assert.equal(restored.applied, 1);
  assert.equal(cold.getState(SCOPE_A).selected.size, 1);
  engine.dispose();
  cold.dispose();
});

for (const mutation of ['splice', 'nested']) {
  test(`receipt 原位 ${mutation} 修改不得改写期望、减少预留或部分激活`, async () => {
    const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 2 } } });
    const { outcome, canonical } = await admit(engine, SCOPE_A, ['glob', 'grep']);
    const selected = outcome.response.data.receipt.selected;
    if (mutation === 'splice') selected.splice(1, 1);
    else selected[0].skillRevision = 's_tampered';
    const before = engine.handleList({ view: 'state' }, SCOPE_A);
    assert.equal(before.data.budgets.activeCount, 2, '出站对象修改不能改变预留');
    const blocked = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(blocked.response.error.code, 'BUDGET_EXCEEDED');
    assert.deepEqual(engine.applyCanonicalPair(canonical, SCOPE_A), { applied: false, reason: 'receipt-mismatch' });
    assert.equal(engine.getState(SCOPE_A).selected.size, 0, '整批失败，不得部分激活');
    assert.equal(engine.getPendingSize(), 0, '拒绝回执后释放预留');
    assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 0);
    const next = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(next.response.ok, true);
    engine.dispose();
  });
}

test('outcome.operation 的顶层、input 与期望嵌套修改不能改写内部 pending', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 2 } } });
  const { outcome, canonical } = await admit(engine, SCOPE_A, ['glob', 'grep']);
  const exposed = outcome.operation;
  assert.notStrictEqual(exposed.expectedReceipt, outcome.response.data.receipt);
  exposed.expectedReceipt.selected[0].toolId = 't_forged';
  exposed.expectedReceipt.selected.splice(1, 1);
  exposed.input.names.splice(0);
  exposed.expectedReceipt = { selected: [] };
  exposed.sessionId = SCOPE_B.sessionId;
  exposed.operationId = 'op_forged';
  exposed.action = 'unload';
  exposed.selectionSource = 'candidate';
  exposed.inputCanonical = '{}';
  exposed.eligibilityGeneration = -1;
  assert.deepEqual(canonical.call.input.names, ['glob', 'grep'], '不应共享宿主原始输入');
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 2);
  const blocked = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(blocked.response.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(engine.applyCanonicalPair(canonical, SCOPE_A), { applied: true, reason: undefined });
  assert.equal(engine.getState(SCOPE_A).selected.size, 2, '原回执仍按未变的内部快照完整激活');
  engine.dispose();
});

test('同时改写 operation.expectedReceipt 与出站 receipt 也不能伪造一致的部分回执', async () => {
  const { engine } = await makeEngine();
  const { outcome, canonical } = await admit(engine, SCOPE_A, ['glob', 'grep']);
  outcome.operation.expectedReceipt.selected.splice(1, 1);
  outcome.response.data.receipt.selected.splice(1, 1);
  assert.deepEqual(engine.applyCanonicalPair(canonical, SCOPE_A), { applied: false, reason: 'receipt-mismatch' });
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  engine.dispose();
});

test('maxInitialCategories:1 限制每页而不截断全集，连续翻页无遗漏且末页标记正确', async () => {
  const { engine: baseline } = await makeEngine();
  const expected = baseline.handleList({ view: 'categories', limit: 20 }, SCOPE_A).data.categories;
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxInitialCategories: 1 } } });
  const seen = [];
  let cursor;
  for (let i = 0; i < expected.length; i += 1) {
    const page = engine.handleList({ view: 'categories', limit: 20, ...(cursor ? { cursor } : {}) }, SCOPE_A);
    assert.equal(page.ok, true);
    assert.equal(page.data.categories.length, 1, '显式 limit 也不能扩大类别页预算');
    seen.push(...page.data.categories);
    const more = i < expected.length - 1;
    assert.equal(page.data.truncated, more);
    if (more) assert.equal(typeof page.data.nextCursor, 'string');
    else assert.equal(page.data.nextCursor, null);
    cursor = page.data.nextCursor;
  }
  assert.equal(seen[0].id, 'files');
  assert.ok(seen.some((card) => card.id === 'shell'), 'shell 必须可达');
  assert.deepEqual(seen, expected, '顺序、内容与未截断全集一致，无重复无遗漏');
  assert.equal(new Set(seen.map((card) => card.id)).size, expected.length);
  // 不扩张普通名称分页：类别预算不限制 available 页大小。
  const names = engine.handleList({ view: 'available', category: 'files', limit: 20 }, SCOPE_A);
  assert.ok(names.data.names.length > 1);
  engine.dispose();
  baseline.dispose();
});

test('类别分页仍尊重更小的请求 limit，末页允许不足一页', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxInitialCategories: 6 } } });
  const seen = [];
  let cursor;
  do {
    const page = engine.handleList({ view: 'categories', limit: 5, ...(cursor ? { cursor } : {}) }, SCOPE_A);
    assert.equal(page.ok, true);
    assert.equal(page.data.categories.length, seen.length < 10 ? 5 : 2);
    seen.push(...page.data.categories.map((card) => card.id));
    cursor = page.data.nextCursor;
    assert.equal(page.data.truncated, cursor !== null);
    assert.ok(seen.length <= 12, '分页必须前进，不能无限重复');
  } while (cursor !== null);
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  engine.dispose();
});
