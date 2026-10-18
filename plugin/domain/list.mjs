// plugin/domain/list.mjs
// 四个 view 的名称/类别/状态投影 + opaque 游标分页。
// 名称模式逐项**只有完整原生名称**:不附 description / summary / revision / schema / skill。
// 游标绑定 {sessionId, view, category, eligibilityGeneration, offset, expiresAt, orderDigest}。
import { fitPrefixLength, estimatedTokenCount } from './budgets.mjs';
import { canonicalJson } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject, mintOpaqueId } from './util.mjs';

// --- i18n shim (added by the message migration) ---------------------------
// These validators are pure and take no locale argument. The plugin resolves
// one locale per activation, so bind the text accessor once here rather than
// threading it through every signature. setLocaleForDomain() is called by the
// adapter at activation; tests call it directly to exercise both languages.
import { domainText } from './locale.mjs';
const text = domainText;
const t = (path) => text.t(path);


/**
 * @param {{ clock:{now():number}, random:{bytes(n:number):Uint8Array}, ttlMs?:number }} deps
 */
export function createCursorStore(deps) {
  const ttlMs = deps.ttlMs ?? 900_000;
  /** @type {Map<string, any>} */
  const store = new Map();
  return {
    /**
     * @param {{sessionId:string, view:string, category:string, eligibilityGeneration:number, offset:number, orderDigest:string}} rec
     */
    issue(rec) {
      const now = deps.clock.now();
      // 顺带清扫已过期游标(TTL 固定 → 插入序即到期序,遇到首个未过期即停)。
      for (const [key, old] of store) {
        if (old.expiresAt > now) break;
        store.delete(key);
      }
      const cursor = mintOpaqueId(deps.random, 'p_');
      store.set(cursor, { ...rec, expiresAt: now + ttlMs });
      return cursor;
    },
    /**
     * @param {string} cursor
     * @param {{sessionId:string, view:string, category:string, eligibilityGeneration:number, orderDigest:string, now:number}} expect
     */
    resolve(cursor, expect) {
      if (!isNonEmptyString(cursor)) throw new DomainError('CURSOR_UNAVAILABLE');
      const rec = store.get(cursor);
      if (!rec) throw new DomainError('CURSOR_UNAVAILABLE');
      if (rec.expiresAt <= expect.now) {
        store.delete(cursor);
        throw new DomainError('CURSOR_UNAVAILABLE');
      }
      if (rec.sessionId !== expect.sessionId) throw new DomainError('CURSOR_UNAVAILABLE');
      if (rec.view !== expect.view || rec.category !== expect.category) throw new DomainError('CURSOR_UNAVAILABLE');
      if (rec.eligibilityGeneration !== expect.eligibilityGeneration) throw new DomainError('CURSOR_UNAVAILABLE');
      if (rec.orderDigest !== expect.orderDigest) throw new DomainError('CURSOR_UNAVAILABLE');
      return rec;
    },
    clear() {
      store.clear();
    },
    /**
     * 按会话回收（会话销毁 / HMR）：游标由 sessionId 归属，销毁后不得继续可用。
     * 只在 `issue()` 里顺带清扫过期项是不够的 —— 列表始终单页时从不 issue。
     * @param {string} sessionId
     */
    dropForSession(sessionId) {
      for (const [cursor, rec] of store) {
        if (rec.sessionId === sessionId) store.delete(cursor);
      }
    },
    size() {
      return store.size;
    },
  };
}

/**
 * 通用项分页辅助函数。
 * @template T
 * @param {{
 *   items: T[], cursorStore: any, sessionId: string, view: string, category: string,
 *   eligibilityGeneration: number, orderDigest: string, limit: number, budgets: any,
 *   now: number, cursor?: string, emptyBudgetMessagePath: string[], emptyBudgetDetails?: Record<string, unknown>,
 *   measurePage?: (page:{pageItems:T[],nextCursor:string|null,truncated:boolean})=>number
 * }} args
 * @returns {{ pageItems: T[], nextCursor: string|null, truncated: boolean }}
 */
function paginateItems(args) {
  const {
    items, cursorStore, sessionId, view, category,
    eligibilityGeneration, orderDigest, limit, budgets, now, cursor,
    emptyBudgetMessagePath, emptyBudgetDetails,
  } = args;

  let offset = 0;
  if (cursor !== undefined) {
    const rec = cursorStore.resolve(cursor, {
      sessionId, view, category, eligibilityGeneration, orderDigest, now,
    });
    offset = rec.offset;
  }

  // 与 createCursorStore 的 p_ + 16 字节 hex 同形；确认页大小后才真正铸游标。
  const placeholder = `p_${'0'.repeat(32)}`;
  const count = Math.min(limit, items.length - offset);
  const pageAt = (n) => ({ pageItems: items.slice(offset, offset + n),
    nextCursor: n > 0 && offset + n < items.length ? placeholder : null,
    truncated: offset + n < items.length });
  const measure = args.measurePage ?? ((page) => Buffer.byteLength(JSON.stringify(page), 'utf8'));
  const keep = fitPrefixLength(count, budgets.maxListResultBytes, (n) => measure(pageAt(n)));
  if (keep < 0 || (count > 0 && keep === 0)) {
    throw new DomainError('BUDGET_EXCEEDED', t(emptyBudgetMessagePath), emptyBudgetDetails);
  }
  const page = pageAt(keep);
  if (page.nextCursor !== null) {
    page.nextCursor = cursorStore.issue({
      sessionId, view, category, eligibilityGeneration, offset: offset + keep, orderDigest,
    });
  }
  return page;
}

/**
 * 名称分页。返回完整名称(不截断),超字节上限时减少**完整项数**。
 * @param {object} args
 * @returns {{names:string[], nextCursor:string|null, truncated:boolean}}
 */
export function paginateNames(args) {
  const { allNames, ...rest } = args;
  const page = paginateItems({
    items: allNames,
    ...rest,
    emptyBudgetMessagePath: ['detail', 'nameOverByteBudget'],
    emptyBudgetDetails: { maxBytes: rest.budgets.maxListResultBytes },
  });
  return { names: page.pageItems, nextCursor: page.nextCursor, truncated: page.truncated };
}

/**
 * 类别分页。
 * @param {object} args
 * @returns {{categories:Array<object>, nextCursor:string|null, truncated:boolean}}
 */
export function paginateCategories(args) {
  const { allCards, ...rest } = args;
  const page = paginateItems({
    items: allCards,
    ...rest,
    emptyBudgetMessagePath: ['detail', 'categoryCardOverByteBudget'],
  });
  return { categories: page.pageItems, nextCursor: page.nextCursor, truncated: page.truncated };
}

/**
 * 状态投影:只返回会话内 selected / advertised / invalidated 与预算,不枚举隐藏目录。
 * @param {import('./state.mjs').SessionDiscoveryState} state
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} budgets
 * @param {Array<{wireBytes:number}>} activeEntries
 */
export function projectState(state, budgets, activeEntries) {
  let totalBytes = 0;
  for (const e of activeEntries) totalBytes += e.wireBytes;
  return {
    mode: state.mode,
    selected: Array.from(state.selected.values())
      .map((s) => ({
        toolId: s.toolId, name: s.name, revision: s.revision,
        selectionSource: s.selectionSource,
      }))
      .sort((a, b) => (a.toolId < b.toolId ? -1 : 1)),
    advertised: Array.from(state.advertised.values())
      .map((a) => ({ toolId: a.toolId, name: a.name, revision: a.revision, requestId: a.requestId }))
      .sort((a, b) => (a.toolId < b.toolId ? -1 : 1)),
    invalidated: Array.from(state.invalidated.entries())
      .map(([toolId, v]) => ({ toolId, reason: v.reason, at: v.at, revision: v.revision }))
      .sort((a, b) => (a.toolId < b.toolId ? -1 : 1)),
    budgets: {
      maxActiveTools: budgets.maxActiveTools,
      maxActiveSchemaBytes: budgets.maxActiveSchemaBytes,
      activeCount: activeEntries.length,
      activeSchemaBytes: totalBytes,
      tokenEstimation: 'estimate',
    },
  };
}

/** 供测试:初始导航体积估算(不截断任何 schema/名称)。 */
export function navigationFootprint(cards) {
  return {
    bytes: Buffer.byteLength(canonicalJson(cards), 'utf8'),
    estimatedTokens: estimatedTokenCount(JSON.stringify(cards)),
    method: 'estimate',
  };
}

/**
 * 把状态投影塞进字节上限：**只裁 `invalidated`**（纯诊断段），逐条减少完整项直到装下。
 *
 * 为什么不是一律明确失败：`selected` / `advertised` 是执行与披露的事实，裁它们会改变含义；
 * 但 `invalidated` 只增不减（state.mjs 的 `next.invalidated.set(...)`），长会话里它会单独把
 * 整个 `view:"state"` 顶穿 —— 于是配了上限的部署会**永久**拿不到状态视图，直到一次成功压缩。
 * 那是"开关看起来配上了、实际长期报错"，比没有上限更糟。
 *
 * 这是**带标记裁剪**，不是静默裁剪：返回值带 `invalidatedTruncated: true`，调用方知道这一段不全。
 * 真装不下（连三段里最短的组合都超）时返回 `null`，由调用方按明确失败处理。
 *
 * 度量口径与出站一致：外壳由 adapter 用 `JSON.stringify` 序列化，这里也用同一口径，
 * 避免 `canonicalJson`（对 `undefined`/NaN 抛错）与真实出站行为不一致。
 *
 * 定位方式：`invalidated` 缩得越短结果一定越小（序列化对数组长度单调不增），因此先用
 * keep=0 一次 O(1) 判定快速失败，再二分出**最大**可保留条数 —— 结果与逐条递减完全一致，
 * 但把 O(N) 次整份序列化降到 O(log N)。
 *
 * @param {{invalidated?: unknown[]}} payload
 * @param {number|null} maxBytes
 * @param {(payload:object)=>number} [sizeOf] 引擎传入完整成功外壳的字节度量。
 * @returns {object|null}
 */
export function fitStateWithinBudget(payload, maxBytes, sizeOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')) {
  if (maxBytes === null) return payload;
  if (sizeOf(payload) <= maxBytes) return payload;
  const invalidated = Array.isArray(payload.invalidated) ? payload.invalidated : [];
  const candidateFor = (keep) => ({ ...payload, invalidated: invalidated.slice(0, keep), invalidatedTruncated: true });
  // 空数组时连 keep=0 的候选都不必试：它必然比 payload 更长，而 payload 已超限。
  if (invalidated.length === 0) return null;
  if (sizeOf(candidateFor(0)) > maxBytes) return null;
  let lo = 0;
  let hi = invalidated.length - 1;
  const largest = candidateFor(hi);
  if (sizeOf(largest) <= maxBytes) return largest;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sizeOf(candidateFor(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return candidateFor(lo);
}

const LIST_VIEW_SET = new Set(['available', 'loaded', 'categories', 'state']);

/** 供 adapter 用:校验 view 名。 */
export function isListView(v) {
  return typeof v === 'string' && LIST_VIEW_SET.has(v);
}
