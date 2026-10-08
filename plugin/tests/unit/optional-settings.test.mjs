import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../adapters/dsh/index.mjs';

test('optional defaults: strict epoch off, initial tools on', () => {
  const raw = validateConfig({});
  assert.equal(raw.requireTrustedEpoch, false);
  assert.equal(raw.requireTrustedEpochForSubagents, false);
  assert.equal(raw.initialToolsEnabled, true);
  assert.equal(raw.alwaysAllowPresetTools, true);
});

test('optional values: explicit false/true and volatile references are preserved', () => {
  assert.equal(validateConfig({ requireTrustedEpoch: true }).requireTrustedEpoch, true);
  assert.equal(validateConfig({ initialToolsEnabled: false }).initialToolsEnabled, false);
  assert.equal(validateConfig({ initialToolsEnabled: { get: () => false } }).initialToolsEnabled, false);
  assert.equal(validateConfig({ alwaysAllowPresetTools: false }).alwaysAllowPresetTools, false);
  assert.equal(validateConfig({ alwaysAllowPresetTools: { get: () => false } }).alwaysAllowPresetTools, false);
});

test('optional values: invalid types do not silently enable or disable checks', () => {
  for (const key of ['requireTrustedEpoch', 'requireTrustedEpochForSubagents', 'initialToolsEnabled', 'alwaysAllowPresetTools']) {
    for (const value of [null, 'false', 0, [], {}]) {
      assert.throws(() => validateConfig({ [key]: value }), /must be a boolean/);
    }
  }
});
