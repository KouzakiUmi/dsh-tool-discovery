// Registration-only official SDK probes. Never execute tools, start agents,
// access a profile, launch terminals, or prepare dependency payloads.
import { dshModule } from '../../contracts/install-resolver.mjs';

export async function captureExtraBuiltins() {
  const rows = [];
  const add = (packageName, variant, definition) => {
    const wire = { name: definition.name, description: definition.description, parameters: definition.parameters };
    if (!rows.some(row => JSON.stringify(row.wire) === JSON.stringify(wire))) rows.push({ package: packageName, variant, wire });
    return () => {};
  };
  const variants = {
    todo: [{ allowParallelInProgress: true }, { allowParallelInProgress: false }],
    'fs-search': [{ sampleOverCapGlobResults: false }, { sampleOverCapGlobResults: true }],
    terminal: [{ enableRunInBackground: false }, { enableRunInBackground: true }],
    'ask-user': [{ mode: 'legacy' }, { mode: 'timed', timeout: 120 }],
  };
  for (const suffix of ['cordis', 'schedule', 'str-replace-editor', 'workspace-dependencies', 'present', 'subagent-control', 'todo', 'ralph', 'session-query', 'ask-user', 'jobs', 'skill', 'fs-search', 'terminal', 'working-directory', 'bash-persistent', 'pwsh-persistent']) {
    const packageName = '@deepseek-ai/dsh-tool-' + suffix;
    const mod = await import(dshModule(packageName));
    for (const variant of variants[suffix] ?? [{}]) {
      const ctx = {
        fs: {}, tools: { register: definition => add(packageName, variant, definition) },
        on: () => () => {}, effect: () => () => {}, get: () => undefined,
        systemPrompt: { section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 },
        sessionProjections: { register() {} },
        jobs: { attachController() {}, events: { subscribe() {} } },
        inject: (_keys, fn) => { fn(ctx); return () => {}; },
      };
      const input = suffix === 'workspace-dependencies' ? { source: process.cwd() } : variant;
      await mod.apply(ctx, mod.Config ? mod.Config(input) : input);
    }
  }
  const { Context } = await import(dshModule('@deepseek-ai/cordis'));
  const mod = await import(dshModule('@deepseek-ai/dsh-tool-subagent'));
  for (const inherits of [false, true]) for (const continuable of [false, true]) for (const selectable of [false, true]) for (const defaults of selectable ? [false, true] : [false]) {
    const variant = { inherits, continuable, selectable, defaults };
    const ctx = new Context();
    try {
      const routes = [{ provider: 'fixture-provider', model: 'fixture-model' }];
      const backend = { name: 'fixture-backend', inheritsParentContext: inherits, capabilities: { depthLimit: true, agentOptions: true },
        ...(continuable ? { prepareContinuable: () => { throw new Error('No execution allowed'); } } : {}),
        ...(defaults ? { agentRouteDefaults: { provider: 'fixture-provider', model: 'fixture-model' } } : {}),
      };
      ctx.provide('tools', { register: definition => add('@deepseek-ai/dsh-tool-subagent', variant, definition) });
      ctx.provide('systemPrompt', { section() {}, context() {}, getSectionOrder: () => 1, getContextOrder: () => 1 });
      ctx.provide('sessionProjections', { register() {}, stateOf: () => selectable ? routes : undefined });
      ctx.provide('subagents', { getProvider: () => backend, resolveMaxDepth: () => undefined });
      if (selectable) ctx.provide('subagentModelSelection', { current: () => ({ enabled: true, allowedModels: routes }) });
      await mod.apply(ctx, mod.Config({ provider: 'fixture-backend', toolName: inherits ? 'subagent_fork' : 'subagent', maxDepth: 'provider-managed', modelSelectionSettings: selectable }), selectable ? { firstLiveSeq: 1 } : undefined);
    } finally { await ctx.fiber.dispose(); }
  }
  const ctx = new Context();
  try {
    ctx.provide('tools', { register: definition => add('@deepseek-ai/dsh-plan-mode', {}, definition) });
    ctx.provide('systemPrompt', { section() {}, getSectionOrder: () => 1 });
    ctx.provide('sessionProjections', { register() {} });
    await ctx.plugin((await import(dshModule('@deepseek-ai/dsh-plan-mode'))).default, { section: 'Fixture plan guidance; no live agent.' }).await();
  } finally { await ctx.fiber.dispose(); }
  return rows;
}
