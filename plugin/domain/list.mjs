// progressive-v2/domain/list.mjs
// 四个 view 的名称/类别/状态投影 + opaque 游标分页。
// 名称模式逐项**只有完整原生名称**:不附 description / summary / revision / schema / skill。
// 游标绑定 {sessionId, view, category, eligibilityGeneration, offset, expiresAt, orderDigest}。
import { createByteAccumulator, estimatedTokenCount } from './budgets.mjs';
import { canonicalJson } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject } from './util.mjs';

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
  const mint = () => {
    const buf = deps.random.bytes(16);
    let hex = '';
    for (const b of buf) hex += b.toString(16).padStart(2, '0');
    return `p_${hex}`;
  };
  return {
    /**
     * @param {{sessionId:string, view:string, category:string, eligibilityGeneration:number, offset:number, orderDigest:string}} rec
     */
    issue(rec) {
      const cursor = mint();
      store.set(cursor, { ...rec, expiresAt: deps.clock.now() + ttlMs });
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
    size() {
      return store.size;
    },
  };
}

/**
 * 名称分页。返回完整名称(不截断),超字节上限时减少**完整项数**。
 * @param {object} args
 * @returns {{names:string[], nextCursor:string|null, truncated:boolean}}
 */
export function paginateNames(args) {
  const {
    allNames, cursorStore, sessionId, view, category,
    eligibilityGeneration, orderDigest, limit, budgets, now, cursor,
  } = args;

  let offset = 0;
  if (cursor !== undefined) {
    const rec = cursorStore.resolve(cursor, {
      sessionId, view, category, eligibilityGeneration, orderDigest, now,
    });
    offset = rec.offset;
  }

  const acc = createByteAccumulator(budgets.maxListResultBytes);
  /** @type {string[]} */
  const names = [];
  let idx = offset;
  let truncated = false;

  for (; idx < allNames.length; idx++) {
    const name = allNames[idx]; // 完整名称,绝不截断
    if (!acc.tryAdd(JSON.stringify(name))) {
      // 一个完整项都放不下 → 明确失败
      if (names.length === 0) {
        throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'nameOverByteBudget']), {
          maxBytes: budgets.maxListResultBytes,
        });
      }
      truncated = true;
      break;
    }
    names.push(name);
    if (names.length >= limit) {
      idx += 1;
      if (idx < allNames.length) truncated = true;
      break;
    }
  }

  let nextCursor = null;
  if (truncated && names.length > 0) {
    const nextOffset = offset + names.length;
    nextCursor = cursorStore.issue({
      sessionId, view, category, eligibilityGeneration, offset: nextOffset, orderDigest,
    });
  }

  return { names, nextCursor, truncated };
}

/**
 * 类别分页。
 * @param {object} args
 * @returns {{categories:Array<object>, nextCursor:string|null, truncated:boolean}}
 */
export function paginateCategories(args) {
  const {
    allCards, cursorStore, sessionId, view, category,
    eligibilityGeneration, orderDigest, limit, budgets, now, cursor,
  } = args;

  let offset = 0;
  if (cursor !== undefined) {
    const rec = cursorStore.resolve(cursor, {
      sessionId, view, category, eligibilityGeneration, orderDigest, now,
    });
    offset = rec.offset;
  }

  const acc = createByteAccumulator(budgets.maxListResultBytes);
  /** @type {Array<object>} */
  const cards = [];
  let idx = offset;
  let truncated = false;

  for (; idx < allCards.length; idx++) {
    const card = allCards[idx];
    if (!acc.tryAdd(JSON.stringify(card))) {
      if (cards.length === 0) throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'categoryCardOverByteBudget']));
      truncated = true;
      break;
    }
    cards.push(card);
    if (cards.length >= limit) {
      idx += 1;
      if (idx < allCards.length) truncated = true;
      break;
    }
  }

  let nextCursor = null;
  if (truncated && cards.length > 0) {
    nextCursor = cursorStore.issue({
      sessionId, view, category, eligibilityGeneration, offset: offset + cards.length, orderDigest,
    });
  }
  return { categories: cards, nextCursor, truncated };
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

/** 供 adapter 用:校验 view 名。 */
export function isListView(v) {
  return isPlainObject({ v }) && typeof v === 'string' && ['available', 'loaded', 'categories', 'state'].includes(v);
}
