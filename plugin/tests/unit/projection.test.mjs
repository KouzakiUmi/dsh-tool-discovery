// 投影的冷恢复等待：**没有超时降级**这条产品语义的单测。
//
// 组合套件（gate-review-boundaries）用真实宿主证明"pending 期间 0 请求"，RB4 还
// 用真实时钟走满 6 秒。但那要 6 秒；这里用最小 fake ctx 把两条边界钉成秒级断言：
//   1) 恢复永远 pending → 监听器的 promise **永不落定**，也**永不产出**投影结果。
//      （任何"等够久就发缩水"的兜底都会在这里露馅；本仓库不再有任何计时器。）
//   2) 宿主本轮的取消信号 abort → 监听器以 abort reason 拒绝，等待沿宿主自己的
//      取消/错误管线退出，而不是由我们另立时限。
//   3) 恢复**已决失败**（incompatible）→ 立即落定，且只留常驻基线（fail closed）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from '../../adapters/dsh/projection.mjs';

const ENTRY = ['tool_list', 'tool_load', 'tool_search'];

/** 最小 ctx：只提供投影真正用到的那几个面。 */
function fakeCtx () {
  const listeners = [];
  return {
    listeners,
    on: (name, listener) => { listeners.push([name, listener]); return () => {}; },
    tools: {
      modeFor: () => 'native',
      get: (name) => (name === undefined ? undefined : { name }),
    },
  };
}

/** 一个 restoring 态的 runtime 替身。 */
function restoringRuntime (overrides = {}) {
  return {
    restoring: true,
    compositionBypass: null,
    alwaysNameSet: new Set(),
    scope: { sessionId: 'u1' },
    engine: {
      getState: () => ({ mode: 'restoring', selected: new Map(), invalidated: new Map() }),
      getCatalog: () => ({ entries: new Map() }),
      getFrozenWire: () => [],
    },
    ...overrides,
  };
}

function harness ({ runtime, whenReady }) {
  const ctx = fakeCtx();
  const lifecycle = { runtimeFor: () => runtime, whenReady };
  createProjection({ ctx, lifecycle, log: () => {} });
  const listener = ctx.listeners.find(([name]) => name === 'system-prompt/assemble')[1];
  const agent = { id: 'a1', session: { id: 'u1' } };
  return { listener, agent, incoming: { sections: [], contexts: [], tools: ENTRY.map((name) => ({ name })) } };
}

test('PR1: 恢复永远 pending → 装配永不落定，也永不产出投影结果', async () => {
  let settled = false;
  const never = new Promise(() => {});
  const { listener, agent, incoming } = harness({
    runtime: restoringRuntime(),
    whenReady: () => never,
  });
  const pending = listener(incoming, { agent, scope: agent }, async () => incoming)
    .then((value) => { settled = true; return value; });
  // 让出足够多的微任务/定时器：若实现里有任何计时器兜底，这里就会落定。
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '恢复仍在 pending 时装配不得落定，更不得发出缩水的那一份');
  assert.equal(typeof pending.then, 'function');
});

test('PR2: 宿主本轮的取消信号 abort → 以 abort reason 拒绝，不产出投影', async () => {
  const controller = new AbortController();
  const reason = new Error('user aborted the turn');
  const never = new Promise(() => {});
  const { listener, agent, incoming } = harness({
    runtime: restoringRuntime(),
    whenReady: () => never,
  });
  const pending = listener(incoming, { agent, scope: agent, signal: controller.signal }, async () => incoming);
  controller.abort(reason);
  await assert.rejects(() => pending, (error) => {
    assert.equal(error, reason, '必须以宿主的 abort reason 拒绝，等待沿宿主取消管线退出');
    return true;
  });
});

test('PR3: 恢复已决失败（incompatible）→ 立即落定，且只留常驻基线', async () => {
  const { listener, agent, incoming } = harness({
    runtime: restoringRuntime({ restoring: false }),
    whenReady: () => Promise.resolve({ mode: 'incompatible', reason: 'readSession-failed' }),
  });
  const transformed = await listener(incoming, { agent, scope: agent }, async () => incoming);
  assert.deepEqual(transformed.tools.map((tool) => tool.name), ENTRY,
    '已决失败只留常驻基线（fail closed），不得披露任何已加载项');
});

test('PR4: incoming 同名重复定义 → INCOMPATIBLE_COMPOSITION（基线段与已加载段同等）', async () => {
  const runtime = restoringRuntime({
    restoring: false,
    engine: {
      getState: () => ({ mode: 'ready', selected: new Map([['t1', { toolId: 't1', name: 'dup', revision: 'r', seq: 1 }]]), invalidated: new Map() }),
      getCatalog: () => ({ entries: new Map([['t1', { toolId: 't1', name: 'dup', revision: 'r' }]]) }),
      getFrozenWire: () => [],
    },
  });
  const { listener, agent } = harness({ runtime, whenReady: () => Promise.resolve({ mode: 'ready' }) });
  // 重复的是**已加载**工具：旧实现对它静默取最后一个（基线段的查重够不着）。
  const incoming = { sections: [], contexts: [], tools: [...ENTRY.map((name) => ({ name })), { name: 'dup' }, { name: 'dup' }] };
  await assert.rejects(
    () => listener(incoming, { agent, scope: agent }, async () => incoming),
    (error) => {
      assert.match(String(error?.message ?? error), /duplicate/i);
      assert.equal(error?.code, 'INCOMPATIBLE_COMPOSITION');
      return true;
    },
  );
});

test('PR5: incoming 只有一份重复候选时正常通过（查重不引入额外限制）', async () => {
  const runtime = restoringRuntime({
    restoring: false,
    engine: {
      getState: () => ({ mode: 'ready', selected: new Map([['t1', { toolId: 't1', name: 'dup', revision: 'r', seq: 1 }]]), invalidated: new Map() }),
      getCatalog: () => ({ entries: new Map([['t1', { toolId: 't1', name: 'dup', revision: 'r' }]]) }),
      getFrozenWire: () => [],
    },
  });
  const { listener, agent } = harness({ runtime, whenReady: () => Promise.resolve({ mode: 'ready' }) });
  const incoming = { sections: [], contexts: [], tools: [...ENTRY.map((name) => ({ name })), { name: 'dup' }] };
  const transformed = await listener(incoming, { agent, scope: agent }, async () => incoming);
  assert.deepEqual(transformed.tools.map((tool) => tool.name), [...ENTRY, 'dup']);
});