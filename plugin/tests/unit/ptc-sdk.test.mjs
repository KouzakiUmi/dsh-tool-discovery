import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtcDisclosure } from '../../adapters/dsh/ptc-sdk.mjs';
import { makeEngine, SCOPE_A, commitLoad } from './helpers.mjs';

async function setup(t, language = 'typescript') {
  const { engine } = await makeEngine();
  const agent = { id: 'actor', session: { id: SCOPE_A.sessionId } };
  const journal = { records: [], recordSdkAdvertisements(records) { this.records.push(...records); } };
  const runtime = { scope: SCOPE_A, agentScope: agent, engine, journal,
    alwaysNameSet: new Set(['read_file']), compositionBypass: null };
  const branded = new WeakSet();
  const schemas = () => [...engine.getCatalog().entries.values()].map((entry) => ({ ...entry.wire, output: { type: 'string' } }));
  const ctx = { get: () => ({ language }), tools: {
    modeFor: () => 'ptc', sdkSchemas: schemas,
    restrict: () => { throw new Error('must not restrict host permissions'); },
  } };
  let enabled = true;
  const logs = [];
  const ptc = createPtcDisclosure({ ctx, lifecycle: { sessions: new Map([[SCOPE_A.sessionId, runtime]]) },
    enabled: () => enabled, renderToolsSdk: (items) => `TS:${JSON.stringify(items)}`,
    renderToolsSdkPy: (items) => `PY:${JSON.stringify(items)}`, isAgentLoopRequest: (request) => branded.has(request),
    log: (event, data) => logs.push({ event, data }) });
  const assembly = { sections: [{ name: 'tools:sdk', text: 'full SDK' }], tools: [{ name: 'run_code' }] };
  const request = (text, mark = true) => {
    const value = { sessionId: SCOPE_A.sessionId, messages: [{ role: 'system', content: [{ type: 'text', text }] }] };
    if (mark) branded.add(value);
    return value;
  };
  t.after(() => engine.dispose());
  return { ptc, agent, runtime, engine, journal, ctx, assembly, request, logs, disable: () => { enabled = false; } };
}

test('PTC SDK 投影只披露基线和有效 selected，不改宿主资格目录', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  const items = JSON.parse(text.slice(3));
  assert.deepEqual(items.map((item) => item.name).sort(), ['glob', 'read_file', 'tool_list', 'tool_load', 'tool_search']);
  assert.equal(h.ctx.tools.sdkSchemas().some((item) => item.name === 'grep'), true);
  assert.equal(h.assembly.sections[0].text, 'full SDK');
  assert.equal(h.journal.records.length, 0, 'assemble 不算曝光');
  h.ptc.observeRequest(h.request(text, false));
  assert.equal(h.journal.records.length, 0, '伪造的 preview 请求不算曝光');
  h.ptc.observeRequest(h.request(text));
  assert.equal(h.journal.records[0].name, 'glob');
});

test('首次 load 不能追认旧 SDK：必须等包含它的新投影真正出站', async (t) => {
  const h = await setup(t);
  const old = h.ptc.project(h.agent, h.assembly, h.runtime);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  h.ptc.observeRequest(h.request(old.sections[0].text));
  assert.equal(h.journal.records.length, 0);
  const fresh = h.ptc.project(h.agent, h.assembly, h.runtime);
  h.ptc.observeRequest(h.request(fresh.sections[0].text));
  assert.deepEqual(h.journal.records.map((record) => record.name), ['glob']);
});

test('PTC 只认最新 system SDK，旧节点/用户复制/周期漂移都不能授信', async (t) => {
  const h = await setup(t);
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const mismatch = h.request(projected.sections[0].text);
  mismatch.messages.push({ role: 'system', content: [{ type: 'text', text: 'replaced SDK' }] });
  mismatch.messages.push({ role: 'user', content: [{ type: 'text', text: projected.sections[0].text }] });
  assert.throws(() => h.ptc.observeRequest(mismatch), /does not match/);
  h.engine.resetCacheEpoch(SCOPE_A);
  assert.throws(() => h.ptc.observeRequest(h.request(projected.sections[0].text)), /does not match/);
  assert.equal(h.journal.records.length, 0);
});

test('PTC off 不观测；Python 使用宿主 Python 渲染契约；缺 SDK section 明确拒绝', async (t) => {
  const h = await setup(t, 'python');
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  assert.match(projected.sections[0].text, /^PY:/);
  h.disable();
  assert.doesNotThrow(() => h.ptc.observeRequest(h.request('not the SDK')));
  assert.throws(() => h.ptc.project(h.agent, { sections: [] }, h.runtime), /exactly one/);
});

test('同 runtime 二次投影不覆盖前一次：早先请求仍按自身快照观测', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projA = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textA = projA.sections[0].text;
  await commitLoad(h.engine, SCOPE_A, { names: ['grep'] });
  const projB = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textB = projB.sections[0].text;
  assert.notEqual(textA, textB, '两次投影文本须不同，否则测不出错配');
  // 观测**前一次**请求 A：修复前会被后一次 B 的快照误拒；修复后按 A 自身快照入账。
  h.ptc.observeRequest(h.request(textA));
  assert.ok(h.journal.records.some((r) => r.name === 'glob'), 'A 的曝光按 A 快照入账');
  assert.ok(!h.journal.records.some((r) => r.name === 'grep'), '未误用后一次 B 的快照');
  // 再观测 B，仍能按 B 快照入账。
  h.ptc.observeRequest(h.request(textB));
  assert.ok(h.journal.records.some((r) => r.name === 'grep'), 'B 的曝光按 B 快照入账');
});

test('观测不消费：同一 branded 请求可重复观测（重试/复用 assembly）', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  h.ptc.observeRequest(h.request(text));
  assert.equal(h.journal.records.length, 1);
  h.ptc.observeRequest(h.request(text));   // 重试/复用同一 assembly
  assert.equal(h.journal.records.length, 2, '再次观测仍入账（观测不消费）');
});

test('只匹配到旧周期快照时报 cache-epoch-drift，而非文本失配', async (t) => {
  const h = await setup(t);
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  h.engine.resetCacheEpoch(SCOPE_A);   // 推进缓存周期，旧快照变 stale
  assert.throws(() => h.ptc.observeRequest(h.request(text)), /does not match/);
  const mismatch = h.logs.find((entry) => entry.event === 'ptc:dispatch-mismatch');
  assert.ok(mismatch, '失败应留下 dispatch-mismatch 诊断');
  assert.equal(mismatch.data.reason, 'cache-epoch-drift');
  // 呈现模式快照：这次投影与派发都在非 native，排除"tools:sdk 由宿主渲染"这条成因。
  assert.equal(mismatch.data.modeAtProjection, 'ptc');
  assert.equal(mismatch.data.modeAtDispatch, 'ptc');
  assert.equal(mismatch.data.projections.at(-1).mode, 'ptc');
});

test('出站当刻已切回 native 时不进守卫（与投影端同一 mode 判据）', async (t) => {
  const h = await setup(t);
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  h.ctx.tools.modeFor = () => 'native';   // 请求发出前该 scope 已切回 native
  h.ptc.observeRequest(h.request(text));
  assert.equal(h.logs.some((entry) => entry.event === 'ptc:dispatch-mismatch'), false,
    'native 出站应早退，不产生守卫诊断');
});

test('同 text 双投影可正常观测入账（走取最新快照路径，不炸）', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  h.ptc.project(h.agent, h.assembly, h.runtime);   // 快照 1
  const projB = h.ptc.project(h.agent, h.assembly, h.runtime);   // 快照 2（同 text）
  const text = projB.sections[0].text;
  h.ptc.observeRequest(h.request(text));
  assert.equal(h.journal.records.length, 1, '观测入账一次');
  assert.equal(h.journal.records[0].name, 'glob');
});

test('重复同 text 预览不挤掉唯一 text 的在途快照', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projA = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textA = projA.sections[0].text;
  await commitLoad(h.engine, SCOPE_A, { names: ['grep'] });
  // 重复 project B（同 text）多次，模拟重复预览/更新
  let textB;
  for (let i = 0; i < 8; i++) textB = h.ptc.project(h.agent, h.assembly, h.runtime).sections[0].text;
  assert.notEqual(textA, textB);
  // A 仍应可被观测（未被重复同 text 预览挤掉）
  h.ptc.observeRequest(h.request(textA));
  assert.ok(h.journal.records.some((r) => r.name === 'glob'), 'A 未被重复同 text 预览挤掉');
});

test('新周期 project 后观测旧周期文本：诊断仍归 cache-epoch-drift', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projA = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textA = projA.sections[0].text;
  h.engine.resetCacheEpoch(SCOPE_A);   // 推进周期
  await commitLoad(h.engine, SCOPE_A, { names: ['grep'] });   // 改 selected → text 变
  const projB = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textB = projB.sections[0].text;
  assert.notEqual(textA, textB);
  // project B 已发生，但旧 A 快照保留；观测旧周期 textA
  assert.throws(() => h.ptc.observeRequest(h.request(textA)), /does not match/);
  const mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'cache-epoch-drift', '旧周期证据保留，诊断仍归 cache-epoch-drift');
  assert.equal(mismatch.data.snapshotEpochs.length, 2, '旧周期快照仍在诊断中可见，未被新 project 清除');
});

test('PENDING_LIMIT 淘汰路径：恰 8 全存活', async (t) => {
  const h = await setup(t);
  // 8 个不同 text（避开 alwaysNameSet 的 read_file，确保 text 各异），全部在途未观测
  const names = ['glob', 'grep', 'edit_file', 'run_shell', 'web_fetch', 'web_search', 'browser_click', 'desktop_type'];
  const texts = [];
  for (const name of names) {
    await commitLoad(h.engine, SCOPE_A, { names: [name] });
    texts.push(h.ptc.project(h.agent, h.assembly, h.runtime).sections[0].text);
  }
  assert.equal(new Set(texts).size, 8, '应产生 8 个不同 text');
  // 恰 8 个全存活：每个都能观测
  for (const text of texts) assert.doesNotThrow(() => h.ptc.observeRequest(h.request(text)));
});

test('超限时已观测快照被淘汰，其重试归 evicted-snapshot（非文本失配）', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const projA = h.ptc.project(h.agent, h.assembly, h.runtime);
  const textA = projA.sections[0].text;
  h.ptc.observeRequest(h.request(textA));   // A 已观测
  // 压到 9 槽：8 个不同 text（避开 read_file），各 project 一次
  const more = ['grep', 'edit_file', 'run_shell', 'web_fetch', 'web_search', 'browser_click', 'desktop_type', 'github_list_pr'];
  for (const name of more) {
    await commitLoad(h.engine, SCOPE_A, { names: [name] });
    h.ptc.project(h.agent, h.assembly, h.runtime);
  }
  // 9 个不同 text，observed 优先淘汰 A；A 的重试应失败且归 evicted-snapshot
  assert.throws(() => h.ptc.observeRequest(h.request(textA)), /does not match/);
  const mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'evicted-snapshot', '已观测快照被淘汰，重试归 evicted-snapshot');
});

test('无快照时归 projection-missing，无非空 system 归 no-system-text', async (t) => {
  const h = await setup(t);
  // projection-missing：从不 project，直接 observe
  assert.throws(() => h.ptc.observeRequest(h.request('anything')), /does not match/);
  let mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'projection-missing');
  // no-system-text：project 后用 system 文本为空的请求（无非空 system）
  h.logs.length = 0;
  h.ptc.project(h.agent, h.assembly, h.runtime);
  assert.throws(() => h.ptc.observeRequest(h.request('')), /does not match/);
  mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'no-system-text');
});

test('空 SDK 渲染文本不会通过 includes("") 误匹配任意 system 提示词', async (t) => {
  const { engine } = await makeEngine();
  t.after(() => engine.dispose());
  const agent = { id: 'actor', session: { id: SCOPE_A.sessionId } };
  const journal = { records: [], recordSdkAdvertisements(records) { this.records.push(...records); } };
  const runtime = { scope: SCOPE_A, agentScope: agent, engine, journal,
    alwaysNameSet: new Set(['read_file']), compositionBypass: null };
  const branded = new WeakSet();
  const logs = [];
  const ptc = createPtcDisclosure({
    ctx: { get: () => ({ language: 'typescript' }), tools: { modeFor: () => 'ptc', sdkSchemas: () => [] } },
    lifecycle: { sessions: new Map([[SCOPE_A.sessionId, runtime]]) },
    enabled: () => true, renderToolsSdk: () => '', renderToolsSdkPy: () => '',
    isAgentLoopRequest: (req) => branded.has(req), log: (event, data) => logs.push({ event, data }),
  });
  await commitLoad(engine, SCOPE_A, { names: ['glob'] });
  ptc.project(agent, { sections: [{ name: 'tools:sdk', text: 'full SDK' }], tools: [] }, runtime);
  const req = { sessionId: SCOPE_A.sessionId, messages: [{ role: 'system', content: [{ type: 'text', text: 'unrelated system prompt' }] }] };
  branded.add(req);
  assert.throws(() => ptc.observeRequest(req), /does not match/);
  assert.equal(journal.records.length, 0);
  const mismatch = logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'outgoing-text-mismatch');
});

test('同周期重投影已观测文本保留 observed 标记，超限时仍优先于未观测快照被淘汰', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const textA = h.ptc.project(h.agent, h.assembly, h.runtime).sections[0].text;
  h.ptc.observeRequest(h.request(textA)); // A 已观测
  // 同周期重投影 A（例如预览），不应洗掉 A 的 observed=true
  h.ptc.project(h.agent, h.assembly, h.runtime);
  const more = ['grep', 'edit_file', 'run_shell', 'web_fetch', 'web_search', 'browser_click', 'desktop_type', 'github_list_pr'];
  const unobservedTexts = [];
  for (const name of more) {
    await commitLoad(h.engine, SCOPE_A, { names: [name] });
    unobservedTexts.push(h.ptc.project(h.agent, h.assembly, h.runtime).sections[0].text);
  }
  // 8 个未观测快照应全部存活，而已观测的 A 被优先淘汰
  for (const text of unobservedTexts) assert.doesNotThrow(() => h.ptc.observeRequest(h.request(text)));
  assert.throws(() => h.ptc.observeRequest(h.request(textA)), /does not match/);
  const mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'evicted-snapshot');
});

test('旧周期快照被淘汰进 evicted 后，在新周期命中仍归因 cache-epoch-drift', async (t) => {
  const h = await setup(t);
  await commitLoad(h.engine, SCOPE_A, { names: ['glob'] });
  const textOld = h.ptc.project(h.agent, h.assembly, h.runtime).sections[0].text;
  h.engine.resetCacheEpoch(SCOPE_A);
  const more = ['grep', 'edit_file', 'run_shell', 'web_fetch', 'web_search', 'browser_click', 'desktop_type', 'github_list_pr'];
  for (const name of more) {
    await commitLoad(h.engine, SCOPE_A, { names: [name] });
    h.ptc.project(h.agent, h.assembly, h.runtime);
  }
  // textOld 因旧周期被淘汰入 evicted；此时收到携带 textOld 的请求应归因 cache-epoch-drift 而非 evicted-snapshot
  assert.throws(() => h.ptc.observeRequest(h.request(textOld)), /does not match/);
  const mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'cache-epoch-drift');
  assert.equal(mismatch.data.modeAtProjection, 'ptc');
});

test('firstDivergenceOf 短前缀回退能定位前 120 字符内的分叉点', async (t) => {
  const h = await setup(t);
  const projected = h.ptc.project(h.agent, h.assembly, h.runtime);
  const text = projected.sections[0].text;
  assert.ok(text.length > 60);
  // 在第 36 字符处篡改（大于 24 字符短锚点，小于 120 字符长锚点）
  const mutated = `prefix\n${text.slice(0, 36)}__MUTATED__${text.slice(47)}`;
  assert.throws(() => h.ptc.observeRequest(h.request(mutated)), /does not match/);
  const mismatch = h.logs.find((e) => e.event === 'ptc:dispatch-mismatch');
  assert.equal(mismatch.data.reason, 'outgoing-text-mismatch');
  assert.equal(mismatch.data.firstDivergence?.offset, 36);
  assert.equal(mismatch.data.firstDivergence?.projectedTotal, text.length);
});

