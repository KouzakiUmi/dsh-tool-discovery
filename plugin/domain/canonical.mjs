// progressive-v2/domain/canonical.mjs
// 无损 canonical JSON、SHA-256 digest、UTF-8 字节核算。
// 键按 code unit 排序;数组顺序保持;拒绝 undefined / NaN / Infinity / function / symbol。
// 这是 digest 与"回执逐字比较"的唯一实现。
import { createHash } from 'node:crypto';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const out = [];
  write(value, out, []);
  return out.join('');
}

/**
 * @param {string} text
 * @returns {string} 小写 hex
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {unknown} value */
export function digestOf(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** @param {string} text */
export function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** @param {unknown} a @param {unknown} b */
export function deepEqualCanonical(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * @param {unknown} value
 * @param {string[]} path
 * @param {string[]} out
 */
function write(value, out, path) {
  if (value === null) {
    out.push('null');
    return;
  }
  const t = typeof value;
  if (t === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${path.join('.')}`);
    // -0 与 0 在 JSON 中同形,统一为 0 以保证 digest 稳定
    out.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
    return;
  }
  if (t === 'string') {
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      const item = value[i];
      if (item === undefined) throw new Error(`canonicalJson: undefined array item at ${path.join('.')}[${i}]`);
      write(item, out, [...path, String(i)]);
    }
    out.push(']');
    return;
  }
  if (t === 'object') {
    const keys = Object.keys(/** @type {object} */ (value)).sort();
    out.push('{');
    let first = true;
    for (const k of keys) {
      const v = /** @type {Record<string, unknown>} */ (value)[k];
      if (v === undefined) continue; // 对象中 undefined 等价于缺省,不参与 digest
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(k), ':');
      write(v, out, [...path, k]);
    }
    out.push('}');
    return;
  }
  throw new Error(`canonicalJson: unsupported type ${t} at ${path.join('.')}`);
}

/**
 * 结构化深冻结:快照必须不可变。
 * 递归进入 Map 的值与 Set 的元素(否则 Map 里的条目对象可被外部改写)。
 * @template T @param {T} value @returns {Readonly<T>}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    // 容器守卫必须先于 Object.freeze 安装(冻结后不可再 defineProperty)
    if (value instanceof Map || value instanceof Set) preventMapMutation(value);
    Object.freeze(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        deepFreeze(k);
        deepFreeze(v);
      }
    } else if (value instanceof Set) {
      for (const v of value) deepFreeze(v);
    } else {
      for (const k of Object.keys(/** @type {object} */ (value))) {
        deepFreeze(/** @type {Record<string, unknown>} */ (value)[k]);
      }
    }
  }
  return value;
}

const FROZEN_MARK = Symbol('domain.frozenContainer');

/**
 * 冻结容器仍可被 set/delete 改写;这里替换原型方法使其抛错。
 * 只作用于本模块创建的不可变快照,不触碰宿主对象。
 * @param {Map<unknown,unknown>|Set<unknown>} container
 */
function preventMapMutation(container) {
  if (/** @type {any} */ (container)[FROZEN_MARK]) return;
  const proto = Object.getPrototypeOf(container);
  if (!proto || Object.getOwnPropertyDescriptor(proto, 'set') === undefined) return;
  const guard = (method) => function guarded() {
    throw new TypeError('attempted to mutate a frozen domain snapshot');
  };
  const own = {
    set: guard('set'), delete: guard('delete'), clear: guard('clear'), add: guard('add'),
  };
  for (const k of Object.keys(own)) {
    Object.defineProperty(container, k, { value: own[k], enumerable: false, writable: false, configurable: false });
  }
  Object.defineProperty(container, FROZEN_MARK, { value: true, enumerable: false });
}
