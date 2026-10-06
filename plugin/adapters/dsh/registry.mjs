// progressive-v2/adapters/dsh/registry.mjs
// 资格事实的唯一入口：把当前 scope 的**真实可见集合**投影成 domain 的
// CatalogBindingDTO[]，并维护宿主侧的绑定代次。
//
// 边界（见 reports/adapter-fit-gap.md）：
//   * 宿主没有 toolId / providerNamespace / bindingGeneration 的公开 API，
//     因此 toolId 由本模块合成，providerNamespace 一律 null（不猜）。
//   * 同名 shadow 只能观测到胜出定义；shadowOf 仅在"scope 解析结果与 global
//     不同"时合成，**不冒称覆盖完整同名双绑定检测**（S04 待宿主 API）。
//   * tools/change 无 payload：变更代次靠重算 diff + domain 的 refreshCatalog。
//   * 检索/排序/分类/identity 全部由 domain 计算，本模块不做。
import { ENTRY_TOOL_NAMES, digestOf } from '../../domain/index.mjs';

/** 宿主 schema 投影 → domain wire（有效 wire 字段：name/description/parameters）。 */
export function wireOfSchema(schema) {
  const wire = { name: schema.name };
  if (typeof schema.description === 'string') wire.description = schema.description;
  if (schema.parameters !== null && typeof schema.parameters === 'object') wire.parameters = schema.parameters;
  return wire;
}

/** 宿主 definition → wire（与 tools.schemas() 的 schemaOf 投影同形）。 */
export function wireOfDefinition(definition) {
  return wireOfSchema({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  });
}

/** scope 键：global 层或某个 agent 的自有层。 */
export function scopeKeyOf(scope) {
  return scope === undefined || scope === null ? 'global' : `agent:${scope.id}`;
}

/**
 * 资格视图适配器。
 * @param {{ctx: any, entryNames?: readonly string[], frameworkRetained?: readonly string[], log?: (msg: string, extra?: any) => void}} deps
 */
export function createRegistryAdapter(deps) {
  const { ctx } = deps;
  const entryNames = new Set([...(deps.entryNames ?? ENTRY_TOOL_NAMES)]);
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  const log = deps.log ?? (() => {});

  /** scopeKey → 绑定代次（宿主侧单调计数；domain 另有资格代次）。 */
  const generations = new Map();
  /** scopeKey → 上一次 bindings 的 toolId 集合（供变更 diff 取证）。 */
  const lastSeen = new Map();

  function generationFor(scopeKey) {
    let g = generations.get(scopeKey);
    if (g === undefined) {
      g = 1;
      generations.set(scopeKey, g);
    }
    return `bg_${scopeKey}_${g}`;
  }

  /** 宿主是否允许本组合：native-only（ptc/both 一律拒绝激活）。 */
  function assertNative(scope) {
    const mode = ctx.tools.modeFor(scope);
    if (mode !== 'native') {
      const error = new Error(`INCOMPATIBLE_PRESENTATION: tools mode "${mode}" is not supported; this composition is native-only`);
      error.code = 'INCOMPATIBLE_PRESENTATION';
      throw error;
    }
    return mode;
  }

  /**
   * 当前 scope 的可见集合 → CatalogBindingDTO[]。
   * 入口与可信 framework 保留项不进目录（它们不可 load/unload）。
   * @param {any} scope agent 或 undefined（global）
   * @returns {{bindings: any[], toolIdsByName: Map<string,string>, generation: string, scopeKey: string}}
   */
  function bindingsFor(scope) {
    const scopeKey = scopeKeyOf(scope);
    const generation = generationFor(scopeKey);
    const view = ctx.tools.view(scope);
    const globalView = ctx.tools.view(undefined);
    /** @type {any[]} */
    const bindings = [];
    /** @type {Map<string,string>} */
    const toolIdsByName = new Map();

    for (const [name, definition] of view.visible) {
      if (entryNames.has(name)) continue;
      if (frameworkRetained.has(name)) continue;
      const globalDefinition = globalView.visible.get(name);
      const shadowsGlobal = globalDefinition !== undefined && globalDefinition !== definition;
      const toolId = shadowsGlobal
        ? `${scopeKey}::${name}`
        : `global::${name}`;
      const wire = wireOfDefinition(definition);
      bindings.push({
        toolId,
        name,
        description: typeof definition.description === 'string' ? definition.description : '',
        wire,
        // 宿主未公开：不得猜测
        providerNamespace: null,
        bindingGeneration: generation,
        shadowOf: shadowsGlobal ? `global::${name}` : null,
        trustedCategoryOverride: null,
        skill: null,
      });
      if (!toolIdsByName.has(name)) toolIdsByName.set(name, toolId);
    }

    bindings.sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
    return { bindings, toolIdsByName, generation, scopeKey };
  }

  /** 记录本次快照，便于变更 diff 取证。 */
  function remember(scopeKey, bindings) {
    lastSeen.set(scopeKey, new Set(bindings.map((b) => b.toolId)));
  }

  /**
   * tools/change 后的代次推进与差异报告（不触碰 domain 状态）。
   * @param {any} scope
   */
  function bumpGeneration(scope) {
    const scopeKey = scopeKeyOf(scope);
    generations.set(scopeKey, (generations.get(scopeKey) ?? 1) + 1);
    log('registry:change', { scopeKey, generation: generations.get(scopeKey) });
  }

  /**
   * 与上一次快照比较，返回新增/消失/定义变化的 toolId（用于失效与取证）。
   * @param {any} scope
   * @param {any[]} bindings
   */
  function diffAgainst(scope, bindings) {
    const scopeKey = scopeKeyOf(scope);
    const previous = lastSeen.get(scopeKey);
    const next = new Set(bindings.map((b) => b.toolId));
    if (previous === undefined) {
      return { added: [...next], removed: [], changed: [] };
    }
    const added = [];
    const removed = [];
    for (const id of next) if (!previous.has(id)) added.push(id);
    for (const id of previous) if (!next.has(id)) removed.push(id);
    return { added, removed, changed: [] };
  }

  /** 登记入口名冲突：三个名字任一在 global 或当前 scope 可见面已存在即冲突。 */
  function findEntryConflicts(scopes) {
    /** @type {{name: string, where: string, definition: any}[]} */
    const conflicts = [];
    const candidates = [{ scope: undefined, where: 'global' }, ...scopes.map((s) => ({ scope: s, where: scopeKeyOf(s) }))];
    for (const name of entryNames) {
      for (const candidate of candidates) {
        const definition = ctx.tools.get(name, candidate.scope);
        if (definition !== undefined) conflicts.push({ name, where: candidate.where, definition });
      }
    }
    return conflicts;
  }

  return {
    entryNames,
    frameworkRetained,
    scopeKeyOf,
    generationFor,
    assertNative,
    bindingsFor,
    remember,
    bumpGeneration,
    diffAgainst,
    findEntryConflicts,
    /** 当前 scope 下按名称解析的 toolId（guard/projection 只读）。 */
    toolIdFor(scope, name) {
      return this.bindingsFor(scope).toolIdsByName.get(name) ?? null;
    },
    /** 组合内的 wire 摘要（报告取证用）。 */
    digestOfWire: digestOf,
  };
}
