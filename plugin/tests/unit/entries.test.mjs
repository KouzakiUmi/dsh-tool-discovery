// 单测：四个入口 definition 的模型可见文案。
//
// description 是**模型每轮真的读到的面**：键名接错不会抛错，只会把空串发给模型，
// 协议外壳依然 ok:true。这是静默失效，只能由「所有 description 非空」的回归锁死。
//
// 覆盖：
//   * 中英文两种 locale 下，顶层 description 与每个参数 description 非空；
//   * 四个顶层 description **确实取自文案表**（硬编码会把 zh 界面退回英文）；
//   * 嵌套的 candidates.items.properties.ref/revision（最容易漏的一层）；
//   * 4 个入口名与顺序不变（tool_unload 是 rc.1 新增的第四入口）；
//   * tool_load 不再暴露 action/toolIds（模型不得自主 unload），tool_unload 带必填 names。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEntryDefinitions } from '../../adapters/dsh/entries.mjs';
import { createText } from '../../domain/index.mjs';

const LOCALES = ['en', 'zh'];

/** 用假的 defineTool 捕获定义，不需要宿主运行时。 */
function capture(locale) {
  const deps = {
    defineTool: (definition) => definition,
    resolve: () => {
      throw new Error('resolve 不应在本单测中被调用');
    },
    text: createText(locale),
  };
  return { definitions: createEntryDefinitions(deps) };
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
      if (typeof nestedSchema?.description === 'string') {
        out.push([`parameters.${key}.items.properties.${nestedKey}`, nestedSchema.description]);
      }
    }
  }
  return out;
}

test('四个入口名与顺序保持不变（含第四入口 tool_unload）', () => {
  const { definitions } = capture('en');
  assert.deepEqual(definitions.map((d) => d.name), ['tool_list', 'tool_search', 'tool_load', 'tool_unload']);
});

for (const locale of LOCALES) {
  test(`[${locale}] 所有模型可见 description 非空（含 candidates 嵌套字段）`, () => {
    const empty = [];
    for (const definition of capture(locale).definitions) {
      for (const [path, text] of descriptionsOf(definition)) {
        if (text.trim().length === 0) empty.push(`${definition.name}.${path}`);
      }
    }
    assert.deepEqual(empty, [], `空 description: ${empty.join(', ')}`);
  });

  test(`[${locale}] 四个顶层 description 取自文案表，不得硬编码`, () => {
    const table = createText(locale);
    for (const definition of capture(locale).definitions) {
      assert.equal(
        definition.description,
        table.t(['entry', definition.name, 'description']),
        `${definition.name} 的 description 必须等于 entry.${definition.name}.description`,
      );
    }
  });

  test(`[${locale}] tool_load 参数说明全部已接线（无 action/toolIds）`, () => {
    const load = byName(capture(locale).definitions).get('tool_load');
    const props = load.parameters;
    assert.equal(typeof props.names.description, 'string');
    assert.equal(typeof props.candidates.description, 'string');
    assert.equal(typeof props.candidates.items.properties.ref.description, 'string');
    assert.equal(typeof props.candidates.items.properties.revision.description, 'string');
    assert.equal(props.action, undefined, 'action 已随卸载动作移出 tool_load');
    assert.equal(props.toolIds, undefined, 'toolIds 卸载字段已下线');
    assert.doesNotMatch(load.description, /no unload|没有卸载/, '描述必须承认 tool_unload 存在');
  });

  test(`[${locale}] tool_unload 带必填 names，说明卸载与下一请求生效`, () => {
    const unload = byName(capture(locale).definitions).get('tool_unload');
    assert.equal(unload.parameters.names.type, 'array');
    assert.equal(unload.parameters.names.required, true);
    assert.equal(typeof unload.parameters.names.description, 'string');
    assert.match(unload.description, /next request|下一次请求/i);
  });
}
