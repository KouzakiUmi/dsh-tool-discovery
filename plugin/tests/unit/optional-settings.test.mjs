// 可选配置面的类型校验（rc.1 重设计）。
//
// 旧版 requireTrustedEpoch / requireTrustedEpochForSubagents / ptcCompatibility 在
// rc.1 上已移除：Config 仍保留字段只为不吞旧配置，validateConfig 不再校验也不再透传。
// 新路径的可选布尔项是 initialToolsEnabled / alwaysAllowPresetTools / gateOwnScopeTools。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../adapters/dsh/index.mjs';

test('optional defaults: initial tools / preset tools / own-scope gate all on', () => {
  const raw = validateConfig({});
  assert.equal(raw.initialToolsEnabled, true);
  assert.equal(raw.alwaysAllowPresetTools, true);
  assert.equal(raw.gateOwnScopeTools, true, 'own-scope 工具默认也必须先 load');
});

test('optional values: explicit false/true and volatile references are preserved', () => {
  assert.equal(validateConfig({ initialToolsEnabled: false }).initialToolsEnabled, false);
  assert.equal(validateConfig({ initialToolsEnabled: { get: () => false } }).initialToolsEnabled, false);
  assert.equal(validateConfig({ alwaysAllowPresetTools: false }).alwaysAllowPresetTools, false);
  assert.equal(validateConfig({ alwaysAllowPresetTools: { get: () => false } }).alwaysAllowPresetTools, false);
  assert.equal(validateConfig({ gateOwnScopeTools: false }).gateOwnScopeTools, false);
  assert.equal(validateConfig({ gateOwnScopeTools: { get: () => false } }).gateOwnScopeTools, false);
});

test('optional values: invalid types do not silently enable or disable checks', () => {
  for (const key of ['initialToolsEnabled', 'alwaysAllowPresetTools', 'gateOwnScopeTools']) {
    for (const value of [null, 'false', 0, [], {}]) {
      assert.throws(() => validateConfig({ [key]: value }), /must be a boolean/);
    }
  }
});

test('removed rc.1 keys are ignored, not re-enabled or passed through', () => {
  for (const key of ['requireTrustedEpoch', 'requireTrustedEpochForSubagents', 'ptcCompatibility']) {
    const raw = validateConfig({ [key]: true });
    assert.equal(Object.hasOwn(raw, key), false, `${key} 不得出现在 effective config 视图里`);
  }
  // 旧键仍然兼容（不抛错），只是没有效果。
  assert.doesNotThrow(() => validateConfig({ requireTrustedEpoch: true, ptcCompatibility: true }));
});
