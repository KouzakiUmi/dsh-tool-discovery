// plugin/adapters/dsh/index.mjs
// 插件装配面：Config 校验、入口冲突检测、有序注册、整组 disposer 回滚。
//
// 激活顺序（任一步失败 → 逆序回滚已创建项，不留孤儿 listener/guard，L09）：
//   1. Config 形状校验
//   2. 三个入口名冲突检测（global 或任一活动 scope 可见面已存在即拒绝，不覆盖）
//   3. （展示模式不在激活期拒绝：按会话 scope 处理，见 projection / guard）
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
// 界面语言文件由**本层**读（内核 host-locale 是纯函数，不持有 I/O 能力）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_LOCALE, CONTROLLED_CATEGORIES, DomainError, ENTRY_TOOL_NAMES, PROTOCOL_VERSION, createDiscoveryEngine, createText, detectHostLocale, setDomainLocale } from '../../domain/index.mjs';
import { createEntryDefinitions } from './entries.mjs';
import { createGuard } from './guard.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createMaskController } from './mask.mjs';
import { createAdmissionStoreHandle, createAdmissionTracker } from './admission.mjs';
import { assertRestrictionHost, viewWithoutRestriction } from './restriction-view.mjs';
import { createRegistryChangeTracker } from './registry-change.mjs';
import { createRegistryAdapter } from './registry.mjs';
import { buildConfig, INITIAL_TOOL_CHOICES, publishToolChoices, resolveAlwaysVisible } from './config.mjs';
import { globalToolInventory, presetToolNamesOf } from './tool-inventory.mjs';

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

/** 宿主 profile 上下文（存在时给出 name / patchPath / home）——语言事实的权威入口。 */
function profileContextOf(ctx) {
  try {
    return ctx.get?.('profileContext') ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 profile patch 文本里取 `- id: locale` 那一项的 `config.preference`。
 *
 * 宿主把界面语言同时记在这里（`@deepseek-ai/dsh-client-locale` 的设置项），它与 profile 名
 * **无关**，所以比 desktop-locale.json 的 per-profile 键更可靠。只扫到下一个 `- id:` 行为止：
 * patch 里别的条目也可能带 `preference` 字段，正则跨条目匹配会读错。
 */
function preferenceFromPatch(text) {
  let inside = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*-\s*id\s*:/.test(line)) {
      inside = /^\s*-\s*id\s*:\s*['"]?locale['"]?\s*$/.test(line);
      continue;
    }
    if (!inside) continue;
    const match = /^\s*preference\s*:\s*['"]?([A-Za-z][A-Za-z0-9-]*)['"]?\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * 语言探测的全部注入面。每一项都可能缺（web/headless、更老的宿主），缺了就回落 en ——
 * 这里不抛错、不伪造路径：探测失败只意味着"语言没跟上"。
 *
 * `localeOverride` 钉住语言（非 `auto`）时**两个来源都不读**：域层会直接返回 override，
 * 任何来源值都用不上 —— 与其读了再扔，不如一开始就不碰文件系统（README 权限表与
 * 10-store §3.1 的承诺：「skips both reads entirely」）。判定规则与 detectHostLocale
 * 的 override 分支一致（trim + 小写后再比哨兵）。
 * @returns {Promise<{localeFile:string|null, localePreference:string|null, profileKey:string|null}>}
 */
export async function localeSourcesOf(ctx, localeOverride) {
  const override = typeof localeOverride === 'string' ? localeOverride.trim().toLowerCase() : '';
  if (override.length > 0 && override !== AUTO_LOCALE) {
    return { localeFile: null, localePreference: null, profileKey: null };
  }
  const profile = profileContextOf(ctx);
  let localeFile = null;
  if (typeof profile?.home === 'string' && profile.home.length > 0) {
    // profileContext.home 已由宿主规范化（空白 DSH_HOME 不会被解析成 cwd）。
    localeFile = join(profile.home, 'desktop-locale.json');
  } else {
    try {
      const mod = await import('@deepseek-ai/dsh-home-paths');
      if (typeof mod?.dshHomePath === 'function') localeFile = mod.dshHomePath('desktop-locale.json');
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  let localePreference = null;
  if (typeof profile?.patchPath === 'string' && profile.patchPath.length > 0) {
    try {
      localePreference = preferenceFromPatch(readFileSync(profile.patchPath, 'utf8'));
    } catch {
      localePreference = null;
    }
  }
  return {
    localeFile,
    localePreference,
    profileKey: typeof profile?.name === 'string' ? profile.name : null,
  };
}

/** 注入给域层的读取函数：域层不持有 I/O 能力，「怎么读」留在适配层。 */
function readLocaleFile(path) {
  return readFileSync(path, 'utf8');
}

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

  // locale：只校验形状。取值交给 domain 的 normalizeLocale 归一（未知语言名回落 en）——
  // "语言没跟上"比"插件整个起不来"轻，所以不因为一个无法识别的语言名拒绝激活。
  if (config.locale !== undefined && typeof config.locale !== 'string') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'locale must be a string.');
  }

  // respectAlwaysVisible：布尔开关（默认 false = 核心工具自动常驻且免披露放行）。
  // 与 initialToolsEnabled 同样先 unwrap volatile 引用再校验 —— 否则日后给该字段加 `.volatile()`
  // 时激活会直接 INCOMPATIBLE_COMPOSITION，而读取器里那段"兼容 volatile"的分支永远走不到。
  const respectAlwaysVisibleRaw = typeof config.respectAlwaysVisible?.get === 'function'
    ? config.respectAlwaysVisible.get() : config.respectAlwaysVisible;
  if (respectAlwaysVisibleRaw !== undefined && typeof respectAlwaysVisibleRaw !== 'boolean') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'respectAlwaysVisible must be a boolean.');
  }

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

  const initialToolsEnabled = typeof config.initialToolsEnabled?.get === 'function'
    ? config.initialToolsEnabled.get() : config.initialToolsEnabled;
  const alwaysAllowPresetTools = typeof config.alwaysAllowPresetTools?.get === 'function'
    ? config.alwaysAllowPresetTools.get() : config.alwaysAllowPresetTools;
  const gateOwnScopeTools = typeof config.gateOwnScopeTools?.get === 'function'
    ? config.gateOwnScopeTools.get() : config.gateOwnScopeTools;
  for (const [key, value] of Object.entries({ initialToolsEnabled, alwaysAllowPresetTools, gateOwnScopeTools })) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `${key} must be a boolean.`);
    }
  }
  // ptcCompatibility / compactBuiltinTool* / requireTrustedEpoch* 是 rc.1 上
  // 已废弃/移除的兼容键：不再读、不再校验，schema 层保留字段只为不吞配置。
  return {
    initialToolsEnabled: initialToolsEnabled !== false,
    alwaysAllowPresetTools: alwaysAllowPresetTools !== false,
    gateOwnScopeTools: gateOwnScopeTools !== false,
    categoryConfig,
    budgets: config.budgets,
    frameworkRetained: Object.freeze([...frameworkRetained]),
    // 替换语义，不是并集：配置给出什么就是什么（CORE_TOOL_NAMES 只作 Config 默认值，
    // 见 config.mjs）。显式 `[]` 确实清空默认项，被移除的工具之后仍可经普通
    // tool_load 重新加载 —— engine 的 protected 判据随之放开。三个发现入口不在
    // 这个字段里，由 ENTRY_TOOL_NAMES 单独保护，任何配置都动不了。
    alwaysVisible: Object.freeze(resolveAlwaysVisible(alwaysVisibleRaw)),
    // 下面三个键曾经**漏在这个字面量里**。注意：本函数的返回值是 apply 阶段唯一的 config
    // 视图（不是调用方传进来的原对象），所以漏掉的键等于"这个配置项不存在"——`tolerantLoadProtected`
    // 因此长期只能取默认 true，显式关掉它无效；`locale` 的钉住同理。现在由
    // plugin/tests/unit/config-passthrough.test.mjs 对着 config.mjs 的 schema 字段逐项钉住。
    tolerantLoadProtected: config.tolerantLoadProtected !== false,
    locale: typeof config.locale === 'string' ? config.locale : undefined,
    respectAlwaysVisible: respectAlwaysVisibleRaw === true,
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
      ? await import('@deepseek-ai/dsh-tools')
      : deps;
    if (typeof resolved.defineTool !== 'function') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The defineTool dependency is missing.');
    }
    // admission store 的 schema 依赖（zod + defineDomain/domainTable）。
    // 解析不到不是"降级继续"也不是"拒绝激活"：tracker 退化为纯内存表，
    // 掩码与执行门禁照旧，只是 durable resume 不可用（日志说明）。
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
    const admissionDepsAvailable = typeof zod === 'object' && zod !== null
      && typeof storageDomainApi?.defineDomain === 'function'
      && typeof storageDomainApi?.domainTable === 'function';
    const config = validateConfig(rawConfig);
    /**
     * 活配置读取（Cordis 两版兼容）。
     *
     * Cordis 4.1（0.2.2-rc.1 起）把 `fiber.config` 改成**原始输入**：它保留待下一次
     * 激活的 raw 值，不再经过 `internal/config` waterfall 与 schema 解析；解析结果
     * （含 volatile 引用）改由公开的 `fiber.effectiveConfig` 暴露。旧版（≤0.2.1-rc.x）
     * 只有 `fiber.config`。这里按能力探测：两版都读到"活的已解析配置"，都读不到时
     * 调用方各自的 `?? config.<field>` 负责回落到 apply 期快照。
     */
    const liveConfig = () => {
      const fiber = ctx.fiber;
      if (fiber === null || fiber === undefined) return undefined;
      return 'effectiveConfig' in fiber ? fiber.effectiveConfig : fiber.config;
    };
    const log = (message, extra) => {
      // 诊断走 info：debug 级别默认不落盘，重启后无法据此判断激活状态。
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`progressive-tools: ${message}`, extra);
      else if (typeof ctx.logger?.debug === 'function') ctx.logger.debug(`progressive-tools: ${message}`, extra);
    };

    // 面向模型的文案跟随 DSH 界面语言：Config 的 locale='auto'（默认）时读宿主界面语言文件，
    // 显式给出语言时不再读文件。路径由宿主 API 解析、读取由本层注入 —— 内核不持有 I/O 能力
    // （见 host-locale.mjs）。任何失败回落 en。
    const locale = detectHostLocale({
      ...(await localeSourcesOf(ctx, config.locale)),
      localeOverride: config.locale,
      readFile: readLocaleFile,
      log,
    });
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

    // rc.1+ 单一路径：restriction 层结构不符就不激活（assertRestrictionHost 一次性校验）。
    assertRestrictionHost(ctx.tools, log);
    const controlDefinitions = new Map();
    // 目录/preset 口径一律用不受本插件掩码影响的可见面（filtersFor 给出要忽略的层）。
    // mask 的常驻名单需要 lifecycle（runtime 建立时按 preset/自证合并），反向成立——
    // 用延迟引用解环。
    let lifecycleForMask = null;
    const mask = createMaskController({
      ctx,
      frameworkRetained: config.frameworkRetained,
      getAlwaysVisible: (agent) => lifecycleForMask?.currentAlwaysNames(agent) ?? [],
      log,
    });
    const tracker = createAdmissionTracker({ log });
    const unrestrictedViewFor = (scope) => {
      const filters = mask.filtersFor(scope);
      return filters.size === 0 ? ctx.tools.view(scope) : viewWithoutRestriction(ctx.tools, scope, filters);
    };
    const registry = createRegistryAdapter({
      ctx,
      entryNames: ENTRY_TOOL_NAMES,
      frameworkRetained: config.frameworkRetained,
      log,
    });

    // ---- 2. 入口名冲突：四个名字任一在 global 或任一活动 scope 可见面已存在即拒绝 ----
    const agents = ctx.get('agents');
    const liveAgents = agents === undefined || typeof agents.list !== 'function' ? [] : agents.list();
    const conflicts = registry.findEntryConflicts(liveAgents);
    if (conflicts.length > 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `控制入口名称冲突: ${conflicts.map((c) => `${c.name}@${c.where}`).join(', ')}`);
    }

    const clock = { now: () => Date.now() };
    const random = { bytes: (n) => randomBytes(n) };
    /** @type {Function[]} 已创建项的 disposer，按创建顺序持有 */
    const disposers = [];

    /**
     * 此刻生效的常驻名单。设置面板写入后 Cordis 会 **重新 resolveConfig 并换成
     * 一个新对象**（cordis lib/index.js:1355 `this.config = this._resolveConfig(...)`），
     * apply 期捕获的 rawConfig 里的旧 volatile ref 就此失效。故优先读 fiber 上的
     * 活 config，读不到才回落捕获值（首次加载时两者相同）。
     *
     * 常驻集合在新 runtime 与后续 reconcile 中读取；engine、mask、guard 同源更新。
     */
    const getInitialToolsEnabled = () => {
      const enabled = liveConfig()?.initialToolsEnabled ?? config.initialToolsEnabled;
      return (typeof enabled?.get === 'function' ? enabled.get() : enabled) !== false;
    };
    const getAlwaysVisible = () => {
      if (!getInitialToolsEnabled()) return [];
      const live = liveConfig()?.alwaysVisible;
      if (live !== undefined) return resolveAlwaysVisible(live);
      return resolveAlwaysVisible(config.alwaysVisible);
    };

    const getPresetTools = (agentScope, viewFor = unrestrictedViewFor) => {
      const enabled = liveConfig()?.alwaysAllowPresetTools ?? config.alwaysAllowPresetTools;
      if ((typeof enabled?.get === 'function' ? enabled.get() : enabled) === false) return [];
      return presetToolNamesOf(ctx.tools, ctx.get('agentPresets'), agentScope, viewFor);
    };
    /**
     * 常驻名单 memo 的代次 token（lifecycle 缓存键的一部分）：只读
     * alwaysAllowPresetTools 读数与 preset 绑定代次，不遍历 layer —— 让
     * 「preset 重绑但注册表没动」这类变化也能自然击穿缓存。
     */
    const getPresetToken = (agentScope) => {
      const enabled = liveConfig()?.alwaysAllowPresetTools ?? config.alwaysAllowPresetTools;
      const on = (typeof enabled?.get === 'function' ? enabled.get() : enabled) !== false;
      if (!on) return 'off';
      const generation = ctx.get('agentPresets')?.generationFor?.(agentScope?.ctx);
      return `on:${generation?.key ?? 'none'}`;
    };

    /**
     * 读 `respectAlwaysVisible`（兼容 volatile 引用与非 volatile 布尔）。
     *
     * 与 getInitialToolsEnabled / ptcEnabled 同一读法：validateConfig 的返回值已把
     * 该字段拍平为布尔，volatile 引用只活在 fiber 的活配置上 —— 只读拍平值的话
     * 设置面板的运行中变更永远不生效。默认 `false` = 现状（核心工具自动常驻且
     * 免披露放行）。guard 与 lifecycle 共用这一个读取器。
     */
    const getRespectAlwaysVisible = () => {
      const raw = liveConfig()?.respectAlwaysVisible ?? config.respectAlwaysVisible;
      const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
      return value === true;
    };

    /** 把当前目录写进 Config 的 meta 并让设置面板重读。 */
    // 注意发布目标是 **apply.Config**（已构建的 Config 树），不是 schemastery 模块
    // 本身 —— 后者没有 dict.alwaysVisible。
    let lastPublishedChoicesKey = null;
    const refreshToolChoices = () => {
      if (apply.Config === undefined) return false;
      // 设置项是应用级配置：读全部登记层（包括预先加载的 preset），
      // 不读当前会话的资格/selected/frozen 表，也不要求创建任何会话。
      const inventory = globalToolInventory(ctx.tools);
      const nextKey = `${inventory.complete === true ? '1' : '0'}:${inventory.names.join('\u0000')}`;
      // 新会话建立时也会触发 onRuntimeCreated → refreshToolChoices；全局工具目录未变时
      // 跳过重复写 meta 与 settings.invalidate()（避免每次建会话都重跑整棵 schema.toJSON）。
      if (nextKey === lastPublishedChoicesKey
        && Array.isArray(apply.Config?.dict?.alwaysVisible?.meta?.[INITIAL_TOOL_CHOICES])) {
        return false;
      }
      if (!publishToolChoices(apply.Config, inventory.names, { complete: inventory.complete })) return false;
      lastPublishedChoicesKey = nextKey;
      // describe() 每次都重跑 schema.toJSON() 并比对 raw（dsh-settings:421-435），
      // meta 一变 revision 就自增并 emit settings/document-updated；invalidate()
      // 只是把这次重算排进微任务。
      ctx.get('settings')?.invalidate?.();
      return true;
    };

    /** 新 runtime 建立时重新发布应用全局目录；不读取该 runtime 的会话目录。 */
    const onRuntimeCreated = () => { refreshToolChoices(); };

    const rollback = () => {
      // 同步释放门禁/监听，不让一个慢存储阻塞撤销；异步 cleanup 仍交回 Cordis 等待。
      const pending = [];
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          pending.push(Promise.resolve(dispose()).catch(error => {
            log('rollback-error', { error: String(error) });
          }));
        } catch (error) {
          log('rollback-error', { error: String(error) });
        }
      }
      return Promise.allSettled(pending);
    };
    /** 宿主若不返回 disposer，也必须保证回滚路径安全。 */
    const own = (disposer) => {
      disposers.push(typeof disposer === 'function' ? disposer : () => {});
    };

    // Cordis 自动回收监听/工具注册，但不认识下面的自有 runtime/engine/journal/ledger。
    // 与存储子 fiber 同样用 effect 持有 cleanup；失败激活已清空 disposers，后续释放为幂等空操作。
    ctx.effect(() => rollback, 'progressive discovery lifecycle');

    try {
      // ---- 1. 掩码控制器 + admission tracker（上面已建）→ lifecycle ----
      const lifecycle = createLifecycle({
        ctx,
        registry,
        config,
        clock,
        random,
        tracker,
        mask,
        log,
        viewFor: unrestrictedViewFor,
        getAlwaysVisible,
        getInitialToolsEnabled,
        getRespectAlwaysVisible,
        getPresetTools,
        getPresetToken,
        onRuntimeCreated,
      });
      lifecycleForMask = lifecycle;
      own(() => lifecycle.dispose());
      own(() => mask.dispose());
      const closeAdmissions = async () => {
        await lifecycle.settleOperations();
        await tracker.dispose();
      };
      own(closeAdmissions);

      // ---- 1.5 admission store：动态子 fiber，作用域内 open/close ----
      //
      // **不**把 storageDomain 放进 apply.inject：那会让宿主在整个组合里因为它而
      // 隐性不激活本插件。`ctx.inject(['storageDomain'], cb)` 是两参动态子 fiber ——
      // 服务到位才跑，跑在**自己的**作用域里，disposer 归它自己。
      //
      // 服务缺席 / open 失败只影响 durable resume：tracker 是纯内存表，掩码与
      // 执行门禁照常；记日志后什么都不做。
      own(ctx.inject(['storageDomain'], (storageCtx) => {
        if (!admissionDepsAvailable) {
          log('admission:deps-missing', {
            note: 'zod / @deepseek-ai/dsh-storage-domain 不可用；admission 仅存内存，durable resume 关闭。',
          });
          return;
        }
        const store = createAdmissionStoreHandle({
          facility: storageCtx.storageDomain,
          defineDomain: storageDomainApi.defineDomain,
          domainTable: storageDomainApi.domainTable,
          z: zod,
          log,
        });
        tracker.holder.store = store;
        storageCtx.effect(() => {
          let attached = true;
          const opening = (async () => {
            const first = await store.ensureOpen();
            return first?.ok === true || !attached ? first : store.ensureOpen();
          })();
          opening.then((outcome) => {
            if (!attached) return;
            if (outcome?.ok !== true) {
              log('admission:unavailable', { reason: outcome?.reason });
              return;
            }
            tracker.seedFromStore(store, [...lifecycle.sessions.keys()]);
            // 已建立的会话补一次 seed + 重掩码（attach 晚于会话建立时才会发生）。
            for (const runtime of lifecycle.sessions.values()) {
              const rows = [...tracker.admissionsFor(runtime.scope.sessionId).values()];
              const { seeded, dropped } = runtime.engine.seedSelection(runtime.scope, rows);
              for (const name of dropped) tracker.revoke(runtime.scope.sessionId, name);
              if (seeded.length > 0 || dropped.length > 0) {
                lifecycle.reconcileMask(runtime.scope.sessionId);
              }
            }
          });
          return async () => {
            attached = false;
            await opening;
            await lifecycle.settleOperations();
            await tracker.detachStore(store);
            await store.close();
          };
        }, 'admission store');
      }));

      // resolve 必须在注册前可用，但 runtime 在首次调用时建立
      const resolveRuntime = (exec) => {
        const agent = exec?.agent;
        if (agent === undefined || agent.session === undefined) {
          throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The host session context is missing.');
        }
        const runtime = lifecycle.runtimeFor(agent.session, agent);
        lifecycle.syncAlwaysNames(runtime);
        return { engine: runtime.engine, scope: runtime.scope, runtime };
      };

      // ---- 4. 四个 typed definition ----
      for (const definition of createEntryDefinitions({
        defineTool: resolved.defineTool,
        resolve: resolveRuntime,
        commitAdmissions: (runtime, rows) => lifecycle.commitAdmissions(runtime, rows),
        revokeAdmissions: (runtime, names) => lifecycle.revokeAdmissions(runtime, names),
        trackOperation: operation => lifecycle.trackOperation(operation),
        text,
      })) {
        own(ctx.tools.register(definition));
        controlDefinitions.set(definition.name, definition);
      }

      // ---- 6. guard（只增拒绝） ----
      own(createGuard({
        ctx,
        lifecycle,
        tracker,
        frameworkRetained: config.frameworkRetained,
        respectAlwaysVisible: getRespectAlwaysVisible,
        controlDefinitions,
        locale,
        log,
      }));

      // ---- 7. session / agent / registry 事件 ----
      own(ctx.on('session/disposed', (session) => lifecycle.disposeSession(session.id)));
      own(ctx.on('agent/created', ({ agent }) => {
        lifecycle.assertActive();
        // 建 runtime（目录/alwaysNameSet/seed）再装掩码——guard 与掩码都依赖它；
        // runtime 不建的话 guard 对 runtime===undefined 只能放行，own-scope
        // 工具首轮就会绕过准入。宿主会 await 这个监听器，同步建 runtime 安全。
        if (agent?.session !== undefined) lifecycle.runtimeFor(agent.session, agent);
        // 装初始掩码：admitted 读自 tracker（store 已 seed 时含 durable 行）。
        mask.ensure(agent, tracker.admissionsFor(agent?.session?.id));
      }));
      own(ctx.on('agent/disposed', ({ agent }) => { mask.disposeAgent(agent); }));
      for (const agent of liveAgents) {
        if (agent?.session !== undefined) {
          try { lifecycle.runtimeFor(agent.session, agent); } catch (error) {
            log('agent:runtime-warmup-failed', { agentId: agent?.id, error: String(error?.message ?? error) });
          }
        }
        mask.ensure(agent, tracker.admissionsFor(agent?.session?.id));
      }
      own(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        lifecycle.assertActive();
        if (context?.scope?.session && context.toolSet) {
          lifecycle.captureStep(context.scope, context.toolSet);
        }
        return next();
      }));
      // pre-step 兜底 reconcile：admission 与 restrictable 集合的任何漂移
      // （第三方掩码叠加、工具热注册）都在下一步装配前重对齐。
      own(ctx.on('agent/pre-step', async (payload, next) => {
        lifecycle.assertActive();
        const agent = payload?.agent;
        const sessionId = agent?.session?.id;
        if (agent !== undefined && typeof sessionId === 'string') {
          lifecycle.reconcileMask(sessionId);
        }
        return next();
      }));
      // 工具集变了（MCP 接入/断开、插件热注册）→ 目录 + admission 对齐 + 重掩码。
      let registryRefreshQueued = false;
      let registryListenerActive = true;
      own(() => { registryListenerActive = false; });
      const registryChanges = createRegistryChangeTracker(ctx.tools, () => mask.ownedFilters());
      const reconcileRegistry = (maskOnly = false) => {
        const changed = registryChanges.changed();
        if (maskOnly && changed === false) return;
        lifecycle.onRegistryChange();
        refreshToolChoices();
      };
      own(ctx.on('tools/change', () => {
        if (mask.isMutating()) {
          // 自反馈环里可能夹着重入的第三方注册：microtask 对齐一次，不丢。
          if (!registryRefreshQueued) {
            registryRefreshQueued = true;
            queueMicrotask(() => {
              registryRefreshQueued = false;
              if (!registryListenerActive) return;
              reconcileRegistry(true);
            });
          }
          return;
        }
        reconcileRegistry();
      }));
      // 首次发布目录：此时四个入口已注册，其余可见工具就是用户能勾选的集合。
      refreshToolChoices();
      log('activate:config-surface', {
        configSchema: configSchema !== undefined,
        configSchemaUnavailable,
      });

      // ---- 8. 配置语义校验（预算/类别）：非法配置必须走完整回滚 ----
      const probe = createDiscoveryEngine({
        protocolVersion: PROTOCOL_VERSION,
        categoryConfig: config.categoryConfig,
        entryToolNames: [...registry.entryNames],
        frameworkToolNames: [...registry.frameworkRetained],
        alwaysToolNames: [...config.alwaysVisible],
        budgets: config.budgets,
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
          mask,
          tracker,
          /** 设置面板的目录写入由宿主 settings 服务完成，这里只提供读侧事实。 */
          currentAlwaysVisible: getAlwaysVisible,
          /** 某会话的准入观测面（诊断只读）。 */
          trustedBaseline: (sessionId) => lifecycle.baselineOf(sessionId),
        });
      }
    } catch (error) {
      await rollback();
      throw error;
    }
  };
  // inject 决定宿主**何时**调用 apply。storageDomain 不在其中：那是动态子 fiber
  // 的可选依赖（缺席=纯内存 admission），不该让整个插件因为它不激活。
  apply.inject = ['tools', 'systemPrompt'];

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
