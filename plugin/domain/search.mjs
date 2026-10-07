// plugin/domain/search.mjs
// 双语 tokenizer、token 集合与可解释排序。
// 约束:
// - 自然无关查询返回 [] ,不凑 K(01 §5.3 / F06);
// - category 是查询约束,不是授权条件;
// - 稳定顺序:score desc, name asc, toolId asc;
// - description / skill 文本只作低权重资料,不影响分类与权限;
// - 索引按 searchDocumentId 共享内容,资格域由调用方的 catalog 决定。
import { MATCH_REASONS, SIGNAL_WEIGHTS, SYNONYM_INDEX } from './constants.mjs';
import { SUPPORTED_LOCALES, createText } from './locale.mjs';

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
 * 同义词触发词的预编译匹配器(模块加载时只建一次)。
 *
 * - CJK 触发词没有词边界,保持子串匹配;
 * - 拉丁触发词按**词边界**匹配,并允许常见屈折后缀(s/es/ed/d/ing)。
 *   此前一律 `includes`:'cli' 会命中 "click"/"client"、'edit' 命中 "credit"、
 *   'word' 命中 "keyword"、'unit' 命中 "community"、'prs' 命中 "express",
 *   查询与条目文档都会被这类误命中带到无关的受控概念上。
 * @type {ReadonlyArray<{concept: string, cjk: boolean, needle: string, re: RegExp|null}>}
 */
const SYNONYM_MATCHERS = Object.freeze(Object.entries(SYNONYM_INDEX).map(([trigger, concept]) => {
  const lowered = trigger.toLowerCase();
  if (CJK.test(lowered)) return { concept, cjk: true, needle: lowered, re: null };
  const words = (lowered.match(LATIN_TOKEN) ?? []).join(' ');
  return { concept, cjk: false, needle: words, re: new RegExp(` ${words}(?:s|es|ed|d|ing)? `, 'u') };
}));

/**
 * 查询侧同义词扩展:受控词表把用户词映射到受控概念。
 * @param {string} text
 * @returns {Set<string>}
 */
export function synonymConcepts(text) {
  /** @type {Set<string>} */
  const concepts = new Set();
  const raw = String(text ?? '');
  const lowered = raw.toLowerCase();
  // 拉丁侧:驼峰先拆开,再抽出 [a-z0-9] 词,用空格连接并首尾补空格,供词边界匹配
  const latin = ` ${(raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(LATIN_TOKEN) ?? []).join(' ')} `;
  for (const m of SYNONYM_MATCHERS) {
    if (concepts.has(m.concept)) continue;
    if (m.cjk ? lowered.includes(m.needle) : m.re.test(latin)) concepts.add(m.concept);
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
 * 类别的双语检索词表,按受控类别 id 记忆化。
 *
 * 为什么要本地化:条目的 category 只有英文受控 id(files/shell/web…),
 * summary 又是宿主的英文工具描述,所以中文查询唯一的桥是同义词表——
 * 查询短语不在受控表里就零命中。locale.mjs 已经备好了每个类别的
 * 本地化标题与能力摘要(zh/en 都有),只是原先只给 tool_list 的类别卡片用。
 *
 * 为什么按 locale 全量并入、而不是"按界面语言取一份":索引在 catalog 刷新时
 * 建一次且不带语言参数,而检索框本身是双语的;索引是语言中立的集合,
 * 而不是"某一个语言下的快照"。
 *
 * 成本:12 个受控类别 × SUPPORTED_LOCALES 条短文本,模块级建一次并缓存,
 * 每次 catalog 刷新只做 Set 合并。
 * @type {Map<string, string[]>}
 */
const CATEGORY_VOCABULARY = new Map();

/**
 * 取某个受控类别的本地化检索词(标题 + 能力摘要,所有支持语言)。
 * @param {string} id 受控类别 id
 * @returns {string[]}
 */
function categoryVocabulary(id) {
  const cached = CATEGORY_VOCABULARY.get(id);
  if (cached !== undefined) return cached;
  /** @type {string[]} */
  const out = [];
  for (const locale of SUPPORTED_LOCALES) {
    const card = createText(locale).category(id);
    if (card === undefined) continue; // 未登记的类别不猜,只留英文 id 的分词
    for (const t of tokenize(card.title)) out.push(t);
    for (const t of tokenize(card.capabilitySummary)) out.push(t);
  }
  CATEGORY_VOCABULARY.set(id, out);
  return out;
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
  for (const c of entry.categories) {
    for (const t of tokenize(c)) categoryTokens.add(t);
    // 本地化标题与能力摘要:让中文查询不必命中英文类别 id 也能落到同一类别。
    for (const t of categoryVocabulary(c)) categoryTokens.add(t);
  }
  /** @type {Set<string>} */
  const summaryTokens = new Set(tokenize(entry.summary));
  /** @type {Set<string>} */
  const skillTokens = new Set();
  if (entry.skill) {
    for (const t of tokenize(entry.skill.usage)) skillTokens.add(t);
    for (const lim of entry.skill.limitations) for (const t of tokenize(lim)) skillTokens.add(t);
  }
  // 条目自身触发哪些受控概念(与查询侧同一个 synonymConcepts:对文档全文做同法匹配)
  const docText = [entry.name, entry.summary, entry.skill ? entry.skill.usage : '', entry.skill ? entry.skill.limitations.join(' ') : ''].join(' ');
  const entryConcepts = synonymConcepts(docText);
  return { nameTokens, categoryTokens, summaryTokens, skillTokens, entryConcepts };
}

/**
 * @typedef {Object} SearchIndex
 * @property {Array<{entry: import('./catalog.mjs').CatalogEntry, doc: ReturnType<typeof documentTokens>}>} items
 */

/**
 * 构建检索索引。
 * @param {ReadonlyArray<import('./catalog.mjs').CatalogEntry>} entries
 * @returns {SearchIndex}
 */
export function buildSearchIndex(entries) {
  const items = entries.map((entry) => ({ entry, doc: documentTokens(entry) }));
  return { items };
}

/**
 * @typedef {Object} SearchHit
 * @property {import('./catalog.mjs').CatalogEntry} entry
 * @property {number} score
 * @property {string[]} reasons
 */

/**
 * 同义词命中在**文档名没有任何有效词命中**时减半计分。
 *
 * 理由:name-token 是按覆盖率缩放的(12 × 命中/总词数),一个名字里真有两
 * 个查询词的文档对 3 词查询只能拿 8 分,再低可到 4 分;而 synonym 是**固定**
 * 8 分、不缩放,于是"命中一个受控概念 + 两条资料字段"会压过"名字就是用户
 * 要的那个工具"的文档——精确查询因此把模型引到错的工具上。
 *
 * 规则一句话:**直接证据(名字)优先,受控同义词只是回退信号**,名字为空时
 * 同义词最多只能拿到 name-token 满覆盖的同量级分数,不能反超。
 * 减半只在"名字零命中"时生效:名字已经命中的文档不受影响,原有排序不变。
 */
function synonymWeight(nameHits) {
  return nameHits > 0 ? SIGNAL_WEIGHTS[MATCH_REASONS.SYNONYM] : SIGNAL_WEIGHTS[MATCH_REASONS.SYNONYM] / 2;
}

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
    //    没有有效词时不得凭停用词子串碰巧命中同义词;
    //    名字零命中时减半,让直接名字证据优先——见 synonymWeight)
    if (hasEffectiveTerm && qConcepts.size > 0) {
      for (const c of qConcepts) {
        if (doc.entryConcepts.has(c)) {
          score += synonymWeight(nameHits);
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
