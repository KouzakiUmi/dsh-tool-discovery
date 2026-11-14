// 可选配置面的类型校验（rc.1 重设计）。
//
// 旧版 requireTrustedEpoch / requireTrustedEpochForSubagents / ptcCompatibility 等键
// 已从 Config 与 validateConfig 中删除（无效果，留着只会误导）。旧 profile 里的同名键
// 由宿主 schemastery 的非严格合并原样带过，不报错也不生效，因此无需迁移。
// 可选布尔项是 initialToolsEnabled / alwaysAllowPresetTools / gateOwnScopeTools。
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
  const REMOVED = ['requireTrustedEpoch', 'requireTrustedEpochForSubagents', 'ptcCompatibility',
    'compactBuiltinToolDescriptions', 'compactBuiltinToolOverrides', 'allowMissingSessionQuery'];
  for (const key of REMOVED) {
    const raw = validateConfig({ [key]: true });
    assert.equal(Object.hasOwn(raw, key), false, `${key} 不得出现在 effective config 视图里`);
  }
  // 旧 profile 仍能激活（不抛错），只是没有效果。
  assert.doesNotThrow(() => validateConfig(Object.fromEntries(REMOVED.map((key) => [key, true]))));
});
