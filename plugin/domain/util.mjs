// plugin/domain/util.mjs
// 通用小工具(不引入任何第三方依赖)。

/**
 * Unicode code point 截断(不按 UTF-16 单元切,避免劈裂代理对)。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clampCodePoints(text, max) {
  const cps = Array.from(String(text));
  if (cps.length <= max) return String(text);
  return cps.slice(0, max).join('');
}

/**
 * 断言 plain object(非数组、非 null)。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 非空字符串断言。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 稳定排序辅助:按多个比较器。
 * @template T
 * @param {T[]} arr
 * @param {...( (a:T,b:T)=>number )} comparators
 */
export function sortBy(arr, ...comparators) {
  return arr.slice().sort((a, b) => {
    for (const c of comparators) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  });
}

/**
 * 铸造随机 opaque ID。
 * @param {{bytes(n:number):Uint8Array}} random
 * @param {string} prefix
 * @param {number} [byteLength=16]
 * @returns {string}
 */
export function mintOpaqueId(random, prefix, byteLength = 16) {
  const buf = random.bytes(byteLength);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return `${prefix}${hex}`;
}

/**
 * 单会话 FIFO 互斥锁:load/unload 串行,list/search 不受影响。
 */
export function createMutex() {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  return {
    /**
     * @template T
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(fn) {
      const result = tail.then(() => fn());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
