// progressive-v2/domain/catalog.mjs
// schema 身份、版本与不可变目录快照。
// 不依赖宿主:schema 身份由"有效 wire 字段"的无损 canonical JSON 完全重算。
import { classifyBinding } from './categories.mjs';
import { deepFreeze, deepEqualCanonical, digestOf, utf8Bytes } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject, sortBy } from './util.mjs';

/**
 * @typedef {Object} CatalogBindingDTO
 * @property {string} toolId
 * @property {string} name
 * @property {string} description
 * @property {{name:string, description?:string, parameters?:object}} wire
 * @property {string|null} [providerNamespace]
 * @property {string|null} [bindingGeneration]
 * @property {string|null} [shadowOf]
 * @property {string|null} [trustedCategoryOverride]
 * @property {{skillRevision:string, usage:string, limitations:string[]}|null} [skill]
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} toolId
 * @property {string} name
 * @property {string[]} categories
 * @property {string} summary
 * @property {string} schemaDigest
 * @property {string} skillRevision
 * @property {string} revision
 * @property {string} searchDocumentId
 * @property {string|null} shadowOf
 * @property {string|null} bindingGeneration
 * @property {{name:string, description?:string, parameters?:object}} wire
 * @property {number} wireBytes
 * @property {{skillRevision:string, usage:string, limitations:string[]}|null} skill
 */

/**
 * 校验并规范化 adapter 传入的绑定。名称/ID 绝不截断或改写。
 * @param {CatalogBindingDTO} b
 * @returns {CatalogBindingDTO}
 */
export function validateBinding(b) {
  if (!isPlainObject(b)) throw new DomainError('INCOMPATIBLE_COMPOSITION', '绑定不是对象。');
  if (!isNonEmptyString(b.toolId)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'toolId 缺失。');
  if (!isNonEmptyString(b.name)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'name 缺失。');
  if (typeof b.description !== 'string') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'description 必须是字符串。');
  }
  if (!isPlainObject(b.wire)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'wire 缺失。');
  if (b.wire.name !== b.name) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'wire.name 与绑定名称不一致。');
  }
  if ('parameters' in b.wire && !isPlainObject(b.wire.parameters)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'wire.parameters 必须是对象。');
  }
  if ('description' in b.wire && typeof b.wire.description !== 'string') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'wire.description 必须是字符串。');
  }
  for (const key of ['providerNamespace', 'bindingGeneration', 'shadowOf', 'trustedCategoryOverride']) {
    if (key in b && b[key] !== null && typeof b[key] !== 'string') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `${key} 必须是字符串或 null。`);
    }
  }
  if ('skill' in b && b.skill !== null) {
    const s = b.skill;
    if (!isPlainObject(s)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'skill 必须是对象或 null。');
    if (!isNonEmptyString(s.skillRevision)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'skillRevision 缺失。');
    if (!isNonEmptyString(s.usage)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'skill usage 缺失。');
    if (!Array.isArray(s.limitations) || s.limitations.some((x) => typeof x !== 'string')) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'skill limitations 必须是字符串数组。');
    }
  }
  return {
    toolId: b.toolId,
    name: b.name,
    description: b.description,
    wire: { ...b.wire },
    providerNamespace: b.providerNamespace ?? null,
    bindingGeneration: b.bindingGeneration ?? null,
    shadowOf: b.shadowOf ?? null,
    trustedCategoryOverride: b.trustedCategoryOverride ?? null,
    skill: b.skill ?? null,
  };
}

/**
 * 由绑定构造不可变目录条目。
 * @param {CatalogBindingDTO} b 已 validate
 * @returns {CatalogEntry}
 */
export function buildEntry(b) {
  const wire = { ...b.wire };
  if ('parameters' in wire) wire.parameters = b.wire.parameters;
  const schemaDigest = digestOf(wire);
  const skillRevision = b.skill ? b.skill.skillRevision : 'none';
  // revision 同时覆盖 wire 身份、技能版本与可证明的注册绑定代次。
  const revision = `r_${digestOf({ schemaDigest, skillRevision, bindingGeneration: b.bindingGeneration ?? null })}`;
  const categories = classifyBinding(b);
  const summary = b.description;
  const searchDocumentId = `d_${digestOf({
    name: b.name,
    categories,
    summary,
    skillText: b.skill ? `${b.skill.usage} ${b.skill.limitations.join(' ')}` : '',
  })}`;
  return {
    toolId: b.toolId,
    name: b.name,
    categories,
    summary,
    schemaDigest,
    skillRevision,
    revision,
    searchDocumentId,
    shadowOf: b.shadowOf ?? null,
    bindingGeneration: b.bindingGeneration ?? null,
    wire,
    wireBytes: utf8Bytes(JSON.stringify(wire)),
    skill: b.skill ? { ...b.skill, limitations: b.skill.limitations.slice() } : null,
  };
}

/**
 * 构造不可变目录快照。条目、映射全部冻结。
 * @param {CatalogBindingDTO[]} rawBindings
 * @param {{ now: number; generation: string; categoryConfig?: Record<string, unknown> }} opts
 * @returns {import('./catalog.mjs').CatalogSnapshot}
 */
export function buildCatalog(rawBindings, opts) {
  if (!Array.isArray(rawBindings)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'bindings 必须是数组。');
  const seen = new Set();
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry>} */
  const entries = new Map();
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry[]>} */
  const byName = new Map();

  for (const raw of rawBindings) {
    const b = validateBinding(raw);
    if (seen.has(b.toolId)) throw new DomainError('INCOMPATIBLE_COMPOSITION', `重复 toolId: ${b.toolId}`);
    seen.add(b.toolId);
    const entry = buildEntry(b);
    entries.set(entry.toolId, entry);
    const arr = byName.get(entry.name) || [];
    arr.push(entry);
    byName.set(entry.name, arr);
  }

  // 稳定顺序:同名多绑定(shadow)按 toolId 排序
  for (const [name, arr] of byName) byName.set(name, sortBy(arr, (a, z) => (a.toolId < z.toolId ? -1 : a.toolId > z.toolId ? 1 : 0)));

  /** @type {Map<string, string[]>} */
  const categories = new Map();
  for (const entry of entries.values()) {
    for (const c of entry.categories) {
      const arr = categories.get(c) || [];
      if (!arr.includes(entry.toolId)) arr.push(entry.toolId);
      categories.set(c, arr);
    }
  }
  for (const [c, arr] of categories) {
    categories.set(c, sortBy(arr, (a, z) => {
      const ea = /** @type {import('./catalog.mjs').CatalogEntry} */ (entries.get(a));
      const ez = /** @type {import('./catalog.mjs').CatalogEntry} */ (entries.get(z));
      return ea.name < ez.name ? -1 : ea.name > ez.name ? 1 : ea.toolId < ez.toolId ? -1 : ea.toolId > ez.toolId ? 1 : 0;
    }));
  }

  /**
   * 每个 (view, category) 的顺序摘要。游标绑定它:目录/权限变化 → 旧游标失效。
   * @type {Map<string, string>}
   */
  const orderDigestByView = new Map();
  for (const [category, ids] of categories) {
    orderDigestByView.set(`available:${category}`, digestOf(ids));
  }
  orderDigestByView.set('categories:all', digestOf(Array.from(categories.keys()).sort()));

  const snapshot = {
    generation: opts.generation,
    builtAt: opts.now,
    entries,
    byName,
    categories,
    orderDigestByView,
  };
  return deepFreeze(snapshot);
}

/**
 * @param {import('./catalog.mjs').CatalogSnapshot} snapshot
 * @param {string} toolId
 */
export function resolveByToolId(snapshot, toolId) {
  return snapshot.entries.get(toolId) || null;
}

/**
 * 按精确名称解析。0 个 → null;>1(同名 shadow 未消歧)→ 抛错,绝不猜。
 * @param {import('./catalog.mjs').CatalogSnapshot} snapshot
 * @param {string} name
 */
export function resolveByName(snapshot, name) {
  const arr = snapshot.byName.get(name);
  if (!arr || arr.length === 0) return null;
  if (arr.length > 1) {
    // 同名多绑定:必须由 toolId 显式消歧,不静默取第一个。
    throw new DomainError('TOOL_UNAVAILABLE', '该名称在当前范围内存在多个绑定,需按 toolId 明确选择。', {
      ambiguousToolIds: arr.map((e) => e.toolId),
    });
  }
  return arr[0];
}

/**
 * 计算某视图在某类别下的稳定名称序列(供 list 与 orderDigest 使用)。
 * @param {import('./catalog.mjs').CatalogSnapshot} snapshot
 * @param {string} category
 * @returns {string[]}
 */
export function orderedNamesFor(snapshot, category) {
  const ids = snapshot.categories.get(category);
  if (!ids) return [];
  return ids.map((id) => {
    const e = /** @type {import('./catalog.mjs').CatalogEntry} */ (snapshot.entries.get(id));
    return e.name;
  });
}

/**
 * 重新计算某条目的 revision/schemaDigest(用于提交前 recheck 与恢复重算)。
 * @param {import('./catalog.mjs').CatalogEntry} entry
 */
export function recomputeIdentity(entry) {
  const schemaDigest = digestOf(entry.wire);
  const revision = `r_${digestOf({
    schemaDigest,
    skillRevision: entry.skillRevision,
    bindingGeneration: entry.bindingGeneration,
  })}`;
  return { schemaDigest, revision, matches: schemaDigest === entry.schemaDigest && revision === entry.revision };
}

/**
 * 同名不同定义检测(同名热替换)。返回 true 表示当前 scope 内该名称存在多个不同定义。
 * @param {import('./catalog.mjs').CatalogSnapshot} snapshot
 * @param {string} name
 */
export function hasNameConflict(snapshot, name) {
  const arr = snapshot.byName.get(name);
  if (!arr || arr.length < 2) return false;
  const first = arr[0].schemaDigest;
  return arr.some((e) => e.schemaDigest !== first);
}

/** 供测试:两个快照是否在同一顺序摘要上等价。 */
export function sameOrderDigest(snapshot, viewKey, orderDigest) {
  return snapshot.orderDigestByView.get(viewKey) === orderDigest;
}

/** re-export,便于调用方只从 catalog 引入比较原语。 */
export { deepEqualCanonical };
