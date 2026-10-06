// progressive-v2/domain/search.mjs
// 双语 tokenizer、倒排与可解释排序。
// 约束:
// - 自然无关查询返回 [] ,不凑 K(01 §5.3 / F06);
// - category 是查询约束,不是授权条件;
// - 稳定顺序:score desc, name asc, toolId asc;
// - description / skill 文本只作低权重资料,不影响分类与权限;
// - 索引按 searchDocumentId 共享内容,资格域由调用方的 catalog 决定。
import { MATCH_REASONS, SIGNAL_WEIGHTS, SYNONYM_INDEX } from './constants.mjs';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const LATIN_TOKEN = /[a-z0-9]+/gu;

/**
 * 双语 tokenizer:中文 unigram + bigram;英文小写化 + 轻量词形归一 + 分隔符拆分。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const input = String(text ?? '');
  /** @type {string[]} */
  const out = [];
  // 先抽出 CJK 连续段,生成 unigram 与相邻 bigram
  const segments = input.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu) || [];
  for (const seg of segments) {
    const cps = Array.from(seg);
    for (const cp of cps) out.push(cp);
    for (let i = 0; i + 1 < cps.length; i++) out.push(cps[i] + cps[i + 1]);
  }
  // 再抽出拉丁/数字 token(含驼峰边界)
  const latinInput = input.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const m of latinInput.matchAll(LATIN_TOKEN)) {
    const token = m[0];
    out.push(token);
    for (const form of stemForms(token)) if (form !== token) out.push(form);
  }
  return out;
}

/**
 * 轻量英文词形归一(保守,只做可逆-ish 的常见后缀剥离)。
 * @param {string} token
 * @returns {string[]}
 */
function stemForms(token) {
  /** @type {string[]} */
  const forms = [];
  // 多个后缀规则独立生效(如 'files' 同时得到 'file' 与 'fil' 的近形),
  // 不用 else-if,避免 'es' 分支吞掉 's' 分支。
  if (token.length > 4 && token.endsWith('ing')) forms.push(token.slice(0, -3));
  if (token.length > 4 && token.endsWith('ed')) forms.push(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('es')) forms.push(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) forms.push(token.slice(0, -1));
  return forms;
}

/**
 * 查询侧同义词扩展:受控词表把用户词映射到受控概念。
 * @param {string} text
 * @returns {Set<string>}
 */
export function synonymConcepts(text) {
  /** @type {Set<string>} */
  const concepts = new Set();
  const lowered = String(text ?? '').toLowerCase();
  for (const [trigger, concept] of Object.entries(SYNONYM_INDEX)) {
    const t = trigger.toLowerCase();
    if (lowered.includes(t)) concepts.add(concept);
  }
  return concepts;
}

/**
 * 为条目构建检索文档的 token 集合。
 * @param {import('./catalog.mjs').CatalogEntry} entry
 */
export function documentTokens(entry) {
  /** @type {Set<string>} */
  const nameTokens = new Set(tokenize(entry.name));
  /** @type {Set<string>} */
  const categoryTokens = new Set();
  for (const c of entry.categories) for (const t of tokenize(c)) categoryTokens.add(t);
  /** @type {Set<string>} */
  const summaryTokens = new Set(tokenize(entry.summary));
  /** @type {Set<string>} */
  const skillTokens = new Set();
  if (entry.skill) {
    for (const t of tokenize(entry.skill.usage)) skillTokens.add(t);
    for (const lim of entry.skill.limitations) for (const t of tokenize(lim)) skillTokens.add(t);
  }
  // 条目自身触发哪些受控概念(与查询侧同法:对文档全文做受控短语子串匹配)
  const docText = [entry.name, entry.summary, entry.skill ? entry.skill.usage : '', entry.skill ? entry.skill.limitations.join(' ') : ''].join(' ');
  const entryConcepts = synonymConcepts(docText);
  return { nameTokens, categoryTokens, summaryTokens, skillTokens, entryConcepts };
}

/**
 * @typedef {Object} SearchIndex
 * @property {Array<{entry: import('./catalog.mjs').CatalogEntry, doc: ReturnType<typeof documentTokens>}>} items
 * @property {Map<string, Array<number>>} postings token → items 下标倒排
 */

/**
 * 构建倒排索引。同 searchDocumentId 的条目共享内容(这里用 doc 去重后建 postings)。
 * @param {ReadonlyArray<import('./catalog.mjs').CatalogEntry>} entries
 * @returns {SearchIndex}
 */
export function buildSearchIndex(entries) {
  const items = entries.map((entry) => ({ entry, doc: documentTokens(entry) }));
  /** @type {Map<string, number[]>} */
  const postings = new Map();
  items.forEach((item, idx) => {
    const all = new Set([
      ...item.doc.nameTokens,
      ...item.doc.categoryTokens,
      ...item.doc.summaryTokens,
      ...item.doc.skillTokens,
    ]);
    for (const t of all) {
      const arr = postings.get(t) || [];
      if (!arr.includes(idx)) arr.push(idx);
      postings.set(t, arr);
    }
  });
  return { items, postings };
}

/**
 * @typedef {Object} SearchHit
 * @property {import('./catalog.mjs').CatalogEntry} entry
 * @property {number} score
 * @property {string[]} reasons
 */

/**
 * 有界检索。返回 score>0 的命中,按稳定顺序取前 limit。
 * @param {SearchIndex} index
 * @param {{ query: string; category: string; limit: number }} args
 * @returns {SearchHit[]}
 */
export function search(index, args) {
  const { query, category, limit } = args;
  const qTokens = new Set(tokenize(query));
  const qConcepts = synonymConcepts(query);
  const normalizedQuery = String(query ?? '').trim().toLowerCase();

  /** @type {Map<number, { score: number; reasons: Set<string> }>} */
  const scores = new Map();

  for (let idx = 0; idx < index.items.length; idx++) {
    const { entry, doc } = /** @type {any} */ (index.items[idx]);
    // category 是查询约束(不是授权):非 all 时只在该类别内打分
    if (category !== 'all' && !entry.categories.includes(category)) continue;

    let score = 0;
    /** @type {Set<string>} */
    const reasons = new Set();

    // 1) 精确名称
    if (normalizedQuery && entry.name.toLowerCase() === normalizedQuery) {
      score += SIGNAL_WEIGHTS[MATCH_REASONS.EXACT_NAME];
      reasons.add(MATCH_REASONS.EXACT_NAME);
    }

    // 2) 名称 token
    for (const t of qTokens) {
      if (doc.nameTokens.has(t)) {
        score += SIGNAL_WEIGHTS[MATCH_REASONS.NAME_TOKEN];
        reasons.add(MATCH_REASONS.NAME_TOKEN);
        break;
      }
    }

    // 3) 同义词概念(受控词表)
    if (qConcepts.size > 0) {
      for (const c of qConcepts) {
        if (doc.entryConcepts.has(c)) {
          score += SIGNAL_WEIGHTS[MATCH_REASONS.SYNONYM];
          reasons.add(MATCH_REASONS.SYNONYM);
          break;
        }
      }
    }

    // 4) 类别 token(仅当查询词命中条目所属类别的名字/同义词)
    for (const t of qTokens) {
      if (doc.categoryTokens.has(t)) {
        score += SIGNAL_WEIGHTS[MATCH_REASONS.CATEGORY_TOKEN];
        reasons.add(MATCH_REASONS.CATEGORY_TOKEN);
        break;
      }
    }

    // 5) 摘要 token(低权重资料)
    for (const t of qTokens) {
      if (doc.summaryTokens.has(t)) {
        score += SIGNAL_WEIGHTS[MATCH_REASONS.SUMMARY_TOKEN];
        reasons.add(MATCH_REASONS.SUMMARY_TOKEN);
        break;
      }
    }

    // 6) 技能 token(最低权重)
    for (const t of qTokens) {
      if (doc.skillTokens.has(t)) {
        score += SIGNAL_WEIGHTS[MATCH_REASONS.SKILL_TOKEN];
        reasons.add(MATCH_REASONS.SKILL_TOKEN);
        break;
      }
    }

    if (score > 0) scores.set(idx, { score, reasons });
  }

  const hits = Array.from(scores.entries()).map(([idx, s]) => ({
    entry: /** @type {any} */ (index.items[idx]).entry,
    score: s.score,
    reasons: Array.from(s.reasons).sort(),
  }));

  // 稳定顺序:score desc, name asc, toolId asc
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.name !== b.entry.name) return a.entry.name < b.entry.name ? -1 : 1;
    return a.entry.toolId < b.entry.toolId ? -1 : a.entry.toolId > b.entry.toolId ? 1 : 0;
  });

  // 不凑 K:只返回真实命中,并按 limit 截断(不因数量不足而填充低分项)
  return hits.slice(0, limit);
}
