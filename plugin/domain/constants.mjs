// progressive-v2/domain/constants.mjs
// 协议版本、错误码元数据、预算默认值、受控类别与受控匹配标签。
// 宿主无关:不 import Cordis / DSH / 第三方包。
import { createText } from './locale.mjs';

/** @type {2} */
export const PROTOCOL_VERSION = 2;

export const ENTRY_TOOL_NAMES = Object.freeze(['tool_list', 'tool_search', 'tool_load']);
export const LOAD_TOOL_NAME = 'tool_load';

/** 02 §3 受控类别(顺序即导航默认顺序)。 */
export const CONTROLLED_CATEGORIES = Object.freeze([
  'files', 'shell', 'web', 'browser', 'desktop', 'github',
  'documents', 'data', 'agents', 'images', 'integrations', 'other',
]);

/** 02 §9 预算冻结值。模型不可修改。 */
export const DEFAULT_BUDGETS = Object.freeze({
  initialSchemaTargetTokens: 2048,
  maxInitialBytes: 8192,
  maxInitialCategories: 12,
  defaultListLimit: 20,
  maxListLimit: 20,
  maxListResultBytes: 4096,
  listCursorTtlMs: 900_000,
  maxQueryCodePoints: 512,
  defaultSearchLimit: 5,
  maxSearchLimit: 8,
  maxSearchResultBytes: 6144,
  maxLoadBatch: 4,
  maxActiveTools: 12,
  maxActiveSchemaBytes: 49_152,
  maxSkillBytesPerLoad: 12_288,
  candidateTtlMs: 900_000,
});

/**
 * 错误码元数据。message 面向模型,保持稳定且不泄漏存在性。
 * message 随界面语言变化,故本表按 locale 生成而非模块级常量。
 * @param {string} [locale] 宿主界面语言；缺省英文。
 * @returns {Readonly<Record<string,{message:string;retryable:boolean;recovery:string}>>}
 */
export function errorCodes (locale) {
  const text = createText(locale);
  return Object.freeze({
    INVALID_ARGS: { message: text.t(['error', 'INVALID_ARGS']), retryable: false, recovery: 'fix_arguments' },
    CATEGORY_UNAVAILABLE: { message: text.t(['error', 'CATEGORY_UNAVAILABLE']), retryable: false, recovery: 'list_categories' },
    NO_MATCH: { message: text.t(['error', 'NO_MATCH']), retryable: true, recovery: 'rewrite_query_or_browse_names' },
    CURSOR_UNAVAILABLE: { message: text.t(['error', 'CURSOR_UNAVAILABLE']), retryable: true, recovery: 'restart_from_first_page' },
    TOOL_UNAVAILABLE: { message: text.t(['error', 'TOOL_UNAVAILABLE']), retryable: false, recovery: 'browse_or_search_again' },
    CANDIDATE_UNAVAILABLE: { message: text.t(['error', 'CANDIDATE_UNAVAILABLE']), retryable: true, recovery: 'search_again' },
    STALE_CANDIDATE: { message: text.t(['error', 'STALE_CANDIDATE']), retryable: true, recovery: 'select_again' },
    SELECTION_CHANGED: { message: text.t(['error', 'SELECTION_CHANGED']), retryable: true, recovery: 'select_again' },
    BUDGET_EXCEEDED: { message: text.t(['error', 'BUDGET_EXCEEDED']), retryable: false, recovery: 'reduce_or_unload' },
    STATE_NOT_READY: { message: text.t(['error', 'STATE_NOT_READY']), retryable: true, recovery: 'retry_when_ready' },
    TOOL_NOT_LOADED: { message: text.t(['error', 'TOOL_NOT_LOADED']), retryable: false, recovery: 'call_tool_load_first' },
    TOOL_NOT_ADVERTISED: { message: text.t(['error', 'TOOL_NOT_ADVERTISED']), retryable: true, recovery: 'wait_for_next_request' },
    INCOMPATIBLE_PRESENTATION: { message: text.t(['error', 'INCOMPATIBLE_PRESENTATION']), retryable: false, recovery: 'use_native_only' },
    INCOMPATIBLE_COMPOSITION: { message: text.t(['error', 'INCOMPATIBLE_COMPOSITION']), retryable: false, recovery: 'fix_composition' },
  });
}

/**
 * 默认语言的错误码表（模块级便利导出，等价于 errorCodes()）。
 * 需要按界面语言取表的调用方应改用 errorCodes(locale)。
 * @type {Readonly<Record<string,{message:string;retryable:boolean;recovery:string}>>}
 */
export const ERROR_CODES = errorCodes();

/** 受控、可解释的匹配标签(02 §5:matchReasons 必须是受控标签)。 */
export const MATCH_REASONS = Object.freeze({
  EXACT_NAME: 'exact-name',
  NAME_TOKEN: 'name-token',
  SYNONYM: 'synonym',
  CATEGORY_TOKEN: 'category-token',
  SUMMARY_TOKEN: 'summary-token',
  SKILL_TOKEN: 'skill-token',
});

/** 排序信号权重:exact-name > name-token > synonym > category-token > summary-token > skill-token。 */
export const SIGNAL_WEIGHTS = Object.freeze({
  [MATCH_REASONS.EXACT_NAME]: 100,
  [MATCH_REASONS.NAME_TOKEN]: 12,
  [MATCH_REASONS.SYNONYM]: 8,
  [MATCH_REASONS.CATEGORY_TOKEN]: 6,
  [MATCH_REASONS.SUMMARY_TOKEN]: 3,
  [MATCH_REASONS.SKILL_TOKEN]: 2,
});

/**
 * 受控同义词表(01 §5.3:同义词来自受控词表,不依赖描述恰好含用户关键词)。
 * key 为受控概念,value 为会扩展到该概念的中文/英文触发词。
 * 只用于检索扩展,不影响分类、资格或权限。
 */
/**
 * 受控同义词表(01 §5.3:同义词来自受控词表,不依赖描述恰好含用户关键词)。
 * 每组第一个元素是概念 id,其后是**双向**触发表:
 *  - 查询侧:用户可能说的中文/英文目标描述;
 *  - 文档侧:工具名与用途描述中可能出现的英文短语。
 * 两侧都用子串匹配,因此同一条目可被中英文查询同时命中。
 * 只用于检索扩展,不影响分类、资格或权限。
 */
export const SYNONYM_GROUPS = Object.freeze([
  Object.freeze([
    'locate-files',
    // 查询侧
    '找文件', '定位文件', '查找文件', '文件在哪', '按路径', '路径模式', '文件路径',
    '列出文件', '文件名字', '哪些文件', 'find files', 'locate files', 'file paths',
    'which files', 'list files',
    // 文档侧
    'by path', 'path pattern', 'file entries', 'file path', 'file name',
  ]),
  Object.freeze([
    'search-content',
    '搜正文', '全文搜索', '内容检索', '在正文', '正文里', '字符串', '内容中',
    'search content', 'grep', 'full text', 'inside files',
    'file content', 'file contents', 'inside file', 'search text', 'text search',
  ]),
  Object.freeze([
    'modify-file',
    '改文件', '修改文件', '写文件', '替换内容', 'edit file', 'modify file', 'write file',
    'edit', 'modify', 'rewrite',
  ]),
  Object.freeze([
    'run-command',
    '执行命令', '跑命令', '终端', '运行程序', 'shell', 'run command', 'terminal', 'cli',
    'command', 'execute',
  ]),
  Object.freeze([
    'fetch-web',
    '抓网页', '读取网页', '网页内容', '获取网页', 'fetch web', 'http request', 'read page source',
    'web page', 'over http', 'fetch a',
  ]),
  Object.freeze([
    'web-search',
    '搜网', '搜索结果', '搜索引擎', '搜一下', 'web search', 'search engine', 'search results',
    'search engine',
  ]),
  Object.freeze([
    'browser-control',
    '操作网页', '点击', '填表单', '在页面上', 'browser', 'click', 'form input', 'interact with page',
    'click an element',
  ]),
  Object.freeze([
    'desktop-control',
    '操作桌面', '桌面输入', '在屏幕上', 'desktop', 'type on screen', 'desktop input',
    'on the desktop',
  ]),
  Object.freeze([
    'github-api',
    '拉取请求', '代码仓库协作', '合并请求', 'pull request', 'repository', 'github',
    'prs',
  ]),
  Object.freeze([
    'office-docs',
    '文档表格', '表格文件', '办公文档', 'excel', 'word', 'spreadsheet', 'office document',
    'office', 'spreadsheet', 'document',
  ]),
  Object.freeze([
    'subagent',
    '子代理', '委派', '分派任务', 'spawn agent', 'subagent', 'delegate', 'spawn a subagent',
  ]),
  Object.freeze([
    'view-image',
    '看图', '查看图片', '图片内容', 'view image', 'inspect image', 'image reading',
    'view an image',
  ]),
  Object.freeze([
    'generate-image',
    '生成图片', '画图', '生成一张图', 'generate image', 'draw image', 'image creation',
    'generate an image',
  ]),
  Object.freeze([
    'data-query',
    '查数据', '单位换算', '换算', '转换', 'convert', 'unit', 'numeric transform',
    'convert numeric',
  ]),
]);

/** 同义词扩展触发词 → 概念,运行时构建(只读)。 */
export const SYNONYM_INDEX = Object.freeze(
  SYNONYM_GROUPS.reduce((acc, group) => {
    const concept = group[0];
    for (const term of group) acc[term] = concept;
    return acc;
  }, Object.create(null)),
);
