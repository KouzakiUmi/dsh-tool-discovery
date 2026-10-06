// progressive-v2/domain/candidate-refs.mjs
// 会话 + 资格代次绑定的短期 opaque 引用。
// opaque、内存态、默认 15 分钟 TTL、跨会话拒绝、fork 不继承、重启即失效。
// "难猜"不替代当前 scope 资格复核:engine 每次 load 仍会用当前 catalog 重新解析 toolId。
import { DomainError } from './errors.mjs';
import { isNonEmptyString } from './util.mjs';

/**
 * @typedef {Object} CandidateRecord
 * @property {string} sessionId
 * @property {number} eligibilityGeneration
 * @property {string} toolId
 * @property {string} revision
 * @property {number} expiresAt
 */

/**
 * @param {{ clock: {now():number}, random: {bytes(n:number):Uint8Array}, ttlMs?: number }} deps
 */
export function createRefStore(deps) {
  const ttlMs = deps.ttlMs ?? 900_000;
  /** @type {Map<string, CandidateRecord>} */
  const store = new Map();

  const mint = () => {
    const buf = deps.random.bytes(16);
    let hex = '';
    for (const b of buf) hex += b.toString(16).padStart(2, '0');
    return `c_${hex}`;
  };

  return {
    /**
     * @param {string} sessionId
     * @param {number} eligibilityGeneration
     * @param {string} toolId
     * @param {string} revision
     * @returns {string} ref
     */
    issue(sessionId, eligibilityGeneration, toolId, revision) {
      const ref = mint();
      store.set(ref, {
        sessionId,
        eligibilityGeneration,
        toolId,
        revision,
        expiresAt: deps.clock.now() + ttlMs,
      });
      return ref;
    },

    /**
     * 解析 ref。任一不符(跨会话/代次/过期/未知)统一 CANDIDATE_UNAVAILABLE,不泄漏差异。
     * @param {string} ref
     * @param {string} sessionId
     * @param {number} eligibilityGeneration
     * @param {number} now
     * @returns {CandidateRecord}
     */
    resolve(ref, sessionId, eligibilityGeneration, now) {
      if (!isNonEmptyString(ref)) throw new DomainError('CANDIDATE_UNAVAILABLE');
      const rec = store.get(ref);
      if (!rec) throw new DomainError('CANDIDATE_UNAVAILABLE');
      if (rec.expiresAt <= now) {
        store.delete(ref);
        throw new DomainError('CANDIDATE_UNAVAILABLE');
      }
      if (rec.sessionId !== sessionId) throw new DomainError('CANDIDATE_UNAVAILABLE');
      if (rec.eligibilityGeneration !== eligibilityGeneration) throw new DomainError('CANDIDATE_UNAVAILABLE');
      return rec;
    },

    /**
     * 资格代次变化时作废所有旧 ref(撤权/代次上升)。
     * @param {number} eligibilityGeneration
     */
    dropForEligibility(eligibilityGeneration) {
      for (const [ref, rec] of store) {
        if (rec.eligibilityGeneration !== eligibilityGeneration) store.delete(ref);
      }
    },

    /** 清空(会话销毁 / HMR)。 */
    clear() {
      store.clear();
    },

    size() {
      return store.size;
    },
  };
}

/** @typedef {ReturnType<typeof createRefStore>} RefStore */
