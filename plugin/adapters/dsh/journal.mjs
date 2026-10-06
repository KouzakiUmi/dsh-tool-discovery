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
  const alwaysVisible = new Set(deps.alwaysVisible ?? []);
  const reportBypass = deps.reportBypass ?? (() => {});

  /** live 路径的 canonical call 缓存：callSeq → {callId, input}（只存 tool_load）。 */
  const liveCalls = new Map();
  /** 恢复窗口内的新事件缓冲（读快照期间到达的事件不能丢）。 */
  let buffering = true;
  /** @type {any[]} */
  let buffer = [];
  /** @type {number|undefined} 最近一次 canonical request/header 的 seq */
  let latestHeaderSeq;
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

    // 披露集合的**权威**观测点：真实出站 request/header。
    // 若这里出现三入口 / 可信框架保留 / 有效 selected 之外的工具，
    // 说明有别的 listener 在我们投影之后又重加了 schema → 整会话 fail closed。
    const allowed = new Set([...entryNames, ...frameworkRetained, ...alwaysVisible, ...activeSelectedNames()]);
    const leaked = headerTools.map((tool) => tool?.name).filter((name) => !allowed.has(name));
    if (leaked.length > 0) {
      reportBypass({ sessionId, names: [...new Set(leaked)] });
      log('composition:bypass', { sessionId, leaked });
      return;
    }

    const byName = new Map(headerTools.map((tool) => [tool.name, tool]));
    const state = engine.getState(scope);
    for (const [toolId, selection] of state.selected) {
      const advertisedTool = byName.get(selection.name);
      if (advertisedTool === undefined) continue;
      const digest = digestOf(wireOfSchema(advertisedTool));
      if (digest !== selection.schemaDigest) {
        // 出站定义与选中时的定义不一致 → 不算已披露（不静默放行）
        log('advertisement:definition-drift', { sessionId, toolId, name: selection.name });
        continue;
      }
      engine.recordAdvertisement(scope, {
        requestId: requestIdFor(event.seq),
        toolId,
        name: selection.name,
        revision: selection.revision,
        schemaDigest: selection.schemaDigest,
      });
    }
  }

  function requestIdFor(seq) {
    return `${sessionId}#${seq === undefined ? 'none' : seq}`;
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
      recordAdvertisements(event);
      return;
    }
    if (event.type === 'tool/call') {
      if (event.data?.name !== 'tool_load') return;
      const input = parseArguments(event.data?.arguments);
      if (input === null || typeof input !== 'object') return;
      liveCalls.set(event.seq, { callId: String(event.data.callId), input });
      return;
    }
    if (event.type !== 'tool/result') return;
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
      else log('journal:applied', { sessionId, seq: callSeq, operationId: pair.call.operationId });
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
      const pairs = foldPairs(ownEvents);
      const outcome = engine.restore(pairs, scope);
      buffering = false;
      buffer = [];
      log('restore:folded', {
        sessionId,
        events: merged.length,
        ownEvents: ownEvents.length,
        pairs: pairs.length,
        inheritedBoundary: ownSeqStart,
        outcome,
      });
      return outcome;
    })();
    return restorePromise;
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
    whenRestored: () => restorePromise,
    dispose() {
      buffering = false;
      buffer = [];
      liveCalls.clear();
    },
  };
}
