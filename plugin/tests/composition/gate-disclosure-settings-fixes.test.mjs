// Real Loader + disposable sessions + mock provider; never writes a real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
const fixtures = ['mock-provider', 'inherited-tools', 'scope-tools'];
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
async function create(boot, id) {
  return boot.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
}
function compact(session) {
  session.append('compaction/start', { compactionId: 'df-reset', turn: null });
  session.append('compaction/summary', { compactionId: 'df-reset', summary: 'Summary', shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokenCount: 0 });
  session.append('compaction/end', { compactionId: 'df-reset', turn: null });
}

test('DS1 real core tool cannot bypass disabled initial injection; ordinary load still works', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures, adapterSchema: true,
    adapter: { initialToolsEnabled: false, alwaysAllowPresetTools: false } });
  let handle;
  let body = 0;
  try {
    boot.ctx.tools.register(defineTool({ name: 'read', description: 'Core-name test fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => { body += 1; return 'read'; } }));
    handle = await create(boot, 'ds-core');
    queueResponse({ text: 'baseline' }); await turn(handle, 'Begin.');
    assert.deepEqual(store.requests[0].tools.map(t => t.name).sort(), ['tool_list', 'tool_load', 'tool_search']);
    const exec = id => boot.ctx.tools.execute({ agent: handle.agent, name: 'read', callId: id, arguments: {}, signal: new AbortController().signal });
    assert.equal((await exec('ds-guess')).isError, true);
    assert.equal(body, 0);
    const runtime = boot.ctx.get('progressiveDiscovery').sessions.get('ds-core');
    assert.equal(runtime.alwaysNameSet.has('read'), false);
    const entry = boot.loader.entries().find(e => e.id === 'progressive-discovery');
    await entry.update({ config: { ...entry.options.config, initialToolsEnabled: true } });
    await boot.loader.await();
    assert.equal(runtime.initialToolsEnabled, false, 'volatile change cannot alter guard mid-epoch');
    assert.equal((await exec('ds-mid-epoch')).isError, true);
    queueResponse({ toolCalls: [{ id: 'ds-load', name: 'tool_load', arguments: { names: ['read'] } }] });
    queueResponse({ toolCalls: [{ id: 'ds-use', name: 'read', arguments: {} }] });
    queueResponse({ text: 'done' }); await turn(handle, 'Load and use read.');
    assert.equal(body, 1);
    compact(handle.agent.session);
    assert.equal(runtime.initialToolsEnabled, true, 'success compaction adopts current switch');
    assert.equal(runtime.alwaysNameSet.has('read'), true);
  } finally { await handle?.dispose(); await boot.closeServices(); boot.dispose(); }
});

test('DS2 actual outbound baseline is frozen across schema change and cold restart; compact adopts new wire', async () => {
  store.reset();
  const name = 'fixture_hidden_inherited';
  const config = { alwaysVisible: [name], alwaysAllowPresetTools: false, respectAlwaysVisible: true };
  let boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: config });
  let handle;
  try {
    handle = await create(boot, 'ds-baseline');
    queueResponse({ text: 'first' }); await turn(handle, 'First.');
    const first = JSON.stringify(store.requests.at(-1).tools);
    const definition = boot.ctx.tools.get(name, handle.agent);
    definition.description = 'CHANGED baseline definition';
    queueResponse({ text: 'changed' }); await turn(handle, 'Again.');
    assert.equal(JSON.stringify(store.requests.at(-1).tools), first);
    const root = boot.tmpRoot;
    await handle.dispose(); handle = null;
    await boot.closeServices();
    boot = await bootAdapterComposition({ tmpRoot: root, fixtures, adapterSchema: true, adapter: config });
    boot.ctx.tools.get(name).description = 'NEW after restart';
    handle = await boot.ctx.agents.resume({ resumeSessionId: 'ds-baseline', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } });
    queueResponse({ text: 'restored' }); await turn(handle, 'Continue.');
    assert.equal(JSON.stringify(store.requests.at(-1).tools), first, 'cold restore preserves own baseline bytes, not current registry bytes');
    compact(handle.agent.session);
    queueResponse({ text: 'new epoch' }); await turn(handle, 'Next epoch.');
    assert.equal(store.requests.at(-1).tools.find(t => t.name === name).description, 'NEW after restart');
  } finally { await handle?.dispose(); await boot.closeServices(); boot.dispose(); }
});
