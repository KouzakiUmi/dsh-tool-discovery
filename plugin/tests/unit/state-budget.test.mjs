// 状态投影的字节上限：**带标记**裁剪只作用于诊断段。
//
// 背景（由一次契约审查实测发现）：`invalidated` 只增不减（state.mjs 的 `next.invalidated.set`），
// 长会话里它会单独把 `view:"state"` 顶穿上限 —— 于是配了 `maxListResultBytes` 的部署会**永久**
// 拿不到状态视图，直到一次成功压缩。那比没有上限更糟：开关看起来配上了，实际长期报错。
// 所以超限时先裁诊断段，并且**必须带标记**（`invalidatedTruncated`），不能静默。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fitStateWithinBudget, projectState } from '../../domain/list.mjs'

/** 一份典型的状态投影：三段列表 + 预算回显。 */
function payloadWith (invalidatedCount) {
  return {
    mode: 'ready',
    selected: [{ toolId: 't1', name: 'a', revision: 'r1', selectionSource: 'model' }],
    advertised: [{ toolId: 't1', name: 'a', revision: 'r1', requestId: 'req-1' }],
    invalidated: Array.from({ length: invalidatedCount }, (_, i) => ({
      toolId: `t_inv_${String(i).padStart(2, '0')}`,
      reason: 'definition-changed',
      at: 1_700_000_000_000,
      revision: 'r1',
    })),
    budgets: {
      maxActiveTools: null,
      maxActiveSchemaBytes: null,
      activeCount: 1,
      activeSchemaBytes: 10,
      tokenEstimation: 'estimate',
    },
  }
}

const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

test('SB1 超限时只裁诊断段，并且带标记（不得静默、不得动 selected/advertised）', () => {
  const payload = payloadWith(40)
  const full = sizeOf(payload)
  const maxBytes = Math.floor(full / 2)

  const fitted = fitStateWithinBudget(payload, maxBytes)
  assert.notEqual(fitted, null, '裁掉诊断段之后必须装得下')
  assert.equal(fitted.invalidatedTruncated, true, '裁剪必须带标记，否则调用方无从知道这一段不全')
  assert.deepEqual(fitted.selected, payload.selected, 'selected 是执行事实，不得被裁')
  assert.deepEqual(fitted.advertised, payload.advertised, 'advertised 是披露事实，不得被裁')
  assert.ok(fitted.invalidated.length < payload.invalidated.length, '诊断段必须真的被裁短')
  assert.ok(sizeOf(fitted) <= maxBytes, '结果必须落在上限之内')
})

test('SB2 正控制：装得下时**逐字不变**、且不产生标记', () => {
  const payload = payloadWith(3)
  const untouched = fitStateWithinBudget(payload, sizeOf(payload))
  assert.deepEqual(untouched, payload, '装得下时必须原样返回')
  assert.equal(Object.hasOwn(untouched, 'invalidatedTruncated'), false, '装得下时不得加标记')
})

test('SB3 连诊断段裁空都装不下时返回 null（由调用方明确失败）', () => {
  assert.equal(fitStateWithinBudget(payloadWith(40), 8), null, '装不下必须返回 null，不能返回超限内容')
})

test('SB4 上限为 null（默认关闭）时不改任何东西', () => {
  const payload = payloadWith(40)
  assert.deepEqual(fitStateWithinBudget(payload, null), payload, '默认关闭必须零改动')
})

test('SB5 真装配：projectState 的投影能被同一个函数裁进上限（端到端形状一致）', () => {
  // 用真实的 projectState 产出，而不是手写形状 —— 防止"测试里的形状"与产品形状漂移。
  const state = {
    mode: 'ready',
    selected: new Map([['t1', { toolId: 't1', name: 'a', revision: 'r1', selectionSource: 'model' }]]),
    advertised: new Map(),
    invalidated: new Map(Array.from({ length: 30 }, (_, i) => [`t_inv_${i}`, { reason: 'definition-changed', at: 1, revision: 'r1' }])),
  }
  const budgets = { maxActiveTools: null, maxActiveSchemaBytes: null, maxListResultBytes: null }
  const payload = projectState(state, budgets, [{ wireBytes: 10 }])
  const maxBytes = Math.floor(sizeOf(payload) / 2)

  const fitted = fitStateWithinBudget(payload, maxBytes)
  assert.notEqual(fitted, null, '真实投影必须也能被裁进上限')
  assert.equal(fitted.invalidatedTruncated, true)
  assert.equal(fitted.selected.length, payload.selected.length, '真实投影的 selected 同样不得被裁')
  assert.ok(sizeOf(fitted) <= maxBytes)
})
