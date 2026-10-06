// 阶段0 smoke：真实 Loader entry 树收敛 + 公共服务可达性（仅安装内服务，不含 fixture）。
// 运行：node progressive-v2/contracts/smoke-loader.mjs
// 产物：progressive-v2/reports/runtime-contract-smoke.json（命令、exit、entry 实际状态）。
// smoke 通过 ≠ 任何门禁通过。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootComposition, compositionSnapshot, removeTmpRoot, REQUIRED_SERVICES } from './harness.mjs'
import { dshPackageJson } from './install-resolver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.resolve(HERE, '..', 'reports', 'runtime-contract-smoke.json')

const result = {
  task: 'runtime-contract-v2',
  stage: 'stage0-smoke-loader-convergence',
  note: 'smoke 通过不等于任何验收门禁通过；8 项门禁仍未降低、仍未验证。',
  timestamp: new Date().toISOString(),
  command: 'node progressive-v2/contracts/smoke-loader.mjs',
  node: process.version,
  platform: process.platform,
  versions: {},
  status: 'fail',
  evidence: {},
  errors: []
}

for (const spec of [
  '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'
]) {
  try {
    result.versions[spec] = dshPackageJson(spec).version
  } catch (error) {
    result.errors.push(`version read failed for ${spec}: ${error?.message ?? error}`)
  }
}

let tmpRoot
let ctx
let loader
try {
  const booted = await bootComposition({ withFixtures: false })
  ctx = booted.ctx
  loader = booted.loader
  tmpRoot = booted.tmpRoot
  result.evidence.entrySpecs = booted.entries.map(({ id, name }) => ({ id, name }))
  result.evidence.snapshot = compositionSnapshot(ctx, loader)
  const missing = REQUIRED_SERVICES.filter((name) => ctx.get(name) === undefined)
  result.evidence.missingServices = missing
  const unsettled = result.evidence.snapshot.entryStates.filter((entry) => !entry.hasFiber)
  result.evidence.entriesWithoutFiber = unsettled
  if (missing.length === 0 && unsettled.length === 0) {
    result.status = 'pass'
    result.note += ' smoke 观察面：Loader 收敛、全部必需服务 ctx.get 可达、每个 entry 均有 fiber。'
  } else {
    result.errors.push(`missing services: [${missing.join(', ')}]; entries without fiber: [${unsettled.map((entry) => entry.id).join(', ')}]`)
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  if (loader !== undefined) {
    try {
      result.evidence.snapshotOnError = compositionSnapshot(ctx, loader)
    } catch (snapshotError) {
      result.errors.push(`snapshot failed: ${snapshotError?.message ?? snapshotError}`)
    }
  }
} finally {
  try {
    if (ctx !== undefined) await ctx.dispose?.()
  } catch (error) {
    result.errors.push(`ctx dispose failed: ${error?.message ?? error}`)
  }
  try {
    if (tmpRoot !== undefined) removeTmpRoot(tmpRoot)
  } catch (error) {
    result.errors.push(`tmp cleanup failed: ${error?.message ?? error}`)
  }
}

result.exitCode = result.status === 'pass' ? 0 : 1
fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ status: result.status, exitCode: result.exitCode, report: REPORT, errors: result.errors }, null, 2))
process.exit(result.exitCode)
