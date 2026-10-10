// localeSourcesOf 的适配层门禁：钉住语言时**两个来源都不读**（README 权限表与
// 10-store §3.1 的承诺「skips both reads entirely」），`auto` 才按权威顺序探测。
// 域层（host-locale）的纯函数行为由 host-locale.test.mjs 钉住；这里钉的是适配层的
// I/O 决策 —— 修复前钉住语言仍会无条件 readFileSync(patchPath)，第一个用例就是
// 它的变异正控制：删掉短路分支，`localePreference` 会变成补丁里的 'en'，用例变红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localeSourcesOf } from '../../adapters/dsh/index.mjs'

const PATCH_TEXT = [
  'profiles:',
  '  - id: other',
  '    config:',
  '      preference: fr', // 别的条目也带 preference：确认只认 `- id: locale` 那一项
  '  - id: locale',
  '    config:',
  '      preference: en',
].join('\n')

function ctxWith (profile) {
  return { get: (key) => key === 'profileContext' ? profile : undefined }
}

function withTempDir (run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-locale-sources-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('pinned locale skips both sources: the patch file is never read', () => withTempDir(async (dir) => {
  const patchPath = join(dir, 'profile.patch')
  writeFileSync(patchPath, PATCH_TEXT)
  const ctx = ctxWith({ name: 'p1', patchPath, home: dir })
  assert.deepEqual(await localeSourcesOf(ctx, 'zh'), { localeFile: null, localePreference: null, profileKey: null })
}))

test('pinned locale matches after trim/lowercase, mirroring the domain override rule', () => withTempDir(async (dir) => {
  const patchPath = join(dir, 'profile.patch')
  writeFileSync(patchPath, PATCH_TEXT)
  const ctx = ctxWith({ name: 'p1', patchPath, home: dir })
  assert.deepEqual(await localeSourcesOf(ctx, ' EN '), { localeFile: null, localePreference: null, profileKey: null })
}))

test('auto probes: the patch preference is read as the authoritative source', () => withTempDir(async (dir) => {
  const patchPath = join(dir, 'profile.patch')
  writeFileSync(patchPath, PATCH_TEXT)
  const ctx = ctxWith({ name: 'p1', patchPath, home: dir })
  assert.deepEqual(await localeSourcesOf(ctx, 'auto'), {
    localeFile: join(dir, 'desktop-locale.json'),
    localePreference: 'en',
    profileKey: 'p1',
  })
}))

test('auto without a patchPath still resolves the desktop-locale path without reading anything', () => withTempDir(async (dir) => {
  const ctx = ctxWith({ name: 'p1', home: dir })
  const sources = await localeSourcesOf(ctx, 'auto')
  assert.equal(sources.localeFile, join(dir, 'desktop-locale.json'))
  assert.equal(sources.localePreference, null)
  assert.equal(sources.profileKey, 'p1')
}))

test('auto without a profileContext yields usable nulls instead of throwing', async () => {
  const sources = await localeSourcesOf(ctxWith(undefined), 'auto')
  assert.equal(sources.localePreference, null)
  assert.equal(sources.profileKey, null)
  // localeFile 取决于本机是否装有 @deepseek-ai/dsh-home-paths：有则给出宿主路径，无则 null。
  assert.ok(sources.localeFile === null || (typeof sources.localeFile === 'string' && sources.localeFile.endsWith('desktop-locale.json')))
})
