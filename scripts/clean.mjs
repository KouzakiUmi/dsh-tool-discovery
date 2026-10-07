#!/usr/bin/env node
// Remove regenerable local test residue (git-ignored). Safe to run any time.
//
// Removes plugin/fixtures/tmp/ — session files the composition suites write and normally
// clean up themselves (see contracts/harness.mjs). Pass --all to also remove .functional-dist/
// (locally built tarballs). Never touches .probe/, plugin/reports/, plugin/audits/ or the
// private quality data: those are evidence, not residue.
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = ['plugin/fixtures/tmp']
if (process.argv.includes('--all')) targets.push('.functional-dist')

for (const rel of targets) {
  const abs = join(ROOT, rel)
  if (!abs.startsWith(ROOT)) throw new Error(`refusing to remove outside the repository: ${abs}`)
  if (!existsSync(abs)) { console.log(`skip   ${rel} (absent)`); continue }
  rmSync(abs, { recursive: true, force: true })
  console.log(`remove ${rel}`)
}
