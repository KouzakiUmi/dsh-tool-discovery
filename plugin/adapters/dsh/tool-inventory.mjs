// 设置页的应用级登记事实，与会话 loaded/advertised/资格目录无关。
// SDK 0.2.1-alpha.1：ToolRuntime.layers 的 global/scoped 均为登记层，preset 会预先加载到 scoped。
// 读取注册表，不创建会话、不激活额外 preset、不执行工具。API 形状不同只报告目录不完整。
import { ENTRY_TOOL_NAMES } from '../../domain/constants.mjs';
const fixed = new Set(ENTRY_TOOL_NAMES);
function addLayer(names, layer) {
  if (typeof layer?.tools?.entries !== 'function') return false;
  for (const [name] of layer.tools.entries()) {
    if (typeof name === 'string' && name.length > 0 && !fixed.has(name)) names.add(name);
  }
  return true;
}
export function globalToolInventory(tools) {
  const names = new Set();
  let complete = false;
  try {
    const layers = tools?.layers;
    complete = addLayer(names, layers?.global) && typeof layers?.scoped?.values === 'function';
    if (typeof layers?.scoped?.values === 'function') {
      for (const layer of layers.scoped.values()) complete = addLayer(names, layer) && complete;
    }
  } catch { complete = false; }
  if (!complete) {
    // 兼容较小替身/未来 SDK：全局可见项是正向证据，但未列出的名字不能判为不可用。
    try {
      for (const name of tools?.view?.(undefined)?.visible?.keys() ?? []) {
        if (typeof name === 'string' && !fixed.has(name)) names.add(name);
      }
    } catch { /* 保留已确认登记的部分；不存在的名称保持未知 */ }
  }
  return { names: [...names].sort(), complete };
}

// 当前 agent 实际绑定的 preset 修订才是授权来源，不信 session header 字符串或设置页全局目录。
// 只保留 preset 自有登记且原生 scope 仍允许的工具；其它 preset 与 agent 后装 scoped 工具不在内。
export function presetToolNamesOf(tools, agentPresets, agentScope) {
  if (typeof agentPresets?.generationFor !== 'function' || agentScope?.ctx === undefined) return [];
  const generation = agentPresets.generationFor(agentScope.ctx);
  if (generation?.key === undefined || typeof tools?.layers?.peek !== 'function') return [];
  const names = new Set();
  addLayer(names, tools.layers.peek(generation.key));
  const visible = tools.view(agentScope).visible;
  return [...names].filter(name => visible.has(name)).sort();
}

/**
 * 运行时装载自证（方案 1）：获取当前 agent scope 自身实际装载并可见的工具名集合。
 * 覆盖直接注册在 agent 自身 scope 及其链上的系统工具（例如 subagent、subagent_fork、list_agents 等动态注入工具）。
 * @param {any} tools ctx.tools
 * @param {any} agentScope 当前会话的 Agent 作用域
 * @returns {string[]}
 */
export function scopeMountedToolNamesOf(tools, agentScope) {
  if (tools === undefined || agentScope === undefined) return [];
  const names = new Set();
  // 1. 若宿主 layers 支持按 scope 获取链式层（chain layers）或自身层（own layer）
  if (typeof tools?.layers?.chainLayers === 'function') {
    try {
      const layers = tools.layers.chainLayers(agentScope) ?? tools.layers.chainLayers(agentScope?.ctx);
      if (Array.isArray(layers)) {
        for (const l of layers) addLayer(names, l);
      }
    } catch {
      // 容错降级
    }
  } else if (typeof tools?.layers?.peek === 'function') {
    const ownLayer = tools.layers.peek(agentScope) ?? tools.layers.peek(agentScope?.ctx);
    if (ownLayer) addLayer(names, ownLayer);
  }
  // 2. 校验在当前 agentScope 下是否真实可见且未被拦截
  if (typeof tools?.view === 'function') {
    try {
      const visible = tools.view(agentScope)?.visible;
      if (visible instanceof Map || (visible && typeof visible.has === 'function')) {
        return [...names].filter(name => visible.has(name)).sort();
      }
    } catch {
      // 容错降级
    }
  }
  return [...names].sort();
}
