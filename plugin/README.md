# DSH Tool Discovery — development guide

Where the code lives, and what you need before you can run the tests. For the design and the
current state, start at [`docs/README.md`](<docs/README.md>) and
[`docs/05-current-status.md`](<docs/05-current-status.md>).

## Layout

| Directory | What it holds |
|---|---|
| [`domain/`](<domain/>) | The kernel: catalog, search, listing, state machine, budgets, error codes. No I/O and no DSH dependency, so it unit-tests on its own. |
| [`adapters/dsh/`](<adapters/dsh/>) | The DSH adapter: entry definitions, registry, journal, projection, guard, lifecycle. Everything host-specific lives here. |
| [`contracts/`](<contracts/>) | Runtime contract checks against a real Loader. |
| [`fixtures/`](<fixtures/>) | Fixtures and mock provider/store used by the composition suites. |
| [`tests/unit/`](<tests/unit/>) | Kernel unit tests — 8 files, 160 cases. |
| [`tests/composition/`](<tests/composition/>) | Composition suites against a real Loader — 14, 7, 13, and 8 cases. |
| [`quality/`](<quality/validate.mjs>) | The quality validator and its tooling. Published, but see below before running it. |

Directories are named for their responsibility, not for a phase of the project.

## Running the tests

From the repository root. Exit code is the result; a suite that looks like it passed is not a
pass.

```sh
npm test                          # 160 passed, 0 failed
npm run test:composition          # 42 passed, 0 failed
```

`test:composition` covers four real-Loader suites — 14 adapter gates, 7 lifecycle, 13 recovery and
fork, and 8 event-`seq` cases. The first two are on `main`; the recovery and event-`seq` suites
are on an unmerged branch, so a checkout of `main` runs 21 composition cases where this branch runs
42 — see [07 — recovery and fork coverage](<docs/07-lifecycle-recovery-coverage.md>).

Prerequisites, because the suites do not have the same ones:

- **Unit** needs only Node. Its one in-repo data dependency,
  `quality/fixtures/catalog.invented.json`, is a synthetic protocol fixture and is published, so
  this suite runs on a fresh clone.
- **Composition** needs an installed DSH Core that provides the host dependencies at the matching
  version. It resolves packages from that installation through
  [`contracts/install-resolver.mjs`](<contracts/install-resolver.mjs>), which uses
  `DSH_INSTALL_ROOT` when set and otherwise falls back to the default install root. These commands
  install and restart nothing and do not touch the DSH profile; they do create and remove temporary
  session files under the git-ignored `fixtures/tmp/`.
- **The quality tooling is published, but the full suite does not complete on a public checkout.**
  The validator needs the frozen scoring dataset, and so does the tooling's own digest test, which
  reads the held-out queries and the frozen labels — none of which are published. Recorded results
  live in [`docs/05-current-status.md`](<docs/05-current-status.md>). Do not add the dataset to the
  tree to make it run; that is a decision of its own.

The internal reports under `reports/` and `audits/` are not published; they are referenced by path
where they matter, not linked.
