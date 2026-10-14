import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtcDisclosure } from '../../adapters/dsh/ptc-sdk.mjs';
import { makeEngine, SCOPE_A, commitLoad } from './helpers.mjs';

async function setup(t, language = 'typescript') {
  const { engine } = await makeEngine();
  const agent = { id: 'actor', session: { id: SCOPE_A.sessionId } };
  const journal = { records: [], recordSdkAdvertisements(records) { this.records.push(...records); } };
  const runtime = { scope: SCOPE_A, agentScope: agent, engine, journal,
    alwaysNameSet: new Set(['read_file']), compositionBypass: null };
  const branded = new WeakSet();
  const schemas = () => [...engine.getCatalog().entries.values()].map((entry) => ({ ...entry.wire, output: { type: 'string' } }));
  const ctx = { get: () => ({ language }), tools: {
    modeFor: () => 'ptc', sdkSchemas: schemas,
    restrict: () => { throw new Error('must not restrict host permissions'); },
  } };
  let enabled = true;
  const ptc = createPtcDisclosure({ ctx, lifecycle: { sessions: new Map([[SCOPE_A.sessionId, runtime]]) },
    enabled: () => enabled, renderToolsSdk: (items) => `TS:${JSON.stringify(items)}`,
    renderToolsSdkPy: (items) => `PY:${JSON.stringify(items)}`, isAgentLoopRequest: (request) => branded.has(request) });
  const assembly = { sections: [{ name: 'tools:sdk', text: 'full SDK' }], tools: [{ name: 'run_code' }] };
  const request = (text, mark = true) => {
    const value = { sessionId: SCOPE_A.sessionId, messages: [{ role: 'system', content: [{ type: 'text', text }] }] };
    if (mark) branded.add(value);
    return value;
  };
  t.after(() => engine.dispose());
  return { ptc, agent, runtime, engine, journal, ctx, assembly, request, disable: () => { enabled = false; } };
}

test('PTC SDK 投影只披露基线和有效 selected，不改宿主资格目录', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  const items = JSON.parse(text.slice(3));
  assert.deepEqual(items.map((item) => item.name).sort(), ['glob', 'read_file', 'tool_list', 'tool_load', 'tool_search']);
  assert.equal(h.ctx.tools.sdkSchemas().some((item) => item.name === 'grep'), true);
  assert.equal(h.assembly.sections[0].text, 'full SDK');
  assert.equal(h.journal.records.length, 0, 'assemble 不算曝光');
  h.ptc.observeRequest(h.request(text, false));
  assert.equal(h.journal.records.length, 0, '伪造的 preview 请求不算曝光');
  h.ptc.observeRequest(h.request(text));
  assert.equal(h.journal.records[0].name, 'glob');
});

test('首次 load 不能追认旧 SDK：必须等包含它的新投影真正出站', async (t) => {
  const h = await setup(t);
  const old = h.ptc.project(h.agent, h.assembly, h.runtime);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  h.ptc.observeRequest(h.request(old.sections[0].text));
  assert.equal(h.journal.records.length, 0);
  const fresh = h.ptc.project(h.agent, h.assembly, h.runtime);
  h.ptc.observeRequest(h.request(fresh.sections[0].text));
  assert.deepEqual(h.journal.records.map((record) => record.name), ['glob']);
});

test('PTC 只认最新 system SDK，旧节点/用户复制/周期漂移都不能授信', async (t) => {
  const h = await setup(t);
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const mismatch = h.request(projected.sections[0].text);
  mismatch.messages.push({ role: 'system', content: [{ type: 'text', text: 'replaced SDK' }] });
  mismatch.messages.push({ role: 'user', content: [{ type: 'text', text: projected.sections[0].text }] });
  assert.throws(() => h.ptc.observeRequest(mismatch), /does not match/);
  h.engine.resetCacheEpoch(SCOPE_A);
  assert.throws(() => h.ptc.observeRequest(h.request(projected.sections[0].text)), /does not match/);
  assert.equal(h.journal.records.length, 0);
});

test('PTC off 不观测；Python 使用宿主 Python 渲染契约；缺 SDK section 明确拒绝', async (t) => {
  const h = await setup(t, 'python');
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  assert.match(projected.sections[0].text, /^PY:/);
  h.disable();
  assert.doesNotThrow(() => h.ptc.observeRequest(h.request('not the SDK')));
  assert.throws(() => h.ptc.project(h.agent, { sections: [] }, h.runtime), /exactly one/);
});
