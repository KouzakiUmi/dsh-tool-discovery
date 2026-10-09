#!/usr/bin/env node
// Repository consistency checks — the same gates CI runs, runnable locally with `npm run check`.
//
// Needs only Node and (optionally) git. No SDK, no DSH installation, no private data.
//
//   identity  package.json / cordis.patch.yml agree, no vendor scope,
//             no reference to the former package name in tracked files
//   docs      README pair covers the three entries, relative links in published docs resolve,
//             published docs make no unmeasured "saving N%" claim
//
// Usage: node scripts/check-repo.mjs [identity] [docs]     (no argument = both)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** Recursively list `.md` files below `rel` (repo-relative, forward slashes). */
function markdownUnder (rel) {
  const dir = join(ROOT, rel)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) return markdownUnder(child)
    return entry.name.endsWith('.md') ? [child] : []
  })
}

function checkIdentity (fail) {
  const pkg = JSON.parse(read('package.json'))

  // The loader resolves the patch by name; a silent mismatch ships a bundle that never activates.
  const patchName = read('cordis.patch.yml').match(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/m)?.[1]
  if (patchName !== pkg.name) fail(`cordis.patch.yml name (${patchName}) must equal package.json name (${pkg.name})`)

  // This repo is third-party; publishing under the vendor scope would collide with the vendor's own plugins.
  if (/^@deepseek(-ai)?\//.test(pkg.name)) fail(`package name '${pkg.name}' squats the vendor scope`)

  // The former package name must be gone from tracked files. The needle is assembled from
  // fragments because this file would otherwise match itself.
  const needle = 'dsh-tool-' + 'search'
  const grep = spawnSync('git', ['grep', '-n', '--fixed-strings', needle, '--', '.', ':!scripts/check-repo.mjs'],
    { cwd: ROOT, encoding: 'utf8' })
  if (grep.error || (grep.status !== 0 && grep.status !== 1)) {
    console.warn(`warn: git grep unavailable, stale-name check skipped (${grep.error?.message ?? `exit ${grep.status}`})`)
  } else if (grep.status === 0) {
    fail(`stale reference(s) to the former package name:\n${grep.stdout.trimEnd()}`)
  }
}

function checkDocs (fail) {
  // README.md and README.zh.md are a bilingual pair; divergence usually means a half-finished edit.
  for (const file of ['README.md', 'README.zh.md']) {
    const text = read(file)
    for (const entry of ['tool_list', 'tool_search', 'tool_load']) {
      if (!text.includes(entry)) fail(`${file} does not mention ${entry}`)
    }
  }

  const rootDocs = ['README.md', 'README.zh.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']
  const published = [...rootDocs.filter((f) => existsSync(join(ROOT, f))), 'plugin/README.md', ...markdownUnder('plugin/docs')]

  // Link shapes this project uses: `](path#anchor)`, `](<path with spaces>)`, `](<path> §9)`.
  // Only the path component is a filename; fragment and trailing prose are not.
  const targetOf = (href) => {
    let h = href.trim()
    const angled = h.match(/^<([^>]+)>/)
    h = angled ? angled[1] : h.split(/\s+/)[0]
    const hash = h.indexOf('#')
    return (hash === -1 ? h : h.slice(0, hash)).trim()
  }
  let checked = 0
  for (const file of published) {
    const text = read(file).replace(/```[\s\S]*?```/g, '')
    for (const m of text.matchAll(/\]\(([^)\n]+)\)/g)) {
      const raw = m[1].trim()
      if (/^(https?:|mailto:)/.test(raw)) continue
      const href = targetOf(raw)
      if (!href) continue
      checked += 1
      if (!existsSync(resolve(ROOT, dirname(file), href))) fail(`${file}: dangling link -> ${raw}`)
    }
  }

  // The project has measured neither token savings nor latency; a bare percentage next to these
  // words would overstate the evidence.
  const claim = /(sav(e|ing|ings)|reduc(e|ed|tion))[^.\n]{0,40}[0-9]+(\.[0-9]+)?%/i
  const claimFiles = ['README.md', 'README.zh.md', 'plugin/README.md', ...markdownUnder('plugin/docs')]
  for (const file of claimFiles) {
    read(file).split('\n').forEach((line, i) => {
      if (claim.test(line)) fail(`${file}:${i + 1}: unmeasured saving claim: ${line.trim()}`)
    })
  }
  console.log(`docs: ${published.length} files, ${checked} relative links checked`)
}

const CHECKS = { identity: checkIdentity, docs: checkDocs }
const wanted = process.argv.slice(2)
const names = wanted.length > 0 ? wanted : Object.keys(CHECKS)
const unknown = names.filter((n) => !(n in CHECKS))
if (unknown.length > 0) {
  console.error(`unknown check: ${unknown.join(', ')} (available: ${Object.keys(CHECKS).join(', ')})`)
  process.exit(2)
}

let failures = 0
for (const name of names) {
  const fail = (message) => { failures += 1; console.error(`FAIL [${name}] ${message}`) }
  CHECKS[name](fail)
  console.log(`${name}: done`)
}
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all repository checks passed')
