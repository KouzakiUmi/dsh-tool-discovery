// plugin/domain/catalog.mjs
// schema 身份、版本与不可变目录快照。
// 不依赖宿主:schema 身份由"有效 wire 字段"的无损 canonical JSON 完全重算。
import { classifyBinding } from './categories.mjs';
import { canonicalJson, deepFreeze, deepEqualCanonical, digestOf, sha256Hex, utf8Bytes } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject, sortBy } from './util.mjs';

// --- i18n shim (added by the message migration) ---------------------------
// These validators are pure and take no locale argument. The plugin resolves
// one locale per activation, so bind the text accessor once here rather than
// threading it through every signature. setLocaleForDomain() is called by the
// adapter at activation; tests call it directly to exercise both languages.
import { domainText } from './locale.mjs';
const text = domainText;
const t = (path) => text.t(path);


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
  if (!isPlainObject(b)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingNotObject']));
  if (!isNonEmptyString(b.toolId)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingMissingToolId']));
  if (!isNonEmptyString(b.name)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingMissingName']));
  if (typeof b.description !== 'string') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingDescriptionNotString']));
  }
  if (!isPlainObject(b.wire)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingMissingWire']));
  if (b.wire.name !== b.name) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingWireNameMismatch']));
  }
  if ('parameters' in b.wire && !isPlainObject(b.wire.parameters)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingWireParametersNotObject']));
  }
  if ('description' in b.wire && typeof b.wire.description !== 'string') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingWireDescriptionNotString']));
  }
  for (const key of ['providerNamespace', 'bindingGeneration', 'shadowOf', 'trustedCategoryOverride']) {
    if (key in b && b[key] !== null && typeof b[key] !== 'string') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', text.format(['detail', 'bindingFieldNotStringOrNull'], { key }));
    }
  }
  if ('skill' in b && b.skill !== null) {
    const s = b.skill;
    if (!isPlainObject(s)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'skillNotObject']));
    if (!isNonEmptyString(s.skillRevision)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'skillMissingRevision']));
    if (!isNonEmptyString(s.usage)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'skillMissingUsage']));
    if (!Array.isArray(s.limitations) || s.limitations.some((x) => typeof x !== 'string')) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'skillLimitationsNotArray']));
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
  return entryFromPrepared(prepareBinding(b));
}

/**
 * 校验 + 规范化 + 单次 canonical 化的绑定记录（prepareCatalog 的内部产物）。
 * wire 只序列化这一次：schemaDigest / wireBytes / 深复制 / 身份指纹全部从这
 * 同一份 canonical 文本派生，buildEntry / identityFingerprintOf / buildCatalog
 * 不再各自重算。
 * @typedef {Object} PreparedBinding
 * @property {CatalogBindingDTO} binding 已 validate 的原绑定
 * @property {string} wireJson canonical 化的 wire 文本
 * @property {string} schemaDigest wire 的 canonical 摘要（即指纹里的 wireDigest）
 * @property {string} revision
 * @property {string[]} categories
 * @property {string} skillRevision
 * @property {string} skillText
 * @property {string} searchDocumentId
 */

/**
 * 单条绑定的规范化：canonical 化 wire 一次，派生全部身份字段。
 * @param {CatalogBindingDTO} b 已 validate
 * @returns {PreparedBinding}
 */
function prepareBinding(b) {
  const wireJson = canonicalJson(b.wire);
  const schemaDigest = `sha256:${sha256Hex(wireJson)}`;
  const skillRevision = b.skill ? b.skill.skillRevision : 'none';
  // revision 同时覆盖 wire 身份、技能版本与可证明的注册绑定代次。
  const revision = `r_${digestOf({ schemaDigest, skillRevision, bindingGeneration: b.bindingGeneration ?? null })}`;
  const categories = classifyBinding(b);
  const skillText = b.skill ? `${b.skill.usage} ${b.skill.limitations.join(' ')}` : '';
  const searchDocumentId = `d_${digestOf({
    name: b.name,
    categories,
    summary: b.description,
    skillText,
  })}`;
  return { binding: b, wireJson, schemaDigest, revision, categories, skillRevision, skillText, searchDocumentId };
}

/**
 * 由已规范化的记录构造目录条目（不再做校验与序列化）。
 * @param {PreparedBinding} rec
 * @returns {CatalogEntry}
 */
function entryFromPrepared(rec) {
  const b = rec.binding;
  return {
    toolId: b.toolId,
    name: b.name,
    categories: rec.categories,
    summary: b.description,
    schemaDigest: rec.schemaDigest,
    skillRevision: rec.skillRevision,
    revision: rec.revision,
    searchDocumentId: rec.searchDocumentId,
    shadowOf: b.shadowOf ?? null,
    bindingGeneration: b.bindingGeneration ?? null,
    // 冻结的只能是内核自有快照，不能递归冻结 adapter/宿主共享的 parameters；
    // 深复制走身份核算的同一份 canonical 文本（parse → 再序列化是不动点）。
    wire: JSON.parse(rec.wireJson),
    wireBytes: utf8Bytes(rec.wireJson),
    skill: b.skill ? { ...b.skill, limitations: b.skill.limitations.slice() } : null,
  };
}

/**
 * 绑定(或目录条目)的身份指纹。字段口径必须与 buildEntry 派生身份时用的**完全一致**:
 * toolId、name、description、wire、bindingGeneration、技能版本、**派生类别**、**技能正文**。
 * 少一个字段 → 把真实变更误判成"没变"(换 wire 却保留旧 ref 与旧游标);
 * 多一个无关字段 → 把无关的热注册误判成"变了"(白白作废全量 ref 与游标)。
 *
 * 类别与技能正文**必须**在指纹里:categories 决定 `orderDigestByView`(游标有效性),
 * 技能正文决定 `searchDocumentId`。当前 DSH adapter 恒传
 * providerNamespace/trustedCategoryOverride/skill = null,两者都不会变;
 * 但指纹的完整性不能靠"现在恰好不变"来保证 —— 任何未来接线都会立刻踩中这个洞。
 * @param {{toolId:string, name:string, description:string, wire:object, bindingGeneration?:string|null,
 *   skillRevision:string, categories?:readonly string[], skill?:{usage:string, limitations:string[]}|null}} rec
 * @returns {string}
 */
function identityDigest(rec) {
  return digestOf({
    toolId: rec.toolId,
    name: rec.name,
    description: rec.description,
    // wire 以其 canonical 摘要入场（schemaDigest 就是 wire 的身份），指纹阶段
    // 不再把 parameters 整体 canonical 化第二遍 —— wire 全文在 prepare 时只
    // 序列化一次。
    wireDigest: rec.wireDigest ?? rec.schemaDigest,
    shadowOf: rec.shadowOf ?? null,
    bindingGeneration: rec.bindingGeneration ?? null,
    skillRevision: rec.skillRevision,
    // 与 buildEntry 派生 searchDocumentId / orderDigestByView 时用的完全同一份值。
    categories: rec.categories ?? null,
    skillText: rec.skill === undefined || rec.skill === null
      ? (rec.skillText ?? '')
      : `${rec.skill.usage} ${rec.skill.limitations.join(' ')}`,
  });
}

/**
 * 建目录**之前**就能算的绑定集指纹(顺序敏感:同一组绑定换序 → 不同指纹)。
 * engine.refreshCatalog 用它在 buildCatalog / buildSearchIndex 之前判
 * "这次 tools/change 到底有没有改动本 scope 的绑定身份"。
 *
 * 形状异常的绑定(缺 wire、skill 不是对象等)会让本函数抛错;调用方据此退回慢路径,
 * 由 buildCatalog 抛规范错误 —— 本函数**不**替代 validateBinding。
 * @param {any[]} rawBindings
 * @returns {string}
 */
export function identityFingerprintOf(rawBindings) {
  return prepareCatalog(rawBindings).fingerprint;
}

/**
 * 校验 + 规范化全部绑定，返回身份指纹与 prepared 记录。
 * 指纹判同 → 丢弃 prepared（不建目录）；判异 → catalogFromPrepared 直接构建，
 * wire 全文零二次序列化、零二次分类。
 * @param {any[]} rawBindings
 * @returns {{ fingerprint: string, prepared: PreparedBinding[] }}
 */
export function prepareCatalog(rawBindings) {
  if (!Array.isArray(rawBindings)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingsNotArray']));
  const seen = new Set();
  const prepared = [];
  for (const raw of rawBindings) {
    const b = validateBinding(raw);
    if (seen.has(b.toolId)) throw new DomainError('INCOMPATIBLE_COMPOSITION', text.format(['detail', 'duplicateToolId'], { toolId: b.toolId }));
    seen.add(b.toolId);
    prepared.push(prepareBinding(b));
  }
  const fingerprint = digestOf(prepared.map((rec) => identityDigest({
    toolId: rec.binding.toolId,
    name: rec.binding.name,
    description: rec.binding.description,
    wireDigest: rec.schemaDigest,
    shadowOf: rec.binding.shadowOf,
    bindingGeneration: rec.binding.bindingGeneration,
    skillRevision: rec.skillRevision,
    categories: rec.categories,
    skillText: rec.skillText,
  })));
  return { fingerprint, prepared };
}

/**
 * 构造不可变目录快照。条目、映射全部冻结。
 * @param {CatalogBindingDTO[]} rawBindings
 * @param {{ now: number; generation: string; categoryConfig?: Record<string, unknown> }} opts
 * @returns {import('./catalog.mjs').CatalogSnapshot}
 */
export function buildCatalog(rawBindings, opts) {
  return catalogFromPrepared(prepareCatalog(rawBindings).prepared, opts);
}

/**
 * 由 prepared 记录直接构建快照（prepareCatalog 的构建分支，零重复序列化）。
 * @param {PreparedBinding[]} prepared
 * @param {{ now: number; generation: string; categoryConfig?: Record<string, unknown> }} opts
 */
export function catalogFromPrepared(prepared, opts) {
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry>} */
  const entries = new Map();
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry[]>} */
  const byName = new Map();

  for (const rec of prepared) {
    const entry = entryFromPrepared(rec);
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
    // entries 是按 toolId 去重的 Map,每个 toolId 只在这里出现一次;classifyBinding
    // 返回的类别数组也已去重。因此直接 push 即可 —— 先前的 arr.includes(toolId)
    // 线性扫描在 N 个绑定 × M 个类别上是 O(N²·M),且守卫恒为 false。
    for (const c of entry.categories) {
      const arr = categories.get(c);
      if (arr === undefined) categories.set(c, [entry.toolId]);
      else arr.push(entry.toolId);
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
  // available:all:最常用的浏览视图。缺了这一项,category:'all' 的游标会退化成绑定
  // 常量 'empty'(engine 取不到摘要时的兜底),于是任何改动了排序的目录变更都杀不掉它。
  // 摘要按**名称序列**算:翻页项就是名称(同名 shadow 已去重),而不是 toolId 序列。
  // 名称序列在构建期一次性算好（orderedAll）：快照冻结后 orderedNamesFor 直接
  // 复用,不再每次 list 重新展开 + 排序。
  const orderedAll = dedupeNames(entries, Array.from(entries.keys()).sort());
  orderDigestByView.set('available:all', digestOf(orderedAll));
  orderDigestByView.set('categories:all', digestOf(Array.from(categories.keys()).sort()));

  const snapshot = {
    generation: opts.generation,
    builtAt: opts.now,
    entries,
    byName,
    categories,
    orderDigestByView,
    orderedAll,
    // 快照自身的身份指纹,与 identityFingerprintOf 同一口径 —— refreshCatalog
    // 拿它和新绑定集比,决定是否真的需要重建。
    identityFingerprint: digestOf(Array.from(entries.values(), (e) => identityDigest({
      toolId: e.toolId,
      name: e.name,
      description: e.summary,
      wireDigest: e.schemaDigest,
      shadowOf: e.shadowOf,
      bindingGeneration: e.bindingGeneration,
      skillRevision: e.skillRevision,
      categories: e.categories,
      skill: e.skill,
    }))),
  };
  return deepFreeze(snapshot);
}

/** 按 toolId 序列投影成去重后的名称序列（同名 shadow 只留先到的名字）。 */
function dedupeNames(entries, ids) {
  const seen = new Set();
  const names = [];
  for (const id of ids) {
    const e = /** @type {import('./catalog.mjs').CatalogEntry} */ (entries.get(id));
    if (!e || seen.has(e.name)) continue;
    seen.add(e.name);
    names.push(e.name);
  }
  names.sort();
  return names;
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
    throw new DomainError('TOOL_UNAVAILABLE', t(['detail', 'ambiguousName']), {
      ambiguousToolIds: arr.map((e) => e.toolId),
    });
  }
  return arr[0];
}

/**
 * 计算某视图在某类别下的稳定名称序列(供 list 与 orderDigest 使用)。
 * 同名多绑定(shadow)只留一个名称,并按名称排序 —— engine.handleList 的 available
 * 视图直接用它产出分页项,因此顺序摘要与实际翻页顺序天然同源。
 * @param {import('./catalog.mjs').CatalogSnapshot} snapshot
 * @param {string} category 'all' 或受控类别
 * @returns {string[]}
 */
export function orderedNamesFor(snapshot, category) {
  // 'all' 的名称序列在快照构建期已算好并冻结;数组被深冻结,直接返回安全。
  if (category === 'all' && Array.isArray(snapshot.orderedAll)) return snapshot.orderedAll;
  return dedupeNames(snapshot.entries, category === 'all'
    ? Array.from(snapshot.entries.keys()).sort()
    : (snapshot.categories.get(category) || []));
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

/** re-export,便于调用方只从 catalog 引入比较原语。 */
export { deepEqualCanonical };
