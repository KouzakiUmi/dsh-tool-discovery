// 设计契约回归：rc.1 的披露/执行链路必须整体一致。
//
// 旧文件用 journal/projection 的快照与回放断言“冻结 wire”。rc.1 删除了这两个
// 子系统（docs/14-rc1-redesign.md），等价的产品目标改由三层共同保证：
//   1. admission tracker：会话级准入表 + durable 快照（admission.mjs）；
//   2. mask：allow = 入口四件 ∪ frameworkRetained ∪ alwaysVisible ∪ admitted，
//      经 restrictableNames 过滤（mask.mjs）；
//   3. guard：admitted 且当前 schemaDigest 一致才放行（guard.mjs）。
// 本文件把这些不变量钉在真实模块接缝上，而不是伪造事件流。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionTracker, createAdmissionStoreHandle } from '../../adapters/dsh/admission.mjs';
import { createMaskController } from '../../adapters/dsh/mask.mjs';
import { createGuard } from '../../adapters/dsh/guard.mjs';
import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs';
import {
  makeEngine, binding, sampleBindings, CATEGORY_CONFIG, fakeClock, fakeRandom, loadTools,
} from './helpers.mjs';

const SESSION = 'sess_di';

// ---------------------------------------------------------------------------
// admission tracker：会话隔离、resume 读回、撤销与清理
// ---------------------------------------------------------------------------

test('AD1 admitted 行按会话隔离，revoke/prune/dropSession 语义明确', () => {
  const tracker = createAdmissionTracker();
  const row = { name: 'glob', toolId: 't_glob', schemaDigest: 'sha256:glob', at: 1 };
  tracker.admit(SESSION, row);
  tracker.admit('other', { ...row, name: 'grep' });

  assert.deepEqual([...tracker.admissionsFor(SESSION).keys()], ['glob']);
  assert.deepEqual([...tracker.admissionsFor('other').keys()], ['grep']);
  assert.equal(tracker.get(SESSION, 'glob').toolId, 't_glob');
  assert.equal(tracker.get(SESSION, 'grep'), undefined, '别的会话的准入不泄漏');

  assert.equal(tracker.revoke(SESSION, 'glob'), true);
  assert.equal(tracker.revoke(SESSION, 'glob'), false, '重复撤销返回 false');
  assert.equal(tracker.get(SESSION, 'glob'), undefined);

  tracker.admit(SESSION, row);
  tracker.admit(SESSION, { ...row, name: 'grep' });
  assert.deepEqual(tracker.pruneWhere(SESSION, (r) => r.name === 'glob'), ['glob']);
  tracker.dropSession(SESSION);
  assert.equal(tracker.admissionsFor(SESSION).size, 0);
  assert.equal(tracker.get('other', 'grep').name, 'grep', 'dropSession 不误杀其它会话');
});

test('AD2 seedFromStore 把 durable 记录灌回内存，重复名字以先读到的为准', () => {
  const tracker = createAdmissionTracker();
  const record = {
    sessionId: SESSION,
    admissions: [
      { name: 'glob', toolId: 't_glob', schemaDigest: 'sha256:a', at: 1 },
      { name: 'glob', toolId: 't_glob', schemaDigest: 'sha256:b', at: 2 },
      { name: 'grep', toolId: 't_grep', schemaDigest: 'sha256:g', at: 3 },
    ],
  };
  tracker.seedFromStore({
    keys: () => [SESSION],
    get: () => record,
  });
  assert.equal(tracker.get(SESSION, 'glob').schemaDigest, 'sha256:a');
  assert.equal(tracker.get(SESSION, 'grep').schemaDigest, 'sha256:g');
});

test('AD3 store handle：打开失败退化为 ephemeral；invalid 记录拒绝落盘；close 幂等', async () => {
  const failing = createAdmissionStoreHandle({
    facility: { open: async () => { throw new Error('disk unavailable'); } },
    defineDomain: () => ({}), domainTable: () => ({}), z: { unknown: () => ({}) },
  });
  assert.deepEqual(await failing.ensureOpen(), { ok: false, reason: 'open-failed' });
  await assert.rejects(failing.put({ sessionId: SESSION, admissions: [] }), /not open/);
  await failing.close();

  const table = new Map();
  const ok = createAdmissionStoreHandle({
    facility: { open: async () => ({ table: () => ({
      get: (key) => table.get(key),
      put: async (key, value) => { table.set(key, value); },
      delete: async (key) => { table.delete(key); },
      keys: () => [...table.keys()],
    }), close: async () => {} }) },
    defineDomain: () => ({}), domainTable: () => ({}), z: { unknown: () => ({}) },
  });
  assert.deepEqual(await ok.ensureOpen(), { ok: true });
  await assert.rejects(ok.put({ sessionId: SESSION, admissions: [{ name: '', toolId: 't', schemaDigest: 'd' }] }),
    /refusing to persist an invalid admission record/);
  const record = { sessionId: SESSION, admissions: [{ name: 'glob', toolId: 't', schemaDigest: 'd', at: 1 }] };
  await ok.put(record);
  assert.deepEqual(ok.keys(), [SESSION]);
  assert.deepEqual(ok.get(SESSION), record);
  await ok.remove(SESSION);
  assert.deepEqual(ok.keys(), []);
  await ok.close();
  await ok.close();
});

// ---------------------------------------------------------------------------
// mask：allow-list 组成、restrictable 过滤、幂等与 dispose
// ---------------------------------------------------------------------------

function maskHarness({ restrictable = ['tool_list', 'tool_search', 'tool_load', 'tool_unload', 'read_file', 'glob', 'grep', 'final_answer', 'pinned'], alwaysVisible = ['read_file'] } = {}) {
  const calls = [];
  let layers = new Map();
  const agent = {
    id: 'agent_1',
    ctx: {
      tools: {
        restrict: ({ allow }) => {
          calls.push([...allow]);
          const restriction = { allow: [...allow] };
          const layer = layers.get(agent) ?? { restrictions: new Map() };
          layers.set(agent, layer);
          const key = Symbol('restriction');
          layer.restrictions.set(key, restriction);
          return () => layer.restrictions.delete(key);
        },
      },
    },
  };
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: new Set(restrictable) }),
      layers: { peek: (who) => layers.get(who) },
    },
  };
  const mask = createMaskController({ ctx, frameworkRetained: ['final_answer'], getAlwaysVisible: () => alwaysVisible });
  return { mask, agent, calls, getRestrictionCount: () => layers.get(agent)?.restrictions?.size ?? 0 };
}

test('MK1 allow = 入口四件 + frameworkRetained + alwaysVisible + admitted，且只保留 restrictable', () => {
  const h = maskHarness({ restrictable: ['tool_list', 'tool_search', 'tool_load', 'tool_unload', 'glob', 'final_answer', 'read_file'] });
  h.mask.update(h.agent, new Set(['glob', 'not_restrictable']));
  assert.deepEqual(h.calls.at(-1), [
    'final_answer', 'glob', 'read_file', 'tool_list', 'tool_load', 'tool_search', 'tool_unload',
  ]);
  assert.equal(h.calls.at(-1).includes('not_restrictable'), false, '未注册/own-scope 名字不得进入 restrict');
});

test('MK2 相同 allow 集合幂等：不重复安装/释放掩码', () => {
  const h = maskHarness();
  h.mask.update(h.agent, new Set(['glob']));
  const count = h.calls.length;
  h.mask.update(h.agent, new Set(['glob']));
  assert.equal(h.calls.length, count, '同样的 allow 不再调用 restrict');
  h.mask.update(h.agent, new Set(['glob', 'grep']));
  assert.equal(h.calls.length, count + 1, '集合变化才换掩码');
  assert.equal(h.getRestrictionCount(), 1, '旧掩码被释放，只剩一层');
});

test('MK3 disposeAgent/dispose 释放本插件持有的全部 restriction', () => {
  const h = maskHarness();
  h.mask.update(h.agent, new Set(['glob']));
  assert.equal(h.getRestrictionCount(), 1);
  assert.equal(h.mask.ownedFilters().length, 1);
  h.mask.disposeAgent(h.agent);
  assert.equal(h.getRestrictionCount(), 0);
  assert.equal(h.mask.ownedFilters().length, 0);
});

test('MK4 新掩码安装失败时旧掩码仍在线（偏严），错误可在观测面读到', () => {
  const h = maskHarness();
  h.mask.update(h.agent, new Set(['glob']));
  const before = h.getRestrictionCount();
  // 下一次 restrict 抛错：模拟宿主拒绝。
  const original = h.agent.ctx.tools.restrict;
  h.agent.ctx.tools.restrict = () => { throw new Error('host rejected'); };
  h.mask.update(h.agent, new Set(['grep']));
  assert.equal(h.getRestrictionCount(), before, '旧掩码不得被提前释放');
  assert.ok(h.mask.errorOf(h.agent) instanceof Error);
  h.agent.ctx.tools.restrict = original;
});

// ---------------------------------------------------------------------------
// 三层接缝：load → admission + mask；guard 放行；unload/invalidat → 收回
// ---------------------------------------------------------------------------

function registryStub(bindings) {
  const state = { bindings, generation: 1 };
  return {
    setBindings(next) { state.bindings = next; },
    entryNames: [...ENTRY_TOOL_NAMES],
    frameworkRetained: ['final_answer'],
    bindingsFor: () => ({ scopeKey: 'scope', bindings: state.bindings }),
    remember: () => {},
    generationFor: () => 'g1',
    bumpGeneration: () => { state.generation += 1; },
    scopeKeyOf: () => 'scope',
    diffAgainst: () => ({ added: [], removed: [] }),
    disposeScope: () => {},
  };
}

async function adapterHarness(bindings = sampleBindings()) {
  const calls = [];
  const layers = new Map();
  const agent = {
    id: 'agent_1',
    session: { id: SESSION },
    ctx: {
      tools: {
        restrict: ({ allow }) => {
          calls.push([...allow]);
          const restriction = { allow: [...allow] };
          const layer = layers.get(agent) ?? { restrictions: new Map() };
          layers.set(agent, layer);
          const key = Symbol('restriction');
          layer.restrictions.set(key, restriction);
          return () => layer.restrictions.delete(key);
        },
      },
    },
  };
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: new Set([...ENTRY_TOOL_NAMES, ...bindings.map((b) => b.name)]) }),
      layers: { peek: (who) => layers.get(who) },
      guard: (fn) => { agent.guardHandler = fn; return () => { agent.guardHandler = undefined; }; },
    },
  };
  const mask = createMaskController({ ctx, frameworkRetained: [], getAlwaysVisible: () => [] });
  const tracker = createAdmissionTracker();
  const registry = registryStub(bindings);
  const lifecycle = createLifecycle({
    ctx: { tools: { view: () => ({ visible: new Map() }) } },
    registry,
    config: {
      locale: 'en', categoryConfig: CATEGORY_CONFIG, alwaysVisible: [],
      initialToolsEnabled: true, tolerantLoadProtected: true, budgets: {},
    },
    clock: fakeClock(), random: fakeRandom(), tracker, mask,
    viewFor: () => ({ visible: new Map() }),
    getPresetTools: () => [],
  });
  const runtime = lifecycle.runtimeFor(agent.session, agent);
  createGuard({ ctx, lifecycle, tracker, controlDefinitions: new Map() });
  const guard = (name) => agent.guardHandler({ name, agent });
  return { agent, runtime, lifecycle, tracker, mask, guard, ctx, calls, registry };
}

test('DI1 load 成功后立刻写 admission + 更新掩码；guard 放行', async () => {
  const bindings = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files' }), binding({ name: 'grep', toolId: 't_files_grep', namespace: 'files' })];
  const h = await adapterHarness(bindings);
  const loaded = await h.runtime.engine.handleLoad({ names: ['glob'] }, h.runtime.scope);
  assert.equal(loaded.response.ok, true);
  assert.match(h.guard('glob'), /not admitted/, 'admission 尚未提交时门禁拒绝');

  h.lifecycle.commitAdmissions(h.runtime, loaded.admitted);
  assert.equal(h.tracker.get(SESSION, 'glob').name, 'glob');
  assert.equal(h.guard('glob'), undefined, 'admission 提交且 digest 一致 → 放行');
  assert.ok(h.mask.ownedFilters().length >= 1, '掩码已安装');
  assert.ok(h.calls.at(-1).includes('glob'), 'allow-list 已包含刚准入的工具');
});

test('DI2 unload 撤销 admission 并重掩码；旧 admission 不得继续放行', async () => {
  const bindings = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files' }), binding({ name: 'grep', toolId: 't_files_grep', namespace: 'files' })];
  const h = await adapterHarness(bindings);
  const loaded = await h.runtime.engine.handleLoad({ names: ['glob', 'grep'] }, h.runtime.scope);
  h.lifecycle.commitAdmissions(h.runtime, loaded.admitted);
  assert.equal(h.guard('glob'), undefined);

  const unloaded = await h.runtime.engine.handleUnload({ names: ['glob'] }, h.runtime.scope);
  assert.equal(unloaded.response.ok, true);
  h.lifecycle.revokeAdmissions(h.runtime, unloaded.revoked);
  assert.equal(h.tracker.get(SESSION, 'glob'), undefined);
  assert.match(h.guard('glob'), /not admitted/, '撤销后执行被拒');
  assert.equal(h.guard('grep'), undefined, '未撤销的工具仍可用');
});

test('DI3 定义换版：refreshCatalog 作废选择；guard 对旧 admission 拒绝并要求重新 load', async () => {
  const bindings = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files' }), binding({ name: 'grep', toolId: 't_files_grep', namespace: 'files' })];
  const h = await adapterHarness(bindings);
  const loaded = await h.runtime.engine.handleLoad({ names: ['glob'] }, h.runtime.scope);
  h.lifecycle.commitAdmissions(h.runtime, loaded.admitted);
  assert.equal(h.guard('glob'), undefined);

  // 宿主替换同名定义（wire 变化）→ lifecycle.onRegistryChange 会 refreshCatalog 并撤销 admission。
  const changed = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files', params: { type: 'object', required: ['pattern'] } }), bindings[1]];
  // 与 lifecycle.onRegistryChange 相同的两步：refreshCatalog 作废选择，然后按返回名撤销 admission。
  const outcome = h.runtime.engine.refreshCatalog(changed);
  assert.deepEqual(outcome.invalidatedNames, ['glob']);
  h.lifecycle.revokeAdmissions(h.runtime, outcome.invalidatedNames);
  assert.equal(h.tracker.get(SESSION, 'glob'), undefined, '换版后 admission 被撤销');
  assert.match(h.guard('glob'), /not admitted/);

  const reload = await h.runtime.engine.handleLoad({ names: ['glob'] }, h.runtime.scope);
  h.lifecycle.commitAdmissions(h.runtime, reload.admitted);
  assert.equal(h.guard('glob'), undefined, '重新 load 恢复执行资格');
});

test('DI4 resume：durable admitted 行在 runtime 建立时回填，guard 直接放行', async () => {
  const bindings = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files' })];
  const h = await adapterHarness(bindings);
  const entry = h.runtime.engine.getCatalog().entries.get('t_files_glob');
  h.tracker.admit(SESSION, { name: entry.name, toolId: entry.toolId, schemaDigest: entry.schemaDigest, at: 1 });
  // 新 lifecycle/engine 用同一 tracker（模拟同 id resume）。
  const mask = createMaskController({ ctx: h.ctx, frameworkRetained: [], getAlwaysVisible: () => [] });
  const lifecycle = createLifecycle({
    ctx: { tools: { view: () => ({ visible: new Map() }) } },
    registry: registryStub(bindings),
    config: { locale: 'en', categoryConfig: CATEGORY_CONFIG, alwaysVisible: [], initialToolsEnabled: true, tolerantLoadProtected: true, budgets: {} },
    clock: fakeClock(), random: fakeRandom(), tracker: h.tracker, mask,
    viewFor: () => ({ visible: new Map() }),
    getPresetTools: () => [],
  });
  const agent2 = { id: 'agent_2', session: { id: SESSION }, ctx: h.agent.ctx };
  const runtime2 = lifecycle.runtimeFor(agent2.session, agent2);
  assert.equal(runtime2.engine.getState(runtime2.scope).selected.size, 1, 'seedSelection 已回填');
  createGuard({ ctx: h.ctx, lifecycle, tracker: h.tracker, controlDefinitions: new Map() });
  const guard = (name) => h.agent.guardHandler({ name, agent: agent2 });
  assert.equal(guard('glob'), undefined, 'resume 后首个请求即可执行');
});

test('DI5 会话隔离：A 的 admission 不泄漏到 B', async () => {
  const bindings = [binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files' })];
  const h = await adapterHarness(bindings);
  const loaded = await h.runtime.engine.handleLoad({ names: ['glob'] }, h.runtime.scope);
  h.lifecycle.commitAdmissions(h.runtime, loaded.admitted);
  const agentB = { id: 'agent_B', session: { id: 'sess_B' }, ctx: h.agent.ctx };
  h.lifecycle.runtimeFor(agentB.session, agentB);
  assert.match(h.agent.guardHandler({ name: 'glob', agent: agentB }), /not admitted/, 'B 未 load 不得执行');
});

test('DI6 搜索/列表不产生 admission，也不改变执行资格', async () => {
  const { engine } = await makeEngine();
  engine.handleSearch({ category: 'files', query: 'glob' }, { sessionId: SESSION });
  engine.handleList({ view: 'available', category: 'files' }, { sessionId: SESSION });
  assert.equal(engine.getState({ sessionId: SESSION }).selected.size, 0);
});
