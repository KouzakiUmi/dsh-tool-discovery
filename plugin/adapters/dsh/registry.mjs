// plugin/adapters/dsh/registry.mjs
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
//
// 绑定代次（bindingGeneration，2026-10 修）：
//   domain 的 revision 含 bindingGeneration，而宿主对**任一 scope 的任一次**
//   register/dispose/restrict 都广播 tools/change（dsh-tools lib/index.js 的
//   ScopedLayers 变更回调）。因此该代次不能是 scope 级单值 —— 那样任何无关工具
//   的热注册都会改写全量 revision，refreshCatalog 随即把所有 selected 判成
//   definition-changed 全部作废。
//   改为 **scope + toolId 独立**的代次，且只在该绑定**自身**变化时推进：
//     * definition **实例**被替换（哪怕 wire 完全相同）→ 换代；
//     * wire 变化 → 换代；
//     * 该绑定从视图消失 → 记缺席并预换代一次，重加时不得复用旧代次；
//     * 其余（别人的工具在动、跨 scope 事件）→ 代次不变，selected 存活。
//   代次是**每次进程内从 1 开始的单调计数**，不含随机量：冷启动用同一 wire 重建
//   得到与首次激活相同的 revision，历史回执的 revision 判据仍可对上。
//   scope 目录代次（generationFor/bumpGeneration）保持原样推进 —— 旧 ref/cursor
//   的失效由 domain 的 eligibilityGeneration 承担，不受本改动影响。
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

  /** scopeKey → 目录代次（宿主侧单调计数；domain 另有资格代次）。 */
  const generations = new Map();
  /** scopeKey → 上一次 bindings 的 toolId 集合（供变更 diff 取证）。 */
  const lastSeen = new Map();
  /**
   * 每个绑定自己的代次：`${scopeKey}\u0000${toolId}` → { gen, definition, digest }。
   * definition 存实例引用（宿主 view() 返回的就是注册时那个对象，见 dsh-tools
   * `view()`：visible 直接透传 layer.tools 的值），因此实例身份可被稳定追踪；
   * digest 是 wire 摘要，用来兜住「同一实例被就地改了 schema」的情况。
   * definition/digest 同时为 undefined = 该绑定当前不在视图里（缺席）。
   */
  const bindingState = new Map();

  const bindingKey = (scopeKey, toolId) => `${scopeKey}\u0000${toolId}`;

  function generationFor(scopeKey) {
    let g = generations.get(scopeKey);
    if (g === undefined) {
      g = 1;
      generations.set(scopeKey, g);
    }
    return `bg_${scopeKey}_${g}`;
  }

  /**
   * 单个绑定的代次：首次出现 / 从缺席重现 / 实例被换 / wire 变了 → 推进；
   * 其余情况原样返回（同一实例 + 同一 wire），使无关变更不波及已有 selected。
   */
  function bindingGenerationFor(scopeKey, toolId, definition, digest) {
    const key = bindingKey(scopeKey, toolId);
    const prev = bindingState.get(key);
    const changed = prev === undefined
      || prev.definition !== definition
      || prev.digest !== digest;
    const gen = changed ? (prev?.gen ?? 0) + 1 : prev.gen;
    bindingState.set(key, { gen, definition, digest });
    return `bg_${scopeKey}_${gen}`;
  }

  /**
   * 把该 scope 上已经看不见的绑定标为缺席并预换代一次：重加时必然拿到新代次，
   * 不会因为「移除→重加、wire 与实例都没变」而复用旧代次。
   */
  function retireAbsent(scopeKey, present) {
    const prefix = `${scopeKey}\u0000`;
    for (const [key, state] of bindingState) {
      if (!key.startsWith(prefix) || present.has(key)) continue;
      if (state.definition === undefined && state.digest === undefined) continue;
      bindingState.set(key, { gen: state.gen + 1, definition: undefined, digest: undefined });
    }
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
   * 每个绑定带**自己的**绑定代次（见文件头「绑定代次」段）。
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
    /** @type {Set<string>} 本轮仍在视图里的绑定键 */
    const present = new Set();

    for (const [name, definition] of view.visible) {
      if (entryNames.has(name)) continue;
      if (frameworkRetained.has(name)) continue;
      const globalDefinition = globalView.visible.get(name);
      const shadowsGlobal = globalDefinition !== undefined && globalDefinition !== definition;
      const toolId = shadowsGlobal
        ? `${scopeKey}::${name}`
        : `global::${name}`;
      const wire = wireOfDefinition(definition);
      const bindingGeneration = bindingGenerationFor(scopeKey, toolId, definition, digestOf(wire));
      present.add(bindingKey(scopeKey, toolId));
      bindings.push({
        toolId,
        name,
        description: typeof definition.description === 'string' ? definition.description : '',
        wire,
        // 宿主未公开：不得猜测
        providerNamespace: null,
        bindingGeneration,
        shadowOf: shadowsGlobal ? `global::${name}` : null,
        trustedCategoryOverride: null,
        skill: null,
      });
      if (!toolIdsByName.has(name)) toolIdsByName.set(name, toolId);
    }

    bindings.sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
    retireAbsent(scopeKey, present);
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
