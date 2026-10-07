// plugin/tests/unit/registry.test.mjs
// 绑定代次稳定性回归：把「无关 tools/change 不得作废已有 selected」这条产品需求
// 钉在 registry + domain refreshCatalog 的真实接缝上。
//
// 背景：bindingGeneration 曾是**scope 级**单一代次，被原样盖到该 scope 的每个
// binding 上；而 domain 的 revision 含 bindingGeneration（domain/catalog.mjs），
// 于是宿主广播的每一次 tools/change（dsh-tools 对任一 scope 的任一次
// register/dispose 都广播）都会改写全量 revision，refreshCatalog 随即把所有
// selected 判成 definition-changed 全部作废。
//
// 本文件只钉住代次语义，不引入新框架：
//   * 无关增删 / 跨 scope 事件 → 已有 binding 的 generation 不变；
//   * 同名同 wire 但 definition **实例**被替换 → generation 必须变；
//   * wire 变化 → generation 必须变；
//   * 移除后重加 → 不得复用旧 generation；
//   * 新 registry（冷启动）用同一 wire 重建 → generation 与首次激活一致（确定性）；
//   * scope 目录代次仍按 tools/change 推进（旧 ref/cursor 失效路径不受影响）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRegistryAdapter, scopeKeyOf } from '../../adapters/dsh/registry.mjs'
import { makeEngine, commitLoad, SCOPE_A } from './helpers.mjs'

const ENTRY_NAMES = ['tool_list', 'tool_search', 'tool_load']

function def (name, description = `synthetic description for ${name}`) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }
}

/** 最小宿主面：只实现 registry 真实使用的 view/get/modeFor。 */
function fakeCtx () {
  const global = new Map()
  const scopes = new Map()
  const ctx = {
    tools: {
      modeFor: () => 'native',
      view (scope) {
        const visible = new Map(global)
        const own = scope === undefined || scope === null ? undefined : scopes.get(scopeKeyOf(scope))
        if (own !== undefined) for (const [name, definition] of own) visible.set(name, definition)
        return {
          visible,
          knownNames: new Set(visible.keys()),
          restrictableNames: new Set(visible.keys()),
        }
      },
      get (name, scope) { return ctx.tools.view(scope).visible.get(name) },
    },
  }
  return { ctx, global, scopes }
}

function makeRegistry (ctx) {
  return createRegistryAdapter({ ctx, entryNames: ENTRY_NAMES, frameworkRetained: ['final_answer'] })
}

const genOf = (view, name) => view.bindings.find((b) => b.name === name).bindingGeneration

/** 复刻 lifecycle.onRegistryChange 的调用顺序：bump → 重新投影 → diff → remember。 */
function onRegistryChange (registry, scope, engine) {
  registry.bumpGeneration(scope)
  const view = registry.bindingsFor(scope)
  const diff = registry.diffAgainst(scope, view.bindings)
  registry.remember(view.scopeKey, view.bindings)
  return { view, diff, outcome: engine === undefined ? undefined : engine.refreshCatalog(view.bindings) }
}

test('R1: 无关工具新增 → 已有工具的绑定代次与 selected 都不变', async () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  global.set('read_file', def('read_file'))
  global.set('run_shell', def('run_shell'))

  const first = registry.bindingsFor(undefined)
  registry.remember(first.scopeKey, first.bindings)
  const { engine } = await makeEngine({ bindings: first.bindings })
  const loaded = await commitLoad(engine, SCOPE_A, { action: 'load', names: ['read_file'] })
  assert.equal(loaded.applied, true)
  assert.deepEqual([...engine.getState(SCOPE_A).selected.keys()], ['global::read_file'])

  // 一个与本会话毫无关系的工具被后装插件注册进来 → 宿主广播 tools/change
  global.set('web_fetch', def('web_fetch'))
  const { view } = onRegistryChange(registry, undefined, engine)

  assert.equal(genOf(view, 'read_file'), genOf(first, 'read_file'))
  assert.equal(genOf(view, 'run_shell'), genOf(first, 'run_shell'))
  assert.deepEqual([...engine.getState(SCOPE_A).selected.keys()], ['global::read_file'])
  const listed = engine.handleList({ view: 'loaded', category: 'all' }, SCOPE_A)
  assert.deepEqual(listed.data.names, ['read_file'])
})

test('R2: 无关工具删除同样不动已有绑定代次与 selected', async () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  global.set('read_file', def('read_file'))
  global.set('web_fetch', def('web_fetch'))

  const first = registry.bindingsFor(undefined)
  registry.remember(first.scopeKey, first.bindings)
  const { engine } = await makeEngine({ bindings: first.bindings })
  await commitLoad(engine, SCOPE_A, { action: 'load', names: ['read_file'] })

  global.delete('web_fetch')
  const { view, diff } = onRegistryChange(registry, undefined, engine)

  assert.deepEqual(diff.removed, ['global::web_fetch'])
  assert.equal(genOf(view, 'read_file'), genOf(first, 'read_file'))
  assert.deepEqual([...engine.getState(SCOPE_A).selected.keys()], ['global::read_file'])
})

test('R3: 同名同 wire 但 definition 实例被替换 → 绑定代次必须变（selected 随之作废）', async () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  global.set('read_file', def('read_file'))

  const first = registry.bindingsFor(undefined)
  registry.remember(first.scopeKey, first.bindings)
  const { engine } = await makeEngine({ bindings: first.bindings })
  await commitLoad(engine, SCOPE_A, { action: 'load', names: ['read_file'] })

  // 另一个插件抢注同名同 schema 的工具：wire 完全相同，实例不同
  global.set('read_file', def('read_file'))
  const { view } = onRegistryChange(registry, undefined, engine)

  assert.notEqual(genOf(view, 'read_file'), genOf(first, 'read_file'))
  assert.deepEqual([...engine.getState(SCOPE_A).selected.keys()], [])
})

test('R4: wire（描述/参数）变化 → 绑定代次必须变', async () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  global.set('read_file', def('read_file'))

  const first = registry.bindingsFor(undefined)
  registry.remember(first.scopeKey, first.bindings)

  global.set('read_file', def('read_file', 'read a file body, now with line numbers'))
  const { view } = onRegistryChange(registry, undefined)

  assert.notEqual(genOf(view, 'read_file'), genOf(first, 'read_file'))
})

test('R5: 移除后重加（同一实例、同一 wire）不得复用旧绑定代次', async () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  const original = def('read_file')
  global.set('read_file', original)

  const first = registry.bindingsFor(undefined)
  registry.remember(first.scopeKey, first.bindings)
  const genBefore = genOf(first, 'read_file')

  global.delete('read_file')
  const absent = onRegistryChange(registry, undefined)
  assert.equal(absent.view.bindings.some((b) => b.name === 'read_file'), false)

  global.set('read_file', original)
  const readded = onRegistryChange(registry, undefined)

  assert.notEqual(genOf(readded.view, 'read_file'), genBefore)
})

test('R6: 冷恢复兼容：新 registry 实例用同一 wire 重建 → 与首次激活同一代次（确定性，无随机 ID）', () => {
  const { ctx, global } = fakeCtx()
  global.set('read_file', def('read_file'))
  global.set('run_shell', def('run_shell'))

  const beforeRestart = makeRegistry(ctx).bindingsFor(undefined)
  // 字面格式与首代次保持不变（每工具独立 epoch 从 1 起）→ 已有正常回执不因
  // 这次改动而作废，也不需要任何历史代次迁移。
  assert.equal(genOf(beforeRestart, 'read_file'), 'bg_global_1')
  assert.equal(genOf(beforeRestart, 'run_shell'), 'bg_global_1')

  // 模拟重启：全新 adapter 实例、宿主视图不变
  const afterRestart = makeRegistry(ctx).bindingsFor(undefined)

  assert.equal(genOf(afterRestart, 'read_file'), genOf(beforeRestart, 'read_file'))
  assert.equal(genOf(afterRestart, 'run_shell'), genOf(beforeRestart, 'run_shell'))
  assert.deepEqual(
    afterRestart.bindings.map((b) => [b.toolId, b.bindingGeneration]),
    beforeRestart.bindings.map((b) => [b.toolId, b.bindingGeneration]),
  )
})

test('R7: 跨 scope 事件不动另一个 scope 的绑定代次', () => {
  const { ctx, global, scopes } = fakeCtx()
  const registry = makeRegistry(ctx)
  const agentA = { id: 'agent_A' }
  const agentB = { id: 'agent_B' }
  global.set('read_file', def('read_file'))
  scopes.set(scopeKeyOf(agentA), new Map([['scope_tool', def('scope_tool')]]))
  scopes.set(scopeKeyOf(agentB), new Map())

  const firstA = registry.bindingsFor(agentA)
  registry.remember(firstA.scopeKey, firstA.bindings)
  const firstGlobal = registry.bindingsFor(undefined)
  registry.remember(firstGlobal.scopeKey, firstGlobal.bindings)
  const firstB = registry.bindingsFor(agentB)

  // agent_A 的自有层热注册了一个工具
  scopes.get(scopeKeyOf(agentA)).set('another_scope_tool', def('another_scope_tool'))
  const changedA = onRegistryChange(registry, agentA)

  assert.equal(genOf(changedA.view, 'read_file'), genOf(firstA, 'read_file'))
  assert.equal(genOf(changedA.view, 'scope_tool'), genOf(firstA, 'scope_tool'))
  // 另一个 scope 完全不受影响：global 与 agent_B 各自的代次都保持不变
  assert.equal(genOf(registry.bindingsFor(undefined), 'read_file'), genOf(firstGlobal, 'read_file'))
  assert.equal(genOf(registry.bindingsFor(agentB), 'read_file'), genOf(firstB, 'read_file'))
})

test('R8: scope 目录代次仍按 tools/change 推进（旧 ref/cursor 失效路径保留）', () => {
  const { ctx, global } = fakeCtx()
  const registry = makeRegistry(ctx)
  global.set('read_file', def('read_file'))

  const initial = registry.generationFor('global')
  assert.equal(registry.generationFor('global'), initial)
  registry.bumpGeneration(undefined)
  const bumped = registry.generationFor('global')
  assert.notEqual(bumped, initial)
  assert.equal(registry.generationFor('agent:agent_A'), registry.generationFor('agent:agent_A'))
})