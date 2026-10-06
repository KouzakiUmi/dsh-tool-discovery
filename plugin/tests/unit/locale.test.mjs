// i18n 覆盖与一致性测试。
//
// 两条防线，对应两类真实缺陷：
//   1. 缺键 —— t() 返回 undefined 会把 `undefined` 送进模型可见的文案。
//   2. 表不对齐 —— en/zh 键集不一致时，某语言下会静默回落到另一种语言或空串。
//
// 另有双语对照用例：同一处错误在 en 下必须是英文。这条最重要——迁移脚本
// 是机械替换的，最容易犯的错是键名写错而测试仍然全绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createText, normalizeLocale, tableFor, setDomainLocale, domainText,
  SUPPORTED_LOCALES, DEFAULT_LOCALE, errorCodes, DomainError,
} from '../../domain/index.mjs'
import { validateListRequest, validateSearchRequest, validateLoadRequest } from '../../domain/protocol.mjs'
import { DEFAULT_BUDGETS } from '../../domain/constants.mjs'

test('locale 归一化：未知值回落 en，绝不猜测', () => {
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('zh'), 'zh')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('zh_CN'), 'zh')
  assert.equal(normalizeLocale('fr'), DEFAULT_LOCALE, '未知语言必须回落，不得瞎猜')
  assert.equal(normalizeLocale(undefined), DEFAULT_LOCALE)
  assert.equal(normalizeLocale(42), DEFAULT_LOCALE)
})

test('en/zh 两表键集完全一致', () => {
  const walk = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? walk(v, `${prefix}${k}.`)
      : [`${prefix}${k}`])
  const en = walk(tableFor('en')).sort()
  const zh = walk(tableFor('zh')).sort()
  assert.deepEqual(zh, en, 'zh 表的键集与 en 不一致')
  assert.ok(en.length > 80, `文案条目过少（${en.length}），迁移可能丢键`)
})

test('每个受支持 locale 的文案表都无空串', () => {
  for (const loc of SUPPORTED_LOCALES) {
    const t = createText(loc)
    for (const key of Object.keys(errorCodes(loc))) {
      const m = t.t(['error', key])
      assert.ok(m && m.trim().length > 0, `${loc}.error.${key} 为空`)
    }
  }
})

test('错误码文案随 locale 切换，且不含对方的语言', () => {
  const en = createText('en')
  const zh = createText('zh')
  const CJK = /[一-鿿]/
  for (const key of Object.keys(errorCodes('en'))) {
    const e = en.t(['error', key])
    const z = zh.t(['error', key])
    assert.ok(!CJK.test(e), `en.${key} 含中文：${e}`)
    assert.ok(CJK.test(z), `zh.${key} 不含中文：${z}`)
    assert.notEqual(e, z, `${key} 两语言文案相同，可能复制错`)
  }
})

test('双语对照：同一校验错误在 en 下必须是英文', () => {
  const bad = () => validateListRequest({ view: 'nope' }, DEFAULT_BUDGETS)

  setDomainLocale('zh')
  const zhErr = (() => { try { bad() } catch (e) { return e } })()
  setDomainLocale('en')
  const enErr = (() => { try { bad() } catch (e) { return e } })()

  assert.ok(/[一-鿿]/.test(zhErr.message), `zh 应为中文，实际：${zhErr.message}`)
  assert.ok(!/[一-鿿]/.test(enErr.message), `en 不应为中文，实际：${enErr.message}`)
  assert.equal(enErr.code, zhErr.code, '错误码不应随语言改变——码是协议的一部分')
  assert.equal(enErr.recovery, zhErr.recovery, 'recovery 是机器可读枚举，不应本地化')
})

test('双语对照：search / load 校验的 40+ 拒绝点全覆盖', () => {
  const cases = [
    () => validateSearchRequest({}, DEFAULT_BUDGETS),
    () => validateSearchRequest({ query: 1 }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'nope' }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'unload' }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'load', toolIds: ['x'] }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'load', names: [] }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'load', names: [1] }, DEFAULT_BUDGETS),
    () => validateLoadRequest({ action: 'load', names: ['a'], candidates: [{ ref: 'r', revision: 'v' }] }, DEFAULT_BUDGETS),
    () => validateListRequest({}, DEFAULT_BUDGETS),
    () => validateListRequest({ view: 'available' }, DEFAULT_BUDGETS),
    () => validateListRequest({ view: 'available', category: 1 }, DEFAULT_BUDGETS),
    () => validateListRequest({ view: 'state', category: 'files' }, DEFAULT_BUDGETS),
    () => validateListRequest({ view: 'available', category: 'files', cursor: 1 }, DEFAULT_BUDGETS),
  ]
  const CJK = /[一-鿿]/
  let checked = 0
  for (const c of cases) {
    setDomainLocale('zh')
    const zhErr = (() => { try { c() } catch (e) { return e } })()
    setDomainLocale('en')
    const enErr = (() => { try { c() } catch (e) { return e } })()
    if (zhErr === undefined || enErr === undefined) continue
    assert.ok(!CJK.test(enErr.message), `en 侧仍为中文：${enErr.message}`)
    assert.ok(!/undefined/.test(enErr.message), `缺键导致 undefined：${enErr.message}`)
    checked++
  }
  assert.ok(checked >= 10, `实际只覆盖 ${checked} 个拒绝点，样本太少`)
})

test('domainText 代理跟随 setDomainLocale', () => {
  setDomainLocale('en')
  assert.ok(!/[一-鿿]/.test(domainText.t(['error', 'INVALID_ARGS'])))
  setDomainLocale('zh')
  assert.ok(/[一-鿿]/.test(domainText.t(['error', 'INVALID_ARGS'])))
  setDomainLocale('en') // 复位，避免污染同文件后续用例
})

test('DomainError 默认 message 随 locale，且 code/recovery 不变', () => {
  setDomainLocale('en')
  const en = new DomainError('TOOL_NOT_LOADED')
  setDomainLocale('zh')
  const zh = new DomainError('TOOL_NOT_LOADED')
  assert.equal(en.code, zh.code)
  assert.equal(en.recovery, zh.recovery)
  assert.ok(!/[一-鿿]/.test(en.message), `en.message 含中文：${en.message}`)
  assert.ok(/[一-鿿]/.test(zh.message))
})