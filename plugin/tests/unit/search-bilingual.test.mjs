// 双语检索:中文查询能命中正确类别 + 直接名字证据优先于受控同义词。
// 只使用人工单测 fixture;不复制 quality fixtures 的描述当 query,不使用 held-out 数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../../domain/catalog.mjs';
import { buildSearchIndex, search } from '../../domain/search.mjs';
import { MATCH_REASONS } from '../../domain/constants.mjs';
import { setDomainLocale, DEFAULT_LOCALE } from '../../domain/locale.mjs';
import { binding } from './helpers.mjs';

// 人工 fixture:11 个能力条目,覆盖 7 个受控类别。
// summary 一律是**英文**(与真实宿主一致),以便验证中文查询只能靠
// 本地化类别词表与受控同义词桥接。
/** @type {Array<[string, string, string, string]>} */
const BILINGUAL = [
  ['glob', 't_files_glob', 'files', 'enumerate file entries by path pattern'],
  ['grep', 't_files_grep', 'files', 'search text inside file contents'],
  ['read_file', 't_files_read', 'files', 'read a file body'],
  ['edit_file', 't_files_edit', 'files', 'modify a located file region'],
  ['run_shell', 't_shell_run', 'shell', 'execute a shell command'],
  ['web_fetch', 't_web_fetch', 'web', 'fetch a web page over http'],
  ['web_search', 't_web_search', 'web', 'query a web search engine'],
  ['browser_click', 't_browser_click', 'browser', 'click an element on a page'],
  ['desktop_type', 't_desktop_type', 'desktop', 'type text on the desktop'],
  ['xlsx_write', 't_xls_write', 'documents', 'write a spreadsheet'],
  ['view_image', 't_images_view', 'images', 'view an image file'],
];

const bilingualIdx = () => buildSearchIndex(Array.from(buildCatalog(
  BILINGUAL.map(([name, toolId, namespace, description]) =>
    binding({ name, toolId, namespace, description, skill: null })),
  { now: 0, generation: 'gB' }).entries.values()));

/** @param {string} query @param {string} category */
const top = (query, category = 'all') => search(bilingualIdx(), { query, category, limit: 5 });

// --- 缺陷 1:中文查询必须命中,而且命中正确的类别 --------------------------------

test('中文能力描述命中对应类别(不依赖英文受控类别 id)', () => {
  /** @type {Array<[string, string]>} [查询, 期望类别] */
  const cases = [
    ['执行命令', 'shell'],
    ['抓取网页内容', 'web'],
    ['点击网页按钮', 'browser'],
    ['在桌面输入文字', 'desktop'],
    ['写入电子表格', 'documents'],
    ['查看图片内容', 'images'],
    ['列出工作区里的文件路径', 'files'],
    ['读取文件内容', 'files'],
    ['用浏览器搜索搜索引擎', 'web'],
  ];
  for (const [query, category] of cases) {
    const hits = top(query);
    assert.ok(hits.length > 0, `"${query}" 应至少命中一个候选`);
    assert.ok(
      hits[0].entry.categories.includes(category),
      `"${query}" 第一候选应为 ${category},实际 ${hits[0].entry.name}[${hits[0].entry.categories.join('|')}]`,
    );
  }
});

test('中文查询能落到具体工具,不只停在类别', () => {
  /** @type {Array<[string, string]>} [查询, 期望工具名] */
  const cases = [
    ['执行命令', 'run_shell'],
    ['抓取网页内容', 'web_fetch'],
    ['点击网页按钮', 'browser_click'],
    ['在桌面输入文字', 'desktop_type'],
    ['写入电子表格', 'xlsx_write'],
    ['查看图片内容', 'view_image'],
    ['在文件里搜索字符串', 'grep'],
  ];
  for (const [query, name] of cases) {
    assert.equal(top(query)[0].entry.name, name, `"${query}" 第一候选应为 ${name}`);
  }
});

test('category 仍是查询约束:中文查询也不跨类别泄漏', () => {
  const index = bilingualIdx();
  // 条目可能属于多个受控类别(catalog 的启发式如此),因此契约是
  // "返回的每个候选都必须真的属于该类别",而不是"类别互斥"。
  const hits = search(index, { query: '在桌面输入文字', category: 'desktop', limit: 5 });
  assert.ok(hits.length > 0, '相关类别内应命中');
  for (const h of hits) assert.ok(h.entry.categories.includes('desktop'), `${h.entry.name} 不属于 desktop`);
  for (const c of ['shell', 'browser', 'images']) {
    assert.equal(
      search(index, { query: '在桌面输入文字', category: c, limit: 5 }).length, 0,
      `中文查询在 ${c} 内不得返回命中`,
    );
  }
});

// --- 缺陷 2:直接名字证据优先于受控同义词 --------------------------------------

test('名字就是查询词的工具排在只命中受控概念的文档之前', () => {
  // read_file 的名字含 read/file,grep 只能靠 'file contents' 受控触发词 + 资料字段。
  const hits = top('read file contents');
  assert.ok(hits.length > 1);
  assert.equal(hits[0].entry.name, 'read_file', `实际第一: ${hits.map((h) => h.entry.name).join(',')}`);
  const readIdx = hits.findIndex((h) => h.entry.name === 'read_file');
  const grepIdx = hits.findIndex((h) => h.entry.name === 'grep');
  assert.ok(readIdx >= 0 && grepIdx >= 0, '两个文档都应是候选');
  assert.ok(readIdx < grepIdx, '直接名字命中必须排在同义词命中之前');
  assert.ok(hits[readIdx].score > hits[grepIdx].score, '名次不只是并列后的字母序,分数也必须更高');
});

test('只命中受控概念的文档仍带 synonym 理由标签', () => {
  const grep = top('read file contents').find((h) => h.entry.name === 'grep');
  assert.ok(grep, 'grep 应仍是候选');
  assert.ok(grep.reasons.includes(MATCH_REASONS.SYNONYM), '受控概念命中仍必须可解释');
});

test('名字命中时同义词不减半:既有排序不被改动', () => {
  // web_fetch 的名字含 web/fetch,查询 concept 也命中,分数不受减半影响。
  const hits = top('fetch a web page');
  assert.equal(hits[0].entry.name, 'web_fetch');
  assert.ok(hits[0].reasons.includes(MATCH_REASONS.NAME_TOKEN));
  assert.ok(hits[0].reasons.includes(MATCH_REASONS.SYNONYM));
  // 若"名字命中时也减半"被误实现,该候选会掉 4 分(23→19);>20 即可区分。
  assert.ok(hits[0].score > 20, `名字命中时同义词必须保持满权重,实际 ${hits[0].score}`);
});

test('精确名称仍然压倒一切(中英文都算)', () => {
  const hits = top('grep');
  assert.equal(hits[0].entry.name, 'grep');
  assert.ok(hits[0].reasons.includes(MATCH_REASONS.EXACT_NAME));
  assert.ok(hits[0].score > 100, `exact-name 应远超其它信号,实际 ${hits[0].score}`);
});

// --- 契约:零命中、理由受控、确定性、索引语言中立 -------------------------------

test('自然无关的中英文查询都返回零命中(不凑 K)', () => {
  for (const q of ['在火星基地种植玉米', 'quantum blockchain hedging strategy', 'zzz qqq xxx']) {
    assert.equal(top(q).length, 0, `"${q}" 应零命中`);
  }
});

test('只由停用词/寒暄构成的中英文查询不产生命中', () => {
  assert.equal(top('请帮我一下谢谢').length, 0, '中文寒暄查询应零命中');
  assert.equal(top('please to the of and in on for me').length, 0, '英文停用词查询应零命中');
});

test('命中理由始终是受控标签', () => {
  const allowed = new Set(Object.values(MATCH_REASONS));
  for (const q of ['读取文件内容', 'read file contents', '在文件里搜索字符串', '抓取网页内容']) {
    const hits = top(q);
    assert.ok(hits.length > 0, `"${q}" 应有命中`);
    for (const h of hits) {
      assert.ok(h.reasons.length > 0);
      for (const r of h.reasons) assert.ok(allowed.has(r), `非受控理由: ${r}`);
    }
  }
});

test('稳定顺序:score desc,再 name asc,再 toolId asc', () => {
  const a = top('读取文件内容');
  assert.deepEqual(a.map((h) => h.entry.toolId), top('读取文件内容').map((h) => h.entry.toolId), '同输入必须完全一致');
  for (let k = 1; k < a.length; k++) {
    if (a[k - 1].score !== a[k].score) continue;
    const prev = a[k - 1].entry;
    const cur = a[k].entry;
    assert.ok(prev.name < cur.name || (prev.name === cur.name && prev.toolId <= cur.toolId), '同分必须按 name/toolId 升序');
  }
});

test('索引与界面语言无关:同一索引在中英文界面下结果一致', () => {
  // 索引建一次、不带 locale,检索框双语 —— 换界面语言不应改变任何候选。
  const index = bilingualIdx();
  setDomainLocale('zh');
  const zh = search(index, { query: 'fetch a web page', category: 'all', limit: 8 }).map((h) => h.entry.toolId);
  setDomainLocale(DEFAULT_LOCALE);
  const en = search(index, { query: 'fetch a web page', category: 'all', limit: 8 }).map((h) => h.entry.toolId);
  assert.deepEqual(zh, en, '同一个索引在不同界面语言下必须给出相同候选');
  assert.ok(zh.length > 0);
});

test('词边界同义词匹配不回归:cli/word/unit 不误命中子串', () => {
  // 文档只含 clickable/client、keyword、community —— 都不应被
  // 'cli' / 'word' / 'unit' 这些拉丁触发词按词边界命中。
  const idx = buildSearchIndex(Array.from(buildCatalog([
    binding({ name: 'clicker', toolId: 't_click', namespace: 'browser', description: 'click a link in the clickable client page', skill: null }),
    binding({ name: 'counter', toolId: 't_count', namespace: 'data', description: 'a community wide count of widgets', skill: null }),
    binding({ name: 'marketer', toolId: 't_kw', namespace: 'documents', description: 'a keyword tag for an office document', skill: null }),
  ], { now: 0, generation: 'gW' }).entries.values()));
  const q = (s) => search(idx, { query: s, category: 'all', limit: 5 });
  assert.equal(q('cli').length, 0, "'cli' 不得命中 clickable/client");
  assert.equal(q('unit').length, 0, "'unit' 不得命中 community");
  // 'keyword' 只能拿到低权重资料分,不得凭 'word' 拿到受控概念分。
  const kw = q('keyword');
  assert.equal(kw.length, 1);
  assert.ok(!kw[0].reasons.includes(MATCH_REASONS.SYNONYM), "'keyword' 不得因包含 'word' 而命中受控概念");
  // 正向对照:真正的受控触发词仍然生效。
  assert.equal(q('click')[0].entry.name, 'clicker');
});