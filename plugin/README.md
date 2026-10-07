# DSH Tool Discovery — development guide

Where the code lives, and what you need before you can run the tests. For the design and the
current state, start at [`docs/README.md`](<docs/README.md>) and
[`docs/05-current-status.md`](<docs/05-current-status.md>).

## Layout

| Directory | What it holds |
|---|---|
| [`domain/`](<domain/>) | The kernel: catalog, search, listing, state machine, budgets, error codes. No I/O and no DSH dependency, so it unit-tests on its own. |
| [`adapters/dsh/`](<adapters/dsh/>) | The DSH adapter: entry definitions, registry, journal, projection, guard, lifecycle, and the schemastery `Config` schema. Everything host-specific lives here. |
| [`client/`](<client/>) | The settings-panel browser half: an official ModuleLoader lazy CJS factory, JSX-free and build-free, plus the isomorphic pure logic it inlines. |
| [`contracts/`](<contracts/>) | Runtime contract checks against a real Loader. |
| [`fixtures/`](<fixtures/>) | Fixtures and mock provider/store used by the composition suites. |
| [`tests/unit/`](<tests/unit/>) | Kernel unit tests. |
| [`tests/composition/`](<tests/composition/>) | Composition suites against a real Loader. |
| [`quality/`](<quality/validate.mjs>) | The quality validator and its tooling. Published, but see below before running it. |

Directories are named for their responsibility, not for a phase of the project.

## Budgets

Hard caps are **off by default** — this plugin ships no extra risk thresholds. In
[`domain/constants.mjs`](<domain/constants.mjs>), every key in `OPTIONAL_LIMIT_KEYS`
(`maxActiveTools`, `maxActiveSchemaBytes`, `maxLoadBatch`, `maxListLimit`, `maxSearchLimit`,
`maxListResultBytes`, `maxSearchResultBytes`, `maxQueryCodePoints`, `maxSkillBytesPerLoad`)
defaults to `null`. `null` disables the cap; a positive integer enables it. `Infinity` is rejected
on purpose: it cannot survive JSON, so it would silently become `null` on the wire.

`resolveBudgets` is the only entry point, and it is strict — an unknown key, a non-integer, a
non-positive number, or a non-null non-integer on an optional limit all fail as
`INCOMPATIBLE_COMPOSITION` rather than being coerced.

Turning a cap on blocks work and costs turns: exceeding it rejects the *new* items (never evicts
disclosed ones), forces the model to split loads, and can force a premature context compaction.
Limits are not optimisation — the recommendation is to leave them off. See the configuration
section in the root [README](<../README.md>) / [README.zh.md](<../README.zh.md>) for the
user-facing version.

What remains bounded with every cap disabled: `defaultListLimit` (20), `defaultSearchLimit` (5),
pagination, and the TTLs.

`maxActiveTools` and `maxActiveSchemaBytes` are evaluated against the on-demand selections only —
already-loaded, frozen, and pending disclosure. The initial `alwaysVisible` baseline is injected by
the host and is deliberately not part of that count.

`initialSchemaTargetTokens` and `maxInitialBytes` are historical target values. No code path
enforces them, so they are not a measured guarantee of a 2K initial budget.

## Running the tests

From the repository root. Exit code is the result; a suite that looks like it passed is not a
pass.

```sh
npm test                          # unit suite — trust the output of this command
npm run test:composition          # composition gates — trust the output of this command
npm run test:all                  # both, in order
npm run check                     # package identity + docs consistency (scripts/check-repo.mjs)
npm run clean                     # remove regenerable residue (plugin/fixtures/tmp)
```

Counts are deliberately not written down: suites are added over time, so any number printed here
would drift. Treat the actual output of these commands as the source of truth.

`test:composition` runs every `tests/composition/gate-*.test.mjs` through a glob, so a new gate file
joins it (and the manual CI job that calls it) without editing a list. Helper modules in that
directory that are not `gate-*.test.mjs` are not suites. See
[07 — recovery and fork coverage](<docs/07-lifecycle-recovery-coverage.md>).

Prerequisites, because the suites do not have the same ones:

- **Unit** needs only Node. Its one in-repo data dependency,
  `quality/fixtures/catalog.invented.json`, is a synthetic protocol fixture and is published, so
  this suite runs on a fresh clone.
- **Composition** needs an installed DSH Core that provides the host dependencies at the matching
  version. It resolves packages from that installation through
  [`contracts/install-resolver.mjs`](<contracts/install-resolver.mjs>), which uses
  `DSH_INSTALL_ROOT` when set and otherwise falls back to the default install root. These commands
  install and restart nothing and do not touch the DSH profile; they do create temporary session
  files under the git-ignored `fixtures/tmp/`, which `contracts/harness.mjs` removes when each test
  process exits (`DSH_KEEP_TMP=1` keeps them; `npm run clean` clears leftovers).
- **The quality tooling is published, but the full suite does not complete on a public checkout.**
  The validator needs the frozen scoring dataset, and so does the tooling's own digest test, which
  reads the held-out queries and the frozen labels — none of which are published. Recorded results
  live in [`docs/05-current-status.md`](<docs/05-current-status.md>). Do not add the dataset to the
  tree to make it run; that is a decision of its own.

The internal reports under `reports/` and `audits/` are not published; they are referenced by path
where they matter, not linked.

### What the tests do and do not cover

The unit suite runs the client factory in a `vm` with only React supplied, asserting the inlined pure
helpers against their isomorphic twin in `plugin/client/model.mjs`. The composition suites exercise
the native `Config` surface, the mutable settings cycle, and the catalog metadata integration.

**No suite renders the settings panel in a real DOM or browser.** There is no rendered-UI acceptance
test, so the panel's runtime appearance remains unverified.
