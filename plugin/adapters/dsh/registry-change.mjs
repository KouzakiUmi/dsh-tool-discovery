// Compare underlying registrations and peer restrictions, not our own masks.
// Unknown registry shapes conservatively retain the full refresh path.
// wire 摘要与 registry.mjs 的绑定代次共用 DEFINITION_DIGESTS 缓存：一次
// tools/change 不再对同一批 definition 序列化+哈希两遍。
import { digestOfDefinition } from './registry.mjs';

/**
 * 把 ignoredFilters() 的返回值归一成 Set。
 * 调用方对外契约是数组（mask.ownedFilters()），但也接受 Set 与其他 iterable；
 * 形状无法解释时返回 null —— 宁可保守 refresh，也不猜"没有自有 filter"，
 * 否则自有掩码换装会被当成第三方变更而反复刷新（rc.1 的 40 次 refresh 退化即由此而来）。
 */
function ignoredSetOf(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value !== null && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    try { return new Set(value); } catch { return null; }
  }
  return null;
}

export function createRegistryChangeTracker(tools, ignoredFilters = () => new Set()) {
  const identities = new WeakMap();
  let serial = 0;
  const id = value => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value);
    if (!identities.has(value)) identities.set(value, ++serial);
    return identities.get(value);
  };
  function fingerprint() {
    try {
      if (typeof tools?.layers?.scoped?.values !== 'function') return null;
      const ignored = ignoredSetOf(ignoredFilters());
      if (ignored === null) return null;
      const rows = [];
      for (const layer of [tools.layers.global, ...tools.layers.scoped.values()]) {
        for (const [name, registration] of layer.tools.entries()) {
          rows.push(['tool', id(layer), name, id(registration), id(registration.definition), id(registration.when), digestOfDefinition(registration.definition)]);
        }
        for (const filter of layer.restrictions.values()) {
          if (!ignored.has(filter)) rows.push(['restriction', id(layer), id(filter), [...filter.allow ?? []].sort(), [...filter.deny ?? []].sort()]);
        }
      }
      return JSON.stringify(rows);
    } catch { return null; }
  }
  let previous = fingerprint();
  return {
    changed() {
      const next = fingerprint();
      const changed = next === null || previous === null || next !== previous;
      previous = next;
      return changed;
    },
  };
}
