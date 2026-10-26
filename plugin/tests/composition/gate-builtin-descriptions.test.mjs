// Real Loader/agent/request journal with a mock provider and an inert tool body.
// No shell, image read, real provider, profile mutation, or custom session events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule, dshPackageJson } from '../../contracts/install-resolver.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
import { createBuiltinDescriptionPolicy } from '../../adapters/dsh/builtin-descriptions.mjs';
import { digestOf } from '../../domain/canonical.mjs';
import { captureExtraBuiltins } from '../helpers/capture-extra-builtins.mjs';

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/builtin-descriptions-rc3.json', import.meta.url), 'utf8'));
const raw = fixture.rows.find(row => row.wire.name === 'read_image').wire;
const compact = createBuiltinDescriptionPolicy({ enabled: true, locale: 'zh' }).project(raw);
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}

function registerInertTool(ctx, onCall, wire = raw) {
  const def = defineTool({ name: wire.name, description: wire.description,
    parameters: Object.fromEntries(Object.entries(wire.parameters.properties).map(([key, schema]) => [key, { ...schema, required: wire.parameters.required.includes(key) }])),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { onCall(); return 'fixture only: no image read'; },
  });
  assert.equal(digestOf({ name: def.name, description: def.description, parameters: def.parameters }), digestOf(wire));
  ctx.tools.register(def);
  return def;
}

for (const baseline of [false, true]) {
  test(`BCD1 ${baseline ? 'baseline' : 'loaded'}: actual requests, volatile update without reload, cold recovery`, async () => {
    store.reset();
    const config = { locale: 'zh', compactBuiltinToolDescriptions: true, initialToolsEnabled: baseline,
      alwaysVisible: baseline ? ['read_image'] : [], respectAlwaysVisible: true, alwaysAllowPresetTools: false };
    let boot = await bootAdapterComposition({ fixtures: ['mock-provider'], adapterSchema: true, omitStorage: true, adapter: config });
    let handle;
    let calls = 0;
    try {
      const original = registerInertTool(boot.ctx, () => { calls++; });
      handle = await boot.ctx.agents.create({ sessionId: `bcd-${baseline}`, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
      if (!baseline) queueResponse({ toolCalls: [{ id: 'bcd-load', name: 'tool_load', arguments: { names: ['read_image'] } }] });
      queueResponse({ toolCalls: [{ id: 'bcd-use', name: 'read_image', arguments: { file_path: 'inert.png' } }] });
      queueResponse({ text: 'done' });
      await turn(handle, 'Use the inert fixture.');
      assert.equal(calls, 1, 'the real guard admits a properly loaded compact definition');
      const before = store.requests.at(-1).tools;
      assert.deepEqual(before.find(wire => wire.name === 'read_image'), compact);
      assert.equal(boot.ctx.tools.get('read_image'), original, 'registry definition identity is untouched');
      assert.equal(original.description, raw.description);
      const service = boot.ctx.get('progressiveDiscovery');
      const entry = boot.adapterEntryState();
      assert.equal(entry.fiber.runtime.Config.dict.compactBuiltinToolDescriptions.meta.volatile, true);
      assert.equal(entry.fiber.runtime.Config.dict.compactBuiltinToolDescriptions.meta.default, false);
      await entry.update({ config: { ...entry.options.config, compactBuiltinToolDescriptions: false } });
      await boot.loader.await();
      assert.equal(boot.ctx.get('progressiveDiscovery'), service, 'updating the toggle cannot dispose the activation');
      queueResponse({ text: 'same epoch' }); await turn(handle, 'Again.');
      assert.deepEqual(store.requests.at(-1).tools, before);
      const root = boot.tmpRoot;
      await handle.dispose(); handle = undefined;
      await boot.closeServices();
      boot = await bootAdapterComposition({ tmpRoot: root, fixtures: ['mock-provider'], adapterSchema: true, omitStorage: true,
        adapter: { ...config, locale: 'en', compactBuiltinToolDescriptions: false } });
      registerInertTool(boot.ctx, () => { calls++; });
      handle = await boot.ctx.agents.resume({ resumeSessionId: `bcd-${baseline}`, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } });
      queueResponse({ toolCalls: [{ id: 'bcd-use-restored', name: 'read_image', arguments: { file_path: 'inert.png' } }] });
      queueResponse({ text: 'restored' }); await turn(handle, 'Resume.');
      assert.equal(calls, 2);
      assert.deepEqual(store.requests.at(-1).tools, before, 'all disclosed bytes survive a cold restart with reversed config');
    } finally { await handle?.dispose(); await boot.closeServices(); boot.dispose(); }
  });
}

test('BCD3 real automatic compaction adopts the saved toggle without stopping the request', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: ['mock-provider'], adapterSchema: true, omitStorage: true,
    adapter: { locale: 'zh', compactBuiltinToolDescriptions: true, alwaysVisible: ['read_image'], respectAlwaysVisible: true, alwaysAllowPresetTools: false },
    extraServices: [
      { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
        auto: true, thresholdRatio: 0.01, retainTokens: 128, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0,
      } },
    ],
  });
  let handle;
  const errors = [];
  const stop = boot.ctx.on('agent/error', payload => errors.push(payload.error));
  try {
    registerInertTool(boot.ctx, () => {});
    handle = await boot.ctx.agents.create({ sessionId: 'bcd-auto', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
    queueResponse({ text: 'Earlier inspection details. '.repeat(1000), usage: { inputTokens: 1000, outputTokens: 10000 } });
    // The selected old span must exceed the framed summary size; the large final
    // answer is retained by the host's tail policy and alone is not sufficient.
    await turn(handle, 'Inspect the earlier context before continuing. '.repeat(100));
    assert.deepEqual(store.requests.at(-1).tools.find(wire => wire.name === 'read_image'), compact);
    const service = boot.ctx.get('progressiveDiscovery');
    const entry = boot.adapterEntryState();
    await entry.update({ config: { ...entry.options.config, compactBuiltinToolDescriptions: false } });
    await boot.loader.await();
    const previous = store.requests.length;
    queueResponse({ text: 'Earlier inspection was summarized.' });
    queueResponse({ text: 'Continue with the compacted context.' });
    await turn(handle, 'Continue.');
    assert.ok(store.requests.slice(previous).some(request => request.purpose === 'compaction'));
    const history = await boot.ctx.sessionQuery.readSession('bcd-auto');
    assert.ok(history.events.some(event => event.type === 'compaction/end' && event.data.error === undefined),
      JSON.stringify(history.events.filter(event => event.type.startsWith('compaction/'))));
    assert.deepEqual(store.requests.at(-1).tools.find(wire => wire.name === 'read_image'), raw);
    assert.equal(boot.ctx.get('progressiveDiscovery'), service);
    assert.deepEqual(errors, []);
  } finally { stop(); await handle?.dispose(); await boot.closeServices(); boot.dispose(); }
});

test('BCD4 per-tool switches do not remount, survive restart, and adopt together after real compaction', async () => {
  store.reset();
  const extra = JSON.parse(readFileSync(new URL('../fixtures/builtin-descriptions-extra-rc3.json', import.meta.url), 'utf8'));
  const skill = extra.rows.find(row => row.wire.name === 'skill').wire;
  const config = { locale: 'zh', compactBuiltinToolDescriptions: true, compactBuiltinToolOverrides: { read_image: false, skill: true },
    initialToolsEnabled: false, alwaysAllowPresetTools: false };
  const options = { fixtures: ['mock-provider'], adapterSchema: true, omitStorage: true, adapter: config,
    extraServices: [
      { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0 } },
    ],
  };
  let boot = await bootAdapterComposition(options);
  let handle;
  let calls = 0;
  const register = () => { registerInertTool(boot.ctx, () => calls++); registerInertTool(boot.ctx, () => calls++, skill); };
  const queueUse = prefix => {
    queueResponse({ toolCalls: [{ id: `${prefix}-load`, name: 'tool_load', arguments: { names: ['read_image', 'skill'] } }] });
    queueResponse({ toolCalls: [
      { id: `${prefix}-image`, name: 'read_image', arguments: { file_path: 'inert.png' } },
      { id: `${prefix}-skill`, name: 'skill', arguments: { name: 'inert-skill' } },
    ] });
    queueResponse({ text: 'Earlier inspection details. '.repeat(500) });
  };
  try {
    register();
    handle = await boot.ctx.agents.create({ sessionId: 'bcd-switches', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
    queueUse('before');
    await turn(handle, 'Inspect the context before continuing. '.repeat(100));
    assert.equal(calls, 2);
    const before = store.requests.at(-1).tools;
    assert.deepEqual(before.find(wire => wire.name === 'read_image'), raw);
    assert.notEqual(before.find(wire => wire.name === 'skill').description, skill.description);
    const entry = boot.adapterEntryState();
    const service = boot.ctx.get('progressiveDiscovery');
    assert.equal(entry.fiber.runtime.Config.dict.compactBuiltinToolOverrides.meta.volatile, true);
    const overrides = { read_image: true, skill: false };
    await entry.update({ config: { ...entry.options.config, compactBuiltinToolOverrides: overrides } });
    await boot.loader.await();
    assert.equal(boot.ctx.get('progressiveDiscovery'), service);
    queueResponse({ text: 'same epoch' }); await turn(handle, 'Continue.');
    assert.deepEqual(store.requests.at(-1).tools, before);
    const root = boot.tmpRoot;
    await handle.dispose(); handle = undefined; await boot.closeServices();
    boot = await bootAdapterComposition({ ...options, tmpRoot: root, adapter: { ...config, locale: 'en', compactBuiltinToolOverrides: overrides } });
    register();
    handle = await boot.ctx.agents.resume({ resumeSessionId: 'bcd-switches', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } });
    queueResponse({ text: 'restored' }); await turn(handle, 'Resume.');
    assert.deepEqual(store.requests.at(-1).tools, before);
    queueResponse({ text: 'Continue the task.' });
    const result = await boot.ctx.get('compaction').compactNow(handle.agent, new AbortController().signal);
    assert.ok(result && result.shadowedSeqs.length > 0);
    queueUse('after'); await turn(handle, 'Use both fixtures again.');
    assert.equal(calls, 4);
    const after = store.requests.at(-1).tools;
    assert.notEqual(after.find(wire => wire.name === 'read_image').description, raw.description);
    assert.deepEqual(after.find(wire => wire.name === 'skill'), skill);
  } finally { await handle?.dispose(); await boot.closeServices(); boot.dispose(); }
});

test('BCD5 extended fixtures match current official rc.3 registrations', { skip: dshPackageJson('@deepseek-ai/dsh-tools').version !== '0.2.1-rc.3' }, async () => {
  const extra = JSON.parse(readFileSync(new URL('../fixtures/builtin-descriptions-extra-rc3.json', import.meta.url), 'utf8'));
  assert.deepEqual(await captureExtraBuiltins(), extra.rows);
});

test('BCD2 fixture fingerprints match official rc.3 registration variants, not invented schemas', { skip: dshPackageJson('@deepseek-ai/dsh-tools').version !== '0.2.1-rc.3' }, async () => {
  for (const row of fixture.rows) {
    const mod = await import(dshModule(row.package));
    const captured = [];
    const variant = row.variant;
    const ctx = { shell: { sandboxMode: variant.sandbox ? 'workspace-write' : undefined }, fs: {}, fiber: { state: 2 }, jobs: {},
      tools: { register: definition => { captured.push(definition); return () => {}; } },
      systemPrompt: { section() {}, getSectionOrder: () => 1 }, on: () => () => {}, effect: () => () => {},
      get: key => key === 'jobs' ? (variant.jobs ? {} : undefined) : key === 'sandboxPolicy' ? {} : undefined,
      inject: (keys, run) => { if (!keys.includes('jobs') || variant.jobs) run(ctx); return () => {}; },
    };
    mod.apply(ctx, mod.Config ? mod.Config({ ...(variant.promote === undefined ? {} : { promoteOnTimeout: variant.promote }) }) : {});
    const actual = captured.find(definition => definition.name === row.wire.name);
    assert.ok(actual, row.wire.name);
    assert.deepEqual({ name: actual.name, description: actual.description, parameters: actual.parameters }, row.wire);
  }
});
