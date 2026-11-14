// 停用场景（disabledPresets）的纯单元门禁：配置归一 + guard 早退。
//
// 语义：绑定的 preset 一旦落在停用名单里，插件对该会话"不存在"——四个发现入口被
// 掩码移出可见面（mask.mjs 的 M6/M7 覆盖），准入判断一律不增加拒绝（本文件覆盖），
// 其余工具与原生权限链完全不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../adapters/dsh/index.mjs';
import { DEFAULT_DISABLED_PRESETS, resolveDisabledPresets } from '../../adapters/dsh/config.mjs';
import { createGuard } from '../../adapters/dsh/guard.mjs';

test('PS1: disabledPresets 默认只停用宿主内置极简模式 minimal', () => {
  assert.deepEqual([...DEFAULT_DISABLED_PRESETS], ['minimal']);
  assert.deepEqual([...validateConfig({}).disabledPresets], ['minimal'], '缺省必须落到默认名单');
  assert.deepEqual([...validateConfig({ disabledPresets: null }).disabledPresets], ['minimal'], 'null 与缺省同义');
});

test('PS2: 显式名单替换默认值；[] 表示不停止任何 preset', () => {
  assert.deepEqual([...validateConfig({ disabledPresets: ['minimal', 'ptc'] }).disabledPresets], ['minimal', 'ptc']);
  assert.deepEqual([...validateConfig({ disabledPresets: [] }).disabledPresets], [], '显式空数组不得回落默认值');
  assert.deepEqual([...validateConfig({ disabledPresets: ['  minimal  ', 'minimal'] }).disabledPresets], ['minimal'],
    '去空白、去重');
});

test('PS3: volatile 引用先解包再归一（设置面板热改的形态）', () => {
  const config = validateConfig({ disabledPresets: { get: () => ['custom'] } });
  assert.deepEqual([...config.disabledPresets], ['custom']);
  assert.deepEqual([...resolveDisabledPresets({ get: () => undefined })], ['minimal'], 'volatile 读到缺省仍回落默认');
});

test('PS4: 形状错误显式拒绝；空白条目与热改同判据（归一而非拒绝）', () => {
  // 形状错误：非数组，或含非字符串条目 → 拒绝激活。
  for (const value of ['minimal', 42, {}, [1], [null], [true]]) {
    assert.throws(() => validateConfig({ disabledPresets: value }), /disabledPresets/);
  }
  // 空白/空串条目：volatile 热改路径（schema + resolveDisabledPresets）本来就接受并
  // 归一，激活期必须同判据——否则配置文件里留过一个 `['minimal','   ']` 就会出现
  // "热改写入成功、下次重载拒绝激活"，插件再也起不来。
  assert.deepEqual([...validateConfig({ disabledPresets: [''] }).disabledPresets], []);
  assert.deepEqual([...validateConfig({ disabledPresets: ['   '] }).disabledPresets], []);
  assert.deepEqual([...validateConfig({ disabledPresets: ['   ', 'minimal'] }).disabledPresets], ['minimal']);
});

/** guard 替身：只提供 guard 早退路径与入口同名覆盖判定需要的最小结构。 */
function guardHarness({ disabled, controlDefinitions, shadowed = false }) {
  let guardFn;
  const logs = [];
  const ctx = {
    tools: {
      guard: (fn) => { guardFn = fn; return () => {}; },
      // 入口同名覆盖判定读它：默认返回已登记 definition 本身（"未被覆盖"）；
      // shadowed=true 时返回另一个实例，模拟宿主解析到的其实是别人的定义。
      get: (name) => (shadowed ? { other: name } : controlDefinitions.get(name)),
      view: () => ({ visible: new Map(), restrictableNames: new Set() }),
    },
  };
  const lifecycle = { sessions: new Map() };
  const tracker = { get: () => undefined };
  createGuard({
    ctx, lifecycle, tracker,
    isPresetDisabled: () => disabled,
    controlDefinitions,
    log: (event) => logs.push(event),
  });
  const agent = { id: 'agent-ps', session: { id: 'session-ps' } };
  return { run: (name) => guardFn({ agent, name }), logs };
}

test('PS5: 停用场景下四个入口一律拒绝派发，其余名字不做任何准入判断', () => {
  const controlDefinitions = new Map([['tool_list', { name: 'tool_list' }]]);
  const harness = guardHarness({ disabled: true, controlDefinitions });
  for (const name of ['tool_list', 'tool_search', 'tool_load', 'tool_unload']) {
    const reason = harness.run(name);
    assert.equal(typeof reason, 'string', `${name} 在停用场景必须被拒`);
    assert.match(reason, /tool discovery is disabled in this preset/);
  }
  assert.ok(harness.logs.includes('guard:discovery-disabled'));
  // 目录外的受控工具、own-scope 工具：停用场景不额外加拒绝（原生链负责）。
  assert.equal(harness.run('fixture_hidden_inherited'), undefined);
  assert.equal(harness.run('fixture_hidden_scope'), undefined);
});

test('PS6: 未停用时入口照旧放行，同名覆盖判据不变（回归）', () => {
  const controlDefinitions = new Map([['tool_list', { name: 'tool_list' }]]);
  const harness = guardHarness({ disabled: false, controlDefinitions });
  assert.equal(harness.run('tool_list'), undefined, '未被覆盖的入口放行');
  assert.equal(harness.logs.includes('guard:discovery-disabled'), false);

  // 入口被同名覆盖：仍按宿主语义拒绝——这条判据与停用场景无关，必须保持。
  const shadowed = guardHarness({ disabled: false, controlDefinitions, shadowed: true });
  assert.match(shadowed.run('tool_list'), /cannot be dispatched/);
});
