// 面向模型的文案表（唯一的文案来源）。
//
// 为什么插件自建：DSH 到 0.2.1-alpha.1 为止**没有提供插件运行时文案 API**。
// `locale/*.json` 只承载插件管理页的 meta 展示（title/description），不参与
// 工具 description、参数说明、nextAction 与错误 message 的渲染。已装插件
// dsh-prompt-zh 也是自行注入中文字符串，而非调用宿主 i18n。
//
// 语言来源：DSH 把界面语言写进 `$DSH_HOME/desktop-locale.json`
// （形如 {"desktop":"en"}），常量定义在 @deepseek-ai/dsh-client-locale
// （LOCALE_IDS = ["zh","en"]）。该文件不在宿主公开 API 内，故按约定路径读取：
// 路径由适配层经宿主 @deepseek-ai/dsh-home-paths 解析、读取函数由适配层注入，
// 本模块与 host-locale 都**不持有 I/O 能力**。任何读取失败或未知值一律回落 en——
// 英文是协议文案的安全默认，猜错方向不会误导模型；Config 的 locale 字段可直接钉住语言。
//
// 范围：只收录**模型每轮真正读到的**文案。代码注释、宿主日志字段、诊断
// visibility 取值一律不进表——它们不是模型可见面，翻译它们只会制造
// "两套文案必须同步" 的维护负担而无收益。
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh']);

/** 默认语言。读取宿主设置失败、或出现未知值时使用。 */
export const DEFAULT_LOCALE = 'en';

const MESSAGES = Object.freeze({
  // ---- 三个入口的 description 与参数说明 ----
  entry: {
    tool_list: {
      description:
        'List discoverable tools by category. Returns names only — no schema, no descriptions. Use it to browse before deciding what to load.',
      category: 'Capability category to browse. Use "all" for every category.',
      cursor: 'Opaque cursor from a previous list call. Omit to start from the first page.',
      view: 'Which bounded view to read: "available" (browsable), "loaded" (currently active), "categories" (capability summaries), or "state" (session selection state). When omitted: "categories" without category, otherwise "available".',
      limit: 'Page size. Default 20.',
      loadAction: 'Default "load".',
      candidateRef: 'Opaque candidate ref.',
      candidateRevision: 'Exact candidate revision (optional; inferred from ref if omitted).',
      namesPath: 'Exact native tool names (load path B). Mutually exclusive with candidates.',
      toolIdsUnload: 'Selected tool ids to unload (action "unload" only).',
      nextAction_categories: 'Pick a category, then call tool_list again with that category.',
      nextAction_available: 'Call tool_load with the exact names you want, or tool_search to narrow by purpose.',
      nextAction_loaded: 'These tools are already active in this session; call them directly.',
      nextAction_state: 'State view does not enumerate hidden tools. Use tool_search to discover more.',
      nextAction_paging: 'More names remain; pass nextCursor to continue.',
    },
    tool_search: {
      description:
        'Find tools that suit a task without loading them. Returns a small candidate set with brief purposes and version-bound refs. Ranking is lexical; it does not call any model.',
      category: 'Restrict candidates to one capability category, or "all" for every category.',
      query: 'Natural-language description of the task (not a tool name).',
      limit: 'Max candidates. Default 5.',
      nextAction_hit: 'Pass the chosen ref to tool_load; revision is optional and inferred from the ref.',
      nextAction_empty: 'Rewrite the query, or browse names with tool_list.',
    },
    tool_load: {
      description:
        'Activate tools for this session. Prefer loading all tools needed for the task in a single batch to maximize cache reuse. Loads take effect on the NEXT request — it never executes a target tool. Loading is an explicit model choice, not a user approval.',
      names: 'Exact native tool names to load.',
      candidates: 'Candidates chosen by ref, as returned by tool_search. revision is optional; it defaults to the version bound to the ref. Mutually exclusive with names.',
      action: '"load" to activate tools (the only supported action).',
      toolIds: 'Tool IDs to unload, as reported by tool_list in the "loaded" view.',
      nextAction_loaded: 'You will see the tool schemas in the next request; call the tools then.',
      nextAction_unloaded: 'The next request will drop these tools.',
    },
  },

  // ---- 错误码 message（面向模型） ----
  error: {
    INVALID_ARGS: 'Invalid argument fields, count, or combination.',
    CATEGORY_UNAVAILABLE: 'That category does not exist or is not currently visible.',
    NO_MATCH: 'No matching candidates.',
    CURSOR_UNAVAILABLE: 'The paging cursor has expired; restart from the first page.',
    TOOL_UNAVAILABLE: 'That name is not available in the current scope.',
    CANDIDATE_UNAVAILABLE: 'That candidate reference has expired; search again or select by name.',
    STALE_CANDIDATE: 'The candidate definition changed; search again or select the current name.',
    SELECTION_CHANGED: 'The current definition changed during validation; select again.',
    BUDGET_EXCEEDED: 'Over budget: load fewer tools in this request, or let a successful context compaction (by the user or DSH) free the disclosed set. Already-disclosed tools are never evicted to make room.',
    STATE_NOT_READY: 'Session state is not ready yet.',
    TOOL_NOT_LOADED: 'This tool was not explicitly loaded in this session.',
    TOOL_NOT_ADVERTISED: 'This tool is not disclosed in the current request.',
    INCOMPATIBLE_PRESENTATION: 'The current presentation mode is not supported.',
    INCOMPATIBLE_COMPOSITION: 'The current plugin composition is not supported.',
  },

  // ---- guard 拒绝文案 ----
  guard: {
    // 与 error.TOOL_NOT_LOADED 区分：这里的事实是"回执已在途、尚未折叠"，
    // 报成 NOT_LOADED 会让模型误以为加载失败而重试。
    pendingFold: 'This tool\'s load is taking effect; call it in the next request.',
    pendingFoldCode: 'TOOL_NOT_ADVERTISED',
  },

  // 内部错误：只用于「未知异常收敛」，不得泄漏堆栈给模型。
  error_internal: 'Internal error in the discovery kernel.',
  ENGINE_DISPOSED: 'The discovery engine has been released.',
  missingSessionIdentityHost: 'The host session identity is unavailable.',
  sessionContextUnavailable: 'The current session context is unavailable.',

  /**
   * 逐点拒绝文案。每条都有对应的错误码，但**码不足以让模型自我纠正**：
   * "limit 超过硬上限" 要告诉它上限是多少、"category 必填" 要告诉它填什么。
   * 因此这些是独立条目而非从码派生。
   */
  detail: {
    budgetNotObject: 'The budgets config must be an object.',
    nameOverByteBudget: 'A single tool name exceeds the result byte budget.',
    categoryCardOverByteBudget: 'A single category card exceeds the result byte budget.',
    candidateCardOverByteBudget: 'A single candidate card exceeds the result byte budget.',
    activeToolCount: 'Active tool count exceeds the limit.',
    activeSchemaBytes: 'Active schema bytes exceed the limit.',
    skillResponseOverBudget: 'This skill response exceeds the byte budget.',
    skillVersionMismatch: 'Skill version does not match the entry.',
    skillForbiddenField: 'The skill payload contains a forbidden field: {field}',
    unknownBudgetKey: 'Unknown budget key: {key}',
    optionalLimitInvalid: 'Optional limit {key} must be a positive integer or null (null = disabled).',
    budgetKeyInvalid: 'Budget key {key} must be a positive integer.',
    bytesOverBudget: '{what} exceeds the byte budget.',
    bindingFieldNotStringOrNull: '{key} must be a string or null.',
    duplicateToolId: 'Duplicate toolId: {toolId}',

    bindingNotObject: 'A catalog binding must be an object.',
    bindingMissingToolId: 'A catalog binding is missing toolId.',
    bindingMissingName: 'A catalog binding is missing name.',
    bindingDescriptionNotString: 'A catalog binding description must be a string.',
    bindingMissingWire: 'A catalog binding is missing wire.',
    bindingWireNameMismatch: 'A binding wire.name does not match the binding name.',
    bindingWireParametersNotObject: 'A binding wire.parameters must be an object.',
    bindingWireDescriptionNotString: 'A binding wire.description must be a string.',
    bindingsNotArray: 'bindings must be an array.',
    ambiguousName: 'That name has multiple bindings in the current scope; select by toolId.',
    skillNotObject: 'A skill must be an object or null.',
    skillMissingRevision: 'A skill is missing skillRevision.',
    skillMissingUsage: 'A skill is missing usage.',
    skillLimitationsNotArray: 'Skill limitations must be an array of strings.',

    engineConfigNotObject: 'engine config must be an object.',
    protocolVersionUnsupported: 'Protocol version is not supported.',
    categoryConfigRequired: 'categoryConfig is required (trusted config).',
    clockRequired: 'clock is required.',
    randomRequired: 'random is required.',
    missingSessionIdentity: 'Missing session identity (must be supplied by the host).',
    operationIdRequired: 'operationId must be supplied by the host.',
    protectedNotLoadable: 'Entry and always-visible tools cannot be loaded.',
    protectedNotUnloadable: 'Entry and always-visible tools cannot be unloaded.',
    modelUnloadDisabled: 'Unloading is not available: loaded tools stay disclosed until the context is compacted. Load another tool instead.',
    candidateRevisionConflict: 'Two candidates for the same tool carry conflicting revisions.',
    nothingToLoad: 'Nothing matched the load request.',
    duplicateRefConflict: 'The same ref was given conflicting revisions.',

    requestNotObject: 'The request must be an object.',
    limitNotPositive: 'limit must be a positive integer.',
    limitOverMax: 'limit exceeds the hard maximum.',
    unknownView: 'Unknown view.',
    cursorNotString: 'cursor must be a string.',
    stateViewRejectsCategory: 'The state view does not accept category.',
    stateViewRejectsCursor: 'The state view does not accept cursor.',
    listNeedsCategory: 'The available/loaded views require category.',
    categoryNotString: 'category must be a string.',
    categoryRequired: 'category is required.',
    queryRequired: 'query is required.',
    queryOverMax: 'query exceeds the length limit.',
    unknownAction: 'Unknown action.',
    unloadRejectsCandidates: 'unload does not accept candidates or names.',
    unloadNeedsToolIds: 'unload requires a non-empty toolIds array.',
    toolIdsNotStrings: 'toolIds must contain strings.',
    unloadOverActiveLimit: 'The unload count exceeds the active limit.',
    loadRejectsToolIds: 'load does not accept toolIds.',
    candidatesNamesExclusive: 'Provide exactly one of candidates or names.',
    loadNeedsOne: 'load requires candidates or names.',
    candidatesNotArray: 'candidates must be a non-empty array.',
    candidatesOverBatch: 'candidates exceeds the batch limit.',
    candidateNotObject: 'Each candidate must be an object.',
    candidateNeedsRefRevision: 'Each candidate needs a ref. revision is optional: omit it (or send an empty value) to take the version the ref is bound to, or send a non-empty string to assert an exact version.',
    namesNotArray: 'names must be a non-empty array.',
    namesOverBatch: 'names exceeds the batch limit.',
    namesNotStrings: 'names must contain strings.',
  },

  // ---- nextAction 提示 ----
  // 字段名内插：拒绝文案要指出**具体是哪个字段**，否则模型无法自我纠正。
  // 用 {field} 占位，由 formatDetail 替换。
  unknownField: 'Unknown field: {field}',
  forbiddenField: 'Field not accepted: {field}',

  nextAction: {
    stateViewNoHidden: 'State view does not enumerate hidden tools.',
    searchInCategory: 'Search in the relevant category with tool_search.',
    loadThenCall: 'Once you know the purpose, load by exact name with tool_load; if unsure, use tool_search.',
    loadedMeansSelected: 'Loaded means currently selected, not disclosed in this request.',
    browseThenSearch: 'Browse names with tool_list before searching by purpose.',
    searchAfterList: 'Now that you know the purpose, call tool_load by exact name; if unsure, call tool_search.',
    pickCandidateThenLoad: 'Select a candidate, then call tool_load with its ref. revision is optional; it defaults to the version bound to the ref.',
    rewriteOrBrowse: 'Rewrite the query, or browse names with tool_list.',
    callNextRequest: 'Once you see the tool schema next request, call the tool.',
    unloadNext: 'The next request will remove these tools.',
  },

  // ---- 类别卡片标题与摘要 ----
  categories: {
    files: { title: 'Files', summary: 'Locate, read, search and modify workspace files.' },
    shell: { title: 'Shell', summary: 'Run commands and manage persistent shells.' },
    web: { title: 'Web', summary: 'Fetch URLs and raw HTTP resources.' },
    browser: { title: 'Browser', summary: 'Drive a real browser: navigate, click, fill, inspect.' },
    desktop: { title: 'Desktop', summary: 'Control desktop UI: windows, keyboard, pointer.' },
    github: { title: 'GitHub', summary: 'Pull requests, issues, repos and review APIs.' },
    documents: { title: 'Documents', summary: 'Create and edit office documents and sheets.' },
    data: { title: 'Data', summary: 'Structured data queries, conversion and formatting.' },
    agents: { title: 'Agents', summary: 'Delegate work to subagents and manage agent teams.' },
    images: { title: 'Images', summary: 'View, crop and generate raster images.' },
    integrations: { title: 'Integrations', summary: 'MCP servers and external service connectors.' },
    other: { title: 'Other', summary: 'Anything not covered by the controlled categories.' },
  },
});

const MESSAGES_ZH = Object.freeze({
  entry: {
    tool_list: {
      description: '按类别列出可发现的工具。只返回名称——不含 schema 与描述。用于在决定加载什么之前先浏览。',
      category: '要浏览的能力类别。用 "all" 表示全部类别。',
      cursor: '上一次 list 调用返回的不透明游标。省略则从首页开始。',
      view: '要读取哪种有界视图："available"（可发现）、"loaded"（当前已激活）、"categories"（能力摘要）或 "state"（会话选择状态）。省略时：未给 category 则为 "categories"，给了 category 则为 "available"。',
      limit: '每页数量。缺省 20。',
      loadAction: '缺省 "load"。',
      candidateRef: '不透明的候选 ref。',
      candidateRevision: '候选的精确 revision（可选，缺省由 ref 推导）。',
      namesPath: '精确原生工具名称（加载路径 B）。与 candidates 互斥。',
      toolIdsUnload: '要卸载的已选工具 id（仅 action="unload"）。',
      nextAction_categories: '选一个类别，再用该类别调用 tool_list。',
      nextAction_available: '用精确名称调用 tool_load，或用 tool_search 按用途缩小范围。',
      nextAction_loaded: '这些工具已在本会话激活，直接调用即可。',
      nextAction_state: '状态视图不枚举隐藏工具。用 tool_search 发现更多。',
      nextAction_paging: '还有更多名称，传入 nextCursor 继续。',
    },
    tool_search: {
      description: '在不加载的前提下找到适合当前任务的工具。返回少量候选，附简短用途与带版本的 ref。排序是词法的，不调用任何模型。',
      query: '用自然语言描述任务（不是工具名）。',
      category: '把候选限定在某个能力类别，或用 "all" 表示全部。',
      limit: '候选上限。缺省 5。',
      nextAction_hit: '把选中的 ref 传给 tool_load；revision 可选，缺省由 ref 推导。',
      nextAction_empty: '改写 query，或用 tool_list 浏览名称。',
    },
    tool_load: {
      description: '为本会话激活工具。建议一次性批量加载当前任务所需的全部工具以最大化复用提示词缓存。加载在**下一次请求**生效——它从不执行目标工具。加载是模型的显式选择，不是用户批准。',
      names: '要加载的精确原生工具名称。',
      candidates: '由 tool_search 返回的 ref 选出的候选；revision 可选，缺省取 ref 绑定的版本。与 names 互斥。',
      action: '"load" 激活工具（唯一支持的动作）。',
      toolIds: '要卸载的工具 ID，由 tool_list 的 "loaded" 视图给出。',
      nextAction_loaded: '下一次请求你会看到这些工具的 schema，届时再调用。',
      nextAction_unloaded: '下一次请求将移除这些工具。',
    },
  },
  error: {
    INVALID_ARGS: '参数字段、数量或组合非法。',
    CATEGORY_UNAVAILABLE: '该类别不存在或当前不可见。',
    NO_MATCH: '没有相关候选。',
    CURSOR_UNAVAILABLE: '分页游标已失效，请从首页重新浏览。',
    TOOL_UNAVAILABLE: '该名称在当前范围内不可用。',
    CANDIDATE_UNAVAILABLE: '候选引用已失效，请重新检索或按名称选择。',
    STALE_CANDIDATE: '候选定义已变化，请重新检索或显式选择当前名称。',
    SELECTION_CHANGED: '验证期间当前定义已变更，请重新选择。',
    BUDGET_EXCEEDED: '已超出预算上限：请减少本次新增的工具数量，或等待一次成功的上下文压缩（由用户或 DSH 触发）释放已披露集合；已披露的工具不会为了腾出预算而被淘汰。',
    STATE_NOT_READY: '会话状态尚未就绪。',
    TOOL_NOT_LOADED: '该工具未在当前会话中显式加载。',
    TOOL_NOT_ADVERTISED: '该工具未在当前请求中披露。',
    INCOMPATIBLE_PRESENTATION: '当前展示模式不受支持。',
    INCOMPATIBLE_COMPOSITION: '当前插件组合不受支持。',
  },
  guard: {
    pendingFold: '该工具的加载正在生效，请在下一次请求中调用。',
    pendingFoldCode: 'TOOL_NOT_ADVERTISED',
  },
  error_internal: '发现内核内部错误。',
  ENGINE_DISPOSED: '发现引擎已释放。',
  missingSessionIdentityHost: '缺少宿主会话身份。',
  sessionContextUnavailable: '当前会话上下文不可用。',

  detail: {
    budgetNotObject: 'budgets 必须是对象。',
    nameOverByteBudget: '单个完整名称已超过结果字节预算。',
    categoryCardOverByteBudget: '单个类别卡片超过结果字节预算。',
    candidateCardOverByteBudget: '单个候选卡片超过结果字节预算。',
    activeToolCount: '活跃工具数量超出上限。',
    activeSchemaBytes: '活跃 schema 总字节超出上限。',
    skillResponseOverBudget: '本次技能响应超过字节预算。',
    skillVersionMismatch: '技能版本与条目不一致。',
    skillForbiddenField: '技能载荷包含禁止字段: {field}',
    unknownBudgetKey: '未知预算项: {key}',
    optionalLimitInvalid: '可选限额 {key} 必须是正整数或 null（null = 关闭）。',
    budgetKeyInvalid: '预算项 {key} 必须是正整数。',
    bytesOverBudget: '{what} 超过字节预算。',
    bindingFieldNotStringOrNull: '{key} 必须是字符串或 null。',
    duplicateToolId: '重复 toolId: {toolId}',

    bindingNotObject: '绑定不是对象。',
    bindingMissingToolId: 'toolId 缺失。',
    bindingMissingName: 'name 缺失。',
    bindingDescriptionNotString: 'description 必须是字符串。',
    bindingMissingWire: 'wire 缺失。',
    bindingWireNameMismatch: 'wire.name 与绑定名称不一致。',
    bindingWireParametersNotObject: 'wire.parameters 必须是对象。',
    bindingWireDescriptionNotString: 'wire.description 必须是字符串。',
    bindingsNotArray: 'bindings 必须是数组。',
    ambiguousName: '该名称在当前范围内存在多个绑定，需按 toolId 明确选择。',
    skillNotObject: 'skill 必须是对象或 null。',
    skillMissingRevision: 'skillRevision 缺失。',
    skillMissingUsage: 'skill usage 缺失。',
    skillLimitationsNotArray: 'skill limitations 必须是字符串数组。',

    engineConfigNotObject: 'engine config 必须是对象。',
    protocolVersionUnsupported: '协议版本不受支持。',
    categoryConfigRequired: 'categoryConfig 必填(可信配置)。',
    clockRequired: 'clock 必填。',
    randomRequired: 'random 必填。',
    missingSessionIdentity: '缺少会话身份(必须由宿主传入)。',
    operationIdRequired: 'operationId 必须由宿主提供。',
    protectedNotLoadable: '入口与常驻工具不可被加载。',
    protectedNotUnloadable: '入口与常驻工具不可被卸载。',
    modelUnloadDisabled: '不支持卸载：已加载的工具会持续披露到上下文被压缩为止，请改用加载其它工具。',
    candidateRevisionConflict: '同一工具的候选 revision 冲突。',
    nothingToLoad: '没有可加载的项。',
    duplicateRefConflict: '重复 ref 的 revision 冲突。',

    requestNotObject: '请求必须是对象根。',
    limitNotPositive: 'limit 必须是正整数。',
    limitOverMax: 'limit 超过硬上限。',
    unknownView: '未知 view。',
    cursorNotString: 'cursor 必须是字符串。',
    stateViewRejectsCategory: 'state view 不接受 category。',
    stateViewRejectsCursor: 'state view 不接受 cursor。',
    listNeedsCategory: 'available/loaded view 需要 category。',
    categoryNotString: 'category 必须是字符串。',
    categoryRequired: 'category 必填。',
    queryRequired: 'query 必填。',
    queryOverMax: 'query 超出长度上限。',
    unknownAction: '未知 action。',
    unloadRejectsCandidates: 'unload 不接受 candidates/names。',
    unloadNeedsToolIds: 'unload 需要非空 toolIds。',
    toolIdsNotStrings: 'toolIds 必须是字符串。',
    unloadOverActiveLimit: 'unload 数量超过活跃上限。',
    loadRejectsToolIds: 'load 不接受 toolIds。',
    candidatesNamesExclusive: 'candidates 与 names 必须且只能提供一项。',
    loadNeedsOne: 'load 需要 candidates 或 names 之一。',
    candidatesNotArray: 'candidates 必须非空数组。',
    candidatesOverBatch: 'candidates 超过批次上限。',
    candidateNotObject: 'candidate 必须是对象。',
    candidateNeedsRefRevision: '每个 candidate 需要 ref。revision 可选：省略（或给空值）即采用 ref 绑定的版本；给出非空字符串则断言一个确切版本。',
    namesNotArray: 'names 必须非空数组。',
    namesOverBatch: 'names 超过批次上限。',
    namesNotStrings: 'names 必须是字符串。',
  },
  unknownField: '未知字段: {field}',
  forbiddenField: '不接受字段: {field}',

  nextAction: {
    stateViewNoHidden: '状态视图不枚举隐藏工具。',
    searchInCategory: '用 tool_search 在相关类别检索。',
    loadThenCall: '知道用途后按精确名称调用 tool_load；不确定时调用 tool_search。',
    loadedMeansSelected: 'loaded 表示有效 selected，不表示当前请求已披露。',
    browseThenSearch: '浏览类别用 tool_list，按用途检索用 tool_search。',
    searchAfterList: '知道用途后按精确名称调用 tool_load；不确定时调用 tool_search。',
    pickCandidateThenLoad: '选定候选后，用其 ref 调用 tool_load；revision 可选，缺省取 ref 绑定的版本。',
    rewriteOrBrowse: '改写 query，或用 tool_list 浏览名称。',
    callNextRequest: '下一轮看到工具 schema 后，再调用原工具。',
    unloadNext: '下一轮请求将移除这些工具。',
  },
  categories: {
    files: { title: '文件', summary: '定位、读取、检索并修改工作区文件。' },
    shell: { title: 'Shell', summary: '执行命令并管理持久化终端。' },
    web: { title: 'Web', summary: '抓取 URL 与原始 HTTP 资源。' },
    browser: { title: '浏览器', summary: '驱动真实浏览器：导航、点击、填写、检查。' },
    desktop: { title: '桌面', summary: '控制桌面界面：窗口、键盘、指针。' },
    github: { title: 'GitHub', summary: '拉取请求、议题、仓库与评审 API。' },
    documents: { title: '文档', summary: '创建与编辑办公文档与表格。' },
    data: { title: '数据', summary: '结构化数据查询、转换与格式化。' },
    agents: { title: '智能体', summary: '委派工作给子代理并管理代理团队。' },
    images: { title: '图像', summary: '查看、裁剪与生成位图。' },
    integrations: { title: '集成', summary: 'MCP 服务器与外部服务连接器。' },
    other: { title: '其它', summary: '受控类别未覆盖的能力。' },
  },
});

const TABLES = Object.freeze({ en: MESSAGES, zh: MESSAGES_ZH });

/** 归一化任意输入到受支持 locale；未知/缺失一律回落默认（不猜）。 */
export function normalizeLocale (raw) {
  if (typeof raw !== 'string') return DEFAULT_LOCALE;
  const tag = raw.trim().toLowerCase().replace('_', '-');
  if (SUPPORTED_LOCALES.includes(tag)) return tag;
  const primary = tag.split('-')[0];
  if (SUPPORTED_LOCALES.includes(primary)) return primary;
  return DEFAULT_LOCALE;
}

/** 取某个 locale 的文案表。未注册 locale 回落默认表。 */
export function tableFor (locale) {
  return TABLES[normalizeLocale(locale)];
}

/**
 * 建立一个文案取值器。
 * @param {string} locale 宿主界面语言
 */
export function createText (locale) {
  const table = tableFor(locale);
  return {
    locale: normalizeLocale(locale),
    /**
     * 取文案。缺失键**不回退到英文**——缺失是接线错误，应当在测试中暴露，
     * 而不是静默产出另一种语言的文案让问题更难查。
     * @param {string[]} path 如 ['error','TOOL_NOT_LOADED']
     */
    t (path) {
      let node = table;
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[key];
      }
      return typeof node === 'string' ? node : undefined;
    },
    /**
     * 取带占位符的文案。字段名是**不可信输入**，原样插入而不翻译；
     * 未声明的 {x} 保持原样，以便一眼看出模板漏配。
     * @param {string[]} path
     * @param {Record<string,string>} vars
     */
    format (path, vars) {
      const s = this.t(path);
      if (typeof s !== 'string') return undefined;
      return s.replace(/\{(\w+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    },
    /** 类别卡片：部署可用可信配置覆盖，否则用受控默认表。 */
    category (id, override) {
      if (override !== undefined && override !== null) return override;
      const c = table.categories?.[id];
      return c === undefined ? undefined : { title: c.title, capabilitySummary: c.summary };
    },
  };
}

// ---------------------------------------------------------------------------
// 激活期语言绑定。
//
// 纯校验函数（catalog/protocol/budgets/list/skills）不接受 locale 参数——它们
// 到处 throw，逐层加参数会污染整条签名链。插件在一个 profile 下只激活一次、
// 语言也随之固定，故在此绑定一次，adapter 激活时调用 setDomainLocale()。
//
// 这是有意的取舍，不是省事：代价是这些函数不再对 locale 无状态。测试必须
// 在两种语言下各跑一遍（见 tests/unit/locale.test.mjs），一旦将来需要
// per-session 语言，就必须把 text 改成显式参数。
let currentText = createText(DEFAULT_LOCALE)

/** 激活期设置语言。由 adapter 的 apply 调用一次。 */
export function setDomainLocale (locale) {
  currentText = createText(locale)
}

/** 供纯函数模块使用的文案取值器。 */
export const domainText = currentTextProxy()

function currentTextProxy () {
  return {
    get locale () { return currentText.locale },
    t: (path) => currentText.t(path),
    format: (path, vars) => currentText.format(path, vars),
  }
}
