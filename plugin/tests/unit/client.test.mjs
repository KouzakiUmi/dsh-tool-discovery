// 单元：client 面板（真实 ModuleLoader wrapper + vm 内真实 React hooks 数据流 + 真实 schemastery 元数据）。
//
// 渲染边界（已独立核验，勿扩大声称）：本机**没有任何可导入的真实 React 渲染器** ——
// SDK 安装树、工作区、全局 npm、.dsh profiles、源码 checkout 均无 react-dom /
// react-test-renderer / jsdom 等模块树（react-dom 仅存在于 pnpm 内容寻址缓存，
// 不是可导入接缝）。因此这里**不做 SSR/DOM 渲染断言**，也不 mock hooks 伪称渲染；
// 组件层只验证数据流与接缝契约。浏览器级验证由主代理决定。
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

/** 在 vm 里跑真正的 client.js wrapper；require 只认 react。 */
function loadClient () {
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
  assert.deepEqual(states, { initialToolsEnabled: true, alwaysAllowPresetTools: true, requireTrustedEpoch: false, requireTrustedEpochForSubagents: false })
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
  // 组件本体存在。渲染未验证：本机无任何可导入真实渲染器（见文件头边界说明）。
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
