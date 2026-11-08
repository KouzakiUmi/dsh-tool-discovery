// 会话准入：同步内存事实 + storageDomain 有序快照；恢复只读本会话。
import { DomainError } from '../../domain/index.mjs';

export const ADMISSION_DOMAIN = 'progressive_tools_admissions';
export const ADMISSION_TABLE = 'admissions';
export const ADMISSION_SCHEMA_VERSION = 1;

function validAdmissionRow(row) {
  return typeof row?.name === 'string' && row.name.length > 0
    && typeof row?.toolId === 'string' && row.toolId.length > 0
    && typeof row?.schemaDigest === 'string' && row.schemaDigest.length > 0;
}

export function createAdmissionSpec({ defineDomain, domainTable, z }) {
  return defineDomain({
    name: ADMISSION_DOMAIN,
    version: ADMISSION_SCHEMA_VERSION,
    layout: 'single',
    tables: { [ADMISSION_TABLE]: domainTable(z.unknown()) },
  });
}

// open 最多尝试两次；不使用后台轮询。close 与在途 open 共用完成屏障。
export function createAdmissionStoreHandle({ facility, defineDomain, domainTable, z, log = () => {} }) {
  let status = 'idle';
  let domain = null;
  let table = null;
  let closing = null;
  let opening = null;
  let attempts = 0;

  async function doOpen() {
    status = 'opening';
    attempts++;
    let opened;
    try {
      opened = await facility.open(createAdmissionSpec({ defineDomain, domainTable, z }));
      table = opened.table(ADMISSION_TABLE);
      domain = opened;
      status = 'open';
      return { ok: true };
    } catch (error) {
      if (opened) { try { await opened.close(); } catch (closeError) { log('admission:store-close-failed', { error: String(closeError) }); } }
      table = null;
      status = 'failed';
      log('admission:store-open-failed', { error: String(error?.message ?? error) });
      return { ok: false, reason: 'open-failed' };
    }
  }

  const handle = {
    get status() { return status; },
    ensureOpen() {
      if (closing !== null) return Promise.resolve({ ok: false, reason: 'closed' });
      if (status === 'open') return Promise.resolve({ ok: true });
      if (opening !== null) return opening;
      if (attempts >= 2) return Promise.resolve({ ok: false, reason: 'open-failed' });
      opening = doOpen().finally(() => { opening = null; });
      return opening;
    },
    get(key) {
      if (status !== 'open' || table === null) throw new Error('admission store is not open');
      return table.get(key);
    },
    async put(record) {
      if (status !== 'open' || table === null) throw new Error('admission store is not open');
      if (typeof record?.sessionId !== 'string' || record.sessionId.length === 0
        || !Array.isArray(record.admissions) || !record.admissions.every(validAdmissionRow)) {
        throw new DomainError('INCOMPATIBLE_COMPOSITION', 'refusing to persist an invalid admission record');
      }
      await table.put(record.sessionId, record);
      return record;
    },
    async remove(key) {
      if (status !== 'open' || table === null) throw new Error('admission store is not open');
      // rc.1 KvTable 的公开方法为 delete；错误交由 tracker 记录并保留 dirty 状态。
      return table.delete(key);
    },
    keys() {
      if (status !== 'open' || table === null) return [];
      return [...table.keys()];
    },
    close() {
      if (closing !== null) return closing;
      closing = (async () => {
        await opening;
        status = 'closed';
        table = null;
        if (domain !== null) {
          const opened = domain;
          domain = null;
          try { await opened.close(); } catch (error) { log('admission:store-close-failed', { error: String(error?.message ?? error) }); }
        }
      })();
      return closing;
    },
  };
  return handle;
}

export function createAdmissionTracker({ log = () => {} } = {}) {
  // inactive 状态仅在有未落盘本地覆盖时保留；公共读侧在 dropSession 后立即为空。
  const sessions = new Map();
  const flushChains = new Map();
  const holder = { store: null };
  let disposed = false;
  let disposing = null;

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { rows: new Map(), touched: new Set(), hydrated: null, active: true, version: 0, saved: 0 };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function hydrate(sessionId, state, store) {
    if (!store || state.hydrated === store) return;
    // get 失败不可标为 hydrated，也不可覆盖坏/未知存储为一个不完整快照。
    const record = store.get(sessionId);
    if (record !== undefined && (record?.sessionId !== sessionId || !Array.isArray(record.admissions))) {
      throw new Error('invalid admission snapshot');
    }
    const rows = new Map();
    for (const row of record?.admissions ?? []) {
      if (validAdmissionRow(row) && !rows.has(row.name)) rows.set(row.name, { ...row });
    }
    // touched 中也包括不存在于 rows 的名字：这是晚 seed 不能复活的撤销墓碑。
    for (const name of state.touched) {
      const row = state.rows.get(name);
      if (row) rows.set(name, row);
      else rows.delete(name);
    }
    state.rows = rows;
    state.hydrated = store;
  }

  function releaseInactive(sessionId, state) {
    if (!state.active && state.saved === state.version && !flushChains.has(sessionId)) sessions.delete(sessionId);
  }

  function flush(sessionId) {
    const store = holder.store;
    const state = sessions.get(sessionId);
    if (!store || !state || state.saved === state.version) return Promise.resolve();
    if (flushChains.has(sessionId)) return flushChains.get(sessionId);
    const chain = (async () => {
      // 一次失败允许一次幂等快照重试；后续 attach/修改/drain 可再尝试 dirty 状态。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const outcome = typeof store.ensureOpen === 'function' ? await store.ensureOpen() : { ok: true };
          if (outcome?.ok !== true) throw new Error(outcome?.reason ?? 'store unavailable');
          if (holder.store !== store) return;
          hydrate(sessionId, state, store);
          while (state.saved !== state.version) {
            const version = state.version;
            const record = { sessionId, updatedAt: Date.now(), admissions: [...state.rows.values()].map(row => ({ ...row })) };
            if (record.admissions.length === 0) await store.remove(sessionId);
            else await store.put(record);
            state.saved = version;
          }
          return;
        } catch (error) {
          log('admission:flush-failed', { sessionId, attempt: attempt + 1, error: String(error?.message ?? error) });
        }
      }
    })().finally(() => {
      flushChains.delete(sessionId);
      releaseInactive(sessionId, state);
    });
    flushChains.set(sessionId, chain);
    return chain;
  }

  async function drain(sessionId) {
    const ids = sessionId === undefined ? [...sessions.keys()] : [sessionId];
    await Promise.allSettled(ids.map(id => flush(id)));
  }

  return {
    holder,
    seedSession(sessionId) {
      if (disposed) return;
      const state = stateFor(sessionId);
      state.active = true;
      if (holder.store?.status === 'open') {
        try { hydrate(sessionId, state, holder.store); }
        catch (error) { log('admission:seed-read-failed', { sessionId, error: String(error?.message ?? error) }); }
      }
    },
    // sessionIds 由 adapter 提供：生产只恢复活动会话，不扫描全部历史会话。
    seedFromStore(store, sessionIds) {
      if (disposed) return;
      for (const sessionId of sessionIds ?? store.keys()) {
        const state = stateFor(sessionId);
        try { hydrate(sessionId, state, store); }
        catch (error) { log('admission:seed-read-failed', { sessionId, error: String(error?.message ?? error) }); }
      }
      for (const [sessionId, state] of sessions) if (state.saved !== state.version) flush(sessionId);
    },
    get(sessionId, name) {
      const state = sessions.get(sessionId);
      return state?.active ? state.rows.get(name) : undefined;
    },
    admissionsFor(sessionId) {
      const state = sessions.get(sessionId);
      return new Map(state?.active ? state.rows : []);
    },
    admit(sessionId, row) {
      if (disposed) return;
      const state = stateFor(sessionId);
      state.active = true;
      state.rows.set(row.name, { ...row });
      state.touched.add(row.name);
      state.version++;
      flush(sessionId);
    },
    revoke(sessionId, name) {
      if (disposed) {
        log('admission:revoke-after-dispose', { sessionId, name });
        return false;
      }
      const state = stateFor(sessionId);
      const removed = state.rows.delete(name);
      // 即使尚未 seed/没有命中也保留撤销意图。
      state.touched.add(name);
      state.version++;
      flush(sessionId);
      return removed;
    },
    pruneWhere(sessionId, predicate) {
      if (disposed) return [];
      const state = sessions.get(sessionId);
      if (!state) return [];
      const removed = [];
      for (const [name, row] of state.rows) {
        if (predicate(row)) { state.rows.delete(name); state.touched.add(name); removed.push(name); }
      }
      if (removed.length) { state.version++; flush(sessionId); }
      return removed;
    },
    dropSession(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) return;
      state.active = false;
      releaseInactive(sessionId, state);
    },
    drain,
    async detachStore(store) {
      if (holder.store !== store) return;
      await drain();
      if (holder.store === store) {
        holder.store = null;
        // 新服务实例需要完整重写当前快照，不能沿用旧实例的 saved 版本。
        for (const state of sessions.values()) { state.saved = -1; state.hydrated = null; }
      }
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true; // 停止新写入，不丢弃已排队的写入。
      disposing = drain().then(() => { sessions.clear(); flushChains.clear(); });
      return disposing;
    },
  };
}
