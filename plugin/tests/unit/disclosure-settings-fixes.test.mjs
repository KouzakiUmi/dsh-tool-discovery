// 执行门禁（adapters/dsh/guard.mjs）的回归测试（rc.1 重设计）。
//
// 旧文件围绕 projection/journal/pendingLoad/compositionBypass 与 PTC 分支展开；这些
// 机制已整体删除：披露由掩码负责，执行门禁只做 admission + 当前定义摘要检查，
// PTC 与 native 共用同一门禁。旧 DF1-DF10 的产品目标（未加载不能执行、入口被同名
// 覆盖要拒、常驻/framework 放行、own-scope 兜底、不泄漏内部错误）在此按新 API 保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../../adapters/dsh/guard.mjs';

const SCOPE = { sessionId: 'sess_guard' };

const definition = (name, digest = `sha256:${name}`) => ({ name, schemaDigest: digest });

/**
 * 最小宿主面：ctx.tools 的 get/view/guard；lifecycle.sessions 为真实的 Map；
 * tracker 用纯内存桩（guard 只调用 get）。
 */
function harness({ entries = [], tracker = new Map(), alwaysNames = [], gateOwnScope = true,
  restrictable = [], visibleCore = [], control = new Map(), getTool, frameworkRetained = [],
  respectAlwaysVisible = () => false, runtimeMissing = false } = {}) {
  let handler;
  const catalogEntries = new Map(entries.map((e) => [e.toolId ?? `t_${e.name}`, e]));
  const byName = new Map();
  for (const e of entries) {
    const arr = byName.get(e.name) ?? [];
    arr.push(e);
    byName.set(e.name, arr);
  }
  const runtime = {
    engine: { getCatalog: () => ({ entries: catalogEntries, byName }) },
    alwaysNameSet: new Set(alwaysNames),
    gateOwnScope,
  };
  const sessions = new Map(runtimeMissing ? [] : [[SCOPE.sessionId, runtime]]);
  const ctx = {
    tools: {
      get: (name) => (getTool ?? ((n) => control.get(n)))(name),
      view: () => ({
        visible: new Map(visibleCore.map((name) => [name, definition(name)])),
        restrictableNames: new Set(restrictable),
      }),
      guard: (fn) => { handler = fn; return () => { handler = undefined; }; },
    },
  };
  createGuard({
    ctx,
    lifecycle: { sessions },
    tracker: {
      get: (sessionId, name) => tracker.get(`${sessionId}:${name}`),
    },
    frameworkRetained,
    respectAlwaysVisible,
    controlDefinitions: control,
    log: () => {},
  });
  const agent = { session: { id: SCOPE.sessionId } };
  return (name) => handler({ name, agent });
}

const admitted = (name, digest = `sha256:${name}`) => new Map([[`${SCOPE.sessionId}:${name}`, {
  name, toolId: `t_${name}`, schemaDigest: digest, at: 1,
}]]);

test('DF1 受控目录内未准入的工具 → 一句话拒绝（not admitted）', () => {
  const run = harness({ entries: [definition('glob')], tracker: new Map() });
  assert.match(run('glob'), /not admitted: load it with tool_load first/);
});

test('DF2 已准入且定义摘要一致 → 放行', () => {
  const run = harness({ entries: [definition('glob')], tracker: admitted('glob') });
  assert.equal(run('glob'), undefined);
});

test('DF3 已准入但定义已换版/被同名覆盖 → 要求重新 load', () => {
  const run = harness({
    entries: [definition('glob', 'sha256:new')],
    tracker: admitted('glob', 'sha256:old'),
  });
  assert.match(run('glob'), /changed after admission: load it again with tool_load/);
});

test('DF4 admission 的 toolId/name 对不上当前目录 → 同样按换版拒绝', () => {
  const run = harness({ entries: [definition('glob')], tracker: new Map([
    [`${SCOPE.sessionId}:glob`, { name: 'glob', toolId: 't_other', schemaDigest: 'sha256:glob', at: 1 }],
  ]) });
  assert.match(run('glob'), /changed after admission/);
});

test('DF5 被 tool_unload 撤销后（tracker 无记录）→ 拒绝执行', () => {
  const run = harness({ entries: [definition('glob')], tracker: new Map() });
  assert.match(run('glob'), /not admitted/);
});

test('DF6 入口名被同名覆盖 → 拒绝，不让模型无声调用影子实现', () => {
  const registered = definition('tool_load');
  const control = new Map([['tool_load', registered]]);
  const run = harness({ control });
  assert.equal(run('tool_load'), undefined, '登记的定义就是自己时放行');
  // ctx.tools.get 返回别的对象（被覆盖）。
  const shadowed = harness({
    control: new Map([['tool_load', registered]]),
    getTool: () => definition('other'),
    entries: [registered],
  });
  assert.match(shadowed('tool_load'), /shadowed by another registration/);
});

test('DF7 frameworkRetained 与 alwaysVisible（含 preset）永不放行前检查', () => {
  const run = harness({
    entries: [definition('glob')],
    frameworkRetained: ['final_answer'],
    alwaysNames: ['preset_only'],
  });
  assert.equal(run('final_answer'), undefined);
  assert.equal(run('preset_only'), undefined);
});

test('DF8 respectAlwaysVisible=false 时核心工具只要当前可见就放行；true 时回到准入检查', () => {
  const open = harness({ entries: [definition('read')], visibleCore: ['read'] });
  assert.equal(open('read'), undefined);
  const exact = harness({
    entries: [definition('read')], visibleCore: ['read'], respectAlwaysVisible: () => true,
  });
  assert.match(exact('read'), /not admitted/);
});

test('DF9 gateOwnScopeTools=false 只放开遮不住的 own-scope 名字；可遮名字仍须准入', () => {
  // 默认 true：目录外但 host 可遮的名字（global/父 scope）仍须准入。
  const run = harness({ entries: [], restrictable: ['own_tool'], gateOwnScope: true });
  assert.match(run('own_tool'), /not admitted/);
  // 显式 false：可遮名字仍然受管（它是 global/父 scope 工具，不是 own-scope）。
  const openRestrictable = harness({ entries: [], restrictable: ['own_tool'], gateOwnScope: false });
  assert.match(openRestrictable('own_tool'), /not admitted/);
  // 遮不住的 own-scope 私有注册：false 时完全不受管。
  const open = harness({ entries: [], restrictable: [], gateOwnScope: false });
  assert.equal(open('own_tool'), undefined);
});

test('DF10 目录外且不可 restrict 的 own-scope 名字：放行，由宿主语义兜底', () => {
  const run = harness({ entries: [] });
  assert.equal(run('host_private_tool'), undefined);
});

test('DF11 runtime 尚未建立时：入口仍受覆盖检查，其它名字保守放行', () => {
  const control = new Map([['tool_list', definition('tool_list')]]);
  const run = harness({ runtimeMissing: true, control });
  assert.equal(run('tool_list'), undefined);
  assert.equal(run('ordinary_tool'), undefined);
});

test('DF12 拒绝文案不泄漏内部错误或路径', () => {
  const run = harness({ entries: [definition('glob')], tracker: new Map() });
  const message = run('glob');
  assert.equal(typeof message, 'string');
  assert.doesNotMatch(message, /private path|STATE_NOT_READY|Error:/);
});
