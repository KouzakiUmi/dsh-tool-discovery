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
import { validateConfig } from '../../adapters/dsh/index.mjs'
import { CORE_TOOL_NAMES } from '../../domain/core-tools.mjs'
import { DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS, resolveBudgets } from '../../domain/index.mjs'

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

// --- budgets 的 null 语义：校验层与 resolveBudgets 必须同源 -------------------------
//
// 背景：`buildConfig` 把 budgets 的默认值定为 null（"关闭覆盖"），用户把"关闭覆盖"
// 显式写成 null 是**文档内**的合法写法；`resolveBudgets` 也对 null 回落 DEFAULT_BUDGETS。
// 但形状校验曾把 null 当"非对象"拒掉，于是走真实 Loader 的显式 null 会让整个
// adapter 激活失败。下面这组断言锁定两个层面的**同一条判据**：
//   * budgets 缺省 / null / {} / 有效显式预算 → 校验通过；
//   * 字符串 / 数组 / 其他非对象 → 仍然拒绝（INCOMPATIBLE_COMPOSITION）；
//   * 通过校验后 resolveBudgets 也必须能吃下同一个值（不允许两层判据漂移）。
const BUDGETS_ACCEPTED = [
  { label: 'undefined（缺省）', value: undefined },
  { label: 'null（关闭覆盖）', value: null },
  { label: '空对象', value: {} },
  { label: '显式正整数', value: { maxActiveTools: 3 } },
  { label: '显式 null 限额', value: { maxListLimit: null } },
]
const BUDGETS_REJECTED = [
  { label: '字符串', value: '8' },
  { label: '数组', value: [8] },
  { label: '数字', value: 8 },
  { label: '布尔', value: true },
]

test('S-U14: validateConfig 接受 budgets 的 undefined / null / {} / 有效显式预算', () => {
  for (const { label, value } of BUDGETS_ACCEPTED) {
    const raw = value === undefined ? {} : { budgets: value }
    assert.doesNotThrow(() => validateConfig(raw), `必须接受 budgets ${label}`)
  }
  assert.equal(validateConfig({}).budgets, undefined, '缺省不得凭空造出 budgets')
  assert.equal(validateConfig({ budgets: null }).budgets, null, 'null 必须原样透传给 resolveBudgets')
  assert.deepEqual(validateConfig({ budgets: { maxActiveTools: 3 } }).budgets, { maxActiveTools: 3 })
})

test('S-U15: budgets 是字符串 / 数组 / 其他非对象时仍被拒（INCOMPATIBLE_COMPOSITION）', () => {
  for (const { label, value } of BUDGETS_REJECTED) {
    assert.throws(() => validateConfig({ budgets: value }),
      (error) => error?.code === 'INCOMPATIBLE_COMPOSITION',
      `budgets 为 ${label} 时必须拒绝`)
  }
})

test('S-U16: 校验层与 resolveBudgets 判据同源 —— 通过校验的值都能被 resolveBudgets 吃下', () => {
  for (const { label, value } of [...BUDGETS_ACCEPTED, ...BUDGETS_REJECTED]) {
    const accepted = BUDGETS_ACCEPTED.some((item) => item.value === value && item.label === label)
    let validationPassed = true
    try {
      validateConfig(value === undefined ? {} : { budgets: value })
    } catch {
      validationPassed = false
    }
    assert.equal(validationPassed, accepted, `validateConfig 对 budgets ${label} 的判定与预期不符`)

    let resolved = true
    try {
      resolveBudgets(value)
    } catch {
      resolved = false
    }
    assert.equal(resolved, accepted, `resolveBudgets 对 budgets ${label} 的判定与校验层漂移`)
  }
})

test('S-U17: budgets 为 null / {} 时硬限额仍默认关闭（不是"被清零"也不是"被启用"）', () => {
  for (const budgets of [null, {}]) {
    const resolved = resolveBudgets(budgets)
    for (const key of OPTIONAL_LIMIT_KEYS) {
      assert.equal(resolved[key], null, `budgets=${JSON.stringify(budgets)} 时 ${key} 应保持关闭`)
    }
    assert.deepEqual(resolved, { ...DEFAULT_BUDGETS }, '缺省覆盖必须精确回落 DEFAULT_BUDGETS')
  }
  // 正控制：显式正整数确实启用同一项，避免上面在空转
  assert.equal(resolveBudgets({ maxActiveTools: 3 }).maxActiveTools, 3)
  assert.equal(resolveBudgets({}).maxActiveTools, null)
})
