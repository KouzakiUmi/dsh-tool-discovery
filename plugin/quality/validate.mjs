#!/usr/bin/env node
// plugin/quality 数据集机械验证器。
//
// 约束：只使用 Node 内置模块与 node:assert，不 import 任何产品代码，不连接 registry，
// 不网络访问，不写任何文件。全部检查失败会一次性列出并以退出码 1 结束。
//
// 用法：node plugin/quality/validate.mjs [--json]

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const FIXTURES = path.join(here, 'fixtures', 'catalog.invented.json');
const HELDOUT_Q = path.join(here, 'queries', 'heldout.queries.json');
const TUNING_Q = path.join(here, 'queries', 'train.queries.json');
const HELDOUT_L = path.join(here, 'labels', 'labels.frozen.json');
const TUNING_L = path.join(here, 'labels', 'labels.train.json');
const PLAN = path.join(repoRoot, 'plugin', 'reports', 'quality-plan.md');

const CJK_GRAM = 8;
const ASCII_GRAM = 5;
const FORBIDDEN_KEYS = new Set([
  'execute', 'executefn', 'handler', 'handlerfn', 'run', 'invoke',
  'implementation', 'impl', 'body', 'fn', 'callback', 'module',
  'require', 'import', 'script', 'code', 'eval'
]);
const SCHEMA_FORBIDDEN_KEYS = new Set(['$ref', 'oneOf', 'anyOf', 'allOf', 'not']);
const LANGS = new Set(['zh', 'en', 'mixed']);
const BANDS = new Set(['natural-language', 'exact-name-protocol']);
const MIN_HELDOUT_NL = 60;
const MIN_NEGATIVES = 15;
const CONFUSABLE_TAGS = [
  'path-vs-content',
  'web-read-vs-browser',
  'image-view-vs-generate',
  'pr-list-vs-search'
];

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ status: 'PASS', name });
  } catch (error) {
    results.push({ status: 'FAIL', name, detail: error && error.message ? error.message : String(error) });
  }
}
function readJson(file) {
  assert.ok(existsSync(file), '文件不存在: ' + path.relative(repoRoot, file));
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    assert.fail('JSON 解析失败 ' + path.relative(repoRoot, file) + ': ' + error.message);
  }
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function sha256Of(value) {
  return 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function codePointLength(text) {
  return [...text].length;
}
function normalizeText(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function tokenize(text) {
  const tokens = [];
  for (const ch of text.normalize('NFKC')) {
    if (CJK_RE.test(ch)) {
      tokens.push({ kind: 'cjk', value: ch });
    }
  }
  const asciiWords = text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+/g) || [];
  return { chars: tokens.map((t) => t.value), asciiWords };
}
function ngrams(text, gramSize, kind) {
  const { chars, asciiWords } = tokenize(text);
  const source = kind === 'cjk' ? chars : asciiWords;
  const out = new Set();
  for (let i = 0; i + gramSize <= source.length; i += 1) {
    out.add(source.slice(i, i + gramSize).join(kind === 'cjk' ? '' : ' '));
  }
  return out;
}
function assertNoExecutionSurface(node, pathLabel) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoExecutionSurface(item, pathLabel + '[' + index + ']'));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    assert.ok(
      !FORBIDDEN_KEYS.has(key.toLowerCase()),
      '出现疑似执行函数字段 ' + pathLabel + '.' + key
    );
    assertNoExecutionSurface(value, pathLabel + '.' + key);
  }
}
function assertSmallSchema(schema, label) {
  assert.equal(schema.type, 'object', label + ': parametersSchema.type 必须为 object');
  const props = Object.keys(schema.properties || {});
  assert.ok(props.length >= 1 && props.length <= 6, label + ': 小 schema 顶层属性数必须在 1..6，实际 ' + props.length);
  assertNoExecutionSurface(schema, label);
  (function walk(node, p) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, p + '[' + i + ']'));
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!SCHEMA_FORBIDDEN_KEYS.has(key), label + ': schema 不允许出现 ' + key + '（' + p + '）');
      walk(value, p + '.' + key);
    }
  })(schema, label);
}

const fixtures = readJson(FIXTURES);
const heldoutQ = readJson(HELDOUT_Q);
const tuningQ = readJson(TUNING_Q);
const heldoutL = readJson(HELDOUT_L);
const tuningL = readJson(TUNING_L);

const toolNames = fixtures.tools.map((t) => t.name);
const nameSet = new Set(toolNames);
const toolByIdCategory = new Map(fixtures.tools.map((t) => [t.name, t.trustedCategory]));

/* ---------- 1. fixtures 契约 ---------- */
check('fixtures: 明确标记为人工虚构、非现场注册目录', () => {
  assert.equal(fixtures.fixtureKind, 'invented-synthetic-catalog');
  assert.equal(fixtures.notLiveRegistry, true, 'notLiveRegistry 必须为 true');
  assert.equal(fixtures.synthetic, true);
  assert.ok(typeof fixtures.notice === 'string' && fixtures.notice.length > 30, 'notice 必须说明非现场目录');
  assert.ok(Array.isArray(fixtures.controlledCategories) && fixtures.controlledCategories.length >= 12);
  for (const tool of fixtures.tools) {
    assert.equal(tool.synthetic, true, tool.name + ': 缺少 synthetic 标记');
  }
});
check('fixtures: 必填字段与可信类别', () => {
  const categories = new Set(fixtures.controlledCategories);
  for (const tool of fixtures.tools) {
    for (const field of ['name', 'toolId', 'synthetic', 'description', 'trustedCategory', 'trustedSkillGuidance', 'parametersSchema']) {
      assert.ok(tool[field] !== undefined, tool.name + ': 缺少字段 ' + field);
    }
    assert.ok(categories.has(tool.trustedCategory), tool.name + ': 类别不在受控列表内: ' + tool.trustedCategory);
    for (const lang of ['zh', 'en']) {
      assert.ok(typeof tool.description[lang] === 'string' && tool.description[lang].length > 8, tool.name + ': description.' + lang + ' 过短');
      assert.ok(typeof tool.trustedSkillGuidance.usage[lang] === 'string' && tool.trustedSkillGuidance.usage[lang].length > 8, tool.name + ': usage.' + lang + ' 过短');
      assert.ok(Array.isArray(tool.trustedSkillGuidance.limitations[lang]) && tool.trustedSkillGuidance.limitations[lang].length >= 1, tool.name + ': limitations.' + lang + ' 缺失');
    }
    assert.ok(codePointLength(tool.description.zh) <= 96, tool.name + ': description.zh 超过 96 code point');
    assert.ok(codePointLength(tool.description.en) <= 160, tool.name + ': description.en 超过 160 code point');
  }
});
check('fixtures: 名称唯一且无执行函数', () => {
  assert.equal(nameSet.size, toolNames.length, 'fixtures 中存在重名工具');
  const ids = new Set(fixtures.tools.map((t) => t.toolId));
  assert.equal(ids.size, fixtures.tools.length, 'fixtures 中存在重复 toolId');
  assertNoExecutionSurface(fixtures.tools, 'fixtures.tools');
});
check('fixtures: 参数只人工小 schema（无 $ref/组合，属性数受限）', () => {
  for (const tool of fixtures.tools) {
    assertSmallSchema(tool.parametersSchema, tool.name);
  }
});
check('fixtures: 覆盖易混淆对所需类别', () => {
  const used = new Set(fixtures.tools.map((t) => t.trustedCategory));
  for (const required of ['files', 'web', 'browser', 'images', 'github', 'documents', 'data', 'agents']) {
    assert.ok(used.has(required), '缺少类别 ' + required);
  }
});

/* ---------- 2. queries 契约 ---------- */
function validateQueryShape(doc, label) {
  assert.ok(Array.isArray(doc.queries) && doc.queries.length > 0, label + ': queries 为空');
  const categories = new Set([...fixtures.controlledCategories, 'all']);
  const seenIds = new Set();
  const seenTexts = new Map();
  for (const q of doc.queries) {
    for (const field of ['queryId', 'query', 'category', 'language', 'band', 'tags', 'expectedNames', 'negative', 'labelRationale']) {
      assert.ok(q[field] !== undefined, label + ': ' + q.queryId + ' 缺少字段 ' + field);
    }
    assert.ok(!seenIds.has(q.queryId), label + ': 重复 queryId ' + q.queryId);
    seenIds.add(q.queryId);
    assert.ok(LANGS.has(q.language), q.queryId + ': 未知 language ' + q.language);
    assert.ok(BANDS.has(q.band), q.queryId + ': 未知 band ' + q.band);
    assert.ok(categories.has(q.category), q.queryId + ': category 非法 ' + q.category);
    assert.ok(Array.isArray(q.tags) && q.tags.length >= 1, q.queryId + ': tags 为空');
    assert.ok(Array.isArray(q.expectedNames), q.queryId + ': expectedNames 必须是数组');
    assert.equal(typeof q.negative, 'boolean', q.queryId + ': negative 必须是布尔');
    assert.ok(codePointLength(q.query) >= 2 && codePointLength(q.query) <= 512, q.queryId + ': query 长度越界');
    // 冻结文件 labels.frozen.json 是评分权威源，labelRationale 以它为准。
    // 下限 6 是防占位符的下限，不是否定冻结集中已有的简短裁定理由（如 H018/H041）。
    assert.ok(codePointLength(q.labelRationale) >= 6, q.queryId + ': labelRationale 过短');
    const norm = normalizeText(q.query);
    assert.ok(!seenTexts.has(norm), q.queryId + ': 与 ' + seenTexts.get(norm) + ' 的 query 规范化后重复');
    seenTexts.set(norm, q.queryId);
    if (q.negative === true) {
      assert.deepEqual(q.expectedNames, [], q.queryId + ': 负例的 expectedNames 必须为空');
    } else {
      assert.ok(q.expectedNames.length >= 1, q.queryId + ': 非负例必须有 expectedNames');
      for (const name of q.expectedNames) {
        assert.ok(nameSet.has(name), q.queryId + ': expectedNames 引用了不存在的 fixture: ' + name);
      }
      if (q.category !== 'all') {
        // 类别可达性由独立的资格检查统一判定（见 check('类别资格 ...')），
        // 此处不再用 some() 做宽松判定，否则跨类别答案会被漏判为通过。
      }
    }
    if (q.band === 'exact-name-protocol') {
      assert.equal(q.expectedNames.length, 1, q.queryId + ': exact-name 用例必须单答案');
      assert.equal(q.query, q.expectedNames[0], q.queryId + ': exact-name 用例的 query 必须就是精确名称');
    }
  }
  return { seenTexts, seenIds };
}
const heldoutShape = { seenTexts: new Map(), seenIds: new Set() };
check('heldout queries: 字段、语言、band、类别与名称引用合法', () => {
  const shape = validateQueryShape(heldoutQ, 'heldout');
  heldoutShape.seenTexts = shape.seenTexts;
  heldoutShape.seenIds = shape.seenIds;
  assert.equal(heldoutQ.labelsFrozen, true, 'heldout 必须声明 labelsFrozen: true');
  assert.ok(typeof heldoutQ.usagePolicy === 'string' && heldoutQ.usagePolicy.includes('污染'), '需要写明验证集污染规则');
});
const tuningShape = { seenTexts: new Map() };
check('tuning queries: 字段、语言、band、类别与名称引用合法', () => {
  const shape = validateQueryShape(tuningQ, 'tuning');
  tuningShape.seenTexts = shape.seenTexts;
});
check('train 与 heldout 不交叉', () => {
  const overlap = [];
  for (const norm of tuningShape.seenTexts.keys()) {
    if (heldoutShape.seenTexts.has(norm)) overlap.push(tuningShape.seenTexts.get(norm) + '/' + heldoutShape.seenTexts.get(norm));
  }
  assert.equal(overlap.length, 0, '存在交叉 query: ' + overlap.join(', '));
});
/* ---------- 2b. 类别资格：非 all 用例的全部 expectedNames 都必须可达 ---------- */
// fixtures 中每项只有单一 trustedCategory，没有多类别别名依据。
// 因此 category 非 'all' 时，expectedNames 里任何一个落在别的类别，该答案在类别内检索中不可达。
// 这里不修改任何数据，只如实列举全部不匹配项。
function collectUnreachable(doc) {
  const out = [];
  for (const q of doc.queries) {
    if (q.category === 'all' || q.negative === true) continue;
    for (const name of q.expectedNames) {
      const actual = toolByIdCategory.get(name);
      if (actual !== q.category) {
        out.push(q.queryId + '（' + q.band + '/' + q.category + '）期望 ' + name + '，其 trustedCategory=' + actual);
      }
    }
  }
  return out;
}
check('类别资格：held-out/train 非 all 用例的全部 expectedNames 都可达', () => {
  const held = collectUnreachable(heldoutQ);
  const train = collectUnreachable(tuningQ);
  const all = held.map((s) => 'heldout ' + s).concat(train.map((s) => 'train ' + s));
  assert.equal(
    all.length,
    0,
    '共 ' + all.length + ' 个答案在所属类别内不可达：' + all.join(' | ')
  );
});

check('query 不照抄 fixture 描述（CJK ' + CJK_GRAM + ' 字 / ASCII ' + ASCII_GRAM + ' 词窗口）', () => {
  const gramIndex = new Map();
  for (const tool of fixtures.tools) {
    const texts = [
      tool.description.zh, tool.description.en,
      tool.trustedSkillGuidance.usage.zh, tool.trustedSkillGuidance.usage.en,
      ...tool.trustedSkillGuidance.limitations.zh, ...tool.trustedSkillGuidance.limitations.en
    ];
    for (const text of texts) {
      for (const gram of ngrams(text, CJK_GRAM, 'cjk')) gramIndex.set('cjk:' + gram, tool.name);
      for (const gram of ngrams(text, ASCII_GRAM, 'ascii')) gramIndex.set('ascii:' + gram, tool.name);
    }
  }
  const offenders = [];
  for (const doc of [heldoutQ, tuningQ]) {
    for (const q of doc.queries) {
      if (q.band === 'exact-name-protocol') continue;
      for (const gram of ngrams(q.query, CJK_GRAM, 'cjk')) {
        const hit = gramIndex.get('cjk:' + gram);
        if (hit) offenders.push(q.queryId + ' 与 ' + hit + ' 描述共享中文片段「' + gram + '」');
      }
      for (const gram of ngrams(q.query, ASCII_GRAM, 'ascii')) {
        const hit = gramIndex.get('ascii:' + gram);
        if (hit) offenders.push(q.queryId + ' 与 ' + hit + ' 描述共享英文片段「' + gram + '」');
      }
    }
  }
  assert.equal(offenders.length, 0, offenders.join(' | '));
});

/* ---------- 3. labels 冻结与一致性 ---------- */
function labelsOf(doc) {
  return new Map(doc.labels.map((l) => [l.queryId, l]));
}
function assertLabelsMatchQueries(queryDoc, labelDoc, labelName) {
  const labelMap = labelsOf(labelDoc);
  assert.equal(labelMap.size, queryDoc.queries.length, labelName + ': labels 条数与 queries 不一致');
  for (const q of queryDoc.queries) {
    const label = labelMap.get(q.queryId);
    assert.ok(label, labelName + ': 缺少 ' + q.queryId + ' 的 label');
    assert.deepEqual(label.expectedNames, q.expectedNames, q.queryId + ': labels 与 queries 的 expectedNames 不一致');
    assert.equal(label.negative, q.negative, q.queryId + ': labels 与 queries 的 negative 不一致');
    assert.equal(label.labelRationale, q.labelRationale, q.queryId + ': labels 与 queries 的 labelRationale 不一致');
    const recomputed = sha256Of({
      queryId: label.queryId,
      expectedNames: label.expectedNames,
      negative: label.negative,
      labelRationale: label.labelRationale
    });
    assert.equal(label.labelDigest, recomputed, q.queryId + ': labelDigest 不匹配（label 已被改动）');
  }
  const queryIds = new Set(queryDoc.queries.map((q) => q.queryId));
  for (const id of labelMap.keys()) {
    assert.ok(queryIds.has(id), labelName + ': labels 中出现 queries 没有的 queryId ' + id);
  }
}
check('heldout labels: 冻结文件与 queries 一一对应且逐条 digest 匹配', () => {
  assert.equal(heldoutL.frozen, true, 'heldout labels 必须 frozen: true');
  assert.ok(typeof heldoutL.labelVersion === 'string' && heldoutL.labelVersion.length > 0);
  assert.ok(typeof heldoutL.labelsOwnerNote === 'string' && heldoutL.labelsOwnerNote.length > 10);
  assertLabelsMatchQueries(heldoutQ, heldoutL, 'heldout labels');
});
check('heldout labels: 冻结元数据可信（时间不超前、来源是代理合成标注）', () => {
  const at = Date.parse(heldoutL.frozenAt);
  assert.ok(Number.isFinite(at), 'frozenAt 不是可解析时间: ' + heldoutL.frozenAt);
  assert.ok(at <= Date.now(), 'frozenAt 晚于当前时间，不是可信冻结证明: ' + heldoutL.frozenAt);
  assert.ok(
    /代理|合成/.test(heldoutL.labelsOwnerNote) && /未.*人工|非.*人工|不代表人类专家/.test(heldoutL.labelsOwnerNote),
    'labelsOwnerNote 必须声明标注是代理编写的合成标注，未经过人类专家审核'
  );
  if (heldoutL.frozenAtCorrection) {
    assert.ok(
      typeof heldoutL.frozenAtCorrection.supersededValue === 'string',
      'frozenAtCorrection 必须记录被取代的旧值'
    );
  }
});
check('tuning labels: 与 tuning queries 一一对应（不冻结）', () => {
  assert.equal(tuningL.frozen, false, 'tuning labels 不应冻结');
  assertLabelsMatchQueries(tuningQ, tuningL, 'tuning labels');
});
check('heldout 评分摘要 digest 与冻结文件记录一致', () => {
  const scoringInput = {
    queryTexts: heldoutQ.queries.map((q) => ({
      queryId: q.queryId, query: q.query, category: q.category, language: q.language, band: q.band, tags: q.tags
    })),
    labels: heldoutL.labels.map((l) => ({
      queryId: l.queryId, expectedNames: l.expectedNames, negative: l.negative, labelRationale: l.labelRationale
    }))
  };
  assert.equal(heldoutL.heldoutScoringDigest, sha256Of(scoringInput), 'heldoutScoringDigest 与该文件当前内容不符');
});
check('报告中的 digest 锚点与冻结文件一致', () => {
  assert.ok(existsSync(PLAN), '缺少 reports/quality-plan.md，无法核对 digest 锚点');
  const plan = readFileSync(PLAN, 'utf8');
  const match = plan.match(/heldoutScoringDigest:\s*(sha256:[0-9a-f]{64})/);
  assert.ok(match, 'reports/quality-plan.md 中没有 heldoutScoringDigest 锚点行');
  assert.equal(match[1], heldoutL.heldoutScoringDigest, '报告锚点与冻结 labels digest 不一致（label 可能被重算）');
});

/* ---------- 4. 覆盖度与计数 ---------- */
const heldoutNl = heldoutQ.queries.filter((q) => q.band === 'natural-language');
const exactName = heldoutQ.queries.filter((q) => q.band === 'exact-name-protocol');
const negatives = heldoutNl.filter((q) => q.negative === true);
function countBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
check('heldout 规模：自然语言 ≥ ' + MIN_HELDOUT_NL + ' 条（exact-name 单独统计）', () => {
  assert.ok(heldoutNl.length >= MIN_HELDOUT_NL, '自然语言 held-out 仅 ' + heldoutNl.length + ' 条');
  assert.ok(exactName.length >= 3, 'exact-name 协议用例过少: ' + exactName.length);
  const scoring = heldoutNl.filter((q) => q.band !== 'exact-name-protocol').length;
  assert.equal(scoring, heldoutNl.length, 'exact-name 用例不得计入自然语言成绩');
});
check('heldout 负例 ≥ ' + MIN_NEGATIVES + ' 条', () => {
  assert.ok(negatives.length >= MIN_NEGATIVES, '负例仅 ' + negatives.length + ' 条');
  const ratio = negatives.length / heldoutNl.length;
  assert.ok(ratio >= 0.15, '负例占比低于 15%: ' + ratio.toFixed(3));
});
check('语言覆盖：中文 / 英文 / 中英混写', () => {
  const byLang = countBy(heldoutNl, (q) => q.language);
  assert.ok((byLang.zh || 0) >= 20, '中文 held-out 不足: ' + (byLang.zh || 0));
  assert.ok((byLang.en || 0) >= 20, '英文 held-out 不足: ' + (byLang.en || 0));
  assert.ok((byLang.mixed || 0) >= 5, '中英混写 held-out 不足: ' + (byLang.mixed || 0));
});
check('易混淆对覆盖：每对 ≥ 4 条', () => {
  const counts = {};
  for (const tag of CONFUSABLE_TAGS) {
    counts[tag] = heldoutNl.filter((q) => q.tags.includes(tag)).length;
    assert.ok(counts[tag] >= 4, '易混淆对 ' + tag + ' 仅 ' + counts[tag] + ' 条');
  }
});
check('模糊同义与组合需求覆盖', () => {
  const synonym = heldoutNl.filter((q) => q.tags.includes('synonym')).length;
  const multi = heldoutNl.filter((q) => q.tags.includes('multi-tool') && q.expectedNames.length >= 2).length;
  assert.ok(synonym >= 5, '同义改写用例不足: ' + synonym);
  assert.ok(multi >= 8, '多工具组合用例不足: ' + multi);
});
check('负例不得引用目录内能力，且负例覆盖中英', () => {
  const byLang = countBy(negatives, (q) => q.language);
  assert.ok((byLang.zh || 0) >= 5 && (byLang.en || 0) >= 5, '负例语言分布不足: ' + JSON.stringify(byLang));
  for (const q of negatives) {
    assert.deepEqual(q.expectedNames, [], q.queryId + ': 负例不得有期望工具');
  }
});

/* ---------- 5. 报告锚点之外的产出摘要 ---------- */
const summary = {
  fixtures: {
    toolCount: fixtures.tools.length,
    categories: [...new Set(fixtures.tools.map((t) => t.trustedCategory))].sort()
  },
  heldout: {
    total: heldoutQ.queries.length,
    naturalLanguage: heldoutNl.length,
    exactNameProtocol: exactName.length,
    negatives: negatives.length,
    negativeRate: Number((negatives.length / heldoutNl.length).toFixed(4)),
    byLanguage: countBy(heldoutNl, (q) => q.language),
    byCategory: countBy(heldoutNl, (q) => q.category),
    confusableTags: Object.fromEntries(CONFUSABLE_TAGS.map((tag) => [tag, heldoutNl.filter((q) => q.tags.includes(tag)).length])),
    multiTool: heldoutNl.filter((q) => q.expectedNames.length >= 2).length
  },
  tuning: {
    total: tuningQ.queries.length,
    negatives: tuningQ.queries.filter((q) => q.negative === true).length,
    byLanguage: countBy(tuningQ.queries, (q) => q.language)
  },
  categoryEligibility: {
    rule: 'category != "all" 时全部 expectedNames 的 trustedCategory 必须等于 category',
    heldoutUnreachable: collectUnreachable(heldoutQ),
    trainUnreachable: collectUnreachable(tuningQ),
    scoringReady: false
  },
  labels: {
    heldoutFrozen: heldoutL.frozen,
    heldoutScoringDigest: heldoutL.heldoutScoringDigest
  },
  bytes: {
    fixtures: utf8Bytes(readFileSync(FIXTURES, 'utf8')),
    heldoutQueries: utf8Bytes(readFileSync(HELDOUT_Q, 'utf8')),
    tuningQueries: utf8Bytes(readFileSync(TUNING_Q, 'utf8'))
  }
};

const failed = results.filter((r) => r.status === 'FAIL');
const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results, summary }, null, 2));
} else {
  for (const r of results) {
    console.log((r.status === 'PASS' ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? ' -> ' + r.detail : ''));
  }
  console.log('');
  console.log('摘要: ' + JSON.stringify(summary, null, 2));
}
if (failed.length > 0) {
  console.error('');
  console.error('验证失败: ' + failed.length + '/' + results.length + ' 项检查未通过。');
  process.exit(1);
}
if (!asJson) {
  console.log('');
  console.log('验证通过: ' + results.length + ' 项检查全部通过（未执行任何产品代码、未访问网络）。');
}
