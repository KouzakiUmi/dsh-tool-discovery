// host-locale 是**纯函数**：不 import node:fs、不读 process.env。
//
// 本文件用注入的读取函数覆盖全部路径 —— 任何一次真实文件系统访问都会让断言失败，
// 这就是「内核不持有 I/O 能力」这条设计声明的机械化证据（而不是靠注释声称）。
//
// 语言事实的形状也是这里钉住的：`desktop-locale.json` 是 **以 profile 名为键的 map**
// （宿主写的是 `{ ...saved, [profile]: locale }`），不是 `{"desktop": ...}` 这种固定字段。
// 本机活跃 profile 恰好叫 `desktop`，所以"按固定字段读"曾经看起来能用 —— 这条断言
// 就是防止它再退回去：换个 profile 名必须失效，而不是读到别人的语言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectHostLocale, AUTO_LOCALE } from '../../domain/host-locale.mjs'
import { DEFAULT_LOCALE } from '../../domain/locale.mjs'

const FILE = '/dsh/desktop-locale.json'

/** 记录调用次数的读取函数；调用记录本身是「有没有触碰宿主文件」的判据。 */
function readerOf (payload) {
  const calls = []
  const read = (path) => {
    calls.push(path)
    if (payload instanceof Error) throw payload
    return payload
  }
  return { read, calls }
}

function loggerOf () {
  const lines = []
  return { log: (message) => lines.push(message), lines }
}

test('HL1: 插件 Config 的显式语言优先，且不读文件（正控制：读取函数必须零调用）', () => {
  const { read, calls } = readerOf('{"desktop":"en"}')
  const { log } = loggerOf()
  assert.equal(detectHostLocale({ localeFile: FILE, localeOverride: 'zh', readFile: read, log }), 'zh')
  assert.deepEqual(calls, [], '有显式语言时不得触碰宿主文件')
})

test('HL2: AUTO 哨兵大小写与空白不敏感（不得被当成语言名而静默钉死默认值）', () => {
  for (const raw of ['auto', 'AUTO', ' Auto ']) {
    const { read, calls } = readerOf('{"desktop":"zh"}')
    const { log } = loggerOf()
    assert.equal(
      detectHostLocale({ localeFile: FILE, profileKey: 'desktop', localeOverride: raw, readFile: read, log }),
      'zh',
      `${JSON.stringify(raw)} 必须被当作"跟随界面语言"并走读取路径`,
    )
    assert.deepEqual(calls, [FILE], `${JSON.stringify(raw)} 必须走读取路径，而不是钉死默认值`)
  }
})

test('HL3: 宿主设置的 preference 优先于文件，且不读文件（正控制）', () => {
  const { read, calls } = readerOf('{"desktop":"en"}')
  const { log } = loggerOf()
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'desktop', localePreference: 'zh', readFile: read, log }),
    'zh',
  )
  assert.deepEqual(calls, [], 'preference 已给出时不得再读文件')
})

test('HL4: desktop-locale.json 必须按 profile 名取值，缺键回落而不是猜', () => {
  const hit = readerOf('{"desktop":"zh","web":"en"}')
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'desktop', readFile: hit.read, log: () => {} }),
    'zh',
  )
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'web', readFile: hit.read, log: () => {} }),
    'en',
  )

  // 没有本 profile 的条目：回落默认，**不得**去读 desktop/locale/preference 之类同名字段。
  const miss = readerOf('{"web":"en","locale":"zh","preference":"zh"}')
  const { log, lines } = loggerOf()
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'desktop', readFile: miss.read, log }),
    DEFAULT_LOCALE,
    '别的 profile 的语言或同名字段都不算本 profile 的语言',
  )
  assert.ok(lines.length >= 1, '缺键回落必须留日志，不能静默')
})

test('HL5: 区域子标签归一（zh-CN → zh）；未知语言回落默认且留日志', () => {
  const regional = readerOf('{"desktop":"zh-CN"}')
  assert.equal(detectHostLocale({ localeFile: FILE, profileKey: 'desktop', readFile: regional.read, log: () => {} }), 'zh')

  const unknown = readerOf('{"desktop":"fr"}')
  const { log, lines } = loggerOf()
  assert.equal(detectHostLocale({ localeFile: FILE, profileKey: 'desktop', readFile: unknown.read, log }), DEFAULT_LOCALE)
  assert.ok(lines.length >= 1, '不受支持的语言回落必须留日志')
})

test('HL6: 缺来源时不访问文件系统（负控制）', () => {
  const { read, calls } = readerOf('{"desktop":"zh"}')
  const { log } = loggerOf()
  assert.equal(detectHostLocale({ profileKey: 'desktop', readFile: read, log }), DEFAULT_LOCALE, '缺 localeFile 必须回落')
  assert.equal(detectHostLocale({ localeFile: '', profileKey: 'desktop', readFile: read, log }), DEFAULT_LOCALE)
  assert.equal(detectHostLocale({ localeFile: FILE, profileKey: 'desktop', log }), DEFAULT_LOCALE, '缺 readFile 必须回落')
  assert.equal(detectHostLocale({ localeFile: FILE, readFile: read, log }), DEFAULT_LOCALE, '拿不到 profile 名必须回落，不得猜键')
  assert.equal(detectHostLocale({ localeFile: FILE, profileKey: '', readFile: read, log }), DEFAULT_LOCALE)
  assert.deepEqual(calls, [], '所有这些缺参路径都不得读文件')
})

test('HL7: 坏 JSON 与读取失败都回落默认，都不抛', () => {
  for (const payload of ['not json', new Error('ENOENT: no such file')]) {
    const { read } = readerOf(payload)
    const { log, lines } = loggerOf()
    assert.equal(detectHostLocale({ localeFile: FILE, profileKey: 'desktop', readFile: read, log }), DEFAULT_LOCALE)
    assert.ok(lines.length >= 1, `payload=${String(payload)} 必须留日志`)
  }
})

test('HL8: 未知的显式 override 归一为默认，且不回落成"再去读文件"', () => {
  const { read, calls } = readerOf('{"desktop":"zh"}')
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'desktop', localeOverride: 'fr', readFile: read, log: () => {} }),
    DEFAULT_LOCALE,
  )
  assert.deepEqual(calls, [], 'override 已给出时不得读文件（即使它无法识别）')
})

test('HL9: AUTO_LOCALE 是公开哨兵值，且不是受支持的语言 id', () => {
  assert.equal(AUTO_LOCALE, 'auto')
  const { read, calls } = readerOf('{"desktop":"zh"}')
  assert.equal(
    detectHostLocale({ localeFile: FILE, profileKey: 'desktop', localeOverride: AUTO_LOCALE, readFile: read, log: () => {} }),
    'zh',
  )
  assert.deepEqual(calls, [FILE])
})
