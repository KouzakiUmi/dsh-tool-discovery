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
 * 查询侧停用词：只由功能词/礼貌词构成的查询不表达任何检索意图,必须返回 []。
 * 只收英文功能词,不收领域词(file/path/search/list/read...),中文由 unigram+bigram
 * 天然承担同样的去噪作用,不在此硬编码。
 */
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'there', 'here',
  'to', 'of', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'into', 'onto',
  'and', 'or', 'but', 'if', 'then', 'than', 'as', 'so',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'please', 'pls', 'want', 'wanna', 'need', 'like', 'know', 'help', 'lets',
  'some', 'any', 'all', 'about', 'just', 'very', 'much', 'many', 'more', 'most', 'other', 'another',
  'not', 'no', 'yes', 'up', 'out', 'over', 'under', 'again', 'also', 'only',
]);

/**
 * 分词基元:中文 unigram + bigram,英文小写化后的原始词(不含词形派生)。
 * 停用词必须在这一层判定,否则 'lets'→'let'、'does'→'do'/'doe' 这类
 * 派生形会把已丢弃的停用词重新带回覆盖计算。
 * @param {string} text
 * @returns {string[]}
 */
function baseTokens(text) {
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
  for (const m of latinInput.matchAll(LATIN_TOKEN)) out.push(m[0]);
  return out;
}

/**
 * 双语 tokenizer:中文 unigram + bigram;英文小写化 + 轻量词形归一 + 分隔符拆分。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  /** @type {string[]} */
  const out = [];
  for (const token of baseTokens(text)) {
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
 * 查询有效词分组:停用词在基元层整词丢弃(连同其词形派生),
 * 其余词的词形变体归为一组,保证"一个词只算一次覆盖",覆盖比例才可比。
 * @param {string} query
 * @returns {Array<Set<string>>}
 */
function queryTermGroups(query) {
  /** @type {Array<Set<string>>} */
  const groups = [];
  for (const token of baseTokens(query)) {
    if (QUERY_STOPWORDS.has(token)) continue;
    const seen = groups.find((g) => g.has(token));
    if (seen) {
      for (const form of stemForms(token)) seen.add(form);
      continue;
    }
    const group = new Set([token]);
    for (const form of stemForms(token)) group.add(form);
    groups.push(group);
  }
  return groups;
}

/**
 * 统计文档某字段命中了多少个有效词分组。
 * @param {Array<Set<string>>} groups
 * @param {Set<string>} fieldTokens
 * @returns {number}
 */
function matchCount(groups, fieldTokens) {
  let n = 0;
  for (const g of groups) {
    for (const v of g) {
      if (fieldTokens.has(v)) { n += 1; break; }
    }
  }
  return n;
}

/**
 * 字段贡献 = 固定权重 × 该字段的有效词覆盖率。
 * 覆盖一个词的宽泛文档(如正文里带 "file" 的 read_file)因此不会因为
 * "每字段固定分"而压过逐词描述目的的精确工具;未命中字段计 0。
 * 理由标签集合不变:命中即仍是同一个受控 matchReasons。
 * @param {string} reason
 * @param {number} matched
 * @param {number} total
 */
function fieldScore(reason, matched, total) {
  if (matched <= 0 || total <= 0) return 0;
  return SIGNAL_WEIGHTS[reason] * (matched / total);
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
  const qGroups = queryTermGroups(query);
  const qConcepts = synonymConcepts(query);
  const normalizedQuery = String(query ?? '').trim().toLowerCase();
  // 没有有效词时(查询全是停用词)不返回命中,避免"只命中 please/to/the"的
  // 无关结果;但不提前 return,精确名称匹配仍然生效。
  const hasEffectiveTerm = qGroups.length > 0;

  /** @type {Map<number, { score: number; reasons: Set<string> }>} */
  const scores = new Map();

  for (let idx = 0; idx < index.items.length; idx++) {
    const { entry, doc } = /** @type {any} */ (index.items[idx]);
    // category 是查询约束(不是授权):非 all 时只在该类别内打分
    if (category !== 'all' && !entry.categories.includes(category)) continue;

    let score = 0;
    /** @type {Set<string>} */
    const reasons = new Set();

    // 1) 精确名称(固定满分,恒居首位)
    if (normalizedQuery && entry.name.toLowerCase() === normalizedQuery) {
      score += SIGNAL_WEIGHTS[MATCH_REASONS.EXACT_NAME];
      reasons.add(MATCH_REASONS.EXACT_NAME);
    }

    // 2) 名称 token(按有效词覆盖率缩放)
    const nameHits = matchCount(qGroups, doc.nameTokens);
    if (nameHits > 0) {
      score += fieldScore(MATCH_REASONS.NAME_TOKEN, nameHits, qGroups.length);
      reasons.add(MATCH_REASONS.NAME_TOKEN);
    }

    // 3) 同义词概念(受控词表,命中即为完整概念信号,不按覆盖率缩放;
    //    没有有效词时不得凭停用词子串碰巧命中同义词)
    if (hasEffectiveTerm && qConcepts.size > 0) {
      for (const c of qConcepts) {
        if (doc.entryConcepts.has(c)) {
          score += SIGNAL_WEIGHTS[MATCH_REASONS.SYNONYM];
          reasons.add(MATCH_REASONS.SYNONYM);
          break;
        }
      }
    }

    // 4) 类别 token(仅当查询有效词命中条目所属类别的名字/同义词)
    const categoryHits = matchCount(qGroups, doc.categoryTokens);
    if (categoryHits > 0) {
      score += fieldScore(MATCH_REASONS.CATEGORY_TOKEN, categoryHits, qGroups.length);
      reasons.add(MATCH_REASONS.CATEGORY_TOKEN);
    }

    // 5) 摘要 token(低权重资料)
    const summaryHits = matchCount(qGroups, doc.summaryTokens);
    if (summaryHits > 0) {
      score += fieldScore(MATCH_REASONS.SUMMARY_TOKEN, summaryHits, qGroups.length);
      reasons.add(MATCH_REASONS.SUMMARY_TOKEN);
    }

    // 6) 技能 token(最低权重)
    const skillHits = matchCount(qGroups, doc.skillTokens);
    if (skillHits > 0) {
      score += fieldScore(MATCH_REASONS.SKILL_TOKEN, skillHits, qGroups.length);
      reasons.add(MATCH_REASONS.SKILL_TOKEN);
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
