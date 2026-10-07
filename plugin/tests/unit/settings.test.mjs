// 单元：初始工具设置面（Config 形状 / 替换语义 / 活目录 meta / 面板纯逻辑）。
//
// schemastery 走测试 resolver 从安装里取（工作区没有 node_modules）；产品代码不含
// 任何机器绝对路径，机器差异只出现在 contracts/install-resolver.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import {
  buildConfig, resolveAlwaysVisible, nativeToolNamesOf, publishToolChoices,
  initialSelectionView, INITIAL_TOOL_CHOICES, DEFAULT_ALWAYS_VISIBLE, FIXED_ENTRY_NAMES,
} from '../../adapters/dsh/config.mjs'
import * as model from '../../client/model.mjs'
import { CORE_TOOL_NAMES } from '../../domain/core-tools.mjs'

const Schema = (await import(dshModule('@deepseek-ai/schemastery'))).default

test('S-U01: Config.alwaysVisible 是 volatile 的 string[]，默认值是 DSH 自带工具', () => {
  const config = buildConfig(Schema)
  const node = config.dict.alwaysVisible
  assert.equal(node.type, 'array')
  assert.equal(node.inner.type, 'string')
  assert.equal(node.meta.volatile, true)
  assert.deepEqual(node.meta.default, [...DEFAULT_ALWAYS_VISIBLE])
  assert.deepEqual(node.meta.default, [...CORE_TOOL_NAMES])
})

test('S-U02: budgets 默认 null 且显式 null 合法（关闭覆盖）', () => {
  const config = buildConfig(Schema)
  assert.equal(config.dict.budgets.meta.default, null)
  assert.equal(config({ budgets: null }).budgets, null)
  assert.deepEqual(config({ budgets: { maxActiveTools: 3 } }).budgets, { maxActiveTools: 3 })
})

test('S-U03: 既有的 categoryConfig / frameworkRetained 仍在 Config 里，不会被吞掉', () => {
  const config = buildConfig(Schema)
  for (const key of ['alwaysVisible', 'frameworkRetained', 'budgets', 'categoryConfig']) {
    assert.ok(config.dict[key] !== undefined, `Config 缺少 ${key}`)
  }
  const resolved = config({ categoryConfig: { files: { title: 'F' } } })
  assert.equal(resolved.categoryConfig.files.title, 'F')
})

test('S-U04: 三个发现入口不在 alwaysVisible 字段里（配置改不动它们）', () => {
  const config = buildConfig(Schema)
  assert.ok(!config.dict.alwaysVisible.meta.default.includes('tool_load'))
  assert.ok(!config.dict.alwaysVisible.meta.default.includes('tool_list'))
  assert.ok(!config.dict.alwaysVisible.meta.default.includes('tool_search'))
  assert.deepEqual([...FIXED_ENTRY_NAMES], ['tool_list', 'tool_search', 'tool_load'])
})

test('S-U05: resolveAlwaysVisible —— 替换不是并集，显式 [] 真的清空', () => {
  assert.deepEqual(resolveAlwaysVisible(['read']), ['read'])
  assert.deepEqual(resolveAlwaysVisible([]), [])
  assert.deepEqual(resolveAlwaysVisible(undefined), [...DEFAULT_ALWAYS_VISIBLE])
  assert.deepEqual(resolveAlwaysVisible(null), [...DEFAULT_ALWAYS_VISIBLE])
  // 去重但保序
  assert.deepEqual(resolveAlwaysVisible(['b', 'a', 'b']), ['b', 'a'])
})

test('S-U06: resolveAlwaysVisible 读 volatile 引用的当前值（即时生效的前提）', () => {
  let current = ['read']
  const ref = { get: () => current }
  assert.deepEqual(resolveAlwaysVisible(ref), ['read'])
  current = ['write', 'glob']
  assert.deepEqual(resolveAlwaysVisible(ref), ['write', 'glob'], 'volatile 引用必须读到更新后的值')
})

test('S-U07: 活目录排除三入口，按名字典序', () => {
  const view = { visible: new Map([['tool_load', {}], ['zeta', {}], ['tool_list', {}], ['alpha', {}]]) }
  assert.deepEqual(nativeToolNamesOf(view), ['alpha', 'zeta'])
  assert.deepEqual(nativeToolNamesOf({ visible: new Map() }), [])
})

test('S-U08: publishToolChoices 写进 meta 且纯 JSON（能随 schema.toJSON 过线）', () => {
  const config = buildConfig(Schema)
  assert.equal(publishToolChoices(config, ['alpha', 'alpha', 5, 'beta']), true)
  const choices = config.dict.alwaysVisible.meta[INITIAL_TOOL_CHOICES]
  assert.deepEqual(choices, [{ name: 'alpha', available: true }, { name: 'beta', available: true }])
  const round = JSON.parse(JSON.stringify(config.toJSON()))
  assert.ok(round.refs !== undefined, 'toJSON 必须是可序列化的 refs 信封')
  // 重投影后仍在
  const rehydrated = new Schema(config.toJSON())
  assert.deepEqual(rehydrated.dict.alwaysVisible.meta[INITIAL_TOOL_CHOICES], choices)
})

test('S-U09: initialSelectionView —— 选中但当前不可用的项标缺失，且仍可删', () => {
  const meta = { choices: [{ name: 'alpha', available: true }] }
  const view = initialSelectionView(meta, ['alpha', 'gone_tool'])
  assert.deepEqual(view.fixed, ['tool_list', 'tool_search', 'tool_load'])
  const gone = view.rows.find((r) => r.name === 'gone_tool')
  assert.equal(gone.available, false)
  assert.equal(gone.selected, true)
  assert.ok(view.rows.some((r) => r.name === 'alpha' && r.available && r.selected))
})

test('S-U10: model.toggleName 加/删不改原数组', () => {
  const base = ['a']
  const added = model.toggleName(base, 'b')
  assert.deepEqual(added, ['a', 'b'])
  assert.deepEqual(base, ['a'])
  const removed = model.toggleName(added, 'a')
  assert.deepEqual(removed, ['b'])
})

test('S-U11: model.filterRows 大小写不敏感，空查询返回全部', () => {
  const rows = [{ name: 'ReadFile' }, { name: 'glob' }, { name: 'pwsh' }]
  assert.deepEqual(model.filterRows(rows, 're').map((r) => r.name), ['ReadFile'])
  assert.deepEqual(model.filterRows(rows, '  ').length, 3)
  assert.deepEqual(model.filterRows(rows, 'zzz'), [])
})

test('S-U12: 恢复默认 —— 无序比较，未变化时不产生多余写入', () => {
  const defaults = ['a', 'b']
  assert.equal(model.isDefaultSelection(['b', 'a'], defaults), true)
  assert.equal(model.isDefaultSelection(['a'], defaults), false)
  const same = model.restoreDefaults(['b', 'a'], defaults)
  assert.equal(same.changed, false)
  const changed = model.restoreDefaults(['a'], defaults)
  assert.equal(changed.changed, true)
  assert.deepEqual(changed.names, ['a', 'b'])
})

test('S-U13: model.buildRows 目录 + 选择合成面板行，固定入口不进行', () => {
  const meta = { choices: [{ name: 'read' }, { name: 'glob' }] }
  const built = model.buildRows(meta, ['read', 'tool_load', 'missing_one'])
  assert.deepEqual(built.fixed, ['tool_list', 'tool_search', 'tool_load'])
  assert.ok(!built.rows.some((r) => r.name === 'tool_load'), '固定入口不得成为可勾选行')
  assert.equal(built.rows.find((r) => r.name === 'missing_one').available, false)
  assert.equal(built.missingCount, 1)
  assert.equal(built.selectedCount, 2)
})
