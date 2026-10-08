import test from 'node:test';
import assert from 'node:assert/strict';
import { globalToolInventory, presetToolNamesOf } from '../../adapters/dsh/tool-inventory.mjs';
import { buildRows } from '../../client/model.mjs';
const layer = names => ({ tools: new Map(names.map(name => [name, { name }])) });

test('application inventory unions registration layers, deduplicates, excludes controls; never asks a session view', () => {
  const inventory = globalToolInventory({ layers: { global: layer(['tool_list', 'global']), scoped: new Map([['preset', layer(['preset', 'global'])], ['agent', layer(['agent'])]]) }, view: () => { throw new Error('must not read session view'); } });
  assert.deepEqual(inventory, { names: ['agent', 'global', 'preset'], complete: true });
});

test('incompatible/incomplete registry only gives positive registration evidence, never a false unavailable claim', () => {
  assert.deepEqual(globalToolInventory({ view: () => ({ visible: new Map([['yes', {}]]) }) }), { names: ['yes'], complete: false });
  assert.deepEqual(globalToolInventory({ layers: { get global() { throw new Error('not supported'); } } }), { names: [], complete: false });
  const unknown = buildRows({ choices: [], catalogComplete: false }, ['ask_user_question']);
  assert.equal(unknown.rows[0].status, 'unknown');
  assert.equal(unknown.missingCount, 0);
  assert.equal(unknown.unknownCount, 1);
  const absent = buildRows({ choices: [], catalogComplete: true }, ['old_name']);
  assert.equal(absent.rows[0].status, 'unregistered');
  assert.equal(absent.missingCount, 1);
  assert.equal(buildRows({ choices: [{ name: 'yes' }], catalogComplete: false }, ['yes']).rows[0].status, 'registered');
});

test('preset whitelist only comes from the actual bound revision, not a header/name/global catalog', () => {
  const currentKey = {}; const otherKey = {};
  const own = layer(['tool_load', 'allowed', 'native_denied']);
  const foreign = layer(['foreign']);
  const tools = { layers: { peek: key => key === currentKey ? own : key === otherKey ? foreign : undefined }, view: () => ({ visible: new Map([['allowed', {}], ['foreign', {}], ['agent_only', {}]]) }) };
  const scope = { ctx: {}, session: { header: { agentPreset: 'other' } } };
  assert.deepEqual(presetToolNamesOf(tools, { generationFor: ctx => { assert.equal(ctx, scope.ctx); return { key: currentKey }; } }, scope), ['allowed']);
  assert.deepEqual(presetToolNamesOf(tools, { generationFor: () => undefined }, scope), []);
  assert.deepEqual(presetToolNamesOf(tools, undefined, scope), []);
});
