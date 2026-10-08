import test from 'node:test';
import assert from 'node:assert/strict';
import { isRuntimeSubagent, requiresTrustedEpoch } from '../../adapters/dsh/epoch-policy.mjs';

test('child exemption requires positive live runtime ownership, never id/header/meta or durable fork lineage', () => {
  const root = { id: 'root', session: { header: { parentId: 'pretend', subagent: true } } };
  const child = { id: 'child' };
  const forkResumedAsRoot = { id: 'fork-root', session: { inheritedEventCount: 99 } };
  const agents = { list: () => [root, child, forkResumedAsRoot], roots: () => [root, forkResumedAsRoot] };
  assert.equal(isRuntimeSubagent(agents, child), true);
  for (const agent of [root, forkResumedAsRoot, { id: 'child', parentId: 'root' }, undefined]) {
    assert.equal(isRuntimeSubagent(agents, agent), false);
    assert.equal(requiresTrustedEpoch({ requireTrustedEpoch: true }, agents, agent), true);
  }
  assert.equal(requiresTrustedEpoch({ requireTrustedEpoch: true }, undefined, child), true);
  assert.equal(requiresTrustedEpoch({ requireTrustedEpoch: true }, { list: () => { throw new Error('unknown'); }, roots: () => [] }, child), true);
});

test('root switch is master; child strict is opt-in, all four combinations', () => {
  const root = {}; const child = {};
  const agents = { list: () => [root, child], roots: () => [root] };
  for (const main of [false, true]) for (const sub of [false, true]) {
    const config = { requireTrustedEpoch: main, requireTrustedEpochForSubagents: sub };
    assert.equal(requiresTrustedEpoch(config, agents, root), main);
    assert.equal(requiresTrustedEpoch(config, agents, child), main && sub);
  }
});
