// plugin/domain/engine.mjs
// 会话内核（rc.1 重设计，docs/14-rc1-redesign.md）。
//
// 与旧版的不同：没有 pending 操作、canonical 回执折叠、冻结 wire、epoch 与
// advertised 账本。tool_load 校验通过后**立即**写入 selected（admission 由
// adapter 的 store 持久化，掩码与执行门禁各自消费同一份事实）；tool_unload
// 是公开的第四入口；resume 由 seedSelection 按名字+schemaDigest 回填。
//
// 保留：目录构建与刷新（身份指纹快路径）、eligibility 代次与候选 ref、
// 分页游标、预算核算、技能交付、本地化文案、输入形状判定一套口径。
import { AUTO_LOCALE } from './host-locale.mjs';
import { ENTRY_TOOL_NAMES, PROTOCOL_VERSION } from './constants.mjs';
import {
  buildCatalog, catalogFromPrepared, prepareCatalog, orderedNamesFor, resolveByName,
} from './catalog.mjs';
import { DomainError, toDomainError } from './errors.mjs';
import { digestOf } from './canonical.mjs';
import {
  resolveBudgets, assertActiveBudget, fitPrefixLength,
} from './budgets.mjs';
import { clampCodePoints, createMutex, isNonEmptyString, isPlainObject } from './util.mjs';
import { buildCategoryCards, resolveCategory } from './categories.mjs';
import { buildSearchIndex, search as runSearch } from './search.mjs';
import { createRefStore } from './candidate-refs.mjs';
import { createCursorStore, paginateNames, paginateCategories, projectState, fitStateWithinBudget } from './list.mjs';
import { projectSkill, assertSkillBudget } from './skills.mjs';
import {
  validateListRequest, validateSearchRequest, validateLoadRequest, validateUnloadRequest,
  okEnvelope, errorEnvelope,
} from './protocol.mjs';
import { createText, domainText } from './locale.mjs';
import { createState, invalidateTool, removeSelection } from './state.mjs';

const MAX_SUMMARY_CODE_POINTS = 96;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
// 候选 ref 的定长形状:与 candidate-refs.mjs 的 mintOpaqueId(random, 'c_') 一致。
const REF_BYTE_LENGTH = 16;
const REF_PLACEHOLDER = `c_${'0'.repeat(REF_BYTE_LENGTH * 2)}`;

export function createDiscoveryEngine(config) {
  if (!isPlainObject(config)) throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'engineConfigNotObject']));
  if ((config.protocolVersion ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'protocolVersionUnsupported']));
  }
  if (config.capabilityKind && config.capabilityKind !== 'native') {
    throw new DomainError('INCOMPATIBLE_PRESENTATION');
  }
  if (!isPlainObject(config.categoryConfig)) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'categoryConfigRequired']));
  }
  if (!isPlainObject(config.clock) || typeof config.clock.now !== 'function') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'clockRequired']));
  }
  if (!isPlainObject(config.random) || typeof config.random.bytes !== 'function') {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'randomRequired']));
  }

  // 以下三项是 volatile 配置的运行中镜像：设置页可以在不重挂载插件的前提下改写它们，
  // adapter 通过下方 setter 同步（见 setBudgets / setTolerantLoadProtected /
  // setCategoryConfig）。构造期仍走 config 快照。
  let budgets = resolveBudgets(config.budgets);
  const entryNames = new Set([...ENTRY_TOOL_NAMES, ...(config.entryToolNames || [])]);
  const frameworkNames = new Set(config.frameworkToolNames || []);
  /**
   * 常驻工具（alwaysVisible）：每轮都在声明里，无需 load 即视为已激活，
   * 既不可 load 也不可 unload。
   */
  const alwaysNames = new Set(config.alwaysToolNames || []);
  /** 是否容错放正常驻工具的重复加载（默认开启以解除死锁冲突） */
  let tolerantLoadProtected = config.tolerantLoadProtected !== false;
  const strictProtectedNames = new Set([...entryNames, ...frameworkNames]);
  let categoryConfig = config.categoryConfig;

  const explicitLocale = config.locale === undefined || config.locale === AUTO_LOCALE ? undefined : config.locale;
  const text = explicitLocale === undefined ? domainText : createText(explicitLocale);
  const t = (path) => text.t(path);
  const listEnvelope = (data, nextKey) => okEnvelope('tool_list', 'list', data, text.t(['nextAction', nextKey]));
  const measureListPage = (view, category, nextKey) => (page) => jsonBytes(listEnvelope(
    view === 'categories'
      ? { view, categories: page.pageItems, nextCursor: page.nextCursor, truncated: page.truncated }
      : { category, view, names: page.pageItems, nextCursor: page.nextCursor, truncated: page.truncated }, nextKey,
  ));

  const clock = config.clock;
  const refStore = createRefStore({ clock, random: config.random, ttlMs: budgets.candidateTtlMs });
  const cursorStore = createCursorStore({ clock, random: config.random, ttlMs: budgets.listCursorTtlMs });

  let catalog = buildCatalog(config.bindings || [], {
    now: clock.now(),
    generation: config.generation || 'g0',
  });
  let index = buildSearchIndex(Array.from(catalog.entries.values()));
  let eligibilityGeneration = 1;

  /** @type {Map<string, ReturnType<typeof createState>>} */
  const sessions = new Map();
  /** @type {Map<string, ReturnType<typeof createMutex>>} */
  const locks = new Map();
  let disposed = false;

  function requireState(scope) {
    if (disposed) {
      throw new DomainError('ENGINE_DISPOSED', undefined, undefined, explicitLocale);
    }
    if (!isPlainObject(scope) || !isNonEmptyString(scope.sessionId)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'missingSessionIdentity']), undefined, explicitLocale);
    }
    let st = sessions.get(scope.sessionId);
    if (!st) {
      st = createState(scope.sessionId);
      sessions.set(scope.sessionId, st);
      // 不能覆盖既有锁：handleLoad/handleUnload 已先 lockFor 取得 L1 并在其上
      // 排队；此处重建 L2 会让 L1 上的排队者在取到锁后发现锁已换而被拒。
      if (!locks.has(scope.sessionId)) {
        locks.set(scope.sessionId, createMutex());
      }
    }
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
   * 活跃 schema 占用面 = 本会话有效 selected（仍解析得到且版本一致）。
   * admission 与 selected 由 adapter 保持一致：selected 之外的工具不占配额。
   */
  function activeFootprint(st) {
    const active = [];
    for (const [toolId, selection] of st.selected) {
      if (alwaysNames.has(selection.name)) continue;
      const entry = resolveByToolIdSafe(toolId);
      if (!entry || entry.revision !== selection.revision) continue;
      active.push({ wireBytes: entry.wireBytes });
    }
    return active;
  }

  const resolveByToolIdSafe = (toolId) => catalog.entries.get(toolId) ?? null;

  function failEnvelope(tool, operation, raw) {
    return errorEnvelope(tool, operation, toDomainError(raw, explicitLocale));
  }

  const api = {
    getCatalog() { return catalog; },
    getEligibilityGeneration() { return eligibilityGeneration; },
    getState(scope) { return requireState(scope); },
    getBudgets() { return budgets; },
    /** adapter 读侧：某会话已选条目（Map 引用，只读使用）。 */
    selectedOf(sessionId) { return sessions.get(sessionId)?.selected ?? new Map(); },

    // ---- tool_list ----------------------------------------------------
    handleList(raw, scope) {
      try {
        const st = requireState(scope);
        const req = validateListRequest(raw, budgets);

        if (req.view === 'state') {
          const active = activeFootprint(st);
          const payload = projectState(st, budgets, active);
          const maxBytes = budgets.maxListResultBytes;
          const fitted = fitStateWithinBudget(payload, maxBytes,
            (data) => jsonBytes(listEnvelope(data, 'stateViewNoHidden')));
          if (fitted === null) {
            const bytes = jsonBytes(listEnvelope(payload, 'stateViewNoHidden'));
            throw new DomainError(
              'BUDGET_EXCEEDED',
              text.format(['detail', 'bytesOverBudget'], { what: `state view (${bytes} bytes > ${maxBytes})` }),
              { bytes, maxBytes },
              explicitLocale,
            );
          }
          return okEnvelope('tool_list', 'list', fitted, text.t(['nextAction', 'stateViewNoHidden']));
        }

        if (req.view === 'categories') {
          const cards = buildCategoryCards(catalog, categoryConfig);
          const orderDigest = catalog.orderDigestByView.get('categories:all') || 'empty';
          const page = paginateCategories({
            allCards: cards,
            measurePage: measureListPage('categories', undefined, 'searchInCategory'),
            cursorStore,
            sessionId: scope.sessionId,
            view: 'categories',
            category: 'all',
            eligibilityGeneration,
            orderDigest,
            limit: Math.min(req.limit, budgets.maxInitialCategories),
            budgets,
            now: clock.now(),
            cursor: req.cursor,
          });
          return okEnvelope('tool_list', 'list', {
            view: 'categories',
            categories: page.categories,
            nextCursor: page.nextCursor,
            truncated: page.truncated,
          }, text.t(['nextAction', 'searchInCategory']));
        }

        const category = resolveCategory(/** @type {string} */ (req.category), catalog, categoryConfig);

        if (req.view === 'loaded') {
          const allNames = Array.from(st.selected.values())
            .map((s) => {
              const e = catalog.entries.get(s.toolId);
              if (!e || e.revision !== s.revision) return null;
              if (category !== 'all' && !e.categories.includes(category)) return null;
              return e.name;
            })
            .filter((n) => n !== null)
            .sort();
          const page = paginateNames({
            allNames,
            measurePage: measureListPage('loaded', category, 'loadedMeansSelected'),
            cursorStore,
            sessionId: scope.sessionId,
            view: 'loaded',
            category,
            eligibilityGeneration,
            orderDigest: digestOf(allNames),
            limit: req.limit,
            budgets,
            now: clock.now(),
            cursor: req.cursor,
          });
          return okEnvelope('tool_list', 'list', {
            category, view: 'loaded', names: page.names, nextCursor: page.nextCursor, truncated: page.truncated,
          }, text.t(['nextAction', 'loadedMeansSelected']));
        }

        const allNames = orderedNamesFor(catalog, category);
        const orderDigest = catalog.orderDigestByView.get(`available:${category}`) || 'empty';
        const page = paginateNames({
          allNames,
          measurePage: measureListPage('available', category, 'searchAfterList'),
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
        }, text.t(['nextAction', 'searchAfterList']));
      } catch (e) {
        return failEnvelope('tool_list', 'list', e);
      }
    },

    // ---- tool_search --------------------------------------------------
    handleSearch(raw, scope) {
      try {
        const st = requireState(scope);
        const req = validateSearchRequest(raw, budgets);
        const category = resolveCategory(req.category, catalog, categoryConfig);

        const hits = runSearch(index, { query: req.query, category, limit: req.limit + 1 });
        const count = Math.min(hits.length, req.limit);
        const cards = [];
        const cardAt = (i) => {
          if (cards[i]) return cards[i];
          const hit = hits[i];
          const sel = st.selected.get(hit.entry.toolId);
          return cards[i] = {
            toolId: hit.entry.toolId,
            ref: REF_PLACEHOLDER,
            revision: hit.entry.revision,
            name: hit.entry.name,
            categories: hit.entry.categories,
            summary: clampCodePoints(hit.entry.summary, MAX_SUMMARY_CODE_POINTS),
            matchReasons: hit.reasons,
            loaded: alwaysNames.has(hit.entry.name) || Boolean(sel && sel.revision === hit.entry.revision),
          };
        };
        const envelopeFor = (candidates, length = candidates.length) => okEnvelope('tool_search', 'search', {
          catalogGeneration: catalog.generation, category, candidates,
          truncated: length < hits.length,
        }, text.t(['nextAction', hits.length === 0 ? 'rewriteOrBrowse' : 'pickCandidateThenLoad']));
        const keep = fitPrefixLength(count, budgets.maxSearchResultBytes,
          (n) => jsonBytes(envelopeFor([], n)), (i) => jsonBytes(cardAt(i)));
        if (keep < 0 || (count > 0 && keep === 0)) {
          throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'candidateCardOverByteBudget']), undefined, explicitLocale);
        }
        const candidates = Array.from({ length: keep }, (_, i) => cardAt(i));
        for (const card of candidates) {
          card.ref = refStore.issue(scope.sessionId, eligibilityGeneration, card.toolId, card.revision);
        }
        return envelopeFor(candidates);
      } catch (e) {
        return failEnvelope('tool_search', 'search', e);
      }
    },

    // ---- tool_load ----------------------------------------------------
    /**
     * 校验 → 预算 → 代次复核 → **立即提交** selected。
     * @returns {{response:object, admitted:Array<{toolId:string,name:string,revision:string,schemaDigest:string}>|null}}
     *   admitted 非 null 时 adapter 必须把它写进 admission store 并更新掩码。
     */
    async handleLoad(raw, scope) {
      const queuedLock = lockFor(scope.sessionId);
      return queuedLock.run(() => {
        try {
          if (disposed) {
            throw new DomainError('ENGINE_DISPOSED', undefined, undefined, explicitLocale);
          }
          if (locks.get(scope.sessionId) !== queuedLock) {
            throw new DomainError('STATE_NOT_READY', undefined, undefined, explicitLocale);
          }
          const st = requireState(scope);
          const req = validateLoadRequest(raw, budgets);
          return api.handleLoadLocked(req, st, scope, raw);
        } catch (e) {
          return { response: errorEnvelope('tool_load', 'load', toDomainError(e, explicitLocale)), admitted: null };
        }
      });
    },

    /**
     * 事务实现（锁内同步）。
     * @returns {{response:object, admitted:Array}|{response:object, admitted:null}}
     */
    handleLoadLocked(req, st, scope, raw) {
      /** @type {Array<{entry:any, source:'candidate'|'name'}>} */
      const resolved = [];
      /** @type {Map<string,string>} toolId → revision */
      const byToolId = new Map();

      for (const item of /** @type {any[]} */ (req.candidates ?? [])) {
        const rec = refStore.resolve(item.ref, scope.sessionId, eligibilityGeneration, clock.now());
        const entry = catalog.entries.get(rec.toolId);
        if (!entry) throw new DomainError('CANDIDATE_UNAVAILABLE', undefined, undefined, explicitLocale);
        const expectedRevision = item.revision ?? rec.revision;
        if (byToolId.has(entry.toolId) && byToolId.get(entry.toolId) !== expectedRevision) {
          throw new DomainError('INVALID_ARGS', t(['detail', 'candidateRevisionConflict']), undefined, explicitLocale);
        }
        if (entry.revision !== expectedRevision) throw new DomainError('STALE_CANDIDATE', undefined, undefined, explicitLocale);
        if (entryNames.has(entry.name) || frameworkNames.has(entry.name)) {
          throw new DomainError('INVALID_ARGS', t(['detail', 'protectedNotLoadable']), undefined, explicitLocale);
        }
        if (alwaysNames.has(entry.name) && !tolerantLoadProtected) {
          throw new DomainError('INVALID_ARGS', t(['detail', 'protectedNotLoadable']), undefined, explicitLocale);
        }
        if (byToolId.has(entry.toolId)) continue;
        byToolId.set(entry.toolId, expectedRevision);
        resolved.push({ entry, source: 'candidate' });
      }

      for (const name of /** @type {string[]} */ (req.names ?? [])) {
        if (entryNames.has(name) || frameworkNames.has(name)) {
          throw new DomainError('INVALID_ARGS', t(['detail', 'protectedNotLoadable']), undefined, explicitLocale);
        }
        if (alwaysNames.has(name) && !tolerantLoadProtected) {
          throw new DomainError('INVALID_ARGS', t(['detail', 'protectedNotLoadable']), undefined, explicitLocale);
        }
        const entry = resolveByName(catalog, name);
        if (!entry) throw new DomainError('TOOL_UNAVAILABLE', undefined, undefined, explicitLocale);
        if (byToolId.has(entry.toolId)) continue;
        byToolId.set(entry.toolId, entry.revision);
        resolved.push({ entry, source: 'name' });
      }

      if (resolved.length === 0) throw new DomainError('INVALID_ARGS', t(['detail', 'nothingToLoad']), undefined, explicitLocale);

      // 锁定资格代次：解析与复核之间目录若被刷新，整批失败。
      const genAtStart = eligibilityGeneration;
      const snapshot = resolved.map((r) => ({
        toolId: r.entry.toolId,
        revision: r.entry.revision,
        schemaDigest: r.entry.schemaDigest,
      }));

      const alreadyActive = activeFootprint(st);
      const fresh = resolved.filter((r) => {
        if (alwaysNames.has(r.entry.name)) return false;
        const sel = st.selected.get(r.entry.toolId);
        if (sel && sel.revision === r.entry.revision) return false;
        return true;
      });
      if (fresh.length > 0) assertActiveBudget(fresh.map((r) => r.entry), alreadyActive, budgets);

      const skills = resolved.filter(({ entry }) => st.selected.get(entry.toolId)?.revision !== entry.revision)
        .map(({ entry }) => projectSkill(entry));
      assertSkillBudget(skills, budgets.maxSkillBytesPerLoad);

      if (eligibilityGeneration !== genAtStart) {
        throw new DomainError('SELECTION_CHANGED', undefined, undefined, explicitLocale);
      }
      const rechecked = new Map();
      for (const snap of snapshot) {
        const cur = catalog.entries.get(snap.toolId);
        if (!cur) throw new DomainError('SELECTION_CHANGED', undefined, undefined, explicitLocale);
        if (cur.revision !== snap.revision || cur.schemaDigest !== snap.schemaDigest) {
          throw new DomainError('SELECTION_CHANGED', undefined, undefined, explicitLocale);
        }
        rechecked.set(snap.toolId, cur);
      }

      // 立即提交：selected 与 admission 是同一事实的两份投影。
      // alwaysVisible 名字在 tolerant 模式下不抛错，但它们是常驻成员、不占
      // admission——只报告为 alreadyResident，不写 selected、不进 admitted。
      const selectionSource = /** @type {'candidate'|'name'} */ (req.candidates !== undefined ? 'candidate' : 'name');
      /** @type {Array<{toolId:string,name:string,revision:string,schemaDigest:string}>} */
      const admitted = [];
      const resident = [];
      for (const snap of snapshot) {
        const entry = /** @type {any} */ (rechecked.get(snap.toolId));
        if (alwaysNames.has(entry.name)) {
          resident.push(entry.name);
          continue;
        }
        const prev = st.selected.get(snap.toolId);
        if (prev && prev.revision === snap.revision) continue;
        st.selected.set(snap.toolId, {
          toolId: snap.toolId,
          name: entry.name,
          revision: snap.revision,
          schemaDigest: snap.schemaDigest,
          skillRevision: entry.skillRevision,
          selectionSource,
          activatedAt: clock.now(),
        });
        st.invalidated.delete(snap.toolId);
        admitted.push({ toolId: snap.toolId, name: entry.name, revision: snap.revision, schemaDigest: snap.schemaDigest });
      }

      const response = okEnvelope('tool_load', 'load', {
        loaded: admitted.map((a) => a.name),
        ...(resident.length > 0 ? { alreadyResident: resident } : {}),
        skills: skills.filter(Boolean),
        takesEffect: 'next_request',
        schemaDelivery: 'native_tools_only',
      }, text.t(['nextAction', 'callNextRequest']));
      return { response, admitted };
    },

    // ---- tool_unload ----------------------------------------------------
    /**
     * 撤销 admitted 条目。只接受 names（admitted 名字，不需要 ref——
     * 模型从 tool_list view:'loaded' 拿到的是名字）。
     * @returns {{response:object, revoked:string[]|null}}
     */
    async handleUnload(raw, scope) {
      const queuedLock = lockFor(scope.sessionId);
      return queuedLock.run(() => {
        try {
          if (disposed) {
            throw new DomainError('ENGINE_DISPOSED', undefined, undefined, explicitLocale);
          }
          if (locks.get(scope.sessionId) !== queuedLock) {
            throw new DomainError('STATE_NOT_READY', undefined, undefined, explicitLocale);
          }
          const st = requireState(scope);
          const req = validateUnloadRequest(raw);
          // 整批事务（全有全无）：保护规则必须先对**整批名字**校验，再执行任何删除。
          // 逐名"边删边校验"会先删掉前面的已选名字再抛错，返回 ok:false / revoked:null，
          // 而 selected 已被删掉一部分 —— adapter 拿不到 revoked 就不会撤销 admission，
          // 随后的单独 unload 该名字又变成空操作，撤销永远到不了 admission store。
          for (const name of req.names) {
            if (strictProtectedNames.has(name) || alwaysNames.has(name)) {
              throw new DomainError('INVALID_ARGS', t(['detail', 'protectedNotLoadable']), undefined, explicitLocale);
            }
          }
          // 未选中的名字保持幂等：不进 revoked，也算成功。
          // name → toolId 反查一次建好（避免 names × selected 的 O(n·m) 嵌套扫）。
          /** @type {Map<string, string>} */
          const toolIdByName = new Map();
          for (const [toolId, sel] of st.selected) toolIdByName.set(sel.name, toolId);
          /** @type {Array<{toolId:string,name:string}>} */
          const matches = [];
          for (const name of req.names) {
            const toolId = toolIdByName.get(name);
            if (toolId !== undefined) matches.push({ toolId, name });
          }
          /** @type {string[]} */
          const revoked = matches.map((m) => m.name);
          for (const { toolId } of matches) removeSelection(st, toolId);
          const response = okEnvelope('tool_unload', 'unload', {
            unloaded: revoked,
            takesEffect: 'next_request',
          }, text.t(['nextAction', 'callNextRequest']));
          return { response, revoked };
        } catch (e) {
          return { response: errorEnvelope('tool_unload', 'unload', toDomainError(e, explicitLocale)), revoked: null };
        }
      });
    },

    /**
     * resume 种子：按名字+schemaDigest 回填 selected。
     * @param {any} scope
     * @param {Array<{name:string,toolId:string,schemaDigest:string,at:number}>} rows
     * @returns {{seeded:string[], dropped:string[]}}
     */
    seedSelection(scope, rows) {
      const st = requireState(scope);
      const seeded = [];
      const dropped = [];
      for (const row of rows ?? []) {
        const entry = resolveByName(catalog, row.name);
        if (!entry || entry.schemaDigest !== row.schemaDigest) {
          dropped.push(row.name);
          continue;
        }
        st.selected.set(entry.toolId, {
          toolId: entry.toolId,
          name: entry.name,
          revision: entry.revision,
          schemaDigest: entry.schemaDigest,
          skillRevision: entry.skillRevision,
          selectionSource: 'resumed',
          activatedAt: row.at ?? clock.now(),
        });
        seeded.push(row.name);
      }
      return { seeded, dropped };
    },

    /**
     * 运行中热改预算（volatile 配置，设置页保存不重挂载插件）。
     * 只更新按次判定用的值；candidateTtlMs/listCursorTtlMs 已在 store 构造时固定，
     * 改 TTL 仍需重载（它们不在这条热改路径上）。
     * @param {any} next
     */
    setBudgets(next) {
      budgets = resolveBudgets(next);
      return budgets;
    },

    /** 运行中热改"容忍重复加载常驻工具"。 */
    setTolerantLoadProtected(next) {
      tolerantLoadProtected = next !== false;
      return tolerantLoadProtected;
    },

    /** 运行中热改类别导航文案（设置页保存不重挂载插件）。 */
    setCategoryConfig(next) {
      if (!isPlainObject(next)) {
        throw new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['detail', 'categoryConfigRequired']));
      }
      categoryConfig = next;
      return categoryConfig;
    },

    setAlwaysVisibleNames(names) {
      const next = names === undefined || names === null ? [] : [...new Set(
        names.filter((name) => typeof name === 'string' && name.length > 0),
      )];
      alwaysNames.clear();
      for (const name of next) alwaysNames.add(name);
      return { alwaysToolNames: [...alwaysNames] };
    },

    /**
     * 撤权 / 同名替换 / schema 变化：作废 selected，升资格代次。
     * @returns {string[]} 受影响会话里被作废的**工具名**（adapter 据此同步撤销 admission）
     */
    invalidate(toolId, reason) {
      eligibilityGeneration += 1;
      refStore.dropForEligibility(eligibilityGeneration);
      cursorStore.clear();
      const now = clock.now();
      const names = [];
      for (const [sid, st] of sessions) {
        const sel = st.selected.get(toolId);
        if (sel) names.push(sel.name);
        sessions.set(sid, invalidateTool(st, toolId, reason, now));
      }
      return names;
    },

    /**
     * 目录刷新：身份指纹一致走快路径；真变了重建 + 升代次 + 作废不匹配项。
     * @returns {{eligibilityGeneration:number, invalidatedNames:string[]}}
     */
    refreshCatalog(bindings) {
      // 校验 + canonical 化只做一遍：指纹判同直接丢 prepared；判异则带着全部
      // 预计算字段构建（wire/parameters 不再二次序列化、分类不再二次推导）。
      let prepared = null;
      let unchanged = false;
      try {
        const result = prepareCatalog(bindings);
        unchanged = result.fingerprint === catalog.identityFingerprint;
        if (!unchanged) prepared = result.prepared;
      } catch {
        unchanged = false;
      }
      if (unchanged) return { eligibilityGeneration, invalidatedNames: [] };

      // prepared === null 说明规范化阶段就抛了：buildCatalog 重跑一遍得到规范错误。
      const nextCatalog = prepared !== null
        ? catalogFromPrepared(prepared, { now: clock.now(), generation: `g${eligibilityGeneration + 1}` })
        : buildCatalog(bindings, { now: clock.now(), generation: `g${eligibilityGeneration + 1}` });
      // 同名 toolId + 同 searchDocumentId 的条目直接复用上一版 doc，不重分词。
      const nextIndex = buildSearchIndex(Array.from(nextCatalog.entries.values()), index);
      catalog = nextCatalog;
      index = nextIndex;
      eligibilityGeneration += 1;
      refStore.dropForEligibility(eligibilityGeneration);
      cursorStore.clear();

      const invalidatedNames = [];
      for (const [sid, st] of sessions) {
        let cur = st;
        for (const [toolId, sel] of st.selected) {
          const e = nextCatalog.entries.get(toolId);
          const gone = !e;
          const changed = Boolean(e) && (e.revision !== sel.revision || e.name !== sel.name);
          if (gone || changed) {
            invalidatedNames.push(sel.name);
            cur = invalidateTool(cur, toolId, gone ? 'tool-removed' : 'definition-changed', clock.now());
          }
        }
        sessions.set(sid, cur);
      }
      return { eligibilityGeneration, invalidatedNames };
    },

    /** 销毁会话：注销 ref/cursor/锁。 */
    destroySession(sessionId) {
      sessions.delete(sessionId);
      locks.delete(sessionId);
      refStore.dropForSession(sessionId);
      cursorStore.dropForSession(sessionId);
    },

    dispose() {
      disposed = true;
      refStore.clear();
      cursorStore.clear();
      sessions.clear();
      locks.clear();
    },
  };
  return api;
}
