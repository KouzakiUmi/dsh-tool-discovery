// progressive-v2/tests/unit/helpers.mjs
// **人工单测 fixture**:全部手写,不复制 quality/fixtures 的描述当 query,
// 不读取任何 held-out query / labels / quality-review 报告。
// 这些数据与真实 registry 无关,只是稳定的测试输入。

/**
 * 可控时钟。
 * @param {number} [start]
 */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/** 确定性随机源(便于断言 ref 形状,不是加密用途)。 */
export function fakeRandom() {
  let n = 0;
  return {
    bytes(len) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = (n + i) & 0xff;
      n += len;
      return out;
    },
  };
}

/** @param {Partial<{toolId:string,name:string,description:string,params:object,namespace:string|null,skill:object|null,skillRevision:string}>} o */
export function binding(o) {
  const name = o.name;
  const description = o.description ?? `synthetic description for ${name}`;
  return {
    toolId: o.toolId ?? `t_${name}`,
    name,
    description,
    wire: {
      name,
      description,
      parameters: o.params ?? { type: 'object', properties: {}, additionalProperties: false },
    },
    providerNamespace: o.namespace ?? null,
    bindingGeneration: o.generation ?? 'gen1',
    shadowOf: o.shadowOf ?? null,
    trustedCategoryOverride: o.override ?? null,
    skill: o.skill === null
      ? null
      : (o.skill ?? {
        skillRevision: o.skillRevision ?? 's1',
        usage: `usage guidance for ${name}`,
        limitations: [`limitation for ${name}`],
      }),
  };
}

/** 12 个受控类别的可信配置。 */
export const CATEGORY_CONFIG = Object.freeze({
  files: { title: 'files', capabilitySummary: 'read, locate and modify files' },
  shell: { title: 'shell', capabilitySummary: 'run commands' },
  web: { title: 'web', capabilitySummary: 'fetch web pages' },
  browser: { title: 'browser', capabilitySummary: 'inspect and control web pages' },
  desktop: { title: 'desktop', capabilitySummary: 'control the desktop' },
  github: { title: 'github', capabilitySummary: 'collaborate on code repositories' },
  documents: { title: 'documents', capabilitySummary: 'read and write office documents' },
  data: { title: 'data', capabilitySummary: 'query and transform data' },
  agents: { title: 'agents', capabilitySummary: 'delegate to subagents' },
  images: { title: 'images', capabilitySummary: 'view and generate images' },
  integrations: { title: 'integrations', capabilitySummary: 'connect external services' },
  other: { title: 'other', capabilitySummary: 'other capabilities' },
});

/** 一组稳定的人工 fixture 绑定。 */
export function sampleBindings() {
  return [
    binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files', description: 'enumerate file entries by path pattern' }),
    binding({ name: 'grep', toolId: 't_files_grep', namespace: 'files', description: 'search text inside file contents' }),
    binding({ name: 'read_file', toolId: 't_files_read', namespace: 'files', description: 'read a file body' }),
    binding({ name: 'edit_file', toolId: 't_files_edit', namespace: 'files', description: 'modify a located file region' }),
    binding({ name: 'run_shell', toolId: 't_shell_run', namespace: 'shell', description: 'execute a shell command' }),
    binding({ name: 'web_fetch', toolId: 't_web_fetch', namespace: 'web', description: 'fetch a web page over http' }),
    binding({ name: 'web_search', toolId: 't_web_search', namespace: 'web', description: 'query a web search engine' }),
    binding({ name: 'browser_click', toolId: 't_browser_click', namespace: 'browser', description: 'click an element on a page' }),
    binding({ name: 'desktop_type', toolId: 't_desktop_type', namespace: 'desktop', description: 'type text on the desktop' }),
    binding({ name: 'github_list_pr', toolId: 't_github_pr', namespace: 'github', description: 'list pull requests' }),
    binding({ name: 'docx_read', toolId: 't_doc_read', namespace: 'documents', description: 'read an office document' }),
    binding({ name: 'xlsx_write', toolId: 't_xls_write', namespace: 'documents', description: 'write a spreadsheet' }),
    binding({ name: 'unit_convert', toolId: 't_data_convert', namespace: 'data', description: 'convert numeric units' }),
    binding({ name: 'spawn_agent', toolId: 't_agents_spawn', namespace: 'agents', description: 'spawn a subagent' }),
    binding({ name: 'view_image', toolId: 't_images_view', namespace: 'images', description: 'view an image file' }),
    binding({ name: 'generate_image', toolId: 't_images_gen', namespace: 'images', description: 'generate an image' }),
    binding({ name: 'mcp_bridge', toolId: 't_int_bridge', namespace: 'integrations', description: 'bridge to an external integration' }),
    binding({ name: 'misc_thing', toolId: 't_other_thing', description: 'a capability with no structural hint' }),
    binding({ name: 'tool_list', toolId: 't_entry_list', description: 'entry point list' }),
    binding({ name: 'tool_search', toolId: 't_entry_search', description: 'entry point search' }),
    binding({ name: 'tool_load', toolId: 't_entry_load', description: 'entry point load' }),
    binding({ name: 'final_answer', toolId: 't_fw_final', description: 'framework required terminator' }),
  ];
}

/** 构造一个默认 engine。 */
export async function makeEngine(overrides = {}) {
  const { createDiscoveryEngine } = await import('../../domain/index.mjs');
  const clock = overrides.clock ?? fakeClock();
  const engine = createDiscoveryEngine({
    bindings: overrides.bindings ?? sampleBindings(),
    categoryConfig: CATEGORY_CONFIG,
    entryToolNames: ['tool_list', 'tool_search', 'tool_load'],
    frameworkToolNames: ['final_answer'],
    clock,
    random: fakeRandom(),
    generation: 'g1',
    newSessionMode: overrides.newSessionMode ?? 'ready',
    ...(overrides.engineConfig || {}),
  });
  return { engine, clock };
}

export const SCOPE_A = Object.freeze({ sessionId: 'sess_A', actorId: 'actor_A' });
export const SCOPE_B = Object.freeze({ sessionId: 'sess_B', actorId: 'actor_B' });
export const SCOPE_FORK = Object.freeze({ sessionId: 'sess_A_fork', actorId: 'actor_A_fork' });

let opCounter = 0;
let seqCounter = 0;
/** 宿主产生的 operationId(不是模型可控的任意事务 ID)。 */
export function nextOpId(prefix = 'op') {
  opCounter += 1;
  return `${prefix}_${String(opCounter).padStart(4, '0')}`;
}

/** 宿主 journal seq。每条成功折叠的 canonical 对应一个递增 seq。 */
export function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

/**
 * handleLoad 只产生 pending；selected 必须等 adapter 确认 canonical 对之后才变。
 * 本助手模拟“宿主已确认最终成功回执”这一步，供需要观察 selected 的单测使用。
 * @param {any} engine
 * @param {any} scope
 * @param {any} input
 */
export async function commitLoad(engine, scope, input) {
  const op = nextOpId();
  const res = await engine.handleLoad(input, scope, { operationId: op });
  if (!res.response.ok) return { response: res.response, applied: false };
  const out = engine.applyCanonicalPair({
    seq: nextSeq(),
    call: { operationId: op, tool: 'tool_load', input },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, scope);
  return { response: res.response, applied: out.applied, reason: out.reason };
}

/**
 * 构造一对 canonical tool/call → tool/result(模拟宿主已确认的对)。
 * @param {{seq:number, operationId:string, input:any, payload:any, isError?:boolean, ok?:boolean}} o
 */
export function pair(o) {
  return {
    seq: o.seq,
    call: { operationId: o.operationId, tool: 'tool_load', input: o.input },
    result: {
      isError: o.isError ?? false,
      ok: o.ok ?? true,
      payload: o.payload,
    },
  };
}
