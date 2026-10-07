// plugin/domain/categories.mjs
// 可信分类与有界导航。
// 分类优先级:可信 override → 受控 namespace 映射 → 结构性确定性规则 → ['other']。
// 关键安全约束:规则只看 name / providerNamespace 的**结构**(前缀、分隔符),
// 绝不读 description(外部不可信文本),更不读任何模型提供的文本。
// 分类只影响可发现性,永远不授予资格或权限。
import { CONTROLLED_CATEGORIES } from './constants.mjs';
import { DomainError } from './errors.mjs';
import { clampCodePoints } from './util.mjs';

/** @type {Readonly<Record<string,string>>} namespace 片段 → 受控类别 */
const NAMESPACE_MAP = Object.freeze({
  files: 'files',
  file: 'files',
  fs: 'files',
  shell: 'shell',
  terminal: 'shell',
  exec: 'shell',
  web: 'web',
  http: 'web',
  fetch: 'web',
  browser: 'browser',
  playwright: 'browser',
  desktop: 'desktop',
  gui: 'desktop',
  github: 'github',
  git: 'github',
  documents: 'documents',
  docs: 'documents',
  docx: 'documents',
  xlsx: 'documents',
  data: 'data',
  agents: 'agents',
  agent: 'agents',
  images: 'images',
  image: 'images',
  integrations: 'integrations',
  mcp: 'integrations',
});

/**
 * 结构性确定性规则。键是名称的命名空间片段,值为该片段映射的类别。
 * 命中即并入 categories(支持多类别)。不命中 → 交给 other。
 * @type {ReadonlyArray<{ segments: readonly string[]; category: string }>}
 */
const NAME_SEGMENT_RULES = Object.freeze([
  { segments: ['glob', 'ls', 'stat', 'read', 'write'], category: 'files' },
  { segments: ['grep', 'search'], category: 'files' },
  { segments: ['edit', 'patch', 'apply'], category: 'files' },
  { segments: ['bash', 'sh', 'cmd', 'command', 'run', 'exec', 'spawn'], category: 'shell' },
  { segments: ['fetch', 'http', 'curl', 'request'], category: 'web' },
  { segments: ['browser', 'page', 'dom', 'locator'], category: 'browser' },
  { segments: ['desktop', 'screen', 'window'], category: 'desktop' },
  { segments: ['github', 'gh', 'pr', 'issue', 'repo'], category: 'github' },
  { segments: ['docx', 'xlsx', 'doc', 'sheet', 'office'], category: 'documents' },
  { segments: ['query', 'sql', 'convert', 'unit', 'csv', 'json'], category: 'data' },
  { segments: ['agent', 'subagent', 'task', 'delegate'], category: 'agents' },
  { segments: ['image', 'img', 'photo', 'picture', 'vision'], category: 'images' },
  { segments: ['mcp', 'integration', 'connector'], category: 'integrations' },
]);

/**
 * @param {string} name
 * @returns {string[]} 小写化后的名称片段(下划线/点/横线/驼峰边界)
 */
export function nameSegments(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * @param {import('./catalog.mjs').CatalogBindingDTO} binding
 * @returns {string[]}
 */
export function classifyBinding(binding) {
  const categories = new Set();
  const override = binding.trustedCategoryOverride;
  if (typeof override === 'string' && CONTROLLED_CATEGORIES.includes(override)) {
    categories.add(override);
  }

  const ns = binding.providerNamespace;
  if (typeof ns === 'string' && ns) {
    for (const seg of nameSegments(ns)) {
      const mapped = NAMESPACE_MAP[seg];
      if (mapped) categories.add(mapped);
    }
  }

  for (const seg of nameSegments(binding.name)) {
    for (const rule of NAME_SEGMENT_RULES) {
      if (rule.segments.includes(seg)) categories.add(rule.category);
    }
  }

  if (categories.size === 0) return ['other'];
  return CONTROLLED_CATEGORIES.filter((c) => categories.has(c));
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [config] 可信类别配置
 */
export function isVisibleCategory(id, config) {
  if (id === 'all') return true;
  if (!CONTROLLED_CATEGORIES.includes(id)) return false;
  if (!config) return true;
  return Object.prototype.hasOwnProperty.call(config, id);
}

/**
 * 有界类别导航卡片。只包含当前 scope 有候选的类别。
 * @param {import('./catalog.mjs').CatalogSnapshot} catalog
 * @param {Record<string, {title:string;capabilitySummary:string}>} config
 * @param {{ limit?: number; maxSummaryCodePoints?: number }} [opts]
 */
export function buildCategoryCards(catalog, config, opts = {}) {
  const maxSummary = opts.maxSummaryCodePoints ?? 96;
  const cards = [];
  for (const id of CONTROLLED_CATEGORIES) {
    const toolIds = catalog.categories.get(id);
    if (!toolIds || toolIds.length === 0) continue;
    const conf = config[id];
    if (!conf) continue; // 未在可信配置中声明的类别不展示
    cards.push({
      id,
      title: String(conf.title),
      capabilitySummary: clampCodePoints(String(conf.capabilitySummary), maxSummary),
      eligibleCount: toolIds.length,
    });
  }
  const limit = opts.limit ?? cards.length;
  return cards.slice(0, limit);
}

/**
 * 解析请求里的 category。不可见/不存在统一 CATEGORY_UNAVAILABLE。
 * @param {string} category
 * @param {import('./catalog.mjs').CatalogSnapshot} catalog
 * @param {Record<string, unknown>} config
 */
export function resolveCategory(category, catalog, config) {
  if (typeof category !== 'string' || category.length === 0) {
    throw new DomainError('CATEGORY_UNAVAILABLE');
  }
  if (category === 'all') return 'all';
  if (!isVisibleCategory(category, config)) throw new DomainError('CATEGORY_UNAVAILABLE');
  const ids = catalog.categories.get(category);
  if (!ids || ids.length === 0) throw new DomainError('CATEGORY_UNAVAILABLE');
  return category;
}
