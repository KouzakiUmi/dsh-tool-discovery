#!/usr/bin/env node
// 离线差集检查：只消费显式取证清单，不启动宿主、不读取 profile、不猜工具来源。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_NAMES } from '../plugin/domain/core-tools.mjs';

export function checkCoreInventory(inventory, baseline = CORE_TOOL_NAMES) {
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  if (inventory?.schemaVersion !== 1 || inventory?.core?.package !== '@deepseek-ai/dsh'
    || !nonempty(inventory.core.version) || !nonempty(inventory.composition)
    || inventory.complete !== true || !Array.isArray(inventory.tools) || !inventory.tools.length) {
    throw new Error('需要 schemaVersion=1、Core 包/版本、composition、complete=true 和非空 tools 清单');
  }
  const names = new Set();
  for (const tool of inventory.tools) {
    if (!nonempty(tool?.name) || !nonempty(tool.source?.package)
      || !nonempty(tool.source?.version) || !nonempty(tool.source?.evidence)
      || !['preset', 'dynamic'].includes(tool.source?.kind)) {
      throw new Error('每个工具须有 name 和 source.package/version/evidence/kind（preset 或 dynamic）');
    }
    if (names.has(tool.name)) throw new Error(`重复工具名：${tool.name}`);
    names.add(tool.name);
  }
  const expected = new Set(baseline);
  return {
    core: inventory.core,
    composition: inventory.composition,
    missingFromBaseline: [...names].filter((name) => !expected.has(name)).sort(),
    absentFromComposition: [...expected].filter((name) => !names.has(name)).sort(),
  };
}

export function main(args) {
  if (args.length !== 2 || args[0] !== '--inventory') {
    console.error('用法：node scripts/check-core-tools.mjs --inventory <已核验的宿主核心工具清单.json>');
    return 2;
  }
  try {
    const report = checkCoreInventory(JSON.parse(readFileSync(resolve(args[1]), 'utf8')));
    console.log(JSON.stringify(report, null, 2));
    // 某个 composition 没有的基线名无害；只有漏收新名使检查失败。
    return report.missingFromBaseline.length ? 1 : 0;
  } catch (error) {
    // 不转储清单全文、读取路径或宿主错误，避免带出私人诊断资料。
    console.error(error instanceof SyntaxError ? '清单不是合法 JSON' :
      error?.code ? '无法读取清单' : error.message);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
