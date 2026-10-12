// Real Loader/fiber lifecycle; isolated roots and mock-only provider calls; no real profile/provider.
// Deferred query/store I/O is injected to make late completion deterministic, not a claim of natural HMR timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const bootOptions = (adapter = {}) => ({
  fixtures: ['mock-provider'], omitStorage: true,
  adapter: { locale: 'en', alwaysAllowPresetTools: false, ...adapter },
});
async function create(boot, id) {
  return boot.ctx.agents.create({ sessionId: id,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
}
function observeDisposal(runtime) {
  const calls = { engine: 0, journal: 0, ledger: 0 };
  for (const name of Object.keys(calls)) {
    const original = runtime[name].dispose;
    runtime[name].dispose = function (...args) {
      calls[name] += 1;
      return original.apply(this, args);
    };
  }
  return calls;
}
function assertReleased(boot, service, calls) {
  assert.equal(boot.ctx.get('progressiveDiscovery'), undefined, 'Cordis removes the provided service');
  for (const name of ['tool_list', 'tool_search', 'tool_load']) {
    assert.equal(boot.ctx.tools.get(name), undefined, 'Cordis removes each registered entry');
  }
  assert.equal(service.sessions.size, 0, 'plugin must release its own runtimes, not only Cordis registrations');
  assert.deepEqual(calls, { engine: 1, journal: 1, ledger: 1 });
}
async function assertUsable(boot, agent, callId) {
  const message = await boot.ctx.tools.execute({ agent, name: 'tool_list', callId,
    arguments: {}, signal: new AbortController().signal });
  assert.notEqual(message.isError, true);
  const text = message.content.map(block => block.text ?? '').join('');
  assert.equal(JSON.parse(text).ok, true, 'remounted plugin must remain usable');
}

test('PD1 real fiber disposal releases owned runtime once; a new plugin fiber remains usable', async () => {
  const boot = await bootAdapterComposition(bootOptions());
  let handle;
  let service;
  try {
    handle = await create(boot, 'pd-ready');
    service = boot.ctx.get('progressiveDiscovery');
    const runtime = service.lifecycle.ensureRuntime(handle.agent.session, handle.agent);
    await service.whenReady(handle.agent.session.id);
    await assertUsable(boot, handle.agent, 'pd-before');
    const calls = observeDisposal(runtime);
    const entry = boot.adapterEntryState();
    await entry.fiber.dispose();
    assertReleased(boot, service, calls);
    await entry.fiber.dispose();
    service.lifecycle.dispose();
    assert.deepEqual(calls, { engine: 1, journal: 1, ledger: 1 }, 'repeat disposal has no duplicate owned cleanup');

    const spec = boot.specs.find(item => item.id === 'progressive-discovery');
    // Loader marks the old entry's shared options disabled on direct fiber disposal.
    await boot.loader.create({ ...spec, disabled: false, id: 'progressive-discovery-remounted' });
    await boot.loader.await();
    const remountedEntry = boot.loader.entries().find(item => item.id === 'progressive-discovery-remounted');
    await remountedEntry.fiber.await();
    const remounted = boot.ctx.get('progressiveDiscovery');
    assert.ok(remounted, JSON.stringify({ entries: Array.from(boot.entryStates()), errors: boot.activationErrors() }));
    assert.notEqual(remounted, service);
    await assertUsable(boot, handle.agent, 'pd-after');
    assert.equal(remounted.sessions.size, 1);
    await boot.loader.entries().find(item => item.id === 'progressive-discovery-remounted').fiber.dispose();
    assert.equal(remounted.sessions.size, 0);
  } finally {
    service?.lifecycle.dispose();
    await handle?.dispose();
    await boot.closeServices();
    boot.dispose();
  }
});

test('PD2 unloading during a pending cold read cannot restore the old engine to ready', async () => {
  const boot = await bootAdapterComposition(bootOptions());
  const gate = deferred();
  let handle;
  let service;
  let runtime;
  let originalRead;
  const query = boot.ctx.get('sessionQuery');
  try {
    handle = await create(boot, 'pd-read');
    const event = handle.agent.session.append('request/header', { header: {} });
    originalRead = query.readSession;
    query.readSession = async () => {
      await gate.promise;
      return { inheritedEventCount: 0, events: [event] };
    };
    service = boot.ctx.get('progressiveDiscovery');
    runtime = service.lifecycle.ensureRuntime(handle.agent.session, handle.agent);
    assert.equal(runtime.restoring, true);
    const calls = observeDisposal(runtime);
    await boot.adapterEntryState().fiber.dispose();
    gate.resolve();
    const outcome = await runtime.restorePromise;
    assertReleased(boot, service, calls);
    assert.notEqual(outcome.mode, 'ready');
    assert.notEqual(runtime.engine.getState(runtime.scope).mode, 'ready');
  } finally {
    gate.resolve();
    await runtime?.restorePromise;
    if (originalRead !== undefined) query.readSession = originalRead;
    service?.lifecycle.dispose();
    await handle?.dispose();
    await boot.closeServices();
    boot.dispose();
  }
});

test('PD3 unloading during a pending epoch put closes the store and cannot revive trusted authorization', async () => {
  const boot = await bootAdapterComposition(bootOptions({ requireTrustedEpoch: true }));
  const gate = deferred();
  let handle;
  let service;
  let runtime;
  let putStarted = false;
  let storeClosed = false;
  try {
    // Real adapter/store/ledger code and SDK domain declaration, but deliberately fake I/O.
    boot.ctx.provide('storageDomain', { open: async () => ({
      table: () => ({ get: () => undefined, put: async () => { putStarted = true; await gate.promise; } }),
      close: async () => { storeClosed = true; },
    }) });
    await boot.loader.await();
    handle = await create(boot, 'pd-put');
    service = boot.ctx.get('progressiveDiscovery');
    runtime = service.lifecycle.ensureRuntime(handle.agent.session, handle.agent);
    for (let i = 0; i < 200 && !putStarted; i++) await Promise.resolve();
    assert.equal(putStarted, true, 'positive control: initial epoch put has actually started');
    assert.equal(runtime.ledger.state, 'pending');
    assert.equal(runtime.ledger.inFlight, true);
    const calls = observeDisposal(runtime);
    await boot.adapterEntryState().fiber.dispose();
    gate.resolve();
    await runtime.restorePromise;
    assertReleased(boot, service, calls);
    assert.equal(storeClosed, true, 'Cordis-owned store effect remains properly closed');
    assert.notEqual(runtime.ledger.state, 'trusted');
    assert.notEqual(runtime.engine.getState(runtime.scope).mode, 'ready');
    assert.deepEqual(runtime.alwaysNames, []);
  } finally {
    gate.resolve();
    await runtime?.restorePromise;
    service?.lifecycle.dispose();
    await handle?.dispose();
    await boot.closeServices();
    boot.dispose();
  }
});

async function bounded(pending, label) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
function assertDisposedError(errors) {
  assert.ok(errors.some(error => error?.code === 'STATE_NOT_READY' && /disposed|卸载/i.test(error.message)),
    'the old request must fail explicitly as disposed, not silently send a reduced request');
}

for (const seam of ['agent/pre-step', 'system-prompt/assemble']) {
  test(`PD4/5 ${seam}: restart rejects an old waiting request; the new activation sends normally`, async () => {
    const boot = await bootAdapterComposition(bootOptions());
    const entered = deferred();
    const gate = deferred();
    let handle;
    let remove;
    const errors = [];
    const stopErrors = boot.ctx.on('agent/error', payload => errors.push(payload.error));
    try {
      remove = boot.ctx.on(seam, async (...args) => {
        const next = args.at(-1);
        const result = await next();
        entered.resolve();
        await gate.promise;
        return result;
      });
      store.reset();
      queueResponse({ text: 'old request must not send' });
      handle = await create(boot, `pd-wait-${seam}`);
      const oldService = boot.ctx.get('progressiveDiscovery');
      const idle = turn(handle, 'Start an old request.');
      await bounded(entered.promise, 'old waterfall entered');
      assert.equal(store.requests.length, 0);
      const expected = seam === 'agent/pre-step' ? 1 : 0;
      assert.equal(oldService.sessions.size, expected, 'positive control: exact assembly/pre-step placement');
      await boot.adapterEntryState().fiber.restart();
      assert.equal(oldService.sessions.size, 0);
      const fresh = boot.ctx.get('progressiveDiscovery');
      assert.ok(fresh);
      assert.notEqual(fresh, oldService);
      await bounded(idle, 'old request stops before downstream gate is released');
      assertDisposedError(errors);
      gate.resolve();
      await Promise.resolve();
      assert.equal(store.requests.length, 0, 'no old schemas may reach the mock provider after restart');
      assert.equal(oldService.sessions.size, 0, 'old projection cannot recreate a runtime');
      remove(); remove = undefined;
      store.reset();
      queueResponse({ text: 'new activation works' });
      await bounded(turn(handle, 'Retry on the new activation.'), 'fresh request');
      assert.equal(store.requests.length, 1);
      assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['tool_list', 'tool_load', 'tool_search']);
      assert.equal(fresh.sessions.size, 1);
    } finally {
      gate.resolve();
      remove?.(); stopErrors();
      await handle?.dispose();
      await boot.closeServices();
      boot.dispose();
    }
  });
}

test('PD6 pending cold restore: disposal stops the old request without waiting for query I/O', async () => {
  const boot = await bootAdapterComposition(bootOptions());
  const entered = deferred();
  const gate = deferred();
  const errors = [];
  const stopErrors = boot.ctx.on('agent/error', payload => errors.push(payload.error));
  const query = boot.ctx.get('sessionQuery');
  const originalRead = query.readSession;
  let handle;
  let runtime;
  try {
    handle = await create(boot, 'pd-wait-cold-read');
    const event = handle.agent.session.append('request/header', { header: {} });
    query.readSession = async () => {
      entered.resolve();
      await gate.promise;
      return { inheritedEventCount: 0, events: [event] };
    };
    store.reset(); queueResponse({ text: 'blocked old read' });
    const service = boot.ctx.get('progressiveDiscovery');
    const idle = turn(handle, 'Recover and send.');
    await bounded(entered.promise, 'query entered');
    runtime = service.sessions.get(handle.agent.session.id);
    assert.ok(runtime?.restoring);
    assert.equal(store.requests.length, 0);
    await boot.adapterEntryState().fiber.dispose();
    await bounded(idle, 'old request stops before read resolves');
    assertDisposedError(errors);
    assert.equal(store.requests.length, 0);
    gate.resolve(); await runtime.restorePromise;
    assert.equal(service.sessions.size, 0);
    assert.equal(store.requests.length, 0);
  } finally {
    gate.resolve(); await runtime?.restorePromise;
    query.readSession = originalRead;
    stopErrors();
    await handle?.dispose();
    await boot.closeServices();
    boot.dispose();
  }
});
