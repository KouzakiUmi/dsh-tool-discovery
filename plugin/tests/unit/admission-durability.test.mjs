import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionTracker, createAdmissionStoreHandle } from '../../adapters/dsh/admission.mjs';
const row = name => ({ name, toolId: `global::${name}`, schemaDigest: `sha256:${name}`, at: 1 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function storeFixture({ gate, failOpen = 0, failWrite = 0 } = {}) {
  const records = new Map();
  let opens = 0, closes = 0, writes = 0;
  const store = createAdmissionStoreHandle({
    facility: { open: async () => {
      opens++;
      if (opens <= failOpen) throw new Error('transient open');
      if (gate) await gate.promise;
      return { table: () => ({
        get: key => records.get(key), keys: () => records.keys(),
        put: async (key, record) => { writes++; if (writes <= failWrite) throw new Error('transient write'); records.set(key, record); },
        delete: async key => records.delete(key),
      }), close: async () => { closes++; } };
    } },
    defineDomain: value => value, domainTable: value => value, z: { unknown: () => ({}) },
  });
  return { store, records, counts: () => ({ opens, closes, writes }) };
}

test('rc.1 delete removes final durable admission and resume cannot revive it', async () => {
  const { store, records } = storeFixture();
  await store.ensureOpen();
  const tracker = createAdmissionTracker(); tracker.holder.store = store;
  tracker.admit('s', row('glob')); tracker.admit('s', row('grep'));
  await tracker.drain();
  tracker.revoke('s', 'glob'); await tracker.drain();
  assert.deepEqual(records.get('s').admissions.map(x => x.name), ['grep']);
  tracker.revoke('s', 'grep'); await tracker.drain();
  assert.equal(records.has('s'), false);
  const resumed = createAdmissionTracker(); resumed.holder.store = store; resumed.seedSession('s');
  assert.equal(resumed.admissionsFor('s').size, 0);
  await tracker.dispose(); await resumed.dispose(); await store.close();
});

test('late seed preserves revoke tombstone and merges untouched durable names', async () => {
  const gate = deferred(), { store, records } = storeFixture({ gate });
  records.set('s', { sessionId: 's', admissions: [row('glob'), row('grep')] });
  const tracker = createAdmissionTracker(); tracker.holder.store = store;
  tracker.revoke('s', 'glob');
  const opening = store.ensureOpen(); gate.resolve(); await opening;
  tracker.seedFromStore(store, ['s']); await tracker.drain();
  assert.deepEqual([...tracker.admissionsFor('s').keys()], ['grep']);
  assert.deepEqual(records.get('s').admissions.map(x => x.name), ['grep']);
  await tracker.dispose(); await store.close();
});

test('writes during open wait and persist, including ephemeral-before-attach changes', async () => {
  const gate = deferred(), { store, records } = storeFixture({ gate });
  const tracker = createAdmissionTracker();
  tracker.admit('s', row('glob'));
  tracker.holder.store = store;
  const opening = store.ensureOpen(); gate.resolve(); await opening;
  tracker.seedFromStore(store, ['s']); await tracker.drain();
  assert.equal(records.get('s').admissions[0].name, 'glob');
  await tracker.dispose(); await store.close();
});

test('immediate disposal drains queued snapshot; detach closes only after flush', async () => {
  const { store, records } = storeFixture(); await store.ensureOpen();
  const tracker = createAdmissionTracker(); tracker.holder.store = store;
  tracker.admit('s', row('glob'));
  await Promise.all([tracker.dispose(), tracker.detachStore(store)]);
  await store.close();
  assert.equal(records.get('s').admissions[0].name, 'glob');
  assert.equal(tracker.admissionsFor('s').size, 0);
  tracker.admit('s', row('grep')); tracker.revoke('s', 'glob');
  assert.equal(tracker.admissionsFor('s').size, 0);
});

test('same-process resume rehydrates one dropped session without scanning history', async () => {
  const { store } = storeFixture(); await store.ensureOpen();
  const tracker = createAdmissionTracker(); tracker.holder.store = store;
  tracker.admit('s', row('glob')); await tracker.drain(); tracker.dropSession('s');
  assert.equal(tracker.admissionsFor('s').size, 0);
  store.keys = () => { throw new Error('must not scan all sessions'); };
  tracker.seedSession('s');
  assert.equal(tracker.get('s', 'glob').name, 'glob');
  await tracker.dispose(); await store.close();
});

test('storage reattachment preserves local revocations over stale durable rows', async () => {
  const first = storeFixture(); await first.store.ensureOpen();
  const tracker = createAdmissionTracker(); tracker.holder.store = first.store;
  tracker.admit('s', row('glob')); tracker.admit('s', row('grep')); await tracker.drain();
  await tracker.detachStore(first.store);
  tracker.revoke('s', 'glob');
  const second = storeFixture();
  second.records.set('s', { sessionId: 's', admissions: [row('glob'), row('grep')] });
  await second.store.ensureOpen(); tracker.holder.store = second.store;
  tracker.seedFromStore(second.store, ['s']); await tracker.drain();
  assert.deepEqual([...tracker.admissionsFor('s').keys()], ['grep']);
  assert.deepEqual(second.records.get('s').admissions.map(x => x.name), ['grep']);
  await tracker.dispose(); await first.store.close(); await second.store.close();
});

test('open and snapshot failures have bounded retries, not permanent first-failure latch', async () => {
  const { store, records, counts } = storeFixture({ failOpen: 1, failWrite: 1 });
  assert.equal((await store.ensureOpen()).ok, false);
  assert.equal((await store.ensureOpen()).ok, true);
  const tracker = createAdmissionTracker(); tracker.holder.store = store;
  tracker.admit('s', row('glob')); await tracker.drain();
  assert.equal(records.get('s').admissions[0].name, 'glob');
  assert.deepEqual(counts(), { opens: 2, closes: 0, writes: 2 });
  await tracker.dispose(); await store.close(); await store.close();
  assert.equal(counts().closes, 1);
});
