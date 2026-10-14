import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamesDriftObserver, describeNamesDrift } from '../../adapters/dsh/names-drift.mjs';
import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';

test('漂移区分周期名单、实际自证集合和真正待加入项，不改变授权', () => {
  const runtime = { scope: { sessionId: 's' }, alwaysNames: ['read'],
    alwaysNameSet: new Set(['read', 'bash']), requireTrustedEpoch: true, ledger: { state: 'trusted' } };
  const details = describeNamesDrift(['write', 'bash', 'write'], runtime);
  assert.deepEqual(details.added, ['bash', 'write']);
  assert.deepEqual(details.removed, ['read']);
  assert.deepEqual(details.effectiveOnly, ['bash']);
  assert.deepEqual(details.pendingAdded, ['write']);
  assert.deepEqual(runtime.alwaysNames, ['read']);
  assert.deepEqual([...runtime.alwaysNameSet], ['read', 'bash']);
});

test('相同差异跨观测点去重、恢复一致后再次变化可报告、状态变化单独报告', () => {
  const events = [];
  const observe = createNamesDriftObserver((name, details) => events.push({ name, details }));
  const runtime = { scope: { sessionId: 's' }, alwaysNames: ['read'], alwaysNameSet: new Set(['read']),
    requireTrustedEpoch: true, ledger: { state: 'trusted' } };
  observe(runtime, ['read'], 'pre-step');
  assert.equal(events.length, 0);
  observe(runtime, ['write', 'read'], 'pre-step');
  observe(runtime, ['read', 'write', 'write'], 'epoch-boundary');
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'lifecycle:names-drift');
  assert.match(events[0].details.activation, /durable-record/);
  runtime.ledger.state = 'blocked';
  observe(runtime, ['read', 'write'], 'pre-step');
  assert.equal(events.length, 2);
  observe(runtime, ['read'], 'pre-step');
  observe(runtime, ['read', 'write'], 'pre-step');
  assert.equal(events.length, 3);
});

test('真实 lifecycle pre-step 接入诊断但不换名；恢复窗口不误报', async () => {
  let names = ['read'];
  const events = [];
  const lifecycle = createLifecycle({
    ctx: {}, config: { requireTrustedEpoch: false }, registry: {},
    getAlwaysVisible: () => names,
    log: (name, details) => events.push({ name, details }),
  });
  const runtime = { scope: { sessionId: 's' }, agentScope: { id: 'a' },
    restoring: true, requireTrustedEpoch: false, alwaysNames: ['read'],
    alwaysNameSet: new Set(['read']), refreshPendingProjection: null };
  lifecycle.sessions.set('s', runtime);
  names = ['read', 'write'];
  await lifecycle.awaitEpochRecord('s');
  assert.equal(events.length, 0);
  runtime.restoring = false;
  await lifecycle.awaitEpochRecord('s');
  await lifecycle.awaitEpochRecord('s');
  assert.equal(events.length, 1);
  assert.equal(events[0].details.point, 'pre-step');
  assert.deepEqual(events[0].details.pendingAdded, ['write']);
  assert.deepEqual([...runtime.alwaysNameSet], ['read']);
  names = null;
  assert.deepEqual(await lifecycle.awaitEpochRecord('s'), { state: 'disabled' });
  assert.equal(events.at(-1).name, 'lifecycle:names-drift-unavailable');
});

test('不同会话独立去重，默认模式不承诺可信记录', () => {
  const events = [];
  const observe = createNamesDriftObserver((_name, details) => events.push(details));
  for (const sessionId of ['a', 'b']) {
    observe({ scope: { sessionId }, alwaysNames: [], alwaysNameSet: new Set() }, ['bash'], 'pre-step');
  }
  assert.equal(events.length, 2);
  assert.match(events[0].activation, /^next-epoch-snapshot/);
});
