// 单测：三个入口 definition 的模型可见文案。
//
// 为什么单测 adapter：description 是**模型每轮真的读到的面**。键名接线错位
// （entries 读 ['entry','tool_load','candidateRef']，而文案表把 candidateRef
// 放在 tool_list 下）不会抛错，只会把 `?? ''` 的空串发给模型——协议外壳
// 依然 ok:true。这是静默失效，只能由「所有 description 非空」的回归锁死。
//
// 覆盖：
//   * 中英文两种 locale 下，顶层 description 与每个参数 description 非空；
//   * 嵌套的 candidates.items.properties.ref/revision（最容易漏的一层）；
//   * 3 个入口名与顺序不变；
//   * action 只允许 load，且保留"缺省 load"信息；
//   * toolIds 字段已下线（模型不得自主 unload）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEntryDefinitions } from '../../adapters/dsh/entries.mjs';
import { createText } from '../../domain/index.mjs';

const LOCALES = ['en', 'zh'];

/** 用假的 defineTool 捕获三个 definition，不需要宿主运行时。 */
function capture(locale) {
  const captured = [];
  const deps = {
    defineTool: (definition) => {
      captured.push(definition);
      return definition;
    },
    resolve: () => {
      throw new Error('resolve 不应在本单测中被调用');
    },
    text: createText(locale),
  };
  return { definitions: createEntryDefinitions(deps), captured };
}

function byName(definitions) {
  return new Map(definitions.map((def) => [def.name, def]));
}

/** 收集一个 definition 里所有 description 字符串（含嵌套）。 */
function descriptionsOf(definition) {
  const out = [];
  if (typeof definition.description === 'string') out.push(['description', definition.description]);
  const parameters = definition.parameters ?? {};
  for (const [key, schema] of Object.entries(parameters)) {
    if (schema && typeof schema === 'object' && typeof schema.description === 'string') {
      out.push([`parameters.${key}`, schema.description]);
    }
    const nested = schema?.items?.properties ?? {};
    for (const [nestedKey, nestedSchema] of Object.entries(nested)) {
      if (nestedSchema && typeof nestedSchema === 'object' && typeof nestedSchema.description === 'string') {
        out.push([`parameters.${key}.items.properties.${nestedKey}`, nestedSchema.description]);
      }
    }
  }
  return out;
}

test('三个入口名与顺序保持不变', () => {
  const { definitions } = capture('en');
  assert.deepEqual(definitions.map((d) => d.name), ['tool_list', 'tool_search', 'tool_load']);
});

for (const locale of LOCALES) {
  test(`[${locale}] 所有模型可见 description 非空（含 candidates 嵌套字段）`, () => {
    const { definitions } = capture(locale);
    const empty = [];
    for (const definition of definitions) {
      for (const [path, text] of descriptionsOf(definition)) {
        if (text.trim().length === 0) empty.push(`${definition.name}.${path}`);
      }
    }
    assert.deepEqual(empty, [], `空 description: ${empty.join(', ')}`);
  });

  test(`[${locale}] tool_load 参数说明全部已接线`, () => {
    const load = byName(capture(locale).definitions).get('tool_load');
    const props = load.parameters;
    // 缺键会直接抛，便于定位；空串由上一个用例拦住。
    assert.equal(typeof props.action.description, 'string');
    assert.equal(typeof props.names.description, 'string');
    assert.equal(typeof props.candidates.description, 'string');
    assert.equal(typeof props.candidates.items.properties.ref.description, 'string');
    assert.equal(typeof props.candidates.items.properties.revision.description, 'string');
  });

  test(`[${locale}] action 只允许 load 且保留"缺省 load"信息`, () => {
    const load = byName(capture(locale).definitions).get('tool_load');
    // enum 与 description 必须自洽：enum 里没有 unload,文案也不得引导 unload。
    assert.deepEqual(load.parameters.action.enum, ['load']);
    const description = load.parameters.action.description;
    assert.match(description, /"load"/);
    assert.match(description, /Default|缺省/);
    assert.doesNotMatch(description, /unload|卸载/);
  });

  test(`[${locale}] toolIds 卸载字段已下线`, () => {
    const load = byName(capture(locale).definitions).get('tool_load');
    // 模型不得自主 unload:卸载入口字段不得再出现在模型可见 schema 里。
    assert.equal(load.parameters.toolIds, undefined);
    assert.equal(load.description.includes('unload previously'), false);
  });
}
