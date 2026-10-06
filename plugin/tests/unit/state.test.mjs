// 状态 reducer、canonical pair 严格核验与 guard 判据测试
// 覆盖 runtime-review F2 的产品补齐点,以及 S08/S09/S10/L01/L03/L05/L07/L11/L12。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../../domain/catalog.mjs';
import {
  createState, reducePair, recordAdvertisement, evaluateCall, invalidateTool,
  recomputeSelectionIdentity, parseReceiptShape, deriveInputPath,
} from '../../domain/state.mjs';
import { makeEngine, SCOPE_A, SCOPE_B, SCOPE_FORK, nextOpId, pair, binding, sampleBindings } from './helpers.mjs';

const catalog = buildCatalog(sampleBindings(), { now: 0, generation: 'g1' });
const entry = (id) => catalog.entries.get(id);
const ctx = () => ({ now: () => 1000, catalog });

function receiptFor(toolId, selectionSource = 'name', operationId = 'op_1', operation = 'load') {
  const e = entry(toolId);
  return {
    kind: 'tool-discovery.selection',
    version: 2,
    operationId,
    operation,
    ...(operation === 'load' ? { selectionSource } : { deselected: [toolId] }),
    ...(operation === 'load'
      ? {
        selected: [{
          toolId: e.toolId, name: e.name, revision: e.revision,
          schemaDigest: e.schemaDigest, skillRevision: e.skillRevision,
        }],
      }
      : {}),
  };
}

// ---- 输入路径与回执形状判据 -------------------------------------------

test('deriveInputPath 从 canonical call 重算路径', () => {
  assert.deepEqual(deriveInputPath({ names: ['a'] }), { ok: true, source: 'name', action: 'load' });
  assert.deepEqual(deriveInputPath({ action: 'load', names: ['a'] }), { ok: true, source: 'name', action: 'load' });
  assert.deepEqual(deriveInputPath({ candidates: [{ ref: 'c', revision: 'r' }] }), { ok: true, source: 'candidate', action: 'load' });
  assert.equal(deriveInputPath({ action: 'unload', toolIds: ['t'] }).action, 'unload');
  assert.equal(deriveInputPath({ names: ['a'], candidates: [{ ref: 'c', revision: 'r' }] }).ok, false, '混用必须被拒');
  assert.equal(deriveInputPath({}).ok, false, 'load 缺输入路径不是合法 canonical call');
  assert.equal(deriveInputPath({ action: 'load' }).reason, 'no-input-path');
  assert.equal(deriveInputPath({ action: 'unload', toolIds: [] }).ok, false);
});

test('parseReceiptShape 拒绝错 kind/版本/字段类型', () => {
  assert.equal(parseReceiptShape({ kind: 'x', version: 2, operationId: 'o', operation: 'load', selectionSource: 'name', selected: [] }).ok, false);
  assert.equal(parseReceiptShape({ kind: 'tool-discovery.selection', version: 1, operationId: 'o', operation: 'load', selectionSource: 'name', selected: [{}] }).ok, false, 'v1 草案不得被当作当前授权');
  assert.equal(parseReceiptShape({ kind: 'tool-discovery.selection', version: 2, operationId: 'o', operation: 'load', selectionSource: 'weird', selected: [{}] }).ok, false);
  const bad = receiptFor('t_files_glob');
  bad.selected[0].schemaDigest = 123;
  assert.equal(parseReceiptShape(bad).ok, false, '字段类型必须严格');
});

// ---- 完整重算比较(F2) -------------------------------------------------

test('F2:四字段必须由当前绑定重算,不能只信自报', () => {
  const e = entry('t_files_glob');
  const good = { toolId: e.toolId, name: e.name, revision: e.revision, schemaDigest: e.schemaDigest, skillRevision: e.skillRevision };
  assert.equal(recomputeSelectionIdentity(e, good).ok, true);
  for (const [field, badValue, reason] of [
    ['name', 'other_name', 'name-mismatch'],
    ['toolId', 't_other', 'toolId-mismatch'],
    ['revision', 'r_forged', 'revision-mismatch'],
    ['schemaDigest', 'sha256:deadbeef', 'schemaDigest-mismatch'],
    ['skillRevision', 's_forged', 'skillRevision-mismatch'],
  ]) {
    const claimed = { ...good, [field]: badValue };
    const res = recomputeSelectionIdentity(e, claimed);
    assert.equal(res.ok, false, `${field} 伪造必须被拒`);
    assert.equal(res.reason, reason);
  }
});

test('F2:自报 schemaDigest 与真实 wire 不符 → 不激活', () => {
  const st = createState('s1');
  const bad = receiptFor('t_files_glob');
  bad.selected[0].schemaDigest = 'sha256:' + '0'.repeat(64);
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: bad }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'schemaDigest-mismatch');
  assert.equal(out.state.selected.size, 0);
  assert.equal(out.state.integrity.rejected, 1);
});

test('F2:toolId↔name 绑定:回执 toolId 与 name 不属于同一绑定 → 不激活', () => {
  const st = createState('s1');
  const bad = receiptFor('t_files_glob');
  // 名字是 glob,toolId 却指向 grep。查找以 toolId 为键,随后必须校验 name,
  // 因此任何 name↔toolId 错配都会在此被拒。
  bad.selected[0].toolId = 't_files_grep';
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: bad }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'name-mismatch');
  assert.equal(out.state.selected.size, 0);
  // 反向:toolId 根本不在目录中
  const absent = receiptFor('t_files_glob', 'name', 'op_2');
  absent.selected[0].toolId = 't_not_in_catalog';
  const out2 = reducePair(st, pair({ seq: 1, operationId: 'op_2', input: { names: ['glob'] }, payload: absent }), ctx());
  assert.equal(out2.applied, false);
  assert.equal(out2.reason, 'toolId-not-in-catalog');
});

test('F2:自报版本号正确但当前绑定已变 → 不激活', () => {
  const changed = buildCatalog(
    sampleBindings().map((b) => (b.toolId === 't_files_glob'
      ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'] } } }
      : b)),
    { now: 0, generation: 'g2' },
  );
  const st = createState('s1');
  // 回执说的是旧定义
  const payload = receiptFor('t_files_glob');
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload }), {
    now: () => 1000, catalog: changed,
  });
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'revision-mismatch', '不得按名字把旧回执升级到新定义');
});

// ---- 外层成功与协议 ok 都要成立 ---------------------------------------

test('isError 为真 → 不激活(只 ok 不算成功)', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({
    seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob'), isError: true, ok: true,
  }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'result-is-error');
});

test('协议 ok 非 true → 不激活(不只看 execute 返回值)', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({
    seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob'), ok: false,
  }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'protocol-not-ok');
});

test('renderer/pruner 改写标记 → 无条件拒(L12)', () => {
  const st = createState('s1');
  const p = pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') });
  p.result.rewrittenBy = 'renderer';
  const out = reducePair(st, p, ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'result-rewritten');
});

// ---- 来源绑定 ---------------------------------------------------------

test('S09:非 tool_load 的调用不得授权激活', () => {
  const st = createState('s1');
  const p = pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') });
  p.call.tool = 'tool_search'; // 伪造 receipt 出现在别的工具结果里
  const out = reducePair(st, p, ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'not-tool-load');
  assert.equal(out.state.selected.size, 0);
});

test('operationId 必须与 canonical call 绑定', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_CALL', input: { names: ['glob'] }, payload: receiptFor('t_files_glob', 'name', 'op_OTHER') }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'operationId-mismatch');
});

test('selectionSource 自报与真实输入路径不符 → 拒(F2 交叉校验)', () => {
  const st = createState('s1');
  // 实际走 names 路径,回执自称 candidate
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob', 'candidate') }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'selectionSource-mismatch');
});

test('F18:混用输入路径的 canonical call 一律拒', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({
    seq: 1, operationId: 'op_1',
    input: { names: ['glob'], candidates: [{ ref: 'c', revision: 'r' }] },
    payload: receiptFor('t_files_glob'),
  }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'mixed-input-paths');
});

test('名称路径:selected 必须 ⊆ call.input.names', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['grep'] }, payload: receiptFor('t_files_glob') }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'selected-not-requested');
});

test('候选路径热态:ref 解析结果必须与 selected 交叉一致', () => {
  const st = createState('s1');
  const globRev = entry('t_files_glob').revision;
  const p = pair({
    seq: 1, operationId: 'op_1',
    input: { candidates: [{ ref: 'c1', revision: globRev }] },
    payload: receiptFor('t_files_glob', 'candidate'),
  });
  const okCtx = { now: () => 1, catalog, resolveRef: () => ({ toolId: 't_files_glob', revision: globRev }) };
  assert.equal(reducePair(st, p, okCtx).applied, true);

  // ref 解析到另一个工具(版本与 input 一致)→ selected 不得来自该 ref
  const grepRev = entry('t_files_grep').revision;
  const p2 = { ...p, call: { ...p.call, input: { candidates: [{ ref: 'c1', revision: grepRev }] } } };
  const otherToolCtx = { now: () => 1, catalog, resolveRef: () => ({ toolId: 't_files_grep', revision: grepRev }) };
  const out = reducePair(createState('s2'), p2, otherToolCtx);
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'selected-not-from-candidate');

  // ref 解析不到 → 拒
  assert.equal(reducePair(createState('s3'), p, { now: () => 1, catalog, resolveRef: () => null }).reason, 'candidate-ref-unresolvable');

  // ref 解析出的 revision 与 call 里的 revision 不一致 → 拒
  const revMismatch = { now: () => 1, catalog, resolveRef: () => ({ toolId: 't_files_glob', revision: 'r_other' }) };
  assert.equal(reducePair(createState('s4'), p, revMismatch).reason, 'candidate-revision-mismatch');
});

// ---- seq 语义 ---------------------------------------------------------

test('重复 seq 被忽略且不重复应用', () => {
  let st = createState('s1');
  const p = pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') });
  st = reducePair(st, p, ctx()).state;
  assert.equal(st.selected.size, 1);
  const dup = reducePair(st, p, ctx());
  assert.equal(dup.applied, false);
  assert.equal(dup.reason, 'stale-seq');
  assert.equal(dup.state.integrity.duplicatesIgnored, 1);
  assert.equal(dup.state.selected.size, 1, '不得重复应用');
});

test('更小 seq(乱序)被忽略并计数', () => {
  let st = createState('s1');
  st = reducePair(st, pair({ seq: 5, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  const out = reducePair(st, pair({ seq: 3, operationId: 'op_2', input: { names: ['grep'] }, payload: receiptFor('t_files_grep', 'name', 'op_2') }), ctx());
  assert.equal(out.applied, false);
  assert.equal(out.state.integrity.outOfOrderIgnored, 1);
  assert.equal(out.state.selected.size, 1);
});

test('seq 缺口被记录,不被静默丢弃', () => {
  const st = createState('s1');
  const out = reducePair(st, pair({ seq: 10, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx());
  assert.equal(out.applied, true);
  assert.deepEqual(out.state.integrity.gaps, [10]);
});

test('sourceEventSeqs 与 seq 冲突 → 拒', () => {
  const st = createState('s1');
  const p = pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') });
  p.result.sourceEventSeqs = [99];
  const out = reducePair(st, p, ctx());
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'source-seq-mismatch');
});

// ---- 幂等与重选 -------------------------------------------------------

test('同 toolId 同版本重复 → 幂等不追加', () => {
  let st = createState('s1');
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  st = reducePair(st, pair({ seq: 2, operationId: 'op_2', input: { names: ['glob'] }, payload: receiptFor('t_files_glob', 'name', 'op_2') }), ctx()).state;
  assert.equal(st.selected.size, 1);
  assert.equal(st.integrity.applied, 2);
});

// ---- guard 判据 -------------------------------------------------------

test('guard:selected 但未 advertised → TOOL_NOT_ADVERTISED', () => {
  let st = createState('s1');
  st.mode = 'ready';
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  const r = evaluateCall(st, { name: 'glob', now: 1 });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'TOOL_NOT_ADVERTISED');
});

test('S08:同响应 load + 猜测调用 → 旧请求未曝光,拒绝', () => {
  let st = createState('s1');
  st.mode = 'ready';
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  // 当前请求 request_1 从未曝光过 glob
  const r = evaluateCall(st, { name: 'glob', requestId: 'request_1', now: 1 });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'TOOL_NOT_ADVERTISED', 'load 完成不等于本请求已披露');
});

test('advertised 后同 request 放行,换 request 需重新曝光', () => {
  let st = createState('s1');
  st.mode = 'ready';
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  const e = entry('t_files_glob');
  st = recordAdvertisement(st, { requestId: 'request_1', toolId: 't_files_glob', name: 'glob', revision: e.revision, schemaDigest: e.schemaDigest, now: 5 });
  assert.equal(evaluateCall(st, { name: 'glob', requestId: 'request_1', now: 6 }).allowed, true);
  const next = evaluateCall(st, { name: 'glob', requestId: 'request_2', now: 6 });
  assert.equal(next.allowed, false);
  assert.equal(next.code, 'TOOL_NOT_ADVERTISED');
});

test('advertised 版本不匹配不算已披露', () => {
  let st = createState('s1');
  st.mode = 'ready';
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  st = recordAdvertisement(st, { requestId: 'r1', toolId: 't_files_glob', name: 'glob', revision: 'r_wrong', schemaDigest: 'sha256:bad', now: 5 });
  assert.equal(st.advertised.size, 0, '版本不符不得建立 advertised');
  assert.equal(evaluateCall(st, { name: 'glob', requestId: 'r1', now: 6 }).allowed, false);
});

test('F1:未知与未加载对外文案一致,visibility 仅诊断', () => {
  const st = createState('s1');
  st.mode = 'ready';
  const hidden = evaluateCall(st, { name: 'glob', now: 1, registeredInScope: true });
  const unknown = evaluateCall(st, { name: 'totally_unknown', now: 1, registeredInScope: false });
  assert.equal(hidden.allowed, false);
  assert.equal(unknown.allowed, false);
  assert.equal(hidden.code, unknown.code, '对外语义一致');
  assert.equal(hidden.reason, unknown.reason, '对外文案必须一致,不得泄漏存在性');
  assert.equal(hidden.visibility, 'hidden');
  assert.equal(unknown.visibility, 'unknown-to-scope', 'visibility 只作诊断');
});

test('guard:入口与框架保留项放行', () => {
  const st = createState('s1');
  st.mode = 'ready';
  assert.equal(evaluateCall(st, { name: 'tool_list', now: 1, isEntryOrFramework: true }).allowed, true);
  assert.equal(evaluateCall(st, { name: 'final_answer', now: 1, isEntryOrFramework: true }).allowed, true);
});

test('guard:状态未就绪 → fail closed', () => {
  const st = createState('s1'); // mode = restoring
  const r = evaluateCall(st, { name: 'glob', now: 1 });
  assert.equal(r.allowed, false);
});

test('L05/L06:撤权后 selected 立即失效且 guard 拒绝', () => {
  let st = createState('s1');
  st.mode = 'ready';
  st = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx()).state;
  const e = entry('t_files_glob');
  st = recordAdvertisement(st, { requestId: 'r1', toolId: 't_files_glob', name: 'glob', revision: e.revision, schemaDigest: e.schemaDigest, now: 5 });
  assert.equal(evaluateCall(st, { name: 'glob', requestId: 'r1', now: 6 }).allowed, true);
  st = invalidateTool(st, 't_files_glob', 'tool-removed', 7);
  assert.equal(st.selected.size, 0);
  assert.equal(st.advertised.size, 0);
  assert.equal(st.invalidated.size, 1);
  const r = evaluateCall(st, { name: 'glob', requestId: 'r1', now: 8 });
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'TOOL_NOT_LOADED');
});

test('reducer 纯度:不改原 state', () => {
  const st = createState('s1');
  st.mode = 'ready';
  const out = reducePair(st, pair({ seq: 1, operationId: 'op_1', input: { names: ['glob'] }, payload: receiptFor('t_files_glob') }), ctx());
  assert.equal(st.selected.size, 0, '原 state 不得被修改');
  assert.equal(out.state.selected.size, 1);
});

// ---- 冷恢复(L01/L03/L11/F17) -----------------------------------------

test('L01 冷恢复:名称路径按回执精确版本恢复', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  const receipt = res.response.data.receipt;
  const target = { sessionId: 'resumed' };
  const out = engine.restore([pair({ seq: 1, operationId: op, input: { names: ['glob'] }, payload: receipt })], target);
  assert.equal(out.mode, 'ready');
  assert.equal(out.applied, 1);
  assert.equal(engine.getState(target).selected.size, 1);
  assert.equal(engine.getState(target).selected.get('t_files_glob').revision, receipt.selected[0].revision);
});

test('F17 回放不升级:恢复时当前定义已变 → 失效而非升级', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  const receipt = res.response.data.receipt;
  // 恢复前 schema 变了
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern', 'cwd'] } } }
    : b));
  engine.refreshCatalog(changed);
  const target = { sessionId: 'resumed2' };
  const out = engine.restore([pair({ seq: 1, operationId: op, input: { names: ['glob'] }, payload: receipt })], target);
  assert.equal(out.applied, 0, '版本不符不得恢复');
  assert.equal(out.rejected, 1);
  assert.equal(engine.getState(target).selected.size, 0);
});

test('L03 fork 不继承父 selected/ref/cursor', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, SCOPE_A);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  const fork = engine.getState(SCOPE_FORK);
  assert.equal(fork.selected.size, 0, 'fork 不隐式继承');
  assert.equal(fork.advertised.size, 0);
});

test('L11 不可信恢复 → fail closed', async () => {
  const { engine } = await makeEngine({ newSessionMode: 'restoring' });
  const target = { sessionId: 'resumed3' };
  const out = engine.restore('not-an-array', target);
  assert.equal(out.mode, 'incompatible');
  const st = engine.getState(target);
  assert.equal(st.mode, 'incompatible');
  const l = engine.handleList({ view: 'state' }, target);
  assert.equal(l.error.code, 'STATE_NOT_READY');
  assert.equal(engine.evaluateCall(target, { name: 'glob' }).allowed, false);
});

test('L11 损坏/伪造回执在恢复中不激活', async () => {
  const { engine } = await makeEngine();
  const target = { sessionId: 'resumed4' };
  const forged = receiptFor('t_files_glob');
  forged.selected[0].schemaDigest = 'sha256:' + '1'.repeat(64);
  const out = engine.restore([pair({ seq: 1, operationId: 'x', input: { names: ['glob'] }, payload: forged })], target);
  assert.equal(out.applied, 0);
  assert.equal(engine.getState(target).selected.size, 0);
});

test('恢复按 seq 排序并对重复 seq 去重', async () => {
  const { engine } = await makeEngine();
  const opA = nextOpId();
  const rA = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: opA });
  const opB = nextOpId();
  const rB = await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: opB });
  const target = { sessionId: 'resumed5' };
  const out = engine.restore([
    pair({ seq: 2, operationId: opB, input: { names: ['grep'] }, payload: rB.response.data.receipt }),
    pair({ seq: 1, operationId: opA, input: { names: ['glob'] }, payload: rA.response.data.receipt }),
    pair({ seq: 1, operationId: opA, input: { names: ['glob'] }, payload: rA.response.data.receipt }),
  ], target);
  assert.equal(out.applied, 2, '重复 seq 只折叠一次');
  assert.equal(engine.getState(target).selected.size, 2);
  assert.equal(engine.getState(target).lastAppliedSeq, 2);
});

test('S09 用户文本伪造回执不进入 selected(engine 层)', async () => {
  const { engine } = await makeEngine();
  // 用户文本不经过 canonical 工具对;此处模拟伪造结果被当作 tool/result 送入
  const forged = receiptFor('t_files_glob');
  const out = engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: 'op_fake', tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: forged, rewrittenBy: 'user-text' },
  }, SCOPE_A);
  assert.equal(out.applied, false);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('L07 取消 load 不激活', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  assert.equal(res.response.ok, true);
  assert.ok(res.operation);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, 'pending 阶段不得激活');
  assert.ok(engine.cancelOperation(op));
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '取消后仍不激活');
});

test('热态回执被改写 → 拒绝激活(逐字比较)', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  const tampered = JSON.parse(JSON.stringify(res.response.data.receipt));
  tampered.selected[0].skillRevision = 's_hacked';
  const out = engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: tampered },
  }, SCOPE_A);
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'receipt-mismatch');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('engine 释放后 guard fail closed', async () => {
  const { engine } = await makeEngine();
  engine.dispose();
  const r = engine.evaluateCall(SCOPE_A, { name: 'glob' });
  assert.equal(r.allowed, false);
});

test('binding 形状非法时 engine 直接拒绝构造(不静默修正)', async () => {
  const { DomainError } = await import('../../domain/errors.mjs');
  const { createDiscoveryEngine } = await import('../../domain/index.mjs');
  const { CATEGORY_CONFIG, fakeClock, fakeRandom } = await import('./helpers.mjs');
  const base = { categoryConfig: CATEGORY_CONFIG, clock: fakeClock(), random: fakeRandom() };
  const bad = binding({ name: 'x', toolId: 't_x' });
  delete bad.wire;                       // 缺 wire
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: [bad] }), DomainError);
  const mismatch = binding({ name: 'x', toolId: 't_x' });
  mismatch.wire.name = 'other';          // wire.name 与绑定名不一致
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: [mismatch] }), DomainError);
  const dup = [binding({ name: 'x', toolId: 't_same' }), binding({ name: 'y', toolId: 't_same' })];
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: dup }), DomainError);
  // 非 native 展示模式首版拒绝
  assert.throws(
    () => createDiscoveryEngine({ ...base, bindings: [], capabilityKind: 'ptc' }),
    (e) => e.code === 'INCOMPATIBLE_PRESENTATION',
  );
});
