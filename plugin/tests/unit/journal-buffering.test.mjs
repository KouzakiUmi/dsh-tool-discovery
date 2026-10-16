// 恢复缓冲的收口 + 在途 load 的预算收口 —— 产品语义单测。**纯可移植**：
// 不导入任何宿主 SDK（store / query / registry 全部经 deps 注入，与
// lifecycle-settlement.test.mjs 同一纪律），因此无 node_modules 也能跑。
//
// ## 这两个缺陷的共同形状
//
// 都是「某个进程内状态**没有读者了，但没人让它归零**」：
//   * JB-U1/U2：journal 的恢复缓冲。bootstrap 路径不读快照，于是那份缓冲永远没人读，
//     却仍在每个 `session/event` 上累加（含 payload 为完整出站 tools 数组的
//     `request/header`）。lifecycle 的 `MAX_BUFFERED_EVENTS` 只封顶 runtime 建立
//     **之前**的那一层，封不到这一层。
//   * JB-U5/U6：journal 的 liveCalls 与 engine 的 pending。配对现场被丢弃了，
//     engine 侧的 `op_<callId>` 预算预留却还留着，为一个从未生效的 load 占额度。
//
// ## fixture 的性质（报告措辞必须与之一致）
//
// 事件是**按 journal 的 canonical 契约声明式注入**的（与 lifecycle-settlement.test.mjs
// 同一性质），不是宿主真实跑出来的流；store 也是注入的 fake。本文件证明的是
// **产品代码在该时序下的行为**，不证明线上自然时序已复现。
//
// ## 「缓冲里还剩多少」怎么观测
//
// `buffer` 是 journal 的私有状态，不为测试开洞。观测点取 restore 的**合并输入**：
// `mergeBySeq(快照, buffer)` 的结果长度被原样写进 `restore:folded` 日志的 `events`。
// 于是「缓冲是否已收口」= 该字段是否等于快照自身的长度。用例里的序号从 0 连续，
// 满足 journal 的 `isContiguousSeqStream` 前提（否则会走 fail closed 分支）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createJournal, foldPairs } from '../../adapters/dsh/journal.mjs';
import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';
import { epochKeyOfRecord } from '../../adapters/dsh/trusted-epoch.mjs';
import { makeEngine, sampleBindings, fakeRandom } from './helpers.mjs';

const CLOCK_START = 1_700_000_000_000;
const clock = { now: () => CLOCK_START };
const random = fakeRandom();

const CATEGORY_CONFIG = Object.freeze({
  files: { title: 'files', capabilitySummary: 'files' },
  other: { title: 'other', capabilitySummary: 'other' },
});

/** 出站 header 事件：payload 里带 tools —— 缓冲若不收口，累积的就是这些对象。 */
const headerEvent = (seq) => ({
  seq, type: 'request/header', data: { header: { tools: [{ name: 'glob' }] } },
});

const toolCallEvent = (seq, callId, names) => ({
  seq, type: 'tool/call', data: { name: 'tool_load', callId, arguments: JSON.stringify({ names }) },
});

const toolResultEvent = (seq, callSeq, receipt) => ({
  seq,
  sourceEventSeqs: [callSeq],
  type: 'tool/result',
  data: {
    message: {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ protocolVersion: 2, tool: 'tool_load', ok: true, data: { receipt } }) }],
    },
  },
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function drain(rounds = 200) { for (let i = 0; i < rounds; i++) await Promise.resolve(); }

const foldedDetail = (logs) => {
  const hit = logs.find(([event]) => event === 'restore:folded');
  assert.ok(hit !== undefined, 'restore 必须走到折叠收尾并留下 restore:folded 日志');
  return hit[1];
};

/** 注入的 fake durable store（与 lifecycle-settlement.test.mjs 的 storeBase 同形状）。 */
function fakeStore(seed = {}) {
  return {
    map: new Map(Object.entries(seed)),
    async ensureOpen() { return { ok: true }; },
    get(key) { return this.map.get(key); },
    async put(record) { this.map.set(epochKeyOfRecord(record), structuredClone(record)); },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// 缺陷 1：恢复缓冲必须被显式收口
// ---------------------------------------------------------------------------

test('JB-U1 stopBuffering 之后到达的事件不再留在缓冲里（幂等）', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  const scope = { sessionId: 'sess_jb1', actorId: 'actor_jb1' };
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    query: { readSession: async () => ({ inheritedEventCount: 0, events: [] }) },
    log: (event, detail) => logs.push([event, detail]),
  });

  journal.onEvent(headerEvent(0));
  journal.onEvent(headerEvent(1));
  journal.stopBuffering();
  journal.stopBuffering();                     // 幂等：重复调用不得抛、不得复活缓冲
  journal.onEvent(headerEvent(2));
  journal.onEvent(headerEvent(3));

  await journal.restore();
  assert.equal(foldedDetail(logs).events, 0,
    '收口后到达的事件不得留在缓冲里（快照自身为空 ⇒ 合并长度必须是 0）');
  assert.equal(journal.hasOwnOutboundHistory(), true,
    '收口只停**留副本**，live 折叠/观测路径必须照旧工作');
});

test('JB-U2 新会话的 bootstrap 路径必须收口缓冲（缺陷 1 的原始症状）', async () => {
  // session.seq === 0 ⇒ noOwnHistoryPossible ⇒ 走 bootstrap 分支，**不读快照**。
  const session = { id: 'sess_jb2', seq: 0, inheritedEventCount: 0 };
  const logs = [];
  const lc = createLifecycle({
    ctx: {},
    registry: makeRegistry(),
    config: { categoryConfig: CATEGORY_CONFIG, budgets: null, alwaysVisible: [] },
    clock, random,
    query: { readSession: async () => ({ inheritedEventCount: 0, events: [] }) },
    log: (event, detail) => { logs.push([event, detail]); },
    trustedEpoch: { store: fakeStore() },
  });

  lc.ensureRuntime(session, { id: 'agent-sess_jb2' });
  await lc.whenReady('sess_jb2');

  // runtime 建好之后发生的每一次真实出站：都不该再被复制进那份没人读的缓冲。
  for (const event of [headerEvent(0), headerEvent(1), headerEvent(2)]) lc.onSessionEvent(session, event);

  const runtime = lc.sessions.get('sess_jb2');
  assert.notEqual(runtime, undefined, '前置：runtime 已建立');
  assert.equal(runtime.journal.hasOwnOutboundHistory(), true,
    '前置：live 事件确实被处理过（否则本用例的 0 毫无意义）');

  await runtime.journal.restore();
  assert.equal(foldedDetail(logs).events, 0,
    'bootstrap 会话不得无界累积 session/event（修复前这里是 3）');
});

test('JB-U3 冷恢复期间到达的事件仍必须被合并（收口不得提前）', async () => {
  // 老会话（seq > 0）⇒ 走 restore 分支。缓冲在 fold 完成之前必须继续收集。
  const session = { id: 'sess_jb3', seq: 2, inheritedEventCount: 0 };
  const gate = deferred();
  const logs = [];
  const lc = createLifecycle({
    ctx: {},
    registry: makeRegistry(),
    config: { categoryConfig: CATEGORY_CONFIG, budgets: null, alwaysVisible: [] },
    clock, random,
    // readSession 卡住：模拟「读快照期间 live 事件仍在抵达」。
    query: { readSession: async () => { await gate.promise; return { inheritedEventCount: 0, events: [] }; } },
    log: (event, detail) => { logs.push([event, detail]); },
    trustedEpoch: { store: fakeStore() },
  });

  lc.ensureRuntime(session, { id: 'agent-sess_jb3' });
  await drain();                                 // 确保 restore 已进入 readSession 的 await 窗口
  for (const event of [headerEvent(0), headerEvent(1)]) lc.onSessionEvent(session, event);
  gate.resolve();
  await lc.whenReady('sess_jb3');
  await drain();

  assert.equal(foldedDetail(logs).events, 2,
    '恢复窗口内抵达的事件必须进入合并（收口只允许发生在 fold 之后）');
});

// ---------------------------------------------------------------------------
// 缺陷 2：在途 load 被丢弃时必须同步释放 engine 的预算预留
// ---------------------------------------------------------------------------

/** 一条在途 tool_load：journal 侧有配对现场，engine 侧有预算预留与期望回执。 */
async function liveLoad({ engineConfig = {}, callId = 'live-1', names = ['glob'], ...rest } = {}) {
  const { engine } = await makeEngine({ bindings: sampleBindings(), engineConfig });
  const scope = { sessionId: 'sess_jb45', actorId: 'actor_jb45' };
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    // `query` 必须能区分「没给」与「显式给 undefined」：journal 用 `query === undefined`
    // 判定"宿主没有公开 query 服务"，默认值会把那个场景吞掉（JB-U8 正是钉它）。
    query: Object.hasOwn(rest, 'query') ? rest.query : { readSession: async () => ({ inheritedEventCount: 0, events: [] }) },
    log: (event, detail) => logs.push([event, detail]),
  });
  // seq 从 1 起：domain 的 stale-seq 判据要求 pair.seq > lastAppliedSeq（初值非负），
  // 真实的 canonical 对也永远不会把 tool/call 放在 seq 0。
  journal.onEvent(toolCallEvent(1, callId, names));
  // entries.mjs 用同一个 operationId 登记热态预留（`op_${exec.callId}`）。
  const operationId = `op_${callId}`;
  const loaded = await engine.handleLoad({ names }, scope, { operationId });
  assert.equal(loaded.response.ok, true, `前置：load 本身必须成功：${JSON.stringify(loaded.response.error)}`);
  assert.equal(engine.getPendingSize(), 1, '前置：存在一条未决预算预留');
  assert.deepEqual([...journal.pendingLoadNames()], names, '前置：journal 认得这条在途 load');
  return { engine, scope, journal, operationId, receipt: loaded.response.data.receipt };
}

test('JB-U5 fail closed 必须释放在途 load 的预算预留', async () => {
  const { engine, journal, operationId } = await liveLoad({ engineConfig: { budgets: { maxActiveTools: 1 } } });
  // seq 畸形的 state 事件 ⇒ journal fail closed（终态，回执永远不会再来）。
  journal.onEvent({ seq: 'bad', type: 'tool/call', data: { name: 'tool_load', callId: 'x', arguments: '{}' } });

  assert.equal(engine.getPendingSize(), 0,
    'fail closed 后不得残留未决预留（否则为一个从未生效的 load 占着额度）');
  assert.equal(engine.cancelOperation(operationId), false,
    '预留必须已被显式取消 —— 不得留到会话结束才释放');
  assert.deepEqual([...journal.pendingLoadNames()], [],
    '配对现场与 engine pending 必须同时收口，不得一边留一边清');
});

test('JB-U6 dispose 必须释放在途 load 的预算预留', async () => {
  const { engine, journal, operationId } = await liveLoad({ engineConfig: { budgets: { maxActiveTools: 1 } } });
  journal.dispose();

  assert.equal(engine.getPendingSize(), 0, 'dispose 后不得残留未决预留');
  assert.equal(engine.cancelOperation(operationId), false, '预留必须已被显式取消');
  assert.deepEqual([...journal.pendingLoadNames()], [], 'dispose 后不得再把这条 load 当作"即将生效"');
});

test('JB-U7 正常成功路径不受影响：回执折叠自己收口，不重复取消', async () => {
  const { engine, journal, operationId, receipt } = await liveLoad({ engineConfig: { budgets: { maxActiveTools: 1 } } });

  journal.onEvent(toolResultEvent(2, 1, receipt));

  // applyCanonicalPair 自己删 pending：成功路径不得留下任何"待 abandon 处理"的残迹。
  assert.equal(engine.getPendingSize(), 0, '成功折叠后未决项必须为空');
  assert.equal(engine.cancelOperation(operationId), false,
    '成功路径由 applyCanonicalPair 收口，abandon 路径不得重复介入');
  assert.deepEqual([...journal.pendingLoadNames()], [], '成功折叠后不得再声称"在途"');
  assert.ok(journal.activeSelectedNames().includes('glob'),
    `回归：正常回执必须照旧激活（修复的是丢弃路径，不是折叠）：${JSON.stringify(journal.activeSelectedNames())}`);
});

// --- 缺陷 2 的第二个出口：恢复**终态**同样必须收口 ---------------------------
//
// 这两条出口（没有 query / readSession 失败）与 failClosedUncertain 不同：它们
// **不置 sealed**，因此归因字符串保持精确（lifecycle 依赖 `readSession-failed` 前缀）。
// 但"没有人再读这份副本"这件事是一样的，所以它们同样必须显式收口。
//
// 观测面说明（诚实边界）：本场景在 `restore:folded` 之前就返回了，因此**缓冲自身**
// 没有第二个观测面——本文件不为私有状态开洞（见文件头）。下面的断言钉的是同一出口
// 可观测的两个后果：engine 侧的预算预留必须释放、归因与 seal 语义不得被改动。

test('JB-U8 没有 sessionQuery 的恢复终态必须释放在途预留', async () => {
  const { engine, journal, operationId } = await liveLoad({
    engineConfig: { budgets: { maxActiveTools: 1 } },
    query: undefined,
  });

  const outcome = await journal.restore();

  assert.equal(outcome.mode, 'incompatible');
  assert.equal(outcome.reason, 'sessionQuery-missing', '归因必须保持精确，不得被 sealed 改写');
  assert.equal(journal.isSealed(), false, '这条出口不改变既有的 seal 语义');
  assert.equal(engine.getPendingSize(), 0, '终态之后不得残留未决预留');
  assert.equal(engine.cancelOperation(operationId), false, '预留必须已被显式取消，而不是留到会话结束');
  assert.deepEqual([...journal.pendingLoadNames()], [], '配对现场与 engine pending 必须同时收口');
});

test('JB-U9 readSession 失败的恢复终态必须释放在途预留', async () => {
  const { engine, journal, operationId } = await liveLoad({
    engineConfig: { budgets: { maxActiveTools: 1 } },
    query: { readSession: async () => { throw new Error('boom'); } },
  });

  const outcome = await journal.restore();

  assert.equal(outcome.mode, 'incompatible');
  assert.equal(outcome.reason, 'readSession-failed', '归因必须保持精确（lifecycle 按此前缀归因）');
  assert.equal(journal.isSealed(), false, '这条出口不改变既有的 seal 语义');
  assert.equal(engine.getPendingSize(), 0, '终态之后不得残留未决预留');
  assert.equal(engine.cancelOperation(operationId), false, '预留必须已被显式取消');
  assert.deepEqual([...journal.pendingLoadNames()], [], '配对现场与 engine pending 必须同时收口');
});

// ---------------------------------------------------------------------------
// lifecycle harness（与 lifecycle-settlement.test.mjs 同一形状）
// ---------------------------------------------------------------------------

function binding(name, toolId) {
  return {
    toolId, name, description: `buffering fixture for ${name}`,
    wire: { name, description: `buffering fixture for ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false } },
    providerNamespace: null, bindingGeneration: 'gen1', shadowOf: null, trustedCategoryOverride: null,
    skill: { skillRevision: 's1', usage: 'usage', limitations: ['limitation'] },
  };
}

function makeRegistry() {
  const bindings = [
    binding('tool_list', 't_entry_list'),
    binding('tool_search', 't_entry_search'),
    binding('tool_load', 't_entry_load'),
    binding('glob', 't_glob'),
  ];
  return {
    entryNames: ['tool_list', 'tool_search', 'tool_load'],
    frameworkRetained: [],
    bindingsFor: () => ({ bindings, scopeKey: 'buffering' }),
    remember: () => {},
    scopeKeyOf: () => 'buffering',
    generationFor: () => 1,
    bumpGeneration: () => {},
    diffAgainst: () => ({ added: [], removed: [] }),
  };
}
// ---------------------------------------------------------------------------
// JB-U10（冷恢复配对语义）：foldPairs 命中 call 必须立即消费 callSeq，与热态
// onEvent 的 liveCalls.delete 同一语义 —— 否则首个非法 result 之后，同 callSeq 的
// 伪造/重复 result 会被折叠激活。
// ---------------------------------------------------------------------------
test('JB-U10 foldPairs 命中即消费：非法首个 result 不得给伪造重复 result 第二次机会', () => {
  const events = [
    toolCallEvent(1, 'c1', ['glob']),
    // 首个 result 命中 call，但外壳非法（非 tool_load 协议外壳）→ 不激活
    { seq: 2, sourceEventSeqs: [1], type: 'tool/result', data: { message: { isError: false, content: [{ type: 'text', text: 'plain error text' }] } } },
    // 同 callSeq 的伪造/重复 result，外壳合法 → 冷恢复不得把它折叠激活
    toolResultEvent(3, 1, { names: ['glob'] }),
  ];
  assert.deepEqual(foldPairs(events), [], 'callSeq 被首个 result 认领后必须删除，伪造重复不得激活');
  // 正向对照：合法首个 result 照常折叠（修的是消费时序，不是折叠能力）
  const good = [toolCallEvent(1, 'c1', ['glob']), toolResultEvent(2, 1, { names: ['glob'] })];
  assert.equal(foldPairs(good).length, 1, '合法配对必须照常折叠');
});

// ---------------------------------------------------------------------------
// JB-U11/12（冷恢复丢失 frozen/advertised 与头部状态）：restore 必须按热态同一
// 函数（applyAdvertisementPass）重放压缩边界之后的 request/header，并还原
// latestHeaderSeq / latestHeaderTools —— 否则冷恢复后当轮已加载工具被误拒
// TOOL_NOT_ADVERTISED。fixture 用真实 domain 引擎（回执来自真实 handleLoad）。
// ---------------------------------------------------------------------------
const loadedWireOf = (engine, name) => [...engine.getCatalog().entries.values()].find((e) => e.name === name).wire;
const entryHeaderEvent = (seq) => ({ seq, type: 'request/header', data: { header: { tools: [{ name: 'tool_list' }] } } });

test('JB-U11 冷恢复重放 header 曝光：恢复后当轮已加载工具可执行，requestId 还原', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  const scope = { sessionId: 'sess_jb11', actorId: 'actor_jb11' };
  // 真实回执：保证 result payload 与 catalog 的 revision/digest 匹配
  const loaded = await engine.handleLoad({ names: ['glob'] }, scope, { operationId: 'op_c1' });
  assert.equal(loaded.response.ok, true, '前置：load 必须成功');
  const receipt = loaded.response.data.receipt;
  const loadedWire = loadedWireOf(engine, 'glob');
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    query: { readSession: async () => ({ inheritedEventCount: 0, events: [
      entryHeaderEvent(0),
      toolCallEvent(1, 'c1', ['glob']),
      toolResultEvent(2, 1, receipt),
      { seq: 3, type: 'request/header', data: { header: { tools: [loadedWire] } } },
    ] }) },
    log: (event, detail) => logs.push([event, detail]),
  });

  const outcome = await journal.restore();

  assert.equal(outcome.mode, 'ready', `前置：恢复必须 ready：${JSON.stringify(outcome)}`);
  assert.equal(engine.getState(scope).selected.size, 1, '前置：pair 已折叠激活');
  assert.equal(journal.currentRequestId(), 'sess_jb11#3', 'latestHeaderSeq 必须还原为本轮最后一次 header');
  const verdict = engine.evaluateCall(scope, { name: 'glob', requestId: journal.currentRequestId(), registeredInScope: true });
  assert.equal(verdict.allowed, true, `恢复后必须按重放的 header 记账放行（修复前 TOOL_NOT_ADVERTISED）：${JSON.stringify(verdict)}`);
  // 首见 wire 披露缓存照旧恢复（本轮两个 header 的工具都在）
  const disclosed = journal.disclosedWire().map((w) => w.name);
  assert.deepEqual([...disclosed].sort(), ['glob', 'tool_list']);
});

test('JB-U12 恢复重放幂等：engine.restore 不得把 live 期间已建立的曝光记账退回去', async () => {
  // 回归护栏（修复前后皆绿）：热态先折叠 + 记账、随后 restore 重选同代次 ——
  // reducePair 对同 revision 重选幂等保留 advertised；重放（applyAdvertisementPass）
  // 是覆盖写/按 digest 删除语义，重复执行只会让记账回到与 header 一致的状态。
  // 注：缺陷单里"engine.restore() 覆盖清空 advertised"的形态在当前 domain 引擎
  // （同代次重选不清 advertised、stale-seq 去重）下无法复现；红灯核实的是
  // JB-U11（冷恢复从未记账）与头部状态还原两处。
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  const scope = { sessionId: 'sess_jb12', actorId: 'actor_jb12' };
  const loaded = await engine.handleLoad({ names: ['glob'] }, scope, { operationId: 'op_c1' });
  const receipt = loaded.response.data.receipt;
  const loadedWire = loadedWireOf(engine, 'glob');
  const gate = deferred();
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    // readSession 卡住：header 在恢复窗口内经 live onEvent 抵达并完成记账
    query: { readSession: async () => { await gate.promise; return { inheritedEventCount: 0, events: [] }; } },
    log: (event, detail) => logs.push([event, detail]),
  });
  journal.onEvent(entryHeaderEvent(0));
  journal.onEvent(toolCallEvent(1, 'c1', ['glob']));
  journal.onEvent(toolResultEvent(2, 1, receipt));
  journal.onEvent({ seq: 3, type: 'request/header', data: { header: { tools: [loadedWire] } } });
  assert.equal(
    engine.evaluateCall(scope, { name: 'glob', requestId: journal.currentRequestId(), registeredInScope: true }).allowed,
    true, '前置：live 路径已按 header 记账放行');

  gate.resolve();
  const outcome = await journal.restore();
  assert.equal(outcome.mode, 'ready', `前置：恢复必须 ready：${JSON.stringify(outcome)}`);
  // engine.restore 重选会清掉 advertised（reducePair）；重放必须把它补回
  const verdict = engine.evaluateCall(scope, { name: 'glob', requestId: journal.currentRequestId(), registeredInScope: true });
  assert.equal(verdict.allowed, true, `engine.restore 清掉的曝光必须由重放补回：${JSON.stringify(verdict)}`);
  assert.deepEqual([...journal.pendingLoadNames()], [], '已结算的 load 不得停留在"即将生效"');
});

// ---------------------------------------------------------------------------
// JB-U13（恢复后残留 liveCalls）：缓冲期 live 写入、但快照已结算的配对现场必须
// 清理 —— 否则 pendingLoadNames 永久返回该工具，guard 把已生效的 load 永远当作
// "即将生效"。
// ---------------------------------------------------------------------------
test('JB-U13 缓冲期 live 写入、快照已结算的配对现场不得残留', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  const scope = { sessionId: 'sess_jb13', actorId: 'actor_jb13' };
  const loaded = await engine.handleLoad({ names: ['glob'] }, scope, { operationId: 'op_c1' });
  const receipt = loaded.response.data.receipt;
  const gate = deferred();
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    // call 在缓冲期 live 抵达，result 只存在于快照里
    query: { readSession: async () => { await gate.promise; return { inheritedEventCount: 0, events: [
      entryHeaderEvent(0),
      toolCallEvent(1, 'c1', ['glob']),
      toolResultEvent(2, 1, receipt),
    ] }; } },
    log: (event, detail) => logs.push([event, detail]),
  });
  journal.onEvent(entryHeaderEvent(0));
  journal.onEvent(toolCallEvent(1, 'c1', ['glob']));
  assert.deepEqual([...journal.pendingLoadNames()], ['glob'], '前置：缓冲期它确实被当作在途');

  gate.resolve();
  const outcome = await journal.restore();
  assert.equal(outcome.mode, 'ready', `前置：恢复必须 ready：${JSON.stringify(outcome)}`);
  assert.equal(engine.getState(scope).selected.size, 1, '前置：快照里的 pair 已结算激活');
  assert.deepEqual([...journal.pendingLoadNames()], [], '已结算的 load 不得永久停留在"即将生效"（修复前这里残留 glob）');
});

// ---------------------------------------------------------------------------
// JB-U14（PTC 子调用的快照结算同样必须清理配对现场）：raw `tool/ptc-dispatch`
// 在热态经 normalizePtcEvent 归一成 canonical tool/result 后命中即消费；restore 的
// 清理循环只按 raw type 过滤 `tool/result` 时会漏掉它 —— 结算只存在于快照里的
// PTC 子调用会在 liveCalls 残留，pendingLoadNames 把已生效的 load 永久当作"即将生效"。
// 判据必须与热态同源：清理前先过同一个 normalizePtcEvent。
// ---------------------------------------------------------------------------
test('JB-U14 PTC 子调用结算只在快照里时，恢复后不得残留在途配对现场', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  const scope = { sessionId: 'sess_jb14', actorId: 'actor_jb14' };
  // 真实回执：保证 PTC 子调用的 content 与 catalog 的 revision/digest 匹配
  const input = { names: ['glob'] };
  const loaded = await engine.handleLoad(input, scope, { operationId: 'op_child' });
  assert.equal(loaded.response.ok, true, '前置：load 必须成功');
  const parent = { seq: 1, type: 'tool/call', data: { callId: 'rc1', name: 'run_code', arguments: {} } };
  const start = { seq: 2, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'rc1', subCallId: 'child',
    name: 'tool_load', arguments: input } };
  const settlement = { seq: 3, type: 'tool/ptc-dispatch', data: { ...start.data, isError: false,
    content: [{ type: 'text', text: JSON.stringify(loaded.response) }] } };
  const gate = deferred();
  const logs = [];
  const journal = createJournal({
    ctx: {}, session: { inheritedEventCount: 0 }, scope, engine,
    // run_code 父调用与 ptc-dispatch-start 在缓冲期 live 抵达，raw tool/ptc-dispatch
    // 结算只存在于快照里
    query: { readSession: async () => { await gate.promise; return { inheritedEventCount: 0, events: [
      entryHeaderEvent(0), parent, start, settlement,
    ] }; } },
    log: (event, detail) => logs.push([event, detail]),
  });
  journal.onEvent(entryHeaderEvent(0));
  journal.onEvent(parent);
  journal.onEvent(start);
  assert.deepEqual([...journal.pendingLoadNames()], ['glob'],
    '前置：缓冲期 PTC 子调用确实被当作在途');

  gate.resolve();
  const outcome = await journal.restore();
  assert.equal(outcome.mode, 'ready', `前置：恢复必须 ready：${JSON.stringify(outcome)}`);
  assert.equal(engine.getState(scope).selected.size, 1, '前置：快照里的 PTC 子调用已结算激活');
  assert.deepEqual([...journal.pendingLoadNames()], [],
    '快照里已结算的 PTC 子调用不得永久停留在"即将生效"（修复前这里残留 glob）');
});
