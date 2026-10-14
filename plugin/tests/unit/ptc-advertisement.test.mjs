import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../../adapters/dsh/journal.mjs';
import { makeEngine, SCOPE_A } from './helpers.mjs';

test('PTC canonical load 和旧 run_code header 均不能伪造 SDK 曝光', async (t) => {
  const { engine } = await makeEngine();
  const journal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope: SCOPE_A,
    engine, collapsedPresentation: () => true });
  t.after(() => { journal.dispose(); engine.dispose(); });
  journal.stopBuffering();
  journal.onEvent({ seq: 0, type: 'request/header', data: { header: { tools: [{ name: 'run_code' }] } } });
  const input = { names: ['glob'] };
  journal.onEvent({ seq: 1, type: 'tool/call', data: { name: 'tool_load', callId: 'first', arguments: input } });
  const out = await engine.handleLoad(input, SCOPE_A, { operationId: 'op_first' });
  journal.onEvent({ seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: { message: { isError: false,
    content: [{ type: 'text', text: JSON.stringify(out.response) }] } } });
  const evaluate = () => engine.evaluateCall(SCOPE_A, { name: 'glob', registeredInScope: true, requestId: journal.currentRequestId() });
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(evaluate().code, 'TOOL_NOT_ADVERTISED');
  journal.onEvent({ seq: 3, type: 'request/header', data: { header: { tools: [{ name: 'run_code' }] } } });
  assert.equal(evaluate().code, 'TOOL_NOT_ADVERTISED', 'header 变化本身也没有 SDK 证据');
  const entry = engine.getCatalog().entries.get('t_files_glob');
  const record = { toolId: entry.toolId, name: entry.name, revision: entry.revision, schemaDigest: entry.schemaDigest, wire: entry.wire };
  journal.recordSdkAdvertisements([{ ...record, revision: 'stale' }]);
  assert.equal(evaluate().allowed, false);
  journal.recordSdkAdvertisements([record]);
  assert.equal(evaluate().allowed, true, '已核验的出站 SDK 快照才可授予曝光');
});
