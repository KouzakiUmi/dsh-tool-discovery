// 阶段0 合同门禁 harness：用真实 Cordis Loader entry 树装配公共 DSH 服务
// （systemPrompt/tools/sessions/sessionProjections/sessionPersistence/sessionQuery/
// approval/llm/agents/agentLoop）与 plugin/fixtures 下的 fixture 插件。
// 测试专用；不改核心、不改依赖树。SDK 一律经 install-resolver 的 createRequire
// 锚点解析为显式模块 URL 后动态 import。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshModule, installBaseUrl, fixtureFileUrl, installRoot } from './install-resolver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures')
export const TMP_ROOT = path.resolve(HERE, '..', 'fixtures', 'tmp')

/** 安装内公共服务 entry（裸包名由 Loader 在安装解析域内导入）。 */
export function serviceEntries (persistenceRoot) {
  return [
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {} },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'sessions', name: '@deepseek-ai/dsh-session', config: {} },
    { id: 'session-projections', name: '@deepseek-ai/dsh-session-projection', config: {} },
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: persistenceRoot } },
    { id: 'session-query', name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
    { id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } },
    { id: 'llm', name: '@deepseek-ai/dsh-llm', config: {} },
    { id: 'agents', name: '@deepseek-ai/dsh-agent', config: {} },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { maxParallelToolCalls: 1, agents: [] } }
  ]
}

/** fixture entry（file URL 导入工作区模块）。frameworkRetained 为可信显式配置。 */
export function fixtureEntries () {
  return [
    { id: 'fx-mock-provider', name: fixtureFileUrl(path.join(FIXTURES_DIR, 'mock-provider.mjs')), config: {} },
    { id: 'fx-inherited-tools', name: fixtureFileUrl(path.join(FIXTURES_DIR, 'inherited-tools.mjs')), config: {} },
    { id: 'fx-scope-tools', name: fixtureFileUrl(path.join(FIXTURES_DIR, 'scope-tools.mjs')), config: {} },
    { id: 'fx-control-tools', name: fixtureFileUrl(path.join(FIXTURES_DIR, 'control-tools.mjs')), config: {} },
    {
      id: 'fx-projection-guard',
      name: fixtureFileUrl(path.join(FIXTURES_DIR, 'projection-guard.mjs')),
      // 可信显式配置：仅这些框架强制输出/终止工具可被投影保留。不按名称猜测豁免。
      config: { frameworkRetained: ['fixture_final_output'] }
    }
  ]
}

export const REQUIRED_SERVICES = [
  'loader', 'systemPrompt', 'tools', 'sessions', 'sessionProjections',
  'sessionPersistence', 'sessionQuery', 'approval', 'llm', 'agents', 'agentLoop'
]

// 本进程创建的临时根。进程退出时统一兜底清除，避免个别用例漏清而在 fixtures/tmp 下累积；
// 设置 DSH_KEEP_TMP=1 可保留现场用于排查。
const ownedTmpRoots = new Set()
let exitCleanupInstalled = false

function installExitCleanup () {
  if (exitCleanupInstalled) return
  exitCleanupInstalled = true
  process.on('exit', () => {
    if (process.env.DSH_KEEP_TMP === '1') return
    for (const root of ownedTmpRoots) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 兜底清理，失败不影响测试结果 */ }
    }
  })
}

/** 创建一个测试生命周期管理的临时根目录。 */
export function makeTmpRoot (label) {
  const root = path.join(TMP_ROOT, `${label}-${process.pid}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  ownedTmpRoots.add(root)
  installExitCleanup()
  return root
}

/** 删除一个测试生命周期拥有的临时根（先校验解析路径再删）。 */
export function removeTmpRoot (root) {
  const resolved = path.resolve(root)
  const expected = path.resolve(TMP_ROOT)
  if (!resolved.startsWith(expected + path.sep)) throw new Error(`refusing to remove path outside fixture tmp root: ${resolved}`)
  fs.rmSync(resolved, { recursive: true, force: true })
  // 刻意不从 ownedTmpRoots 移除：宿主的异步落盘可能在此之后重建目录，退出时还要再清一次。
}

async function waitFor (probe, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 装配真实 Loader composition 并等待必需服务可达。
 * @returns {{ ctx, loader, entries: object[], tmpRoot: string }}
 */
export async function bootComposition ({ tmpRoot, withFixtures = true, serviceTimeoutMs = 20000 } = {}) {
  const { Context } = await import(dshModule('@deepseek-ai/cordis'))
  const { Loader } = await import(dshModule('@deepseek-ai/cordis-plugin-loader'))
  const root = tmpRoot ?? makeTmpRoot('run')
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: installBaseUrl() })
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('loader service not reachable after ctx.plugin(Loader)')
  const specs = [...serviceEntries(path.join(root, 'sessions')), ...(withFixtures ? fixtureEntries() : [])]
  for (const spec of specs) await loader.create(spec)
  await loader.await()
  await waitFor(() => REQUIRED_SERVICES.every((name) => ctx.get(name) !== undefined), serviceTimeoutMs,
    `required services; missing: ${REQUIRED_SERVICES.filter((name) => ctx.get(name) === undefined).join(', ')}`)
  return { ctx, loader, entries: specs, tmpRoot: root }
}

/** 取证：每个 entry 的实际激活状态 + 服务可达性。 */
export function compositionSnapshot (ctx, loader) {
  const entryStates = []
  for (const entry of loader.entries()) {
    entryStates.push({
      id: entry.id,
      name: entry.options?.name ?? null,
      disabled: entry.disabled === true,
      hasFiber: entry.fiber !== undefined,
      fiberState: entry.fiber?.state ?? null,
      entryTask: entry._initTask !== undefined
    })
  }
  const services = {}
  for (const name of REQUIRED_SERVICES) services[name] = ctx.get(name) !== undefined
  return { installRoot: installRoot(), entryStates, services }
}
