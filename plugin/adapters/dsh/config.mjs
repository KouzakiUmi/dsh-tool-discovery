// plugin/adapters/dsh/config.mjs
// 插件的 schemastery Config 与设置面板用的活目录元数据。
//
// 两个职责，刻意放在一个模块：
//
//  1. `buildConfig(Schema)` —— 宿主 dsh-settings 读的 `fiber.runtime.Config`。
//     只有 `alwaysVisible` 是 volatile（即时生效、可被设置面板改写而不重挂载）。
//     **替换语义，不是并集**：字段默认值是 CORE_TOOL_NAMES；一旦显式给出
//     （含显式 `[]`），该值就是完整的初始注入名单，把默认项删掉是真的删掉，
//     之后仍可经普通 tool_load 再次加载（engine 的 protected 判据随之放开）。
//     三个发现入口**不在这个字段里**，由 domain 的 ENTRY_TOOL_NAMES 单独保护，
//     任何配置都改不动。
//
//  2. `initialToolChoices` —— 活目录元数据，挂在 `alwaysVisible` 的 `schema.meta`
//     上（`Schema.extra`，纯 JSON）。设置面板从这里读到"现在真实存在哪些工具"。
//     为什么不另开通道：dsh-settings `describe()` 每次都原样
//     `schema.toJSON()` 发出整棵 schema 树（lib/index.js:421-435、:444），
//     meta 是这棵树的一部分；tools/change 时改 meta 再 `settings.invalidate()`
//     就能让客户端重读，无需 RPC、广播或只读配置字段。
//
// Schema 由调用方注入（工厂 deps.Schema），生产默认按裸包名动态 import —— 与
// defineTool 同一形状，因此工作区（无 node_modules）也不会因本模块而无法加载。
import { CORE_TOOL_NAMES } from '../../domain/core-tools.mjs';
import { ENTRY_TOOL_NAMES } from '../../domain/constants.mjs';

/** meta key：设置面板读取的当前工具目录。 */
export const INITIAL_TOOL_CHOICES = 'initialToolChoices';

/** 面板上的三个固定入口（不可勾选、不可删除）。 */
export const FIXED_ENTRY_NAMES = Object.freeze([...ENTRY_TOOL_NAMES]);

/** 默认初始注入名单：DSH 自带工具。 */
export const DEFAULT_ALWAYS_VISIBLE = Object.freeze([...CORE_TOOL_NAMES]);

/**
 * 取当前生效的常驻名单。配了 schemastery `Config` 时 `alwaysVisible` 是 volatile
 * 引用（`{get()}`，设置面板改动即时可见），未配时是普通数组；两种都读。
 * 缺省回落 DSH 默认名单。
 * @param {any} value `config.alwaysVisible`
 * @returns {string[]}
 */
export function resolveAlwaysVisible(value) {
  let raw = value;
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') raw = raw.get();
  if (!Array.isArray(raw)) return [...DEFAULT_ALWAYS_VISIBLE];
  const out = [];
  const seen = new Set();
  for (const name of raw) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 构造宿主设置页使用的 Config schema。
 * @param {any} Schema schemastery 默认导出（`import Schema from '@deepseek-ai/schemastery'`）
 */
export function buildConfig(Schema) {
  if (Schema === undefined || typeof Schema?.object !== 'function') {
    throw new TypeError('The schemastery Schema dependency is missing.');
  }
  const alwaysVisible = Schema.array(Schema.string())
    .default([...DEFAULT_ALWAYS_VISIBLE])
    .volatile()
    .description('Tools injected into every request from the start. Replaces the DSH default list entirely; the three discovery entries are always present and cannot be removed.');
  return Schema.object({
    alwaysVisible,
    frameworkRetained: Schema.array(Schema.string())
      .default([])
      .description('Trusted framework-mandated tool names the projection must keep. Not user-editable here.'),
    // budgets 默认 null = 完全不覆盖，走 domain 的冻结默认值（budgets.mjs 对
    // undefined/null 都回落 DEFAULT_BUDGETS）。必须显式允许 null：用户把
    // "关闭覆盖"写成 null 不该被 schema 拒掉。schemastery 没有 `Schema.null`，
    // 但**非 required** 字段本来就接受 null（Schema.resolve 的 isNullable 分支），
    // 所以这里只是把默认值定为 null。
    budgets: Schema.dict(Schema.number())
      .default(null)
      .description('Optional overrides for the frozen budget defaults. null means no overrides.'),
    // 既有部署已在用的字段：保留在 Config 里，免得新 Config 把它当成未知键吞掉。
    // 形状校验仍由 validateConfig 做（逐类检查 title/capabilitySummary），这里只
    // 保证不拦。
    categoryConfig: Schema.dict(Schema.any())
      .default({})
      .description('Per-category model-visible navigation copy. Falls back to the interface-language table for any category left unset.'),
  });
}

/**
 * 当前 scope 真实可见的原生工具名（不含三个发现入口）—— 面板的目录来源。
 * 与 registry 同一事实源 `ctx.tools.view()`，只是不构造 CatalogBindingDTO。
 * @param {{view:{visible: Map<string,any>}}} view
 */
export function nativeToolNamesOf(view) {
  const fixed = new Set(FIXED_ENTRY_NAMES);
  const names = [];
  for (const name of view?.visible?.keys() ?? []) {
    if (fixed.has(name)) continue;
    names.push(name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names;
}

/**
 * 把活目录写进 `alwaysVisible` 节点的 meta。纯 JSON；就地改，不重建 schema 树。
 * 写完由调用方 `settings.invalidate()` 触发 describe 重发（dsh-settings:382）。
 * @param {any} config buildConfig 的产物
 * @param {readonly string[]} names
 */
export function publishToolChoices(config, names) {
  const node = config?.dict?.alwaysVisible;
  if (node === undefined) return false;
  const seen = new Set();
  const choices = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    choices.push({ name, available: true });
  }
  node.meta = { ...node.meta, [INITIAL_TOOL_CHOICES]: choices };
  return true;
}

/**
 * 设置面板的完整初始集合：固定三入口 + 目录里可选的工具。
 * 选中但当前不可用（被移除/换版）的名字保留在 `missing` 里，供 UI 标注但仍可删。
 * @param {{choices?: readonly any[]}} meta `alwaysVisible` 节点的 meta
 * @param {readonly string[]} selected 用户配置里的 alwaysVisible
 */
export function initialSelectionView(meta, selected) {
  const fixed = FIXED_ENTRY_NAMES;
  const available = new Set();
  const byName = new Map();
  for (const choice of meta?.choices ?? []) {
    if (typeof choice?.name !== 'string') continue;
    byName.set(choice.name, choice);
    available.add(choice.name);
  }
  const selectedSet = new Set();
  for (const name of selected ?? []) {
    if (typeof name === 'string' && name.length > 0) selectedSet.add(name);
  }
  const rows = [];
  for (const name of selectedSet) {
    if (fixed.includes(name)) continue;
    rows.push({ name, selected: true, available: available.has(name) });
  }
  for (const name of available) {
    if (selectedSet.has(name)) continue;
    rows.push({ name, selected: false, available: true });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { fixed: [...fixed], rows };
}
