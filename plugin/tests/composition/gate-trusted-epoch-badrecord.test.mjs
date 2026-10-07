// 可信周期基线 —— **存量坏记录**门禁（契约 `08 §2.4c`，验收项 TE-BAD）。
//
// 行为事实（实测于安装内 `@deepseek-ai/dsh-storage-domain` 0.2.1-alpha.1 + 真实 JSON backend，
// 与 `08 §2.4c` 首段一致）：
//   存量里只要有**一条**与 schema 不匹配的记录，`facility.open(spec)` 就让**整个域**打开失败，
//   抛 `stored record '<key>' in table 'epoch_baselines' does not match its schema`。
//   存储**服务本身是健康的**（provider 在、盘可读），坏掉的只是数据里的一行。
//   ⇒ 它必须被归因为 INVALID（数据问题），而不是 STORAGE_UNAVAILABLE（服务问题）：
//     后者的处置文案是「先恢复该存储服务」，对着一行坏数据永远恢复不了。
//
// **故障注入的性质（必须如实声明）**：
//   本文件里那条「版本不匹配」的记录是**声明式注入**的 —— 在**本用例私有的 tmp 存储**中，
//   直接把 JSON 文件里那一条记录的 `protocolVersion` / `schemaVersion` 改成不匹配的值。
//   这**不是宿主自然产生的行为**：正常路径下产品的 `store.put()` 在写前自证
//   （`validateEpochRecordShape`），SDK 的 `put` 也只在 domain open 的 `loadAll` 上校验存量，
//   所以真实运行里不会自己写出这样一行记录。注入是**为了取到那条反例数据**而声明的动作，
//   不是一个对宿主行为的断言。
//   注入走**真实文件介质**（就是 SDK 真实读写的那个 JSON 文件），不裸删目录、不假装没写过、
//   不绕过 SDK 去改内存里的表。
//
// 判据（互相独立，任何一条都不得靠「取到 undefined 就跳过」蒙过去）：
//   BRC（正控制 / 反空过） 同样的「写一轮 → 真关闭 → 同 root 重启」，**不注入**：
//       重启后会话必须照常 ready 且真的出站。⇒ 证明 B1 的 blocked 与 0 request 不是
//       「重启本身就阻塞」换来的。
//   BR0（前置，双证）  ① 官方 durable API（`facility.get(domain)` → `domain.table(table)` →
//       遍历 `entries` 按 `sessionId` 定位）必须真的找到那条记录；② 落盘的 JSON 文件里
//       必须存在同一个 key，且其 `protocolVersion` / `schemaVersion` 与产品常量一致。
//       —— 否则「产品本来就没写过记录」会被误当成「记录被污染」，门禁就白过。
//   BR1（主判据）    重启后该会话的账本 reason 必须是 `INVALID_TRUSTED_EPOCH`，
//       且**明确不是** `STORAGE_UNAVAILABLE`；终态必须是 blocked（非 ready）。
//   BR2（不空过）    被阻止的会话必须 **0 出站请求**，不得发出缩水 fallback。
//   BR3（不越权）    重启后再读一次 JSON 文件：那条坏记录**仍在**、仍是注入后的原值、
//       **没有被删除**、**没有被当前配置覆盖**（epochId / names / trigger 等原字段保持不变）。
//
// 断言纪律：本文件**不改产品代码**使其变绿；判据不成立时如实留红。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch-badrecord.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'

const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
/** 与 gate-trusted-epoch 同款配置：显式置空，基线只剩三个发现入口。 */
const ADAPTER_CONFIG = { alwaysVisible: [] }

/** 注入用的不匹配版本号（与产品常量刻意不同，见 trusted-epoch.mjs 的 PROTOCOL/SCHEMA_VERSION）。 */
const INJECTED_PROTOCOL_VERSION = 1
const INJECTED_SCHEMA_VERSION = 99

const handles = []
const cleanup = []

after(async () => {
  for (const handle of handles.reverse()) {
    try { await handle.dispose() } catch { /* 已释放 */ }
  }
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* 已释放 */ }
  }
})

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

async function drive (ctx, tmpRoot, sessionId) {
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: tmpRoot }
  })
  handles.push(handle)
  return handle
}

async function resumeDrive (ctx, sessionId) {
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }
  })
  handles.push(handle)
  return handle
}

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
}

function namesOf (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

/**
 * 取产品公开的可信周期常量与原因码（`plugin/adapters/dsh/trusted-epoch.mjs`）。
 * 产品未提供时**明确报错**，绝不静默降级 —— 否则「记录本来就没写过」会被误当成
 * 「记录被污染」。
 */
async function trustedEpochApi () {
  const mod = await import('../../adapters/dsh/trusted-epoch.mjs')
  const { TRUSTED_EPOCH_DOMAIN: domain, TRUSTED_EPOCH_TABLE: table,
    TRUSTED_EPOCH_REASONS: reasons, TRUSTED_EPOCH_PROTOCOL_VERSION: protocolVersion,
    TRUSTED_EPOCH_SCHEMA_VERSION: schemaVersion } = mod
  if (typeof domain !== 'string' || typeof table !== 'string' || reasons === undefined) {
    throw new Error(`trusted-epoch.mjs 未导出可用的域/表/原因常量：${JSON.stringify(Object.keys(mod))}`)
  }
  assert.equal(reasons.INVALID, 'INVALID_TRUSTED_EPOCH', '主判据要求 INVALID 的稳定值')
  assert.equal(reasons.UNAVAILABLE, 'STORAGE_UNAVAILABLE', 'UNAVAILABLE 的稳定值')
  assert.notEqual(reasons.INVALID, reasons.UNAVAILABLE, '两种终态必须互不相同')
  return { domain, table, reasons, protocolVersion, schemaVersion }
}

/** 在真实 storageDomain 里定位本会话的那条记录，返回 { key, value } 或 null。 */
function findRecordOf (table, sessionId) {
  for (const [key, value] of table.entries()) {
    if (value?.sessionId === sessionId) return { key, value }
  }
  return null
}

/** 定位真实 JSON backend 写的那个域文件（就是 SDK 真正读写的介质）。 */
function domainFileOf (storageRoot, domainName) {
  const file = path.join(storageRoot, `${domainName}.json`)
  assert.ok(fs.existsSync(file),
    `前置：真实 JSON backend 必须已在私有 tmp 存储里写出 ${domainName}.json，实际目录：${JSON.stringify(fs.readdirSync(storageRoot))}`)
  return file
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 观察下一轮真实出站（与 gate-trusted-epoch 同款纪律）：
 * 终态取自 `lifecycle.whenReady` 的落定结果 + 出站请求计数，窗口只用于取样。
 */
async function observeNextTurn (store, queueResponse, handle, sessionId, label, lifecycle, windowMs = 800) {
  assert.ok(lifecycle !== undefined && lifecycle !== null,
    'observeNextTurn 必须显式传入 boot.ctx 上的 lifecycle')
  const ctx = handle.agent.session?.ctx
  const events = []
  const off = ctx?.on?.('session/event', (session, event) => {
    if (session.id === sessionId) events.push(event.type)
  })
  const before = store.requests.length
  queueResponse({ text: `${label} turn` })
  userTurn(handle, 'Continue.').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  const sent = store.requests.slice(before)
  const settled = await lifecycle.whenReady(sessionId)
  assert.ok(settled !== undefined && settled !== null && typeof settled.mode === 'string',
    `终态必须存在且带明确 mode（不得是 null/undefined）：${JSON.stringify(settled)}`)
  off?.()
  return { sent, events, settled }
}

/**
 * BR0 阶段一：先在真实介质上跑一轮，并做**双证前置**。
 * 返回 { file, key, before } —— before 是注入前那一条记录的原始副本。
 */
async function seedAndProve (api, sessionId) {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot1.dispose())
  assert.deepEqual(boot1.activationErrors(), [], 'composition 必须收敛')

  queueResponse({ text: 'BRAD phase one' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, sessionId)
  await userTurn(h1, 'Say something so the host writes a real trusted record.')
  assert.equal(h1.agent.session.seq > 0, true, '前置：必须先有真实非空历史')
  await h1.dispose()
  handles.splice(handles.indexOf(h1), 1)

  // 证一：官方 durable API 上真的存在这条记录。
  const facility = boot1.ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达')
  const domain = facility.get(api.domain)
  assert.ok(domain !== undefined, `前置：产品必须已打开可信域 ${api.domain}`)
  const table = domain.table(api.table)
  const found = findRecordOf(table, sessionId)
  assert.ok(found !== null,
    `前置：会话 ${sessionId} 的可信记录必须真实存在于 ${api.domain}.${api.table}，否则本例是空过`)
  assert.equal(found.value.protocolVersion, api.protocolVersion,
    `前置：durable 记录的产品版本号必须是 ${api.protocolVersion}`)
  assert.equal(found.value.schemaVersion, api.schemaVersion,
    `前置：durable 记录的产品 schema 版本号必须是 ${api.schemaVersion}`)

  // 证二：真实文件介质上，同一个 key、同一组合法版本号。
  const file = domainFileOf(boot1.storageRoot, api.domain)
  const before = readJson(file)
  assert.ok(isPlainObject(before.tables), `前置：JSON 顶层必须有 tables 对象：${JSON.stringify(Object.keys(before))}`)
  const raw = before.tables[api.table]
  assert.ok(isPlainObject(raw),
    `前置：tables.${api.table} 必须是**对象**而不是数组（真实 JSON backend 的形状），实际 ${Array.isArray(raw) ? 'array' : typeof raw}`)
  assert.ok(isPlainObject(raw[found.key]),
    `前置：文件里必须存在 durable 侧同一个 key ${found.key}，实际 keys=${JSON.stringify(Object.keys(raw))}`)
  assert.equal(raw[found.key].protocolVersion, api.protocolVersion, '前置：文件里的 protocolVersion 必须合法')
  assert.equal(raw[found.key].schemaVersion, api.schemaVersion, '前置：文件里的 schemaVersion 必须合法')

  return { store, queueResponse, boot1, file, key: found.key, before: raw[found.key] }
}

// ---------------------------------------------------------------------------
// BRC：正控制 —— 同样的「写一轮 → 真关闭 → 同 root 重启」，不注入，必须照常可用
// ---------------------------------------------------------------------------
test('BRC: 反空过控制 —— 同 root 真重启（不注入坏记录）后必须 ready 且正常出站', async () => {
  const api = await trustedEpochApi()
  const { store, queueResponse, boot1 } = await seedAndProve(api, 'te-brad-control')

  // 必须先真关闭全部服务，否则第二个 Loader 不是在重启，而是在并发开同一物理介质。
  await boot1.closeServices()

  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES, adapter: ADAPTER_CONFIG, tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  assert.deepEqual(boot2.activationErrors(), [], '重启 composition 必须收敛')
  store.reset()

  const h2 = await resumeDrive(boot2.ctx, 'te-brad-control')
  try {
    const { sent, settled } = await observeNextTurn(
      store, queueResponse, h2, 'te-brad-control', 'BRC',
      boot2.ctx.get('progressiveDiscovery').lifecycle,
    )
    assert.ok(sent.length > 0,
      '正控制：同 root 重启后会话必须照常出站（否则 BR1 的 0 request 无分辨力）')
    assert.equal(settled.mode, 'ready',
      `正控制：未被污染的可信记录必须让会话照常 ready，实际：${JSON.stringify(settled)}`)
  } finally {
    await h2.dispose()
    handles.splice(handles.indexOf(h2), 1)
  }
})

// ---------------------------------------------------------------------------
// BR1 / BR2 / BR3：注入一条与 schema 不匹配的记录 → INVALID（不是 UNAVAILABLE）+ 0 请求 + 不删不改
// ---------------------------------------------------------------------------
test('BR1: 存量坏记录（声明式注入）→ 落 INVALID_TRUSTED_EPOCH、0 出站请求，且坏记录不被删不改', async () => {
  const api = await trustedEpochApi()
  const sessionId = 'te-badrecord-1'
  const { store, queueResponse, boot1, file, key, before } = await seedAndProve(api, sessionId)

  // --- 注入：在**本用例私有的 tmp 介质**里改那一行的版本号（真实文件，SDK 会真的读到） ---
  await boot1.closeServices()
  const poisoned = readJson(file)
  const row = poisoned.tables[api.table][key]
  row.protocolVersion = INJECTED_PROTOCOL_VERSION
  row.schemaVersion = INJECTED_SCHEMA_VERSION
  fs.writeFileSync(file, JSON.stringify(poisoned, null, 2))
  const injected = readJson(file).tables[api.table][key]
  assert.equal(injected.protocolVersion, INJECTED_PROTOCOL_VERSION, '注入正控：protocolVersion 已改成不匹配值')
  assert.equal(injected.schemaVersion, INJECTED_SCHEMA_VERSION, '注入正控：schemaVersion 已改成不匹配值')
  assert.notEqual(injected.protocolVersion, api.protocolVersion,
    '注入正控：注入值必须真的与产品常量不同（否则这就不是一条坏记录）')
  assert.notEqual(injected.schemaVersion, api.schemaVersion,
    '注入正控：注入的 schema 版本号必须真的与产品常量不同')

  // --- 重启：同一个 tmpRoot，必须先真关闭过（上面已 closeServices），用 agents.resume ---
  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES, adapter: ADAPTER_CONFIG, tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  assert.deepEqual(boot2.activationErrors(), [], '重启 composition 必须收敛')
  assert.deepEqual(boot2.activationErrors().filter((e) => /storageDomain/.test(e)), [],
    '存储服务本身是健康的：重启后 storageDomain 必须正常激活（不是 provider 缺席）')
  store.reset()

  const h2 = await resumeDrive(boot2.ctx, sessionId)
  try {
    const { sent, settled } = await observeNextTurn(
      store, queueResponse, h2, sessionId, 'BR1',
      boot2.ctx.get('progressiveDiscovery').lifecycle,
    )

    // BR1：终态是「数据坏了」，不是「存储服务不可用」。
    assert.notEqual(settled.mode, 'ready',
      `坏记录存在时会话不得 ready，实际：${JSON.stringify(settled)}`)
    const runtime = boot2.ctx.get('progressiveDiscovery').sessions.get(sessionId)
    assert.ok(runtime !== undefined, `真实 runtime 必须存在：${sessionId}`)
    assert.equal(runtime.ledger.state, 'blocked', `坏记录必须是被封住的终态；实际 ${runtime.ledger.state}`)
    assert.equal(runtime.ledger.reason, api.reasons.INVALID,
      `主判据：坏记录必须落 ${api.reasons.INVALID}（数据问题），实际 ${String(runtime.ledger.reason)}`)
    assert.notEqual(runtime.ledger.reason, api.reasons.UNAVAILABLE,
      `坏记录不得被归因为 ${api.reasons.UNAVAILABLE}：存储服务健康，坏的是数据里的一行`)
    assert.notEqual(runtime.ledger.reason, api.reasons.MISSING,
      `坏记录不得被归因为 ${api.reasons.MISSING}：记录确实存在，只是读不出来`)
    assert.equal(runtime.alwaysNames.length, 0,
      `基线不可授权时常驻名单必须为空；实际 ${JSON.stringify(runtime.alwaysNames)}`)

    // BR2：不空过 —— 一条出站请求都不许发出去（不发缩水 fallback）。
    assert.equal(sent.length, 0,
      `坏记录存在时不得发出任何出站请求；实际发出：${JSON.stringify(sent.map(namesOf))}`)

    // BR3：不越权 —— 坏记录不被自动删除、不被当前配置覆盖。
    const after = readJson(file)
    assert.ok(isPlainObject(after.tables?.[api.table]?.[key]),
      `坏记录不得被自动删除：${api.domain}.json 里必须仍有 key ${key}`)
    const afterRow = after.tables[api.table][key]
    assert.equal(afterRow.protocolVersion, INJECTED_PROTOCOL_VERSION,
      '坏记录不得被改写回合法版本号（那等于静默修数据）')
    assert.equal(afterRow.schemaVersion, INJECTED_SCHEMA_VERSION,
      '坏记录不得被改写回合法 schema 版本号')
    for (const field of ['sessionId', 'ownSeqStart', 'epochId', 'compactionEndSeq', 'names', 'trigger', 'writtenAt']) {
      assert.deepEqual(afterRow[field], before[field],
        `坏记录不得被当前配置覆盖：字段 ${field} 必须保持原值`)
    }
  } finally {
    await h2.dispose()
    handles.splice(handles.indexOf(h2), 1)
  }
})

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}