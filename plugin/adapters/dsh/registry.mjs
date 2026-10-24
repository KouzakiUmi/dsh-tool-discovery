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
  // Preserve the observed field order; canonicalization is only for identity.
  const wire = {};
  for (const key of Object.keys(schema)) {
    if (key === 'name'
      || (key === 'description' && typeof schema[key] === 'string')
      || (key === 'parameters' && schema[key] !== null && typeof schema[key] === 'object')) {
      wire[key] = schema[key];
    }
  }
  if (!Object.hasOwn(wire, 'name')) wire.name = schema.name;
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
   *
   * digest 的重算探针：宿主对**任一 scope** 的任意注册动作都广播 tools/change，
   * 每次都会对**全部**可见绑定重走这里。同一实例且序列化内容未变时（绝大多数
   * 广播都是这种无关变更），用上次缓存的 digest 即可 —— 但"实例未变"单独不足以
   * 跳过：digest 兜的正是**同一实例被就地改写 schema**。因此对 wire 实际读取的
   * 三个字段（name/description/parameters，**直接属性读取**，能看到非枚举与原型
   * 解析值，与 wireOfDefinition 同一读取面；不读 definition 的其它字段，避免
   * 触发无关 getter）做一次普通 JSON.stringify（约 canonical 的 1/5 成本）作内容
   * 探针，探针一致才复用；探针不同或序列化失败则当场重算 canonical digest。
   * 残余盲区（Symbol 键携带 wire 数据、不可枚举 toJSON 快照）下代次计数可能少推
   * 一次，但 wire/digest 本身仍按当前内容重建，授权语义由 catalog 的
   * schemaDigest 判据兜底，不受影响。
   * @param {string} scopeKey
   * @param {string} toolId
   * @param {any} definition
   * @param {object} wire 该定义的 wire 投影（仅在探针未命中时才需要其 digest）
   */
  function bindingGenerationFor(scopeKey, toolId, definition, wire) {
    const key = bindingKey(scopeKey, toolId);
    const prev = bindingState.get(key);
    let probe;
    try {
      probe = JSON.stringify([definition.name, definition.description, definition.parameters]);
    } catch {
      probe = undefined; // 循环引用等病态形状 → 视为已变化，交给 canonical 路径报错
    }
    const reusable = prev !== undefined && prev.definition === definition
      && probe !== undefined && prev.probe === probe;
    const digest = reusable ? prev.digest : digestOf(wire);
    const changed = prev === undefined
      || prev.definition !== definition
      || prev.digest !== digest;
    const gen = changed ? (prev?.gen ?? 0) + 1 : prev.gen;
    bindingState.set(key, { gen, definition, digest, probe });
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

  /**
   * 会话释放：删除该 scope 的全部跨会话字典条目（generations / lastSeen / bindingState）。
   *
   * 为什么**不**沿用 retireAbsent 的"留键清值"：那是给**还活着**的 scope 用的 ——
   * 缺席绑定的代次计数必须保留（重加时从旧值 +1，不得复用旧代次），所以键不能删。
   * 而 scope 本身随会话释放后，这些键不再有任何读者（同一 agent scope id 不会
   * 复活成需要延续代次语义的会话），留着就是纯泄漏。唯一调用点是 lifecycle 的
   * disposeSession。global 键（scope 为 undefined）不由本方法负责 —— 会话释放
   * 永远带着自己的 agent scope。
   * @param {any} scope agent scope
   */
  function disposeScope(scope) {
    const scopeKey = scopeKeyOf(scope);
    generations.delete(scopeKey);
    lastSeen.delete(scopeKey);
    const prefix = `${scopeKey}\u0000`;
    for (const key of [...bindingState.keys()]) {
      if (key.startsWith(prefix)) bindingState.delete(key);
    }
    log('registry:scope-disposed', { scopeKey });
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
      const bindingGeneration = bindingGenerationFor(scopeKey, toolId, definition, wire);
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
    bindingsFor,
    remember,
    bumpGeneration,
    diffAgainst,
    disposeScope,
    findEntryConflicts,
    /** 当前 scope 下按名称解析的 toolId（guard/projection 只读）。 */
    toolIdFor(scope, name) {
      return this.bindingsFor(scope).toolIdsByName.get(name) ?? null;
    },
    /** 组合内的 wire 摘要（报告取证用）。 */
    digestOfWire: digestOf,
  };
}
