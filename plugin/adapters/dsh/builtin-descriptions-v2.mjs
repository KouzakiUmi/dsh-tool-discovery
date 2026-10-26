// Reviewed v2 additions. v1 remains immutable for old cache epochs.
import { V2_DESCRIPTION_SOURCES } from './builtin-descriptions-v2-sources.mjs';

const COPY = {
  str_replace_editor: {
    en: 'Persistent file viewer/editor. view shows numbered file content or non-hidden directory entries up to two levels deep. create refuses an existing file. Long output is truncated with <response clipped>. Unused null parameters count as omitted; required parameters still need values. For str_replace, old_str must exactly match consecutive original lines including whitespace and occur only once; add context if ambiguous. new_str replaces those lines; to delete, omit new_str rather than pass null.',
    zh: '查看、创建和编辑文件，状态跨调用和对话保留。view 显示文件行号，或列出目录下两层内的非隐藏文件与目录；create 不覆盖已有文件。长输出用 <response clipped> 标记截断。不适用参数的 null 按省略处理，必需参数仍须赋值。str_replace 的 old_str 必须逐字匹配连续原文（含空白）且唯一；不唯一时补足上下文。new_str 是替换内容；删除匹配时省略 new_str，不要传 null。',
  },
  cordis_inspect_list: {
    en: 'List known Host and synchronized Client Inspect providers, their platforms, purposes, read-only methods and schemas. Before writing/configuring plugins, use this list to choose a provider/method for cordis_inspect_query. Do not guess names or treat Inspect methods as business Service APIs.',
    zh: '列出 Host 已知及从 Client 同步的 Inspect Provider：平台、用途、只读方法和输入/输出 schema。编写或配置插件前先查此目录，再选 provider/method 调用 cordis_inspect_query。不得猜名称，Inspect 方法不是插件可调用的业务 Service API。',
  },
  cordis_inspect_query: {
    en: 'Run a read-only Inspect query. Take platform/provider/method from cordis_inspect_list and satisfy its input schema. Before plugin work, inspect exact service/event/config/tool/UI contracts here. Host queries run locally; Client queries await the first valid page response until timeout, then report failure or reconnection guidance. Cannot invoke business Service methods or change runtime state.',
    zh: '执行只读 Inspect 查询。platform/provider/method 必须来自 cordis_inspect_list，input 须符合方法 schema。写插件前核对 Service、Event、Config、Tool、主题和 Slot 树/props 契约。Host 查询在本地执行；Client 等待时限内第一个有效页面响应，否则报失败或提示重连。不能调用业务 Service 方法或修改运行时。',
  },
  load_workspace_dependencies: {
    en: 'Return bundled Python/library paths and distribution versions; include Node.js/pnpm paths when shipped. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml and XlsxWriter. Use them for Office work unless user/workspace instructions select otherwise. Run the returned pnpm script with the returned Node executable. PATH and package-manager settings are unchanged.',
    zh: '返回内置 Python、库目录的绝对路径及发行版本；含 Node.js/pnpm 时也返回其路径。内置 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml、XlsxWriter。Office 任务优先用这些库，用户或工作区另有指定除外。用返回的 Node 执行返回的 pnpm 脚本；不更改 PATH 或包管理器配置。',
  },
  ralph: {
    en: 'Run a foreground fresh-agent Ralph loop for one immutable objective, only on explicit human request for Ralph/fresh-agent iteration. Each round starts without parent or prior-child conversation; shared workspace is durable memory, with only a bounded structured report passed between rounds. Return on worker-reported completion/blocker or round limit. Use goal tools for ordinary same-session long-running work.',
    zh: '仅在用户明确要求 Ralph/全新代理迭代时，为一个不变目标运行前台循环。每轮新建子代理，不继承父或前轮子代理对话；共享工作区充当长期记忆，轮间只传有界结构化报告。收到工作代理报告完成、具体阻塞或达到轮数上限时返回。普通同会话长期任务用 goal 工具。',
  },
  present: {
    en: 'Declare existing files as final deliverables, especially Office documents, sheets or slides. Prefer a final response if sufficient. The user opens the current files; contents are not copied.',
    zh: '把已存在的文件声明为最终交付物，适合 Office 文档、表格或幻灯片；直接回复足够时优先回复。用户打开的是当前文件，不复制文件内容。',
  },
  send_message: {
    en: 'Message an agent: active agents receive it next step; idle agents start a new turn. Returns delivery confirmation, not the answer.',
    zh: '给代理发消息：工作中的代理下一步接收，空闲代理开始新一轮。返回投递确认，不是代理答案。',
  },
  interrupt_agent: {
    en: 'Request a subagent stop; returns without waiting. Local direct children can later continue via send_message. External executions stop permanently with no follow-ups. Its own children keep running.',
    zh: '请求子代理停止当前工作，不等待停止完成。本地直属子代理可稍后用 send_message 续聊；外部执行永久停止且不能续聊。它创建的子代理仍继续运行。',
  },
  list_subagent_models: {
    en: 'Inspect child LLM routes without changing the current agent: no args lists providers; provider lists its models; provider+model inspects that model and efforts. The catalog is advisory; adapters may accept unlisted model IDs. Use returned IDs in delegation provider/model/reasoning_effort.',
    zh: '查询子代理 LLM 路由，不改变当前代理。不传参数列 provider；传 provider 列模型；同时传 provider/model 查指定模型及思考档位。目录仅供参考，适配器可能接受未列出的模型 ID。将返回 ID 用于委派的 provider/model/reasoning_effort。',
  },
  schedule_create: {
    en: 'Schedule a reminder delivering prompt to this session. Set exactly one of after_seconds/at/every_seconds/daily/weekly/cron. Skip nonexistent local times; repeated local times fire once at the earlier instant. After downtime, recurring schedules deliver only the latest missed occurrence. Crashes may duplicate delivery.',
    zh: '创建到期向本会话投递 prompt 的提醒。after_seconds/at/every_seconds/daily/weekly/cron 必须且只能选一个。跳过时区中不存在的本地时间；重复本地时间仅在较早时刻触发一次。停机后循环提醒仅补投最近一次错过的事件；崩溃后可能重复投递。',
  },
  schedule_update: {
    en: 'Update a reminder, preserving its id. Supply a new title, prompt, or at most one timing selector; omitted fields stay unchanged. For a new relative delay, create a new reminder.',
    zh: '更新提醒并保留 ID。可改 title/prompt，最多选一种时间参数；省略字段保持原值。要更改相对延迟，请创建新提醒。',
  },
  schedule_delete: {
    en: 'Delete an active or inactive reminder from this session. Already queued messages are not retracted.',
    zh: '删除本会话中活动或非活动的提醒，不撤回已排队的提醒消息。',
  },
  grep: {
    en: 'Search files with a ripgrep regex. Return matching lines and numbers grouped by file, up to 250 matches; larger results include the saved full-list path.',
    zh: '用 ripgrep 正则搜索文件内容，按文件分组返回匹配行与行号，最多 250 项；超出时给出完整匹配列表的保存路径。',
  },
  terminal_open: {
    en: 'Open an owner-isolated persistent terminal from a registered backend for shell/REPL state shared across tool calls.',
    zh: '从已注册后端创建归当前代理隔离所有的持久终端，用于跨调用保留 shell/REPL 状态。',
  },
  working_directory: {
    en: 'Read the working directory or change it with cd. Relative paths use it; existing shells/processes keep their own directories.',
    zh: '读取当前工作目录，或用 cd 更改；相对路径基于当前目录。已有 shell 和运行中进程的目录不变。',
  },
  exit_plan_mode: {
    en: 'Plan mode only: submit a plan for review. Approval exits plan mode; execute from the next step. Otherwise stay in planning, revise using returned feedback and resubmit.',
    zh: '仅限规划模式：提交计划供审阅。批准后退出规划，从下一步执行；否则继续规划，依据返回意见修改并重新提交。',
  },
  skill: {
    en: 'Load full skill instructions before acting on a task that names or clearly matches a skill in this session catalog.',
    zh: '加载技能完整指令。任务点名或明确匹配本会话目录中的技能时，行动前先加载。',
  },
  ask_user_question: {
    en: 'Ask brief, direct, self-contained questions for missing information/preferences/decisions. Use user-facing terms, not unexplained internals; use distinct stable IDs. A submitted skip has empty selected and no custom. pending means no batch arrived before timeout; the user can still answer.',
    zh: '就缺失信息、偏好或决策提简短直接且自足的问题。使用用户能理解的术语，不假设知道后台工作或内部名称；问题 ID 须稳定且互不重复。已提交的跳过答案为 selected 空且无 custom；pending 表示超时前尚未收到整批答案，用户仍可回答。',
  },
  bash: {
    en: 'Run commands in this agent\'s persistent bash shell; current directory and exported environment persist between calls.',
    zh: '在当前代理的持久 bash 中执行命令；工作目录和导出的环境变量跨调用保留。',
  },
  pwsh: {
    en: 'Run commands in this agent\'s persistent PowerShell; current directory and exported environment persist between calls.',
    zh: '在当前代理的持久 PowerShell 中执行命令；工作目录和导出的环境变量跨调用保留。',
  },
};

function delegation(variant, language) {
  if (language === 'zh') {
    let text = variant.inherits
      ? '委派给继承已完成对话轮次的子代理，不含当前在途轮次；只需提供新增任务上下文。'
      : '委派独立任务给不共享本对话的子代理，须提供完整自足的任务上下文。';
    text += '立即返回独立管理的子代理 ID；完成时通知，只交付结果而非中间步骤。';
    text += variant.continuable ? '子代理用 send_message 报告；可用它引导在途工作或稍后续聊。' : '完成通知包含最终答案；此后端不接受续聊。';
    if (variant.selectable) {
      text += '可选 LLM：省略 provider/model/reasoning_effort 时采用已配置的子代理默认值及' + (variant.defaults ? '后端路由默认值。' : '兼容的父代理补充值。');
      text += '覆盖前用 list_subagent_models 查路由和档位，provider/model 必须成对给出；换路由且未指定档位时用新模型默认档位。';
      if (variant.inherits) text += '换路由可能无法复用继承对话的服务端前缀缓存。';
    }
    return text;
  }
  let text = variant.inherits
    ? 'Start a child seeded with completed conversation turns, not the current in-flight turn; provide only new task context. '
    : 'Start a separate child without this conversation; provide a complete, self-contained task. ';
  text += 'Returns its independently managed id immediately; completion is notified. You receive results, not intermediate steps. ';
  text += variant.continuable ? 'The child reports via send_message; use it to steer active work or continue later.' : 'The completion notice contains the final answer; this backend accepts no follow-ups.';
  if (variant.selectable) {
    text += ' Optional LLM selection: omit provider/model/reasoning_effort to use configured child defaults and ' + (variant.defaults ? 'provider route defaults.' : 'compatible parent values.');
    text += ' To override, inspect list_subagent_models, then give provider and model together. A changed route without an explicit effort uses the selected model default.';
    if (variant.inherits) text += ' Route changes can prevent reuse of the inherited provider-side prefix cache.';
  }
  return text;
}

function copy(name, variant, language) {
  if (name === 'subagent' || name === 'subagent_fork') return delegation(variant, language);
  if (name === 'todo_write') {
    if (language === 'zh') return '为多步骤工作维护任务清单，简单单步任务跳过。开始前按具体步骤建项；工作未结束时，' + (variant.allowParallelInProgress ? '正在处理的项标为 in_progress，仅并行工作可同时有多项。' : '保持恰好一项 in_progress。') + '每项完成后立即标为 completed。';
    return 'Maintain a task list for multi-step work, not trivial tasks. Add concrete steps before starting; while work remains, ' + (variant.allowParallelInProgress ? 'mark active work in_progress, multiple only for parallel work. ' : 'keep exactly one item in_progress. ') + 'Mark each step completed immediately when done.';
  }
  if (name === 'glob') {
    if (language === 'zh') return '按 glob 查文件而非目录，包含隐藏及忽略文件。按修改时间排序，最多返回 100 个路径；超出时' + (variant.sampleOverCapGlobResults ? '跨顶层项目抽样' : '保留前 100 项') + '，并给出完整列表的保存路径。';
    return 'Find files (not directories) by glob, including hidden/ignored files. Return up to 100 paths in modification-time order; over the cap, ' + (variant.sampleOverCapGlobResults ? 'sample across top-level entries' : 'keep the first paths') + ' and report the saved full-list path.';
  }
  if (name === 'terminal_send') {
    if (language === 'zh') return '向持久终端发送文本，默认提交 Enter；等到提示符、stdin 等待、输出静默、超时或会话退出。' + (variant.enableRunInBackground ? '后台模式返回供 job_output/job_kill 使用的 job ID。' : '');
    return 'Send text to a persistent terminal; Enter is submitted by default. Wait for prompt/stdin wait/output silence/timeout/session exit.' + (variant.enableRunInBackground ? ' Background returns a job id for job_output/job_kill.' : '');
  }
  if (!COPY[name]) throw new Error(`Missing reviewed builtin description: ${name}`);
  return COPY[name][language];
}

export const V2_ADDITIONAL_DESCRIPTION_RULES = Object.freeze(V2_DESCRIPTION_SOURCES.map(source => Object.freeze({
  name: source.name, sourceDigests: Object.freeze([source.sourceDigest]),
  en: copy(source.name, source.variant, 'en'), zh: copy(source.name, source.variant, 'zh'),
})));
