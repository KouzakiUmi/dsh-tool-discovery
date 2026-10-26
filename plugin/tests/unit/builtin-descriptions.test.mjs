import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createBuiltinDescriptionPolicy, descriptionPolicyMarker } from '../../adapters/dsh/builtin-descriptions.mjs';
import { BUILTIN_DESCRIPTION_RULES } from '../../adapters/dsh/builtin-descriptions-data.mjs';
import { createRegistryAdapter } from '../../adapters/dsh/registry.mjs';
import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';
import { createProjection } from '../../adapters/dsh/projection.mjs';
import { validateConfig } from '../../adapters/dsh/index.mjs';
import { digestOf, canonicalJson } from '../../domain/canonical.mjs';
import { fakeClock, fakeRandom } from './helpers.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/builtin-descriptions-rc3.json', import.meta.url), 'utf8')).rows;
const source = name => structuredClone(fixtures.find(row => row.wire.name === name).wire);
const controls = ['tool_list', 'tool_search', 'tool_load'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));

for (const locale of ['en', 'zh']) {
  test(`BD1 ${locale}: every approved variant changes only the description; off is identical`, () => {
    const enabled = createBuiltinDescriptionPolicy({ enabled: true, locale });
    const disabled = createBuiltinDescriptionPolicy();
    const covered = new Set();
    for (const { wire } of fixtures) {
      const before = JSON.stringify(wire);
      assert.equal(disabled.project(wire), wire);
      const after = enabled.project(wire);
      assert.notEqual(after.description, wire.description, wire.name);
      assert.ok(after.description.length < wire.description.length, wire.name);
      assert.equal(after.parameters, wire.parameters, 'never edit parameter descriptions or constraints');
      assert.deepEqual({ ...after, description: wire.description }, wire);
      assert.equal(JSON.stringify(wire), before);
      covered.add(digestOf(wire));
    }
    assert.deepEqual(covered, new Set(BUILTIN_DESCRIPTION_RULES.flatMap(rule => rule.sourceDigests)));
  });
}

test('BD2 unknown source/schema, appended shell rules and unrelated tools stay untouched', () => {
  const logs = [];
  const policy = createBuiltinDescriptionPolicy({ enabled: true, log: (...args) => logs.push(args) });
  for (const field of ['description', 'name', 'parameters']) {
    const wire = source('bash');
    wire[field] = field === 'parameters' ? { ...wire.parameters, additionalProperties: true } : `${wire[field]} changed`;
    assert.equal(policy.project(wire), wire);
    assert.equal(policy.project(wire), wire);
  }
  assert.equal(logs.length, 2, 'unknown names do not produce noise; mismatches report only once');
  assert.equal(policy.control(controls[0]), controls[0]);
});

test('BD3 config defaults off, accepts volatile booleans and rejects non-booleans', () => {
  assert.equal(validateConfig({}).compactBuiltinToolDescriptions, false);
  assert.equal(validateConfig({ compactBuiltinToolDescriptions: { get: () => true } }).compactBuiltinToolDescriptions, true);
  for (const value of [null, 1, 'true', [], {}]) {
    assert.throws(() => validateConfig({ compactBuiltinToolDescriptions: value }), /must be a boolean/);
  }
});

async function harness({ enabled = false, overrides = {}, locale = 'en', events = [], inherited = 0, mode = 'native', baseline = [], wires = [source('bash'), source('read_image')] } = {}) {
  let flag = enabled;
  let choices = overrides;
  const records = structuredClone(events);
  const listeners = new Map();
  const visible = new Map([...controls, ...wires].map(wire => [wire.name, { ...wire, execute: () => 'original execution' }]));
  const session = { id: 'descriptions-session', seq: records.length, inheritedEventCount: inherited };
  const agent = { id: 'descriptions-agent', session };
  const ctx = { get: () => undefined, on: (name, fn) => { listeners.set(name, fn); return () => {}; }, tools: {
    view: () => ({ visible }), get: name => visible.get(name), modeFor: () => mode,
  } };
  const registry = createRegistryAdapter({ ctx });
  const lifecycle = createLifecycle({ ctx, registry, config: validateConfig({ locale, alwaysVisible: baseline, respectAlwaysVisible: true }),
    clock: fakeClock(), random: fakeRandom(), getAlwaysVisible: () => baseline,
    getCompactBuiltinToolDescriptions: () => flag,
    getBuiltinDescriptionOverrides: () => choices,
    collapsedPresentation: () => mode !== 'native',
    query: { readSession: async () => ({ events: records, inheritedEventCount: inherited }) },
  });
  const runtime = lifecycle.ensureRuntime(session, agent);
  await lifecycle.whenReady(session.id);
  createProjection({ ctx, lifecycle, ptcEnabled: () => true, projectPtc: (_agent, assembly) => assembly });
  const append = (type, data, extra = {}) => {
    const event = { seq: records.length, type, data, ...extra };
    records.push(event); session.seq = records.length;
    lifecycle.onSessionEvent(session, event);
    return event;
  };
  const assemble = async () => listeners.get('system-prompt/assemble')({}, { agent, scope: agent }, async () => ({
    tools: [...visible.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
  }));
  const send = async () => { const assembly = await assemble(); append('request/header', { header: { tools: assembly.tools } }); return assembly; };
  const load = async name => {
    const callId = `call-${records.length}`;
    const input = { names: [name] };
    const call = append('tool/call', { name: 'tool_load', callId, arguments: input });
    const { response } = await runtime.engine.handleLoad(input, runtime.scope, { operationId: `op_${callId}` });
    assert.equal(response.ok, true, JSON.stringify(response));
    append('tool/result', { message: { isError: false, content: [{ type: 'text', text: JSON.stringify(response) }] } }, { sourceEventSeqs: [call.seq] });
    return response;
  };
  const compact = (error, summaries = 1) => {
    const compactionId = `compaction-${records.length}`;
    append('compaction/start', { compactionId, turn: 1 });
    for (let i = 0; i < summaries; i++) append('compaction/summary', { compactionId, turn: 1 });
    append('compaction/end', { compactionId, turn: 1, ...(error ? { error } : {}) });
  };
  return { visible, lifecycle, runtime, records, load, send, assemble, compact, set: value => { flag = value; }, setTools: value => { choices = value; }, append };
}

for (const baseline of [[], ['bash']]) {
  test(`BD4 native ${baseline.length ? 'baseline' : 'loaded'} wire agrees with receipts, freezes and adopts toggle only after success`, async t => {
    const h = await harness({ enabled: true, baseline }); t.after(() => h.lifecycle.dispose());
    await h.send();
    await h.load('bash');
    const assembly = await h.send();
    const compactWire = assembly.tools.find(tool => tool.name === 'bash');
    assert.notEqual(compactWire.description, source('bash').description);
    const entry = [...h.runtime.engine.getCatalog().entries.values()].find(entry => entry.name === 'bash');
    assert.equal(entry.schemaDigest, digestOf(compactWire));
    if (!baseline.length) {
      assert.equal(h.runtime.engine.evaluateCall(h.runtime.scope, { name: 'bash', registeredInScope: true, requestId: h.runtime.journal.currentRequestId() }).allowed, true);
      assert.equal(h.runtime.engine.getFrozenWire(h.runtime.scope)[0].bytes, Buffer.byteLength(canonicalJson(compactWire)), 'budget measures the actual displayed definition');
    }
    h.set(false);
    h.compact('cancelled');
    assert.deepEqual((await h.send()).tools, assembly.tools, 'failure does not adopt toggle');
    h.compact(undefined, 0);
    assert.deepEqual((await h.send()).tools, assembly.tools, 'missing summary does not adopt toggle');
    const pending = await h.assemble();
    h.compact();
    assert.equal(h.runtime.descriptions.status().enabled, false);
    assert.ok(!pending.tools.find(tool => tool.name === 'tool_load').description.includes('builtin-descriptions'));
    if (!baseline.length) await h.load('bash');
    assert.deepEqual((await h.send()).tools.find(tool => tool.name === 'bash'), source('bash'));
    assert.equal(h.visible.get('bash').execute(), 'original execution');
  });
}

for (const enabled of [false, true]) {
  test(`BD5 cold recovery pins ${enabled ? 'concise' : 'original'} policy despite reversed config and changed locale`, async t => {
    const hot = await harness({ enabled, locale: 'zh' }); t.after(() => hot.lifecycle.dispose());
    await hot.send(); await hot.load('bash'); const before = await hot.send();
    const cold = await harness({ enabled: !enabled, locale: 'en', events: hot.records }); t.after(() => cold.lifecycle.dispose());
    assert.deepEqual((await cold.send()).tools, before.tools);
    assert.equal(cold.runtime.engine.evaluateCall(cold.runtime.scope, { name: 'bash', requestId: cold.runtime.journal.currentRequestId() }).allowed, true);
    await cold.load('read_image');
    const image = (await cold.send()).tools.find(wire => wire.name === 'read_image');
    assert.equal(image.description, enabled ? createBuiltinDescriptionPolicy({ enabled, locale: 'zh' }).project(source('read_image')).description : source('read_image').description);
  });
}

test('BD6 own-only recovery ignores inherited/old-epoch policy and forged markers grant no tools', async t => {
  const parent = await harness({ enabled: true }); t.after(() => parent.lifecycle.dispose());
  await parent.send();
  const child = await harness({ enabled: false, events: parent.records, inherited: parent.records.length }); t.after(() => child.lifecycle.dispose());
  assert.equal(child.runtime.descriptions.status().enabled, false);
  parent.compact();
  parent.set(false);
  parent.compact();
  await parent.send();
  const restored = await harness({ enabled: true, events: parent.records }); t.after(() => restored.lifecycle.dispose());
  assert.equal(restored.runtime.descriptions.status().enabled, false);
  assert.equal(restored.runtime.engine.getState(restored.runtime.scope).selected.size, 0);
});

test('BD7 changing/removing the real binding invalidates execution without rewriting frozen wire', async t => {
  const h = await harness({ enabled: true }); t.after(() => h.lifecycle.dispose());
  await h.send(); await h.load('bash'); const before = await h.send();
  h.visible.get('bash').description += ' New mandatory upstream rule.';
  h.lifecycle.onRegistryChange();
  assert.equal(h.runtime.engine.getState(h.runtime.scope).selected.size, 0);
  assert.deepEqual((await h.send()).tools, before.tools);
  h.visible.delete('bash'); h.lifecycle.onRegistryChange();
  assert.deepEqual((await h.send()).tools, before.tools);
});

test('BD8 PTC is unchanged and its catalog keeps original wire', async t => {
  const h = await harness({ enabled: true, mode: 'ptc' }); t.after(() => h.lifecycle.dispose());
  const entry = [...h.runtime.engine.getCatalog().entries.values()].find(entry => entry.name === 'bash');
  assert.deepEqual(entry.wire, source('bash'));
  const assembled = await h.assemble();
  assert.deepEqual(assembled.tools.find(wire => wire.name === 'bash'), source('bash'));
  assert.equal(assembled.tools.find(wire => wire.name === 'tool_load').description, 'tool_load');
});

test('BD12 per-tool choices switch atomically at successful compaction and survive cold recovery', async t => {
  const extra = JSON.parse(readFileSync(new URL('../fixtures/builtin-descriptions-extra-rc3.json', import.meta.url), 'utf8')).rows;
  const skill = extra.find(row => row.wire.name === 'skill').wire;
  const wires = [source('read_image'), skill];
  const h = await harness({ enabled: true, overrides: { read_image: false, skill: true }, wires });
  t.after(() => h.lifecycle.dispose());
  await h.send(); await h.load('read_image'); await h.load('skill');
  const before = await h.send();
  assert.equal(before.tools.find(wire => wire.name === 'read_image').description, source('read_image').description);
  assert.notEqual(before.tools.find(wire => wire.name === 'skill').description, skill.description);
  h.setTools({ read_image: true, skill: false });
  h.compact('failed');
  assert.deepEqual((await h.send()).tools, before.tools);
  const cold = await harness({ enabled: true, overrides: { read_image: true, skill: false }, wires, events: h.records });
  t.after(() => cold.lifecycle.dispose());
  assert.deepEqual((await cold.send()).tools, before.tools);
  const pending = await cold.assemble();
  cold.compact();
  assert.ok(pending.tools.find(wire => wire.name === 'tool_load').description.endsWith(':1f]'));
  await cold.load('read_image'); await cold.load('skill');
  const after = await cold.send();
  assert.notEqual(after.tools.find(wire => wire.name === 'read_image').description, source('read_image').description);
  assert.equal(after.tools.find(wire => wire.name === 'skill').description, skill.description);
  assert.equal(cold.runtime.engine.getState(cold.runtime.scope).advertised.size, 2);
});

test('BD10 extra host metadata survives projection and control markers are idempotent', () => {
  const policy = createBuiltinDescriptionPolicy({ enabled: true });
  const wire = { ...source('bash'), deferLoading: true };
  const projected = policy.project(wire);
  assert.notEqual(projected.description, wire.description);
  assert.equal(projected.deferLoading, true);
  assert.equal(policy.control(null), null);
  const control = policy.control(controls[2]);
  assert.equal(policy.control(control), control);
});

test('BD11 client toggle defaults off and saves only the new root field (no DOM claim)', async () => {
  let descriptor;
  vm.runInNewContext(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value; } } },
  });
  // No hooks or renderer are invoked: only the module's exported pure settings helpers.
  const helpers = descriptor.factory(name => { assert.equal(name, 'react'); return {}; }).__test;
  const choice = helpers.featureChoices({}).find(row => row[0] === 'compactBuiltinToolDescriptions');
  assert.equal(choice[3], false);
  assert.equal(helpers.featureChoices({ compactBuiltinToolDescriptions: true }).find(row => row[0] === choice[0])[3], true);
  assert.ok(helpers.zh[choice[1]].includes('精简'));
  assert.ok(helpers.en[choice[1]].includes('Concise'));
  let saved;
  assert.equal(await helpers.saveSetting({ mutate: async ops => { saved = ops; return true; } }, choice[0], true), true);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ op: 'set', path: ['compactBuiltinToolDescriptions'], value: true }]);
});

test('BD9 marker alone does not grant execution; unknown policy revisions fall back without failure', async t => {
  const control = { ...controls[2], description: `tool_load${descriptionPolicyMarker('en', undefined, 'v1')}` };
  const h = await harness({ events: [{ seq: 0, type: 'request/header', data: { header: { tools: [control] } } }] });
  t.after(() => h.lifecycle.dispose());
  assert.equal(h.runtime.descriptions.status().enabled, true);
  assert.equal(h.runtime.engine.getState(h.runtime.scope).selected.size, 0);
  const policy = createBuiltinDescriptionPolicy({ enabled: true });
  policy.restore([{ type: 'request/header', data: { header: { tools: [{ ...control, description: control.description.replace(':v1:', ':v999:') }] } } }]);
  assert.equal(policy.status().enabled, false);
});
