// host-locale 是**纯函数**：不 import node:fs、不读 process.env。
//
// 本文件用注入的读取函数覆盖全部路径 —— 任何一次真实文件系统访问都会让断言失败，
// 这就是「内核不持有 I/O 能力」这条设计声明的机械化证据（而不是靠注释声称）。
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

test('HL1: 显式 override 优先，且不读文件（正控制：读取函数必须零调用）', () => {
  const { read, calls } = readerOf('{"desktop":"en"}')
  const { log } = loggerOf()
  assert.equal(detectHostLocale({ localeFile: FILE, localeOverride: 'zh', readFile: read, log }), 'zh')
  assert.deepEqual(calls, [], '有显式语言时不得触碰宿主文件')
})

test('HL2: auto 哨兵走读取路径，desktop / locale / preference 三个字段都能识别', () => {
  for (const key of ['desktop', 'locale', 'preference']) {
    const { read, calls } = readerOf(JSON.stringify({ [key]: 'zh' }))
    assert.equal(
      detectHostLocale({ localeFile: FILE, localeOverride: AUTO_LOCALE, readFile: read, log: () => {} }),
      'zh',
      `字段 ${key} 必须被识别`,
    )
    assert.deepEqual(calls, [FILE], `字段 ${key} 走读取路径时必须真的读了那一个文件`)
  }
})

test('HL3: 区域子标签归一（zh-CN → zh）；未知语言回落默认且留日志', () => {
  const regional = readerOf('{"desktop":"zh-CN"}')
  assert.equal(detectHostLocale({ localeFile: FILE, readFile: regional.read, log: () => {} }), 'zh')

  const unknown = readerOf('{"desktop":"fr"}')
  const { log, lines } = loggerOf()
  assert.equal(detectHostLocale({ localeFile: FILE, readFile: unknown.read, log }), DEFAULT_LOCALE)
  assert.ok(lines.length >= 1, '回落必须留日志，不能静默')
})

test('HL4: 无可识别字段 / 坏 JSON / 读失败 都回落默认，且都不抛', () => {
  for (const payload of ['{}', '{"desktop":42}', 'not json', new Error('ENOENT: no such file')]) {
    const { read } = readerOf(payload)
    const { log, lines } = loggerOf()
    assert.equal(detectHostLocale({ localeFile: FILE, readFile: read, log }), DEFAULT_LOCALE)
    assert.ok(lines.length >= 1, `payload=${String(payload)} 必须留日志`)
  }
})

test('HL5: 缺路径或缺读取函数时都不访问文件系统（负控制）', () => {
  const { read, calls } = readerOf('{"desktop":"zh"}')
  const { log } = loggerOf()
  assert.equal(detectHostLocale({ readFile: read, log }), DEFAULT_LOCALE, '缺 localeFile 必须回落')
  assert.equal(detectHostLocale({ localeFile: '', readFile: read, log }), DEFAULT_LOCALE, '空路径必须回落')
  assert.equal(detectHostLocale({ localeFile: FILE, log }), DEFAULT_LOCALE, '缺 readFile 必须回落')
  assert.deepEqual(calls, [], '两条缺参路径都不得读文件')
})

test('HL6: 未知 override 归一为默认，且不回落成"再去读文件"', () => {
  const { read, calls } = readerOf('{"desktop":"zh"}')
  assert.equal(detectHostLocale({ localeFile: FILE, localeOverride: 'fr', readFile: read, log: () => {} }), DEFAULT_LOCALE)
  assert.deepEqual(calls, [], 'override 已给出时不得读文件（即使它无法识别）')
})
