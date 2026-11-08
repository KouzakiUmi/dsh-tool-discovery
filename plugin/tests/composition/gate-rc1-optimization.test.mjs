import test from 'node:test';
import assert from 'node:assert/strict';
import { executeToolCall } from './harness.mjs';
import { createAdmissionTracker } from '../../adapters/dsh/admission.mjs';
import { setup, agentFor, turn, call, queueResponse, store, payloadFor, registerTool } from './rc1-helpers.mjs';

async function entry(boot, agent, name, names, id = name) {
  const result = await executeToolCall(boot.ctx, { agent, name, arguments: { names }, callId: id, signal: new AbortController().signal });
  return JSON.parse(result.content.map(x => x.text ?? '').join(''));
}

test('rc.1 optimization: own-scope load cannot authorize another call in the same response', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-own-step');
  queueResponse({ toolCalls: [call('load-own', 'tool_load', { names: ['fixture_hidden_scope'] }), call('same-own', 'fixture_hidden_scope', { text: 'no' })] });
  queueResponse({ toolCalls: [call('next-own', 'fixture_hidden_scope', { text: 'yes' })] });
  queueResponse({ text: 'done' }); await turn(agent);
  assert.equal(store.bodyCount('same-own'), 0);
  assert.equal(store.bodyCount('next-own'), 1);
  assert.equal(payloadFor(agent, 'load-own').ok, true);
});

test('rc.1 optimization: own unload and reload in one response never restore step permission', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-own-reload');
  queueResponse({ toolCalls: [call('first-load', 'tool_load', { names: ['fixture_hidden_scope'] })] });
  queueResponse({ toolCalls: [call('revoke-own', 'tool_unload', { names: ['fixture_hidden_scope'] }), call('reload-own', 'tool_load', { names: ['fixture_hidden_scope'] }), call('same-reload', 'fixture_hidden_scope', { text: 'no' })] });
  queueResponse({ toolCalls: [call('next-reload', 'fixture_hidden_scope', { text: 'yes' })] });
  queueResponse({ text: 'done' }); await turn(agent);
  assert.equal(store.bodyCount('same-reload'), 0);
  assert.equal(store.bodyCount('next-reload'), 1);
});

test('rc.1 optimization: failed mixed unload preserves state; legal retry revokes real execution', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-atomic');
  const name = 'fixture_hidden_inherited', service = boot.ctx.get('progressiveDiscovery');
  await entry(boot, agent, 'tool_load', [name]);
  assert.equal((await entry(boot, agent, 'tool_unload', [name, 'tool_list'], 'invalid')).ok, false);
  assert.equal(service.sessions.get(agent.session.id).engine.selectedOf(agent.session.id).size, 1);
  assert.ok(service.tracker.get(agent.session.id, name));
  assert.equal((await entry(boot, agent, 'tool_unload', [name], 'valid')).ok, true);
  assert.equal(service.tracker.get(agent.session.id, name), undefined);
  const result = await executeToolCall(boot.ctx, { agent, name, arguments: { text: 'no' }, callId: 'revoked', signal: new AbortController().signal });
  assert.equal(result.isError, true);
});

test('rc.1 optimization: final unload deletes real durable snapshot, same-process resume stays revoked', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-revoke-durable');
  const name = 'fixture_hidden_inherited', service = boot.ctx.get('progressiveDiscovery');
  await entry(boot, agent, 'tool_load', [name]); await service.tracker.drain();
  const durable = service.tracker.holder.store;
  assert.equal(durable.get(agent.session.id).admissions.length, 1);
  await entry(boot, agent, 'tool_unload', [name]); await service.tracker.drain();
  assert.equal(durable.get(agent.session.id), undefined);
  const restored = createAdmissionTracker(); restored.holder.store = durable; restored.seedSession(agent.session.id);
  assert.equal(restored.admissionsFor(agent.session.id).size, 0); await restored.dispose();
});

test('rc.1 optimization: disposed session resumes admission in same activation', async t => {
  const boot = await setup(t);
  const handle = await boot.ctx.agents.create({ sessionId: 'opt-resume', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
  t.after(() => handle.dispose());
  const first = handle.agent;
  const name = 'fixture_hidden_inherited', service = boot.ctx.get('progressiveDiscovery');
  await entry(boot, first, 'tool_load', [name]); await service.tracker.drain();
  await handle.dispose();
  assert.equal(service.sessions.has(first.session.id), false);
  const resumed = await agentFor(t, boot, first.session.id);
  assert.ok(service.tracker.get(resumed.session.id, name));
  const result = await executeToolCall(boot.ctx, { agent: resumed, name, arguments: { text: 'yes' }, callId: 'resume-use', signal: new AbortController().signal });
  assert.equal(result.isError, false);
});

test('rc.1 optimization: volatile removal syncs engine, mask and guard before reload', async t => {
  const name = 'fixture_hidden_inherited';
  const boot = await setup(t, { adapterSchema: true, adapter: { alwaysVisible: [name], respectAlwaysVisible: true, alwaysAllowPresetTools: false } });
  const agent = await agentFor(t, boot, 'opt-volatile'), service = boot.ctx.get('progressiveDiscovery');
  const config = boot.adapterEntryState();
  await config.update({ config: { ...config.options.config, alwaysVisible: [] } }); await boot.loader.await();
  service.lifecycle.reconcileMask(agent.session.id);
  const result = await entry(boot, agent, 'tool_load', [name]);
  assert.deepEqual(result.data.loaded, [name]);
  assert.ok(service.tracker.get(agent.session.id, name));
  assert.ok(boot.ctx.tools.get(name, agent));
  await entry(boot, agent, 'tool_unload', [name]);
  await config.update({ config: { ...config.options.config, alwaysVisible: [name] } }); await boot.loader.await();
  service.lifecycle.reconcileMask(agent.session.id);
  assert.equal((await entry(boot, agent, 'tool_unload', [name], 'protected')).ok, false);
});

test('rc.1 optimization: disabled initial injection also gates own core-name tools', async t => {
  const boot = await setup(t, { adapter: { initialToolsEnabled: false, alwaysAllowPresetTools: false } });
  const agent = await agentFor(t, boot, 'opt-own-core');
  let executions = 0;
  const remove = await registerTool(agent.ctx, 'read', 'own core fixture', () => { executions++; return 'ok'; }); t.after(remove);
  const result = await executeToolCall(boot.ctx, { agent, name: 'read', arguments: {}, callId: 'guess-core', signal: new AbortController().signal });
  assert.equal(result.isError, true); assert.equal(executions, 0);
  await entry(boot, agent, 'tool_load', ['read']);
  const loaded = await executeToolCall(boot.ctx, { agent, name: 'read', arguments: {}, callId: 'use-core', signal: new AbortController().signal });
  assert.equal(loaded.isError, false); assert.equal(executions, 1);
});

test('rc.1 optimization: late real storage attach cannot resurrect an unloaded name', async t => {
  const boot = await setup(t, { omitStorage: true });
  const agent = await agentFor(t, boot, 'opt-late-revoke');
  const service = boot.ctx.get('progressiveDiscovery'), name = 'fixture_hidden_inherited';
  const target = [...service.sessions.get(agent.session.id).engine.getCatalog().entries.values()].find(x => x.name === name);
  const records = new Map([[agent.session.id, { sessionId: agent.session.id, admissions: [{ name, toolId: target.toolId, schemaDigest: target.schemaDigest, at: 1 }] }]]);
  let release, entered;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const remove = boot.ctx.provide('storageDomain', { open: async () => {
    entered(); await gate;
    return { table: () => ({ get: id => records.get(id), keys: () => records.keys(), put: async (id, record) => records.set(id, record), delete: async id => records.delete(id) }), close: async () => {} };
  } });
  t.after(() => { release(); remove?.(); });
  await started;
  assert.equal((await entry(boot, agent, 'tool_unload', [name])).ok, true);
  release(); await service.tracker.holder.store.ensureOpen(); await service.tracker.drain();
  assert.equal(service.tracker.get(agent.session.id, name), undefined);
  assert.equal(records.has(agent.session.id), false);
  assert.equal(boot.ctx.tools.get(name, agent), undefined);
});

test('rc.1 optimization: immediate plugin disposal drains queued real durable write', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-dispose-drain');
  const service = boot.ctx.get('progressiveDiscovery'), durable = service.tracker.holder.store;
  await durable.ensureOpen();
  let saved;
  const put = durable.put.bind(durable);
  durable.put = async record => { await put(record); saved = record; };
  const runtime = service.sessions.get(agent.session.id);
  const loaded = await runtime.engine.handleLoad({ names: ['fixture_hidden_inherited'] }, runtime.scope);
  service.lifecycle.commitAdmissions(runtime, loaded.admitted);
  await boot.adapterEntryState().fiber.dispose();
  assert.equal(saved?.admissions[0].name, 'fixture_hidden_inherited');
  assert.equal(durable.status, 'closed');
  assert.equal(service.sessions.size, 0);
});

test('rc.1 optimization: entry unload committed during disposal drains revocation before close', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-dispose-revoke');
  const service = boot.ctx.get('progressiveDiscovery'), name = 'fixture_hidden_inherited';
  await entry(boot, agent, 'tool_load', [name]); await service.tracker.drain();
  const runtime = service.sessions.get(agent.session.id), durable = service.tracker.holder.store;
  let release, entered;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const unload = runtime.engine.handleUnload.bind(runtime.engine);
  runtime.engine.handleUnload = async (...args) => { const result = await unload(...args); entered(); await gate; return result; };
  let revoked = false;
  const remove = durable.remove.bind(durable);
  durable.remove = async id => { await remove(id); revoked = true; };
  const pending = boot.ctx.tools.get('tool_unload').execute({ names: [name] }, { agent });
  await started;
  const disposing = boot.adapterEntryState().fiber.dispose();
  release(); await pending; await disposing;
  assert.equal(revoked, true, 'already committed unload continuation must reach durable delete');
  assert.equal(durable.status, 'closed');
  assert.equal(service.sessions.size, 0);
});

test('rc.1 optimization: pure mask churn never refreshes catalogs or retains released filters', async t => {
  const boot = await setup(t), agent = await agentFor(t, boot, 'opt-mask-churn');
  const service = boot.ctx.get('progressiveDiscovery');
  let refreshed = 0; const original = service.lifecycle.onRegistryChange;
  service.lifecycle.onRegistryChange = (...args) => { refreshed++; return original(...args); };
  for (let i = 0; i < 20; i++) {
    await entry(boot, agent, 'tool_load', ['fixture_hidden_inherited'], `load-${i}`);
    await entry(boot, agent, 'tool_unload', ['fixture_hidden_inherited'], `unload-${i}`);
  }
  await service.tracker.drain();
  assert.equal(refreshed, 0);
  assert.equal(service.mask.filtersFor(agent).size, 1);
  assert.equal([...boot.ctx.tools.layers.peek(agent).restrictions.values()].length, 1);
});
