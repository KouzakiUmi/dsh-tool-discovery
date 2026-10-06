// progressive-v2/domain/engine.mjs
// 组合根:请求处理、load/unload 事务、advertise/guard/失效/恢复。
//
// 边界:不 import Cordis / DSH / 第三方包;不注册工具;不写日志;不改 profile。
// 所有"当前可见性 / 展示模式 / 保留项 / 身份"都由 adapter 以可信 DTO 传入。
import { resolveBudgets } from './budgets.mjs';
import { buildCatalog, resolveByName, resolveByToolId } from './catalog.mjs';
import { buildCategoryCards, resolveCategory } from './categories.mjs';
import { canonicalJson, deepEqualCanonical } from './canonical.mjs';
import { createByteAccumulator } from './budgets.mjs';
import { createCursorStore, paginateCategories, paginateNames, projectState } from './list.mjs';
import { createRefStore } from './candidate-refs.mjs';
import { DomainError, toDomainError } from './errors.mjs';
import { ENTRY_TOOL_NAMES, PROTOCOL_VERSION } from './constants.mjs';
import { assertSkillBudget, projectSkill } from './skills.mjs';
import { assertActiveBudget } from './budgets.mjs';
import {
  errorEnvelope, okEnvelope, validateListRequest, validateLoadRequest, validateSearchRequest,
} from './protocol.mjs';
import { buildSearchIndex, search as runSearch } from './search.mjs';
import {
  createState, evaluateCall as evalCall, invalidateTool, recordAdvertisement, reducePair,
} from './state.mjs';
import { clampCodePoints, createMutex, isNonEmptyString, isPlainObject } from './util.mjs';

const MAX_SUMMARY_CODE_POINTS = 96;

/**
 * @param {any} config
 * @returns {import('./index.mjs').DiscoveryEngine}
 */
export function createDiscoveryEngine(config) {
  if (!isPlainObject(config)) throw new DomainError('INCOMPATIBLE_COMPOSITION', 'engine config 必须是对象。');
  if ((config.protocolVersion ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', '协议版本不受支持。');
  }
  if (config.capabilityKind && config.capabilityKind !== 'native') {
    throw new DomainError('INCOMPATIBLE_PRESENTATION');
  }
  if (!isPlainObject(config.categoryConfig)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'categoryConfig 必填(可信配置)。');
  }
  if (!isPlainObject(config.clock) || typeof config.clock.now !== 'function') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'clock 必填。');
  }
  if (!isPlainObject(config.random) || typeof config.random.bytes !== 'function') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', 'random 必填。');
  }

  const budgets = resolveBudgets(config.budgets);
  const entryNames = new Set([...ENTRY_TOOL_NAMES, ...(config.entryToolNames || [])]);
  const frameworkNames = new Set(config.frameworkToolNames || []);
  /**
   * 常驻工具（alwaysVisible）：DSH 自带工具等。它们无需 load 即视为已激活，
   * 因此既不可被 unload，也不需要经 canonical 回执进入 selected —— 它们本来
   * 就在每一轮请求里。过滤只针对名单之外的后装工具。
   */
  const alwaysNames = new Set(config.alwaysToolNames || []);
  /** 入口与框架保留项不可 load/unload —— 来自可信配置,不按名称猜。 */
  const protectedNames = new Set([...entryNames, ...frameworkNames, ...alwaysNames]);
  /** @type {Map<string, string>} name → toolId(受保护项,如可解析) */
  const newSessionMode = config.newSessionMode === 'restoring' ? 'restoring' : 'ready';

  const clock = config.clock;
  const refStore = createRefStore({ clock, random: config.random, ttlMs: budgets.candidateTtlMs });
  const cursorStore = createCursorStore({ clock, random: config.random, ttlMs: budgets.listCursorTtlMs });

  let catalog = buildCatalog(config.bindings || [], {
    now: clock.now(),
    generation: config.generation || 'g0',
  });
  let index = buildSearchIndex(Array.from(catalog.entries.values()));
  let eligibilityGeneration = 1;

  /** @type {Map<string, import('./state.mjs').SessionDiscoveryState>} */
  const sessions = new Map();
  /** @type {Map<string, ReturnType<typeof createMutex>>} */
  const locks = new Map();
  /** @type {Map<string, any>} operationId → pending */
  const pending = new Map();
  let opCounter = 0;
  let disposed = false;

  /**
   * @param {any} scope
   * @returns {import('./state.mjs').SessionDiscoveryState}
   */
  function requireState(scope) {
    if (!isPlainObject(scope) || !isNonEmptyString(scope.sessionId)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', '缺少会话身份(必须由宿主传入)。');
    }
    let st = sessions.get(scope.sessionId);
    if (!st) {
      st = createState(scope.sessionId);
      if (newSessionMode === 'ready') st.mode = 'ready';
      sessions.set(scope.sessionId, st);
      locks.set(scope.sessionId, createMutex());
    }
    return st;
  }

  function requireReady(scope) {
    const st = requireState(scope);
    if (st.mode !== 'ready') throw new DomainError('STATE_NOT_READY');
    return st;
  }

  function lockFor(sessionId) {
    let l = locks.get(sessionId);
    if (!l) {
      l = createMutex();
      locks.set(sessionId, l);
    }
    return l;
  }

  /**
   * 当前 catalog 内受保护项的 toolId。**按当前 catalog 动态解析**，
   * 不做创建期快照(D2)：refreshCatalog 换绑定后新 toolId 必须同样被保护。
   * @returns {Set<string>}
   */
  function protectedToolIdsNow() {
    return new Set(
      Array.from(catalog.entries.values())
        .filter((e) => protectedNames.has(e.name))
        .map((e) => e.toolId),
    );
  }

  /**
   * @param {string} tool
   * @param {string} operation
   * @param {unknown} raw
   * @param {any} scope
   */
  function failEnvelope(tool, operation, raw, scope) {
    try {
      void scope;
      throw raw;
    } catch (e) {
      return errorEnvelope(tool, operation, toDomainError(e));
    }
  }

  return {
    // ---- 只读视图 -------------------------------------------------------
    getCatalog() {
      return catalog;
    },
    getEligibilityGeneration() {
      return eligibilityGeneration;
    },
    getState(scope) {
      return requireState(scope);
    },
    getBudgets() {
      return budgets;
    },

    // ---- tool_list ------------------------------------------------------
    /**
     * @param {unknown} raw
     * @param {any} scope
     */
    handleList(raw, scope) {
      try {
        requireReady(scope);
        const req = validateListRequest(raw, budgets);
        const st = requireState(scope);

        if (req.view === 'state') {
          const activeEntries = Array.from(st.selected.values())
            .map((s) => resolveByToolId(catalog, s.toolId))
            .filter(Boolean);
          return okEnvelope('tool_list', 'list', projectState(st, budgets, activeEntries), '状态视图不含隐藏目录。');
        }

        if (req.view === 'categories') {
          const cards = buildCategoryCards(catalog, config.categoryConfig, {
            limit: budgets.maxInitialCategories,
          });
          const orderDigest = catalog.orderDigestByView.get('categories:all') || 'empty';
          const page = paginateCategories({
            allCards: cards,
            cursorStore,
            sessionId: scope.sessionId,
            view: 'categories',
            category: 'all',
            eligibilityGeneration,
            orderDigest,
            limit: req.limit,
            budgets,
            now: clock.now(),
            cursor: req.cursor,
          });
          return okEnvelope('tool_list', 'list', {
            view: 'categories',
            categories: page.categories,
            nextCursor: page.nextCursor,
            truncated: page.truncated,
          }, '用 tool_search 在相关类别检索。');
        }

        const category = resolveCategory(/** @type {string} */ (req.category), catalog, config.categoryConfig);

        if (req.view === 'loaded') {
          // 只列当前 category 中**有效** selected(仍解析得到且未被撤权/失效)的名称
          const names = Array.from(st.selected.values())
            .map((s) => {
              const e = resolveByToolId(catalog, s.toolId);
              if (!e || e.revision !== s.revision) return null; // 已失效
              if (category !== 'all' && !e.categories.includes(category)) return null;
              return e.name;
            })
            .filter((n) => n !== null)
            .sort();
          return okEnvelope('tool_list', 'list', {
            category, view: 'loaded', names, nextCursor: null, truncated: false,
          }, 'loaded 表示有效 selected,不表示当前请求已披露。');
        }

        // available:只返回完整原生名称,不附描述/revision/schema/skill
        const ids = category === 'all'
          ? Array.from(catalog.entries.keys()).sort()
          : (catalog.categories.get(category) || []);
        const seen = new Set();
        /** @type {string[]} */
        const allNames = [];
        for (const id of ids) {
          const e = resolveByToolId(catalog, id);
          if (!e || seen.has(e.name)) continue;
          seen.add(e.name);
          allNames.push(e.name);
        }
        allNames.sort();
        const orderDigest = catalog.orderDigestByView.get(`available:${category}`) || 'empty';
        const page = paginateNames({
          allNames,
          cursorStore,
          sessionId: scope.sessionId,
          view: 'available',
          category,
          eligibilityGeneration,
          orderDigest,
          limit: req.limit,
          budgets,
          now: clock.now(),
          cursor: req.cursor,
        });
        return okEnvelope('tool_list', 'list', {
          category,
          view: 'available',
          names: page.names,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
        }, '知道用途后按精确名称调用 tool_load;不确定时调用 tool_search。');
      } catch (e) {
        return failEnvelope('tool_list', 'list', e, scope);
      }
    },

    // ---- tool_search ----------------------------------------------------
    /**
     * @param {unknown} raw
     * @param {any} scope
     */
    handleSearch(raw, scope) {
      try {
        requireReady(scope);
        const req = validateSearchRequest(raw, budgets);
        const category = resolveCategory(req.category, catalog, config.categoryConfig);
        const st = requireState(scope);

        const hits = runSearch(index, { query: req.query, category, limit: req.limit });
        // 自然无关 → 零命中,ok=true,不凑 K
        if (hits.length === 0) {
          return okEnvelope('tool_search', 'search', {
            catalogGeneration: catalog.generation,
            category,
            candidates: [],
            truncated: false,
          }, '改写 query 或用 tool_list 浏览名称。');
        }

        const acc = createByteAccumulator(budgets.maxSearchResultBytes);
        /** @type {any[]} */
        const candidates = [];
        let truncated = false;
        for (const hit of hits) {
          const ref = refStore.issue(scope.sessionId, eligibilityGeneration, hit.entry.toolId, hit.entry.revision);
          const sel = st.selected.get(hit.entry.toolId);
          const card = {
            toolId: hit.entry.toolId,
            ref,
            revision: hit.entry.revision,
            name: hit.entry.name,
            categories: hit.entry.categories,
            summary: clampCodePoints(hit.entry.summary, MAX_SUMMARY_CODE_POINTS),
            matchReasons: hit.reasons,
            loaded: alwaysNames.has(hit.entry.name) || Boolean(sel && sel.revision === hit.entry.revision),
          };
          if (!acc.tryAdd(JSON.stringify(card))) {
            truncated = true;
            break;
          }
          candidates.push(card);
        }
        if (candidates.length === 0) {
          throw new DomainError('BUDGET_EXCEEDED', '单个候选卡片超过结果字节预算。');
        }
        return okEnvelope('tool_search', 'search', {
          catalogGeneration: catalog.generation,
          category,
          candidates,
          truncated,
        }, '选定候选后,用 ref 与 revision 调用 tool_load。');
      } catch (e) {
        return failEnvelope('tool_search', 'search', e, scope);
      }
    },

    // ---- tool_load ------------------------------------------------------
    /**
     * @param {unknown} raw
     * @param {any} scope
     * @param {{operationId:string}} ctx operationId 必须由宿主产生
     */
    async handleLoad(raw, scope, ctx) {
      const requestedAction = isPlainObject(raw) && raw.action === 'unload' ? 'unload' : 'load';
      /** @param {any} req @param {any} st */
      const runLocked = (req, st) => {
        try {
          return req.action === 'unload'
            ? this.runUnload(req, st, scope, ctx, raw)
            : this.handleLoadLocked(req, st, scope, ctx, raw);
        } catch (e) {
          return { response: errorEnvelope('tool_load', requestedAction, toDomainError(e)), operation: null };
        }
      };

      /** @type {any} */
      let req;
      try {
        requireReady(scope);
        req = validateLoadRequest(raw, budgets);
      } catch (e) {
        return { response: errorEnvelope('tool_load', requestedAction, toDomainError(e)), operation: null };
      }
      if (!isPlainObject(ctx) || !isNonEmptyString(ctx.operationId)) {
        return {
          response: errorEnvelope('tool_load', requestedAction, new DomainError('INCOMPATIBLE_COMPOSITION', 'operationId 必须由宿主提供。')),
          operation: null,
        };
      }
      const st = requireState(scope);
      // load/unload 对同一会话串行(FIFO)
      return lockFor(scope.sessionId).run(() => runLocked(req, st));
    },

    /**
     * 内部:load/unload 的事务实现(在锁内同步执行,便于单测与可重入)。
     * @param {any} req
     * @param {any} st
     * @param {any} scope
     * @param {{operationId:string}} ctx
     * @param {unknown} raw
     */
    handleLoadLocked(req, st, scope, ctx, raw) {
      const operation = req.action === 'load' ? 'load' : 'unload';
      if (req.action === 'unload') return this.runUnload(req, st, scope, ctx, raw);

      /** @type {Array<{entry:any, source:'candidate'|'name'}>} */
      const resolved = [];
      /** @type {Map<string,string>} toolId → revision */
      const byToolId = new Map();
      /** @type {string[]} */
      const namesPath = [];

      for (const item of /** @type {any[]} */ (req.candidates ?? [])) {
        const rec = refStore.resolve(item.ref, scope.sessionId, eligibilityGeneration, clock.now());
        const entry = resolveByToolId(catalog, rec.toolId);
        if (!entry) throw new DomainError('CANDIDATE_UNAVAILABLE');
        if (entry.revision !== item.revision) throw new DomainError('STALE_CANDIDATE');
        // D1:候选路径与 names 路径对称 —— 入口/框架保留项一律不可 load。
        if (protectedNames.has(entry.name)) {
          throw new DomainError('INVALID_ARGS', '入口与框架保留项不可被加载。');
        }
        if (byToolId.has(entry.toolId) && byToolId.get(entry.toolId) !== item.revision) {
          throw new DomainError('INVALID_ARGS', '同一工具的候选 revision 冲突。');
        }
        if (byToolId.has(entry.toolId)) continue;
        byToolId.set(entry.toolId, item.revision);
        resolved.push({ entry, source: 'candidate' });
      }

      for (const name of /** @type {string[]} */ (req.names ?? [])) {
        namesPath.push(name);
        if (protectedNames.has(name)) {
          throw new DomainError('INVALID_ARGS', '入口与框架保留项不可被加载。');
        }
        const entry = resolveByName(catalog, name);
        if (!entry) throw new DomainError('TOOL_UNAVAILABLE');
        if (byToolId.has(entry.toolId)) continue;
        byToolId.set(entry.toolId, entry.revision);
        resolved.push({ entry, source: 'name' });
      }

      if (resolved.length === 0) throw new DomainError('INVALID_ARGS', '没有可加载的项。');

      // 锁定本次验证快照(含资格代次)
      const genAtStart = eligibilityGeneration;
      const snapshot = resolved.map((r) => ({
        toolId: r.entry.toolId,
        revision: r.entry.revision,
        schemaDigest: r.entry.schemaDigest,
      }));

      // 幂等:已以同版本选中 → 不重复计费
      const fresh = resolved.filter((r) => {
        const sel = st.selected.get(r.entry.toolId);
        return !(sel && sel.revision === r.entry.revision);
      });
      const alreadyActive = Array.from(st.selected.values())
        .map((s) => resolveByToolId(catalog, s.toolId))
        .filter(Boolean);

      assertActiveBudget(fresh.map((r) => r.entry), alreadyActive, budgets);
      const skills = resolved.map((r) => projectSkill(r.entry));
      assertSkillBudget(skills, budgets.maxSkillBytesPerLoad);

      // 提交前 recheck:资格代次 + 每项 revision 重算。变化则整批失败,绝不偷偷改选。
      if (eligibilityGeneration !== genAtStart) {
        throw new DomainError('SELECTION_CHANGED');
      }
      for (const snap of snapshot) {
        const cur = resolveByToolId(catalog, snap.toolId);
        if (!cur) throw new DomainError('SELECTION_CHANGED');
        if (cur.revision !== snap.revision || cur.schemaDigest !== snap.schemaDigest) {
          throw new DomainError('SELECTION_CHANGED');
        }
      }

      const selectionSource = /** @type {'candidate'|'name'} */ (req.candidates ? 'candidate' : 'name');
      const receipt = {
        kind: 'tool-discovery.selection',
        version: PROTOCOL_VERSION,
        operationId: ctx.operationId,
        operation: 'load',
        selectionSource,
        selected: snapshot.map((s) => {
          const e = /** @type {any} */ (resolveByToolId(catalog, s.toolId));
          return {
            toolId: s.toolId,
            name: e.name,
            revision: s.revision,
            schemaDigest: s.schemaDigest,
            skillRevision: e.skillRevision,
          };
        }),
      };

      const response = okEnvelope('tool_load', 'load', {
        receipt,
        skills: skills.filter(Boolean),
        takesEffect: 'next_request',
        schemaDelivery: 'native_tools_only',
      }, '下一轮看到工具 schema 后,再调用原工具。');

      const op = {
        operationId: ctx.operationId,
        action: /** @type {const} */ ('load'),
        selectionSource,
        input: raw,
        expectedReceipt: receipt,
      };
      pending.set(ctx.operationId, op);
      return { response, operation: op };
    },

    /**
     * @param {any} req @param {any} st @param {any} scope @param {{operationId:string}} ctx @param {unknown} raw
     */
    runUnload(req, st, scope, ctx, raw) {
      const toolIds = /** @type {string[]} */ (req.toolIds);
      for (const id of toolIds) {
        if (protectedToolIdsNow().has(id) || protectedNames.has(resolveByToolId(catalog, id)?.name ?? '')) {
          throw new DomainError('INVALID_ARGS', '入口与框架保留项不可被卸载。');
        }
      }
      // 未激活 ID 幂等 no-op;不推断其它 scope 是否存在
      const deselected = toolIds.filter((id) => st.selected.has(id));
      const receipt = {
        kind: 'tool-discovery.selection',
        version: PROTOCOL_VERSION,
        operationId: ctx.operationId,
        operation: 'unload',
        deselected,
      };
      const response = okEnvelope('tool_load', 'unload', {
        receipt,
        takesEffect: 'next_request',
      }, '下一轮请求将移除这些工具。');
      const op = {
        operationId: ctx.operationId,
        action: /** @type {const} */ ('unload'),
        selectionSource: /** @type {const} */ ('name'),
        input: raw,
        expectedReceipt: receipt,
      };
      pending.set(ctx.operationId, op);
      return { response, operation: op };
    },

    // ---- canonical 折叠 --------------------------------------------------
    /**
     * 只在 adapter 确认 canonical tool/call → tool/result 对时调用。
     * @param {any} pair
     * @param {any} scope
     */
    applyCanonicalPair(pair, scope) {
      if (disposed) return { applied: false, reason: 'engine-disposed' };
      let st;
      try {
        st = requireState(scope);
      } catch (e) {
        return { applied: false, reason: toDomainError(e).code };
      }
      const op = pending.get(pair?.call?.operationId);
      if (op) {
        // 热态:回执必须与登记的期望回执逐字一致(renderer/pruner 改写 → 拒)
        if (!deepEqualCanonical(op.expectedReceipt, pair?.result?.payload)) {
          pending.delete(pair.call.operationId);
          const next = reducePair(st, { ...pair, result: { ...pair.result, rewrittenBy: 'receipt-mismatch' } }, {
            now: () => clock.now(), catalog,
          });
          sessions.set(scope.sessionId, next.state);
          return { applied: false, reason: 'receipt-mismatch' };
        }
        pending.delete(pair.call.operationId);
      }
      const resolver = {
        now: () => clock.now(),
        catalog,
        protectedToolIds: protectedToolIdsNow(),
        protectedNames,
        resolveRef: (ref) => {
          try {
            const rec = refStore.resolve(ref, scope.sessionId, eligibilityGeneration, clock.now());
            return { toolId: rec.toolId, revision: rec.revision };
          } catch {
            return null;
          }
        },
      };
      const out = reducePair(st, pair, resolver);
      sessions.set(scope.sessionId, out.state);
      return { applied: out.applied, reason: out.reason };
    },

    /** 取消 / 失败 / post-policy 失败:丢弃 pending,selected 不动。 */
    cancelOperation(operationId) {
      return pending.delete(operationId);
    },

    // ---- 曝光 / guard ---------------------------------------------------
    /**
     * @param {any} scope
     * @param {{requestId:string, toolId:string, name:string, revision:string, schemaDigest:string}} rec
     */
    recordAdvertisement(scope, rec) {
      const st = requireState(scope);
      const next = recordAdvertisement(st, { ...rec, now: clock.now() });
      sessions.set(scope.sessionId, next);
    },

    /**
     * @param {any} scope
     * @param {any} call
     */
    evaluateCall(scope, call) {
      if (disposed) {
        return { allowed: false, code: 'TOOL_NOT_LOADED', reason: '引擎已释放。', visibility: 'hidden' };
      }
      const st = requireState(scope);
      const isEntryOrFramework = protectedNames.has(call.name);
      return evalCall(st, {
        name: call.name,
        toolId: call.toolId,
        requestId: call.requestId,
        now: clock.now(),
        registeredInScope: call.registeredInScope ?? null,
        isEntryOrFramework,
      });
    },

    // ---- 失效 -----------------------------------------------------------
    /**
     * 撤权 / 同名替换 / schema 变化:作废 selected + advertised,升资格代次。
     * @param {string} toolId
     * @param {string} reason
     */
    invalidate(toolId, reason) {
      for (const [sid, st] of sessions) {
        sessions.set(sid, invalidateTool(st, toolId, reason, clock.now()));
      }
    },

    /**
     * 目录刷新:重建不可变快照,升代次,旧 ref/cursor 全部失效,失效不再匹配的选择。
     * @param {any[]} bindings
     */
    refreshCatalog(bindings) {
      const nextCatalog = buildCatalog(bindings, {
        now: clock.now(),
        generation: `g${Date.now().toString(36)}`,
      });
      const nextIndex = buildSearchIndex(Array.from(nextCatalog.entries.values()));
      catalog = nextCatalog;
      index = nextIndex;
      eligibilityGeneration += 1;
      refStore.dropForEligibility(eligibilityGeneration);

      for (const [sid, st] of sessions) {
        let cur = st;
        for (const [toolId, sel] of st.selected) {
          const e = nextCatalog.entries.get(toolId);
          const gone = !e;
          const changed = Boolean(e) && (e.revision !== sel.revision || e.name !== sel.name);
          if (gone || changed) cur = invalidateTool(cur, toolId, gone ? 'tool-removed' : 'definition-changed', clock.now());
        }
        sessions.set(sid, cur);
      }
      return { eligibilityGeneration };
    },

    // ---- 恢复 -----------------------------------------------------------
    /**
     * 冷恢复:按 seq 折叠 canonical 对,与当前资格取交集;**只证明 wire 合同**。
     * @param {any[]} pairs
     * @param {any} scope
     */
    restore(pairs, scope) {
      if (disposed) return { mode: 'incompatible', applied: 0, rejected: 0 };
      let st;
      try {
        st = requireState(scope);
      } catch (e) {
        return { mode: 'incompatible', applied: 0, rejected: 0, error: toDomainError(e).code };
      }
      if (!Array.isArray(pairs)) {
        st.mode = 'incompatible';
        sessions.set(scope.sessionId, st);
        return { mode: 'incompatible', applied: 0, rejected: 0 };
      }
      const sorted = pairs
        .filter((p) => isPlainObject(p) && typeof p.seq === 'number')
        .sort((a, b) => a.seq - b.seq);
      // 按 seq 去重(同 seq 只折叠第一次)
      /** @type {Set<number>} */
      const seenSeq = new Set();
      const deduped = sorted.filter((p) => {
        if (seenSeq.has(p.seq)) return false;
        seenSeq.add(p.seq);
        return true;
      });

      let applied = 0;
      let rejected = 0;
      let cur = st;
      for (const p of deduped) {
        const out = reducePair(cur, p, { now: () => clock.now(), catalog, protectedToolIds: protectedToolIdsNow(), protectedNames, resolveRef: undefined });
        cur = out.state;
        if (out.applied) applied += 1;
        else rejected += 1;
      }
      // 与当前资格取交集:不再解析的定义作废
      for (const [toolId, sel] of cur.selected) {
        const e = catalog.entries.get(toolId);
        if (!e || e.revision !== sel.revision) cur = invalidateTool(cur, toolId, 'not-eligible-after-restore', clock.now());
      }
      cur.mode = 'ready';
      sessions.set(scope.sessionId, cur);
      return { mode: 'ready', applied, rejected, coldCandidateRestores: cur.integrity.coldCandidateRestores };
    },

    /**
     * 恢复完成(全新会话无 journal 时直接 ready)。
     * @param {any} scope
     */
    ready(scope) {
      const st = requireState(scope);
      if (st.mode === 'restoring') st.mode = 'ready';
      sessions.set(scope.sessionId, st);
    },

    /** 不可信恢复 → fail closed,保持不可执行。 */
    failClosed(scope) {
      const st = requireState(scope);
      st.mode = 'incompatible';
      sessions.set(scope.sessionId, st);
    },

    /** 销毁会话(会话销毁 / HMR):注销缓存引用,不影响历史日志。 */
    destroySession(sessionId) {
      sessions.delete(sessionId);
      locks.delete(sessionId);
    },

    dispose() {
      disposed = true;
      refStore.clear();
      cursorStore.clear();
      pending.clear();
      sessions.clear();
      locks.clear();
    },

    // 供测试 / adapter 观察
    getPendingSize: () => pending.size,
  };
}
