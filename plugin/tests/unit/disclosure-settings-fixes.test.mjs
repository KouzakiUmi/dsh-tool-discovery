import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, commitLoad } from './helpers.mjs';
import { createGuard } from '../../adapters/dsh/guard.mjs';
import { createProjection } from '../../adapters/dsh/projection.mjs';
import { createJournal } from '../../adapters/dsh/journal.mjs';

const wire = (name, description = 'old') => ({ name, description, parameters: { type: 'object', properties: {} } });

function harness() {
  const listeners = new Map();
  const runtime = {
    scope: SCOPE_A, restoring: false, compositionBypass: null, requireTrustedEpoch: false,
    initialToolsEnabled: false, alwaysNameSet: new Set(['baseline']),
    engine: { getState: () => ({ mode: 'ready', selected: new Map() }), getFrozenWire: () => [] },
    journal: { pendingLoadNames: () => new Set(), currentRequestId: () => 'r1' },
  };
  const ctx = { on: (name, fn) => { listeners.set(name, fn); return () => {}; },
    tools: { modeFor: () => 'native', get: (name) => ({ name }), guard: (fn) => { listeners.set('guard', fn); return () => {}; } } };
  const lifecycle = { runtimeFor: () => runtime };
  const agent = { session: { id: SCOPE_A.sessionId } };
  createProjection({ ctx, lifecycle });
  return { ctx, runtime, lifecycle, agent, project: async (tools) => listeners.get('system-prompt/assemble')({}, { agent }, async () => ({ tools })), listeners };
}

function journalFor(engine, extra = {}) {
  return createJournal({ engine, scope: SCOPE_A, session: { id: SCOPE_A.sessionId, inheritedEventCount: 0 }, alwaysVisible: ['baseline'], ...extra });
}

const header = (seq, tools) => ({ seq, type: 'request/header', data: { header: { tools } } });
const compact = (start = 1, error) => [
  { seq: start, type: 'compaction/start', data: { compactionId: 'compact', turn: null } },
  { seq: start + 1, type: 'compaction/summary', data: { compactionId: 'compact', turn: null } },
  { seq: start + 2, type: 'compaction/end', data: { compactionId: 'compact', turn: null, ...(error === undefined ? {} : { error }) } },
];

test('DF1 engine forwards pendingLoad without granting execution', async () => {
  const { engine } = await makeEngine();
  const result = engine.evaluateCall(SCOPE_A, { name: 'read_file', pendingLoad: true });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'TOOL_NOT_ADVERTISED');
  assert.equal(result.visibility, 'pending-fold');
  assert.equal(engine.evaluateCall(SCOPE_A, { name: 'read_file' }).code, 'TOOL_NOT_LOADED');
});

test('DF2 disabled initial injection rejects guessed core names without changing baseline', async () => {
  const h = harness();
  const { engine } = await makeEngine();
  h.runtime.engine = engine;
  createGuard({ ctx: h.ctx, lifecycle: h.lifecycle });
  const before = [...h.runtime.alwaysNameSet];
  assert.match(h.listeners.get('guard')({ name: 'read', agent: h.agent }), /TOOL_NOT_LOADED/);
  assert.deepEqual([...h.runtime.alwaysNameSet], before);
  h.runtime.initialToolsEnabled = true;
  assert.equal(h.listeners.get('guard')({ name: 'read', agent: h.agent }), undefined);
});

test('DF3 actual header freezes baseline bytes and order; preview does not freeze', async () => {
  const h = harness();
  const { engine } = await makeEngine();
  h.runtime.journal = journalFor(engine, { alwaysVisibleProvider: () => h.runtime.alwaysNameSet });
  h.runtime.alwaysNameSet.add('second');
  await h.project([wire('baseline', 'preview')]);
  h.runtime.journal.onEvent(header(0, [wire('baseline'), wire('second')]));
  const projected = await h.project([wire('second', 'changed'), wire('baseline', 'changed')]);
  assert.deepEqual(projected.tools, [wire('baseline'), wire('second')]);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, 'header wire never confers selection authority');
});

test('DF4 failed compaction preserves baseline freeze; success releases it', async () => {
  const h = harness();
  const { engine } = await makeEngine();
  h.runtime.journal = journalFor(engine);
  h.runtime.journal.onEvent(header(0, [wire('baseline')]));
  for (const event of compact(1, 'failed')) h.runtime.journal.onEvent(event);
  assert.equal((await h.project([wire('baseline', 'new')])).tools[0].description, 'old');
  for (const event of compact(4)) h.runtime.journal.onEvent(event);
  assert.equal((await h.project([wire('baseline', 'new')])).tools[0].description, 'new');
});

test('DF6 fork inherited header never freezes child baseline wire', async () => {
  const { engine } = await makeEngine();
  const h = harness();
  const events = [header(0, [wire('baseline', 'parent')]), header(1, [wire('baseline', 'child')])];
  h.runtime.journal = journalFor(engine, { session: { id: SCOPE_A.sessionId, inheritedEventCount: 1 },
    query: { readSession: async () => ({ inheritedEventCount: 1, events }) } });
  await h.runtime.journal.restore();
  assert.deepEqual((await h.project([wire('baseline', 'changed')])).tools, [wire('baseline', 'child')]);
});

test('DF7 later baseline additions append after already disclosed selected tools', async () => {
  const { engine } = await makeEngine();
  const h = harness(); h.runtime.engine = engine;
  h.runtime.journal = journalFor(engine, { alwaysVisibleProvider: () => h.runtime.alwaysNameSet });
  assert.equal((await commitLoad(engine, SCOPE_A, { names: ['read_file'] })).applied, true);
  // Use the catalog's real definition so advertised validation is not a no-op.
  const loadedWire = [...engine.getCatalog().entries.values()].find(e => e.name === 'read_file').wire;
  h.runtime.journal.onEvent(header(0, [wire('baseline'), loadedWire]));
  h.runtime.alwaysNameSet.add('new_baseline');
  const projected = await h.project([wire('new_baseline'), loadedWire, wire('baseline', 'changed')]);
  assert.deepEqual(projected.tools.map(t => t.name), ['baseline', 'read_file', 'new_baseline']);
  assert.deepEqual(projected.tools.slice(0, 2), [wire('baseline'), loadedWire]);
});

test('DF5 cold recovery freezes only own current-epoch header bytes, never header authorization', async () => {
  const { engine } = await makeEngine();
  const events = [header(0, [wire('baseline', 'previous')]), ...compact(1), header(4, [wire('hidden'), wire('baseline', 'current')])];
  const h = harness();
  h.runtime.journal = journalFor(engine, { query: { readSession: async () => ({ inheritedEventCount: 0, events }) } });
  assert.equal((await h.runtime.journal.restore()).mode, 'ready');
  const projected = await h.project([wire('hidden'), wire('baseline', 'changed')]);
  assert.deepEqual(projected.tools, [wire('baseline', 'current')]);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('DF8 non-native admits the transport and the preset baseline, not every name', () => {
  const listeners = new Map();
  const runtime = {
    scope: SCOPE_A, restoring: false, compositionBypass: null, requireTrustedEpoch: false,
    initialToolsEnabled: true, alwaysNameSet: new Set(['preset_only']),
    engine: { evaluateCall: () => ({ allowed: false, reason: 'not loaded', code: 'TOOL_NOT_LOADED', visibility: 'hidden' }) },
    journal: { pendingLoadNames: () => new Set(), currentRequestId: () => 'r1' },
  };
  const ctx = {
    tools: {
      modeFor: () => 'ptc',
      get: (name) => ({ name }),
      guard: (fn) => { listeners.set('guard', fn); return () => {}; },
    },
  };
  createGuard({
    ctx,
    lifecycle: { runtimeFor: () => runtime },
    log: () => {},
    ptcEnabled: () => true,
    sdkNames: () => ['preset_only', 'tool_list'],
  });
  const agent = { session: { id: SCOPE_A.sessionId } };
  const guard = listeners.get('guard');
  assert.equal(guard({ name: 'run_code', agent }), undefined);
  assert.equal(guard({ name: 'tool_list', agent }), undefined);
  assert.equal(guard({ name: 'preset_only', agent }), undefined);
  assert.match(guard({ name: 'hidden_tool', agent }), /TOOL_NOT_LOADED/);
});

test('DF9 PTC compatibility off bypasses the guard', () => {
  const listeners = new Map();
  let created = 0;
  const ctx = {
    tools: {
      modeFor: () => 'ptc',
      get: (name) => ({ name }),
      guard: (fn) => { listeners.set('guard', fn); return () => {}; },
    },
  };
  createGuard({
    ctx,
    lifecycle: { runtimeFor: () => { created += 1; return {}; } },
    ptcEnabled: () => false,
  });
  const agent = { session: { id: 's' } };
  assert.equal(listeners.get('guard')({ name: 'hidden_tool', agent }), undefined);
  assert.equal(created, 0);
});
