// progressive-v2/adapters/dsh/index.mjs
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
import { CONTROLLED_CATEGORIES, DomainError, ENTRY_TOOL_NAMES, createDiscoveryEngine } from '../../domain/index.mjs';
import { createEntryDefinitions } from './entries.mjs';
import { createGuard } from './guard.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createProjection } from './projection.mjs';
import { createRegistryAdapter } from './registry.mjs';

/** 默认可信类别表（部署可用 Config 覆盖）。category 只影响可发现性，不授予资格。 */
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
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained 必须是字符串数组。');
  }
  for (const name of frameworkRetained) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained 只能是非空字符串。');
    }
    if (ENTRY_TOOL_NAMES.includes(name)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `frameworkRetained 不得包含控制入口 "${name}"。`);
    }
  }
  if (new Set(frameworkRetained).size !== frameworkRetained.length) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'frameworkRetained 不得重复。');
  }
  const categoryConfig = config.categoryConfig ?? DEFAULT_CATEGORY_CONFIG;
  requirePlainObject(categoryConfig, 'categoryConfig');
  for (const id of Object.keys(categoryConfig)) {
    if (!CONTROLLED_CATEGORIES.includes(id)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `未知受控类别: ${id}`);
    }
    const card = requirePlainObject(categoryConfig[id], `categoryConfig.${id}`);
    if (typeof card.title !== 'string' || typeof card.capabilitySummary !== 'string') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `categoryConfig.${id} 需要 title 与 capabilitySummary。`);
    }
  }
  if (config.budgets !== undefined) requirePlainObject(config.budgets, 'budgets');
  if (config.allowMissingSessionQuery !== undefined && typeof config.allowMissingSessionQuery !== 'boolean') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'allowMissingSessionQuery 必须是布尔值。');
  }
  return {
    categoryConfig,
    budgets: config.budgets,
    frameworkRetained: Object.freeze([...frameworkRetained]),
    // 保留该键仅为兼容既有配置；缺失 sessionQuery 已不再拒绝激活。
    allowMissingSessionQuery: config.allowMissingSessionQuery === true,
  };
}

/**
 * 构造插件 apply。`defineTool` 由调用方注入（安装树内默认按裸包名解析）。
 * @param {{defineTool?:Function}} [deps]
 */
export function createProgressiveDiscoveryAdapter(deps = {}) {
  const apply = async function apply(ctx, rawConfig) {
    const resolved = deps.defineTool === undefined
      ? { defineTool: (await import('@deepseek-ai/dsh-tools')).defineTool }
      : deps;
    if (typeof resolved.defineTool !== 'function') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', '缺少 defineTool 依赖。');
    }
    const config = validateConfig(rawConfig);
    const log = (message, extra) => {
      if (typeof ctx.logger?.debug === 'function') ctx.logger.debug(`progressive-tools: ${message}`, extra);
    };

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
    if (query === undefined) {
      log('degraded:no-session-query', {
        impact: '新会话正常；有历史会话的冷恢复将 fail closed（mode:incompatible）',
      });
    }

    const clock = { now: () => Date.now() };
    const random = { bytes: (n) => randomBytes(n) };
    /** @type {Function[]} 已创建项的 disposer，按创建顺序持有 */
    const disposers = [];

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
      const lifecycle = createLifecycle({ ctx, registry, config, clock, random, query, log });
      own(() => lifecycle.dispose());

      // resolve 必须在注册前可用，但 runtime 在首次 assemble 时建立
      const resolveRuntime = (exec) => {
        const agent = exec?.agent;
        if (agent === undefined || agent.session === undefined) {
          throw new DomainError('INCOMPATIBLE_COMPOSITION', '缺少宿主会话上下文。');
        }
        const runtime = lifecycle.ensureRuntime(agent.session, agent);
        return { engine: runtime.engine, scope: runtime.scope };
      };

      // ---- 4. 三个 typed definition ----
      for (const definition of createEntryDefinitions({ defineTool: resolved.defineTool, resolve: resolveRuntime })) {
        own(ctx.tools.register(definition));
      }

      // ---- 5. 投影 ----
      own(createProjection({ ctx, lifecycle, frameworkRetained: config.frameworkRetained, log }));

      // ---- 6. guard（只增拒绝） ----
      own(createGuard({ ctx, lifecycle, frameworkRetained: config.frameworkRetained, log }));

      // ---- 7. session 与 registry 事件 ----
      own(ctx.on('session/event', (session, event) => lifecycle.onSessionEvent(session, event)));
      own(ctx.on('session/disposed', (session) => lifecycle.disposeSession(session.id)));
      own(ctx.on('tools/change', () => lifecycle.onRegistryChange()));

      // ---- 8. 配置语义校验（预算/类别）：非法配置必须走完整回滚 ----
      const probe = createDiscoveryEngine({
        protocolVersion: 2,
        categoryConfig: config.categoryConfig,
        entryToolNames: [...registry.entryNames],
        frameworkToolNames: [...registry.frameworkRetained],
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
        });
      }
    } catch (error) {
      rollback();
      throw error;
    }
  };
  // 只声明真正必需的服务；sessionQuery/agents 是可选依赖（缺失即 fail closed）。
  apply.inject = ['tools', 'systemPrompt'];
  return apply;
}

export default createProgressiveDiscoveryAdapter();
