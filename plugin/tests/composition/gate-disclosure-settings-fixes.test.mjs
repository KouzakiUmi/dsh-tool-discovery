// rc.1 admission + mask：真实 Loader、独立会话及 mock provider。
// 旧 DS1 的压缩采用 initialToolsEnabled 和 DS2 的 frozen wire/canonical 冷恢复无等价目标，相关子系统已删。
// 有效目标保留为：核心工具不绕过关闭注入、load/use、定义变化撤权、同 id durable resume 与重载恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, executeToolCall } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
const fixtures = ['mock-provider', 'inherited-tools', 'scope-tools'];
const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload'];
const HIDDEN = 'fixture_hidden_inherited';
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
async function create(boot, id) {
  return boot.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
}
function call(boot, handle, name, callId, args = {}) {
  return executeToolCall(boot.ctx, { agent: handle.agent, name, callId, arguments: args, signal: new AbortController().signal });
}
function runtimeFor(boot, handle) {
  return boot.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(handle.agent.session, handle.agent);
}
async function close(boot) { await boot.closeServices(); await boot.dispose(); }

test('DS1: 关闭初始注入时核心名工具也要 admission；普通 load/use 不受影响', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures, adapterSchema: true,
    adapter: { initialToolsEnabled: false, alwaysAllowPresetTools: false } });
  let handle;
  let body = 0;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    boot.ctx.tools.register(defineTool({ name: 'read', description: 'Core-name test fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => { body += 1; return 'read'; } }));
    handle = await create(boot, 'ds-core');
    const runtime = runtimeFor(boot, handle);
    queueResponse({ text: 'baseline' }); await turn(handle, 'Begin.');
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
    assert.equal(runtime.alwaysNameSet.has('read'), false);
    assert.equal((await call(boot, handle, 'read', 'ds-guess')).isError, true);
    assert.equal(body, 0);
    const own = await call(boot, handle, 'fixture_hidden_scope', 'ds-own-guess', { text: 'guess' });
    assert.equal(own.isError, true);
    assert.equal(store.bodyCount('ds-own-guess'), 0);
    queueResponse({ toolCalls: [{ id: 'ds-load', name: 'tool_load', arguments: { names: ['read'] } }] });
    queueResponse({ toolCalls: [{ id: 'ds-use', name: 'read', arguments: {} }] });
    queueResponse({ text: 'done' }); await turn(handle, 'Load and use read.');
    assert.ok(store.requests[2].tools.some(tool => tool.name === 'read'));
    assert.equal(body, 1);
    assert.ok(boot.ctx.get('progressiveDiscovery').tracker.get('ds-core', 'read'));
  } finally { await handle?.dispose(); await close(boot); }
});

test('DS2: 换版撤销旧 admission 并收回声明，重新 load 下一步恢复执行', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: { alwaysVisible: [], respectAlwaysVisible: true } });
  let handle;
  let replacementBody = 0;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    handle = await create(boot, 'ds-definition');
    runtimeFor(boot, handle);
    queueResponse({ toolCalls: [{ id: 'ds-v1-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'ds-v1-use', name: HIDDEN, arguments: { text: 'v1' } }] });
    queueResponse({ text: 'v1 done' }); await turn(handle, 'Load and use first version.');
    assert.equal(store.bodyCount('ds-v1-use'), 1);
    const sent = JSON.stringify(store.requests[1].tools);
    const definition = boot.ctx.tools.get(HIDDEN);
    definition.description = 'Replacement definition v2.';
    definition.execute = args => { replacementBody += 1; return args.text; };
    boot.ctx.emit('tools/change');
    assert.equal((await call(boot, handle, HIDDEN, 'ds-v2-guess', { text: 'guess' })).isError, true);
    assert.equal(replacementBody, 0);
    queueResponse({ toolCalls: [{ id: 'ds-v2-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'ds-v2-use', name: HIDDEN, arguments: { text: 'v2' } }] });
    queueResponse({ text: 'v2 done' }); await turn(handle, 'Reload and use the replacement.');
    assert.equal(store.requests[3].tools.some(tool => tool.name === HIDDEN), false, '换版后的下一请求回到隐藏态');
    assert.equal(store.requests[4].tools.find(tool => tool.name === HIDDEN)?.description, 'Replacement definition v2.');
    assert.equal(replacementBody, 1);
    assert.equal(JSON.stringify(store.requests[1].tools), sent, '新定义不改写历史请求');
  } finally { await handle?.dispose(); await close(boot); }
});

test('DS3: 同 root 冷启动从 admission 恢复同 id；换版不沿用旧授权，重新 load 可恢复', async () => {
  store.reset();
  const config = { alwaysVisible: [], respectAlwaysVisible: true };
  let boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: config });
  let handle;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    handle = await create(boot, 'ds-resume');
    runtimeFor(boot, handle);
    const service = boot.ctx.get('progressiveDiscovery');
    const admissionStore = service.tracker.holder.store;
    assert.ok(admissionStore, '真实 storageDomain 正控制');
    await admissionStore.ensureOpen();
    const originalPut = admissionStore.put.bind(admissionStore);
    let finishWrite;
    const wrote = new Promise(resolve => { finishWrite = resolve; });
    admissionStore.put = async record => {
      const result = await originalPut(record);
      if (record.sessionId === 'ds-resume' && record.admissions.some(row => row.name === HIDDEN)) finishWrite();
      return result;
    };
    queueResponse({ toolCalls: [{ id: 'ds-durable-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ text: 'persisted' }); await turn(handle, 'Load for resume.');
    assert.ok(service.tracker.get('ds-resume', HIDDEN));
    // 等真实 put 完成，关闭并复用同一测试 root；不合成历史回执。
    await wrote;
    assert.ok(admissionStore.get('ds-resume').admissions.some(row => row.name === HIDDEN));
    const root = boot.tmpRoot;
    await handle.dispose(); handle = null;
    await boot.closeServices();
    boot = await bootAdapterComposition({ tmpRoot: root, fixtures, adapterSchema: true, adapter: config });
    assert.deepEqual(boot.activationErrors(), []);
    handle = await boot.ctx.agents.resume({ resumeSessionId: 'ds-resume', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } });
    runtimeFor(boot, handle);
    queueResponse({ toolCalls: [{ id: 'ds-resumed-use', name: HIDDEN, arguments: { text: 'resumed' } }] });
    queueResponse({ text: 'resume done' }); await turn(handle, 'Continue with admitted tool.');
    assert.equal(store.bodyCount('ds-resumed-use'), 1);
    const current = boot.ctx.tools.get(HIDDEN);
    current.description = 'Changed after resume.';
    boot.ctx.emit('tools/change');
    assert.equal((await call(boot, handle, HIDDEN, 'ds-resume-drift', { text: 'guess' })).isError, true);
    assert.equal(store.bodyCount('ds-resume-drift'), 0);
    queueResponse({ toolCalls: [{ id: 'ds-resume-reload', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'ds-resume-reuse', name: HIDDEN, arguments: { text: 'new version' } }] });
    queueResponse({ text: 'done' }); await turn(handle, 'Reload changed definition.');
    assert.equal(store.bodyCount('ds-resume-reuse'), 1);
  } finally { await handle?.dispose(); await close(boot); }
});
