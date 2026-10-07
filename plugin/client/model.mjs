// progressive-v2/client/model.mjs
// 设置面板的纯逻辑：不 import React，可在无 DOM 的单测里直接跑。
//
// 组件（client.js）只负责把这层算出来的派生值渲染成复选框列表；所有"哪些工具
// 可选、哪些被选中、筛选后剩哪些"的判断都在这里，便于单测而不必起浏览器。

/** 大小写不敏感的子串筛选。空查询返回全部（保持原序）。 */
export function filterRows (rows, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle === '') return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(needle));
}

/** 勾选/取消一个名字。返回新数组（配置是 volatile 引用，宿主按值比较）。 */
export function toggleName (selected, name) {
  const list = Array.isArray(selected) ? [...selected] : [];
  const at = list.indexOf(name);
  if (at === -1) list.push(name);
  else list.splice(at, 1);
  return list;
}

/** 当前选择是否与 DSH 默认完全一致（无序比较、忽略重复）。 */
export function isDefaultSelection (selected, defaults) {
  const a = new Set(Array.isArray(selected) ? selected : []);
  const b = new Set(Array.isArray(defaults) ? defaults : []);
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

/** 恢复 DSH 默认：给回一份副本，并指出是否真的变了（避免无谓写入）。 */
export function restoreDefaults (selected, defaults) {
  const next = [...(Array.isArray(defaults) ? defaults : [])];
  return { names: next, changed: !isDefaultSelection(selected, next) };
}

/**
 * 把"目录 + 当前配置"折成面板要渲染的行。
 * @param {{choices?: readonly any[]}} meta `alwaysVisible` 节点上的 meta
 * @param {readonly string[]} selected 用户配置的 alwaysVisible
 * 组件层不必知道宿主 meta 的键名（服务端写 initialToolChoices，这里读 choices）。
 * @param {{choices?: readonly any[], default?: readonly string[]}} meta readMeta 归一后的形状
 * @param {readonly string[]} selected 用户配置的 alwaysVisible
 * @returns {{fixed: readonly string[], rows: ReadonlyArray<{name:string,selected:boolean,available:boolean}>,
 *            selectedCount: number, missingCount: number}}
 */
export function buildRows (meta, selected) {
  const fixed = ['tool_list', 'tool_search', 'tool_load'];
  const available = new Set();
  for (const choice of meta?.choices ?? []) {
    if (typeof choice?.name === 'string') available.add(choice.name);
  }
  const chosen = new Set();
  for (const name of selected ?? []) {
    if (typeof name === 'string' && name.length > 0) chosen.add(name);
  }
  const rows = [];
  for (const name of chosen) {
    if (fixed.includes(name)) continue;
    rows.push({ name, selected: true, available: available.has(name) });
  }
  for (const name of available) {
    if (chosen.has(name)) continue;
    rows.push({ name, selected: false, available: true });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    fixed,
    rows,
    selectedCount: rows.filter((r) => r.selected).length,
    missingCount: rows.filter((r) => !r.available).length,
  };
}
