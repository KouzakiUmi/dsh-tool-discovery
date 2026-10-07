// progressive-v2/adapters/dsh/journal.mjs
// canonical 日志折叠 + public sessionQuery 冷恢复。
//
// 硬规则（domain-api §5 / adapter-plan §6-§7）：
//   1. 只 fold **宿主确认的 canonical tool/call → tool/result 对**：
//      tool/result 的 sourceEventSeqs 必须包含对应 tool/call 的 seq。
//      用户文本、tool_list/tool_search 结果一律不构造 pair。
//   2. **最终 isError 不激活**：durable tool/result 的 isError 为真 → 不折叠。
//      execute body 成功不代表激活；判定只认 durable 事件的最终态。
//   3. 恢复顺序：**先订阅缓冲 → sessionQuery.readSession 读 raw 快照 → 按 seq
//      合并去重 → 交给 engine.restore**。读快照与挂监听之间不丢 load/unload。
//   4. query 缺失 / 读取失败且确有 load 历史 → failClosed，保持不可执行；
//      绝不使用 deprecated snapshotEvents 兜底。
//   5. fork own-only：只折叠本会话拥有的 canonical 对（seq >= inheritedEventCount，
//      事实取公开 query.readSession 与 live Session 的 inheritedEventCount 交叉核验）；
//      继承前缀不折叠、不观测、不进缓冲；边界缺失/畸形/冲突或 seq 流断口一律 fail closed。
import { digestOf } from '../../domain/index.mjs';
import { compactedEpochIdentity, initialEpochIdentity } from './trusted-epoch.mjs';
import { wireOfSchema } from './registry.mjs';

/** 从 durable tool/result 的 message 内容里解析出协议外壳与回执。 */
export function parseResultEnvelope(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (parsed.protocolVersion !== 2 || parsed.tool !== 'tool_load') return null;
  const receipt = parsed.ok === true ? parsed?.data?.receipt ?? null : null;
  return { ok: parsed.ok === true, receipt };
}

function resultText(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 从一组已按 seq 排序的事件里构造 canonical pair（只认 tool_load）。
 * @param {ReadonlyArray<any>} events
 */
export function foldPairs(events) {
  /** @type {Map<number, {callId: string, input: any}>} */
  const calls = new Map();
  /** @type {any[]} */
  const pairs = [];
  for (const event of events) {
    if (event.type === 'tool/call') {
      if (event.data?.name !== 'tool_load') continue;
      const input = parseArguments(event.data?.arguments);
      if (input === null || typeof input !== 'object') continue;
      calls.set(event.seq, { callId: String(event.data.callId), input });
      continue;
    }
    if (event.type !== 'tool/result') continue;
    const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
    for (const callSeq of sources) {
      const call = calls.get(callSeq);
      if (call === undefined) continue;
      const shell = parseResultEnvelope(resultText(event));
      if (shell === null) continue;
      pairs.push({
        // seq 取 canonical call 的 seq：与 sourceEventSeqs 绑定（domain 判据 2）
        seq: callSeq,
        call: { operationId: `op_${call.callId}`, tool: 'tool_load', input: call.input },
        result: {
          isError: event.data?.message?.isError === true,
          ok: shell.ok,
          payload: shell.receipt,
          sourceEventSeqs: sources.slice(),
        },
      });
    }
  }
  return pairs;
}

/** 按 seq 合并快照与缓冲并去重（先到先得）。 */
export function mergeBySeq(snapshotEvents, bufferedEvents) {
  const seen = new Set();
  const out = [];
  for (const event of [...(snapshotEvents ?? []), ...(bufferedEvents ?? [])]) {
    if (typeof event?.seq !== 'number' || seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** fork 继承边界归一：仅接受非负安全整数；缺失/畸形一律返回 null（不确定）。 */
export function normalizeInheritedBoundary(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * seq 合法性：非负安全整数（与继承边界同一口径）。
 * 注意 `Number.isSafeInteger(-1)` 为 true —— 负 seq 不是日志位次，必须显式排除，
 * 否则它会一路落到继承前缀过滤（seq < ownSeqStart）被当成"继承事件"静默丢弃。
 */
function isValidSeq(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 是否是会改变本插件状态语义的事件（折叠、披露观测、请求身份）。
 *
 * canonical `tool/result` 同样算状态提交点：load/unload 的**生效只由 result 决定**，
 * 把它当"非状态事件"会让畸形 seq 的撤销提交被静默丢弃（宿主已确认的 unload 不生效，
 * selected 原样留存并在下一轮重新披露）。
 *
 * `tool/result` 分三类（依据宿主真实契约 @deepseek-ai/dsh-session 0.2.1-alpha.1）：
 *   1. 可证状态提交点：`sourceEventSeqs` 命中本会话 live 登记的 tool_load call，
 *      或回执外壳自报 tool_load。
 *   2. 可证无关：`liveCalls` 为空 —— 本 journal 无法构造任何 canonical pair
 *      （`applyCanonicalPair` 仅从该配对循环到达），故此类 result 不可能增减状态。
 *   3. **不可鉴别**：仍有未决 tool_load 状态调用，而本 result 既无法归属、外壳也不再
 *      自报 tool_load。不能假定它无关：宿主契约允许 `sourceEventSeqs` **合法缺省**
 *      （dsh-session lib/index.js:889 —— 工具未 started 时该字段整个不存在），
 *      故"有没有 sourceEventSeqs"不能当判据；外壳 `tool` 属不可信自报字段，
 *      更不能据它假定非状态。→ 保守按状态不确定处理，fail closed。
 *
 * 代价有界：只在"畸形 seq + 状态调用在途"时触发；合法 seq 事件永不走此分支；
 * 而诚实宿主的 seq 恒为合法非负安全整数（dsh-session SessionSeq 校验），
 * 故该保守分支对真实宿主流不可达，不会误封正常 result。
 * @param {any} event
 * @param {Map<number, any>} [liveCalls] callSeq → live 登记的 tool_load call
 */
function isStateAffecting(event, liveCalls) {
  if (event?.type === 'request/header') return true;
  if (event?.type === 'tool/call') return event.data?.name === 'tool_load';
  if (event?.type !== 'tool/result') return false;
  if (liveCalls !== undefined && liveCalls.size > 0) return true;   // 类别 1（归属命中）+ 类别 3
  return parseResultEnvelope(resultText(event)) !== null;            // 类别 1（外壳自报）
}

/**
 * seq 流完整性：合并后的事件必须按 seq 从 0 起连续（宿主日志契约：seq=数组下标）。
 * 断口/越界意味着损坏或不确定 → 调用方 fail closed，绝不盲切数组。
 */
export function isContiguousSeqStream(events) {
  for (let i = 0; i < events.length; i++) {
    if (!Number.isSafeInteger(events[i]?.seq) || events[i].seq !== i) return false;
  }
  return true;
}

/**
 * 每个会话一个 journal：缓存事件、折叠 canonical 对、维护当前请求身份、驱动恢复。
 * @param {{ctx:any, session:any, scope:{sessionId:string,actorId:string}, engine:any, query:any, log?:Function}} deps
 */
export function createJournal(deps) {
  const { session, scope, engine, query, log = () => {} } = deps;
  const sessionId = scope.sessionId;
  const entryNames = new Set(deps.entryNames ?? ['tool_list', 'tool_search', 'tool_load']);
  const frameworkRetained = new Set(deps.frameworkRetained ?? []);
  // 常驻工具同样出现在真实出站 header 里，必须计入 allowed。
  // 漏掉这一组会把白名单工具判成"别的 listener 泄漏"，进而把整会话标为
  // compositionBypass，此后所有非白名单工具一律 INCOMPATIBLE_COMPOSITION。
  //
  // 名单走 provider 而非静态数组：成功压缩会重开一个周期并换上新的常驻名单，
  // provider 读的是 runtime 上那份（由 lifecycle 在周期边界就地替换）。
  const alwaysVisibleProvider = typeof deps.alwaysVisibleProvider === 'function'
    ? deps.alwaysVisibleProvider
    : () => new Set(deps.alwaysVisible ?? []);
  const onEpochReset = typeof deps.onEpochReset === 'function' ? deps.onEpochReset : () => {};
  /**
   * **一次真实用户 `/compact` 完整落定**时的通知（五条 own LIVE canonical 链全部成立）。
   * 只有它才允许把一个"缺可信记录"的老会话迁出来 —— 迁移绝不从历史扫描触发。
   * @param {{compactionId:string, identity:{epochId:string, compactionEndSeq:number}}} info
   */
  const onUserCompactionComplete = typeof deps.onUserCompactionComplete === 'function'
    ? deps.onUserCompactionComplete
    : () => {};
  /**
   * canonical request/header 观测点：这份 tools 数组**已经发出去**了。
   * 于是"未发送刷新"必须立刻失效 —— 否则一次事后发生的手动/空闲压缩会去改写
   * 已经进入历史的那份数组。宿主 dsh-agent-loop 会在 pre-step 之后返回旧 assembly
   * （lib/index.js:921-923），所以这个清理点是必需的，不是保险。
   */
  const onRequestHeader = typeof deps.onRequestHeader === 'function' ? deps.onRequestHeader : () => {};
  const reportBypass = deps.reportBypass ?? (() => {});

  /** live 路径的 canonical call 缓存：callSeq → {callId, input}（只存 tool_load）。 */
  const liveCalls = new Map();
  /** 恢复窗口内的新事件缓冲（读快照期间到达的事件不能丢）。 */
  let buffering = true;
  /** @type {any[]} */
  let buffer = [];
  /** @type {number|undefined} 最近一次 canonical request/header 的 seq */
  let latestHeaderSeq;
  /**
   * 最近一次 canonical request/header 的**完整 tools 数组**。
   *
   * 为什么必须留着：宿主**只在 header 发生变化时**才 append `request/header`
   * （`@deepseek-ai/dsh-agent-loop` buildRequest：`!headerEquals(baseline, header)`
   * 才 append，外加首次 / 新请求序列）。所以「header 没变」的那几轮根本没有事件，
   * 靠事件流是补不回 advertised 的 —— 见 replayAdvertisements。
   * @type {any[]|null}
   */
  let latestHeaderTools = null;
  let restorePromise;
  /**
   * fork 继承边界（own-only 折叠的权威事实）：只折叠/观测 seq >= ownSeqStart 的事件。
   * 初值取 live Session 的 inheritedEventCount（当前公开 session 协议字段），
   * restore 时与公开 query.readSession 的 inheritedEventCount 交叉核验后校准；
   * null = 不确定（缺失/畸形）→ 一律 fail closed，绝不猜测。
   */
  let ownSeqStart = normalizeInheritedBoundary(session?.inheritedEventCount);
  /** 边界不确定等异常已 fail closed：停止一切折叠/观测，不再收窄也不放宽。 */
  let sealed = false;
  /** fail closed 的原因；restore 不得用它把 incompatible 重新置 ready。 */
  let sealedReason = null;
  /**
   * 缓存周期边界。
   *
   * 手动 `/compact` 与自动压缩在宿主里**同走** `compactSurfaceRegion`
   * （dsh-compaction-basic lib/index.js:450-521），因此不需要绑定 compact 命令本身，
   * 只要旁路订阅 session 事件流即可覆盖两条路径。那条路径：
   *   * `session.append('compaction/start', lifecycle)`（lifecycle 含 compactionId）；
   *   * 摘要落地时 `append('compaction/summary', ...)`（commitCompactionBody）；
   *   * 成功 → `append('compaction/end', lifecycle)`；
   *   * 失败/取消 → 也 append end，但 data 多一个 `error: errorChain(error)`。
   * 宿主自己的日志格式校验就是这条规则（dsh-session-format-v3-to-v4
   * lib/index.js:723「successful compaction/end requires one summary」，持久化读路径
   * 会据此判损坏）。本插件的"成功"判据与宿主一致：**匹配 start 的 compactionId +
   * 恰好一次 compaction/summary + end 不带 `error`**。缺任一条都按未提交处理 ——
   * 模型上下文原样保留，绝不白白丢掉已披露的 schema。
   *
   * `openCompactions` 只装"已见 start、未见 end"的 compactionId，并逐条记下
   * **start 的 turn / sourceCommandId 与每一次 summary 的 seq**。孤立 end（无匹配
   * start）不得重置 —— 那是损坏或不属于本会话的日志，不构成"一次成功压缩"。
   * `lastSuccessCompactionEndSeq` 是恢复时的折叠下界：压缩之前签发的 load 回执
   * **不得**在冷恢复时复活（新周期里模型必须重新 load）。
   *
   * **`currentEpoch`** 是本会话**当前缓存周期身份**：初始为 `initial`；每次成功的
   * canonical 压缩推进为 `compactionId@endSeq`。它只来自本会话自己的成功压缩边界，
   * **绝不**来自任何出站 header，也**不是**配置 hash。lifecycle 用它与 storageDomain
   * 里的记录逐字段比对（见 trusted-epoch.mjs）。
   *
   * **`commandRuns`** 只记 `command/run{name:'compact', source.kind:'user'}` 的 commandId
   * （安装内 dsh-commands lib/index.js:334-339 保证了 source:{kind:'user'}）。加上
   * `command/done` 的 kind==='success' 且 `sourceEventSeq === 摘要 seq`，就凑齐了
   * "本次 live 的真实用户 `/compact` 成功"这一条**唯一**的迁移授权。
   * 注意 `sourceEventSeq` 指向的是 **compaction/summary 的 seq**，不是 end 的 seq。
   */
  const openCompactions = new Map();
  /** commandId → {seq}：**只记 name==='compact' 且 source.kind==='user' 的 run，且带 seq**
   *  （安装内 dsh-commands lib/index.js:334-339 保证了 source:{kind:'user'}）。 */
  const commandRuns = new Map();
  /**
   * commandId（C，即 compaction 的 sourceCommandId）→ 已成功压缩、仍在等 command/done 的事实。
   * 键**必须是 commandId**：宿主为命令与压缩各铸一个 id（CompactionId(randomUUID()) vs
   * CommandId(`cmd-…`)），拿 compactionId 去查命令会永远查不到。
   */
  const awaitingUserDone = new Map();
  let lastSuccessCompactionEndSeq = -1;
  let currentEpoch = initialEpochIdentity();
  /**
   * 本会话 own 段里是否出现过**真实出站/工具事实**。
   * 它是"能不能建立初始记录"的另一半判据：完全没有出站事实时仍要先查同 identity
   * 的 durable 记录（冷崩重放场景），只有记录**确实缺失**才允许建立初始记录。
   */
  let ownOutboundSeen = false;

  function failClosedUncertain(reason) {
    sealed = true;
    sealedReason = reason;
    engine.failClosed(scope);
    // 已 fail closed：缓冲与 live call 缓存不再有读取者（onEvent 入口即 return），
    // 丢弃它们以杜绝「残留配对 + 后续重复 result 重新激活」，并让内存回到基线。
    buffer = [];
    liveCalls.clear();
    log('journal:fail-closed', { sessionId, reason });
    return { mode: 'incompatible', reason };
  }

  /** 宿主副作用：把一次真实出站请求的披露集合登记为 advertised。 */
  function recordAdvertisements(event) {
    const headerTools = event.data?.header?.tools;
    if (!Array.isArray(headerTools)) return;
    latestHeaderSeq = event.seq;
    latestHeaderTools = headerTools;
    // 这次出站已经发生：本次投影的"未发送刷新"到此为止。
    onRequestHeader(event);

    // 披露集合的**权威**观测点：真实出站 request/header。
    // 若这里出现三入口 / 可信框架保留 / 有效 selected / 披露缓存之外的工具，
    // 说明有别的 listener 在我们投影之后又重加了 schema → 整会话 fail closed。
    // 披露缓存必须在白名单里：撤权/换版的工具仍按冻结 wire 继续披露（guard 另行
    // 拒绝执行），把它当泄漏会误封整个会话。
    const allowed = new Set([
      ...entryNames, ...frameworkRetained, ...alwaysVisibleProvider(),
      ...activeSelectedNames(),
      ...frozenNames(),
    ]);
    const leaked = headerTools.map((tool) => tool?.name).filter((name) => !allowed.has(name));
    if (leaked.length > 0) {
      reportBypass({ sessionId, names: [...new Set(leaked)] });
      log('composition:bypass', { sessionId, leaked });
      return;
    }

    const byName = new Map(headerTools.map((tool) => [tool.name, tool]));
    applyAdvertisementPass(byName, event.seq);
  }

  /**
   * 拿一份 header 的 tools 与当前 selected 对账，逐项建立 advertised。
   *
   * **幂等**：state.recordAdvertisement 对「已记账且 name/revision/digest 三者全等」的项
   * 是覆盖写，对任一不符的项是删除。所以重复调用只会让记账回到与该 header 一致的
   * 状态，不放宽任何判据 —— digest 仍逐字比对。
   * @param {Map<string, any>} byName header tools 的 name → 定义
   * @param {number|undefined} headerSeq 该 header 的事件 seq（记账的 requestId 依据）
   */
  function applyAdvertisementPass(byName, headerSeq) {
    const state = engine.getState(scope);
    for (const [toolId, selection] of state.selected) {
      const advertisedTool = byName.get(selection.name);
      if (advertisedTool === undefined) continue;
      const wire = wireOfSchema(advertisedTool);
      if (digestOf(wire) !== selection.schemaDigest) {
        // 出站定义与选中时的定义不一致 → 不算已披露（不静默放行）
        log('advertisement:definition-drift', { sessionId, toolId, name: selection.name });
        continue;
      }
      engine.recordAdvertisement(scope, {
        requestId: requestIdFor(headerSeq),
        toolId,
        name: selection.name,
        revision: selection.revision,
        schemaDigest: selection.schemaDigest,
        // 逐字冻结这一次真正投给模型的 wire：顺序与内容此后不再变。
        wire,
      });
    }
  }

  /**
   * 用**最后一次观测到的 header** 重放一次曝光对账。
   *
   * 修的是什么（真实复现过，不是推演）：工具被移除 → 重加 → 重新 `tool_load` 之后，
   * 出站 wire **逐字未变**（frozen 披露缓存一直留着那份定义），于是宿主不会发新的
   * `request/header`（它只在 `!headerEquals(baseline, header)` 时 append）。而
   * `invalidateTool`（移除时）与 `reducePair`（换版本时）都会清掉 `advertised` ——
   * 两头一夹，工具永久停在 `TOOL_NOT_ADVERTISED`：明明在 wire 上、明明 selected 着，
   * 却永远调不动，只能靠重启会话冷恢复。（实测：出站 6 次请求全都带着它，记账却是空的。）
   *
   * 为什么这样补是安全的：wire 没变 ⇒ 模型当前上下文里那份定义**一直有效**，本次只是
   * 把记账补回与该 header 一致的状态；`currentRequestId()` 仍指向同一个 header seq，
   * digest 仍逐字比对。**没有放宽任何一条拒绝判据**，反而是把本该存在的授权补回来。
   */
  function replayAdvertisements() {
    if (latestHeaderTools === null) return;
    applyAdvertisementPass(new Map(latestHeaderTools.map((tool) => [tool.name, tool])), latestHeaderSeq);
  }

  function requestIdFor(seq) {
    return `${sessionId}#${seq === undefined ? 'none' : seq}`;
  }

  /**
   * 一次成功压缩的**唯一**判据（严格版）：
   *   匹配的 compactionId + start/end 的 `turn` 逐字一致 + **恰好一次** summary +
   *   end 不带 `error`。dup summary、孤立 end、turn 不一致、失败/取消都不重置。
   */
  function settleCompactionEnd(event) {
    const id = event.data?.compactionId;
    const open = typeof id === 'string' ? openCompactions.get(id) : undefined;
    if (open === undefined || !openCompactions.delete(id)) {
      log('compaction:end-without-start', { sessionId, seq: event.seq });
      return;
    }
    if (event.data?.turn !== open.turn) {
      log('compaction:turn-mismatch-no-reset', { sessionId, seq: event.seq });
      return;
    }
    if (open.summaries.length !== 1) {
      // 0 次 = 没有摘要；>1 次 = 重复摘要。两种都不是"恰好一次成功压缩"。
      log('compaction:not-successful-no-reset', { sessionId, seq: event.seq, summaries: open.summaries.length });
      return;
    }
    if (event.data?.error !== undefined) {
      log('compaction:not-successful-no-reset', { sessionId, seq: event.seq, error: true });
      return;
    }
    lastSuccessCompactionEndSeq = event.seq;
    currentEpoch = compactedEpochIdentity(id, event.seq);
    liveCalls.clear();
    engine.resetCacheEpoch(scope, 'compaction-end');
    // 周期重开：此刻（且仅此刻）取此刻的配置、换上新的常驻名单，并刷新那份**尚未发送**
    // 的投影（见 projection.mjs 的"未发送刷新"段：宿主在 pre-step 之后会返回旧 assembly）。
    //
    // `userInitiated` 的判据是**完整**的手动压缩形态，不是"见过一个 compact 命令名"：
    //   * end 必须带 start 那个 sourceCommandId（宿主两段共用同一个 lifecycle 对象）；
    //   * start 与 end 的 `turn` 都是 null —— 手动压缩 owner 为 null，自动压缩 owner 是
    //     打开的 turn（dsh-compaction-basic:456-468）；
    //   * command/run(name:'compact', source.kind:'user') 必须**早于** start。
    // 它本身**不**构成迁移授权 —— 还要等 command/done 成功（见 settleUserCompaction）。
    const commandId = typeof open.sourceCommandId === 'string' ? open.sourceCommandId : null;
    const run = commandId === null ? undefined : commandRuns.get(commandId);
    const userInitiated = commandId !== null
      && run !== undefined
      && run.seq < open.startSeq
      && open.turn === null
      && event.data?.turn === null
      && event.data?.sourceCommandId === open.sourceCommandId;
    if (userInitiated) {
      awaitingUserDone.set(commandId, {
        compactionId: id,
        identity: currentEpoch,
        summarySeq: open.summaries[0],
        endSeq: event.seq,
        runSeq: run.seq,
      });
    }
    onEpochReset({ compactionId: id, endSeq: event.seq, identity: currentEpoch, userInitiated });
    log('compaction:cache-epoch-reset', { sessionId, seq: event.seq, compactionId: id, userInitiated });
  }

  /**
   * `command/done` 落定一次真实用户 `/compact`：五条 own LIVE canonical 链的最后一环。
   *   command/run(name:'compact', source.kind:'user', id C)   seq < start
   *     → compaction/start(sourceCommandId C, turn null)
   *     → compaction/summary(id, 恰好一次, seq S)
   *     → compaction/end(sourceCommandId C, turn null, error 不存在)
   *     → command/done(id C, kind success, sourceEventSeq === S, seq > end)
   * `sourceEventSeq` 指向 **summary 的 seq**（宿主用 result.summarySeq 结算，
   * dsh-command-compact:63），不是 end 的 seq。任一条不成立都不迁移。
   * 默认的 compactNow 程序调用（无 command/run）永远走不到这里。
   */
  function settleUserCompaction(event) {
    const id = event.data?.commandId;
    if (typeof id !== 'string') return;
    if (!commandRuns.has(id)) return;
    if (event.data?.kind !== 'success') {
      // 失败/取消的 done：不迁移，并释放这条挂起事实（否则会一直占着 C）。
      if (awaitingUserDone.delete(id)) {
        log('compaction:user-done-not-success', { sessionId, seq: event.seq, kind: event.data?.kind });
      }
      return;
    }
    const pending = awaitingUserDone.get(id);
    if (pending === undefined) return;
    if (event.data?.sourceEventSeq !== pending.summarySeq) {
      log('compaction:user-done-seq-mismatch', {
        sessionId, seq: event.seq, commandId: id, sourceEventSeq: event.data?.sourceEventSeq, summarySeq: pending.summarySeq,
      });
      awaitingUserDone.delete(id);
      return;
    }
    if (!(event.seq > pending.endSeq && event.seq > pending.runSeq)) {
      // 顺序不成立（done 早于 end/run）：这不是一条真实链，绝不迁移。
      log('compaction:user-done-out-of-order', { sessionId, seq: event.seq, commandId: id, endSeq: pending.endSeq });
      awaitingUserDone.delete(id);
      return;
    }
    awaitingUserDone.delete(id);
    onUserCompactionComplete({ compactionId: pending.compactionId, identity: pending.identity });
  }

  /** 处理一个 canonical 事件（同步；来自宿主 session/event 流）。 */
  function onEvent(event) {
    if (sealed) return;
    const seq = event?.seq;
    if (!isValidSeq(seq)) {
      // 无法定位 seq 的事件：状态提交点即不确定 → fail closed；其余忽略（merge 也会丢弃）
      if (isStateAffecting(event, liveCalls)) failClosedUncertain('event-seq-invalid');
      return;
    }
    if (ownSeqStart === null) {
      // 边界未知（缺失/畸形）→ 不猜测：state 相关事件一律 fail closed
      if (isStateAffecting(event, liveCalls)) failClosedUncertain('inherited-boundary-unknown');
      return;
    }
    // fork 继承前缀不是本会话拥有的事件：不折叠、不观测、不进缓冲
    // （call/result 跨界不成对：继承 call 在此被滤掉，其 result 无法配对）
    if (seq < ownSeqStart) return;
    if (buffering) buffer.push(event);
    if (event.type === 'request/header') {
      ownOutboundSeen = true;
      recordAdvertisements(event);
      return;
    }
    // ---- 真实用户 `/compact` 的命令链（迁移的唯一授权来源） ------------------
    if (event.type === 'command/run') {
      if (event.data?.name === 'compact' && event.data?.source?.kind === 'user'
        && typeof event.data?.commandId === 'string') {
        // 重复 run（同 commandId）不覆盖：命令注册表保证 id 唯一，重复即损坏。
        if (!commandRuns.has(event.data.commandId)) {
          commandRuns.set(event.data.commandId, { seq: event.seq });
        }
      }
      return;
    }
    if (event.type === 'command/done') {
      settleUserCompaction(event);
      return;
    }
    // 缓存周期的唯一重置源：见 openCompactions 的口径说明。
    if (event.type === 'compaction/start') {
      const id = event.data?.compactionId;
      if (typeof id !== 'string' || id.length === 0) return;
      // 重复 start（同一 compactionId）**不覆盖**旧状态：否则第二个 start 会把第一段
      // 已积累的 summary 吞掉，让"两次 summary"看起来像"恰好一次"。
      if (openCompactions.has(id)) {
        log('compaction:duplicate-start', { sessionId, seq: event.seq, compactionId: id });
        return;
      }
      openCompactions.set(id, {
        // start 的 turn/sourceCommandId 是后续 summary 与 end 必须逐字匹配的事实。
        turn: event.data?.turn,
        sourceCommandId: event.data?.sourceCommandId,
        summaries: [],
        startSeq: event.seq,
      });
      return;
    }
    if (event.type === 'compaction/summary') {
      const id = event.data?.compactionId;
      const open = typeof id === 'string' ? openCompactions.get(id) : undefined;
      // 摘要必须属于同一次压缩：sourceCommandId 两侧一致（宿主把 start 的
      // sourceCommandId 原样带进 summary，dsh-compaction-basic:634-638）。
      if (open !== undefined
        && (open.sourceCommandId === undefined
          || open.sourceCommandId === event.data?.sourceCommandId)) {
        open.summaries.push(event.seq);
      }
      return;
    }
    if (event.type === 'compaction/end') {
      settleCompactionEnd(event);
      return;
    }
    if (event.type === 'tool/call') {
      ownOutboundSeen = true;
      if (event.data?.name !== 'tool_load') return;
      const input = parseArguments(event.data?.arguments);
      if (input === null || typeof input !== 'object') return;
      liveCalls.set(event.seq, { callId: String(event.data.callId), input });
      return;
    }
    if (event.type !== 'tool/result') return;
    ownOutboundSeen = true;
    const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
    for (const callSeq of sources) {
      const call = liveCalls.get(callSeq);
      if (call === undefined) continue;
      liveCalls.delete(callSeq);
      const shell = parseResultEnvelope(resultText(event));
      if (shell === null) {
        log('journal:unparsable-result', { sessionId, seq: event.seq });
        continue;
      }
      const pair = {
        seq: callSeq,
        call: { operationId: `op_${call.callId}`, tool: 'tool_load', input: call.input },
        result: {
          isError: event.data?.message?.isError === true,
          ok: shell.ok,
          payload: shell.receipt,
          sourceEventSeqs: sources.slice(),
        },
      };
      const outcome = engine.applyCanonicalPair(pair, scope);
      if (!outcome.applied) log('journal:rejected', { sessionId, seq: callSeq, reason: outcome.reason });
      else {
        log('journal:applied', { sessionId, seq: callSeq, operationId: pair.call.operationId });
        // reducePair 会清掉这些项的 advertised（换版本）。若出站 wire 没变，宿主就**不会**
        // 再发一次 request/header —— 不补这一下，工具会永久停在 TOOL_NOT_ADVERTISED。
        replayAdvertisements();
      }
    }
  }

  /** 冷恢复：先缓冲（本模块在激活期即已订阅）→ readSession → 按 seq 合并 → engine.restore。 */
  function restore() {
    if (restorePromise !== undefined) return restorePromise;
    restorePromise = (async () => {
      // live 事件已 fail closed：恢复不得把 incompatible 重新置 ready（否则选中原样复活）
      if (sealed) {
        log('restore:skipped', { sessionId, reason: sealedReason });
        return { mode: 'incompatible', reason: sealedReason };
      }
      if (query === undefined) {
        engine.failClosed(scope);
        log('restore:fail-closed', { sessionId, reason: 'sessionQuery-missing' });
        return { mode: 'incompatible', reason: 'sessionQuery-missing' };
      }
      /** @type {any[]|null} */
      let snapshotEvents = null;
      try {
        const loaded = await query.readSession(sessionId);
        if (!Array.isArray(loaded?.events)) {
          // 形状不符 = 损坏/不确定：不得把空 pairs 当"全新会话"放行
          return failClosedUncertain('readSession-shape-invalid');
        }
        // own-only 边界：公开 query 的 inheritedEventCount 与 live Session 交叉核验
        const queryBoundary = normalizeInheritedBoundary(loaded.inheritedEventCount);
        if (queryBoundary === null) {
          return failClosedUncertain('inherited-boundary-invalid');
        }
        if (ownSeqStart !== null && ownSeqStart !== queryBoundary) {
          return failClosedUncertain('inherited-boundary-mismatch');
        }
        ownSeqStart = queryBoundary;
        snapshotEvents = loaded.events;
      } catch (error) {
        // D-1:readSession 失败一律 failClosed。本函数只在 session.seq>0（确有历史）时
        // 被 lifecycle 调用；读不到历史就不得把空 pairs 当"全新会话"放行。
        engine.failClosed(scope);
        log('restore:fail-closed', { sessionId, reason: `readSession-failed:${String(error?.message ?? error)}` });
        return { mode: 'incompatible', reason: 'readSession-failed' };
      }
      const merged = mergeBySeq(snapshotEvents, buffer);
      // seq 值校验（不盲切数组）：合并流必须自 0 连续，否则边界与配对不可信
      if (!isContiguousSeqStream(merged)) {
        return failClosedUncertain('event-seq-not-contiguous');
      }
      // 边界越界（大于流长）= 损坏/不确定；等于流长是合法"整段继承"（own 为空）
      if (ownSeqStart > merged.length) {
        return failClosedUncertain('inherited-boundary-out-of-range');
      }
      // readSession 期间 live 事件可能已 fail closed：提交前再核一次，
      // 否则 await 窗口内的 fail closed 会被 engine.restore 的 mode='ready' 抹掉。
      if (sealed) {
        log('restore:skipped', { sessionId, reason: sealedReason });
        return { mode: 'incompatible', reason: sealedReason };
      }
      // own-only 折叠：只把本会话拥有的事件交给 fold（继承前缀整段滤除）
      const ownEvents = merged.filter((event) => event.seq >= ownSeqStart);
      // 成功压缩边界：压缩之前签发的 load 回执**不复活**。判据与 live 路径完全一致
      // （同一份 settleCompactionEnd），因此"重启后认哪个 epoch"与"运行时认哪个 epoch"
      // 永远是同一个函数，不会因为重放而漂移。
      //
      // **这里绝不触发迁移**：历史扫描出来的 command 链不是"本次 live 的用户迁移授权"，
      // 迁移只认 settleUserCompaction 在 live 路径上凑齐的那五条事件。
      for (const event of ownEvents) {
        if (event.type === 'request/header' || event.type === 'tool/call' || event.type === 'tool/result') {
          ownOutboundSeen = true;
        }
        if (event.type === 'compaction/start') {
          const id = event.data?.compactionId;
          if (typeof id === 'string' && id.length > 0 && !openCompactions.has(id)) {
            openCompactions.set(id, {
              turn: event.data?.turn,
              sourceCommandId: event.data?.sourceCommandId,
              summaries: [],
              startSeq: event.seq,
            });
          }
        } else if (event.type === 'compaction/summary') {
          const id = event.data?.compactionId;
          const open = typeof id === 'string' ? openCompactions.get(id) : undefined;
          if (open !== undefined
            && (open.sourceCommandId === undefined || open.sourceCommandId === event.data?.sourceCommandId)) {
            open.summaries.push(event.seq);
          }
        } else if (event.type === 'compaction/end') {
          settleCompactionEndQuiet(event);
        }
      }
      const pairs = foldPairs(ownEvents).filter((p) => p.seq > lastSuccessCompactionEndSeq);
      const outcome = engine.restore(pairs, scope);
      buffering = false;
      buffer = [];
      log('restore:folded', {
        sessionId,
        events: merged.length,
        ownEvents: ownEvents.length,
        pairs: pairs.length,
        compactionBoundary: lastSuccessCompactionEndSeq,
        inheritedBoundary: ownSeqStart,
        outcome,
        currentEpoch,
        ownOutboundSeen,
      });
      return outcome;
    })();
    return restorePromise;
  }

  /**
   * 冷恢复重放专用的压缩结算：推进 `currentEpoch` 与折叠下界，但**不**触发任何
   * onEpochReset / onUserCompactionComplete —— 重放期间 runtime 还没建好名单，
   * 更不能把历史里的命令当成迁移授权。
   */
  function settleCompactionEndQuiet(event) {
    const id = event.data?.compactionId;
    const open = typeof id === 'string' ? openCompactions.get(id) : undefined;
    if (open === undefined || !openCompactions.delete(id)) return;
    if (event.data?.turn !== open.turn) return;
    if (open.summaries.length !== 1) return;
    if (event.data?.error !== undefined) return;
    lastSuccessCompactionEndSeq = event.seq;
    currentEpoch = compactedEpochIdentity(id, event.seq);
  }

  /** 当前请求身份（canonical request/header 的 seq）；无 header 时为 #none。 */
  function currentRequestId() {
    return requestIdFor(latestHeaderSeq);
  }

  /**
   * 目录中仍有效（未被失效、定义未变）的 selected 名称集合 —— **披露白名单的唯一来源**。
   *
   * 非 ready（`restoring` / `incompatible`）一律返回空集：
   *   * `restoring`：恢复未完成，本就不该披露任何 selection（兑现 projection 的既有注释
   *     "可能仍处于 restoring → 只留三入口"）；`engine.restore()` 是原子地填 selected 并置
   *     ready，故正常路径下这是一条 no-op。
   *   * `incompatible`：fail closed 后引擎**按设计保留** `selected` 作为保守残留
   *     （清 selected 会改 domain 语义，超出本轮 scope）。该残留不授予执行权
   *     （`evaluateCall` 先判 `mode !== 'ready'`），但**绝不能**继续进入出站投影白名单，
   *     否则"fail closed"只停在执行面，隐藏工具的完整 schema 仍会随下一轮出站泄露。
   * 不改 domain / projection / guard：收口点就在本 getter。
   */
  function activeSelectedNames() {
    const state = engine.getState(scope);
    if (state.mode !== 'ready') return [];
    const catalog = engine.getCatalog();
    const names = [];
    for (const [toolId, selection] of state.selected) {
      if (state.invalidated.has(toolId)) continue;
      const entry = catalog.entries.get(toolId);
      if (entry === undefined || entry.revision !== selection.revision) continue;
      names.push(selection.name);
    }
    return names;
  }

  /**
   * 本会话在当前缓存周期内已逐字披露过的工具名。撤权 / 换版**不**把它移除：
   * 披露缓存的清空点只有成功压缩（见 openCompactions 段）。
   */
  function frozenNames() {
    return engine.getFrozenWire(scope).map((f) => f.name);
  }

  /**
   * 尚在飞行中、canonical 回执尚未折叠的 tool_load 目标名。
   *
   * 模型在同一响应里 load 完立刻猜测调用是常见写法，而折叠要等 tool/result
   * 才发生。没有这个查询，guard 会把这种「即将生效」误判为「从未加载」，
   * 报出与事实相反的 TOOL_NOT_LOADED，模型据此重试或改走错误路径。
   */
  function pendingLoadNames() {
    const names = new Set();
    for (const { input } of liveCalls.values()) {
      if (Array.isArray(input?.names)) {
        for (const n of input.names) if (typeof n === 'string') names.add(n);
      }
      if (Array.isArray(input?.candidates)) {
        for (const c of input.candidates) if (typeof c?.name === 'string') names.add(c.name);
      }
    }
    return names;
  }

  return {
    sessionId,
    onEvent,
    restore,
    currentRequestId,
    activeSelectedNames,
    pendingLoadNames,
    /**
     * 本会话**当前**缓存周期身份。只来自本会话自己的成功 canonical 压缩边界
     * （`initial` 或 `compactionId@endSeq`）；冷恢复重放推进它，live 压缩也推进它。
     * lifecycle 用它去 storageDomain 里找**同一个 epoch** 的那一份名单。
     */
    currentEpoch: () => ({ ...currentEpoch }),
    /**
     * own 段里是否出现过真实出站/工具事实（request/header、tool/call、tool/result）。
     * false ⇒ 这个会话还没有任何可被"出站日志"授权过的东西。
     */
    hasOwnOutboundHistory: () => ownOutboundSeen,
    /** journal 自身因日志损坏而封死（严重损坏的冷恢复保持既有 seal 语义）。 */
    isSealed: () => sealed,
    /** 封死的原因（只读诊断面；供 lifecycle 把 failed-closed 归因写进 reason）。 */
    sealedReason: () => sealedReason,
    whenRestored: () => restorePromise,
    dispose() {
      buffering = false;
      buffer = [];
      liveCalls.clear();
      // 会话释放后不再有任何读者；留着它只会让迟到的重放复活授权。
      latestHeaderTools = null;
      latestHeaderSeq = undefined;
    },
  };
}
