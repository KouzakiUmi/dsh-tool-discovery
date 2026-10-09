// plugin/adapters/dsh/index.mjs
// 插件装配面：Config 校验、入口冲突检测、有序注册、整组 disposer 回滚。
//
// 激活顺序（任一步失败 → 逆序回滚已创建项，不留孤儿 listener/guard，L09）：
//   1. Config 形状校验
//   2. 三个入口名冲突检测（global 或任一活动 scope 可见面已存在即拒绝，不覆盖）
//   3. native-only 断言
//   4. 注册三个 typed definition
//   5. 投影监听（system-prompt/assemble）
//   6. 执行 guard（tools.guard）
//   7. session 监听（session/event、session/created、session/disposed）与 registry 变更（tools/change）
//   8. 预算/类别配置的**语义**校验（构造并释放一个探测引擎）
//      —— 刻意放在注册之后：配置非法时必须走完整的整组回滚路径。
//
// 边界：产品代码不含机器绝对路径；宿主模块（defineTool）由工厂注入，
// 安装树内的默认入口按裸包名动态 import。
import { randomBytes } from 'node:crypto';
import { CONTROLLED_CATEGORIES, DomainError, ENTRY_TOOL_NAMES, createDiscoveryEngine, createText, detectHostLocale, setDomainLocale } from '../../domain/index.mjs';
import { createEntryDefinitions } from './entries.mjs';
import { createGuard } from './guard.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createProjection } from './projection.mjs';
import { createRegistryAdapter } from './registry.mjs';
import { buildConfig, publishToolChoices, resolveAlwaysVisible } from './config.mjs';
import { globalToolInventory, presetToolNamesOf, scopeMountedToolNamesOf } from './tool-inventory.mjs';
import { createTrustedEpochHolder, createTrustedEpochStore, TRUSTED_EPOCH_REASONS } from './trusted-epoch.mjs';

/**
 * schemastery 必须在**默认工厂构造之前**就位。
 *
 * 原因：Cordis 对 `fiber.runtime.Config` 做首次 resolveConfig 是在 fiber 建立时，
 * 早于 apply 体。`dsh-settings` 读 `entry.fiber.runtime.Config` 时
 * （lib/index.js:539）也只会得到已有产物，**不会**回头补建 volatile 引用
 * （`:417` 的 ACTIVE 判断只关乎 describe 能否进行）。若在 apply 里才赋
 * `apply.Config`，首个配置解析已经错过，`alwaysVisible` 就不是 volatile ref，
 * 设置面板的即时写入会退化成一次 remount 式的重解析 —— 正好会打断我们最在意的
 * 缓存稳定性。所以这里用顶层 await 在模块加载期就把 Schema 拿稳。
 *
 * 工作区（无 node_modules、无 peer）下这会失败。只有明确的
 * ERR_MODULE_NOT_FOUND 被容忍并降级为"没有 Config 面板"；其余错误照抛。
 * 降级时 **不** 给 apply 挂 Config，宿主读到 undefined 就是真的没有 ——
 * 绝不谎称默认入口带 Config 或在线可用。
 */
let defaultSchema;
/** @type {{ package: string, reason: string }|null} 默认入口拿不到 Schema 时的说明 */
export let configSchemaUnavailable = null;
try {
  defaultSchema = (await import('@deepseek-ai/schemastery')).default;
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  configSchemaUnavailable = {
    package: '@deepseek-ai/schemastery',
    reason: 'ERR_MODULE_NOT_FOUND: install @deepseek-ai/schemastery (or pass deps.Schema) to get the settings surface; the plugin still works without it.',
  };
}

/** 默认可信类别表（部署可用 Config 覆盖）。category 只影响可发现性，不授予资格。
 *  部署未覆盖的类别回落到 locale 表——它们是模型可见的导航文案。 */
export const DEFAULT_CATEGORY_CONFIG = Object.freeze({
  files: { title: 'Files', capabilitySummary: 'Locate, read, search and modify workspace files.' },
  shell: { title: 'Shell', capabilitySummary: 'Run commands and manage persistent shells.' },
  web: { title: 'Web', capabilitySummary: 'Fetch URLs and raw HTTP resources.' },
  browser: { title: 'Browser', capabilitySummary: 'Drive a real browser: navigate, click, fill, inspect.' },
  desktop: { title: 'Desktop', capabilitySummary: 'Control desktop UI: windows, keyboard, pointer.' },
  github: { title: 'GitHub', capabilitySummary: 'Pull requests, issues, repos and review APIs.' },
  documents: { title: 'Documents', capabilitySummary: 'Create and edit office documents and sheets.' },
  data: { title: 'Data', capabilitySummary: 'Structured data queries, conversion and formatting.' },
  agents: { title: 'Agents', capabilitySummary: 'Delegate work to subagents and manage agent teams.' },
  images: { title: 'Images', capabilitySummary: 'View, crop and generate raster images.' },
  integrations: { title: 'Integrations', capabilitySummary: 'MCP servers and external service connectors.' },
  other: { title: 'Other', capabilitySummary: 'Anything not covered by the controlled categories.' },
});

function requirePlainObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', `${what} 必须是对象。`);
  }
  return value;
}

/** Config 形状校验（语义校验在激活末的探测引擎里做）。 */
export function validateConfig(raw) {
  const config = raw === undefined || raw === null ? {} : requirePlainObject(raw, 'config');
  const frameworkRetained = config.frameworkRetained ?? [];
  if (!Array.isArray(frameworkRetained)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained must be an array of strings.');
  }
  for (const name of frameworkRetained) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained must contain non-empty strings.');
    }
    if (ENTRY_TOOL_NAMES.includes(name)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `frameworkRetained must not contain the control entry "${name}".`);
    }
  }
  if (new Set(frameworkRetained).size !== frameworkRetained.length) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained must not contain duplicates.');
  }
  // validateConfig 只做形状校验；本地化后的类别表在 apply 里、探测到 locale
  // 之后才构造。此处仍需兜底，否则未部署 categoryConfig 的插件会被拒。
  const categoryConfig = config.categoryConfig ?? DEFAULT_CATEGORY_CONFIG;
  requirePlainObject(categoryConfig, 'categoryConfig');
  for (const id of Object.keys(categoryConfig)) {
    if (!CONTROLLED_CATEGORIES.includes(id)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `Unknown controlled category: ${id}`);
    }
    const card = requirePlainObject(categoryConfig[id], `categoryConfig.${id}`);
    if (typeof card.title !== 'string' || typeof card.capabilitySummary !== 'string') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `categoryConfig.${id} 需要 title 与 capabilitySummary。`);
    }
  }
  // budgets：null 与缺省**同义** —— Config 里 budgets 的默认值就是 null（"关闭
  // 覆盖"，见 buildConfig），schemastery 也会把用户显式写的 null 原样交给 apply。
  // resolveBudgets 对 undefined/null 一律回落 DEFAULT_BUDGETS，所以这里放行 null，
  // 只把"既不是缺省也不是 null 的非对象"（字符串 / 数组 / 数字 / 布尔）当形状错误。
  if (config.budgets !== undefined && config.budgets !== null) requirePlainObject(config.budgets, 'budgets');

  // alwaysVisible：默认放行 DSH 自带工具，使过滤只作用于后装的插件/MCP 工具。
  //
  // 配了 schemastery Config 时这里是 **volatile 引用**而不是数组（设置面板的即时
  // 写入正是靠它不重挂载），所以先归一再校验。归一后拿到的是**当前**值；周期中途
  // 的变更由 lifecycle 在周期边界自己去 fiber 上读，不靠这份快照。
  const alwaysVisibleRaw = (config.alwaysVisible !== null
    && typeof config.alwaysVisible === 'object'
    && typeof config.alwaysVisible.get === 'function')
    ? config.alwaysVisible.get()
    : config.alwaysVisible;
  if (alwaysVisibleRaw !== undefined && alwaysVisibleRaw !== null && !Array.isArray(alwaysVisibleRaw)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'alwaysVisible must be an array of strings.');
  }
  for (const name of alwaysVisibleRaw ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'alwaysVisible must contain non-empty strings.');
    }
  }

  if (config.allowMissingSessionQuery !== undefined && typeof config.allowMissingSessionQuery !== 'boolean') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'allowMissingSessionQuery must be a boolean.');
  }
  const initialToolsEnabled = typeof config.initialToolsEnabled?.get === 'function'
    ? config.initialToolsEnabled.get() : config.initialToolsEnabled;
  const alwaysAllowPresetTools = typeof config.alwaysAllowPresetTools?.get === 'function'
    ? config.alwaysAllowPresetTools.get() : config.alwaysAllowPresetTools;
  for (const [key, value] of Object.entries({ initialToolsEnabled, alwaysAllowPresetTools, requireTrustedEpoch: config.requireTrustedEpoch,
    requireTrustedEpochForSubagents: config.requireTrustedEpochForSubagents })) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `${key} must be a boolean.`);
    }
  }
  return {
    initialToolsEnabled: initialToolsEnabled !== false,
    alwaysAllowPresetTools: alwaysAllowPresetTools !== false,
    requireTrustedEpoch: config.requireTrustedEpoch === true,
    requireTrustedEpochForSubagents: config.requireTrustedEpochForSubagents === true,
    categoryConfig,
    budgets: config.budgets,
    frameworkRetained: Object.freeze([...frameworkRetained]),
    // 替换语义，不是并集：配置给出什么就是什么（CORE_TOOL_NAMES 只作 Config 默认值，
    // 见 config.mjs）。显式 `[]` 确实清空默认项，被移除的工具之后仍可经普通
    // tool_load 重新加载 —— engine 的 protected 判据随之放开。三个发现入口不在
    // 这个字段里，由 ENTRY_TOOL_NAMES 单独保护，任何配置都动不了。
    alwaysVisible: Object.freeze(resolveAlwaysVisible(alwaysVisibleRaw)),
    // 保留该键仅为兼容既有配置；缺失 sessionQuery 已不再拒绝激活。
    allowMissingSessionQuery: config.allowMissingSessionQuery === true,
  };
}

/**
 * 构造插件 apply。宿主依赖由调用方注入（安装树内默认按裸包名解析）。
 *
 * 注入契约（生产默认 = 裸包 dynamic import；工作区无 peer 时只降级对应能力，
 * 绝不伪造）：
 *   * `deps.defineTool` / `deps.Schema` —— 既有。
 *   * `deps.storageDomainApi = { defineDomain, domainTable }`
 *     取自 `@deepseek-ai/dsh-storage-domain`。
 *   * `deps.z` —— zod（**不是** schemastery：domain 的记录 schema 是 zod；
 *     schemastery 只有 Config 那一层，没有 parse/safeParse）。
 * @param {{defineTool?:Function, Schema?:any, storageDomainApi?:{defineDomain:Function, domainTable:Function}, z?:any}} [deps]
 */
export function createProgressiveDiscoveryAdapter(deps = {}) {
  const apply = async function apply(ctx, rawConfig) {
    const resolved = deps.defineTool === undefined
      ? { defineTool: (await import('@deepseek-ai/dsh-tools')).defineTool }
      : deps;
    if (typeof resolved.defineTool !== 'function') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The defineTool dependency is missing.');
    }
    // 可信周期的存储依赖：生产按裸包名解析；解析不到就**保持 unavailable 终态**，
    // 不伪造一套内存 domain —— 那等于把"没有权威"伪装成"有权威"。
    let storageDomainApi = deps.storageDomainApi;
    let zod = deps.z;
    if (zod === undefined) {
      try {
        const zodModule = await import('zod');
        // zod 既是 default 导出也可能是纯命名空间导出：取能建 schema 的那个。
        zod = zodModule.default ?? zodModule;
      } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        zod = undefined;
      }
    }
    if (storageDomainApi === undefined) {
      try {
        const sdk = await import('@deepseek-ai/dsh-storage-domain');
        storageDomainApi = { defineDomain: sdk.defineDomain, domainTable: sdk.domainTable };
      } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        storageDomainApi = undefined;
      }
    }
    const trustedEpochDepsAvailable = typeof zod === 'object' && zod !== null
      && typeof storageDomainApi?.defineDomain === 'function'
      && typeof storageDomainApi?.domainTable === 'function';
    const config = validateConfig(rawConfig);
    const log = (message, extra) => {
      // 诊断走 info：debug 级别默认不落盘，重启后无法据此判断激活状态。
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`progressive-tools: ${message}`, extra);
      else if (typeof ctx.logger?.debug === 'function') ctx.logger.debug(`progressive-tools: ${message}`, extra);
    };

    // 面向模型的文案跟随 DSH 界面语言。探测失败回落 en（见 host-locale.mjs）。
    const locale = detectHostLocale({ log });
    const text = createText(locale);
    // 纯校验函数（catalog/protocol/budgets/list/skills）不收 locale 参数，
    // 在此一次性绑定，使它们的拒绝文案也随界面语言。详见 locale.mjs 的取舍说明。
    setDomainLocale(locale);
    log('activate:locale', { locale });
    // 探测结果并入 config：engine 的 nextAction 与类别卡据此取文案。
    config.locale = locale;
    // 类别卡是模型可见的导航：部署未覆盖的用 locale 文案表，部署覆盖的优先。
    // 在此而非 validateConfig 内构造——那里还没有 text。
    const localizedDefaults = Object.fromEntries(CONTROLLED_CATEGORIES.map((id) => {
      const c = text.category(id);
      return [id, c ?? DEFAULT_CATEGORY_CONFIG[id]];
    }));
    config.categoryConfig = { ...localizedDefaults, ...(config.categoryConfig ?? {}) };

    const registry = createRegistryAdapter({
      ctx,
      entryNames: ENTRY_TOOL_NAMES,
      frameworkRetained: config.frameworkRetained,
      log,
    });

    // ---- 2. 入口名冲突：三个名字任一在 global 或任一活动 scope 可见面已存在即拒绝 ----
    const agents = ctx.get('agents');
    const liveAgents = agents === undefined || typeof agents.list !== 'function' ? [] : agents.list();
    const conflicts = registry.findEntryConflicts(liveAgents);
    if (conflicts.length > 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `控制入口名称冲突: ${conflicts.map((c) => `${c.name}@${c.where}`).join(', ')}`);
    }

    // ---- 3. native-only ----
    registry.assertNative(undefined);

    // sessionQuery 只用于**有历史**的会话做冷恢复（lifecycle: seq>0 才调
    // journal.restore()）。全新会话 seq===0 直接 ready，不读盘。
    // 因此缺失该服务时**不能拒绝激活**——那会让插件在所有会话上一律失效，
    // 而它本来完全能服务新会话。恢复不可用时的正确降级由 journal 逐会话
    // fail closed 承担（query===undefined → mode:'incompatible'），
    // 而不是在此处一刀切拒绝组合。
    const query = ctx.get('sessionQuery');
    log('activate:deps', {
      sessionQuery: query !== undefined,
      sessions: ctx.get('sessions') !== undefined,
      sessionPersistence: ctx.get('sessionPersistence') !== undefined,
      agents: ctx.get('agents') !== undefined,
      nativeOnly: true,
    });
    if (query === undefined) {
      log('degraded:no-session-query', {
        impact: '新会话正常；有历史会话的冷恢复将 fail closed（mode:incompatible）',
      });
    }

    const clock = { now: () => Date.now() };
    const random = { bytes: (n) => randomBytes(n) };
    /**
     * 可信周期的存储挂载点。**始终存在**（哪怕依赖/服务都不可用）：那样会话能拿到
     * 一个确定的 STORAGE_UNAVAILABLE 终态，而不是挂死等一个永远不会来的服务。
     */
    const trustedEpoch = createTrustedEpochHolder({ log });
    /** @type {Function[]} 已创建项的 disposer，按创建顺序持有 */
    const disposers = [];

    /**
     * 此刻生效的常驻名单。设置面板写入后 Cordis 会 **重新 resolveConfig 并换成
     * 一个新对象**（cordis lib/index.js:1355 `this.config = this._resolveConfig(...)`），
     * apply 期捕获的 rawConfig 里的旧 volatile ref 就此失效。故优先读 fiber 上的
     * 活 config，读不到才回落捕获值（首次加载时两者相同）。
     *
     * 只在 lifecycle 的两个**周期边界**被读（建立 runtime / 成功压缩后重开），
     * 周期中途配置变更因此不改变任何在跑的会话。
     */
    const getAlwaysVisible = () => {
      const enabled = ctx.fiber?.config?.initialToolsEnabled ?? config.initialToolsEnabled;
      if ((typeof enabled?.get === 'function' ? enabled.get() : enabled) === false) return [];
      const live = ctx.fiber?.config?.alwaysVisible;
      if (live !== undefined) return resolveAlwaysVisible(live);
      return resolveAlwaysVisible(config.alwaysVisible);
    };

    const getPresetTools = (agentScope) => {
      const enabled = ctx.fiber?.config?.alwaysAllowPresetTools ?? config.alwaysAllowPresetTools;
      if ((typeof enabled?.get === 'function' ? enabled.get() : enabled) === false) return [];
      return presetToolNamesOf(ctx.tools, ctx.get('agentPresets'), agentScope);
    };

    /** 把当前目录写进 Config 的 meta 并让设置面板重读。 */
    // 注意发布目标是 **apply.Config**（已构建的 Config 树），不是 schemastery 模块
    // 本身 —— 后者没有 dict.alwaysVisible。
    const refreshToolChoices = () => {
      if (apply.Config === undefined) return false;
      // 设置项是应用级配置：读全部登记层（包括预先加载的 preset），
      // 不读当前会话的资格/selected/frozen 表，也不要求创建任何会话。
      const inventory = globalToolInventory(ctx.tools);
      if (!publishToolChoices(apply.Config, inventory.names, { complete: inventory.complete })) return false;
      // describe() 每次都重跑 schema.toJSON() 并比对 raw（dsh-settings:421-435），
      // meta 一变 revision 就自增并 emit settings/document-updated；invalidate()
      // 只是把这次重算排进微任务。
      ctx.get('settings')?.invalidate?.();
      return true;
    };

    /** 新 runtime 建立时重新发布应用全局目录；不读取该 runtime 的会话目录。 */
    const onRuntimeCreated = () => { refreshToolChoices(); };

    /**
     * storageDomain 到位（或从 unavailable 变为可用）之后，把那些**只**因为存储
     * 缺席而封住的会话重试一次。迁移类终态（MISSING / INVALID）**不**重试 ——
     * 它们要等本次 live 的真实用户 `/compact`，不能靠重试蒙混过去。
     */
    const retryStorageUnavailable = (lifecycle) => {
      for (const runtime of lifecycle.sessions.values()) {
        if (runtime.ledger?.reason !== TRUSTED_EPOCH_REASONS.UNAVAILABLE) continue;
        lifecycle.retryBaseline(runtime);
      }
    };

    const rollback = () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          log('rollback-error', { error: String(error) });
        }
      }
      disposers.length = 0;
    };
    /** 宿主若不返回 disposer，也必须保证回滚路径安全。 */
    const own = (disposer) => {
      disposers.push(typeof disposer === 'function' ? disposer : () => {});
    };

    try {
      const lifecycle = createLifecycle({
        ctx,
        registry,
        config,
        clock,
        random,
        query,
        log,
        getAlwaysVisible,
        getPresetTools,
        onRuntimeCreated,
        trustedEpoch: trustedEpoch,
      });
      own(() => lifecycle.dispose());

      // ---- 8.5 可信周期存储：动态子 fiber，作用域内 open/close ----
      //
      // **不**把 storageDomain 放进 apply.inject：那会让宿主在整个组合里因为它而
      // 隐性不激活本插件。`ctx.inject(['storageDomain'], cb)` 是两参动态子 fiber ——
      // 服务到位才跑，跑在**自己的**作用域里，disposer 归它自己。
      //
      // 服务缺席 / open 失败都不是"降级继续"，而是会话级的确定终态
      // STORAGE_UNAVAILABLE（0 request，见 trusted-epoch.mjs）。
      // 兼容模式不打开、读取或写入可信周期存储；不是把易失状态伪装成 durable 授权。
      if (config.requireTrustedEpoch) ctx.inject(['storageDomain'], (storageCtx) => {
        if (!trustedEpochDepsAvailable) {
          log('trusted-epoch:deps-missing', {
            note: 'zod / @deepseek-ai/dsh-storage-domain 不可用；会话将落 STORAGE_UNAVAILABLE 并停止发请求。',
          });
          return;
        }
        const store = createTrustedEpochStore({
          facility: storageCtx.storageDomain,
          defineDomain: storageDomainApi.defineDomain,
          domainTable: storageDomainApi.domainTable,
          z: zod,
          log,
        });
        trustedEpoch.attach(store);
        storageCtx.effect(() => {
          // 幂等 open（并发共享同一次），失败只落终态，不重试、不挂死。
          const opening = store.ensureOpen();
          opening.then((outcome) => {
            if (outcome?.ok === true) retryStorageUnavailable(lifecycle);
            else log('trusted-epoch:unavailable', { reason: outcome?.reason, failure: store.failure });
          });
          return async () => {
            trustedEpoch.detach();
            await opening.catch(() => {});
            await store.close();
          };
        }, 'trusted-epoch store');
      });

      // resolve 必须在注册前可用，但 runtime 在首次 assemble 时建立
      const resolveRuntime = (exec) => {
        const agent = exec?.agent;
        if (agent === undefined || agent.session === undefined) {
          throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The host session context is missing.');
        }
        const runtime = lifecycle.ensureRuntime(agent.session, agent);
        return { engine: runtime.engine, scope: runtime.scope };
      };

      // ---- 4. 三个 typed definition ----
      for (const definition of createEntryDefinitions({ defineTool: resolved.defineTool, resolve: resolveRuntime, text })) {
        own(ctx.tools.register(definition));
      }

      // ---- 5. 投影 ----
      own(createProjection({ ctx, lifecycle, frameworkRetained: config.frameworkRetained, log }));

      // ---- 6. guard（只增拒绝） ----
      own(createGuard({ ctx, lifecycle, frameworkRetained: config.frameworkRetained, locale, log }));

      // ---- 7. session 与 registry 事件 ----
      own(ctx.on('session/event', (session, event) => lifecycle.onSessionEvent(session, event)));
      own(ctx.on('session/disposed', (session) => lifecycle.disposeSession(session.id)));

      // ---- 7.5 post-next 的 agent/pre-step 屏障 ----
      //
      // 宿主 assemble(:907) → waterfall('agent/pre-step')(:911) → 仍返回旧 assembly
      // (:921-923)，而 basic 的自动压缩就在这个 waterfall 内
      // （dsh-compaction-basic:839）。所以一次成功压缩换掉的名单，会**先**被那份
      // 尚未发送的 assembly 带出去，而新周期的可信记录可能还没 durable。
      // 这里在 next() 之后等本次新 epoch 的 put 落定；期间尊重宿主取消信号，
      // 不新增任何超时。
      own(ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        const sessionId = payload?.agent?.session?.id;
        if (typeof sessionId === 'string') {
          await lifecycle.awaitEpochRecord(sessionId, payload?.signal);
        }
        return decision;
      }));
      // 工具集变了（MCP 接入/断开、插件热注册）→ 目录元数据跟着更新，设置面板重读。
      own(ctx.on('tools/change', () => {
        lifecycle.onRegistryChange();
        refreshToolChoices();
      }));
      // 首次发布目录：此时三个入口已注册，其余可见工具就是用户能勾选的集合。
      refreshToolChoices();
      log('activate:config-surface', {
        configSchema: configSchema !== undefined,
        configSchemaUnavailable,
      });

      // ---- 8. 配置语义校验（预算/类别）：非法配置必须走完整回滚 ----
      const probe = createDiscoveryEngine({
        protocolVersion: 2,
        categoryConfig: config.categoryConfig,
        entryToolNames: [...registry.entryNames],
        frameworkToolNames: [...registry.frameworkRetained],
        alwaysToolNames: [...config.alwaysVisible],
        budgets: config.budgets,
        newSessionMode: 'restoring',
        bindings: [],
        clock,
        random,
        generation: 'probe',
      });
      probe.dispose();

      if (typeof ctx.provide === 'function') {
        ctx.provide('progressiveDiscovery', {
          whenReady: (sessionId) => lifecycle.whenReady(sessionId),
          sessions: lifecycle.sessions,
          registry,
          lifecycle,
          /** 设置面板的目录写入由宿主 settings 服务完成，这里只提供读侧事实。 */
          currentAlwaysVisible: getAlwaysVisible,
          /** 某会话的可信周期基线（门禁/诊断只读观测面）。 */
          trustedBaseline: (sessionId) => lifecycle.baselineOf(sessionId),
        });
      }
    } catch (error) {
      rollback();
      throw error;
    }
  };
  // inject 决定宿主**何时**调用 apply。只声明 tools/systemPrompt 时，apply 会在
  // 其后就绪的瞬间执行，而 sessionQuery（inject: ['sessions'] 的间接依赖）此时
  // 未必已激活——那正是 ctx.get('sessionQuery') 返回 undefined 的原因：服务在
  // 组合树里存在（--dump-config 可见），只是晚于本插件一步。
  //
  // 把它加入 inject 后：若该服务最终不可用，宿主不会调用 apply，插件保持未激活，
  // 宿主工具表不受影响——这是良性失败；若可用，则 apply 一定在它就绪之后运行，
  // 恢复路径拿到的就是真实服务。
  apply.inject = ['tools', 'systemPrompt', 'sessionQuery'];

  // Config 必须在**本工厂返回之前**挂上：宿主对 fiber.runtime.Config 的首次
  // resolveConfig 发生在 fiber 建立时，早于 apply 体，晚一秒就拿不到 volatile
  // 引用（见文件头 schema 解析段的说明）。
  const configSchema = deps.Schema ?? defaultSchema;
  if (configSchema !== undefined) {
    apply.Config = buildConfig(configSchema);
    publishToolChoices(apply.Config, []);
  } else {
    // 降级：明确记录缺依赖，但不谎称有 Config —— apply.Config 保持 undefined，
    // 宿主读到 undefined 就是真的没有设置面板。插件其余能力不受影响。
    apply.ConfigUnavailable = configSchemaUnavailable ?? {
      package: '@deepseek-ai/schemastery',
      reason: 'no schemastery Schema available',
    };
  }
  return apply;
}

export default createProgressiveDiscoveryAdapter();
