// Stable v2 bit order: never reorder/remove entries after a release. A new policy
// revision is required when changing defaults, templates, or this interpretation.
export const LEGACY_DESCRIPTION_TOOLS = Object.freeze(['bash', 'pwsh', 'workflow', 'read_image', 'create_goal']);
const legacy = new Set(LEGACY_DESCRIPTION_TOOLS);
export const BUILTIN_DESCRIPTION_TOOLS = Object.freeze([
  ['bash', 'shell'], ['pwsh', 'shell'], ['workflow', 'agents'], ['read_image', 'files'], ['create_goal', 'planning'],
  ['str_replace_editor', 'files'], ['glob', 'files'], ['grep', 'files'],
  ['subagent', 'agents'], ['subagent_fork', 'agents'], ['list_subagent_models', 'agents'],
  ['send_message', 'agents'], ['interrupt_agent', 'agents'],
  ['cordis_inspect_list', 'runtime'], ['cordis_inspect_query', 'runtime'], ['load_workspace_dependencies', 'runtime'],
  ['ralph', 'agents'], ['todo_write', 'planning'], ['present', 'files'], ['exit_plan_mode', 'planning'],
  ['schedule_create', 'schedules'], ['schedule_update', 'schedules'], ['schedule_delete', 'schedules'],
  ['terminal_open', 'shell'], ['terminal_send', 'shell'], ['working_directory', 'shell'],
  ['ask_user_question', 'planning'], ['skill', 'planning'],
].map(([name, group]) => Object.freeze({ name, group, defaultEnabled: legacy.has(name) })));
const names = new Set(BUILTIN_DESCRIPTION_TOOLS.map(tool => tool.name));

export function resolveBuiltinDescriptionOverrides(raw) {
  const value = typeof raw?.get === 'function' ? raw.get() : raw;
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('compactBuiltinToolOverrides must be a plain object of tool names and booleans.');
  }
  const result = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (!names.has(name) || typeof enabled !== 'boolean') {
      throw new TypeError('compactBuiltinToolOverrides requires supported tool names and boolean values.');
    }
    result[name] = enabled;
  }
  return Object.freeze(result);
}

export function selectedDescriptionTools(overrides) {
  const values = resolveBuiltinDescriptionOverrides(overrides);
  return BUILTIN_DESCRIPTION_TOOLS.filter(tool => values[tool.name] ?? tool.defaultEnabled).map(tool => tool.name);
}

export function encodeDescriptionTools(selected) {
  const set = new Set(selected);
  if ([...set].some(name => !names.has(name))) throw new TypeError('Unknown builtin description tool.');
  return BUILTIN_DESCRIPTION_TOOLS.reduce((mask, tool, index) => set.has(tool.name) ? mask | (1n << BigInt(index)) : mask, 0n).toString(16);
}

export function decodeDescriptionTools(value) {
  if (typeof value !== 'string' || !/^(0|[1-9a-f][0-9a-f]*)$/.test(value)
    || value.length > Math.ceil(BUILTIN_DESCRIPTION_TOOLS.length / 4)) return null;
  const mask = BigInt(`0x${value}`);
  if (mask >> BigInt(BUILTIN_DESCRIPTION_TOOLS.length)) return null;
  return BUILTIN_DESCRIPTION_TOOLS.filter((_tool, index) => (mask & (1n << BigInt(index))) !== 0n).map(tool => tool.name);
}
