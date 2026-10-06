// DSH core's built-in tool names — the always-visible baseline.
//
// Why a list at all: the tools registry carries no provenance, so the plugin
// cannot tell at runtime which tool came from the core install and which from a
// profile-installed plugin or an MCP server. Everything the core ships is
// therefore named explicitly.
//
// Derivation (2026-10-06, DSH NEXT @ 0.2.1-alpha.1): every `@deepseek-ai/dsh-tool-*`
// package in the core install was scanned for the tool names it registers, using
// two independent extraction passes that agreed exactly on 32 names. Packages
// that register no tool (dsh-tool-workflow, dsh-tool-call-timeout-policy) and
// aliases of the same name across packages (bash / pwsh) are folded in once.
//
// This is the *baseline*, not a closed set: `alwaysVisible` in the plugin config
// is merged on top of it, so a deployment can add its own without editing this
// file. Names here that a given host does not have are harmless — the projection
// only ever keeps tools the host already put in the assembly.
export const CORE_TOOL_NAMES = Object.freeze([
  // shell
  'bash', 'pwsh',
  // files
  'read', 'write', 'edit', 'str_replace_editor', 'read_image',
  // file search
  'glob', 'grep',
  // interaction
  'ask_user_question', 'present', 'skill',
  // planning / goals
  'todo_write', 'get_goal', 'create_goal', 'update_goal',
  // background jobs
  'job_output', 'job_list', 'job_kill',
  // scheduling
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  // web
  'web_search', 'web_fetch',
  // subagents
  'list_subagent_models', 'send_message', 'interrupt_agent',
  // diagnostics
  'cordis_inspect_list', 'cordis_inspect_query',
  // workspace
  'load_workspace_dependencies',
  // agent loop
  'ralph',
])