import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtcDisclosure } from '../../adapters/dsh/ptc-sdk.mjs';

function agentWith(known, mode = 'ptc') {
  const calls = [];
  let installed = null;
  const agent = {
    session: { id: 's1' },
    ctx: {
      tools: {
        restrict(filter) {
          calls.push(filter);
          installed = filter;
          return () => { installed = null; };
        },
      },
    },
  };
  const ctx = {
    tools: {
      modeFor: () => mode,
      view: () => ({ restrictableNames: new Set(known) }),
    },
  };
  return { agent, ctx, calls, current: () => installed };
}

test('PTC off lifts any restriction and does not install one', () => {
  const { agent, ctx, calls } = agentWith(['tool_list', 'read']);
  const ptc = createPtcDisclosure({
    ctx,
    lifecycle: { currentAlwaysNames: () => ['read'], sessions: new Map() },
    enabled: () => false,
  });
  assert.equal(ptc.sync(agent), false);
  assert.equal(calls.length, 0);
});

test('PTC on uses the adopted baseline and only valid selections', () => {
  const { agent, ctx, calls } = agentWith(['tool_list', 'tool_search', 'tool_load', 'read', 'hidden', 'stale', 'run_code']);
  const sessions = new Map([['s1', {
    scope: { sessionId: 's1' },
    alwaysNameSet: new Set(['read']),
    engine: {
      getState: () => ({
        mode: 'ready',
        invalidated: new Map([['gone', { reason: 'definition-changed' }]]),
        selected: new Map([
          ['ok', { toolId: 'ok', name: 'hidden', revision: 'r1' }],
          ['old', { toolId: 'old', name: 'stale', revision: 'r0' }],
          ['gone', { toolId: 'gone', name: 'hidden', revision: 'r9' }],
        ]),
      }),
      getCatalog: () => ({
        entries: new Map([
          ['ok', { name: 'hidden', revision: 'r1' }],
          ['old', { name: 'stale', revision: 'r1' }],
        ]),
      }),
    },
  }]]);
  const ptc = createPtcDisclosure({
    ctx,
    lifecycle: { currentAlwaysNames: () => ['live-config', 'run_code'], sessions },
    enabled: () => true,
  });
  assert.equal(ptc.sync(agent), true);
  assert.deepEqual(calls[0].allow.sort(), ['hidden', 'read', 'tool_list', 'tool_load', 'tool_search']);
  assert.equal(calls[0].allow.includes('live-config'), false);
  assert.equal(calls[0].allow.includes('stale'), false);
});

test('replacing the restriction disposes the previous one', () => {
  const { agent, ctx } = agentWith(['tool_list']);
  let disposed = 0;
  agent.ctx.tools.restrict = () => () => { disposed += 1; };
  const ptc = createPtcDisclosure({
    ctx,
    lifecycle: { currentAlwaysNames: () => [], sessions: new Map() },
    enabled: () => true,
  });
  ptc.sync(agent);
  ptc.sync(agent);
  assert.equal(disposed, 1);
  ptc.lift(agent);
  assert.equal(disposed, 2);
  ptc.sync(agent);
  ptc.disposeAll();
  assert.equal(disposed, 3);
});
