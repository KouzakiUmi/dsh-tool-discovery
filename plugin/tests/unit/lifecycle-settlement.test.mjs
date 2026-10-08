// 恢复收尾落定（F3）产品语义单测 —— **纯可移植**。
//
// 本文件**不导入任何宿主 SDK**：store 经 deps 注入（与 trusted-epoch.test.mjs 同一纪律），
// 因此可以在没有 node_modules 的环境里跑（与 CI 的 portable unit 一致）。
//
// ## fixture 的性质（报告措辞必须与之一致）
//
//   * 五条 `/compact` 事件是**按 journal 的 canonical 契约声明式注入**到**真实**的
//     `createLifecycle` / `createJournal` 上的，**不是**宿主真实用户跑出来的
//     `/compact`（没有真实 dsh-compaction / dsh-commands 在场）。
//   * store 是**注入的 fake**，不是真实 `@deepseek-ai/dsh-storage-domain` 的 durable 写。
// 因此本文件证明的是**产品代码在该时序下的行为**，**不**证明线上自然时序已复现。
//
// 两种 store 形态都要覆盖，因为它们与真实 API 的贴合度不同：
//   * `perCallOpenGatedStore` —— 每次 `ensureOpen` 各自一个闸门。**最悲观**：
//     迁移写可以越过 load 单独前进。
//   * `sharedOpenGatedStore`  —— 所有调用共享**同一个** opening promise，逐字复刻真实
//     `createTrustedEpochStore.ensureOpen()` 的 `opening` 复用语义（`trusted-epoch.mjs`
//     的 `if (opening !== null) return opening;`）。时序形态与真实 API 一致。
//
// 覆盖的产品语义（与 adapters/dsh/lifecycle.mjs 一一对应）：
//   LS-U1 `load()` 的 await 窗口里抵达一次 live `/compact`（其 adopt 推进 revision）时，
//        `load()` 会提前返回 `{state: PENDING, reason: null}`。那**不是**失败。
//   LS-U2 该非终态**不得**触发 blockBaseline：不得有 reason=null 的归因、不得 fail closed
//        引擎、不得把 restoring 提前归 false、不得把名单提前装上。
//   LS-U3 恢复的 baselinePromise / whenReady / awaitEpochRecord 必须**等待当前写**落定。
//   LS-U4 释放后：trusted + ready + 保留**边界那一刻**的名单（不是当前配置）。
//   LS-U5 当前写失败后：准确的 blocked reason（STORAGE_UNAVAILABLE），不得为 null。
//   LS-U6 dispose 之后在途写不得复活：既不得 trusted，也不得把名单装进 runtime /
//        把引擎置 ready。
//   LS-U7 回归不倒退：全新会话 / own-only fork 空 own 段 / 冷崩复用三条 happy path
//        仍照原样落定；老会话仍必须被拒（0 request）。
//   LS-U8 `begin()` 也会被更晚的 adopt supersede 并返回 P —— 同一不变量必须覆盖。
//   LS-U9 **共享** ensureOpen（贴近真实 API）的时序形态。
//   LS-U10 **连续多次** supersession：不设轮数封顶，跟到最后一次写为止。
//   LS-U11 `retryBaseline` 的 promise 语义（restoring=false 形态）。
//   LS-U12 **回归**：缺失资格判定与初始记录的启动必须处在同一个同步块内，
//        否则外层 await 间隙里先到的 live 用户 `/compact` 会被过期的初始记录 supersede。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLifecycle } from '../../adapters/dsh/lifecycle.mjs';
import {
  BASELINE_STATE, TRUSTED_EPOCH_REASONS, epochKeyOfRecord,
} from '../../adapters/dsh/trusted-epoch.mjs';

const CLOCK_START = 1_700_000_000_000;
const clock = { now: () => CLOCK_START };
const random = { bytes: (n) => new Uint8Array(n) };

const CATEGORY_CONFIG = Object.freeze({
  files: { title: 'files', capabilitySummary: 'files' },
  other: { title: 'other', capabilitySummary: 'other' },
});

/** 周期边界那一刻捕获的名单（与当前配置故意不同，用于证明"用边界名单"）。 */
const BOUNDARY_NAMES = Object.freeze(['boundary_tool']);
const CONFIG_NAMES = Object.freeze(['glob']);

function binding(name, toolId) {
  return {
    toolId, name, description: `settlement fixture for ${name}`,
    wire: { name, description: `settlement fixture for ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false } },
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
    binding('boundary_tool', 't_boundary'),
  ];
  return {
    entryNames: ['tool_list', 'tool_search', 'tool_load'],
    frameworkRetained: [],
    bindingsFor: () => ({ bindings, scopeKey: 'settlement' }),
    remember: () => {},
    scopeKeyOf: () => 'settlement',
    generationFor: () => 1,
    bumpGeneration: () => {},
    diffAgainst: () => ({ added: [], removed: [] }),
  };
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // 未 await 的 rejected promise 不应触发 unhandledRejection
  return { promise, resolve, reject };
};

const storeBase = (map) => ({
  map,
  openCalls: 0,
  putCalls: 0,
  get(key) { return map.get(key); },
  async close() {},
});

/** 形态 A：每次 `ensureOpen` 各自一个闸门（最悲观，迁移写可单独前进）。 */
function perCallOpenGatedStore(seed = {}) {
  const s = storeBase(new Map(Object.entries(seed)));
  const openGates = [];
  // put 闸门是**队列**：连续两次写各取一个，否则第一个闸门会被第二次覆盖而丢失。
  const putGates = [];
  s.gateOpen = () => { const g = deferred(); openGates.push(g); return g; };
  s.releaseOpens = () => { for (const g of openGates.splice(0)) g.resolve(); };
  s.gatePut = () => { const g = deferred(); putGates.push(g); return g; };
  s.ensureOpen = async () => {
    s.openCalls += 1;
    const g = openGates.shift();
    if (g !== undefined) await g.promise;
    return { ok: true };
  };
  s.put = async (record) => {
    s.putCalls += 1;
    const g = putGates.shift();
    if (g !== undefined) await g.promise;
    s.map.set(epochKeyOfRecord(record), structuredClone(record));
  };
  return s;
}

/**
 * 形态 B：所有 `ensureOpen` 共享**同一个** opening promise ——
 * 逐字复刻真实 `createTrustedEpochStore.ensureOpen()` 的 `opening` 复用
 * （`if (opening !== null) return opening;` 与 open 之后的直接返回）。
 */
function sharedOpenGatedStore(seed = {}) {
  const s = storeBase(new Map(Object.entries(seed)));
  let opening = null;
  let opened = false;
  const putGates = [];
  s.gateOpen = () => { opening = deferred(); return opening; };
  s.releaseOpen = () => { opening?.resolve(); };
  s.gatePut = () => { const g = deferred(); putGates.push(g); return g; };
  s.ensureOpen = () => {
    s.openCalls += 1;
    if (opened) return Promise.resolve({ ok: true });   // 真实语义：已 open 立即返回
    if (opening === null) opening = deferred();          // 真实语义：复用同一个 opening
    return opening.promise.then(() => { opened = true; return { ok: true }; });
  };
  s.put = async (record) => {
    s.putCalls += 1;
    const g = putGates.shift();
    if (g !== undefined) await g.promise;
    s.map.set(epochKeyOfRecord(record), structuredClone(record));
  };
  return s;
}

const headerEvent = (seq) => ({ seq, type: 'request/header', data: { header: { tools: [{ name: 'glob' }] } } });

/** 五条 own LIVE canonical 用户 /compact 链（顺序与 journal.mjs 的判据逐条对齐）。 */
function userCompactionChain(startSeq, tag = 'cmp-1', commandId = 'cmd-compact-1') {
  return [
    { seq: startSeq + 0, type: 'command/run', data: { name: 'compact', source: { kind: 'user' }, commandId } },
    { seq: startSeq + 1, type: 'compaction/start', data: { compactionId: tag, turn: null, sourceCommandId: commandId } },
    { seq: startSeq + 2, type: 'compaction/summary', data: { compactionId: tag, sourceCommandId: commandId } },
    { seq: startSeq + 3, type: 'compaction/end', data: { compactionId: tag, turn: null, sourceCommandId: commandId } },
    { seq: startSeq + 4, type: 'command/done', data: { commandId, kind: 'success', sourceEventSeq: startSeq + 2 } },
  ];
}

function makeLifecycle({ store, query, logs, getAlwaysVisible = () => [...BOUNDARY_NAMES] }) {
  return createLifecycle({
    ctx: {},
    registry: makeRegistry(),
    config: { requireTrustedEpoch: true, categoryConfig: CATEGORY_CONFIG, locale: undefined, budgets: null, alwaysVisible: [...CONFIG_NAMES] },
    clock, random, query,
    log: (event, detail) => { logs.push([event, detail]); },
    getAlwaysVisible,
    trustedEpoch: { store },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 有界微任务排空：store 闸门全是 promise，drain 后 load 的续行必定已跑完。 */
async function drain(rounds = 200) { for (let i = 0; i < rounds; i++) await Promise.resolve(); }
async function until(predicate, what, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await tick();
  }
}

const blockedLogs = (logs) => logs.filter(([event]) => event === 'lifecycle:baseline-blocked');
const engineModeOf = (lc, sessionId) => {
  const runtime = lc.sessions.get(sessionId);
  return runtime === undefined ? null : runtime.engine.getState(runtime.scope).mode;
};
const runtimeOf = (lc, sessionId) => lc.sessions.get(sessionId);

/** own 段已有 2 条出站事实的老会话 + 无 durable 记录 → 走 restore 分支。 */
function legacyFixture(id) {
  const events = [headerEvent(0), headerEvent(1)];
  const session = { id, seq: events.length, inheritedEventCount: 0, snapshotEvents: () => events };
  const query = { readSession: async () => ({ inheritedEventCount: 0, events: events.map((e) => structuredClone(e)) }) };
  return { events, session, query };
}

// ---------------------------------------------------------------------------
// LS-U1 ~ LS-U6：核心反例（逐调用闸门形态）。修复前必须真红。
// ---------------------------------------------------------------------------
test('LS-U1..U6 迁移写在途时恢复不得判失败，释放后按边界名单落定', async () => {
  const id = 's_settle';
  const { events, session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  const loadOpen = store.gateOpen();      // load() 的那一次 ensureOpen
  const migrationPut = store.gatePut();  // 迁移写的 put 保持"在途"
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.openCalls === 1, 'load() 进入 ensureOpen');

  // 按 canonical 契约注入的迁移链，在 load 的 await 窗口里抵达。
  for (const event of userCompactionChain(events.length)) lc.onSessionEvent(session, event);
  await until(() => store.putCalls === 1, '迁移写的 put 进入在途');

  loadOpen.resolve();
  await drain();

  const runtime = runtimeOf(lc, id);
  const inFlight = lc.baselineOf(id);

  // LS-U2：不得以 reason=null 执行 blockBaseline（四个独立可观测量）
  assert.deepEqual(blockedLogs(logs), [], '在途窗口不得出现 lifecycle:baseline-blocked');
  assert.equal(inFlight.state, BASELINE_STATE.PENDING, '在途窗口基线是 pending（尚有工作在途），不是失败终态');
  assert.notEqual(engineModeOf(lc, id), 'incompatible', '在途窗口不得把引擎 fail closed');
  assert.equal(runtime.restoring, true, '在途窗口不得把 restoring 提前归 false');
  assert.deepEqual(runtime.alwaysNames, [], '在途窗口不得把名单提前装上（pending 不可授权）');

  // LS-U3：三条等待面都必须等当前写
  let readySettled = 'pending';
  void lc.whenReady(id).then((value) => { readySettled = value; });
  let barrier = 'pending';
  void lc.awaitEpochRecord(id).then(
    () => { barrier = 'resolved'; },
    (error) => { barrier = `rejected:${error?.message ?? error}`; },
  );
  await drain();
  assert.equal(readySettled, 'pending', 'whenReady 不得先返回 incompatible，必须等当前写');
  assert.equal(barrier, 'pending', 'awaitEpochRecord 不得抛 blocked，必须等当前写');

  // LS-U4：释放后 trusted + ready + 边界名单（不是当前配置）
  migrationPut.resolve();
  await until(() => lc.baselineOf(id).state === BASELINE_STATE.TRUSTED, '迁移写落定');
  await drain();
  const settled = lc.baselineOf(id);
  assert.equal(settled.state, BASELINE_STATE.TRUSTED);
  assert.deepEqual(settled.names, [...BOUNDARY_NAMES], '必须保留周期边界那一刻的名单，而不是当前配置');
  assert.notDeepEqual(settled.names, [...CONFIG_NAMES], '名单不得回落到当前配置');
  assert.equal(settled.epochId, 'cmp-1@5', 'epoch 身份必须是那次成功压缩的边界');
  assert.equal(engineModeOf(lc, id), 'ready', '释放后引擎必须 ready');
  assert.deepEqual(blockedLogs(logs), [], '全程不得出现 baseline-blocked');
  assert.equal(store.map.size, 1, '必须恰好一条 durable 记录');
  assert.equal([...store.map.values()][0].trigger, 'manual', '用户迁移的 trigger 必须是 manual');
});

test('LS-U5 当前写失败后必须是准确的 blocked reason', async () => {
  const id = 's_settle_fail';
  const { events, session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  store.gateOpen();
  const migrationPut = store.gatePut();
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.openCalls === 1, 'load() 进入 ensureOpen');
  for (const event of userCompactionChain(events.length)) lc.onSessionEvent(session, event);
  await until(() => store.putCalls === 1, '迁移写的 put 进入在途');
  store.releaseOpens();
  await drain();

  migrationPut.reject(new Error('durable write refused'));
  await until(() => lc.baselineOf(id).state === BASELINE_STATE.BLOCKED, '失败落定');
  await drain();

  const failed = lc.baselineOf(id);
  assert.equal(failed.state, BASELINE_STATE.BLOCKED);
  assert.equal(typeof failed.reason, 'string', 'blocked 归因必须是字符串');
  assert.ok(failed.reason.length > 0, 'blocked 归因不得为空串');
  assert.notEqual(failed.reason, null, 'blocked 归因不得为 null（F3 的原始症状）');
  assert.equal(failed.reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE, 'durable 写失败归因必须是存储不可用');
  for (const [, detail] of blockedLogs(logs)) {
    assert.notEqual(detail.reason, null, 'baseline-blocked 日志的 reason 不得为 null');
    assert.ok(String(detail.reason).length > 0);
  }
  // 0 request 语义不得被绕过
  await assert.rejects(() => lc.awaitEpochRecord(id), /STORAGE_UNAVAILABLE/);
});

test('LS-U6 dispose 之后在途写不得复活（trusted / 名单 / ready 三项都不得）', async () => {
  const id = 's_settle_dispose';
  const { events, session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  store.gateOpen();
  const migrationPut = store.gatePut();
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.openCalls === 1, 'load() 进入 ensureOpen');
  for (const event of userCompactionChain(events.length)) lc.onSessionEvent(session, event);
  await until(() => store.putCalls === 1, '迁移写的 put 进入在途');
  store.releaseOpens();
  await drain();

  const namesBefore = [...runtimeOf(lc, id).alwaysNames];
  lc.disposeSession(id);
  migrationPut.resolve();      // 释放闸门，让在途写真的走完
  await until(() => lc.sessions.size === 0, 'runtime 已释放');
  await drain();
  await drain();
  await tick();

  const after = lc.baselineOf(id);
  assert.ok(after === null || after.state !== BASELINE_STATE.TRUSTED, 'dispose 之后不得复活为 trusted');
  assert.equal(runtimeOf(lc, id), undefined, 'runtime 必须已释放');
  assert.deepEqual(namesBefore, [], '前置：本会话在 dispose 前本就未获授权');
  // 释放闸门后名单也不得被装进任何 runtime（runtime 已释放，无处可装）
  for (const [, sessionId] of lc.sessions) assert.notEqual(sessionId, id);
  assert.deepEqual(blockedLogs(logs), [], 'dispose 路径不得产生 baseline-blocked');
});

// ---------------------------------------------------------------------------
// LS-U9 共享 ensureOpen（贴近真实 API 的时序形态）
// ---------------------------------------------------------------------------
test('LS-U9 共享 ensureOpen 形态下同样不得在迁移在途时判失败', async () => {
  const id = 's_settle_shared';
  const { events, session, query } = legacyFixture(id);
  const store = sharedOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  const open = store.gateOpen();   // load 与迁移写共享这一个 opening
  const migrationPut = store.gatePut();
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.openCalls === 1, 'load() 进入 ensureOpen');

  // 迁移写此刻也必须卡在**同一个** opening 上（真实语义）。
  for (const event of userCompactionChain(events.length)) lc.onSessionEvent(session, event);
  await until(() => store.openCalls === 2, '迁移写的 ensureOpen 也已发出（共享同一个 opening）');

  // 共享 opening 打开：load 先续行（被 adopt 推进 revision → PENDING/null），
  // 迁移写随后续行并进入被闸门挂住的 put。
  store.releaseOpen();
  await until(() => store.putCalls === 1, '迁移写的 put 进入在途');
  await drain();

  const inFlight = lc.baselineOf(id);
  const runtime = runtimeOf(lc, id);
  assert.deepEqual(blockedLogs(logs), [], '共享 opening 形态下也不得出现 baseline-blocked');
  assert.equal(inFlight.state, BASELINE_STATE.PENDING, '在途窗口基线是 pending');
  assert.notEqual(engineModeOf(lc, id), 'incompatible', '在途窗口不得把引擎 fail closed');
  assert.equal(runtime.restoring, true, '在途窗口不得把 restoring 提前归 false');

  let readySettled = 'pending';
  void lc.whenReady(id).then((value) => { readySettled = value; });
  await drain();
  assert.equal(readySettled, 'pending', 'whenReady 必须等当前写');

  migrationPut.resolve();
  await until(() => lc.baselineOf(id).state === BASELINE_STATE.TRUSTED, '迁移写落定');
  await drain();
  const settled = lc.baselineOf(id);
  assert.deepEqual(settled.names, [...BOUNDARY_NAMES]);
  assert.equal(settled.epochId, 'cmp-1@5');
  assert.equal(engineModeOf(lc, id), 'ready');
  assert.deepEqual(blockedLogs(logs), []);
});

// ---------------------------------------------------------------------------
// LS-U10 连续多次 supersession：必须跟到最后一次写，不设轮数封顶
// ---------------------------------------------------------------------------
test('LS-U10 连续两次迁移互相 supersede：必须跟到最后一次，不得中途判失败', async () => {
  const id = 's_settle_twice';
  const { events, session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  const logs = [];
  // 第二次边界的名单刻意不同：用来证明"跟到的是**最后**一次写"。
  let generation = 0;
  const lc = makeLifecycle({
    store, query, logs,
    getAlwaysVisible: () => (generation === 0 ? [...BOUNDARY_NAMES] : ['second_boundary_tool']),
  });

  const loadOpen = store.gateOpen();
  const firstPut = store.gatePut();
  const secondPut = store.gatePut();
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.openCalls === 1, 'load() 进入 ensureOpen');

  for (const event of userCompactionChain(events.length, 'cmp-1', 'cmd-1')) lc.onSessionEvent(session, event);
  await until(() => store.putCalls === 1, '第一次迁移写进入在途');

  // 在 load 仍未续行时抵达第二次迁移：它会 supersede 第一次 adopt。
  generation = 1;
  for (const event of userCompactionChain(events.length + 5, 'cmp-2', 'cmd-2')) lc.onSessionEvent(session, event);
  await until(() => store.putCalls === 2, '第二次迁移写进入在途');

  loadOpen.resolve();
  await drain();

  assert.deepEqual(blockedLogs(logs), [], '连续 supersession 期间不得出现 baseline-blocked');
  assert.equal(lc.baselineOf(id).state, BASELINE_STATE.PENDING, '此时仍在途');

  // 先放行被 supersede 的第一次写（它必须不产生任何授权），再放行真正的第二次。
  firstPut.resolve();
  await drain();
  assert.deepEqual(blockedLogs(logs), [], '被 supersede 的写落定也不得触发 blockBaseline');
  assert.equal(lc.baselineOf(id).state, BASELINE_STATE.PENDING, '第一次写落定后仍应等第二次');

  secondPut.resolve();
  await until(() => lc.baselineOf(id).state === BASELINE_STATE.TRUSTED, '最后一次写落定');
  await drain();

  const settled = lc.baselineOf(id);
  // 链 1 从 seq=2 起（end=5），链 2 从 seq=7 起（end=10）。
  assert.equal(settled.epochId, 'cmp-2@10', '必须认最后一次成功压缩的边界');
  assert.deepEqual(settled.names, ['second_boundary_tool'], '必须用最后一次边界的名单');
  assert.equal(engineModeOf(lc, id), 'ready');
  assert.deepEqual(blockedLogs(logs), [], '全程不得出现 baseline-blocked');
  // 注：这里**不**断言"被 supersede 的第一次写绝不落盘"。第一次 adopt 在第二次抵达
  // 之前就已经越过 revision 复核、进入了 `store.put()`，那条记录仍会落盘 —— 这是旧审查
  // F4 记录的既有窄窗口（"已进入 store.put() 的写不会因 supersede/failClosed/dispose
  // 而撤回"），**先于本轮存在**，不归 F3 管，也不由本轮改动。
  // 本例要钉的是**授权面**：权威基线必须是最后一次成功的边界，名单必须是最后一次的，
  // 且全程不得出现任何 blockBaseline / reason=null。
});

// ---------------------------------------------------------------------------
// LS-U8 `begin()` 的同型 supersession
// ---------------------------------------------------------------------------
test('LS-U8 初始 begin() 被更晚的 adopt supersede 时不得以 null 判失败', async () => {
  const id = 's_settle_begin';
  // 全新会话（seq===0）→ 走 bootstrap 分支；query 缺席（本分支本就不读它）。
  const session = { id, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [] };
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query: undefined, logs });

  // 闸门是队列：第 1 个给 `begin()` 的写，第 2 个给后来那次 adopt 的写。
  const beginPut = store.gatePut();
  const adoptPut = store.gatePut();
  lc.ensureRuntime(session, { id: `agent-${id}` });
  await until(() => store.putCalls >= 1, '初始记录的 put 开始');

  // 在 bootstrap 收尾期间抵达一次迁移 → supersede begin
  for (const event of userCompactionChain(0, 'cmp-b', 'cmd-b')) lc.onSessionEvent(session, event);
  await until(() => store.putCalls >= 2, '迁移写的 put 开始');
  await drain();

  assert.deepEqual(blockedLogs(logs), [], 'begin 被 supersede 期间不得出现 baseline-blocked');
  const inFlight = lc.baselineOf(id);
  assert.notEqual(inFlight.state, BASELINE_STATE.BLOCKED, 'begin 被 supersede 不得被判为失败终态');

  // 先放行被 supersede 的 begin（它必须不产生授权），再放行真正的迁移写。
  beginPut.resolve();
  await drain();
  assert.deepEqual(blockedLogs(logs), [], '被 supersede 的 begin 落定也不得触发 blockBaseline');

  adoptPut.resolve();
  await until(() => {
    const state = lc.baselineOf(id)?.state;
    return state === BASELINE_STATE.TRUSTED || state === BASELINE_STATE.BLOCKED;
  }, 'bootstrap 落定');
  await drain();

  const settled = lc.baselineOf(id);
  assert.equal(settled.state, BASELINE_STATE.TRUSTED, '最终必须落定到可信（迁移成功）');
  assert.equal(engineModeOf(lc, id), 'ready');
  assert.deepEqual(blockedLogs(logs), [], '全程不得出现 baseline-blocked');
  for (const [, detail] of blockedLogs(logs)) assert.notEqual(detail.reason, null);
});

// ---------------------------------------------------------------------------
// LS-U7 回归不倒退
// ---------------------------------------------------------------------------
test('LS-U7a 全新会话照常 bootstrap（query 缺席也不影响 seq===0 的会话）', async () => {
  const id = 's_settle_new';
  const session = { id, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [] };
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query: undefined, logs });

  lc.ensureRuntime(session, { id: `agent-${id}` });
  const outcome = await lc.whenReady(id);
  assert.equal(outcome.mode, 'ready', '全新会话必须照常 bootstrap');
  const baseline = lc.baselineOf(id);
  assert.equal(baseline.state, BASELINE_STATE.TRUSTED);
  assert.equal(store.map.size, 1);
  assert.equal([...store.map.values()][0].epochId, 'initial');
  assert.equal([...store.map.values()][0].trigger, 'initial');
  assert.deepEqual(baseline.names, [...BOUNDARY_NAMES], '名单取自建立那一刻的捕获值');
  assert.deepEqual(blockedLogs(logs), []);
});

test('LS-U7b own-only fork 空 own 段仍照常 bootstrap，且键用继承边界', async () => {
  const id = 's_settle_fork';
  const events = [headerEvent(0), headerEvent(1)];
  const session = { id, seq: 2, inheritedEventCount: 2, snapshotEvents: () => events };
  const query = { readSession: async () => ({ inheritedEventCount: 2, events: events.map((e) => structuredClone(e)) }) };
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  lc.ensureRuntime(session, { id: `agent-${id}` });
  const outcome = await lc.whenReady(id);
  assert.equal(outcome.mode, 'ready');
  const baseline = lc.baselineOf(id);
  assert.equal(baseline.state, BASELINE_STATE.TRUSTED, 'own-only fork 空 own 段必须仍能 bootstrap');
  assert.equal(baseline.epochId, 'initial');
  assert.deepEqual(baseline.names, [...BOUNDARY_NAMES]);
  assert.equal([...store.map.values()][0].ownSeqStart, 2, '记录键的 ownSeqStart 必须是继承边界');
});

test('LS-U7c 冷崩复用取 durable 记录里的名单而非当前配置', async () => {
  const id = 's_settle_reuse';
  const durable = {
    protocolVersion: 2, schemaVersion: 1, sessionId: id, ownSeqStart: 0,
    epochId: 'initial', compactionEndSeq: -1, names: ['from_durable_record'],
    trigger: 'initial', writtenAt: 1,
  };
  const store = perCallOpenGatedStore({ [epochKeyOfRecord(durable)]: durable });
  const events = [headerEvent(0), headerEvent(1), headerEvent(2)];
  const session = { id, seq: 3, inheritedEventCount: 0, snapshotEvents: () => events };
  const query = { readSession: async () => ({ inheritedEventCount: 0, events: events.map((e) => structuredClone(e)) }) };
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  lc.ensureRuntime(session, { id: `agent-${id}` });
  const outcome = await lc.whenReady(id);
  assert.equal(outcome.mode, 'ready');
  const baseline = lc.baselineOf(id);
  assert.equal(baseline.state, BASELINE_STATE.TRUSTED, '冷崩复用必须复用已落盘记录');
  assert.deepEqual(baseline.names, ['from_durable_record'], '名单必须取自 durable 记录，不与当前配置取交集');
  assert.equal(store.putCalls, 0, '复用路径不得重写记录');
});

test('LS-U7d 有 own 出站事实但无记录的老会话仍必须被拒（0 request）', async () => {
  const id = 's_settle_legacy';
  const { session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  lc.ensureRuntime(session, { id: `agent-${id}` });
  const outcome = await lc.whenReady(id);
  assert.equal(outcome.mode, 'incompatible');
  assert.equal(outcome.reason, TRUSTED_EPOCH_REASONS.MISSING, '老会话无记录必须是 MISSING');
  assert.equal(lc.baselineOf(id).state, BASELINE_STATE.BLOCKED);
  assert.equal(store.putCalls, 0, '不得因记录缺失而补建初始记录');
  assert.equal(store.map.size, 0, 'durable 侧不得留下任何授权记录');
  await assert.rejects(() => lc.awaitEpochRecord(id), /MISSING_TRUSTED_EPOCH/);
});

// ---------------------------------------------------------------------------
// LS-U11 retryBaseline 的 promise 语义（restoring=false 形态）—— 只记录，不改
// ---------------------------------------------------------------------------
test('LS-U11 retryBaseline：restoring=false 时 whenReady 不跟踪重试 promise（现状记录）', async () => {
  const id = 's_settle_retry';
  const { session, query } = legacyFixture(id);
  const store = perCallOpenGatedStore();
  // 存储先缺席（index.mjs 触发 retryBaseline 的既有前提），之后切换为可用。
  let failOpen = true;
  const realEnsureOpen = store.ensureOpen;
  store.ensureOpen = async () => (failOpen ? { ok: false, reason: 'open-failed' } : realEnsureOpen());
  const logs = [];
  const lc = makeLifecycle({ store, query, logs });

  lc.ensureRuntime(session, { id: `agent-${id}` });
  const first = await lc.whenReady(id);
  assert.equal(first.mode, 'incompatible');
  assert.equal(lc.baselineOf(id).reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE);
  const runtime = runtimeOf(lc, id);
  assert.equal(runtime.restoring, false, '终态后 restoring 必须已归 false（正常收尾）');

  // 存储到位 → retryBaseline（restoring=false 形态）
  failOpen = false;
  const gate = store.gateOpen();
  const retry = lc.retryBaseline(runtime);
  await until(() => store.openCalls >= 1, '重试的 load 进入 ensureOpen');
  assert.equal(runtime.restoring, false, 'retryBaseline 期间 restoring 仍为 false（既有语义，本轮未改）');
  // 现状记录：whenReady 在 restoring=false 时立即按当前 mode 返回，不跟踪重试 promise。
  const readyDuringRetry = await lc.whenReady(id);
  assert.equal(readyDuringRetry.mode, 'incompatible', '现状：whenReady 不跟踪 retryBaseline 的 promise');
  // 但 awaitEpochRecord 的现状语义是**保守**的：`retryBaseline` 不会把账本放回 PENDING，
  // 于是重试在途期间账本仍是上一次的 BLOCKED(UNAVAILABLE)，pre-step 继续 0 request。
  // 这不是 F3 的缺陷（它不授权、只保守），本轮**只记录不改动**，免得无谓扩展。
  let barrier = 'pending';
  void lc.awaitEpochRecord(id).then(() => { barrier = 'resolved'; }, (e) => { barrier = `rejected:${e?.message ?? e}`; });
  await drain();
  assert.match(String(barrier), /STORAGE_UNAVAILABLE/,
    '现状（保守）：重试在途期间 awaitEpochRecord 仍按上一次的 BLOCKED 归因 0 request，不授权');
  assert.equal(runtime.restoring, false, '重试在途期间 restoring 仍为 false（现状，本轮未改）');

  gate.resolve();
  await retry;
  await drain();
  const after = lc.baselineOf(id);
  // legacy 会话：重试读到的仍是缺失，而"缺失"不构成补建资格 → 保持 MISSING，不得授权。
  assert.equal(after.state, BASELINE_STATE.BLOCKED, 'legacy 会话重试后仍不得被补建授权');
  assert.equal(after.reason, TRUSTED_EPOCH_REASONS.MISSING);
  assert.equal(store.map.size, 0, '重试不得为 legacy 会话补建初始记录');
  assert.equal(runtime.restoring, false, '重试终态后 restoring 仍为 false');
  for (const [, detail] of blockedLogs(logs)) assert.notEqual(detail.reason, null, '归因不得为 null');
  // 重试后的归因必须是**读出来的** MISSING，而不是上一次的 UNAVAILABLE。
  assert.ok(
    blockedLogs(logs).some(([, d]) => d.reason === TRUSTED_EPOCH_REASONS.MISSING),
    '重试落定后必须以 MISSING 归因（记录确实缺失），不得沿用旧的 UNAVAILABLE',
  );
});

// ---------------------------------------------------------------------------
// LS-U12（回归，窄修复）：缺失资格判定的**同步块内启动**初始记录
//
// 形态：全新会话（own 段空）→ 资格判定为 missing 且有资格 → 在那个**同步 decide 回调
// 内部**注入一次 live 用户 `/compact` 链（adopt 会捕获自己的边界名单并推进 revision），
// 紧接着当前配置再变更一次。
//
// 旧写法把资格快照 `{done:false}` 交出去、外层 await 之后才 `begin()`，于是那条更早抵达的
// adopt 被过期的初始记录 supersede：最终变成 `epochId=initial / trigger=initial /
// names=[当时配置]` —— 手动迁移被静默回退。修复后 `begin()` 与资格判定同处一个同步块。
//
// 反空过：先证明钩子**真的在缺失判定窗口里跑过**、手动链**真的 adopt 成功**，
// 再断言最终名单 / epochId / trigger；任一前提不成立都会先报错，而不是静默通过。
// ---------------------------------------------------------------------------
test('LS-U12：缺失资格与初始记录的启动必须在同一同步块内，否则会覆盖先到的 live 手动迁移', async () => {
  const id = 's_settle_missing_window';
  const session = { id, seq: 0, inheritedEventCount: 0 };
  const store = perCallOpenGatedStore();
  const logs = [];
  // 当前配置分两代：判定窗口里是 BOUNDARY_NAMES，adopt 之后变成 CONFIG_NAMES。
  // 两条名单**故意不同**，因此"最终名单是谁"就是本判据的核心可观测量。
  let generation = 0;
  const lc = makeLifecycle({
    store, query: undefined, logs,
    getAlwaysVisible: () => (generation === 0 ? [...BOUNDARY_NAMES] : [...CONFIG_NAMES]),
  });

  const runtime = lc.ensureRuntime(session, { id: `agent-${id}` });
  const hasOwn = runtime.journal.hasOwnOutboundHistory.bind(runtime.journal);
  let hookRan = false;
  runtime.journal.hasOwnOutboundHistory = () => {
    if (!hookRan) {
      hookRan = true;
      // 缺记录资格判定的**同步块内部**安排一次更早抵达的 live 迁移。
      queueMicrotask(() => {
        for (const event of userCompactionChain(0, 'u12-cmp', 'u12-command')) {
          lc.onSessionEvent(session, event);
        }
        generation = 1; // 配置此刻才变 —— 过期快照会把这份新配置写进初始记录
      });
    }
    return hasOwn();
  };

  const outcome = await lc.whenReady(id);

  // ---- 反空过前置：钩子真的执行过 ----
  assert.equal(hookRan, true, '前置：缺失资格判定的钩子必须真的在窗口里执行（否则本例是空过）');
  assert.ok(logs.some(([event]) => event === 'lifecycle:bootstrap-refused-legacy') === false,
    '前置：本例走的是「有资格建立」分支，不得退化成 legacy 拒绝');

  // ---- 反空过前置：手动链真的 adopt 并落盘 ----
  const records = [...store.map.values()];
  assert.equal(records.length >= 1, true, '前置：durable 侧必须真的写过记录（本例不得空盘通过）');
  const migrated = records.find((record) => record.epochId === 'u12-cmp@3');
  assert.notEqual(migrated, undefined,
    `前置：live 手动迁移必须真的 adopt 成功并落盘；实际记录：${JSON.stringify(records.map((r) => ({ epochId: r.epochId, trigger: r.trigger, names: r.names })))}`);
  assert.equal(migrated.trigger, 'manual', '前置：那条记录必须是 manual 触发，不是 initial');

  // ---- 本判据本体 ----
  assert.equal(outcome.mode, 'ready', `前置：最终必须落 ready；实际 ${JSON.stringify(outcome)}`);
  const baseline = lc.baselineOf(id);
  assert.equal(baseline.state, BASELINE_STATE.TRUSTED, `基线必须 trusted；实际 ${baseline.state}/${baseline.reason}`);
  assert.equal(baseline.epochId, 'u12-cmp@3',
    `基线必须停在那次手动迁移的周期（u12-cmp@3），不得被过期资格快照重置为 initial；实际 ${baseline.epochId}`);
  assert.deepEqual(baseline.names, [...BOUNDARY_NAMES],
    '基线名单必须是**边界那一刻**捕获的名单，而不是 adopt 之后变更过的当前配置');
  assert.equal(records.some((record) => record.epochId === 'u12-cmp@3' && record.trigger === 'initial'), false,
    '过期资格快照不得把手动迁移改写成 initial 记录');
  assert.equal(runtime.restoring, false, '终态后 restoring 必须归 false');
  for (const [, detail] of blockedLogs(logs)) assert.notEqual(detail.reason, null, '归因不得为 null');
});
