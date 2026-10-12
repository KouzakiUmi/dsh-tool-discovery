// Portable activation invalidation tests: no host SDK, profile or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';

const lifecycle = () => createLifecycle({ ctx: {}, registry: {}, config: { locale: 'en' } });
const disposed = error => error?.code === 'STATE_NOT_READY' && /disposed/.test(error.message);

test('AL1 completed/rejected work does not invalidate a live activation', async () => {
  const live = lifecycle();
  assert.equal(await live.waitForActive(Promise.resolve('value')), 'value');
  const error = new Error('original work failure');
  await assert.rejects(live.waitForActive(Promise.reject(error)), actual => actual === error);
  assert.doesNotThrow(() => live.assertActive());
  live.dispose();
});

test('AL2 dispose rejects pending waits immediately and permanently forbids old runtime creation', async () => {
  const live = lifecycle();
  let rejectWork;
  const waiting = live.waitForActive(new Promise((_resolve, reject) => { rejectWork = reject; }));
  const failure = assert.rejects(waiting, disposed);
  live.dispose();
  await failure;
  assert.throws(() => live.ensureRuntime({ id: 'old' }, {}), disposed);
  assert.throws(() => live.runtimeFor({ id: 'old' }, {}), disposed);
  await assert.rejects(live.awaitEpochRecord('old'), disposed);
  assert.equal(live.sessions.size, 0);
  assert.doesNotThrow(() => live.dispose());
  await assert.rejects(live.waitForActive(Promise.reject(new Error('work arriving after disposal'))), disposed);
  // The dropped work is still observed by the race; a late failure must not be unhandled.
  rejectWork(new Error('late work rejection'));
  await Promise.resolve();
});

test('AL3 a resolved promise queued before disposal cannot return an old activation result', async () => {
  const live = lifecycle();
  const waiting = live.waitForActive(Promise.resolve('old assembly'));
  const failure = assert.rejects(waiting, disposed);
  live.dispose();
  await failure;
});

test('AL4 invalidation is local to one activation, never a fresh lifecycle', async () => {
  const old = lifecycle();
  const fresh = lifecycle();
  old.dispose();
  assert.equal(await fresh.waitForActive(Promise.resolve('new assembly')), 'new assembly');
  assert.doesNotThrow(() => fresh.assertActive());
  fresh.dispose();
});

test('AL5 activation abort listeners are removed on success, work failure and disposal', async () => {
  const live = lifecycle();
  const original = AbortSignal.prototype.addEventListener;
  let signal;
  let initial;
  // Capture the private activation signal only during one synchronous registration.
  try {
    AbortSignal.prototype.addEventListener = function (...args) {
      signal = this;
      return original.apply(this, args);
    };
    initial = live.waitForActive(Promise.resolve('done'));
  } finally { AbortSignal.prototype.addEventListener = original; }
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  await initial;
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const error = new Error('failed work');
  await assert.rejects(live.waitForActive(Promise.reject(error)), actual => actual === error);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const pending = live.waitForActive(new Promise(() => {}));
  const failure = assert.rejects(pending, disposed);
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  live.dispose();
  await failure;
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});
