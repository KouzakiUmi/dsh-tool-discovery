import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoreInventory, main } from '../../../scripts/check-core-tools.mjs';

const inventory = (names) => ({ schemaVersion: 1,
  core: { package: '@deepseek-ai/dsh', version: 'fixture' }, composition: 'standard + dynamic fixture', complete: true,
  tools: names.map((name) => ({ name, source: { package: '@deepseek-ai/dsh-tool-fixture',
    version: 'fixture', evidence: 'lib/index.js:1 registration', kind: 'dynamic' } })) });

test('取证清单报告新增与 composition 缺失，不能把注册 ID 当工具名', () => {
  const report = checkCoreInventory(inventory(['bash', 'new_tool']), ['bash', 'read']);
  assert.deepEqual(report.missingFromBaseline, ['new_tool']);
  assert.deepEqual(report.absentFromComposition, ['read']);
});

test('缺来源、版本、动态取证或完整性声明时拒绝给出通过结论', () => {
  const original = inventory(['bash']);
  for (const change of [
    (value) => { value.complete = false; },
    (value) => { value.core.package = '@deepseek-ai/dsh-web-app'; },
    (value) => { value.core.version = ''; },
    (value) => { value.tools = []; },
    (value) => { delete value.tools[0].source; },
    (value) => { value.tools[0].source.kind = 'guess'; },
    (value) => { value.tools[0].source.evidence = ''; },
  ]) {
    const value = structuredClone(original);
    change(value);
    assert.throws(() => checkCoreInventory(value));
  }
  assert.throws(() => checkCoreInventory(inventory(['bash', 'bash'])), /重复/);
});

test('相同 composition 无新增即通过差集，工具顺序不影响结果', () => {
  assert.deepEqual(checkCoreInventory(inventory(['read', 'bash']), ['bash', 'read']).missingFromBaseline, []);
});

test('CLI 无清单或无法读取时返回 2 而非假通过', () => {
  const original = console.error;
  const messages = [];
  console.error = (message) => messages.push(message);
  try {
    assert.equal(main([]), 2);
    assert.equal(main(['--inventory', 'nonexistent-core-inventory-fixture.json']), 2);
    assert.equal(messages.length, 2);
  } finally { console.error = original; }
});
