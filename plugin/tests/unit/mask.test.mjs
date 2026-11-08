// rc.1 掩码回归：长期换装的 filter 回收、私有 filter 不污染注册表指纹、
// 旧 disposer 异常不失联、安装失败不丢旧掩码、第三方 filter 不误删。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaskController } from '../../adapters/dsh/mask.mjs';
import { createRegistryChangeTracker } from '../../adapters/dsh/registry-change.mjs';
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * 最小宿主替身：mask.mjs 实际读取的结构是
 *   ctx.tools.view(agent).restrictableNames / ctx.tools.layers.peek(agent).restrictions
 *   agent.ctx.tools.restrict({ allow }) → disposer
 * 同时给出 registry-change 需要的 tools.layers.global / tools.layers.scoped。
 */
function maskHost({ restrictable = [...ENTRY_TOOL_NAMES, 'read_file', 'alpha', 'beta'] } = {}) {
  const restrictions = new Map();
  const installs = [];
  const broken = new Set();
  const controls = { failInstall: null, onInstall: null, onRelease: null };
  const layer = { tools: new Map(), restrictions };
  const agent = {
    id: 'agent_mask',
    ctx: {
      tools: {
        restrict: ({ allow }) => {
          if (controls.failInstall) throw controls.failInstall;
          const filter = { allow: new Set(allow) };
          const key = Symbol('restriction');
          restrictions.set(key, filter);
          const disposer = () => {
            if (broken.has(disposer)) throw new Error('failed to release old mask');
            controls.onRelease?.();
            restrictions.delete(key);
          };
          installs.push({ key, filter, disposer });
          // 模拟宿主在 restrict 内同步触发 tools/change，其他插件趁机重入注册。
          controls.onInstall?.();
          return disposer;
        },
      },
    },
  };
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: new Set(restrictable) }),
      layers: { peek: (who) => (who === agent ? layer : undefined) },
    },
  };
  const tools = {
    layers: {
      global: { tools: new Map(), restrictions: new Map() },
      scoped: new Map([[agent, layer]]),
    },
  };
  return { agent, ctx, tools, layer, restrictions, installs, broken, controls };
}

test('M1 20 次 load/unload 换装后只保留当前自有 filter，ownedFilters 仍是数组', () => {
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx });
  for (let i = 0; i < 20; i += 1) {
    mask.update(host.agent, new Set([i % 2 === 0 ? 'alpha' : 'beta']));
  }
  assert.equal(host.installs.length, 20, '每次换集合都换过掩码');
  assert.equal(host.restrictions.size, 1, '宿主层只剩一个生效掩码');
  const owned = mask.ownedFilters();
  assert.ok(Array.isArray(owned), 'ownedFilters 对外仍是数组');
  assert.equal(owned.length, 1, '已解除的旧 filter 必须被回收');
  assert.equal(owned[0], [...host.restrictions.values()][0], '认领的就是当前生效的 filter');
  assert.deepEqual([...mask.filtersFor(host.agent)], owned, 'filtersFor 与 ownedFilters 一致');
});

test('M2 自有掩码连续换装不被指纹当成外部变更（20 次循环 0 次 refresh）', () => {
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx });
  mask.update(host.agent, new Set(['alpha']));
  const tracker = createRegistryChangeTracker(host.tools, () => mask.ownedFilters());
  assert.equal(tracker.changed(), false);

  let refreshes = 0;
  for (let i = 0; i < 20; i += 1) {
    mask.update(host.agent, new Set([i % 2 === 0 ? 'alpha' : 'beta']));
    if (tracker.changed()) refreshes += 1;
  }
  assert.equal(refreshes, 0, '自有掩码换装不得触发会话目录 refresh');

  const third = { allow: new Set(['third-party']) };
  host.restrictions.set(Symbol('third-party'), third);
  assert.equal(tracker.changed(), true, '第三方 restriction 必须触发 refresh');
  assert.equal(tracker.changed(), false);
  host.layer.tools.set('third-party', { definition: { name: 'third-party', description: 'third', parameters: {} } });
  assert.equal(tracker.changed(), true, '第三方注册必须触发 refresh');
  assert.equal(mask.ownedFilters().includes(third), false, '第三方 filter 不在自有集合');
});

test('M3 旧 disposer 抛错：新掩码不丢、旧 filter 保守保留、后续重试回收且不误删第三方', () => {
  const logs = [];
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx, log: (event, payload) => logs.push([event, payload]) });
  mask.update(host.agent, new Set(['alpha']));
  const first = host.installs.at(-1);
  const thirdKey = Symbol('third-party');
  const third = { allow: new Set(['third-party']) };
  host.restrictions.set(thirdKey, third);
  host.broken.add(first.disposer);

  mask.update(host.agent, new Set(['beta']));
  const second = host.installs.at(-1);
  assert.equal(host.restrictions.has(second.key), true, '释放旧掩码失败不得连带释放新掩码');
  assert.equal(host.restrictions.has(first.key), true, '旧掩码仍在层里时必须继续被跟踪');
  assert.equal(mask.errorOf(host.agent), null, '旧 disposer 失败不是安装失败');
  assert.ok(logs.some(([event]) => event === 'mask:release-failed'), '释放失败有观测记录');
  const owned = mask.ownedFilters();
  assert.equal(owned.length, 2, '仍生效的旧自有 filter 继续认领');
  assert.equal(owned.includes(third), false, '第三方 filter 绝不进入自有集合');

  // 同一 desired 集合不再重复安装：state 指向活的新掩码，没有失联。
  const installsBefore = host.installs.length;
  mask.update(host.agent, new Set(['beta']));
  assert.equal(host.installs.length, installsBefore);

  host.broken.delete(first.disposer);
  mask.update(host.agent, new Set(['alpha']));
  assert.equal(host.restrictions.has(first.key), false, '下一次 reconcile 重试成功解除旧掩码');
  assert.equal(host.restrictions.has(thirdKey), true, '第三方 filter 未被误删');
  assert.equal(mask.ownedFilters().length, 1, '回收后自有 filter 回到 1');
});

test('M4 新掩码安装失败：旧 disposer 不丢、旧掩码仍生效，恢复后正常换装', () => {
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx });
  mask.update(host.agent, new Set(['alpha']));
  const first = host.installs.at(-1);
  host.controls.failInstall = new Error('host rejected');
  mask.update(host.agent, new Set(['beta']));
  assert.equal(host.restrictions.has(first.key), true, '安装失败时旧掩码不得被提前释放');
  assert.ok(mask.errorOf(host.agent) instanceof Error);
  assert.deepEqual(mask.ownedFilters(), [first.filter], '失败路径不产生新的自有 filter');

  host.controls.failInstall = null;
  mask.update(host.agent, new Set(['beta']));
  assert.equal(host.restrictions.size, 1);
  assert.equal(host.restrictions.has(first.key), false);
  assert.equal(mask.ownedFilters().length, 1);
  assert.equal(mask.errorOf(host.agent), null, '成功后清掉错误观测');
});

test('M5 换装期间重入的第三方 restriction 不被认领/误删，且随后必须被指纹观察到', () => {
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx });
  mask.update(host.agent, new Set(['alpha']));
  const first = host.installs.at(-1);
  const tracker = createRegistryChangeTracker(host.tools, () => mask.ownedFilters());
  assert.equal(tracker.changed(), false);

  let third = null;
  host.controls.onInstall = () => {
    host.controls.onInstall = null;
    third = { allow: new Set(['third-party']) };
    host.restrictions.set(Symbol('third-party'), third);
  };
  mask.update(host.agent, new Set(['beta']));
  assert.ok(mask.errorOf(host.agent) instanceof Error, '无法唯一认定自有 filter 时按失败处理');
  assert.equal(host.restrictions.has(first.key), true, '旧掩码仍生效');
  assert.equal(host.restrictions.size, 2, '重入的第三方 filter 未被误删');
  const owned = mask.ownedFilters();
  assert.equal(owned.length, 1, '只认领旧掩码，不认领第三方 filter');
  assert.equal(owned.includes(third), false);
  assert.equal(tracker.changed(), true, '换装期间重入的第三方 restriction 不得被忽略');
  assert.equal(tracker.changed(), false, '一次对齐后稳定');

  mask.update(host.agent, new Set(['beta']));
  assert.equal(host.restrictions.size, 2, '恢复后只剩新掩码 + 第三方 filter');
  assert.equal(mask.ownedFilters().length, 1);
});

test('M6 同一 allow 的 reconcile 也重试待释放的旧掩码，且重试在 mutating 范围内', () => {
  const host = maskHost();
  const mask = createMaskController({ ctx: host.ctx });
  mask.update(host.agent, new Set(['alpha']));
  const first = host.installs.at(-1);
  host.broken.add(first.disposer);
  mask.update(host.agent, new Set(['beta']));
  assert.equal(mask.ownedFilters().length, 2, '释放失败时旧 filter 留作重试');

  host.broken.delete(first.disposer);
  const mutatingDuringRelease = [];
  host.controls.onRelease = () => mutatingDuringRelease.push(mask.isMutating());
  const installsBefore = host.installs.length;
  // 同一个 allow（key 不变）：早退也必须先重试，否则旧掩码永远卡住。
  mask.update(host.agent, new Set(['beta']));
  assert.equal(host.installs.length, installsBefore, '同一 allow 不重复安装掩码');
  assert.equal(host.restrictions.has(first.key), false, '同一 allow 的 reconcile 也解除旧掩码');
  assert.equal(mask.ownedFilters().length, 1);
  assert.deepEqual(mutatingDuringRelease, [true], '重试释放时 mutating 计数必须已经生效');
});
