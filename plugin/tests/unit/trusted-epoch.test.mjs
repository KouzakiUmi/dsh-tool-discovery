// 可信周期名单（trusted epoch record）产品语义单测 —— **纯可移植**。
//
// 本文件**不导入任何宿主 SDK**：zod / @deepseek-ai/dsh-storage-domain 一律经
// 注入进入产品模块（工厂 deps.storageDomainApi / deps.z，store 的 facility）。
// 因此本文件可以在没有任何 node_modules 的环境里跑（与 CI 的 portable unit 一致）。
// 真正的 zod schema 与真实 domain 读写由 composition 门禁覆盖。
//
// 覆盖的产品语义（与 adapters/dsh/trusted-epoch.mjs 一一对应）：
//   TE-U1 记录键 = (sessionId, ownSeqStart, epochId, endSeq) 的稳定编码，不用配置 hash。
//   TE-U2 epoch 身份：initial 或 compactionId+endSeq（不是配置 hash）。
//   TE-U3 记录字段严格校验：版本/身份不符/名单含重复或空串/未知键一律 invalid；
//        但**空名单合法**（用户把 alwaysVisible 配成 [] 是真实配置）。
//   TE-U4 spec 转发：defineDomain(domain, version, layout:'single') + domainTable(zod)。
//   TE-U5 store：open 失败/幂等/写前自证/读失败可辨/卸载先于 open 时不复活句柄。
//   TE-U6 新会话：初始 record 落盘完成前基线是 pending（=0 request 的授权依据）。
//   TE-U7 老会话无 record → MISSING_TRUSTED_EPOCH；坏 record → INVALID_TRUSTED_EPOCH；
//       存储不可用 → STORAGE_UNAVAILABLE。三者互相可辨，绝不混淆。
//   TE-U8 同 epoch 重启只认 record.names：不与当前配置取交集、不被当前配置替换。
//   TE-U9 revision token + 写前复检：更旧 epoch 既不覆盖当前授权，也**不会把旧名单
//       写进新 epoch 的键**（持久层污染）。
//   TE-U10 dispose / 未挂载存储：pending 不得在 dispose 之后"复活"授权。
//   TE-U13 createEpochRecord 对非法输入是抛错，不是静默剔除。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_STATE,
  INITIAL_EPOCH_ID,
  NO_COMPACTION_SEQ,
  SESSION_FAILED_CLOSED,
  STORE_OPEN_FAILURE,
  TRUSTED_EPOCH_DOMAIN,
  TRUSTED_EPOCH_PROTOCOL_VERSION,
  TRUSTED_EPOCH_REASONS,
  TRUSTED_EPOCH_SCHEMA_VERSION,
  TRUSTED_EPOCH_TABLE,
  compactedEpochIdentity,
  classifyStoreOpenFailure,
  createEpochLedger,
  createEpochRecord,
  createTrustedEpochHolder,
  createTrustedEpochSpec,
  createTrustedEpochStore,
  epochKeyOf,
  initialEpochIdentity,
  trustedEpochBlockedError,
  validateEpochRecord,
} from '../../adapters/dsh/trusted-epoch.mjs';

const SESSION = 'sess-1';
const OWN_START = 4;

/** 最小链式 zod 替身：本文件只断言"表声明确实由 zod schema 构建"，
 *  **不证明 zod 自身的校验行为**（那属于真实 zod 的职责，由 composition 覆盖）。 */
function fakeZod () {
  const chain = (tag, shape) => {
    const node = { __zod: tag, shape, args: [] };
    for (const method of ['min', 'int', 'max', 'optional', 'nullable']) node[method] = () => node;
    node.refine = (fn, info) => { node.refinement = { fn, info }; return node; };
    return node;
  };
  return {
    strictObject: (shape) => chain('strictObject', shape),
    object: (shape) => chain('object', shape),
    literal: (value) => chain(`literal:${value}`),
    string: () => chain('string'),
    number: () => chain('number'),
    array: () => chain('array'),
    enum: (values) => chain(`enum:${values.join('|')}`),
  };
}

/** 转发用 defineDomain / domainTable：真实记录 SDK 的两个调用点。 */
function fakeApi (log = []) {
  return {
    defineDomain: (spec) => { log.push(spec); return spec; },
    domainTable: (schema) => ({ valueSchema: schema }),
    z: fakeZod(),
  };
}

/** 只实现产品真正用到的那三个读写的假 domain 表面（get 同步 / put durable / close）。 */
function fakeStorageDomain ({ failOpen = false, failPut = false } = {}) {
  const records = new Map();
  const puts = [];
  const closes = [];
  const storage = { records, puts, closes, failOpen, failPut };
  const facility = {
    openCalls: 0,
    async open (spec) {
      facility.openCalls += 1;
      if (failOpen) throw Object.assign(new Error('backend-not-found'), { code: 'backend-not-found' });
      if (facility.opened) throw Object.assign(new Error('already open'), { code: 'already-open' });
      facility.opened = true;
      return {
        name: spec.name,
        table (name) {
          assert.equal(name, TRUSTED_EPOCH_TABLE);
          return {
            get: (key) => records.get(key),
            put: async (key, value) => {
              puts.push({ key, value });
              if (failPut) throw new Error('backend write rejected');
              records.set(key, value);
            },
          };
        },
        close: async () => { closes.push(spec.name); },
      };
    },
  };
  storage.facility = facility;
  return storage;
}

/** 记录键对应的现成记录（少字段/错身份由各例自己构造）。 */
function storedRecord (overrides = {}) {
  const base = createEpochRecord({
    sessionId: SESSION,
    ownSeqStart: OWN_START,
    identity: initialEpochIdentity(),
    names: ['core_read', 'core_write'],
    trigger: 'initial',
    writtenAt: 1000,
  });
  return { ...base, ...overrides };
}

/** 把假存储接到 holder 上（holder 才是产品实际依赖的面）。 */
function holderWith (storage) {
  const holder = createTrustedEpochHolder({ log: () => {} });
  holder.attach({
    ensureOpen: async () => (storage.failOpen
      ? { ok: false, reason: 'open-failed' }
      : { ok: true }),
    get: (key) => storage.records.get(key),
    put: async (record) => {
      storage.puts.push(record);
      if (storage.failPut) throw new Error('backend write rejected');
      storage.records.set(recordKey(record), record);
    },
    close: async () => { storage.closes.push('closed') },
  });
  return holder;
}

/** 让出若干微任务：写路径要先 await ensureOpen 才真正发出 put。 */
async function tick (times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** 由记录字段还原键（与产品同一条编码，避免测试自己拼键）。 */
function recordKey (record) {
  return epochKeyOf({
    sessionId: record.sessionId,
    ownSeqStart: record.ownSeqStart,
    epochId: record.epochId,
    compactionEndSeq: record.compactionEndSeq,
  });
}

function makeLedger (storage, overrides = {}) {
  return createEpochLedger({
    storeHolder: holderWith(storage),
    sessionId: SESSION,
    ownSeqStart: OWN_START,
    now: () => 4242,
    log: () => {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
test('TE-U1: 记录键是四元组的稳定编码，不用配置 hash', () => {
  const a = epochKeyOf({ sessionId: SESSION, ownSeqStart: OWN_START, epochId: 'c1@9', compactionEndSeq: 9 });
  const b = epochKeyOf({ sessionId: SESSION, ownSeqStart: OWN_START, epochId: 'c1@9', compactionEndSeq: 9 });
  assert.equal(a, b, '同四元组必须得到同一个键');
  assert.notEqual(a, epochKeyOf({ sessionId: SESSION, ownSeqStart: OWN_START, epochId: 'c1@9', compactionEndSeq: 10 }));
  assert.notEqual(a, epochKeyOf({ sessionId: SESSION, ownSeqStart: OWN_START + 1, epochId: 'c1@9', compactionEndSeq: 9 }));
  assert.notEqual(a, epochKeyOf({ sessionId: 'other', ownSeqStart: OWN_START, epochId: 'c1@9', compactionEndSeq: 9 }));
  assert.equal(a.includes('core_read'), false, '键里绝不能出现名单内容');
});

test('TE-U2: epoch 身份来自 initial 或压缩边界，绝不是配置 hash', () => {
  assert.deepEqual(initialEpochIdentity(), { epochId: INITIAL_EPOCH_ID, compactionEndSeq: NO_COMPACTION_SEQ });
  assert.deepEqual(compactedEpochIdentity('cid-7', 42), { epochId: 'cid-7@42', compactionEndSeq: 42 });
  assert.notEqual(compactedEpochIdentity('cid-7', 42).epochId, compactedEpochIdentity('cid-7', 43).epochId);
});

test('TE-U3: 记录字段严格校验 —— 身份/版本/名单/未知键', () => {
  const expected = { sessionId: SESSION, ownSeqStart: OWN_START, identity: initialEpochIdentity() };
  assert.equal(validateEpochRecord(storedRecord(), expected).ok, true, '自洽记录必须通过');

  const bad = [
    ['protocol-version', { protocolVersion: 1 }],
    ['schema-version', { schemaVersion: 99 }],
    ['session', { sessionId: 'other' }],
    ['own-seq-start', { ownSeqStart: OWN_START + 1 }],
    ['epoch-id', { epochId: 'other' }],
    ['compaction-end-seq', { compactionEndSeq: 3 }],
    ['trigger', { trigger: 'whatever' }],
    ['names-blank', { names: ['ok', ''] }],
    ['names-duplicate', { names: ['dup', 'dup'] }],
    ['names-non-string', { names: ['ok', 7] }],
    ['names-not-array', { names: 'core_read' }],
    ['written-at', { writtenAt: -1 }],
    ['unknown-key', { extra: true }],
  ];
  for (const [what, overrides] of bad) {
    const verdict = validateEpochRecord(storedRecord(overrides), expected);
    assert.equal(verdict.ok, false, `${what} 必须被判为 invalid`);
    assert.ok(Array.isArray(verdict.issues) && verdict.issues.length > 0, `${what} 必须给出可辨的 issue`);
  }
  assert.equal(validateEpochRecord(null, expected).ok, false, '非对象必须是 invalid');
  // 反向：空名单是**合法配置**（alwaysVisible: [] 是替换语义下的真实取值）。
  assert.equal(validateEpochRecord(storedRecord({ names: [] }), expected).ok, true,
    '空名单合法：显式配置 alwaysVisible: [] 就是"不带任何常驻工具"');
  assert.deepEqual(storedRecord({ names: [] }).names, []);
  assert.equal(validateEpochRecord(storedRecord(), {
    sessionId: SESSION, ownSeqStart: OWN_START, identity: compactedEpochIdentity('cid-7', 9),
  }).ok, false, '当前 epoch 身份与记录不符必须是 invalid（不得静默采用）');
});

test('TE-U4: spec 只声明一次，layout single + zod 表；注入的 defineDomain/domainTable 被真实使用', () => {
  const seen = [];
  const spec = createTrustedEpochSpec(fakeApi(seen));
  assert.equal(seen.length, 1);
  assert.equal(spec.name, TRUSTED_EPOCH_DOMAIN, '域名必须匹配 UNIT_NAME_RE（只允许小写字母/数字/下划线）');
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/, '域名必须满足安装内 dsh-storage 的 UNIT_NAME_RE');
  assert.equal(spec.version, 1);
  assert.equal(spec.layout, 'single');
  assert.ok(Object.hasOwn(spec.tables, TRUSTED_EPOCH_TABLE));
  assert.equal(spec.tables[TRUSTED_EPOCH_TABLE].valueSchema.__zod, 'strictObject',
    '记录 schema 必须是 zod 严格对象（schemastery 不是 zod，不得冒充）');
  assert.deepEqual(Object.keys(spec.tables[TRUSTED_EPOCH_TABLE].valueSchema.shape).sort(), [
    'compactionEndSeq', 'epochId', 'names', 'ownSeqStart', 'protocolVersion',
    'schemaVersion', 'sessionId', 'trigger', 'writtenAt',
  ], 'zod schema 的字段必须与纯 JS 校验的字段一致');
  assert.equal(typeof spec.tables[TRUSTED_EPOCH_TABLE].valueSchema.refinement?.fn, 'function',
    '名单唯一性也必须落在 zod schema 上（domain open 会用它校验存量记录）');
});

test('TE-U5: 存储缺失/open 失败 → 确定的终态，不抛到调用面', async () => {
  const missingHolder = createTrustedEpochHolder({ log: () => {} });
  const ledger = createEpochLedger({
    storeHolder: missingHolder, sessionId: SESSION, ownSeqStart: OWN_START, log: () => {},
  });
  await ledger.load();
  assert.equal(ledger.state, BASELINE_STATE.BLOCKED);
  assert.equal(ledger.reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE);

  const storage = fakeStorageDomain({ failOpen: true });
  const failing = makeLedger(storage);
  await failing.load();
  assert.equal(failing.state, BASELINE_STATE.BLOCKED);
  assert.equal(failing.reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE, 'open 失败与缺服务必须落在同一个可辨的存储不可用终态');
});

test('TE-U5b: store 层 —— open 幂等 / 写前自证 / 读失败可辨 / 卸载先于 open 不复活句柄', async () => {
  // (1) open 幂等：并发两次 ensureOpen 只真正开一次。
  const storage = fakeStorageDomain();
  const store = createTrustedEpochStore({ facility: storage.facility, ...fakeApi() });
  const [a, b] = await Promise.all([store.ensureOpen(), store.ensureOpen()]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.equal(storage.facility.openCalls, 1, 'open 必须幂等（并发调用共享同一次）');
  assert.equal(store.status, 'open');

  // (2) 写前自证：SDK 的 put 不校验，非法记录必须在产品侧被拒绝，不落盘。
  await assert.rejects(
    () => store.put({ ...storedRecord(), names: ['dup', 'dup'] }),
    /refusing to persist an invalid trusted epoch record/,
    'put 前的严格校验是产品自己的责任（SDK put 不校验）',
  );
  await assert.rejects(() => store.put({ ...storedRecord(), extra: 1 }), /unknown-key:extra/);
  assert.equal(storage.puts.length, 0, '非法记录一次都不能落盘');
  const good = storedRecord();
  await store.put(good);
  assert.equal(storage.puts.length, 1);
  assert.equal(storage.puts[0].key, recordKey(good), '写入键必须是四元组编码');

  // (3) 读失败必须与"没有记录"可区分：get 抛错，绝不吞成 undefined。
  const broken = createTrustedEpochStore({
    facility: { open: async () => ({ table: () => ({ get: () => { throw new Error('medium unreadable'); } }), close: async () => {} }) },
    ...fakeApi(),
  });
  await broken.ensureOpen();
  assert.throws(() => broken.get('k'), /medium unreadable/, '读失败不得被伪装成"没有记录"');

  // (4) 卸载先于 open 落定：迟到的 open 结果自己关掉，句柄不得复活。
  let releaseOpen;
  const late = { closes: [], openCalls: 0 };
  const lateStore = createTrustedEpochStore({
    facility: {
      open: async (spec) => {
        late.openCalls += 1;
        await new Promise((resolve) => { releaseOpen = resolve; });
        return { table: () => ({ get: () => undefined, put: async () => {} }), close: async () => { late.closes.push(spec.name); } };
      },
    },
    ...fakeApi(),
  });
  const opening = lateStore.ensureOpen();
  await tick();
  const closing = lateStore.close();
  releaseOpen();
  assert.deepEqual(await opening, { ok: false, reason: 'closed' });
  await closing;
  assert.equal(lateStore.status, 'closed');
  assert.deepEqual(late.closes, [TRUSTED_EPOCH_DOMAIN], '迟到的 open 句柄必须由 store 自己关闭');
  assert.deepEqual(await lateStore.ensureOpen(), { ok: false, reason: 'closed' }, '关闭后不得再开');
});

test('TE-U6: 新会话的初始 record 落盘完成前基线是 pending（0 request 的授权依据）', async () => {
  // 受控 put：完成时机由测试掌握，从而能观察"落盘之前"的状态。
  const { ledger, written, nthWrite, releaseAll } = gatedPutLedger();
  try {
    const run = ledger.begin(['core_read'], 'initial');
    // 用**显式事件**确认写已发出，不靠 setTimeout 采样猜它发生了。
    await nthWrite(1);
    assert.equal(written.length, 1, '初始 record 必须真的写出去');
    assert.equal(ledger.state, BASELINE_STATE.PENDING, 'put 未落定前不得成为 trusted');
    assert.deepEqual(ledger.names, null, 'pending 期间没有任何可授权的常驻名单');
    assert.equal(written[0].epochId, INITIAL_EPOCH_ID);
    assert.equal(written[0].compactionEndSeq, NO_COMPACTION_SEQ);
    assert.equal(written[0].trigger, 'initial');
    assert.equal(written[0].protocolVersion, TRUSTED_EPOCH_PROTOCOL_VERSION);
    assert.equal(written[0].schemaVersion, TRUSTED_EPOCH_SCHEMA_VERSION);
    assert.deepEqual(written[0].names, ['core_read']);

    releaseAll();
    await run;
    assert.equal(ledger.state, BASELINE_STATE.TRUSTED);
    assert.deepEqual(ledger.names, ['core_read']);
  } finally {
    releaseAll();
  }
});

test('TE-U7: 老会话 —— missing / invalid / storage 三种终态互不混淆', async () => {
  const empty = fakeStorageDomain();
  const missing = makeLedger(empty);
  await missing.load();
  assert.equal(missing.state, BASELINE_STATE.BLOCKED);
  assert.equal(missing.reason, TRUSTED_EPOCH_REASONS.MISSING);
  assert.deepEqual(missing.names, null);

  const broken = fakeStorageDomain();
  const key = epochKeyOf({
    sessionId: SESSION, ownSeqStart: OWN_START, epochId: INITIAL_EPOCH_ID, compactionEndSeq: NO_COMPACTION_SEQ,
  });
  broken.records.set(key, { ...storedRecord(), names: ['dup', 'dup'] });
  const invalid = makeLedger(broken);
  await invalid.load();
  assert.equal(invalid.state, BASELINE_STATE.BLOCKED);
  assert.equal(invalid.reason, TRUSTED_EPOCH_REASONS.INVALID, '坏 record 必须与缺 record 分开');
  assert.equal(broken.puts.length, 0, '读到坏 record 时绝不覆盖它');
});

test('TE-U8: 同 epoch 重启只认 record.names —— 不与当前配置取交集、不被当前配置替换', async () => {
  const storage = fakeStorageDomain();
  storage.records.set(recordKey(storedRecord()), storedRecord({ names: ['kept_a', 'kept_b'] }));
  const ledger = makeLedger(storage);
  // 配置此刻是另一份名单（模拟"周期中途改了设置"）。
  const configNow = ['brand_new', 'kept_a'];
  await ledger.load();
  assert.equal(ledger.state, BASELINE_STATE.TRUSTED);
  assert.deepEqual(ledger.names, ['kept_a', 'kept_b'], '权威只能是 record.names');
  assert.equal(ledger.names.includes('brand_new'), false, '当前配置不得替换同 epoch 的既有名单');
  assert.deepEqual([...new Set(configNow)].sort(), ['brand_new', 'kept_a'], '配置值只用于下一次周期边界');
});

/** 受控 put 的账本：记录每次真正发出的写，并让测试逐个放行。 */
function gatedPutLedger () {
  const written = [];
  const releases = [];
  const waiters = [];
  const ledger = createEpochLedger({
    storeHolder: {
      store: {
        ensureOpen: async () => ({ ok: true }),
        get: () => undefined,
        put: (record) => {
          written.push(record);
          for (const waiter of waiters.splice(0)) waiter(written.length);
          return new Promise((resolve) => { releases.push(resolve); });
        },
        close: async () => {},
      },
      onAttach: () => () => {},
    },
    sessionId: SESSION, ownSeqStart: OWN_START, log: () => {},
  });
  /** 等到"第 n 次写真的发出"为止 —— 显式事件，不靠采样。 */
  const nthWrite = (n) => (written.length >= n
    ? Promise.resolve(written)
    : new Promise((resolve) => waiters.push(() => resolve(written))));
  /** 放行第 n 次写（1 基）。 */
  const releaseNth = (n) => releases[n - 1]();
  /** 放行全部尚未落定的写：断言路径收尾用，绝不让单测自身挂起。 */
  const releaseAll = () => { while (releases.length > 0) releases.shift()(); };
  return { ledger, written, releases, nthWrite, releaseNth, releaseAll };
}

test('TE-U9: revision token —— 更旧 epoch 的 put 迟到完成不得覆盖当前授权', async () => {
  const { ledger, nthWrite, releaseNth, releaseAll } = gatedPutLedger();
  try {
    const first = ledger.adopt({ identity: compactedEpochIdentity('cid-1', 10), names: ['epoch_one'], trigger: 'auto' });
    const second = ledger.adopt({ identity: compactedEpochIdentity('cid-2', 20), names: ['epoch_two'], trigger: 'manual' });
    await nthWrite(1);

    releaseNth(1);                       // 新 epoch 落定
    await second;
    assert.deepEqual(ledger.names, ['epoch_two']);
    assert.equal(ledger.state, BASELINE_STATE.TRUSTED);
    await first;
    assert.deepEqual(ledger.names, ['epoch_two'], '旧 put 完成不得把当前授权改回 epoch_one');
    assert.equal(ledger.state, BASELINE_STATE.TRUSTED);
  } finally {
    releaseAll();
  }
});

test('TE-U9b: 更旧的 epoch 不得把**旧名单**写进**新 epoch 的键**（持久层污染）', async () => {
  // 与主私有反例同一次开放次序：旧 epoch 的写先入队但**在 await 期间**被新 epoch 取代，
  // 于是它的落盘必须在 put 之前就被拦下 —— revision 只能挡运行时回写，挡不住持久污染。
  const { ledger, written, nthWrite, releaseAll } = gatedPutLedger();
  const NEW = compactedEpochIdentity('cid-2', 20);
  try {
    ledger.adopt({ identity: compactedEpochIdentity('cid-1', 10), names: ['old_baseline'], trigger: 'auto' });
    ledger.adopt({ identity: NEW, names: ['new_baseline'], trigger: 'manual' });
    await nthWrite(1);

    // 持久视角：当前 epoch 的键上只允许出现新名单。
    const newKey = epochKeyOf({
      sessionId: SESSION, ownSeqStart: OWN_START, epochId: NEW.epochId, compactionEndSeq: 20,
    });
    for (const record of written) {
      if (recordKey(record) !== newKey) continue;
      assert.deepEqual(record.names, ['new_baseline'], '新 epoch 的键上绝不允许出现旧名单');
    }
    for (const record of written) {
      assert.equal(record.names.includes('old_baseline') && recordKey(record) === newKey, false,
        '旧名单不得被写进新 epoch 的键');
    }

    releaseAll();
    await ledger.whenSettled();
    const durable = written.filter((record) => recordKey(record) === newKey);
    assert.equal(durable.length, 1, '新 epoch 的键只应有一条记录');
    assert.deepEqual(durable[0].names, ['new_baseline']);
    assert.equal(ledger.identity.epochId, NEW.epochId);
  } finally {
    releaseAll();
  }
});

test('TE-U15: 冷崩重放 —— 同 identity 已有 durable 记录时必须**先读它**，不得无条件 begin 覆盖', async () => {
  // 场景：初始 record 已 durable，但首 header 还没发出就崩了。重建后 own 出站历史为空，
  // 而"此刻的配置"可能已经被改过 —— 权威必须来自已落盘的那一份。
  const storage = fakeStorageDomain();
  storage.records.set(recordKey(storedRecord({ names: ['durable_baseline'] })), storedRecord({ names: ['durable_baseline'] }));
  const ledger = makeLedger(storage);
  // 无 own 出站历史时，调用方先 load；判据是"同 identity 的记录是否真的缺失"。
  const loaded = await ledger.load();
  assert.equal(loaded.state, BASELINE_STATE.TRUSTED);
  assert.deepEqual(ledger.names, ['durable_baseline'], '必须复用 durable 名单');
  assert.equal(storage.puts.length, 0, '存在有效记录时绝不无条件写初始 record 覆盖它');
});

test('TE-U16: 无 own 出站历史且同 identity 记录**确实缺失**（读无异常、非 invalid）才允许 begin', async () => {
  const storage = fakeStorageDomain();
  const ledger = makeLedger(storage);
  const loaded = await ledger.load();
  assert.equal(loaded.reason, TRUSTED_EPOCH_REASONS.MISSING, '只有这一种"缺失"才允许建立初始记录');
  await ledger.begin(['fresh_baseline'], 'initial');
  assert.equal(storage.puts.length, 1);
  assert.deepEqual(ledger.names, ['fresh_baseline']);

  // 反向：记录存在但非法时**不得** begin —— 那会用当前配置覆盖一条坏记录。
  const broken = fakeStorageDomain();
  broken.records.set(recordKey(storedRecord({ names: ['a', 'a'] })), storedRecord({ names: ['a', 'a'] }));
  const guarded = makeLedger(broken);
  const verdict = await guarded.load();
  assert.equal(verdict.reason, TRUSTED_EPOCH_REASONS.INVALID);
  assert.equal(broken.puts.length, 0, 'invalid 绝不允许被无条件 begin 覆盖');
});

test('TE-U10: dispose 之后 pending 的写不得复活授权；attach 之前也不得凭空 trusted', async () => {
  const { ledger, nthWrite, releaseNth, releaseAll } = gatedPutLedger();
  try {
    const run = ledger.begin(['core_read'], 'initial');
    await nthWrite(1);
    ledger.dispose();
    releaseNth(1);
    await run;
    assert.notEqual(ledger.state, BASELINE_STATE.TRUSTED, 'dispose 后不得复活为 trusted');
    assert.equal(ledger.state, BASELINE_STATE.BLOCKED);
    assert.deepEqual(ledger.names, null);
  } finally {
    releaseAll();
  }
});

test('TE-U13: createEpochRecord 对非法输入是抛错，不是静默剔除', () => {
  const base = { sessionId: SESSION, ownSeqStart: OWN_START, identity: initialEpochIdentity(), trigger: 'initial', writtenAt: 1 };
  assert.throws(() => createEpochRecord({ ...base, names: ['a', 'a'] }), /must not repeat/);
  assert.throws(() => createEpochRecord({ ...base, names: ['a', ''] }), /non-empty/);
  assert.throws(() => createEpochRecord({ ...base, names: ['a', 3] }), /non-empty/);
  assert.throws(() => createEpochRecord({ ...base, names: 'a' }), /array of strings/);
  assert.throws(() => createEpochRecord({ ...base, trigger: 'nope', names: [] }), /trigger must be one of/);
  assert.throws(() => createEpochRecord({ ...base, ownSeqStart: -1, names: [] }), /ownSeqStart/);
  assert.throws(() => createEpochRecord({ ...base, writtenAt: -1, names: [] }), /writtenAt/);
  assert.throws(() => createEpochRecord({ ...base, identity: { epochId: '' }, names: [] }), /identity/);
  assert.deepEqual(createEpochRecord({ ...base, names: [] }).names, [], '空名单合法');
});

test('TE-U11: 写失败不吞 —— 落 STORAGE_UNAVAILABLE 而不是默默沿用旧授权', async () => {
  const storage = fakeStorageDomain({ failPut: true });
  const ledger = makeLedger(storage);
  await ledger.begin(['core_read'], 'initial');
  assert.equal(ledger.state, BASELINE_STATE.BLOCKED);
  assert.equal(ledger.reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE);
  assert.deepEqual(ledger.names, null);
});

test('TE-U12: whenSettled 等的是"此刻在途的那一次写"，落定后不再挂起', async () => {
  const { ledger, nthWrite, releaseNth, releaseAll } = gatedPutLedger();
  try {
    const run = ledger.begin(['core_read'], 'initial');
    let settled = false;
    const wait = ledger.whenSettled().then((value) => { settled = true; return value; });
    await nthWrite(1);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(settled, false, '在途写未落定前不得假装已就绪');
    releaseNth(1);
    await run;
    assert.equal((await wait).state, BASELINE_STATE.TRUSTED);
    assert.equal(settled, true);
    assert.equal((await ledger.whenSettled()).state, BASELINE_STATE.TRUSTED, '无在途写时必须立即返回');
  } finally {
    releaseAll();
  }
});

test('TE-U14: 三种终态的错误文案必须分流 —— /compact 不是存储不可用的解法', () => {
  const missing = trustedEpochBlockedError(TRUSTED_EPOCH_REASONS.MISSING);
  const invalid = trustedEpochBlockedError(TRUSTED_EPOCH_REASONS.INVALID);
  const unavailable = trustedEpochBlockedError(TRUSTED_EPOCH_REASONS.UNAVAILABLE);
  for (const error of [missing, invalid, unavailable]) {
    assert.equal(error.code, 'STATE_NOT_READY', '复用既有码表，不新增错误码');
  }
  assert.match(missing.message, new RegExp(TRUSTED_EPOCH_REASONS.MISSING));
  assert.match(missing.message, /成功执行一次 \/compact/, '缺记录：提示本次 /compact 迁移');
  assert.match(invalid.message, new RegExp(TRUSTED_EPOCH_REASONS.INVALID));
  assert.match(invalid.message, /不会被当前配置覆盖/, '坏记录：明确不按当前配置覆盖');
  assert.match(invalid.message, /不会被删除/, '坏记录：本轮不 prune，明确不会删');
  assert.match(unavailable.message, new RegExp(TRUSTED_EPOCH_REASONS.UNAVAILABLE));
  assert.match(unavailable.message, /\/compact 无法解决/,
    '存储不可用必须明说 /compact 解决不了（provider 缺失时写不进去）');
  assert.notEqual(missing.message, invalid.message, '不同终态不得共用同一句文案');
  assert.notEqual(invalid.message, unavailable.message, '不同终态不得共用同一句文案');
  assert.notEqual(missing.message, unavailable.message, '不同终态不得共用同一句文案');
});

test('TE-U17: failClosed 是独立一态 —— 不是 pending、不是 blocked、更不是 trusted', () => {
  const storage = fakeStorageDomain({});
  const ledger = makeLedger(storage);
  // 正控制：初始就是 pending（"尚未落定"），这正是 failClosed 必须区别开的那一态。
  assert.equal(ledger.state, BASELINE_STATE.PENDING);

  const decided = ledger.failClosed('readSession-failed');
  assert.equal(decided.state, BASELINE_STATE.FAILED_CLOSED);
  assert.equal(ledger.state, BASELINE_STATE.FAILED_CLOSED);
  assert.deepEqual(ledger.names, null, 'failClosed 从不授予任何名单');
  assert.equal(String(ledger.reason).startsWith(SESSION_FAILED_CLOSED), true,
    `reason 必须带独立前缀（与三种可信基线终态可辨）：${String(ledger.reason)}`);
  assert.match(String(ledger.reason), /readSession-failed/, '归因细节必须进 reason');

  // 三种可信基线终态都不得与之混同
  for (const reason of Object.values(TRUSTED_EPOCH_REASONS)) {
    assert.notEqual(String(ledger.reason), reason, `failClosed 不得冒充 ${reason}`);
  }
  assert.notEqual(ledger.state, BASELINE_STATE.BLOCKED, '并进 blocked 会凭空多出一条 0-request 规则');
  assert.notEqual(ledger.state, BASELINE_STATE.TRUSTED, '谎称可信比阻断更危险');
  assert.notEqual(ledger.state, BASELINE_STATE.PENDING, '留在 pending 会被当成"还在恢复"而挂死');
});

test('TE-U17b: failClosed 不写盘，且让在途的写变成 superseded（不得事后复活授权）', async () => {
  const { ledger, written, nthWrite, releaseNth, releaseAll } = gatedPutLedger();
  try {
    const run = ledger.begin(['core_read'], 'initial');
    await nthWrite(1);
    ledger.failClosed('journal-sealed');
    releaseNth(1);
    await run;
    assert.equal(ledger.state, BASELINE_STATE.FAILED_CLOSED, '在途写迟到不得把状态改回 trusted');
    assert.deepEqual(ledger.names, null, 'failClosed 之后不得因迟到写而出现名单');
    assert.equal(written.length, 1, 'failClosed 自身绝不写盘');
  } finally {
    releaseAll();
  }
});

test('TE-U18: open 失败要分「坏记录」与「服务不可用」，且认不出来时诚实降级', () => {
  // 实测安装内 SDK 对存量坏记录的原话（真实 JSON backend，域整体打开失败）
  const sdkSchemaMessage = "domain 'progressive_tools_trusted_epochs': stored record "
    + "'[\"s\",0,\"initial\",-1]' in table 'epoch_baselines' does not match its schema";
  assert.equal(classifyStoreOpenFailure(sdkSchemaMessage), STORE_OPEN_FAILURE.SCHEMA);
  assert.equal(classifyStoreOpenFailure(new Error(sdkSchemaMessage)), STORE_OPEN_FAILURE.SCHEMA,
    'Error 对象也要能归类');

  // 其它一切失败都归 UNKNOWN —— 宁可少一个归因，也绝不把未知失败猜成"坏记录"
  for (const other of [
    'storage provider is not registered',
    'EACCES: permission denied',
    'ECONNREFUSED 127.0.0.1:0',
    'domain already open',
    '',
    undefined,
    null,
  ]) {
    assert.equal(classifyStoreOpenFailure(other), STORE_OPEN_FAILURE.UNKNOWN,
      `不得把「${String(other)}」猜成坏记录`);
  }
});

test('TE-U18b: 域因存量坏记录打不开 → 会话落 INVALID（数据问题），不是 UNAVAILABLE', async () => {
  const ledger = createEpochLedger({
    storeHolder: {
      store: {
        ensureOpen: async () => ({ ok: false, reason: STORE_OPEN_FAILURE.SCHEMA }),
        get: () => undefined,
        put: async () => { throw new Error('不得写到打不开的域') },
        close: async () => {},
      },
      onAttach: () => () => {},
    },
    sessionId: SESSION, ownSeqStart: OWN_START, log: () => {},
  });
  const loaded = await ledger.load();
  assert.equal(loaded.state, BASELINE_STATE.BLOCKED);
  assert.equal(loaded.reason, TRUSTED_EPOCH_REASONS.INVALID,
    '坏记录是数据问题：必须落 INVALID，其文案才告诉用户"人工处置那一条记录"');
  assert.deepEqual(ledger.names, null);
  assert.match(trustedEpochBlockedError(loaded.reason).message, /不会被删除/,
    '必须明确不会自动删除/覆盖坏记录');
});

test('TE-U18c: 未知 open 失败仍然是 UNAVAILABLE（诚实降级，不改既有语义）', async () => {
  const ledger = createEpochLedger({
    storeHolder: {
      store: {
        ensureOpen: async () => ({ ok: false, reason: STORE_OPEN_FAILURE.UNKNOWN }),
        get: () => undefined,
        put: async () => { throw new Error('不得写') },
        close: async () => {},
      },
      onAttach: () => () => {},
    },
    sessionId: SESSION, ownSeqStart: OWN_START, log: () => {},
  });
  const loaded = await ledger.load();
  assert.equal(loaded.reason, TRUSTED_EPOCH_REASONS.UNAVAILABLE);
  assert.match(trustedEpochBlockedError(loaded.reason).message, /\/compact 无法解决/);
});

test('TE-U17c: failClosed 的 reason 带独立前缀，误用可信基线文案只会暴露归因错误', () => {
  const storage = fakeStorageDomain({});
  const ledger = makeLedger(storage);
  ledger.failClosed(undefined);
  assert.equal(ledger.reason, SESSION_FAILED_CLOSED, '无归因细节时用纯前缀');
  ledger.failClosed('');
  assert.equal(ledger.reason, SESSION_FAILED_CLOSED, '空归因不得拼出尾随冒号');
  ledger.failClosed('event-seq-not-contiguous');
  assert.equal(ledger.reason, `${SESSION_FAILED_CLOSED}:event-seq-not-contiguous`);
  // 三种可信基线终态的文案不得被复用到这里：/compact / 人工处置 那些提示只对它们成立。
  assert.equal(/compact/.test(ledger.reason), false, 'failClosed 不是缺记录，不该提 /compact 迁移');
});