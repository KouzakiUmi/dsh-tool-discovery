// 门禁：`validateConfig` 的返回值是 apply 阶段**唯一**的配置视图 —— 它返回的是一个新对象，
// 不是调用方传进来的原对象。因此 config.mjs 里声明的每个**仍生效**的 schema 字段都必须
// 出现在那个返回值里；漏掉一个就等于"这个配置项静默不存在"。
//
// 这条门禁由一次真实事故催生：`tolerantLoadProtected`、`locale`、`respectAlwaysVisible`
// 三个键曾在同一个返回值里一起缺席。rc.1 重设计后 compactBuiltinTool* / ptcCompatibility /
// requireTrustedEpoch* 只是兼容字段（无效果），显式列在 DEPRECATED 中，不要求透传。
// 纯可移植：只读 config.mjs 的源码文本 + 调用纯函数，不依赖宿主 SDK。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateConfig } from '../../adapters/dsh/index.mjs'

const CONFIG_SOURCE = new URL('../../adapters/dsh/config.mjs', import.meta.url)

/** rc.1 上保留但不再生效的兼容键：Config 里仍有，validateConfig 不校验也不透传。 */
const DEPRECATED = new Set([
  'compactBuiltinToolDescriptions',
  'compactBuiltinToolOverrides',
  'ptcCompatibility',
  'requireTrustedEpoch',
  'requireTrustedEpochForSubagents',
])

/** 扫 `buildConfig` 里 `Schema.object({ ... })` 字面量的键名（含简写属性）。 */
function declaredFields() {
  const source = readFileSync(CONFIG_SOURCE, 'utf8')
  const block = /return Schema\.object\(\{([\s\S]*?)\n {2}\}\);/.exec(source)
  assert.ok(block !== null, '前置：config.mjs 必须有一个 Schema.object({...}) 字面量')
  return [...block[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9_]*)\s*[,:]/gm)].map((match) => match[1])
}

test('CP1: config.mjs 中每个仍生效的配置字段都必须出现在 validateConfig 的返回里', () => {
  const fields = declaredFields()
  // 棘轮：只许增不许减；扫描器漏字段时先在这里失败。
  assert.ok(fields.length >= 14, `前置：字段扫描必须扫到全部字段，实际只扫到 ${fields.length} 个`)

  const returned = validateConfig({})
  const missing = fields.filter((field) => !DEPRECATED.has(field) && !Object.hasOwn(returned, field))
  assert.deepEqual(missing, [],
    `这些仍生效的配置字段没有出现在 validateConfig 的返回值里，因此会静默失效：${missing.join(', ')}`)
})

test('CP2: 曾经漏掉的键与新增的 own-scope 开关都能透传（正控制）', () => {
  const returned = validateConfig({
    tolerantLoadProtected: false,
    locale: 'zh',
    respectAlwaysVisible: true,
    gateOwnScopeTools: false,
  })
  assert.equal(returned.tolerantLoadProtected, false, '显式关闭 tolerantLoadProtected 必须生效')
  assert.equal(returned.locale, 'zh', '显式钉住 locale 必须到达 apply')
  assert.equal(returned.respectAlwaysVisible, true, 'respectAlwaysVisible 必须到达 apply')
  assert.equal(returned.gateOwnScopeTools, false, 'gateOwnScopeTools 必须到达 apply')
})

test('CP3: 已废弃的兼容键不进入 effective config（避免"看起来配置了"）', () => {
  const returned = validateConfig({
    compactBuiltinToolDescriptions: true,
    compactBuiltinToolOverrides: { skill: true },
    ptcCompatibility: true,
    requireTrustedEpoch: true,
    requireTrustedEpochForSubagents: true,
  })
  for (const key of DEPRECATED) {
    assert.equal(Object.hasOwn(returned, key), false, `${key} 不得出现在 effective config 中`)
  }
  // 兼容字段在 schema 层仍然存在（不吞用户配置）。
  const fields = declaredFields()
  for (const key of DEPRECATED) assert.ok(fields.includes(key), `Config 仍应保留兼容字段 ${key}`)
})
