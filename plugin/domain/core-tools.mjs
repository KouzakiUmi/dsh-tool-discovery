// DSH 核心自带工具名 —— 常驻名单的默认基线。
//
// 为什么要显式列一份：工具注册表不携带来源信息，插件在运行时无法区分某个工具来自核心安装、
// 还是来自 profile 里装的插件或 MCP server。因此核心自带的工具在这里逐一写名。
//
// 派生时点（2026-10-09，DSH NEXT @ 0.2.1-alpha.1）：对照上游
// @deepseek-ai/dsh-web-app/presets/standard.patch.yml 与各核心包逐项扫描。动态注入的子代理
// 工具（subagent、subagent_fork、list_agents）、workflow 与 exit_plan_mode 一并收录。
//
// 这是**默认值**，不是强制集合：配置里显式给出的 `alwaysVisible` 会完整替换它（包括 `[]`），
// 部署因此可以增删初始工具而无需改这个文件。某个宿主没有的名字无害：投影只保留该宿主真正
// 提供的工具。
//
// 注意（已知语义边界）：适配层的"运行时装载自证"会把当前 scope 内**可见**的核心工具并入常驻
// 名单，并且不经 load 即可执行 —— 所以**默认情况下**把某个核心工具从 `alwaysVisible` 里删掉，
// 只影响初始注入，不能阻止它回来。要让配置成为**上限**（没列出就必须先 load），把适配层的
// `respectAlwaysVisible` 打开；该开关的两个分支、三个观测面与已记录的覆盖缺口见
// plugin/docs/11-code-review-findings.md。
export const CORE_TOOL_NAMES = Object.freeze([
  // shell
  'bash', 'pwsh',
  // files
  'read', 'write', 'edit', 'str_replace_editor', 'read_image',
  // file search
  'glob', 'grep',
  // interaction
  'ask_user_question', 'present', 'skill',
  // planning / goals / plan mode
  'todo_write', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode',
  // background jobs
  'job_output', 'job_list', 'job_kill',
  // scheduling
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  // web
  'web_search', 'web_fetch',
  // subagents & delegation
  'subagent', 'subagent_fork', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent',
  // workflow
  'workflow',
  // diagnostics
  'cordis_inspect_list', 'cordis_inspect_query',
  // workspace
  'load_workspace_dependencies',
  // agent loop
  'ralph',
])