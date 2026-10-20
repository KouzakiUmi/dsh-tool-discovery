import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPrefixLength } from '../../domain/budgets.mjs';
import { paginateNames } from '../../domain/list.mjs';
import { makeEngine, binding, SCOPE_A, commitLoad } from './helpers.mjs';
import { createState, freezeTool } from '../../domain/state.mjs';
import { digestOf, canonicalJson } from '../../domain/canonical.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('freeze preserves nested observed JSON order and takes an independent copy', () => {
  const wire = { name: 'ordered', description: 'description', parameters: {
    type: 'object', properties: { z: { type: 'string', description: 'z' }, a: { enum: ['b', 'a'] } }, required: ['z', 'a'],
  } };
  const original = JSON.stringify(wire);
  assert.notEqual(original, canonicalJson(wire), 'fixture must detect canonical key sorting');
  const rec = { toolId: 'ordered', name: 'ordered', revision: 'r1', schemaDigest: digestOf(wire), wire };
  const state = freezeTool(createState(), rec);
  const frozen = state.frozen.get('ordered');
  assert.equal(JSON.stringify(frozen.wire), original);
  assert.equal(frozen.bytes, bytes(wire));
  wire.parameters.properties.z.description = 'mutated';
  wire.parameters.required.reverse();
  assert.equal(JSON.stringify(frozen.wire), original);
});

test('bounded prefix examines only a byte-bounded prefix of a huge page', () => {
  let touched = 0;
  const keep = fitPrefixLength(1_000_000, 100, () => 20, () => { touched++; return 10; });
  assert.equal(keep, 7);
  assert.ok(touched <= 10, `unexpected item visits: ${touched}`);
  assert.equal(fitPrefixLength(1_000_000, null, () => assert.fail('unlimited envelope'), () => assert.fail('unlimited item')), 1_000_000);
  assert.equal(fitPrefixLength(0, 1, () => 2, () => assert.fail('empty item')), -1);
});

test('terminal cursor savings can fit a whole page after a non-fitting intermediate page', () => {
  assert.equal(fitPrefixLength(2, 30, (n) => n === 1 ? 40 : 5, () => 10), 2);
});

test('list budget never reads the undelivered tail, and mints only one usable cursor', () => {
  const names = ['中'.repeat(5), 'tail'.repeat(100)];
  Object.defineProperty(names, 2, { get() { assert.fail('serialized or sliced the whole page'); } });
  names.length = 1_000_000;
  let issued = 0;
  const page = paginateNames({ allNames: names, sessionId: 's', view: 'available', category: 'files',
    eligibilityGeneration: 1, orderDigest: 'd', now: 0, limit: 1_000_000,
    budgets: { maxListResultBytes: 150 }, cursorStore: { issue(rec) { issued++; assert.equal(rec.offset, 1); return `p_${'a'.repeat(32)}`; } },
  });
  assert.deepEqual(page.names, ['中'.repeat(5)]);
  assert.equal(page.truncated, true);
  assert.equal(issued, 1);
  assert.ok(bytes(page) <= 150);
});

test('search byte cap constructs cards lazily and returned refs remain loadable', async (t) => {
  const bindings = Array.from({ length: 100 }, (_, i) => binding({ name: `file_${String(i).padStart(3, '0')}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings, engineConfig: { budgets: { maxSearchLimit: null, maxSearchResultBytes: 800 } } });
  t.after(() => engine.dispose());
  // Search ranking uses indexed documents; candidate projection reads selected state.
  // An unreturned distant entry must never be projected under the small byte cap.
  const last = engine.getCatalog().byName.get('file_099')[0];
  const selected = engine.getState(SCOPE_A).selected;
  const get = selected.get.bind(selected);
  selected.get = (id) => {
    assert.notEqual(id, last.toolId, 'materialized the full candidate page');
    return get(id);
  };
  const response = engine.handleSearch({ category: 'files', query: 'file', limit: 100 }, SCOPE_A);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.data.candidates.length > 0 && response.data.candidates.length < 100);
  assert.ok(bytes(response) <= 800);
  assert.equal(response.data.truncated, true);
  assert.equal((await commitLoad(engine, SCOPE_A, { candidates: [{ ref: response.data.candidates[0].ref }] })).applied, true);
});

const freezeWire = (wire, schemaDigest = digestOf(wire), state = createState()) => freezeTool(state,
  { toolId: 'edge', name: 'edge', revision: 'r', schemaDigest, wire });

test('JSON snapshot retains escaping, numeric-key order and null-prototype data', () => {
  const properties = Object.assign(Object.create(null), { z: { enum: ['"', '\\', '\n', '中文', '\ud800', '\u2028'] }, 10: {}, 2: {} });
  const wire = { parameters: { properties, type: 'object' }, description: 'x\t\r', name: 'edge' };
  assert.equal(JSON.stringify(freezeWire(wire).frozen.get('edge').wire), JSON.stringify(wire));
});

test('stable getters/proxies snapshot as JSON data; later mutation cannot rewrite it', () => {
  const parameters = new Proxy({ type: 'object', properties: {} }, {});
  const wire = { name: 'edge', get description() { return 'stable'; }, parameters };
  const expected = JSON.stringify(wire);
  const frozen = freezeWire(wire).frozen.get('edge').wire;
  parameters.type = 'string';
  assert.equal(JSON.stringify(frozen), expected);
  assert.equal(Object.getOwnPropertyDescriptor(frozen, 'description').get, undefined);
});

test('toJSON transformations and changing getters never enter frozen state', () => {
  const state = createState();
  const wire = { name: 'edge', parameters: { type: 'object' } };
  Object.defineProperty(wire.parameters, 'toJSON', { value: () => ({ type: 'string' }) });
  assert.throws(() => freezeWire(wire, digestOf(wire), state), { code: 'INCOMPATIBLE_COMPOSITION' });
  let reads = 0;
  const moving = { name: 'edge', get description() { return String(reads++); }, parameters: {} };
  assert.throws(() => freezeWire(moving, digestOf(moving), state), { code: 'INCOMPATIBLE_COMPOSITION' });
  assert.equal(state.frozen.size, 0);
});

test('circular JSON fails without mutating state', () => {
  const state = createState();
  const wire = { name: 'edge', parameters: {} };
  wire.parameters.self = wire;
  assert.throws(() => freezeWire(wire, 'unused', state));
  assert.equal(state.frozen.size, 0);
});

test('an oversized first item is inspected once then fails without reading the page tail', () => {
  const names = ['x'.repeat(1024 * 1024)];
  Object.defineProperty(names, 1, { get() { assert.fail('read tail after oversized item'); } });
  names.length = 1_000_000;
  assert.throws(() => paginateNames({ allNames: names, sessionId: 's', view: 'available', category: 'files',
    eligibilityGeneration: 1, orderDigest: 'd', now: 0, limit: 1_000_000,
    budgets: { maxListResultBytes: 100 }, cursorStore: { issue() { assert.fail('issued cursor'); } },
  }), { code: 'BUDGET_EXCEEDED' });
});
