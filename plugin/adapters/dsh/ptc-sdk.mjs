// PTC 只裁剪公开 tools:sdk 文本，不通过 tools.restrict 改变宿主资格目录。
// 曝光只在已品牌化的真实 agent-loop llm/stream 请求中确认，assemble/旧 header 不授信。
import { ENTRY_TOOL_NAMES, DomainError, digestOf } from '../../domain/index.mjs';
import { wireOfSchema } from './registry.mjs';

const RUN_CODE = 'run_code';

export function createPtcDisclosure(deps) {
  const { ctx, lifecycle, enabled, renderToolsSdk, renderToolsSdkPy, isAgentLoopRequest } = deps;
  const log = deps.log ?? (() => {});
  // assembly 与其实际 SDK 快照一一对应；预览不会自己生成 advertised。
  // **pending 存「未观测快照」列表**（而非单一快照）：同一 runtime 可能在一次请求被
  // 观测前产生多次投影（重入 assemble / 并发预览 / 另一 agent）。若只存最后一次，早先
  // 那次的请求会去对照后一次的快照而被误拒 —— 二者文本本可各自自洽。observeRequest 按
  // 「出站 system 含某快照 text」匹配出本次请求对应的快照，取最长（最精确）者入账。
  const pending = new WeakMap();
  // 诊断：本 session 最近几次投影的指纹。守卫失败时连同现场一起报出，用来区分
  // 「快照缺失 / 周期漂移 / 出站文本不含投影」三种原因 —— 只读记录，不改判定。
  const projections = new WeakMap();
  const PROJECTION_TRACE_LIMIT = 8;
  // pending 快照上限：防无界累积。超限时优先淘汰已观测的（已入账、不再需匹配），
  // 保护仍在途的未观测快照；全部在途时才 FIFO 兜底。
  // 取舍：这会让已观测快照在超限时被过早淘汰，其「重试」将失败（诊断归 evicted-snapshot）——
  // 「在途首次观测」优先于「已观测重试」，是有意为之。
  const PENDING_LIMIT = 8;
  // 被淘汰快照的摘要留痕：守卫失败时据此把「快照已被淘汰」归因成 evicted-snapshot，
  // 而非误报成「文本被改写」。仅诊断用，不参与匹配判定。
  const evicted = new WeakMap();
  const EVICTED_LIMIT = 8;

  function pushEvicted(runtime, item) {
    const list = evicted.get(runtime) ?? [];
    list.push({
      text: item.text,
      epoch: item.epoch,
      observed: item.observed,
      names: item.names,
      mode: item.mode,
    });
    if (list.length > EVICTED_LIMIT) list.shift();
    evicted.set(runtime, list);
  }

  // 诊断：呈现模式快照。宿主 `dsh-tools` 的 `tools:sdk` section 在 `modeFor(scope)`
  // 为 `native` 时渲染空串、非 native 时才渲染宿主自己的 SDK；本插件也只在非 native 时
  // 替换该 section。投影当刻与出站当刻各记一次，用来区分「投影时还不是非 native」
  // 与「请求发出时已经不是非 native」——两种情况都表现为出站不含投影文本。
  // 只读：不参与任何判定。
  function modeOf(scope) {
    try { return ctx.tools.modeFor(scope); } catch { return 'unknown'; }
  }

  function allowNames(runtime) {
    const names = new Set([...ENTRY_TOOL_NAMES, ...(deps.frameworkRetained ?? []), ...(runtime.alwaysNameSet ?? [])]);
    names.delete(RUN_CODE);
    const state = runtime.engine.getState(runtime.scope);
    if (state.mode !== 'ready' || runtime.compositionBypass !== null) return names;
    const catalog = runtime.engine.getCatalog();
    for (const item of state.selected.values()) {
      const entry = catalog.entries.get(item.toolId);
      if (state.invalidated.has(item.toolId) || entry === undefined
        || entry.revision !== item.revision || entry.name !== item.name) continue;
      names.add(item.name);
    }
    return names;
  }

  function project(agent, assembly, runtime) {
    const language = ctx.get('ptcRuntime')?.language;
    const render = language === 'typescript' ? renderToolsSdk : language === 'python' ? renderToolsSdkPy : undefined;
    if (typeof render !== 'function' || typeof isAgentLoopRequest !== 'function') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'PTC discovery requires the host SDK renderer and agent-loop request observer.');
    }
    const sections = assembly.sections ?? [];
    if (sections.filter((section) => section.name === 'tools:sdk').length !== 1) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'PTC discovery requires exactly one tools:sdk section.');
    }
    const allowed = allowNames(runtime);
    const schemas = ctx.tools.sdkSchemas(agent).filter((schema) => allowed.has(schema.name));
    const text = render(schemas);
    const byName = new Map(schemas.map((schema) => [schema.name, wireOfSchema(schema)]));
    const state = runtime.engine.getState(runtime.scope);
    const records = [];
    if (state.mode === 'ready' && runtime.compositionBypass === null) {
      for (const selection of state.selected.values()) {
        const wire = byName.get(selection.name);
        if (wire === undefined || digestOf(wire) !== selection.schemaDigest || state.invalidated.has(selection.toolId)) continue;
        records.push({ toolId: selection.toolId, name: selection.name, revision: selection.revision,
          schemaDigest: selection.schemaDigest, wire });
      }
    }
    const prior = pending.get(runtime) ?? [];
    // 同周期内重复投影同一 text（例如已观测后又发生一次未派发预览 assemble）时，
    // 继承既有的 observed 标记：不让预览把「已观测」冲回 false，否则超限时它会占住
    // 真正未观测在途快照的槽位。
    const prevObserved = prior.some((item) => item.epoch === state.epoch && item.text === text && item.observed);
    const snapshot = { text, records, epoch: state.epoch, names: schemas.map((schema) => schema.name),
      mode: modeOf(agent), observed: prevObserved };
    // 去重 + 保留旧周期 + 上限淘汰：
    //  * 同 text 旧快照被新快照覆盖（新者 records/epoch 更准）——重复预览不浪费槽位，也不会挤掉唯一 text 的在途快照。
    //  * 重新投影同一 text 时，从 evicted 移除同 text 旧留痕（该文本已重新在途）。
    //  * 刻意**不**清旧周期快照：保留它们供 dispatch-mismatch 识别「出站是旧周期文本」→ cache-epoch-drift。
    //  * 超上限时淘汰优先级：(1) 旧周期快照（进了 evicted 仍保留 epoch 供 drift 诊断）
    //    → (2) 当前周期已观测快照 → (3) FIFO 兜底，最大限度保护当前周期未观测的在途快照。
    const kept = prior.filter((item) => item.text !== text);
    const prevEvicted = evicted.get(runtime);
    if (prevEvicted !== undefined) {
      evicted.set(runtime, prevEvicted.filter((item) => item.text !== text));
    }
    kept.push(snapshot);
    if (kept.length > PENDING_LIMIT) {
      let excess = kept.length - PENDING_LIMIT;
      for (let i = 0; i < kept.length && excess > 0;) {
        if (kept[i].epoch !== state.epoch) {
          pushEvicted(runtime, kept[i]);
          kept.splice(i, 1); excess -= 1;
        } else i += 1;
      }
      for (let i = 0; i < kept.length && excess > 0;) {
        if (kept[i].observed) {
          pushEvicted(runtime, kept[i]);
          kept.splice(i, 1); excess -= 1;
        } else i += 1;
      }
      if (excess > 0) {
        for (let j = 0; j < excess; j++) pushEvicted(runtime, kept[j]);
        kept.splice(0, excess);
      }
    }
    pending.set(runtime, kept);
    const trace = projections.get(runtime) ?? [];
    trace.push({ at: Date.now(), epoch: state.epoch, tools: schemas.length, length: text.length,
      digest: digestOf(text).slice(0, 20), mode: snapshot.mode, names: schemas.map((schema) => schema.name) });
    if (trace.length > PROJECTION_TRACE_LIMIT) trace.shift();
    projections.set(runtime, trace);
    return { ...assembly, sections: sections.map((section) => section.name === 'tools:sdk'
      ? { ...section, text, interpolate: false } : section) };
  }

  function observeRequest(options) {
    if (enabled() !== true || typeof isAgentLoopRequest !== 'function' || !isAgentLoopRequest(options)) return;
    const runtime = lifecycle.sessions.get(options.sessionId);
    if (runtime === undefined || ctx.tools.modeFor(runtime.agentScope) === 'native') return;
    const pendingList = pending.get(runtime) ?? [];
    // in-history 路由可能保留多个 system 节点，只认最后一个非空 system 消息。
    const latest = options.messages?.filter((message) => message.role === 'system')
      .map((message) => (message.content ?? []).map((block) => block.type === 'text' ? block.text : '').join(''))
      .filter((text) => text.length > 0).at(-1);
    const currentEpoch = runtime.engine.getState(runtime.scope).epoch;
    // 按「出站 system 含快照 text」匹配本次请求对应的快照，取最长（最精确）者，
    // 同长度取最新（后投影者）——同 text 不同 records 时按最新 revision 入账，修 records 归属。
    // 空串快照绝不参与子串匹配（`latest.includes('')` 恒真会把任意出站当成命中）。
    let snapshot;
    if (typeof latest === 'string') {
      for (const item of pendingList) {
        if (item.epoch !== currentEpoch || item.text.length === 0 || !latest.includes(item.text)) continue;
        if (snapshot === undefined || item.text.length >= snapshot.text.length) snapshot = item;
      }
    }
    if (snapshot === undefined) {
      reportDispatchMismatch(options, runtime, pendingList, latest, currentEpoch, modeOf(runtime.agentScope));
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The outgoing PTC SDK does not match the discovery projection.');
    }
    // 不消费：观测不删除快照，正常情况下「同一 branded 请求可重复观测（重试/复用 assembly）」。
    // 只标记已观测，供 project 端超限时优先淘汰——已入账的先让位保护在途快照；因此极端超限
    // （≥ PENDING_LIMIT+1 个不同 text）时已观测快照可能被过早淘汰，其重试会失败（归 evicted-snapshot）。
    snapshot.observed = true;
    runtime.journal.recordSdkAdvertisements(snapshot.records);
    log('ptc:sdk-advertised', { sessionId: options.sessionId, names: snapshot.records.map((record) => record.name) });
  }

  /**
   * 守卫失败时的现场留痕（只读，不参与判定）。
   *
   * 失败分支按「未观测快照列表 + 出站匹配」分级（抛出的错误本身仍不区分，靠这里定位）：
   *   * `projection-missing`：该 runtime 上没有任何快照且被淘汰项也不匹配（assemble 从未投影到这里）。
   *   * `cache-epoch-drift`：当前周期无可匹配快照——或周期已被推进（目前只有压缩结束会推进），
   *     或出站只包含旧周期的快照文本。
   *   * `evicted-snapshot`：出站匹配的是被淘汰的快照（超限时已观测快照被先淘汰，其重试会到此）。
   *   * `no-system-text`：出站里没有非空 system 消息可比对。
   *   * `outgoing-text-mismatch`：有同周期快照、出站也有 system，但没有任何快照的 text 被
   *     出站包含 —— 结合 `projections` 指纹可判断是"宿主重渲染覆盖"还是"文本被改写"。
   *
   * 除 reason 外，`modeAtProjection` / `modeAtDispatch`（以及每条 `projections[].mode`）
   * 用来区分另一条独立成因：投影当刻或出站当刻的呈现模式为 `native` —— 那时
   * `tools:sdk` section 由宿主渲染空串/宿主自己的 SDK，本插件从未替换过它，
   * 与"投影文本被改写"是两回事。
   */
  /**
   * 定位投影文本与出站文本的**首个逐字符分歧**（只读诊断，不参与判定）。
   *
   * 先按引言（前 120 字符；若前 120 字符内即发生改写则回退到前 24 字符短锚点）
   * 在出站里找到对应起点，再从该点逐字符比对，返回分歧偏移与两侧各 160 字符的片段。
   * 引言本身找不到时返回 `offset: -1` —— 那说明整段被换掉（不是局部改写）。
   */
  function firstDivergenceOf(projected, latestText) {
    if (typeof projected !== 'string' || projected.length === 0 || latestText === null) return null;
    let at = latestText.indexOf(projected.slice(0, 120));
    if (at < 0 && projected.length >= 24) at = latestText.indexOf(projected.slice(0, 24));
    if (at < 0) return { offset: -1, projection: projected.slice(0, 160), outgoing: null };
    let offset = 0;
    while (offset < projected.length && at + offset < latestText.length
      && projected[offset] === latestText[at + offset]) offset += 1;
    return {
      offset,
      projectedTotal: projected.length,
      outgoingExhausted: at + offset >= latestText.length,
      projection: projected.slice(offset, offset + 160),
      outgoing: latestText.slice(at + offset, at + offset + 160),
    };
  }

  function reportDispatchMismatch(options, runtime, pendingList, latest, currentEpoch, modeAtDispatch) {
    const latestText = typeof latest === 'string' ? latest : null;
    const trace = projections.get(runtime) ?? [];
    const matching = latestText === null ? [] : pendingList.filter((item) => item.text.length > 0 && latestText.includes(item.text));
    const matchingCurrent = matching.filter((item) => item.epoch === currentEpoch);
    const sameEpoch = pendingList.filter((item) => item.epoch === currentEpoch);
    const evictedList = evicted.get(runtime) ?? [];
    const evictedMatch = latestText === null ? [] : evictedList.filter((item) => item.text.length > 0 && latestText.includes(item.text));
    const evictedCurrent = evictedMatch.filter((item) => item.epoch === currentEpoch);
    // 定性优先看「是否匹配到当前周期快照」：只匹配到旧周期快照（含已被淘汰的旧周期快照）
    // 一律归 cache-epoch-drift；匹配到当前周期被淘汰快照才归 evicted-snapshot。
    const reason = latestText === null ? 'no-system-text'
      : pendingList.length === 0 && evictedMatch.length === 0 ? 'projection-missing'
        : matchingCurrent.length === 0 && matching.length > 0 ? 'cache-epoch-drift'
          : matchingCurrent.length === 0 && evictedCurrent.length > 0 ? 'evicted-snapshot'
            : matchingCurrent.length === 0 && evictedMatch.length > 0 ? 'cache-epoch-drift'
              : sameEpoch.length === 0 ? 'cache-epoch-drift' : 'outgoing-text-mismatch';
    // names 取「代表快照」自身的 names（而非最新 trace），避免归因到别的投影。
    const representative = matchingCurrent[0] ?? matching.at(-1) ?? evictedCurrent.at(-1) ?? evictedMatch.at(-1) ?? sameEpoch.at(-1);
    const names = representative?.names ?? trace.at(-1)?.names ?? [];
    log('ptc:dispatch-mismatch', {
      sessionId: options.sessionId,
      reason,
      snapshotEpochs: pendingList.map((item) => item.epoch),
      currentEpoch,
      pendingCount: pendingList.length,
      matchedCount: matching.length,
      latestLength: latestText === null ? null : latestText.length,
      projectedLengths: pendingList.map((item) => item.text.length),
      includesProjection: representative !== undefined && latestText !== null && representative.text.length > 0
        ? latestText.includes(representative.text) : false,
      // 引言（固定指令）是否在出站里：区分"渲染契约不同"与"仅声明集合不同"。
      includesProjectionHead: representative !== undefined && latestText !== null && representative.text.length > 0
        ? latestText.includes(representative.text.slice(0, 120)) : false,
      projectionCount: trace.length,
      projections: trace.map((entry) => ({
        at: entry.at, epoch: entry.epoch, tools: entry.tools, length: entry.length, digest: entry.digest,
        mode: entry.mode,
      })),
      // 呈现模式：投影当刻 vs 出站当刻。宿主 `dsh-tools` 的 `tools:sdk` section 在
      // `modeFor(scope) === 'native'` 时渲染空串，且本插件只在非 native 时替换它 ——
      // 两者不一致（尤其投影为 native）本身就是「出站不含投影文本」的一条独立成因，
      // 与「文本被改写」不同：那种情况下该 section 从头到尾不属于本插件。
      modeAtDispatch,
      modeAtProjection: representative?.mode ?? trace.at(-1)?.mode ?? null,
      // 首个分歧点：定位引言在出站里的位置，再逐字符比对，给出投影与出站在**哪一位**
      // 开始不同以及两侧片段 —— 把「被改写了什么」指到具体位置，而不是继续猜上游插件。
      firstDivergence: firstDivergenceOf(representative?.text, latestText),
      projectedTools: names.length,
      evictedCount: evictedList.length,
      evictedMatched: evictedMatch.length,
      missingFromLatest: latestText === null ? null : names.filter((name) => !latestText.includes(name)),
    });
  }

  return { project, observeRequest, allowNames };
}
