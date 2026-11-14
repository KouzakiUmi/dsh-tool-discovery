// 停用场景组合门禁：绑定 minimal 的会话必须回到"没有本插件"的原生工具面与准入。
//
// 覆盖：
//   * 四入口在 minimal 会话的声明里消失，且猜名调用被 guard 拒绝；
//   * 其它工具既不遮罩也不要求 admission（停用 = 不遮罩 + 不设门禁）；
//   * 非停用 preset 仍是原来的发现流程（回归）；
//   * `disabledPresets: []` 把 minimal 恢复正常流程；自定义名单同样按 id 生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, executeToolCall } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';

const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload'];
/** 全局（继承）工具：非 preset 注册，停用场景下必须照旧可见可执行。 */
const INHERITED = 'fixture_hidden_inherited';
const fixture = new URL('./fixtures/preset-tool.mjs', import.meta.url).href;
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));

/** 两个 preset：`minimal`（宿主机智模式的 id）与一个普通 preset。 */
async function boot(config = {}) {
  const host = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapterSchema: true,
    adapter: { alwaysVisible: [], initialToolsEnabled: false, ...config },
    extraServices: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard-ish' } }],
  });
  try {
    assert.deepEqual(host.activationErrors(), []);
    for (const [id, name] of [['minimal', 'fixture_preset_minimal'], ['standard-ish', 'fixture_preset_standard']]) {
      await host.loader.create({
        id,
        name: '@deepseek-ai/dsh-agent-preset',
        config: { id, plugins: [{ id: 'preset-tool', name: fixture, config: { name } }] },
      });
    }
    await host.loader.await();
    assert.deepEqual(host.activationErrors(), []);
    return host;
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

async function create(host, id, preset) {
  return host.ctx.agents.create({
    sessionId: id,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: host.tmpRoot },
    setup: async ctx => { await host.ctx.agentPresets.mount(ctx, preset); },
  });
}

async function turn(handle) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise tool visibility.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}

function call(host, handle, name, callId, args = { text: 'ok' }) {
  return executeToolCall(host.ctx, { agent: handle.agent, name, callId, arguments: args, signal: new AbortController().signal });
}

const namesOf = request => request.tools.map(tool => tool.name);

test('DP1: minimal 会话看不到四入口，原生/预置工具不遮罩也不要求 admission', async () => {
  store.reset();
  const host = await boot();
  let handle;
  try {
    handle = await create(host, 'dp-minimal', 'minimal');
    queueResponse({ text: 'no discovery entries expected' });
    await turn(handle);
    const names = namesOf(store.requests[0]);
    for (const entry of ENTRIES) assert.equal(names.includes(entry), false, `${entry} 不得出现在 minimal 会话声明里`);
    assert.ok(names.includes(INHERITED), '全局工具照旧可见');
    assert.ok(names.includes('fixture_preset_minimal'), 'minimal 自己的工具照旧可见');

    // 不遮罩：没有 load 也能执行；不设门禁：guard 不额外拒绝。
    const inherited = await call(host, handle, INHERITED, 'dp-inherited');
    assert.equal(inherited.isError, false, '停用场景不得要求 admission');
    assert.equal(store.bodyCount('dp-inherited'), 1);

    // 四入口被掩码移出可见面，猜名调用也不可派发。
    const guessed = await call(host, handle, 'tool_list', 'dp-guess-list', {});
    assert.equal(guessed.isError, true, '停用场景下入口调用必须被拒');
    assert.equal(store.bodyCount('dp-guess-list'), 0);
    const tracked = host.ctx.get('progressiveDiscovery').tracker;
    assert.equal(tracked.get('dp-minimal', INHERITED), undefined, '停用场景不得写 admission');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('DP2: 非停用 preset 仍走原来的发现流程（回归）', async () => {
  store.reset();
  const host = await boot();
  let handle;
  try {
    handle = await create(host, 'dp-standard', 'standard-ish');
    queueResponse({ text: 'discovery entries expected' });
    await turn(handle);
    const names = namesOf(store.requests[0]);
    for (const entry of ENTRIES) assert.ok(names.includes(entry), `${entry} 必须在正常 preset 里可见`);
    assert.equal(names.includes(INHERITED), false, '受控全局工具未 load 不得披露');
    const denied = await call(host, handle, INHERITED, 'dp-standard-denied');
    assert.equal(denied.isError, true, '正常 preset 仍要求 admission');
    assert.equal(store.bodyCount('dp-standard-denied'), 0);
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('DP3: disabledPresets: [] 把 minimal 恢复成正常发现流程', async () => {
  store.reset();
  const host = await boot({ disabledPresets: [] });
  let handle;
  try {
    handle = await create(host, 'dp-empty-list', 'minimal');
    queueResponse({ text: 'discovery entries expected' });
    await turn(handle);
    const names = namesOf(store.requests[0]);
    for (const entry of ENTRIES) assert.ok(names.includes(entry), '显式 [] 不再停用任何 preset');
    assert.equal(names.includes(INHERITED), false);
    const denied = await call(host, handle, INHERITED, 'dp-empty-denied');
    assert.equal(denied.isError, true);
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('DP4: 自定义名单按 preset id 生效，未列出的 preset 不受影响', async () => {
  store.reset();
  const host = await boot({ disabledPresets: ['standard-ish'] });
  const handles = [];
  try {
    const disabledOne = await create(host, 'dp-custom-off', 'standard-ish');
    handles.push(disabledOne);
    queueResponse({ text: 'inert' });
    await turn(disabledOne);
    assert.equal(namesOf(store.requests[0]).some(name => ENTRIES.includes(name)), false, '自定义停用生效');

    const normalOne = await create(host, 'dp-custom-on', 'minimal');
    handles.push(normalOne);
    queueResponse({ text: 'normal' });
    await turn(normalOne);
    assert.ok(namesOf(store.requests[1]).includes('tool_list'), '不在名单里的 preset 保持正常流程');
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    await host.dispose();
  }
});

test('DP5: 会话空白期切换 preset 后，停用状态在下一请求对齐', async () => {
  store.reset();
  const host = await boot();
  let handle;
  try {
    handle = await create(host, 'dp-switch-back', 'minimal');
    assert.equal(host.ctx.tools.view(handle.agent).visible.has('tool_list'), false, 'minimal 绑定后入口不可见');

    // 宿主只允许空白会话换 preset：此刻还没有任何请求，可直接切换。
    await host.ctx.agentPresets.select(handle.agent, 'standard-ish');
    queueResponse({ text: 'after switch' });
    await turn(handle);
    assert.ok(namesOf(store.requests[0]).includes('tool_list'), '切回正常 preset 后入口重新出现');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});
