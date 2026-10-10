// 组合测试 harness：真实 Cordis Loader entry 树 + 安装内 0.2.1-alpha.2 服务
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
  'registry-churn': path.join(LOCAL_FIXTURES, 'registry-churn.mjs'),
  'removable-tool': path.join(LOCAL_FIXTURES, 'removable-tool.mjs')
}

/** 本用例私有的存储根（与 session 持久化根同级，互不覆盖）。 */
export function storageRoot (tmpRoot) {
  return path.join(tmpRoot, 'data')
}

/**
 * 可信周期记录用的真实 SDK 存储 provider（安装内 0.2.1-alpha.2）。
 *
 * 这三条 entry 与 Desktop base bundle 的真实装配同源：
 * `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:161-176`
 *   storage        → ctx.storage
 *   storage-json   → storageBackendServiceKey('json')   Config { root }
 *   storage-domain → ctx.storage.domain               Config { backend, routes }
 *
 * root 落在**本用例自己的 tmpRoot/data** 下，随 boot.dispose() 的 removeTmpRoot 一起清除，
 * 不写用户真实 DSH home。
 */
export function storageEntries (tmpRoot) {
  return [
    { id: 'storage', name: '@deepseek-ai/dsh-storage', config: {} },
    { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: storageRoot(tmpRoot) } },
    { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }
  ]
}

/**
 * 真实宿主 fork 场景需要的最小服务集（`planEntries` 的 `extraServices` 参数）。
 *
 * 为什么不是只装配 subagents + fork provider：`@deepseek-ai/dsh-subagent` 的
 * `static inject` 含 **`workingDirectory`**（0.2.1-alpha.2 起），而
 * `@deepseek-ai/dsh-working-directory` 又硬依赖 `fs` 与 `sessionProjections`。
 * 少装任何一条，subagents 的 fiber 都停在 pending：`ctx.get('subagents')` 是
 * undefined，真实 fork 门禁会以「前置不成立」失败 —— 那不是产品缺陷，是装配缺口。
 *
 * 三条与安装内最小装配同源（`@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml`）：
 *   sandbox           → ctx.sandbox
 *   filesystem        → ctx.fs（fs-local）
 *   working-directory → ctx.workingDirectory
 *
 * @param {string} [defaultDirectory] workingDirectory 的部署回落目录（必须是绝对路径）。
 */
export function forkServices (defaultDirectory = process.cwd()) {
  return [
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local', config: {} },
    { id: 'filesystem', name: '@deepseek-ai/dsh-fs-local', config: {} },
    { id: 'working-directory', name: '@deepseek-ai/dsh-working-directory', config: { defaultDirectory } },
    { id: 'subagents', name: '@deepseek-ai/dsh-subagent', config: {} },
    { id: 'subagent-fork-in-process', name: '@deepseek-ai/dsh-subagent-fork-in-process', config: {} }
  ]
}

/**
 * 真实 fork 子会话的启动器 —— 0.2.1-alpha.2 的 activation 形状。
 *
 * `ctx.subagents.start(provider, request)` 在 0.2.1-alpha.2 已不存在；公开入口是
 * `startActivation({ provider, label, request, signal, delivery })`，返回
 * `{ childId, messageId, result, dispose }`，**不再回传子 Agent 句柄** —— 子 Agent 由
 * `ctx.agents.get(childId)` 取（物化后立即可达）。这里把两者收口成门禁共用的一个形状，
 * 避免每个真实 fork 门禁各自写一遍 API 映射。
 *
 * 注意 `dispose` 是**本次 activation** 的释放句柄，不是「关闭子会话」。
 *
 * @param {any} ctx 已装配 forkServices() 的 composition ctx。
 * @param {any} parentAgent 作为父的真实 live Agent（必须是 agents 里那个精确实例）。
 * @param {string} [promptText] 初始 prompt 文本，同时用作 descriptor label。
 * @param {{signal?:AbortSignal}} [options] 调用方取消信号。
 * @returns {Promise<{id:string, result:Promise<unknown>, localAgent:any, dispose:()=>Promise<void>}>}
 */
export async function startFork (ctx, parentAgent, promptText = 'Child task.', options = {}) {
  const receipt = await ctx.subagents.startActivation({
    provider: 'fork',
    label: promptText,
    request: { parent: parentAgent, prompt: [{ type: 'text', text: promptText }] },
    signal: options.signal ?? new AbortController().signal,
    delivery: 'parent'
  })
  return {
    id: receipt.childId,
    result: receipt.result,
    localAgent: ctx.agents.get(receipt.childId),
    dispose: receipt.dispose
  }
}

/** 组装 entry 列表：服务 → 选定 fixture → adapter（最后装配，便于观察冲突面）。
 *  extraServices：追加的安装内公共服务 entry（如 subagents / fork provider），
 *  形如 { id, name, config? }；仅测试装配用，不改 contracts/。
 *  adapterSchema：只影响**新增**的 settings 门禁——让 adapter entry 改用注入 Schema
 *  的那个 shim。默认 false，既有验收路径原样保留。
 *  omitStorage：显式**负向**开关——不装配 storage 三件套，供「缺 provider」路径使用。
 *  默认装配（产品强制可信记录，composition 必须处在真实存储之下）。 */
export function planEntries ({ tmpRoot, fixtures = [], adapter = null, omitSessionQuery = false, adapterFirst = false, extraServices = [], adapterSchema = false, omitStorage = false }) {
  const services = [
    ...serviceEntries(path.join(tmpRoot, 'sessions'))
      .filter((entry) => !(omitSessionQuery && entry.id === 'session-query')),
    ...(omitStorage === true ? [] : storageEntries(tmpRoot)),
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
  // ctx.plugin() 返回的 fiber 是公开的关闭句柄；保留下来供 closeServices() 用。
  const loaderFiber = await ctx.plugin(Loader, { baseUrl: installBaseUrl() })
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
  // storageDomain 只在装配了 storage 三件套时才是必需服务（omitStorage 是显式负向路径）。
  const requiredWithStorage = options.omitStorage === true ? required : [...required, 'storageDomain']
  if (!options.skipServiceWait) {
    await waitFor(() => requiredWithStorage.every((name) => ctx.get(name) !== undefined), 20000,
      `required services; missing: ${requiredWithStorage.filter((name) => ctx.get(name) === undefined).join(', ')}`)
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

  /**
   * **真正**关闭本 composition 装配的所有服务，但**保留 tmpRoot**。
   *
   * 用于「真关闭 → 同 root 重启」这类门禁：只有把 entry fiber 逐个 dispose 掉、
   * 让 adapter 释放它打开的 storage domain、再让 storage provider 卸载，
   * 第二个 Loader 才不是并发开同一物理 medium。
   *
   * 关闭顺序 = **创建顺序的逆序**（adapter 最后装配，先关；storage provider 先装配，后关），
   * 这样 adapter 有机会先释放它打开的 domain。逐个 await，避免半关闭状态。
   *
   * 公开面：`await fiber.dispose()`（官方 framework 文档）、`ctx.storageDomain.closeAll()`
   * （官方 SDK public）。不碰 loader 内部的 `remove()`（它不 await disposal）。
   */
  const closeServices = async () => {
    const closeErrors = []
    for (const entry of [...loader.entries()].reverse()) {
      const fiber = entry.fiber
      if (fiber === undefined || fiber === null) continue
      if (typeof fiber.dispose !== 'function') {
        closeErrors.push(`entry ${entry.id}: fiber.dispose is not a function`)
        continue
      }
      try {
        await fiber.dispose()
      } catch (error) {
        closeErrors.push(`entry ${entry.id}: ${String(error?.message ?? error)}`)
      }
    }
    // 官方 SDK 公开的收尾：关掉任何仍然打开的 domain（重复关闭是幂等的）。
    const facility = ctx.get('storageDomain')
    if (facility !== undefined && typeof facility.closeAll === 'function') {
      try {
        await facility.closeAll()
      } catch (error) {
        closeErrors.push(`storageDomain.closeAll: ${String(error?.message ?? error)}`)
      }
    }
    if (closeErrors.length > 0) throw new Error(`closeServices 未完全关闭：${closeErrors.join(' | ')}`)
  }

  return {
    ctx,
    loader,
    /** ctx.plugin(Loader) 返回的公开关闭 fiber。 */
    loaderFiber,
    tmpRoot,
    /** 本用例私有的真实存储根（omitStorage 时目录不会被创建）。 */
    storageRoot: storageRoot(tmpRoot),
    /** 该 composition 是否真的装配了 storage 三件套。 */
    storageMounted: options.omitStorage !== true,
    specs,
    entryStates,
    adapterEntryState,
    activationErrors,
    /** 真关闭服务但保留 tmpRoot；需要重启复用同一 root 的门禁用它。 */
    closeServices,
    dispose: () => removeTmpRoot(tmpRoot)
  }
}
