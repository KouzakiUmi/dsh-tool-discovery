// 真实隔离 Loader / SDK render / run_code transport / 嵌套执行 / canonical journal / llm/stream。
// 模型响应与 PTC 程序 backend 为声明式 fixture；不宣称真实 TS/Python worker 已验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, forkServices } from './harness.mjs';
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs';
import { fileURLToPath } from 'node:url';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
import { runs } from './fixtures/ptc-runtime.mjs';

const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
const sdkText = (request) => request.messages.filter((message) => message.role === 'system')
  .map((message) => message.content.map((block) => block.text ?? '').join('')).filter(Boolean).at(-1);
const program = (id, actions) => queueResponse({ toolCalls: [{ id, name: 'run_code', arguments: {
  description: 'isolated PTC fixture', code: JSON.stringify(actions),
} }] });

for (const language of ['typescript', 'python']) {
  test(`PTC ${language}: 不隐藏资格目录、首次 load 同程序拒绝、下一请求实际 SDK 曝光才执行`, async (t) => {
    store.reset(); runs.length = 0;
    const boot = await bootAdapterComposition({
      fixtures: ['mock-provider'], adapter: { alwaysVisible: [], alwaysAllowPresetTools: false,
        respectAlwaysVisible: true, ptcCompatibility: true, requireTrustedEpoch: true },
      extraServices: [...forkServices().slice(0, 3), { id: 'ptc-fixture',
        name: fixtureFileUrl(fileURLToPath(new URL('./fixtures/ptc-runtime.mjs', import.meta.url))), config: { language } }],
    });
    t.after(async () => { await boot.closeServices(); boot.dispose(); });
    assert.deepEqual(boot.activationErrors(), []);
    const calls = [];
    const definition = defineTool({ name: 'ptc_target', description: 'isolated target', parameters: {
      text: { type: 'string', required: true },
    }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => { calls.push(args.text); return args.text; } });
    let disposeTool = boot.ctx.tools.register(definition);
    t.after(() => disposeTool());
    const handle = await boot.ctx.agents.create({ sessionId: `ptc-${language}`,
      agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
    t.after(() => handle.dispose());
    handle.agent.ctx.tools.presentAs('ptc');
    const turn = async () => {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'PTC fixture task' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
    };
    program('load-first', [
      { name: 'tool_search', arguments: { category: 'all', query: 'ptc_target' } },
      { name: 'tool_load', arguments: { names: ['ptc_target'] } },
      { name: 'ptc_target', arguments: { text: 'same-program-guess' } },
    ]);
    program('call-next', [{ name: 'ptc_target', arguments: { text: 'next-request' } }]);
    queueResponse({ text: 'done' });
    await turn();
    assert.equal(store.requests.length, 3);
    assert.equal(sdkText(store.requests[0]).includes('ptc_target'), false);
    assert.equal(sdkText(store.requests[1]).includes('ptc_target'), true);
    assert.deepEqual(store.requests[0].tools.map((tool) => tool.name), ['run_code']);
    assert.equal(runs[0][0].ok, true);
    assert.match(runs[0][0].value, /ptc_target/, '搜索仍可发现未披露的真实工具');
    assert.equal(runs[0][1].ok, true);
    assert.equal(JSON.parse(runs[0][1].value).ok, true);
    assert.equal(runs[0][2].ok, false);
    assert.match(runs[0][2].error, /TOOL_NOT_ADVERTISED/);
    assert.deepEqual(calls, ['next-request']);
    assert.notEqual(boot.ctx.tools.get('ptc_target', handle.agent), undefined, 'SDK 裁剪没有改变宿主资格');

    // 冷恢复真实持久日志与可信记录，不保留旧内存 advertised/SDK 快照。
    const lifecycle = boot.ctx.get('progressiveDiscovery').lifecycle;
    lifecycle.disposeSession(handle.agent.session.id);
    const restored = lifecycle.ensureRuntime(handle.agent.session, handle.agent);
    assert.equal((await lifecycle.whenReady(handle.agent.session.id)).mode, 'ready');
    assert.equal(restored.engine.getState(restored.scope).selected.size, 1);
    assert.equal(restored.engine.getState(restored.scope).advertised.size, 0);
    const coldStart = store.requests.length;
    program('cold-call', [{ name: 'ptc_target', arguments: { text: 'cold-restored' } }]);
    queueResponse({ text: 'cold done' });
    await turn();
    assert.equal(sdkText(store.requests[coldStart]).includes('ptc_target'), true);
    assert.deepEqual(calls, ['next-request', 'cold-restored']);

    // 同 wire 移除→重加→重新 load：旧 SDK 不追认，新实际请求仍能重新曝光。
    disposeTool(); disposeTool = boot.ctx.tools.register(definition);
    const start = store.requests.length;
    const runStart = runs.length;
    program('load-again', [
      { name: 'tool_load', arguments: { names: ['ptc_target'] } },
      { name: 'ptc_target', arguments: { text: 'reloaded-same-program' } },
    ]);
    program('call-again', [{ name: 'ptc_target', arguments: { text: 'reloaded-next-request' } }]);
    queueResponse({ text: 'done again' });
    await turn();
    assert.equal(sdkText(store.requests[start]).includes('ptc_target'), false);
    assert.equal(sdkText(store.requests[start + 1]).includes('ptc_target'), true);
    assert.equal(runs[runStart][1].ok, false);
    assert.deepEqual(calls, ['next-request', 'cold-restored', 'reloaded-next-request']);
  });
}
