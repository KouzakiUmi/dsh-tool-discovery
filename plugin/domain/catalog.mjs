// progressive-v2/domain/catalog.mjs
// schema 身份、版本与不可变目录快照。
// 不依赖宿主:schema 身份由"有效 wire 字段"的无损 canonical JSON 完全重算。
import { classifyBinding } from './categories.mjs';
import { canonicalJson, deepFreeze, deepEqualCanonical, digestOf, utf8Bytes } from './canonical.mjs';
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
  // 只浅拷贝一层:wire.parameters(以及任何嵌套对象)仍与调用方共享引用。
  // 快照的不可变性靠 digest 口径(canonical JSON)而非深拷贝保证 —— 摘要与比较
  // 都按内容算,共享引用不影响 identity;代价是调用方**不得**在 buildCatalog
  // 之后改写原 wire 对象。
  const wire = { ...b.wire };
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
    wireBytes: utf8Bytes(canonicalJson(wire)),
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
    wire: rec.wire,
    bindingGeneration: rec.bindingGeneration ?? null,
    skillRevision: rec.skillRevision,
    // 与 buildEntry 派生 searchDocumentId / orderDigestByView 时用的完全同一份值。
    categories: rec.categories ?? null,
    skillText: rec.skill === undefined || rec.skill === null
      ? ''
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
  return digestOf(rawBindings.map((b) => identityDigest({
    toolId: b.toolId,
    name: b.name,
    description: b.description,
    wire: b.wire,
    bindingGeneration: b.bindingGeneration,
    skillRevision: b.skill ? b.skill.skillRevision : 'none',
    // 与 buildEntry 同一个口径:category 与 skill 都是派生态。
    categories: classifyBinding(b),
    skill: b.skill,
  })));
}

/**
 * 构造不可变目录快照。条目、映射全部冻结。
 * @param {CatalogBindingDTO[]} rawBindings
 * @param {{ now: number; generation: string; categoryConfig?: Record<string, unknown> }} opts
 * @returns {import('./catalog.mjs').CatalogSnapshot}
 */
export function buildCatalog(rawBindings, opts) {
  if (!Array.isArray(rawBindings)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'bindingsNotArray']));
  const seen = new Set();
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry>} */
  const entries = new Map();
  /** @type {Map<string, import('./catalog.mjs').CatalogEntry[]>} */
  const byName = new Map();

  for (const raw of rawBindings) {
    const b = validateBinding(raw);
    if (seen.has(b.toolId)) throw new DomainError('INCOMPATIBLE_COMPOSITION', text.format(['detail', 'duplicateToolId'], { toolId: b.toolId }));
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
  orderDigestByView.set('available:all', digestOf(orderedNamesFor(
    /** @type {any} */ ({ entries, categories }),
    'all',
  )));
  orderDigestByView.set('categories:all', digestOf(Array.from(categories.keys()).sort()));

  const snapshot = {
    generation: opts.generation,
    builtAt: opts.now,
    entries,
    byName,
    categories,
    orderDigestByView,
    // 快照自身的身份指纹,与 identityFingerprintOf 同一口径 —— refreshCatalog
    // 拿它和新绑定集比,决定是否真的需要重建。
    identityFingerprint: digestOf(Array.from(entries.values(), (e) => identityDigest({
      toolId: e.toolId,
      name: e.name,
      description: e.summary,
      wire: e.wire,
      bindingGeneration: e.bindingGeneration,
      skillRevision: e.skillRevision,
      categories: e.categories,
      skill: e.skill,
    }))),
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
  const ids = category === 'all'
    ? Array.from(snapshot.entries.keys()).sort()
    : (snapshot.categories.get(category) || []);
  const seen = new Set();
  /** @type {string[]} */
  const names = [];
  for (const id of ids) {
    const e = /** @type {import('./catalog.mjs').CatalogEntry} */ (snapshot.entries.get(id));
    if (!e || seen.has(e.name)) continue;
    seen.add(e.name);
    names.push(e.name);
  }
  names.sort();
  return names;
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
