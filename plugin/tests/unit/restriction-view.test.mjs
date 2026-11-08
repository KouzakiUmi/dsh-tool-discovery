import test from 'node:test';
import assert from 'node:assert/strict';
import { viewWithoutRestriction, assertRestrictionHost } from '../../adapters/dsh/restriction-view.mjs';

function layer(definitions, restrictions = []) {
  return {
    tools: new Map(definitions.map((name) => [name, { definition: { name } }])),
    restrictions: new Map(restrictions.map((filter, i) => [i, filter])),
  };
}

test('ignores only the owned mask, preserving ancestor and peer restrictions and own shadows', () => {
  const owned = { allow: new Set(['entry']) };
  const parent = layer(['parent'], [{ deny: new Set(['blocked']) }]);
  const own = layer(['local', 'shadow'], [owned, { deny: new Set(['peer-denied']) }]);
  const global = layer(['entry', 'hidden', 'blocked', 'peer-denied', 'shadow']);
  const tools = { layers: { global, chainLayers: () => [parent, own], peek: () => own } };
  const result = viewWithoutRestriction(tools, {}, owned);
  assert.deepEqual([...result.visible.keys()], ['entry', 'hidden', 'shadow', 'parent', 'local']);
  assert.equal(result.visible.get('shadow'), own.tools.get('shadow').definition);
  assert.deepEqual([...result.restrictableNames], ['entry', 'hidden', 'blocked', 'peer-denied', 'shadow', 'parent']);
  assert.equal(own.restrictions.get(0), owned, 'inspection does not remove or mutate a live filter');
});

test('fails closed when host internals are unavailable', () => {
  assert.throws(() => viewWithoutRestriction({}, {}, undefined), /restriction-safe catalog unavailable/);
});

for (const missing of ['chainLayers', 'peek', 'entries', 'selectExecutor', 'view', 'restrict']) {
  test(`activation preflight rejects missing ${missing} and records a diagnostic`, () => {
    const tools = { layers: { chainLayers() {}, peek() {}, global: { tools: { entries() {} } } },
      selectExecutor() {}, view() {}, restrict() {} };
    assert.doesNotThrow(() => assertRestrictionHost(tools));
    if (missing === 'entries') tools.layers.global.tools.entries = null;
    else if (missing in tools.layers) tools.layers[missing] = null;
    else tools[missing] = null;
    const logs = [];
    assert.throws(() => assertRestrictionHost(tools, (...args) => logs.push(args)),
      error => error.code === 'INCOMPATIBLE_COMPOSITION' && error.message.includes(missing));
    assert.equal(logs[0][0], 'restriction:incompatible-host');
    assert.equal(logs[0][1].missing.length, 1);
  });
}
