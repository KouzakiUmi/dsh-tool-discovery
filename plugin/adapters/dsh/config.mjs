// plugin/adapters/dsh/config.mjs
// 插件的 schemastery Config 与设置面板用的活目录元数据。
//
// 两个职责，刻意放在一个模块：
//
//  1. `buildConfig(Schema)` —— 宿主 dsh-settings 读的 `fiber.runtime.Config`。
//     `alwaysVisible` / `initialToolsEnabled` 是 volatile：保存不重挂载，在周期边界采用。
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
import { ENTRY_TOOL_NAMES, DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS, CONTROLLED_CATEGORIES } from '../../domain/constants.mjs';

/** meta key：设置面板读取的当前工具目录。 */
export const INITIAL_TOOL_CHOICES = 'initialToolChoices';

/** 面板上的三个固定入口（不可勾选、不可删除）。 */
export const FIXED_ENTRY_NAMES = Object.freeze([...ENTRY_TOOL_NAMES]);

/** 默认初始注入名单：DSH 自带工具。 */
export const DEFAULT_ALWAYS_VISIBLE = Object.freeze([...CORE_TOOL_NAMES]);

/**
 * 默认"不生效"的 preset 名单：宿主官方极简模式（`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`
 * 的 `id: minimal`）。极简模式的设计前提是工具面极小，四入口会改写这个前提，所以默认让插件在
 * 这些 preset 上保持惰性。
 * @type {readonly string[]}
 */
export const DEFAULT_DISABLED_PRESETS = Object.freeze(['minimal']);

/**
 * 归一 `disabledPresets`：去空白、去空串、去重，保持给出顺序。
 *
 * 语义与 `alwaysVisible` 一致——**替换不是追加**：`undefined` / `null` 取默认值
 * `['minimal']`，显式 `[]` 表示"没有 preset 被停用"（所有 preset 都回到正常发现流程）。
 * volatile 引用（设置面板写入）先解包再归一。
 * @param {any} value `config.disabledPresets`
 * @returns {readonly string[]}
 */
export function resolveDisabledPresets(value) {
  let raw = value;
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') raw = raw.get();
  if (raw === undefined || raw === null) return DEFAULT_DISABLED_PRESETS;
  if (!Array.isArray(raw)) return DEFAULT_DISABLED_PRESETS;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return Object.freeze(out);
}

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
    .description('Manual initial tool list. Replaces the DSH default list; current-preset retention is controlled separately. Changes reconcile on the next request. The four discovery entries stay available.');
  alwaysVisible.meta = { ...alwaysVisible.meta, settingConstraints: {
    budgetKeys: Object.keys(DEFAULT_BUDGETS), optionalLimitKeys: [...OPTIONAL_LIMIT_KEYS],
    categoryKeys: [...CONTROLLED_CATEGORIES],
  } };
  return Schema.object({
    alwaysVisible,
    initialToolsEnabled: Schema.boolean()
      .default(true)
      .volatile()
      .description('Inject the configured initial tools. Changes reconcile on the next request; the four discovery entries stay available.'),
    alwaysAllowPresetTools: Schema.boolean()
      .default(true)
      .volatile()
      .description('Always include tools registered by the current bound preset, even when manual initial injection is disabled. Changes reconcile on the next request; native permissions and eligibility remain enforced.'),
    gateOwnScopeTools: Schema.boolean()
      .default(true)
      .volatile()
      .description('On (default): tools registered into the agent\'s own scope must also pass tool_load before they can execute — own-scope registrations cannot be masked by design, so admission is their only gate. Off: own-scope tools outside the catalog execute freely.'),
    disabledPresets: Schema.array(Schema.string())
      .default(['minimal'])
      .volatile()
      .description('Preset ids where tool discovery stays inert: the four discovery entries are hidden, nothing else is masked, and no admission gate is applied, so native tools behave exactly as without this plugin. Default ["minimal"] (the built-in minimal preset). An explicit [] disables discovery nowhere. Unknown ids simply never match. Reconciles on the next request.'),
    frameworkRetained: Schema.array(Schema.string())
      .default([])
      .description('Trusted framework-mandated tool names the projection must keep. Not user-editable here.'),
    tolerantLoadProtected: Schema.boolean()
      .default(true)
      .volatile()
      .description('Tolerate loading already-active baseline tools idempotently instead of throwing protectedNotLoadable. Resolves conflict deadlocks when models attempt to load system or preset tools. Changes apply to running sessions without a reload.'),
    // 「alwaysVisible 是下限还是精确集合」的开关。默认关闭 = 现状：当前 scope 真实提供的
    // DSH 核心工具会被自动并入常驻名单，并且不经 load 即可执行——这避免了 TOOL_NOT_LOADED
    // 往返，也让上游新增的核心工具不必等本插件更新名单。打开后 alwaysVisible（与 preset
    // 保留项）就是**精确集合**：没列出的核心工具必须像别的工具一样先 tool_load。
    // volatile：常驻名单与掩码在配置热改时立即重算（adapter 监听 loader/volatile-update），
    // 已有会话在下一个模型步骤就采用新值，不需要重挂载插件。
    respectAlwaysVisible: Schema.boolean()
      .default(false)
      .volatile()
      .description('Make alwaysVisible an exact set, DSH core tools included. Off by default: core tools the current scope actually offers are auto-enrolled and admitted without a load (fewer round-trips, new upstream core tools keep working). Turn it on when your list should be the ceiling — a core tool you left out then has to be loaded like any other tool. Changes apply to running sessions without a reload.'),
    // budgets 默认 null = 完全不覆盖，走 domain 的冻结默认值（budgets.mjs 对
    // undefined/null 都回落 DEFAULT_BUDGETS）。必须显式允许 null：用户把
    // "关闭覆盖"写成 null 不该被 schema 拒掉。schemastery 没有 `Schema.null`，
    // 但**非 required** 字段本来就接受 null（Schema.resolve 的 isNullable 分支），
    // 所以这里只是把默认值定为 null。
    budgets: Schema.dict(Schema.number())
      .default(null)
      .volatile()
      .description('Optional overrides for the frozen budget defaults. null means no overrides. Applied to running sessions without a reload (the two cursor/candidate TTL keys still need one).'),
    // 界面语言：'auto'（默认）跟随桌面界面语言，读不到就回落 en；其它值把语言钉死，
    // 不再去读宿主文件。取值经 domain 的 normalizeLocale 归一，未知语言名回落 en。
    // volatile：语言可以在运行中改（adapter 监听 loader/volatile-update，重做文案绑定
    // 并重建四个入口 definition），不需要重挂载插件。
    locale: Schema.string()
      .default('auto')
      .volatile()
      .description('Model-visible copy language: "auto" follows the desktop interface language when it can be read, otherwise falls back to en. Any other value pins the locale; unknown names fall back to en. Applied to running sessions without a reload.'),
    // 既有部署已在用的字段：保留在 Config 里，免得新 Config 把它当成未知键吞掉。
    // 形状校验仍由 validateConfig 做（逐类检查 title/capabilitySummary），这里只
    // 保证不拦。
    categoryConfig: Schema.dict(Schema.any())
      .default({})
      .volatile()
      .description('Per-category model-visible navigation copy. Falls back to the interface-language table for any category left unset. Applied to running sessions without a reload.'),
  });
}

/**
 * 单个 scope 真实可见的原生工具名（不含三个发现入口）；不是设置页的全局完整性证据。
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
export function publishToolChoices(config, names, { complete = false, frameworkRetained = [] } = {}) {
  const node = config?.dict?.alwaysVisible;
  if (node === undefined) return false;
  const seen = new Set();
  const choices = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    choices.push({ name, available: true });
  }
  node.meta = { ...node.meta, [INITIAL_TOOL_CHOICES]: choices,
    toolDirectory: { scope: 'application', complete: complete === true },
    // 只读展示用：frameworkRetained 必须保持非 volatile（改了要重载插件），因此宿主
    // 不会把它放进实时表单的 value。它搭 volatile 节点的 meta 通道下发，面板据此显示
    // 真实值而不是空表。
    frameworkRetained: [...frameworkRetained] };
  return true;
}

/**
 * 设置面板的完整初始集合：固定三入口 + 目录里可选的工具。
 * 未登记或全局目录尚未完整确认的已选名字仍可删除；不把未列出等同于调用不可用。
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
    rows.push({ name, selected: true, available: available.has(name),
      status: available.has(name) ? 'registered' : meta?.catalogComplete === true ? 'unregistered' : 'unknown' });
  }
  for (const name of available) {
    if (selectedSet.has(name)) continue;
    rows.push({ name, selected: false, available: true, status: 'registered' });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { fixed: [...fixed], rows };
}
