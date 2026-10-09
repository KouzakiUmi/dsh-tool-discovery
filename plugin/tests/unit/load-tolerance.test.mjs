// plugin/tests/unit/load-tolerance.test.mjs
// 方案 2 单元测试：容错幂等加载常驻工具（tolerantLoadProtected）及防死锁验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, nextOpId } from './helpers.mjs';

test('LT1: 默认 tolerantLoadProtected: true 下，tool_load 加载常驻工具幂等成功（避免死锁）', async () => {
  // 设置 read_file 为常驻工具
  const { engine } = await makeEngine({
    engineConfig: {
      alwaysToolNames: ['read_file'],
    },
  });

  // 模型请求加载常驻工具 read_file
  const opId = nextOpId();
  const res = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: opId });
  assert.equal(res.response.ok, true, '加载常驻工具必须成功返回 ok: true');
  assert.equal(res.response.data.receipt.operation, 'load');
  assert.equal(res.response.data.receipt.selected[0].name, 'read_file');

  // canonical 折叠验证
  const out = engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: opId, tool: 'tool_load', input: { names: ['read_file'] } },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, SCOPE_A);
  assert.equal(out.applied, true, '折叠必须成功应用');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

test('LT2: 显式关闭 tolerantLoadProtected: false 时，加载常驻工具抛出 INVALID_ARGS (protectedNotLoadable)', async () => {
  const { engine } = await makeEngine({
    engineConfig: {
      alwaysToolNames: ['read_file'],
      tolerantLoadProtected: false,
    },
  });

  const res = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false, '严格模式下必须拒绝加载常驻工具');
  assert.equal(res.response.error.code, 'INVALID_ARGS');
});

test('LT3: 无论 tolerantLoadProtected 开关如何，三入口项与框架保留项坚决不可加载', async () => {
  const { engine } = await makeEngine({
    frameworkToolNames: ['final_answer'],
    engineConfig: {
      tolerantLoadProtected: true, // 即使开启容错
    },
  });

  // 三入口工具
  for (const entry of ['tool_list', 'tool_search', 'tool_load']) {
    const res = await engine.handleLoad({ names: [entry] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(res.response.ok, false, `${entry} 绝对不可加载`);
    assert.equal(res.response.error.code, 'INVALID_ARGS');
  }

  // 框架保留工具
  const fwRes = await engine.handleLoad({ names: ['final_answer'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(fwRes.response.ok, false, '框架保留工具绝对不可加载');
  assert.equal(fwRes.response.error.code, 'INVALID_ARGS');
});
