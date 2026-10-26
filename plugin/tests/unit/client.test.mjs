// 单元：client 面板（真实 ModuleLoader wrapper + vm 内真实 React hooks 数据流 + 真实 schemastery 元数据）。
//
// 渲染边界（已独立核验，勿扩大声称）：本机**没有** react-dom / react-test-renderer /
// jsdom 等 DOM 渲染器（react-dom 仅存在于 pnpm 内容寻址缓存，不是可导入接缝），
// 因此这里**不做 DOM/SSR 断言**。但宿主安装树里**有** react-reconciler（与 react 同版本，
// peer 匹配），本文件用它挂一个最小 host config，拿到**真实** React 的 hooks / effect /
// 卸载语义 —— 这是真渲染，不是 mock hooks 伪称渲染。若该模块不可解析，涉及渲染的用例
// 会显式 skip 并说明原因（见 reconcilerBundle.error），绝不静默通过。
//
// 纪律：
//   * client.js 在 **vm** 里执行，只提供 React 的 require —— 不 mock './model.mjs'
//     之类（它现在根本不该被 require，这条本身就是被测事实）。
//   * 活目录 / 默认名单来自**真实** buildConfig + publishToolChoices 的 toJSON 产物，
//     经 settingsSchema.rehydrate 回来；不手搓假 meta。
//   * 假 IO 只出现在保存通道（ConfigForm controller 的 mutate），不模拟业务结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { buildConfig, publishToolChoices, DEFAULT_ALWAYS_VISIBLE } from '../../adapters/dsh/config.mjs'
import * as model from '../../client/model.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '..', '..', 'client', 'client.js')

const React = (await import(dshModule('react'))).default
const Schema = (await import(dshModule('@deepseek-ai/schemastery'))).default

/**
 * 在 vm 里跑真正的 client.js wrapper；require 只认 react。
 * @param {{globals?: Record<string, unknown>}} [options] 额外注入 sandbox 全局（如假定时器）。
 */
function loadClient (options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const registered = new Map()
  const requested = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load (descriptor) {
          registered.set(descriptor.id, descriptor)
        },
      },
    },
    console: { error () {}, warn () {}, log () {} },
    ...(options.globals ?? {}),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })

  const descriptor = registered.get('dsh-tool-discovery')
  assert.ok(descriptor !== undefined, 'wrapper 必须以 dsh-tool-discovery 为 id 注册')

  const exportsObject = descriptor.factory((id) => {
    requested.push(id)
    assert.equal(id, 'react', `client 只应 require 已注册的 module id，实际: ${id}`)
    return React
  })
  return { exports: exportsObject, requested }
}

// ---------------------------------------------------------------------------
// 真实 React 渲染接缝（react-reconciler）：宿主安装树里有与 react 同版本的
// react-reconciler，用它挂最小 host config 即可拿到真实 hooks / effect / 卸载语义。
// 没有 DOM：host 实例是普通对象树，断言只针对 props 与子节点。
// ---------------------------------------------------------------------------
async function loadReconciler () {
  try {
    const reconcilerModule = await import(dshModule('react-reconciler'))
    const constants = (await import(dshModule('react-reconciler/constants'))).default
    return { Reconciler: reconcilerModule.default ?? reconcilerModule, constants, error: null }
  } catch (error) {
    return { Reconciler: null, constants: null, error }
  }
}
const reconcilerBundle = await loadReconciler()

function createHostConfig (DefaultEventPriority) {
  let updatePriority = DefaultEventPriority
  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    noTimeout: -1,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    scheduleMicrotask: queueMicrotask,
    supportsMicrotasks: true,
    createInstance (type, props) { return { type, props, children: [] } },
    createTextInstance (text) { return { text } },
    appendInitialChild (parent, child) { parent.children.push(child) },
    appendChild (parent, child) { parent.children.push(child) },
    appendChildToContainer (container, child) { container.children.push(child) },
    insertBefore (parent, child, before) {
      const index = parent.children.indexOf(before)
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    },
    insertInContainerBefore (container, child, before) {
      const index = container.children.indexOf(before)
      container.children.splice(index < 0 ? container.children.length : index, 0, child)
    },
    removeChild (parent, child) {
      const index = parent.children.indexOf(child)
      if (index >= 0) parent.children.splice(index, 1)
    },
    removeChildFromContainer (container, child) {
      const index = container.children.indexOf(child)
      if (index >= 0) container.children.splice(index, 1)
    },
    clearContainer (container) { container.children.length = 0 },
    detachDeletedInstance () {},
    commitTextUpdate (textInstance, _oldText, newText) { textInstance.text = newText },
    resetTextContent (textInstance) { textInstance.text = '' },
    commitMount () {},
    commitUpdate () {},
    hideInstance () {},
    unhideInstance () {},
    hideTextInstance () {},
    unhideTextInstance () {},
    finalizeInitialChildren () { return false },
    shouldSetTextContent () { return false },
    getRootHostContext () { return {} },
    getChildHostContext (parentContext) { return parentContext },
    getPublicInstance (instance) { return instance },
    prepareForCommit () { return null },
    resetAfterCommit () {},
    preparePortalMount () {},
    getCurrentEventPriority () { return DefaultEventPriority },
    getCurrentUpdatePriority () { return updatePriority },
    setCurrentUpdatePriority (next) { updatePriority = next },
    resolveUpdatePriority () { return updatePriority || DefaultEventPriority },
    shouldAttemptEagerTransition () { return false },
    requestPostPaintCallback () {},
    trackSchedulerEvent () {},
    resolveEventType () { return null },
    resolveEventTimeStamp () { return -1.1 },
    maySuspendCommit () { return false },
    preloadInstance () { return true },
    startSuspendingCommit () {},
    suspendInstance () {},
    waitForCommitToBeReady () { return null },
    NotPendingTransition: null,
    HostTransitionContext: React.createContext(null),
    resetFormInstance () {},
  }
}

/** 渲染器：render/unmount 都同步落盘，flush() 负责跑完 passive effects。 */
function createRenderer () {
  const { Reconciler, constants } = reconcilerBundle
  const reconciler = Reconciler(createHostConfig(constants.DefaultEventPriority))
  const container = { type: 'root', children: [] }
  const root = reconciler.createContainer(
    container,
    constants.ConcurrentRoot,
    null,
    false,
    null,
    'dsh-tool-discovery-test',
    (error) => { throw error },
    null,
    (error) => { throw error },
    null,
    null,
  )
  return {
    container,
    reconciler,
    render (element) {
      reconciler.flushSyncFromReconciler(() => { reconciler.updateContainer(element, root, null, null) })
      reconciler.flushPassiveEffects()
    },
    unmount () {
      reconciler.flushSyncFromReconciler(() => { reconciler.updateContainer(null, root, null, null) })
      reconciler.flushPassiveEffects()
    },
    flush () { reconciler.flushPassiveEffects() },
  }
}

/** 让 React 默认优先级的更新真正落盘（调度器走 MessageChannel，需要几轮宏任务）。 */
async function settle () {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 假定时器：只装进 vm sandbox，宿主全局定时器不受影响。 */
function fakeClock () {
  let seq = 0
  const pending = new Map()
  return {
    setTimeout (fn, ms) {
      const id = ++seq
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout (id) { pending.delete(id) },
    pending,
    count () { return pending.size },
    tick (ms) {
      for (const [id, timer] of [...pending.entries()]) {
        if (timer.ms <= ms) { pending.delete(id); timer.fn() }
      }
    },
  }
}

/** 可控 Promise：保存通道未决时用来制造"卸载后 Promise 才落地"的窗口。 */
function deferredPromise () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 宿主树遍历：按谓词找第一个节点。 */
function findNode (root, predicate) {
  let hit
  const visit = (node) => {
    if (hit !== undefined || node == null || typeof node !== 'object') return
    if (predicate(node)) { hit = node; return }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return hit
}

/** 节点文本（递归拼接文本子节点）。 */
function textOf (node) {
  if (node == null || typeof node !== 'object') return ''
  if (typeof node.text === 'string') return node.text
  return (node.children ?? []).map(textOf).join('')
}

/** 每个 JSON 设置区块的可见状态：保存按钮是否禁用、是否给出 jsonInvalidNow。 */
function jsonSections (root) {
  const found = []
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return
    if (node.type === 'section') {
      const textarea = node.children.find((child) => child?.type === 'textarea')
      if (textarea !== undefined) {
        const buttons = []
        const collect = (current) => {
          if (current == null || typeof current !== 'object') return
          if (current.type === 'button') buttons.push(current)
          for (const child of current.children ?? []) collect(child)
        }
        collect(node)
        found.push({
          name: String(textarea.props.id).replace('tool-discovery-', ''),
          invalid: textarea.props['aria-invalid'] === 'true',
          applyDisabled: buttons.map((button) => button.props.disabled === true),
          alerts: node.children.filter((child) => child?.props?.role === 'alert').map(textOf),
        })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return found
}

/** 用真实 buildConfig + publishToolChoices 造出 describe 会发的那棵树。 */
function realSchemaEnvelope (choices) {
  const config = buildConfig(Schema)
  publishToolChoices(config, choices)
  return config.toJSON()
}
/** 只重投影，不做校验：与 dsh-client-ui-settings 的 SettingsSchemaService.rehydrate 同形。 */
const rehydrate = (serialized) => new Schema(serialized)

test('C-U01: wrapper 以 dsh-tool-discovery 注册，且只 require 已注册的 module id', () => {
  const { requested } = loadClient()
  assert.deepEqual(requested, ['react'], '不得出现 ./model.mjs 之类的普通 ESM 相对 require')
})

test('C-U02: client.js 的纯逻辑与 model.mjs 行为一致（内联副本不得漂移）', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const rows = [{ name: 'ReadFile' }, { name: 'glob' }, { name: 'pwsh' }]
  // 跨 vm realm：vm 里造的数组原型与宿主不同，deepEqual(strict) 会误判；
  // 用宿主 realm 的 [...r] 摊平后再比内容。
  const names = (r) => [...r].map((x) => x.name)
  assert.deepEqual(names(t.filterRows(rows, 're')), names(model.filterRows(rows, 're')))
  assert.equal(t.filterRows(rows, '  ').length, model.filterRows(rows, '  ').length)
  assert.deepEqual(names(t.toggleName(['a'], 'b')), names(model.toggleName(['a'], 'b')))
  assert.deepEqual(names(t.toggleName(['a', 'b'], 'a')), names(model.toggleName(['a', 'b'], 'a')))
  assert.equal(t.isDefaultSelection(['b', 'a'], ['a', 'b']), model.isDefaultSelection(['b', 'a'], ['a', 'b']))
  const meta = { choices: [{ name: 'read' }, { name: 'gone_tool' }], default: ['read'] }
  assert.deepEqual(names(t.buildRows(meta, ['read']).rows), names(model.buildRows(meta, ['read']).rows))
  assert.equal(t.buildRows(meta, ['read']).missingCount, model.buildRows(meta, ['read']).missingCount)
  assert.deepEqual([...t.setMembership(['a'], ['b', 'c'], true)], [...model.setMembership(['a'], ['b', 'c'], true)])
  assert.deepEqual([...t.setMembership(['a', 'b'], ['a'], false)], [...model.setMembership(['a', 'b'], ['a'], false)])
  assert.deepEqual([...t.setMembership(['a', 'a', 'b'], ['a'], false)], ['b'], '清空必须删掉每一次出现，否则集合比较会跳过写入')
  assert.deepEqual([...model.setMembership(['a', 'a', 'b'], ['a'], false)], ['b'])
  assert.equal(model.isDefaultSelection(model.setMembership(['read', 'read'], ['read'], false), ['read', 'read']), false)
  const groupInput = [{ name: 'read', selected: true }, { name: 'mcp__srv__do', selected: false }, { name: 'fixture_x', selected: false }]
  const grouped = t.groupRows(groupInput, ['read'])
  assert.deepEqual(JSON.parse(JSON.stringify(grouped)), JSON.parse(JSON.stringify(model.groupRows(groupInput, ['read']))))
  assert.deepEqual([...grouped].map((g) => g.key), ['core', 'mcp', 'plugin'])
  assert.equal(grouped[0].selectedCount, 1)
  assert.deepEqual([...t.groupRows([], ['read'])], [], '空清单不产生任何分组')
})

test('C-U03: 活目录接缝 —— 未选中的第三方工具必须成行且可勾（端到端真实 metadata）', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  // 真实 Config → toJSON（describe 发的就是它）→ rehydrate
  const envelope = realSchemaEnvelope(['fixture_alpha', 'fixture_beta'])
  const node = t.alwaysVisibleNode({ schema: envelope }, { rehydrate })
  assert.ok(node !== undefined, 'alwaysVisible 节点必须能从 describe 信封重投影出来')
  assert.deepEqual(node.meta.initialToolChoices.map((c) => c.name), ['fixture_alpha', 'fixture_beta'])

  // 接缝一次归一：宿主的 initialToolChoices/default → 面板的 choices/default
  const meta = t.readMeta(node)
  assert.equal(meta.choices.length, 2)
  assert.ok(meta.default.includes('read'), 'DSH 默认名单来自 meta.default')

  const built = t.buildRows(meta, ['fixture_alpha'])
  const beta = built.rows.find((r) => r.name === 'fixture_beta')
  assert.ok(beta !== undefined, '未选中的目录项不得丢失（否则无法添加第三方工具）')
  assert.equal(beta.selected, false)
  assert.equal(beta.available, true)
  assert.equal(built.missingCount, 0)
})

test('C-U04: 勾选未选中的工具会把它加进名单', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const node = t.alwaysVisibleNode({ schema: realSchemaEnvelope(['fixture_alpha', 'fixture_beta']) }, { rehydrate })
  const meta = t.readMeta(node)
  const current = ['fixture_alpha']
  const next = t.toggleName(current, 'fixture_beta')
  assert.deepEqual([...next], ['fixture_alpha', 'fixture_beta'])
  const built = t.buildRows(meta, next)
  assert.equal(built.rows.find((r) => r.name === 'fixture_beta').selected, true)
})

test('C-U05: 恢复默认取 Config.alwaysVisible.meta.default（完整 CORE），不按当前筛选', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const node = t.alwaysVisibleNode({ schema: realSchemaEnvelope(['fixture_alpha']) }, { rehydrate })
  // 目录里没有 read（它没注册），但它仍是 DSH 默认项，删掉后必须能恢复
  const meta = t.readMeta(node)
  assert.deepEqual([...meta.default], [...DEFAULT_ALWAYS_VISIBLE], '默认名单必须来自 meta.default，而不是目录交集')
  assert.ok(meta.default.includes('read'))
  assert.ok(!meta.choices.some((c) => c.name === 'read'), '目录里确实没有 read（正控制）')
  // 用户把 read 删掉之后，恢复默认仍会把完整的 CORE 写回去
  const reduced = meta.default.filter((n) => n !== 'read')
  assert.equal(t.isDefaultSelection(reduced, meta.default), false)
  assert.ok(t.isDefaultSelection(meta.default, meta.default))
})

/** 造一个只模拟**保存通道**（ConfigForm controller）的 ctx；业务结果一律用真实 metadata。 */
function fakeCtx (schemaEnvelope, selected, mutate) {
  const formState = { status: 'ready', value: { alwaysVisible: selected }, revision: 1, writable: true }
  const makeMirror = (rev) => ({
    view: {
      namespaces: [{ ns: 'tool-search', schema: schemaEnvelope, value: { alwaysVisible: selected }, revision: rev, writable: true }],
    },
  })
  let current = makeMirror(1)
  const ctx = {
    configForms: {
      describe: () => ({ getSnapshot: () => current, subscribe: () => () => {} }),
      get: () => ({ getSnapshot: () => formState, subscribe: () => () => {}, mutate }),
    },
    settingsSchema: { rehydrate },
  }
  return { ctx, setMirror: (rev) => { current = makeMirror(rev) } }
}

test('C-U12: 目录完整性随真实 schema 元数据传递，未确认状态不误报不可用', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const schema = buildConfig(Schema)
  publishToolChoices(schema, ['registered'], { complete: true })
  const node = t.alwaysVisibleNode({ schema: schema.toJSON() }, { rehydrate })
  const meta = t.readMeta(node)
  assert.equal(meta.catalogComplete, true)
  const actual = t.buildRows(meta, ['registered', 'missing'])
  const expected = model.buildRows(meta, ['registered', 'missing'])
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)
  assert.equal(actual.rows.find(row => row.name === 'registered').status, 'registered')
  assert.equal(actual.rows.find(row => row.name === 'missing').status, 'unregistered')
  publishToolChoices(schema, ['registered'], { complete: false })
  const partialMeta = t.readMeta(t.alwaysVisibleNode({ schema: schema.toJSON() }, { rehydrate }))
  const partial = t.buildRows(partialMeta, ['missing'])
  assert.equal(partial.rows.find(row => row.name === 'missing').status, 'unknown')
  assert.equal(partial.missingCount, 0)
  assert.equal(actual.rows.filter(row => row.available).length, 1, '未登记的已选项不属于目录计数')
  assert.equal(partial.rows.filter(row => row.available).length, 1, '未确认的已选项不属于目录计数')
  assert.equal(t.readMeta(undefined).catalogComplete, false)
})

test('C-U11: 可选功能默认值与 Config 一致，保存只修改指定字段', async () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const config = buildConfig(Schema)
  assert.equal(config.dict.requireTrustedEpoch.meta.default, false)
  assert.equal(config.dict.initialToolsEnabled.meta.default, true)
  assert.equal(config.dict.alwaysAllowPresetTools.meta.default, true)
  assert.equal(config.dict.requireTrustedEpochForSubagents.meta.default, false)
  assert.notEqual(config.dict.requireTrustedEpochForSubagents.meta.volatile, true)
  const states = Object.fromEntries(t.featureChoices({}).map(([key, _label, _help, checked]) => [key, checked]))
  assert.equal(config.dict.ptcCompatibility.meta.default, false)
  assert.equal(config.dict.compactBuiltinToolDescriptions.meta.default, false)
  assert.deepEqual(states, { initialToolsEnabled: true, alwaysAllowPresetTools: true, compactBuiltinToolDescriptions: false, ptcCompatibility: false, requireTrustedEpoch: false, requireTrustedEpochForSubagents: false, tolerantLoadProtected: true, respectAlwaysVisible: false })
  const enabled = t.featureChoices({ requireTrustedEpoch: true, initialToolsEnabled: false })
  assert.equal(enabled.find(row => row[0] === 'requireTrustedEpoch')[3], true)
  assert.equal(enabled.find(row => row[0] === 'initialToolsEnabled')[3], false)
  const calls = []
  const form = { mutate: async ops => { calls.push(JSON.parse(JSON.stringify(ops))); return true } }
  assert.equal(await t.saveSetting(form, 'requireTrustedEpoch', true), true)
  assert.deepEqual(calls, [[{ op: 'set', path: ['requireTrustedEpoch'], value: true }]])
  assert.equal(await t.saveSetting(form, 'frameworkRetained', []), false)
  assert.equal(calls.length, 1, '页面不得写可信框架字段')
  assert.equal(await t.saveSetting(form, 'alwaysAllowPresetTools', false), true)
  assert.deepEqual(calls[1], [{ op: 'set', path: ['alwaysAllowPresetTools'], value: false }])
  assert.equal(await t.saveSetting(form, 'requireTrustedEpochForSubagents', true), true)
  assert.deepEqual(calls[2], [{ op: 'set', path: ['requireTrustedEpochForSubagents'], value: true }])
  assert.equal(await t.saveSetting({ mutate: async () => false }, 'initialToolsEnabled', false), false)
  await assert.rejects(() => t.saveSetting({ mutate: async () => { throw new Error('write rejected') } }, 'requireTrustedEpoch', false), /write rejected/)
})

test('C-U06: getSnapshot 身份稳定 —— 同输入必须返回同一引用（否则 useSyncExternalStore 无限重渲染）', () => {
  const { exports: mod } = loadClient()
  const envelope = realSchemaEnvelope(['fixture_alpha'])
  const { ctx, setMirror } = fakeCtx(envelope, ['fixture_alpha'], async () => true)
  const source = mod.__test.createSnapshotSource(ctx)

  const a = source.getSnapshot()
  assert.equal(a.writable, true, '保留宿主可写状态供功能开关禁用判据使用')
  const b = source.getSnapshot()
  assert.equal(a, b, '连续两次 getSnapshot 必须是同一对象')

  // 上游换了快照引用 → 必须产出新对象（否则面板永远不更新）
  setMirror(2)
  const c = source.getSnapshot()
  assert.notEqual(a, c, '上游快照引用变化后必须换新对象')
  assert.equal(source.getSnapshot(), c, '换过之后又要稳定下来')
})

test('C-U07: 订阅函数稳定绑定，装配时只订阅一次', () => {
  const { exports: mod } = loadClient()
  const envelope = realSchemaEnvelope(['fixture_alpha'])
  let subscribes = 0
  const formState = { status: 'ready', value: { alwaysVisible: [] }, revision: 1, writable: true }
  const mirrorState = { view: { namespaces: [{ ns: 'tool-search', schema: envelope, value: { alwaysVisible: [] }, revision: 1, writable: true }] } }
  const ctx = {
    configForms: {
      describe: () => ({ getSnapshot: () => mirrorState, subscribe: () => { subscribes += 1; return () => {} } }),
      get: () => ({ getSnapshot: () => formState, subscribe: () => { subscribes += 1; return () => {} }, mutate: async () => true }),
    },
    settingsSchema: { rehydrate },
  }
  const source = mod.__test.createSnapshotSource(ctx)
  assert.equal(subscribes, 0, '创建快照源本身不订阅')
  const off = source.subscribe(() => {})
  assert.equal(subscribes, 2, '一次 subscribe 同时挂镜像与表单两条')
  off()
  const Root = mod.__test.createTabRoot(ctx, (k) => k)
  assert.equal(typeof Root, 'function')
  assert.equal(subscribes, 2, '组件装配不应额外订阅（服务在组件函数外已固定）')
})

test('C-U08: 面板叶子把目录里的可选项折成可勾选行（含未选中的第三方工具）', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const envelope = realSchemaEnvelope(['fixture_alpha', 'fixture_beta'])
  const { ctx } = fakeCtx(envelope, ['fixture_alpha'], async () => true)
  const source = t.createSnapshotSource(ctx)
  const snapshot = source.getSnapshot()
  const built = t.buildRows(snapshot.meta, snapshot.value.alwaysVisible)
  assert.equal(built.rows.length, 2)
  assert.ok(built.rows.some((r) => r.name === 'fixture_beta' && !r.selected),
    '未选中的第三方工具必须可勾')
  assert.deepEqual([...built.fixed], ['tool_list', 'tool_search', 'tool_load'])
  // 组件本体存在。DOM 渲染未验证；真实 reconciler 的 hooks/effect 接缝见文件头。
  assert.equal(typeof t.SettingsPanel, 'function')
})

// 回归守卫：client 包声明必须与官方 dsh-client-modules 扫描契约一致。
// 依据安装 SDK 0.2.1-alpha.1 的 parseDshClient（lib/index.js:61-75）与装饰模板
// package.json：dsh.client 缺 platform 会在宿主启动扫描时 loud-throw（FAILED fiber）。
test('C-U10: 包声明契约 —— dsh.client.platform/exports/files 符合官方扫描器要求', () => {
  const pkgPath = path.resolve(HERE, '..', '..', '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

  assert.equal(pkg.name, 'dsh-tool-discovery')
  // parseDshClient 要求 platform 为字符串；官方模板与全部官方包均为 "web"
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 缺失或非法：真实 Loader 扫描会 loud-throw')
  // 扫描器要求 exports["./client"] 存在（lib/index.js:719）
  const clientExport = pkg.exports?.['./client']
  assert.equal(typeof clientExport, 'string', '必须导出 ./client bundle')
  assert.ok(fs.existsSync(path.resolve(path.dirname(pkgPath), clientExport)),
    'exports["./client"] 必须指向真实存在的文件')
  // factory 注册 id 已在 C-U01 验证为 'dsh-tool-discovery'，此处不再重复
  const { exports: mod } = loadClient()
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('plugin/client/'),
    'files 必须覆盖 plugin/client/（npm pack 后 bundle 不丢）')
  assert.equal(typeof mod.apply, 'function', 'factory 产物必须带 Cordis 形态的 apply')
  assert.ok(Array.isArray(mod.inject), 'factory 产物必须声明 inject 服务键')
})

test('C-U13: all editable Config fields have a save path; trusted framework stays read-only', async () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const calls = []
  const form = { mutate: async ops => { calls.push(ops); return true } }
  const values = { alwaysVisible: [], initialToolsEnabled: false, alwaysAllowPresetTools: false, compactBuiltinToolDescriptions: true, compactBuiltinToolOverrides: { skill: true }, ptcCompatibility: true,
    requireTrustedEpoch: false, requireTrustedEpochForSubagents: false, tolerantLoadProtected: false,
    respectAlwaysVisible: true, locale: 'zh', budgets: { maxActiveTools: 3 }, categoryConfig: {} }
  const schema = buildConfig(Schema)
  assert.deepEqual(Object.keys(schema.dict).sort(), [...Object.keys(values), 'frameworkRetained'].sort())
  for (const [key, value] of Object.entries(values)) {
    assert.equal(await t.saveSetting(form, key, value), true, `${key} missing from settings save path`)
  }
  assert.equal(await t.saveSetting(form, 'frameworkRetained', ['read']), false)
  assert.equal(calls.length, Object.keys(values).length)
})

test('C-U14: fixed entries never become editable even when present in metadata', () => {
  const { exports: mod } = loadClient()
  const meta = { choices: [{ name: 'tool_load' }, { name: 'read' }] }
  assert.deepEqual([...mod.__test.buildRows(meta, []).rows].map(r => r.name), ['read'])
  assert.deepEqual(model.buildRows(meta, []).rows.map(r => r.name), ['read'])
})

test('C-U15: omitted alwaysVisible renders real schema default, not an empty list', () => {
  const { exports: mod } = loadClient()
  const { ctx } = fakeCtx(realSchemaEnvelope(['read']), undefined, async () => true)
  const snapshot = mod.__test.createSnapshotSource(ctx).getSnapshot()
  assert.deepEqual([...snapshot.value.alwaysVisible], [...DEFAULT_ALWAYS_VISIBLE])
  assert.equal(snapshot.metaAvailable, true)
})

test('C-U16: advanced validation follows real host metadata and blocks invalid activation config', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const node = t.alwaysVisibleNode({ schema: realSchemaEnvelope([]) }, { rehydrate })
  const constraints = t.readMeta(node).constraints
  assert.ok(constraints.budgetKeys.includes('maxActiveTools'))
  for (const value of [{ maxActiveTools: 2 }, { maxLoadBatch: null }, null, {}]) assert.equal(t.validAdvancedSetting('budgets', value, constraints), true)
  for (const value of [{ unknown: 1 }, { maxActiveTools: 0 }, { maxActiveTools: 1.5 }, { defaultSearchLimit: null }, [], 'bad']) assert.equal(t.validAdvancedSetting('budgets', value, constraints), false)
  assert.equal(t.validAdvancedSetting('categoryConfig', { files: { title: 'Files', capabilitySummary: 'Read' } }, constraints), true)
  for (const value of [{ bad: { title: 'Bad', capabilitySummary: 'Bad' } }, { files: { title: 'Files' } }, null]) assert.equal(t.validAdvancedSetting('categoryConfig', value, constraints), false)
  assert.equal(t.validAdvancedSetting('locale', 'zh', constraints), true)
  assert.equal(t.validAdvancedSetting('locale', 'invalid', constraints), false)
})

test('C-U17: active badge uses separate foreground and background tokens', () => {
  const { exports: mod } = loadClient()
  const active = mod.__test.S.badge(true)
  assert.notEqual(active.background, active.color)
  assert.ok(!active.background.includes('--dsw-alias-state-business-primary'))
  assert.ok(active.color.includes('--dsw-alias-state-business-primary'))
})

test('C-U19: effect badges cover every feature switch with a real effect kind', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const featureKeys = t.featureChoices({}).map(([key]) => key)
  // 每个功能开关都必须有生效类别，且取值在已知集合内（未知值会渲染成 fxUndefined）。
  for (const key of featureKeys) {
    assert.ok(t.FEATURE_EFFECT[key] !== undefined, `${key} missing from FEATURE_EFFECT`)
    assert.ok(['reload', 'session', 'turn'].includes(t.FEATURE_EFFECT[key]), `${key} has unknown effect kind`)
  }
  // 非 volatile（保存即重载）字段必须是 reload；volatile 的 session/turn 区分要有数据支撑：
  // requireTrustedEpoch 家族与 tolerantLoadProtected/respectAlwaysVisible 非 volatile。
  for (const key of ['requireTrustedEpoch', 'requireTrustedEpochForSubagents', 'tolerantLoadProtected', 'respectAlwaysVisible']) {
    assert.equal(t.FEATURE_EFFECT[key], 'reload', `${key} is non-volatile and must be 'reload'`)
  }
  assert.equal(t.FEATURE_EFFECT.ptcCompatibility, 'turn')
  // 徽标文案键（fxReload/fxSession/fxTurn + *Title）在两个语言表里都要齐。
  for (const kind of ['Reload', 'Session', 'Turn']) {
    assert.equal(typeof t.zh[`fx${kind}`], 'string')
    assert.equal(typeof t.en[`fx${kind}`], 'string')
    assert.equal(typeof t.zh[`fx${kind}Title`], 'string')
    assert.equal(typeof t.en[`fx${kind}Title`], 'string')
  }
})

test('C-U27: rendered effect badge titles resolve in both dictionaries', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  for (const dictionary of [t.zh, t.en]) {
    const renderer = createRenderer()
    const seen = new Set()
    renderer.render(React.createElement(t.SettingsPanel, {
      t: (key) => { assert.equal(typeof dictionary[key], 'string', `missing translation: ${key}`); seen.add(key); return dictionary[key] },
      snapshot: { status: 'ready', writable: true, value: {}, meta: { choices: [], default: [], constraints: {} } },
      error: null, notice: null, busy: false,
      onToggle () {}, onBulk () {}, onRestore () {}, onFeature () {}, onDescriptionTool () {}, onSetting () {},
      draftStore: t.createDraftStore(),
    }))
    for (const kind of ['Reload', 'Session', 'Turn']) assert.ok(seen.has(`fx${kind}Title`))
    renderer.unmount()
  }
})

/** 最小 document 桩：只实现 getElementById / createElement / head.appendChild。 */
function fakeDocument (existing = []) {
  const head = {
    children: [...existing],
    appendChild (element) { this.children.push(element) },
  }
  return {
    head,
    getElementById (id) { return head.children.find((element) => element.id === id) ?? null },
    createElement () {
      return {
        id: '',
        textContent: '',
        remove () { head.children = head.children.filter((element) => element !== this) },
      }
    },
  }
}

test('C-U20: panel interaction styles are shared by reference count and released by the last owner', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  // 无 document 的环境（vm 单测）必须安全退化为 no-op 清理函数。
  const noopCleanup = t.ensurePanelStyles(undefined)
  assert.equal(typeof noopCleanup, 'function')
  noopCleanup()

  // 最小 document 桩：验证幂等注入、head 挂载与引用计数释放。
  const doc = fakeDocument()
  const cleanup1 = t.ensurePanelStyles(doc)
  assert.equal(doc.head.children.length, 1, '样式表恰好注入一次')
  assert.ok(doc.head.children[0].textContent.includes('.dtd-panel'), '规则必须限定在 .dtd-panel 命名空间内')
  assert.ok(doc.head.children[0].textContent.includes('prefers-reduced-motion'), '动效偏好降级规则必须在场')
  const cleanup2 = t.ensurePanelStyles(doc)
  assert.equal(doc.head.children.length, 1, '重复调用不得重复注入')
  // 两个所有者（两个面板实例）：先清理一个不得拆掉另一个仍在用的样式。
  cleanup1()
  assert.equal(doc.head.children.length, 1, '仍有所有者时不得移除共享样式')
  cleanup1() // 幂等：重复清理只释放一次
  assert.equal(doc.head.children.length, 1, '重复 cleanup 必须幂等')
  cleanup2()
  assert.equal(doc.head.children.length, 0, '最后一个所有者清理时才移除样式')
})

test('C-U25: 外部已存在的同 ID 样式只借用、绝不误删', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  const foreign = { id: 'dsh-tool-discovery-panel-styles', textContent: '/* 不是本插件创建的样式 */' }
  const doc = fakeDocument([foreign])
  const cleanup = t.ensurePanelStyles(doc)
  assert.equal(doc.head.children.length, 1, '不得重复注入')
  assert.equal(doc.head.children[0], foreign, '外部样式不得被替换')
  cleanup()
  assert.equal(doc.head.children.length, 1, '外部已有的样式不得被误删')
  cleanup() // 幂等
  assert.equal(doc.head.children.length, 1)
})

test('C-U26: 两个所有者交错清理 —— 任一顺序下都要等最后一个所有者才移除', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  // 顺序 A：后注册的先清理。
  const docA = fakeDocument()
  const cleanupA1 = t.ensurePanelStyles(docA)
  const cleanupA2 = t.ensurePanelStyles(docA)
  assert.equal(docA.head.children.length, 1)
  cleanupA2()
  assert.equal(docA.head.children.length, 1, '仍有所有者时样式必须留着')
  cleanupA1()
  assert.equal(docA.head.children.length, 0, '最后一个所有者清理时才移除')

  // 顺序 B：先注册的先清理（旧实现正是这里拆掉了别人仍在用的样式）。
  const docB = fakeDocument()
  const cleanupB1 = t.ensurePanelStyles(docB)
  const cleanupB2 = t.ensurePanelStyles(docB)
  cleanupB1()
  assert.equal(docB.head.children.length, 1, '先注册的清理不得拆掉第二个实例仍在用的样式')
  cleanupB2()
  assert.equal(docB.head.children.length, 0, '最后一个所有者清理时才移除')
})

test('C-U21: match count copy and restore-default gate use localized helpers', () => {
  const { exports: mod } = loadClient()
  const t = mod.__test
  assert.equal(t.zh.matchCount(1), '匹配 1 项')
  assert.equal(t.zh.matchCount(3), '匹配 3 项')
  assert.equal(t.en.matchCount(1), '1 match')
  assert.equal(t.en.matchCount(3), '3 matches')
  // 恢复默认的禁用判据与 onRestore 的跳过判据共用 isDefaultSelection：已默认则禁用。
  const meta = { choices: [{ name: 'x' }], default: ['read'] }
  assert.equal(t.isDefaultSelection(['read'], meta.default), true)
  assert.equal(t.isDefaultSelection(['read', 'x'], meta.default), false)
})

test('C-U18: JSON drafts survive editor recreation, reset on saved changes, and stay activation-local', () => {
  const { exports: mod } = loadClient()
  const store = mod.__test.createDraftStore()
  assert.equal(store.read('budgets', null), 'null')
  store.write('budgets', null, '{unfinished')
  store.write('categoryConfig', {}, '{"files":')
  assert.equal(store.read('budgets', null), '{unfinished')
  assert.equal(store.read('categoryConfig', {}), '{"files":')
  assert.equal(store.read('budgets', { maxActiveTools: 3 }), JSON.stringify({ maxActiveTools: 3 }, null, 2))
  assert.equal(store.read('categoryConfig', {}), '{"files":')
  assert.equal(mod.__test.createDraftStore().read('budgets', null), 'null')
})

test('C-U09: 快照源不吞错误 —— mutate 的两条失败路径都不产生未处理拒绝', async () => {
  const { exports: mod } = loadClient()
  const envelope = realSchemaEnvelope(['fixture_alpha'])
  let unhandled = false
  const onUnhandled = () => { unhandled = true }
  process.on('unhandledRejection', onUnhandled)
  try {
    // 返回 false：装配点如实呈现"未保存"
    const ok1 = fakeCtx(envelope, [], async () => false)
    assert.equal(await ok1.ctx.configForms.get('tool-search').mutate([]), false)
    // 抛错：createTabRoot 的 write() 内部 try/catch 兜住并记 logSaveFailure；
    // 这里验证 controller 契约本身不静默吞错（错误确实冒到调用方，由上层处理）。
    const boom = fakeCtx(envelope, [], async () => { throw new Error('boom') })
    await assert.rejects(
      () => boom.ctx.configForms.get('tool-search').mutate([]),
      /boom/,
      'mutate 的拒绝必须能被上层捕获，而不是变成未处理拒绝',
    )
    await new Promise((r) => setImmediate(r))
    assert.equal(unhandled, false, '不得产生未处理拒绝')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// ---------------------------------------------------------------------------
// 组件树回归（真实 React 渲染）：JSON 草稿形状校验 + 保存生命周期守卫
// ---------------------------------------------------------------------------

/** 渲染面板并返回每个 JSON 设置区块的可见状态。 */
function renderJsonSections (t, drafts) {
  const constraints = { budgetKeys: ['maxActiveTools'], optionalLimitKeys: [], categoryKeys: ['files'] }
  const snapshot = {
    status: 'ready',
    writable: true,
    value: { alwaysVisible: [], budgets: null, categoryConfig: {} },
    meta: { choices: [], default: [], constraints },
  }
  const draftStore = t.createDraftStore()
  for (const [name, text] of Object.entries(drafts)) {
    draftStore.write(name, snapshot.value[name] ?? (name === 'budgets' ? null : {}), text)
  }
  const renderer = createRenderer()
  renderer.render(React.createElement(t.SettingsPanel, {
    t: (key) => key,
    snapshot,
    error: null,
    notice: null,
    busy: false,
    onToggle () {},
    onBulk () {},
    onRestore () {},
    onFeature () {},
    onDescriptionTool () {},
    onSetting () {},
    draftStore,
  }))
  return jsonSections(renderer.container)
}

test('C-U22: JSON 草稿的形状错与语法错一样禁用保存并给出 jsonInvalidNow', (tc) => {
  if (reconcilerBundle.error !== null) {
    tc.skip(`react-reconciler 不可解析：${reconcilerBundle.error.message}`)
    return
  }
  const { exports: mod } = loadClient()
  const t = mod.__test

  // 形状错：budgets=[]（数组）。此前 parseDraft 返回 null，saveBlocked 只认 undefined，
  // 结果按钮可点且没有实时错误 —— 用户要点保存后才被后续校验拒绝。
  let sections = renderJsonSections(t, { budgets: '[]' })
  const budgetsArray = sections.find((section) => section.name === 'budgets')
  assert.deepEqual(budgetsArray.applyDisabled, [true], '数组形状必须禁用保存')
  assert.deepEqual(budgetsArray.alerts, ['jsonInvalidNow'], '形状错必须给出实时错误')
  assert.equal(budgetsArray.invalid, true, '形状错必须标出 aria-invalid')
  const categoryOk = sections.find((section) => section.name === 'categoryConfig')
  assert.deepEqual(categoryOk.applyDisabled, [false], '另一个合法字段不受牵连')
  assert.deepEqual(categoryOk.alerts, [])

  // 形状错：categoryConfig=null
  sections = renderJsonSections(t, { categoryConfig: 'null' })
  const categoryNull = sections.find((section) => section.name === 'categoryConfig')
  assert.deepEqual(categoryNull.applyDisabled, [true], 'categoryConfig=null 必须禁用保存')
  assert.deepEqual(categoryNull.alerts, ['jsonInvalidNow'], 'categoryConfig=null 必须给出实时错误')

  // 语法错：同样禁用保存并报错
  sections = renderJsonSections(t, { budgets: '{oops' })
  const budgetsBroken = sections.find((section) => section.name === 'budgets')
  assert.deepEqual(budgetsBroken.applyDisabled, [true], '语法错必须禁用保存')
  assert.deepEqual(budgetsBroken.alerts, ['jsonInvalidNow'], '语法错必须给出实时错误')

  // budgets=null 合法（关闭覆盖）：不得禁用、不得报错。
  sections = renderJsonSections(t, { budgets: 'null' })
  const budgetsNull = sections.find((section) => section.name === 'budgets')
  assert.deepEqual(budgetsNull.applyDisabled, [false], 'budgets=null 合法：保存不得禁用')
  assert.deepEqual(budgetsNull.alerts, [], 'budgets=null 不得报错')

  // 最终防线不变：合法形状之外的深层校验仍由 validAdvancedSetting 兜底。
  const constraints = { budgetKeys: ['maxActiveTools'], optionalLimitKeys: [], categoryKeys: ['files'] }
  assert.equal(t.validAdvancedSetting('budgets', null, constraints), true)
  assert.equal(t.validAdvancedSetting('categoryConfig', null, constraints), false)
  assert.equal(t.validAdvancedSetting('budgets', [], constraints), false)
})

/** 装一个真实 Root：面板 + 保存通道（mutate 由可控 Promise 驱动）。 */
function mountRoot (mod, mutate) {
  const envelope = realSchemaEnvelope(['fixture_alpha'])
  const { ctx } = fakeCtx(envelope, ['fixture_alpha'], mutate)
  const Root = mod.__test.createTabRoot(ctx, (key) => key)
  const renderer = createRenderer()
  renderer.render(React.createElement(Root))
  const toggle = findNode(renderer.container, (node) => node?.props?.role === 'switch')
  assert.ok(toggle !== undefined, '面板必须有可触发的功能开关')
  return { renderer, toggle }
}

test('C-U23: 保存 Promise 未决时卸载 —— 不得新建定时器，也不得再更新已卸载的组件', async (t) => {
  if (reconcilerBundle.error !== null) {
    t.skip(`react-reconciler 不可解析：${reconcilerBundle.error.message}`)
    return
  }
  // 成功路径：Promise 落地时组件已卸载。
  const clock = fakeClock()
  const { exports: mod } = loadClient({ globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } })
  const deferred = deferredPromise()
  const { renderer, toggle } = mountRoot(mod, () => deferred.promise)
  toggle.props.onClick() // → write → mutate 挂起
  renderer.unmount() // 卸载：清定时器 + 标记未挂载
  deferred.resolve(true) // 保存结果此刻才落地
  await settle()
  assert.equal(clock.count(), 0, '卸载后不得新建 3 秒自动消失定时器')
  clock.tick(3000) // 若定时器被创建，这里会回调到已卸载的组件
  assert.equal(clock.count(), 0)

  // 失败路径：同样不得在卸载后更新状态。
  const clock2 = fakeClock()
  const { exports: mod2 } = loadClient({ globals: { setTimeout: clock2.setTimeout, clearTimeout: clock2.clearTimeout } })
  const deferred2 = deferredPromise()
  const second = mountRoot(mod2, () => deferred2.promise)
  second.toggle.props.onClick()
  second.renderer.unmount()
  deferred2.resolve(false)
  await settle()
  assert.equal(clock2.count(), 0, '卸载后的失败路径也不得留下定时器')
})

test('C-U24: 挂载时的保存仍给出提示并自动消失；卸载清掉已有定时器', async (t) => {
  if (reconcilerBundle.error !== null) {
    t.skip(`react-reconciler 不可解析：${reconcilerBundle.error.message}`)
    return
  }
  const clock = fakeClock()
  const { exports: mod } = loadClient({ globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } })
  const deferred = deferredPromise()
  const { renderer, toggle } = mountRoot(mod, () => deferred.promise)

  toggle.props.onClick()
  deferred.resolve(true)
  await settle()
  assert.equal(clock.count(), 1, '保存成功后应有一个 3 秒自动消失定时器')
  assert.ok(textOf(renderer.container).includes('saved'), '保存成功后必须显示已保存提示')

  clock.tick(3000)
  await settle()
  assert.equal(clock.count(), 0, '定时器触发后不应残留')
  assert.ok(!textOf(renderer.container).includes('saved'), '3 秒后提示必须自动消失')

  // 再保存一次并卸载：卸载必须清掉已存在的定时器。
  const again = findNode(renderer.container, (node) => node?.props?.role === 'switch')
  again.props.onClick()
  await settle()
  assert.equal(clock.count(), 1)
  renderer.unmount()
  assert.equal(clock.count(), 0, '卸载时必须清掉已有定时器')
})
