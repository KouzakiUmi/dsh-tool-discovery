import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../../adapters/dsh/journal.mjs';

test('PTC replay re-advertises valid SDK selections when the header stays run_code', () => {
  const scope = { sessionId: 'ptc-replay', actorId: 'a' };
  const ads = [];
  const selection = { toolId: 'ok', name: 'hidden', revision: 'r1', schemaDigest: 'd1' };
  const engine = {
    getState: () => ({
      mode: 'ready',
      invalidated: new Map(),
      selected: new Map([['ok', selection]]),
    }),
    getCatalog: () => ({
      entries: new Map([['ok', { ...selection, wire: { name: 'hidden' } }]]),
    }),
    getFrozenWire: () => [],
    recordAdvertisement: (_scope, rec) => ads.push(rec),
    applyCanonicalPair: () => ({ applied: true }),
    cancelOperation: () => {},
  };
  const journal = createJournal({
    ctx: {},
    session: { id: scope.sessionId, inheritedEventCount: 0 },
    scope,
    engine,
    collapsedPresentation: () => true,
  });
  journal.stopBuffering();
  journal.onEvent({
    seq: 0,
    type: 'request/header',
    data: { header: { tools: [{ name: 'run_code' }] } },
  });
  ads.length = 0;
  journal.onEvent({
    seq: 1,
    type: 'tool/call',
    data: { name: 'tool_load', callId: 'c1', arguments: { names: ['hidden'] } },
  });
  journal.onEvent({
    seq: 2,
    type: 'tool/result',
    sourceEventSeqs: [1],
    data: {
      message: {
        content: [{ type: 'text', text: JSON.stringify({ protocolVersion: 2, tool: 'tool_load', ok: true, data: { receipt: {} } }) }],
      },
    },
  });
  assert.equal(ads.length, 1);
  assert.equal(ads[0].name, 'hidden');
  assert.equal(ads[0].revision, 'r1');
  assert.equal(ads[0].requestId, 'ptc-replay#0');
  journal.dispose();
});
