// 组合测试 harness：真实 Cordis Loader entry 树 + 安装内 0.2.1-alpha.1 服务
// + mock provider（录制最终 GenerateOptions）+ adapters/dsh 产品插件。
//
// 与阶段0 contracts/harness.mjs 的区别：这里装载的是**产品 adapter**，
// 而不是阶段0 的 contract stub；且不装载 control-tools / projection-guard
// （它们会占用三个入口名并自带投影，与产品 adapter 冲突）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dshModule, installBaseUrl, fixtureFileUrl,
} from '../../contracts/install-resolver.mjs'
import {
  serviceEntries, REQUIRED_SERVICES, makeTmpRoot, removeTmpRoot,
} from '../../contracts/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures')
const LOCAL_FIXTURES = path.resolve(HERE, 'fixtures')

/** 可选的阶段0 fixture（继承的全局工具 / scope-own 工具 / mock provider）。 */
export const SHARED_FIXTURES = {
  'mock-provider': path.join(FIXTURES, 'mock-provider.mjs'),
  'inherited-tools': path.join(FIXTURES, 'inherited-tools.mjs'),
  'scope-tools': path.join(FIXTURES, 'scope-tools.mjs')
}

export const LOCAL = {
  'adapter': path.resolve(HERE, 'adapter-entry.mjs'),
  // 仅 gate-settings 用：额外注入 schemastery Schema，从而让 adapter 带 Config。
  'adapter-schema': path.resolve(HERE, 'adapter-entry-schema.mjs'),
  'approval-policy': path.join(LOCAL_FIXTURES, 'approval-policy.mjs'),
  'conflict-entry': path.join(LOCAL_FIXTURES, 'conflict-entry.mjs'),
  'readd-catalog-listener': path.join(LOCAL_FIXTURES, 'readd-catalog-listener.mjs'),
  'registry-churn': path.join(LOCAL_FIXTURES, 'registry-churn.mjs')
}

/** 组装 entry 列表：服务 → 选定 fixture → adapter（最后装配，便于观察冲突面）。
 *  extraServices：追加的安装内公共服务 entry（如 subagents / fork provider），
 *  形如 { id, name, config? }；仅测试装配用，不改 contracts/。
 *  adapterSchema：只影响**新增**的 settings 门禁——让 adapter entry 改用注入 Schema
 *  的那个 shim。默认 false，既有验收路径原样保留。 */
export function planEntries ({ tmpRoot, fixtures = [], adapter = null, omitSessionQuery = false, adapterFirst = false, extraServices = [], adapterSchema = false }) {
  const services = [
    ...serviceEntries(path.join(tmpRoot, 'sessions'))
      .filter((entry) => !(omitSessionQuery && entry.id === 'session-query')),
    ...extraServices.map((spec) => ({ config: {}, ...spec }))
  ]
  const fixtureEntries = fixtures.map((id, index) => ({
    id: `fx-${id}`,
    name: fixtureFileUrl(SHARED_FIXTURES[id] ?? LOCAL[id]),
    config: {}
  }))
  const adapterEntry = adapter === null ? null : {
    id: 'progressive-discovery',
    name: fixtureFileUrl(adapterSchema ? LOCAL['adapter-schema'] : LOCAL.adapter),
    config: adapter
  }
  if (adapterEntry === null) return [...services, ...fixtureEntries]
  return adapterFirst
    ? [...services, adapterEntry, ...fixtureEntries]
    : [...services, ...fixtureEntries, adapterEntry]
}

/** 错误取证：带 domain code，避免"只看到自定义文案"的歧义。 */
function describeError (error) {
  if (error === undefined || error === null) return 'unknown error'
  const code = typeof error.code === 'string' ? `[${error.code}] ` : ''
  return `${code}${String(error?.stack ?? error)}`
}

async function waitFor (probe, timeoutMs, what) {  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 启动真实 composition。
 * @returns {{ctx:any, loader:any, tmpRoot:string, entryStates:()=>any[], adapterError:()=>string|null}}
 */
export async function bootAdapterComposition (options = {}) {
  const { Context } = await import(dshModule('@deepseek-ai/cordis'))
  const { Loader } = await import(dshModule('@deepseek-ai/cordis-plugin-loader'))
  const tmpRoot = options.tmpRoot ?? makeTmpRoot('adapter')
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: installBaseUrl() })
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('loader service not reachable')

  const specs = planEntries({ ...options, tmpRoot })
  /** @type {Error[]} */
  const activationErrorsRaw = []
  for (const spec of specs) {
    try {
      await loader.create(spec)
    } catch (error) {
      activationErrorsRaw.push(error)
    }
  }
  try {
    await loader.await()
  } catch (error) {
    activationErrorsRaw.push(error)
  }

  const required = REQUIRED_SERVICES.filter((name) => !(options.omitSessionQuery === true && name === 'sessionQuery'))
  if (!options.skipServiceWait) {
    await waitFor(() => required.every((name) => ctx.get(name) !== undefined), 20000,
      `required services; missing: ${required.filter((name) => ctx.get(name) === undefined).join(', ')}`)
  }

  const entryStates = () => loader.entries().map((entry) => ({
    id: entry.id,
    disabled: entry.disabled === true,
    fiberState: entry.fiber?.state ?? null
  }))
  const adapterEntryState = () => loader.entries().find((entry) => entry.id === 'progressive-discovery') ?? null
  /** entry 的激活失败不一定让 loader.create/await 抛出：直接读 fiber 上的错误。 */
  const activationErrors = () => [
    ...activationErrorsRaw.map((error) => describeError(error)),
    ...loader.entries()
      .filter((entry) => entry.fiber?._error !== undefined && entry.fiber?._error !== null)
      .map((entry) => `entry ${entry.id}: ${describeError(entry.fiber._error)}`)
  ]

  return {
    ctx,
    loader,
    tmpRoot,
    specs,
    entryStates,
    adapterEntryState,
    activationErrors,
    dispose: () => removeTmpRoot(tmpRoot)
  }
}
