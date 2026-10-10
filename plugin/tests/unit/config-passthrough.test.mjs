// 门禁：`validateConfig` 的返回值是 apply 阶段**唯一**的配置视图 —— 它返回的是一个新字面量，
// 不是调用方传进来的原对象。因此 config.mjs 里声明的每个 schema 字段都必须出现在那个字面量里；
// 漏掉一个就等于"这个配置项静默不存在"（用户改了也没反应）。
//
// 这条门禁由一次真实事故催生：`tolerantLoadProtected`、`locale`、`respectAlwaysVisible` 三个键
// 曾在同一个字面量里一起缺席，于是"关掉 tolerantLoadProtected"和"钉住 locale"都是假的。
// 纯可移植：只读 config.mjs 的源码文本 + 调用纯函数，不依赖宿主 SDK。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateConfig } from '../../adapters/dsh/index.mjs'

const CONFIG_SOURCE = new URL('../../adapters/dsh/config.mjs', import.meta.url)

/** 扫 `buildConfig` 里 `Schema.object({ ... })` 字面量的键名（含简写属性）。 */
function declaredFields() {
  const source = readFileSync(CONFIG_SOURCE, 'utf8')
  const block = /return Schema\.object\(\{([\s\S]*?)\n {2}\}\);/.exec(source)
  assert.ok(block !== null, '前置：config.mjs 必须有一个 Schema.object({...}) 字面量')
  return [...block[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9_]*)\s*[,:]/gm)].map((match) => match[1])
}

test('CP1: config.mjs 声明的每个配置字段都必须出现在 validateConfig 的返回里', () => {
  const fields = declaredFields()
  // 棘轮：只许增不许减。这里原先写 `>= 8`，而当时字段已有 11 个 —— 扫描器丢掉 1~3 个字段
  // （缩进变化、加一层嵌套、格式重排）时门禁仍然全绿。新增字段时把下限一起上调。
  assert.ok(fields.length >= 11, `前置：字段扫描必须扫到全部字段，实际只扫到 ${fields.length} 个`)

  const returned = validateConfig({})
  const missing = fields.filter((field) => !Object.hasOwn(returned, field))
  assert.deepEqual(missing, [],
    `这些配置字段没有出现在 validateConfig 的返回字面量里，因此会静默失效：${missing.join(', ')}`)
})

test('CP2: 三个曾经漏掉的键现在真的能透传（正控制）', () => {
  const returned = validateConfig({
    tolerantLoadProtected: false,
    locale: 'zh',
    respectAlwaysVisible: true,
  })
  assert.equal(returned.tolerantLoadProtected, false, '显式关闭 tolerantLoadProtected 必须生效')
  assert.equal(returned.locale, 'zh', '显式钉住 locale 必须到达 apply')
  assert.equal(returned.respectAlwaysVisible, true, 'respectAlwaysVisible 必须到达 apply')
})
