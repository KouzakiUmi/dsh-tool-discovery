import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createBuiltinDescriptionPolicy, descriptionPolicyMarker } from '../../adapters/dsh/builtin-descriptions.mjs';
import { BUILTIN_DESCRIPTION_RULES } from '../../adapters/dsh/builtin-descriptions-data.mjs';
import { V2_ADDITIONAL_DESCRIPTION_RULES } from '../../adapters/dsh/builtin-descriptions-v2.mjs';
import { BUILTIN_DESCRIPTION_TOOLS, LEGACY_DESCRIPTION_TOOLS, selectedDescriptionTools, resolveBuiltinDescriptionOverrides, encodeDescriptionTools, decodeDescriptionTools } from '../../adapters/dsh/builtin-description-options.mjs';
import { validateConfig } from '../../adapters/dsh/index.mjs';
import { digestOf } from '../../domain/canonical.mjs';

const fixtures = ['builtin-descriptions-rc3.json', 'builtin-descriptions-extra-rc3.json'].flatMap(file =>
  JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8')).rows);
const ruleList = [...BUILTIN_DESCRIPTION_RULES, ...V2_ADDITIONAL_DESCRIPTION_RULES];
const digests = new Set(ruleList.flatMap(rule => rule.sourceDigests));
const matched = fixtures.filter(row => digests.has(digestOf(row.wire)));
const all = Object.fromEntries(BUILTIN_DESCRIPTION_TOOLS.map(tool => [tool.name, true]));
const none = Object.fromEntries(BUILTIN_DESCRIPTION_TOOLS.map(tool => [tool.name, false]));
const control = description => [{ type: 'request/header', data: { header: { tools: [{ name: 'tool_load', description }] } } }];

test('BO1 existing defaults stay compatible; every additional tool defaults off', () => {
  assert.deepEqual(selectedDescriptionTools(), LEGACY_DESCRIPTION_TOOLS);
  assert.equal(BUILTIN_DESCRIPTION_TOOLS.length, 28);
  assert.equal(matched.length, 53);
  assert.equal(digests.size, 53, 'no duplicate definition hashes');
  assert.deepEqual(new Set(ruleList.map(rule => rule.name)), new Set(BUILTIN_DESCRIPTION_TOOLS.map(tool => tool.name)));
  assert.deepEqual(selectedDescriptionTools({ bash: false, skill: true }), ['pwsh', 'workflow', 'read_image', 'create_goal', 'skill']);
  assert.deepEqual(validateConfig({}).compactBuiltinToolOverrides, {});
});

test('BO2 reject unknown tool keys and non-boolean values; read volatile maps', () => {
  const input = { skill: true, bash: false };
  const result = resolveBuiltinDescriptionOverrides({ get: () => input });
  assert.deepEqual(result, input);
  input.skill = false;
  assert.equal(result.skill, true, 'take an immutable snapshot');
  for (const value of [null, [], 1, true, 'all', { unknown: true }, { skill: 1 }, { bash: null }, new Date(), JSON.parse('{"__proto__":true}')]) {
    assert.throws(() => validateConfig({ compactBuiltinToolOverrides: value }), error => error.code === 'INCOMPATIBLE_COMPOSITION');
  }
});

test('BO3 all tools have independent on/off controls without changing the host wire', () => {
  for (const tool of BUILTIN_DESCRIPTION_TOOLS) {
    const policy = createBuiltinDescriptionPolicy({ enabled: true, overrides: { ...none, [tool.name]: true } });
    for (const { wire } of matched) {
      const original = JSON.stringify(wire);
      const projected = policy.project(wire);
      assert.equal(projected !== wire, wire.name === tool.name, `${tool.name} must not affect ${wire.name}`);
      assert.equal(JSON.stringify(wire), original);
      assert.equal(projected.parameters, wire.parameters);
      assert.deepEqual({ ...projected, description: wire.description }, wire);
    }
  }
});

for (const locale of ['en', 'zh']) {
  test(`BO4 ${locale}: all supported descriptions shrink and unsupported variants stay intact`, () => {
    const policy = createBuiltinDescriptionPolicy({ enabled: true, locale, overrides: all });
    for (const { wire } of fixtures) {
      const result = policy.project(wire);
      if (!digests.has(digestOf(wire))) { assert.equal(result, wire); continue; }
      assert.ok(result.description.length < wire.description.length, wire.name);
      assert.ok(Buffer.byteLength(result.description) < Buffer.byteLength(wire.description), `${locale}/${wire.name} UTF-8 bytes`);
      assert.deepEqual({ ...result, description: wire.description }, wire);
    }
    const disabled = createBuiltinDescriptionPolicy({ overrides: all });
    for (const { wire } of fixtures) assert.equal(disabled.project(wire), wire, 'master switch gates every tool');
  });
}

test('BO10 changed source descriptions or parameter constraints never match by name alone', () => {
  const policy = createBuiltinDescriptionPolicy({ enabled: true, overrides: all });
  for (const { wire } of matched) {
    const changedText = { ...wire, description: wire.description + ' New mandatory rule.' };
    assert.equal(policy.project(changedText), changedText);
    const changedParameters = { ...wire, parameters: { ...wire.parameters, minProperties: 99 } };
    assert.equal(policy.project(changedParameters), changedParameters);
  }
});

test('BO11 distinct delegation and scheduling capabilities keep distinct wording', () => {
  const policy = createBuiltinDescriptionPolicy({ enabled: true, overrides: all });
  for (const row of fixtures.filter(row => ['subagent', 'subagent_fork'].includes(row.wire.name))) {
    const text = policy.project(row.wire).description;
    assert.equal(text.includes('completed conversation turns'), row.variant.inherits);
    assert.equal(text.includes('send_message'), row.variant.continuable);
    assert.equal(text.includes('no follow-ups'), !row.variant.continuable);
    assert.equal(text.includes('Optional LLM selection'), row.variant.selectable);
    assert.equal(text.includes('provider route defaults'), row.variant.defaults);
  }
  for (const row of fixtures.filter(row => row.wire.name === 'todo_write')) {
    assert.equal(policy.project(row.wire).description.includes('exactly one'), !row.variant.allowParallelInProgress);
  }
  for (const row of fixtures.filter(row => row.wire.name === 'terminal_send')) {
    assert.equal(policy.project(row.wire).description.includes('Background'), row.variant.enableRunInBackground);
  }
  const schedule = policy.project(fixtures.find(row => row.wire.name === 'schedule_create').wire).description;
  for (const required of ['exactly one', 'nonexistent', 'earlier instant', 'latest missed', 'duplicate delivery']) assert.ok(schedule.includes(required));
});

test('BO5 masks have stable bit order and reject invalid or future bits', () => {
  assert.equal(encodeDescriptionTools(LEGACY_DESCRIPTION_TOOLS), '1f');
  assert.equal(encodeDescriptionTools(BUILTIN_DESCRIPTION_TOOLS.map(tool => tool.name)), 'fffffff');
  assert.equal(encodeDescriptionTools(['skill']), '8000000');
  for (const tool of BUILTIN_DESCRIPTION_TOOLS) assert.deepEqual(decodeDescriptionTools(encodeDescriptionTools([tool.name])), [tool.name]);
  assert.deepEqual(decodeDescriptionTools('0'), []);
  for (const value of ['', '01', '-1', '1g', 'A', '10000000', 'f'.repeat(1024), undefined]) assert.equal(decodeDescriptionTools(value), null);
});

test('BO6 v2 roundtrip pins exact per-tool choices and language even if settings reverse', () => {
  const hot = createBuiltinDescriptionPolicy({ enabled: true, locale: 'zh', overrides: { ...none, skill: true, subagent: true } });
  const marker = hot.control({ name: 'tool_load', description: 'load' }).description;
  assert.ok(marker.length < 90, 'bounded marker, not a repeated full name list');
  const cold = createBuiltinDescriptionPolicy({ enabled: false, locale: 'en', overrides: all });
  cold.restore(control(marker));
  assert.deepEqual(cold.status(), hot.status());
  for (const { wire } of fixtures) assert.deepEqual(cold.project(wire), hot.project(wire));
  cold.reset(true, 'en', none);
  assert.deepEqual(cold.status().tools, []);
  assert.match(cold.control({ name: 'tool_load', description: 'load' }).description, /:v2:en:0\]$/);
});

test('BO7 v1 replay uses only the exact original templates and original five names', () => {
  assert.equal(digestOf(BUILTIN_DESCRIPTION_RULES), 'sha256:4ae236d3da591f3e141885977e1dca72d48635da912ea973a4b04f25253e2292', 'published v1 descriptions and fingerprints must not drift');
  const policy = createBuiltinDescriptionPolicy({ enabled: true, locale: 'en', overrides: all });
  policy.restore(control('load' + descriptionPolicyMarker('zh', undefined, 'v1')));
  assert.equal(policy.status().revision, 'v1');
  assert.deepEqual(policy.status().tools, LEGACY_DESCRIPTION_TOOLS);
  for (const { wire } of fixtures) {
    const old = BUILTIN_DESCRIPTION_RULES.find(rule => rule.sourceDigests.includes(digestOf(wire)));
    if (old) assert.equal(policy.project(wire).description, old.zh);
    else assert.equal(policy.project(wire), wire, 'v1 must not acquire new variants or tools');
  }
  assert.match(policy.control({ name: 'tool_load', description: 'load' }).description, /:v1:zh\]$/);
});

test('BO8 malformed/unknown markers do not enable a partial policy; unmarked history stays original', () => {
  for (const suffix of [':v2:zh]', ':v2:zh:10000000]', ':v2:zh:01]', ':v1:zh:1f]', ':v99:en:1]', ':v2:en:A]']) {
    const policy = createBuiltinDescriptionPolicy({ enabled: true, overrides: all });
    policy.restore(control('load\n[dsh-tool-discovery:builtin-descriptions' + suffix));
    assert.equal(policy.status().enabled, false);
  }
  const policy = createBuiltinDescriptionPolicy({ enabled: true, overrides: all });
  policy.restore(control('load'));
  assert.equal(policy.status().enabled, false);
});

test('BO12 settings element wiring exposes one callback per supported tool (not a DOM test)', () => {
  let descriptor;
  vm.runInNewContext(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value; } } },
  });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [initial, () => {}] };
  const helpers = descriptor.factory(() => react).__test;
  const toggled = [];
  const tree = helpers.SettingsPanel({ t: key => key, snapshot: { status: 'ready', writable: true,
    value: { compactBuiltinToolDescriptions: true, compactBuiltinToolOverrides: { skill: true } },
    meta: { choices: [], default: [], constraints: { builtinDescriptionTools: BUILTIN_DESCRIPTION_TOOLS } },
  }, onDescriptionTool: (...args) => toggled.push(args) });
  const nodes = [];
  function visit(node) { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children ?? []) visit(child); }
  visit(tree);
  const switches = nodes.filter(node => typeof node.type === 'function' && node.props?.id?.startsWith('concise-tool-'));
  assert.equal(switches.length, 28);
  const skill = switches.find(node => node.props.id === 'concise-tool-skill');
  assert.equal(skill.props.checked, true);
  assert.equal(skill.props.disabled, false);
  skill.props.onChange(false);
  assert.deepEqual(toggled, [['skill', false]]);
});

test('BO9 UI choices use host metadata and save a single leaf without overwriting siblings', async () => {
  let descriptor;
  vm.runInNewContext(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value; } } },
  });
  const helpers = descriptor.factory(name => { assert.equal(name, 'react'); return {}; }).__test;
  const constraints = { builtinDescriptionTools: BUILTIN_DESCRIPTION_TOOLS };
  const rows = helpers.descriptionToolRows({}, constraints);
  assert.equal(rows.length, 28);
  assert.deepEqual(Array.from(rows.filter(row => row.checked), row => row.name), LEGACY_DESCRIPTION_TOOLS);
  assert.equal(helpers.descriptionToolRows({ compactBuiltinToolOverrides: { skill: true, bash: false } }, constraints).find(row => row.name === 'skill').checked, true);
  assert.equal(helpers.descriptionToolRows({}, undefined).length, 0);
  const writes = [];
  const form = { mutate: async ops => { writes.push(JSON.parse(JSON.stringify(ops))); return true; } };
  assert.equal(await helpers.saveDescriptionTool(form, constraints, 'skill', true), true);
  assert.deepEqual(writes, [[{ op: 'set', path: ['compactBuiltinToolOverrides', 'skill'], value: true }]]);
  assert.equal(await helpers.saveDescriptionTool(form, constraints, 'unknown', true), false);
  assert.equal(await helpers.saveDescriptionTool(form, constraints, 'skill', 'true'), false);
  assert.equal(await helpers.saveDescriptionTool(form, undefined, 'skill', true), false);
  assert.equal(writes.length, 1);
  assert.equal(await helpers.saveDescriptionTool({ mutate: async () => false }, constraints, 'skill', true), false);
  await assert.rejects(helpers.saveDescriptionTool({ mutate: async () => { throw new Error('save failed'); } }, constraints, 'skill', true), /save failed/);
});
