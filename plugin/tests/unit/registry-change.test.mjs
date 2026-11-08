import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryChangeTracker } from '../../adapters/dsh/registry-change.mjs';

function fixture() {
  const global = { tools: new Map(), restrictions: new Map() };
  const scoped = { tools: new Map(), restrictions: new Map() };
  const owned = new Set();
  const tools = { layers: { global, scoped: new Map([['a', scoped]]) } };
  const tracker = createRegistryChangeTracker(tools, () => owned);
  return { global, scoped, owned, tracker };
}
const registration = name => ({ definition: { name, description: name, parameters: {} } });

function fixtureWith(ignoredFactory) {
  const global = { tools: new Map(), restrictions: new Map() };
  const scoped = { tools: new Map(), restrictions: new Map() };
  const tools = { layers: { global, scoped: new Map([['a', scoped]]) } };
  return { global, scoped, tracker: createRegistryChangeTracker(tools, ignoredFactory) };
}

test('owned mask installation, replacement and removal do not refresh session catalogs', () => {
  const { scoped, owned, tracker } = fixture();
  const first = { allow: new Set(['tool_list']) };
  scoped.restrictions.set(1, first); owned.add(first);
  assert.equal(tracker.changed(), false);
  const second = { allow: new Set(['tool_list', 'loaded']) };
  scoped.restrictions.set(2, second); owned.add(second);
  scoped.restrictions.delete(1); owned.delete(first);
  assert.equal(tracker.changed(), false);
  scoped.restrictions.delete(2); owned.delete(second);
  assert.equal(tracker.changed(), false);
});

test('reentrant global and scoped registrations during a mask mutation still require reconciliation', () => {
  const { global, scoped, owned, tracker } = fixture();
  const mask = { allow: new Set(['tool_list']) };
  scoped.restrictions.set(1, mask); owned.add(mask);
  global.tools.set('third-party', registration('third-party'));
  scoped.tools.set('own', registration('own'));
  // This is the queued microtask's settled observation, not the transient mask.
  assert.equal(tracker.changed(), true);
  assert.equal(tracker.changed(), false, 'one settled alignment suffices');
  global.tools.get('third-party').definition.description = 'changed in place';
  assert.equal(tracker.changed(), true, 'same-name definition changes are real changes');
  scoped.restrictions.set(2, { deny: new Set(['third-party']) });
  assert.equal(tracker.changed(), true, 'third-party restrictions must never be ignored');
});

test('unknown registry shape conservatively refreshes', () => {
  assert.equal(createRegistryChangeTracker({}).changed(), true);
});

test('array-shaped owned filters (mask.ownedFilters() contract) are ignored like sets', () => {
  const owned = [];
  const { scoped, tracker } = fixtureWith(() => owned);
  const first = { allow: new Set(['tool_list']) };
  scoped.restrictions.set(1, first); owned.push(first);
  assert.equal(tracker.changed(), false);
  const second = { allow: new Set(['tool_list', 'loaded']) };
  scoped.restrictions.set(2, second); owned.push(second);
  scoped.restrictions.delete(1); owned.splice(0, 1);
  assert.equal(tracker.changed(), false);
  scoped.restrictions.delete(2); owned.length = 0;
  assert.equal(tracker.changed(), false);
  scoped.restrictions.set(3, { deny: new Set(['third-party']) });
  assert.equal(tracker.changed(), true, '第三方 restriction 在数组口径下同样不得被忽略');
});

test('other iterable owned-filter sources are normalized to a set', () => {
  const owned = [];
  const { scoped, tracker } = fixtureWith(() => owned.values());
  const mask = { allow: new Set(['tool_list']) };
  scoped.restrictions.set(1, mask); owned.push(mask);
  assert.equal(tracker.changed(), false);
  scoped.restrictions.set(2, { deny: new Set(['third-party']) });
  assert.equal(tracker.changed(), true);
});

test('unknown ignored-filter shapes conservatively refresh instead of guessing', () => {
  const sources = [() => ({}), () => 42, () => null, () => undefined, () => 'not-a-filter-set'];
  for (const [index, source] of sources.entries()) {
    const { tracker } = fixtureWith(source);
    assert.equal(tracker.changed(), true, `shape #${index} must refresh`);
  }
});

