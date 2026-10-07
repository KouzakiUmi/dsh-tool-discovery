// plugin/adapters/dsh/trusted-epoch.mjs
// **可信常驻名单的权威来源**：官方 `ctx.storageDomain` 上的持久记录。
//
// 为什么不再用日志反推（这是本模块存在的唯一理由）：
//   旧实现在冷恢复时取「本周期第一条 request/header 里出现过的工具名」当作常驻名单
//   （journal.mjs 的 epoch-names bootstrap）。那份数组是**出站日志**：只要历史上某一轮
//   有别的 listener 在我们投影之后又加了一个工具，它就会进入恢复出的授权名单，而 guard
//   对 alwaysNameSet 直接早退放行 —— 模型猜名即可执行，从未经过 canonical 折叠。
//   出站事实不能反推授权。
//
// 权威判据（全部来自本插件**自己拥有**的成功压缩边界 + 用户显式配置）：
//   * 记录只由两条路径产生：① 无 own 出站历史的新会话/own-only fork 的**初始**记录；
//     ② 一次**成功**压缩（canonical start/summary/end 三段严格成立）后的新周期记录。
//   * 记录身份 = (sessionId, ownSeqStart, epochId, compactionEndSeq)。epochId 是
//     `initial` 或 `compactionId@endSeq` —— **不是配置 hash**：配置在周期中途变了不该
//     把旧周期改写成新周期。
//   * 同一 epoch 重启只读 record.names：不与当前配置取交集，也不被当前配置替换。
//   * 缺 record（missing）、坏 record（invalid）、存储不可用（unavailable）是三个
//     **互不混淆**的终态：都明确报出、都不发请求，也都**不**把 journal 封死
//     —— 只有本次 live 的真实用户 `/compact` 成功才能把老会话迁出来。
//
// 依赖注入纪律：本模块**顶层不 import 任何宿主包**。zod 与 @deepseek-ai/dsh-storage-domain
// 由工厂 deps.z / deps.storageDomainApi 注入，测试可直接注入真实安装内的副本；因此本文件
// 可在没有任何 node_modules 的环境里被单测加载。
import { DomainError } from '../../domain/index.mjs';

/** 记录协议版本 / 记录 schema 版本。两者都必须严格匹配，不做向前兼容猜测。 */
export const TRUSTED_EPOCH_PROTOCOL_VERSION = 2;
export const TRUSTED_EPOCH_SCHEMA_VERSION = 1;

/**
 * 域名必须匹配安装内 `UNIT_NAME_RE`（/^[a-z][a-z0-9_]*$/，@deepseek-ai/dsh-storage
 * lib/index.js:80），所以只能用小写字母、数字与下划线，且不能以数字开头。
 */
export const TRUSTED_EPOCH_DOMAIN = 'progressive_tools_trusted_epochs';
export const TRUSTED_EPOCH_TABLE = 'epoch_baselines';

/** 未压缩过的初始周期的身份。 */
export const INITIAL_EPOCH_ID = 'initial';
/** 初始周期没有压缩边界，用 -1 表示"压缩之前不存在"（seq 恒非负）。 */
export const NO_COMPACTION_SEQ = -1;

/** 存储类失败的三种**可辨**终态。reason 稳定，可被门禁与日志按值判别。 */
export const TRUSTED_EPOCH_REASONS = Object.freeze({
  MISSING: 'MISSING_TRUSTED_EPOCH',
  INVALID: 'INVALID_TRUSTED_EPOCH',
  UNAVAILABLE: 'STORAGE_UNAVAILABLE',
});

/**
 * `store.ensureOpen()` 的失败细分：open 失败**不只有**一种原因。
 *
 * 实测（安装内 @deepseek-ai/dsh-storage-domain 0.2.1-alpha.1，真实 JSON backend）：
 * 存量里存在一条**与 schema 不匹配**的记录时，`facility.open(spec)` 会让**整个域**
 * 打开失败，报
 *   `domain 'progressive_tools_trusted_epochs': stored record '<key>' in table
 *    'epoch_baselines' does not match its schema`
 * 这**不是**"存储服务不可用"：provider 健康、网络正常，只是数据里有一行读不出来。把它
 * 报成 UNAVAILABLE 会让用户去"恢复存储服务"，而真正要做的是处置那一行数据。
 *
 * 因此这里把 open 失败再分一层，让 ledger 能落到 **INVALID**（其既有文案已经明确写了
 * "不会被覆盖、不会被删除，请人工处置"）。
 *
 * **诚实降级**：这是对 SDK 文案的最佳努力分类。认不出来时一律回 `open-failed`（即今天
 * 的 UNAVAILABLE 行为）—— 宁可少一个归因，也绝不把未知失败猜成"坏记录"。
 */
export const STORE_OPEN_FAILURE = Object.freeze({
  SCHEMA: 'invalid-stored-record',
  UNKNOWN: 'open-failed',
});

/**
 * 把 SDK 的 open 失败文案归类。**只**认 SDK 自己那句 schema 不匹配的措辞；
 * 其它一切（含 provider 缺失、权限、磁盘错误）都归 UNKNOWN。
 * @param {unknown} message
 * @returns {string} STORE_OPEN_FAILURE 之一
 */
export function classifyStoreOpenFailure (message) {
  const text = typeof message === 'string' ? message : String(message?.message ?? message ?? '')
  return /does not match its schema/i.test(text)
    ? STORE_OPEN_FAILURE.SCHEMA
    : STORE_OPEN_FAILURE.UNKNOWN;
}

/**
 * 把一次 store 访问失败映射成**可信基线的终态**。
 *
 * 只有一种情况不是 UNAVAILABLE：域因为存量记录与 schema 不匹配而打不开 → INVALID
 * （数据问题，处置那一行；服务本身健康）。其余一切 —— provider 缺席、open 抛错、
 * 读盘失败、句柄已关闭 —— 都是 UNAVAILABLE。
 * @param {any} error 捕获到的异常（携带 openFailure 时按它归类）
 * @returns {string} TRUSTED_EPOCH_REASONS 之一
 */
function baselineReasonForStoreFailure (error) {
  return error?.openFailure === STORE_OPEN_FAILURE.SCHEMA
    ? TRUSTED_EPOCH_REASONS.INVALID
    : TRUSTED_EPOCH_REASONS.UNAVAILABLE;
}

/** 抛出带 open 失败归类的异常，供上面的 baselineReasonForStoreFailure 消费。 */
function storeOpenFailure (reason) {
  const error = new Error(`trusted epoch store open failed: ${reason ?? 'unknown'}`);
  error.openFailure = reason;
  return error;
}

/**
 * 基线状态机。pending 同样意味着"不可授权"（0 request），不是一个可发请求的态。
 *
 * `failed-closed` 是**第四个**态，也是最容易与前三个混淆的一个，所以单独说明：
 * 它**不是**可信基线的终态，而是"本会话因为与可信周期无关的既有原因（journal
 * 自身损坏 / readSession 失败 / 严重 seq 不连续）已 fail closed"。这三种情形在本模块
 * 出现之前就有明确的既有语义：**请求照发、只带基线、执行照拒**（见 L11b / RB2）。
 * 把它并进 BLOCKED 会让那些会话变成 0 request（等于凭空多出一条"请求不得发出"的
 * 新规则，且会把同 composition 里其它会话的请求队列错位）；把它并进 TRUSTED 则是
 * 谎称"名单已可信"。因此它是独立一态：投影照常放行这一次请求（引擎仍 incompatible，
 * 披露只剩基线），guard 仍然拒绝每一次非入口调用（`baseline !== TRUSTED` 早于
 * alwaysNameSet 早退），出站与执行两侧的既有判据都原样保留。
 */
export const BASELINE_STATE = Object.freeze({
  PENDING: 'pending',
  TRUSTED: 'trusted',
  BLOCKED: 'blocked',
  FAILED_CLOSED: 'failed-closed',
});

/** `failed-closed` 的 reason 前缀：明确区别于三种可信基线终态，便于日志与门禁按值判别。 */
export const SESSION_FAILED_CLOSED = 'SESSION_FAILED_CLOSED';

const TRIGGERS = Object.freeze(['initial', 'manual', 'auto']);

/** 记录的全部合法字段。**没有**可选项，也**没有**向前兼容的未知键。 */
const RECORD_KEYS = Object.freeze([
  'protocolVersion', 'schemaVersion', 'sessionId', 'ownSeqStart',
  'epochId', 'compactionEndSeq', 'names', 'trigger', 'writtenAt',
]);

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 名单**严格**归一：非数组、非字符串、空串、重复项一律抛错，绝不静默剔除。
 *
 * 空数组是**合法**的（用户把 alwaysVisible 显式配成 `[]` 是真实配置，config.mjs 的
 * 替换语义就是这么定义的），所以这里只拒绝非法项，不拒绝"空"。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function assertEpochNames (raw) {
  if (!Array.isArray(raw)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch names must be an array of strings');
  }
  const seen = new Set();
  for (const name of raw) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch names must contain non-empty strings');
    }
    if (seen.has(name)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `trusted epoch names must not repeat "${name}"`);
    }
    seen.add(name);
  }
  return [...raw];
}

/** 四元组的稳定编码。**刻意不用配置 hash**：键只标识"哪一个 epoch 的哪一份名单"。 */
export function epochKeyOf ({ sessionId, ownSeqStart, epochId, compactionEndSeq }) {
  return JSON.stringify([String(sessionId), ownSeqStart, String(epochId), compactionEndSeq]);
}

/** 初始周期身份。 */
export function initialEpochIdentity () {
  return { epochId: INITIAL_EPOCH_ID, compactionEndSeq: NO_COMPACTION_SEQ };
}

/** 压缩后的周期身份：compactionId + endSeq。 */
export function compactedEpochIdentity (compactionId, compactionEndSeq) {
  return { epochId: `${String(compactionId)}@${compactionEndSeq}`, compactionEndSeq };
}

/** 从一条记录还原它自己的键（写入路径与诊断用同一条编码）。 */
export function epochKeyOfRecord (record) {
  return epochKeyOf({
    sessionId: record.sessionId,
    ownSeqStart: record.ownSeqStart,
    epochId: record.epochId,
    compactionEndSeq: record.compactionEndSeq,
  });
}

/**
 * 构造一条记录。**形状与 zod schema 一一对应**，且非法输入直接抛错：
 * 写出去的形状必须由本模块自己保证 —— 安装内 `table.put` **不做** schema 校验
 * （校验只发生在 open 的 loadAll 路径），所以"写前自证"是唯一的一道。
 * @param {{sessionId:string, ownSeqStart:number, identity:{epochId:string, compactionEndSeq:number},
 *          names:readonly string[], trigger:'initial'|'manual'|'auto', writtenAt:number}} input
 */
export function createEpochRecord (input) {
  if (input === null || typeof input !== 'object') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch record input must be an object');
  }
  if (!TRIGGERS.includes(input.trigger)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', `trusted epoch trigger must be one of ${TRIGGERS.join('|')}`);
  }
  const identity = input.identity;
  if (!isPlainObject(identity) || typeof identity.epochId !== 'string' || identity.epochId.length === 0
    || !Number.isSafeInteger(identity.compactionEndSeq)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch identity must be {epochId, compactionEndSeq}');
  }
  if (!Number.isSafeInteger(input.ownSeqStart) || input.ownSeqStart < 0) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch ownSeqStart must be a non-negative integer');
  }
  if (!Number.isSafeInteger(input.writtenAt) || input.writtenAt < 0) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'trusted epoch writtenAt must be a non-negative integer');
  }
  return {
    protocolVersion: TRUSTED_EPOCH_PROTOCOL_VERSION,
    schemaVersion: TRUSTED_EPOCH_SCHEMA_VERSION,
    sessionId: String(input.sessionId),
    ownSeqStart: input.ownSeqStart,
    epochId: identity.epochId,
    compactionEndSeq: identity.compactionEndSeq,
    names: assertEpochNames(input.names ?? []),
    trigger: input.trigger,
    writtenAt: input.writtenAt,
  };
}

/**
 * 严格校验一条记录的**形状**（不涉及"它是不是当前 epoch 那一份"）。
 *
 * 不用 zod 做这一层：读回校验必须能在**没有 node_modules** 的环境里跑（单测是 portable 的）；
 * zod schema 仍会在 domain open 时对每条存量记录校验一次（见 createTrustedEpochSpec）。
 * 两层判据刻意一致。
 * @param {unknown} raw
 * @returns {{ok:boolean, issues:string[]}}
 */
export function validateEpochRecordShape (raw) {
  const issues = [];
  if (!isPlainObject(raw)) return { ok: false, issues: ['not-an-object'] };
  for (const key of Object.keys(raw)) {
    if (!RECORD_KEYS.includes(key)) issues.push(`unknown-key:${key}`);
  }
  if (raw.protocolVersion !== TRUSTED_EPOCH_PROTOCOL_VERSION) issues.push('protocol-version');
  if (raw.schemaVersion !== TRUSTED_EPOCH_SCHEMA_VERSION) issues.push('schema-version');
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) issues.push('session-id');
  if (!Number.isSafeInteger(raw.ownSeqStart) || raw.ownSeqStart < 0) issues.push('own-seq-start');
  if (typeof raw.epochId !== 'string' || raw.epochId.length === 0) issues.push('epoch-id');
  if (!Number.isSafeInteger(raw.compactionEndSeq)) issues.push('compaction-end-seq');
  if (!TRIGGERS.includes(raw.trigger)) issues.push('trigger');
  if (!Number.isSafeInteger(raw.writtenAt) || raw.writtenAt < 0) issues.push('written-at');
  if (!Array.isArray(raw.names)) issues.push('names');
  else {
    const seen = new Set();
    for (const name of raw.names) {
      if (typeof name !== 'string' || name.length === 0) { issues.push('names'); break; }
      if (seen.has(name)) { issues.push('names'); break; }
      seen.add(name);
    }
  }
  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

/**
 * 严格校验 + **与当前 epoch 身份逐字段比对**。身份不符即 invalid：
 * 绝不"取最接近的那条"、绝不静默采用。
 * @param {unknown} raw
 * @param {{sessionId:string, ownSeqStart:number, identity:{epochId:string, compactionEndSeq:number}}} expected
 */
export function validateEpochRecord (raw, expected) {
  const shape = validateEpochRecordShape(raw);
  const issues = [...shape.issues];
  if (shape.ok) {
    if (raw.sessionId !== expected?.sessionId) issues.push('session-id-mismatch');
    if (raw.ownSeqStart !== expected?.ownSeqStart) issues.push('own-seq-start-mismatch');
    if (raw.epochId !== expected?.identity?.epochId) issues.push('epoch-id-mismatch');
    if (raw.compactionEndSeq !== expected?.identity?.compactionEndSeq) issues.push('compaction-end-seq-mismatch');
  }
  return issues.length === 0 ? { ok: true, issues: [], record: raw } : { ok: false, issues };
}

/**
 * 记录 schema（**zod**，不是 schemastery —— `@deepseek-ai/dsh-storage-domain` 的
 * `domainTable()` 收 zod schema；schemastery 只管插件 Config 那一层，没有 parse/safeParse）。
 *
 * ## 这里为什么是**刻意宽松**的（`08 §2.4c` 的修法，读之前请先读完）
 *
 * 这条 schema **不再是权威**，它只是一层**传输形状**。真正的判据是本文件里的
 * `validateEpochRecordShape` / `validateEpochRecord`，它们**逐会话**执行并给出精确归因。
 *
 * 放宽的原因不是图省事，而是 SDK 侧这层校验的**失败语义是全局的**：
 * `@deepseek-ai/dsh-storage-domain` 0.2.1-alpha.1 在 `facility.open(spec)` 里对
 * **每一条**存量记录跑 `tableSpec.valueSchema.parse(raw)`，**任何一条**抛错就
 * `throw` 掉整个 `open`（`lib/index.js:371-373`）。于是「表里有一行读不出来」
 * 这个**局部**问题，被放大成「这个域里**所有**会话都停摆」——
 * 包括那些记录完好、跟那条坏行毫无关系的会话（实测记录见 `08 §2.4c` 末段）。
 *
 * SDK 确实自带一个针对这个的开关 `invalidRecords: 'backup-and-skip'`，但**本插件用不上**：
 * 它要求 unit 实现 `backupRecord`，而那只存在于 `per-record` 布局的 unit 上
 * （`dsh-storage-json` 的 `PerRecordJsonUnit`）；本 spec 声明的是 `layout: 'single'`，
 * 其 `SingleJsonUnit` **没有** `backupRecord`，于是 SDK 走到
 * `unit.backupRecord === void 0` 分支**照旧抛出**（同一行 `lib/index.js:373`）。
 * 换句话说：开这个开关在本布局上是个**空开关**。改布局则要同时把
 * `epochKeyOf()` 的 `JSON.stringify([...])` 键改成 path-safe 形状
 * （JSON backend 要求 `/^[a-zA-Z0-9_-]+$/`），那是一次带数据迁移的破坏性变更。
 *
 * 相比之下，把这层放宽**不损失任何安全性**：
 *   * 写入侧仍由 `store.put()` 调用的 `validateEpochRecordShape` 自证，非法记录**写不出去**；
 *   * 读取侧仍由 `ledger.load()` 调的 `validateEpochRecord` 逐条严格校验，
 *     并**额外**比对当前 epoch 身份；唯一键、字段集合、版本号都在那里把关，
 *     比 SDK 那层更严（SDK 那层是 `strictObject`，我们这层还要求 key 集合精确相等）；
 *   * 坏记录仍然**不被删除、不被覆盖、不被 quarantine** —— 本模块一行介质都不碰。
 *
 * 放宽换来的**唯一**行为变化，正是要修的那条：坏记录从「拖垮整个域」变成
 * 「只让**它自己**那个会话落 INVALID」，其余会话照常工作。
 * @param {any} z 注入的 zod 模块（生产 = `await import('zod')`）
 */
export function createEpochTransportSchema (z) {
  // 接受任何 JSON 值。刻意**不**在此处收紧：这里收紧就等于把局部数据问题
  // 重新变成 08 §2.4c 记录的那个全局失败。
  return z.unknown()
}

/**
 * 声明一次领域。`layout: 'single'`：一个领域一条 KV unit，本插件只维护自己那张表。
 * 领域**不做数据迁移**（安装内 README「已知限制」），spec 变更需手工迁移存量数据。
 * @param {{defineDomain:Function, domainTable:Function, z:any}} api
 */
export function createTrustedEpochSpec ({ defineDomain, domainTable, z }) {
  return defineDomain({
    name: TRUSTED_EPOCH_DOMAIN,
    version: TRUSTED_EPOCH_SCHEMA_VERSION,
    layout: 'single',
    tables: { [TRUSTED_EPOCH_TABLE]: domainTable(createEpochTransportSchema(z)) },
  });
}

/**
 * 领域句柄的薄封装：open 幂等、get 同步、put 前自证、close 可重复调用。
 *
 * 边界（全部来自安装内 @deepseek-ai/dsh-storage-domain 0.2.1-alpha.1 的真实实现）：
 *   * `facility.open(spec)` 是 **async**，并对同一名字做 single-open（`already-open`）。
 *   * `table.get(key)` 是**同步**内存读；`table.put` 在 resolve 前已 durable，但
 *     **put 不做 schema 校验** —— 所以写入前必须由本模块自证（`validateEpochRecordShape`）。
 *   * `domain.close()` 是 async，会 drain 已入队的写；重复调用共享同一次 teardown。
 *
 * **读失败与"没有记录"必须可区分**：`get` 让读取异常原样抛出，绝不吞成 `undefined`
 * —— 否则一次真实的读盘失败会被当成"记录缺失"，进而让初始 bootstrap 覆盖掉一条
 * 其实还在、只是暂时读不到的记录。
 *
 * @param {{facility:any, defineDomain:Function, domainTable:Function, z:any, log?:Function}} deps
 */
export function createTrustedEpochStore (deps) {
  const { facility, defineDomain, domainTable, z } = deps;
  const log = deps.log ?? (() => {});
  /** @type {'idle'|'opening'|'open'|'failed'|'closed'} */
  let status = 'idle';
  let domain = null;
  let table = null;
  let failure = null;
  /** close 先于 open 落定时的闸门：迟到的 open 结果必须自己关掉，绝不复活句柄。 */
  let closedEarly = false;
  /** @type {Promise<{ok:boolean, reason?:string}>|null} */
  let opening = null;

  async function doOpen () {
    status = 'opening';
    let opened;
    try {
      const spec = createTrustedEpochSpec({ defineDomain, domainTable, z });
      opened = await facility.open(spec);
    } catch (error) {
      status = closedEarly ? 'closed' : 'failed';
      failure = String(error?.message ?? error);
      const classified = classifyStoreOpenFailure(failure);
      log('trusted-epoch:store-open-failed', { error: failure, classified });
      return { ok: false, reason: classified };
    }
    if (closedEarly) {
      // 卸载已经先一步发生：这一份刚拿到的句柄由我们自己释放，状态保持 closed。
      try { await opened.close(); } catch (error) { log('trusted-epoch:late-close-failed', { error: String(error) }); }
      status = 'closed';
      return { ok: false, reason: 'closed' };
    }
    try {
      domain = opened;
      table = opened.table(TRUSTED_EPOCH_TABLE);
      status = 'open';
      log('trusted-epoch:store-open', { name: TRUSTED_EPOCH_DOMAIN });
      return { ok: true };
    } catch (error) {
      try { await opened.close(); } catch { /* 已尽力释放 */ }
      status = 'failed';
      failure = String(error?.message ?? error);
      log('trusted-epoch:store-open-failed', { error: failure });
      return { ok: false, reason: 'open-failed' };
    }
  }

  return {
    get status () { return status; },
    get failure () { return failure; },
    /** 幂等 open：并发调用共享同一次 open；失败后不重试（终态明确，不挂死）。 */
    ensureOpen () {
      if (status === 'open') return Promise.resolve({ ok: true });
      if (status === 'closed') return Promise.resolve({ ok: false, reason: 'closed' });
      if (opening !== null) return opening;
      opening = doOpen();
      return opening;
    },
    /** 同步读。未打开 / 已关闭 / 读取异常都**抛出**，绝不伪装成"没有记录"。 */
    get (key) {
      if (status !== 'open' || table === null) throw new Error('trusted epoch store is not open');
      return table.get(key);
    },
    /** durable 写。**写前严格自证**：SDK 的 put 不校验，非法记录不得落盘。 */
    async put (record) {
      if (status !== 'open' || table === null) throw new Error('trusted epoch store is not open');
      const verdict = validateEpochRecordShape(record);
      if (!verdict.ok) {
        throw new Error(`refusing to persist an invalid trusted epoch record: ${verdict.issues.join(',')}`);
      }
      await table.put(epochKeyOfRecord(record), record);
      return record;
    },
    async close () {
      closedEarly = true;
      if (domain === null) { status = 'closed'; return; }
      const closing = domain.close();
      status = 'closed';
      try { await closing; } catch (error) { log('trusted-epoch:close-failed', { error: String(error) }); }
    },
  };
}

/**
 * store 的挂载点。
 *
 * 为什么是 holder 而不是直接持 store：`storageDomain` 由 `ctx.inject(['storageDomain'],…)`
 * 的**子 fiber** 提供，可能晚于插件 apply，也可能永远不出现（宿主没这个服务）。
 * 绝不阻塞等待"它也许会来"（那叫挂死），所以 holder 暴露的是**当前事实**：
 * `store` 为 null 时会话立刻落 STORAGE_UNAVAILABLE；store 到位后由宿主重试一次。
 */
export function createTrustedEpochHolder ({ log = () => {} } = {}) {
  const listeners = new Set();
  return {
    /** @type {{ensureOpen:Function, get:Function, put:Function, close:Function}|null} */
    store: null,
    attach (store) {
      this.store = store;
      log('trusted-epoch:store-attached', {});
      for (const listener of [...listeners]) {
        try { listener(store); } catch (error) { log('trusted-epoch:attach-listener-failed', { error: String(error) }); }
      }
    },
    detach () {
      this.store = null;
    },
    /** @returns {() => void} 退订函数 */
    onAttach (listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 会话级账本：一个 epoch 一个权威基线，带 revision token 的异步写入。
 *
 * 三条硬规则：
 *   1. **pending 也是不可授权**：基线落定（首次 put durable）之前没有任何名单。
 *      "首次新会话 0 request"靠的就是这一条，而不是靠调用方自觉不请求。
 *   2. **写入的身份与名单在第一次 await 之前就定死**：记录一旦构造就不再读任何可变
 *      状态。否则一个更旧的 epoch 在 await 期间遇到新 epoch 时，会把**旧名单**写进
 *      **新 epoch 的键**——revision 只能挡住运行时回写，挡不住持久层污染。
 *      revision 与 dispose 另在 put **之前**再核一次。
 *   3. **写路径永不 reject**：所有 SDK 异步（含 `ensureOpen` 本身）都被捕获，
 *      失败一律落成确定的 blocked 终态，而不是把异常抛回调用面。
 *
 * @param {{storeHolder:any, sessionId:string, ownSeqStart:number,
 *          now?:() => number, log?:Function}} deps
 */
export function createEpochLedger (deps) {
  const { storeHolder, sessionId, ownSeqStart } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  let identity = initialEpochIdentity();
  let state = BASELINE_STATE.PENDING;
  let reason = null;
  /** @type {string[]|null} 仅在 trusted 时非 null */
  let names = null;
  let revision = 0;
  /** @type {Promise<any>|null} 此刻在途的那一次写 */
  let inflight = null;
  let disposed = false;

  function markBlocked (next) {
    state = BASELINE_STATE.BLOCKED;
    reason = next;
    names = null;
  }

  function isCurrent (rev) {
    return !disposed && rev === revision;
  }

  /**
   * 启动一次写。返回的 promise **永不 reject**。
   * @param {() => any} build 同步构造记录（不得读任何可变状态）
   */
  function startWrite (build) {
    const rev = (revision += 1);
    let record;
    try {
      record = build();
    } catch (error) {
      log('trusted-epoch:record-build-failed', { error: String(error?.message ?? error) });
      if (isCurrent(rev)) markBlocked(TRUSTED_EPOCH_REASONS.INVALID);
      return Promise.resolve({ ok: false, reason: TRUSTED_EPOCH_REASONS.INVALID });
    }
    const task = (async () => {
      try {
        const store = storeHolder?.store ?? null;
        if (store === null) throw new Error('trusted epoch store is not attached');
        const opened = await store.ensureOpen();
        if (opened?.ok !== true) throw storeOpenFailure(opened?.reason);
        // await 之后、put 之前再核一次：被更新的 epoch / 已卸载的会话都不得继续落盘。
        if (disposed || rev !== revision) {
          log('trusted-epoch:write-superseded', { rev, current: revision });
          return { ok: false, reason: 'superseded' };
        }
        await store.put(record);
      } catch (error) {
        log('trusted-epoch:write-failed', { error: String(error?.message ?? error) });
        const reason = baselineReasonForStoreFailure(error);
        if (isCurrent(rev)) markBlocked(reason);
        return { ok: false, reason };
      }
      if (disposed) {
        log('trusted-epoch:put-after-dispose', {});
        return { ok: false, reason: 'disposed' };
      }
      if (rev !== revision) {
        // 更旧的 epoch 迟到：不复活、不覆盖当前授权（rule 2）。
        log('trusted-epoch:stale-put', { rev, current: revision });
        return { ok: true, stale: true };
      }
      identity = { epochId: record.epochId, compactionEndSeq: record.compactionEndSeq };
      state = BASELINE_STATE.TRUSTED;
      reason = null;
      names = [...record.names];
      return { ok: true, record };
    })();
    inflight = task;
    const clear = () => { if (inflight === task) inflight = null; };
    task.then(clear, clear);
    return task;
  }

  /**
   * 新会话 / 无 own 出站历史的 fork：建立**初始**记录。
   * 落定前 state 保持 pending —— 调用方据此拒绝发请求。
   */
  function begin (configNames, trigger = 'initial') {
    const identitySnapshot = initialEpochIdentity();
    // 读阶段（load）刚把状态落成 blocked(MISSING)；建立初始记录期间必须**先**回到
    // pending，否则"正在写初始记录"会被误报成"确定失败"，调用方也会走错分支。
    identity = identitySnapshot;
    state = BASELINE_STATE.PENDING;
    reason = null;
    names = null;
    return startWrite(() => createEpochRecord({
      sessionId,
      ownSeqStart,
      identity: identitySnapshot,
      names: configNames ?? [],
      trigger,
      writtenAt: now(),
    }));
  }

  /** 冷恢复一个**有 own 出站历史**的老会话：只认当前 epoch 的那一份记录。 */
  async function load () {
    const rev = (revision += 1);
    const store = storeHolder?.store ?? null;
    if (store === null) {
      markBlocked(TRUSTED_EPOCH_REASONS.UNAVAILABLE);
      return { state, reason };
    }
    let raw;
    try {
      const opened = await store.ensureOpen();
      if (opened?.ok !== true) throw storeOpenFailure(opened?.reason);
      if (!isCurrent(rev)) return { state, reason };
      raw = store.get(epochKeyOf({
        sessionId, ownSeqStart, epochId: identity.epochId, compactionEndSeq: identity.compactionEndSeq,
      }));
    } catch (error) {
      // 读盘失败**不是**"没有记录"：落存储不可用，绝不让后续 bootstrap 覆盖一条可能还在的记录。
      log('trusted-epoch:read-failed', { error: String(error?.message ?? error) });
      const reason = baselineReasonForStoreFailure(error);
      if (isCurrent(rev)) markBlocked(reason);
      return { state, reason };
    }
    if (!isCurrent(rev)) return { state, reason };
    if (raw === undefined) {
      markBlocked(TRUSTED_EPOCH_REASONS.MISSING);
      return { state, reason };
    }
    const verdict = validateEpochRecord(raw, { sessionId, ownSeqStart, identity });
    if (!verdict.ok) {
      log('trusted-epoch:record-invalid', { issues: verdict.issues });
      markBlocked(TRUSTED_EPOCH_REASONS.INVALID);
      return { state, reason };
    }
    // 权威只有 record.names：既不与当前配置取交集，也不被当前配置替换。
    names = [...verdict.record.names];
    state = BASELINE_STATE.TRUSTED;
    reason = null;
    log('trusted-epoch:record-loaded', { count: names.length, epochId: identity.epochId });
    return { state, reason };
  }

  /**
   * 周期边界（新压缩 / 迁移）换 epoch：立刻推进身份与 revision，落盘新记录。
   * `configNames` 必须由调用方**在边界那一刻同步捕获** —— 不能等 put 完成后再读配置。
   */
  function adopt ({ identity: next, names: configNames, trigger }) {
    const identitySnapshot = { epochId: next.epochId, compactionEndSeq: next.compactionEndSeq };
    identity = identitySnapshot;
    state = BASELINE_STATE.PENDING;
    reason = null;
    names = null;
    return startWrite(() => createEpochRecord({
      sessionId,
      ownSeqStart,
      identity: identitySnapshot,
      names: configNames ?? [],
      trigger,
      writtenAt: now(),
    }));
  }

  /**
   * 把**读取键**对齐到 journal 报告的当前 epoch。
   *
   * 为什么需要：`readSession` 的 await 窗口里可能真的发生一次压缩（live 路径已经把
   * journal 的 epoch 推进了），而本账本此时还没读过任何记录。若不先对齐，就会拿着旧的
   * `initial` 去查 —— 永远查不到新周期那条记录，老会话会被误判成 missing。
   * 只用于**解析基线之前**；不写盘、不改 revision、不改状态。
   * @param {{epochId:string, compactionEndSeq:number}} next
   */
  function setIdentity(next) {
    if (inflight !== null) return;
    identity = { epochId: next.epochId, compactionEndSeq: next.compactionEndSeq };
  }

  return {
    get sessionId () { return sessionId; },
    get ownSeqStart () { return ownSeqStart; },
    get identity () { return { ...identity }; },
    get state () { return state; },
    get reason () { return reason; },
    get names () { return names === null ? null : [...names]; },
    get revision () { return revision; },
    get inFlight () { return inflight !== null; },
    begin,
    load,
    adopt,
    setIdentity,
    /**
     * 会话因**与可信周期无关**的既有原因已 fail closed（journal 损坏 / readSession
     * 失败 / 严重 seq 不连续）。不是可信基线的终态：见 BASELINE_STATE.FAILED_CLOSED。
     *
     * 它必须**同步**落定，且不写盘：此刻还没有、也不该有任何授权事实。
     * @param {string} [detail] 归因细节（进 reason，便于日志与门禁定位是哪一种）
     */
    failClosed (detail) {
      // 已经在途的写不再有意义（授权已经不可能发生）；revision 让它回来时被判为 superseded。
      revision += 1;
      state = BASELINE_STATE.FAILED_CLOSED;
      reason = detail === undefined || detail === null || detail === ''
        ? SESSION_FAILED_CLOSED
        : `${SESSION_FAILED_CLOSED}:${String(detail)}`;
      names = null;
      log('trusted-epoch:session-failed-closed', { sessionId, detail: String(detail) });
      return { state, reason };
    },
    /** 等"此刻在途的那一次写"落定；无在途写时立即返回。没有超时、没有兜底。 */
    async whenSettled () {
      while (inflight !== null) {
        const current = inflight;
        await current;
        if (inflight === current) inflight = null;
      }
      return { state, reason };
    },
    dispose () {
      disposed = true;
      // 已经 trusted 的会话不必降级（runtime 本身随会话释放）；pending/blocked 保持不可授权。
      if (state === BASELINE_STATE.TRUSTED || state === BASELINE_STATE.FAILED_CLOSED) return;
      markBlocked(reason ?? 'disposed');
    },
  };
}

/**
 * 基线不可授权时抛出的统一错误：**按 reason 分流**的文案。
 *
 * 三种终态对用户要说的是三件不同的事，绝不能合成一句"跑个 /compact 就行"：
 *   * MISSING —— 本次会话成功执行一次真实用户的 `/compact` 即可迁移出新周期记录。
 *   * UNAVAILABLE —— 宿主没有提供可用的可信存储服务（provider 缺失 / open 失败）。
 *     `/compact` 解决不了它；必须先恢复该服务。
 *   * INVALID —— 记录身份或格式校验失败。**不会**用当前配置去覆盖那条坏记录，
 *     也**不删**它（本轮不做 prune）；需要人工处置存储里的那一条。
 *
 * 复用的是 domain 已有的 STATE_NOT_READY 码 —— 不新增、不改动冻结的错误码表。
 * @param {string} reason
 */
export function trustedEpochBlockedError (reason) {
  switch (reason) {
    case TRUSTED_EPOCH_REASONS.MISSING:
      return new DomainError('STATE_NOT_READY',
        `本会话没有可验证的可信周期记录（${reason}），已停止发出请求。请在本次会话里成功执行一次 /compact，建立新的可信周期后继续。`);
    case TRUSTED_EPOCH_REASONS.INVALID:
      return new DomainError('STATE_NOT_READY',
        `本会话的可信周期记录身份或格式校验失败（${reason}），已停止发出请求。该记录不会被当前配置覆盖，也不会被删除；请先人工处置存储中的那一条记录。`);
    case TRUSTED_EPOCH_REASONS.UNAVAILABLE:
      return new DomainError('STATE_NOT_READY',
        `宿主未提供可用的可信周期存储（${reason}），已停止发出请求。/compact 无法解决：请先恢复该存储服务（provider 缺失或 domain 打开失败），再继续本会话。`);
    default:
      return new DomainError('STATE_NOT_READY',
        `本会话的可信周期基线不可授权（${String(reason)}），已停止发出请求。`);
  }
}