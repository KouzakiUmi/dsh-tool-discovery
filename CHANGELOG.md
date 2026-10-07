# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Reading this changelog

The source baseline is published on `main` as its single initial-publish commit. This repository
was rebuilt on 2026-10-06: the earlier history — including the `2a1f9c0` and `257ddc0` commits,
which are quoted in older entries below — was rewritten away and **no longer resolves**. Entries
below the functional-build entry are historical source-baseline records, not claims about current
release availability. The package remains **not published to npm**. This functional-build round
performs no profile installation, GUI reload, or application restart. Publishing a source commit,
releasing a package, and accepting an online product are three different events.

Nothing in this file is a product-acceptance statement. For the authoritative per-item status —
what is verified, what is unverified, and what this version refuses to support — see
[`plugin/docs/05-current-status.md`](plugin/docs/05-current-status.md).

## [0.2.0-functional.1] — 2026-10-07

Functional build on `fix/discovery-functionality`; not an online GUI acceptance or npm publication.

### Added

- Initial-tool settings panel with searchable live tool choices, add/remove selection, and restore
  DSH defaults. Explicit `alwaysVisible` replaces the default list; changes take effect in a new
  session or after a successful compaction, not midway through the current cache epoch.
- Real-host regression gates for cache epochs, manual/automatic compaction, restart recovery,
  and the native Config/settings metadata boundary.

### Changed

- Tool disclosure is append-only with frozen wire definitions within an epoch. Only a successful
  manual or automatic compaction resets on-demand disclosure; model-driven unload is rejected.
- Nine optional hard caps default to `null` (disabled). Explicit caps reject new work without
  evicting disclosed tools; their latency, extra-turn and context-rebuild trade-offs are documented.
- The client bundle declares its web platform and ships in the validated release payload.
- Native Config requires the tested `@deepseek-ai/schemastery` 3.18.5-alpha.1 peer.

### Verification boundary

- Local verification: 250 unit checks and 64 real-host composition checks passed against Core
  0.2.1-alpha.1. Hosted CI runs the portable subset and explicitly reports the two host-bound
  test files it cannot run without that SDK.
- Rendered DOM, online settings activation, real-provider cache savings and latency are not
  claimed. No profile installation, reload, or restart was performed in this release round.
- Commandcode interruption anomalies and unfinished browser probes are deferred, not shipped
  as fixes or used to block this functional build.

## [0.2.0-functional.2] — reload and cold-recovery hotfix

Branch `fix/review-cache-boundaries`. The package is **not published to npm**.
This entry describes the source fix. Installation state and any online status are recorded
separately, elsewhere. Nothing here is a product-acceptance statement.

### Fixed

- **A truncated outbound request was sent while cold restore was still pending.** When the runtime
  was still `restoring`, system-prompt assembly went ahead and emitted a request carrying less than
  the tools the session had already loaded. Assembly now waits for the public
  `lifecycle.whenReady(sessionId)` to settle and only then projects, so a pending restore never
  produces a short request.
- **The restore wait had no cancellation path.** The wait has **no new default timeout**: there is
  no fixed deadline that would eventually downgrade to a truncated request. Its only exits are the
  settled restore and the host's own per-turn cancellation signal (`context.signal`, injected by
  `assembleContextFor`), which aborts that turn through the host's cancellation/error pipeline
  instead of a locally imposed limit.
- **A decided restore error could be turned into a pass by waiting.** Adding the wait did not
  loosen the existing fail-closed rule: when restore settles as an error/incompatible state, the
  request is still emitted **without** the previously loaded tools, the engine stays `incompatible`,
  and a guessed tool name executes nothing.
- **Budget override `null` was rejected.** `validateConfig` now accepts `budgets: null` and treats
  it as covered by `DEFAULT_BUDGETS`, consistently with the native Config and the domain defaults.
  The defaults themselves are unchanged, existing limits still apply, and a malformed non-object
  budget value is still rejected.
- **Duplicate definitions in the real incoming array.** System-prompt assembly now checks the full
  incoming tool array for same-name duplicate definitions and reports
  `INCOMPATIBLE_COMPOSITION`, with a single-definition positive control. The previous duplicate
  check covered the initial baseline allowed set only, not the loaded tools, so a duplicate among
  loaded tools was not detected.

### Changed

- `version` is `0.2.0-functional.2`. `test:composition` additionally runs
  `plugin/tests/composition/gate-review-boundaries.test.mjs`; `plugin/tests/unit/projection.test.mjs`
  is already covered by the existing `test` glob. Dependencies, `private`, publishing policy, and
  publishing policy are unchanged. The host-composition CI command also includes the new boundary
  suite. **No new storage SDK peer dependency is added.**

### Not claimed by this work

- The trusted-baseline / storage-migration task was interrupted and is **not** part of this
  delivery. Nothing here says the trusted baseline is fixed.
- No GUI verification or online acceptance was performed, and **no cache saving, token reduction,
  or latency improvement is measured or claimed.**
- The historical header authorization defect discussed in
  [`plugin/docs/07-lifecycle-recovery-coverage.md`](plugin/docs/07-lifecycle-recovery-coverage.md)
  **remains outstanding for later work**; it is not fixed by this round. This round also **does not
  enable any old-session migration** for it.
- The timing counterexample is driven by a monotonic-clock loop with `finally` cleanup rather than
  a single wall-clock sample, so the assertion does not depend on one `Date.now()` reading.
- No pass counts are asserted in this entry.

## [Unreleased]

Direction branch `fix/lifecycle-recovery-coverage`. **Not merged.** The implementation and the code
review ran on the **same model in different sessions**, and the documentation alignment and this
round's review likewise. Both chains therefore carry a **correlated error from the shared model
source** and are **not equivalent to independent cross-model evidence**. The primary evidence in
this round is **machine-reproducible assertions and command exit codes**; the pull request is left to
maintainer review and is **not auto-merged**. None of this is product acceptance, and none of it puts
the branch on `main`.

### Added

- `plugin/tests/composition/gate-adapter-event-seq.test.mjs` — 8 composition cases covering the
  event-`seq` gate and the sealed state: a malformed canonical `result` fails closed, a repeat valid
  `result` does not revive a sealed state, a restore after sealing does not return to ready,
  non-canonical tools and ordinary events are not sealed, the own-only boundary is not widened, and
  the outbound request after sealing carries only the three entries. Malformed `seq` values are
  injected synthetically, since the host does not naturally produce them.
- `plugin/tests/composition/gate-adapter-recovery.test.mjs` — 13 composition cases, 8 of them
  against a real Cordis Loader and a real host fork, covering fail-closed recovery on a missing
  session query and on a failed `readSession`, real fork isolation, unload and candidate load
  across a cold restart, registry churn, and recovery intersected with current eligibility.
- `plugin/tests/composition/fixtures/registry-churn.mjs` — fixture that triggers a real
  `tools/change` generation bump.

### Fixed

- **A malformed canonical event `seq` did not stop execution.** When a canonical `tool`/`result`
  pair carried an `undefined`, `NaN`, non-integer, negative, unsafe-integer, `null`, or missing
  `seq`, the undo was dropped while the pair was still counted as allowed. A valid `seq` is now
  required to be a non-negative safe integer, and events are classified by whether they affect
  state. An uncertain pending state call is sealed conservatively: the calls buffer is cleared and
  gates are placed before and after restore, `activeSelectedNames` returns `[]` while not ready so
  the outbound **mock provider** recording's final `GenerateOptions.tools` carries only the three
  entries, and a repeat of a pending event does not revive the sealed state. This is an
  availability-for-safety trade, not a universal claim: a malformed `seq` with a pending state call
  seals, a valid `seq` does not pass through this gate, and a valid-`seq` damaged load is
  unauthorised because it cannot be paired. Scope is `journal.mjs` only — projection, kernel, and
  guard are unchanged. On the real bus, `session.append` validates against its own `SessionSeq`
  before emitting, so a malformed or forged `seq` never reaches the journal; the defence is
  therefore exercised by driving `journal.onEvent` directly, and a real malformed bus is **not**
  covered.

- **A cold-recovery case that passed vacuously.** The previous `L01` case disposed its composition,
  which deleted the session `jsonl`, and read state through a `ctx.expose` handle that was always
  `undefined`, so the assertion block was skipped entirely. The harness is fixed and the case now
  asserts strictly.
- **Fork parent events entered the child session's restore fold.** *Proven:* a parent session's
  `tool_load` canonical pairs did reach the child's restore folding, where the kernel rejected them
  on `revision-mismatch`. *Not proven, and not claimed:* that a parent tool was ever activated,
  disclosed, or executed in the child — the child's first request carried only the three entries
  and a guessed parent tool never executed. Fork `reset` therefore held only because `revision`
  happened to differ between parent and child, with no ownership semantics behind it.
- **Own-only `seq` boundary in `plugin/adapters/dsh/journal.mjs`.** Only canonical pairs at
  `seq >= inheritedEventCount` are folded. The boundary is cross-checked between the public
  `query.readSession()` result and the live session; filtering works on `seq` values rather than a
  blind array slice; the merged stream must be contiguous from 0. Restore folding, the
  recovery-window buffer, and the live event path all apply the same boundary, so the inherited
  prefix is never folded, never observed, and never buffered. A missing, malformed, conflicting,
  or out-of-range boundary, or a gap in the `seq` stream, fails closed.

### Not claimed by this work

- The `readSession`-failure case is driven by **fault injection**; it does not represent a natural
  host fault.
- Cases `L03b1`–`L03b4` are **synthetic counterexamples**: they establish the boundary's semantics
  without claiming the host naturally produces malformed or same-`revision` event streams. The
  malformed `seq` values in the event-`seq` suite are likewise synthetic.
- **The `seq` gate and the event-`seq` suite have been independently reviewed and passed, within a
  scope limited to this round's three code files.** That is a code-level review result, not product
  acceptance, and it does not cover any source outside those three files.
- The author's assertion that host `seq` values are well-formed holds **only within the contract
  actually read**; this does not claim corruption is impossible. The end-to-end value of a
  corrupted persisted log is still unverified, and long fork sessions remain unverified at the
  product level.
- Compaction, the crash/fsync window, HMR, the receipt meta channel, and multi-scope concurrent
  registry churn remain uncovered. Coverage is not upgraded for them.
- The frozen quality result (21 checks, 20 PASS / 1 FAIL) and the public test prerequisites are
  unchanged by this branch.

## [0.2.0-functional.3] — trusted epoch baselines, and tool-churn cache consistency

Branch `feat/trusted-cache-epochs`. This entry describes **source** delivered by pull request.
The package is **not published to npm**, and no profile installation, GUI reload or application
restart is part of this delivery. Nothing here is a product-acceptance statement; the authoritative
per-item status is [`plugin/docs/05-current-status.md`](plugin/docs/05-current-status.md) and the
contract is [`plugin/docs/08-trusted-epoch-baselines.md`](plugin/docs/08-trusted-epoch-baselines.md).

`version` moves to `0.2.0-functional.3` because `0.2.0-functional.2` is already taken by the
released `build-c4a111c` asset; reusing it would make two different source states indistinguishable
to the plugin manager.

### Added

- **Durable epoch records replace outbound observation as the trust source.** A session's resident
  tool names are now read from and written to a record on the host-provided storage domain. An
  outbound `request`/`header` is an observation and is no longer treated as authorization: a model
  that guesses a name which once appeared in a persisted header no longer executes it.
- **A session with no epoch record stops explicitly and blocks its request.** The terminal state has
  **no default timeout** and never degrades to a reduced request. The current configuration hash is
  neither an epoch identity nor a trust predicate. A record that does not match its schema, and a
  storage service that cannot be opened, are reported as two separate terminal states with separate
  wording; a bad record is neither deleted nor overwritten by the current configuration.
- **One real user-initiated `/compact` migrates an old session**, and only when the canonical chain
  holds in one own session: run `compact` from `user`; `start.sourceCommandId` present with `turn`
  null; exactly one summary, correctly ordered; `end` without error; `done` successful with
  `sourceEventSeq == summary.seq`. Any failed condition means no migration, with no retry and no
  inference. A historical command chain is never a migration authorisation.
- **An already-trusted session keeps refreshing normally.** Any successful manual **or automatic**
  compaction adopts the latest configuration, writes a new epoch record and resets. Automatic
  compaction is a normal path and is not blocked; within one epoch the record alone is authoritative
  and is not replaced by the current configuration; a new epoch adopts the boundary configuration
  snapshot in full, without intersecting or inheriting the previous epoch's list.
- **Three new real-host gate suites** cover the authorisation surface, the I/O timing and fork
  isolation, the fourth baseline state, and the tool-churn cache path. Within one epoch, the write
  is awaited on the post-next agent / pre-step barrier, because SDK assembly runs before automatic
  compaction.

### Fixed

- **Late storage arrival could authorize a session that had to be migrated.** When the storage
  service became available after a session had already been blocked, the retry path reused the
  bootstrap path without checking whether the session had its own outbound history, and could write
  an initial record for it. A missing record is not by itself a qualification to create one: only a
  session with no outbound fact in its own segment qualifies, and the qualification now sits at the
  single exit through which all three bootstrap entry points pass.
- **A decided restore stopped emitting requests at all.** When the journal was sealed or
  `readSession` failed, the session's baseline stayed pending forever, which was read as "baseline
  not settled" and suppressed every outbound request — a hang, not the pre-existing fail-closed
  behaviour. That state is now a distinct fourth baseline state: the request is still emitted with
  the baseline only, the engine stays `incompatible`, and execution is still refused. Folding it into
  a blocked state would have invented a new "must not emit" rule and misaligned the request queue of
  other sessions in the same composition.
- **A removed-then-re-added tool became permanently uncallable.** The host appends `request/header`
  only when the header actually changes. After a tool was removed, re-added and loaded again, the
  outbound wire was byte-identical, so no new header event arrived, while the invalidation and the
  version change had both cleared its advertisement record — the tool stayed on the wire and in the
  selection yet every call failed with `TOOL_NOT_ADVERTISED` until the session was restarted. The
  journal now remembers the last observed header and replays the disclosure bookkeeping against it.
  No rejection rule is loosened: the digest is still compared byte for byte and the request identity
  is still the same header. This matters in production whenever an MCP server drops and reconnects.
- **Tool removal had no real-host coverage at all.** The existing churn fixture only ever **added**
  a tool, and the registry unit suite covered only the generation counter. Removal is a real
  production shape, so it now has a fixture that is removed by disposing its entry fiber, and gates
  asserting that a removed selection stops executing, that its old candidate reference is refused,
  and that an unrelated tool is unaffected.

### Changed (metadata only)

- `dependencies.zod` (`^4.4.3`) and an **optional** peer `@deepseek-ai/dsh-storage-domain`
  `0.2.1-alpha.1`. A production capture without that SDK blocks explicitly instead of attaching a
  provider automatically, and no storage backend is added. `private`, `files`, `exports` and the
  publishing policy are unchanged. The declared `zod` range is anchored to the real `4.4.3`
  observed in the host-provided SDK; the adapter takes `zod` from the host's own storage-domain
  dependency, so **dependency-isolated installation is still unverified** and is not claimed here.
- `test:composition` and the explicit host-composition list in CI both name the new gate files. CI
  installs no SDK implicitly and the portable skip list is unchanged; the portable unit and epoch
  suites stay pure portable.

### Verification boundary

- Local runs, commands and exit codes: `npm test` → **283 pass / 0 fail**, exit **0**;
  `npm run test:composition` → **103 pass / 0 fail / 0 skipped**, exit **0**. These were run by the
  author of this round against the real DSH Core `0.2.1-alpha.1` composition.
- One **non-author** review of the three security-boundary fixes returned **pass** on all three, and
  added the `failed-closed` and bad-record gates. Its own evidence is an internal report and is not
  part of this tree.
- **A known contract-level gap remains open and is not fixed here.** On the bootstrap branch the
  session's own-history qualification is derived from live counters without cross-checking stored
  history; an independent reviewer demonstrated the shape in memory but could not establish that a
  real host reports the contradictory counters it requires. It is recorded in
  [`plugin/docs/08-trusted-epoch-baselines.md`](plugin/docs/08-trusted-epoch-baselines.md), not
  silently closed.
- The review also left nine items uncovered, notably the canonical `tool_load` receipt chain as a
  positive authorisation source and the whole-domain open failure. Until those are covered this
  feature is **not** product-accepted.
- **Not claimed:** real-provider wire behaviour, token reduction, latency, GUI rendering and online
  migration are unverified. No cache-saving or latency measurement is claimed. The frozen quality
  result (21 checks, 20 PASS / 1 FAIL) is unchanged by this branch and the scoring data is still
  not publishable.

## [0.2.0-functional.4] — TE-R coverage for the canonical tool_load receipt chain

Branch `feat/tool-load-receipt-authorization`. **This round changes tests and documentation only; no
product source file is modified.** The package is **not published to npm**, and no profile
installation, GUI reload or application restart is part of this delivery. Nothing here is a
product-acceptance statement.

`version` moves to `0.2.0-functional.4` because `0.2.0-functional.3` is already taken by the released
`build-3c2ed533706e` asset; reusing it would make two different source states indistinguishable to the
plugin manager.

### Added

- **The canonical `tool_load` receipt chain is now gated as a positive authorisation source (TE-R).**
  The previous round's independent review listed TE-R among nine uncovered items, and it is the one
  that matters most for this feature: the durable epoch record is the authority for a session's
  **resident** names, but an **on-demand** tool must still be authorised by the canonical
  `tool/call`→`tool/result` chain. Nothing had proven that the record had not quietly replaced that
  chain as the authorisation source.
  The new gates make the two authorisation surfaces **separately** observable:
  - **TER0** — with the resident baseline explicitly empty, a real `tool_load` fold must produce the
    tool's selection, and the name must appear in **neither** `alwaysNameSet` nor the trusted record's
    `names`. Without both negatives the rest of the group would be a vacuous pass.
  - **TER1** — across a **real restart** (all services genuinely closed, the loader reopened on the
    same root, session resumed), the selection must be rebuilt by replaying the receipt chain from the
    persisted log, and a direct execution must reach the tool body (`isError:false`, body count 1).
    The baseline is empty for the whole sequence, so there is no other authorisation surface to borrow.
  - **TER2** — in that same restored session, a sibling hidden tool that was **never** loaded must
    still be refused with a zero body count. This is the anti-vacuity control: TER1 must not be
    obtainable by allowing everything after a restore.
- The gates resolve the selection through the **same** path the product uses
  (`plugin/domain/state.mjs:429` filters `selected.values()` by `.name`), because `selected` is a map
  keyed by canonical tool id (`global::…`), not by bare tool name.

### Fixed

- Nothing. No behavioural defect was found in this round: TE-R's property already held, and the gap
  was coverage. This entry therefore records **no** product change and claims no fix.

### Verification boundary

- Local runs, commands and exit codes: `npm test` → **283 pass / 0 fail**, exit **0**;
  `npm run test:composition` → **105 pass / 0 fail / 0 skipped**, exit **0** (was 103; +2 from this
  round), against the real DSH Core `0.2.1-alpha.1` composition on this machine.
- **The new gates were mutation-checked.** Short-circuiting `engine.applyCanonicalPair` in
  `plugin/adapters/dsh/journal.mjs` — i.e. removing the receipt chain as an authorisation source
  entirely — turns TER0 and TER1 **red**, together with the pre-existing TE0 and TE1c. The mutation was
  reverted and `journal.mjs` is byte-identical to `main`. TER0/TER1 are therefore not vacuous passes.
- **Author-run results are not acceptance.** Per the contract's own discipline, these runs were
  performed by the author of this round, so they do **not** upgrade any criterion to "passed" and do
  **not** discharge the outstanding independent review.
- **Still open, unchanged by this round:** the whole-domain open failure (`08 §2.4c`, one bad stored
  record makes every session terminal, still unfixed), the bootstrap-path contract gap (`08 §2.2a`,
  deliberately deferred), the remaining uncovered review items, the residual sign-off debt in
  `05 §5`, and the whole of `03 §11` stage 3 (real provider wire, token reduction, TTFT/retrieval
  experiments, npm publication and installation). This feature is still **not** product-accepted.

## [0.1.0] — prepared 2026-10-06, not published

> **Outcome, added after the fact:** this tree became the initial publish commit on `main`.
> The history was later rebuilt, so the commit IDs named in older entries no longer resolve; the
> entry below is kept as it was written at freeze time.
> No tag, no GitHub release, no npm publish, and no profile install accompanied it.

The first source baseline. This entry records what the tree contains; it does **not** describe a
publication event. As of this writing nothing has been pushed or released: no tag, no GitHub
release, no npm publish, no installation into any profile. The date is the day the tree was
frozen, not a release date.

### Added

- `plugin/domain/` — host-independent kernel: catalog, paginated list, natural-language search,
  candidate refs, canonical receipts, session state machine, budgets, error codes. Imports only
  `node:crypto` and its own relative modules.
- `plugin/adapters/dsh/` — DSH adapter: entry definitions, registry adapter, journal,
  system-prompt projection, execution guard, session and registry-change lifecycle, and a
  whole-group rollback path.
- Three-entry control protocol — `tool_list` / `tool_search` / `tool_load` — replacing a
  single-entry approach with a host-independent kernel behind it.
- `plugin/contracts/` — host seam probes that check the adapter's assumptions against a real
  Cordis Loader (`gate-runtime-contract.mjs`, `smoke-loader.mjs`, `install-resolver.mjs`).
- `plugin/tests/` — 8 kernel unit files (160 cases) and two real-Loader composition suites
  (14 + 7 gates).
- `plugin/quality/` — offline quality validator and freeze tooling.
- `plugin/docs/` — requirements and architecture, frozen protocol and data model, implementation
  and acceptance matrix, runtime evidence, and current status.
- `plugin/audits/`, `plugin/reports/` — internal review and implementation evidence. **Not
  published**; see the root README.
- Root documentation: bilingual README, `CONTRIBUTING.md`, `SECURITY.md`, and a pull request
  template.

### Fixed

- **D1** — the `load` candidate path did not check entry and framework-retained tool protection,
  so a `search → load(candidates) → fold` sequence could place a framework tool into the selected
  set.
- **D2** — the protection set was snapshotted once at engine construction and did not follow
  catalog refreshes.
- **D-1** — when `journal.restore()`'s `readSession` failed and the event buffer held no tool
  events, the state was set to ready through the "new session" branch, violating fail-closed
  semantics.
- An experimental `ok:false` → throw mapping on the entry error shell was reverted by cross-review;
  the three entries return the standard error envelope, and activation is enforced by the two-part
  `isError` / `ok` check on the fold side.

### Changed

- Layout migrated from the phase-codename `progressive-v2/` to the responsibility-named `plugin/`.
  Same-volume subtree rename; internal relative paths unchanged. Recorded in the internal
  migration report.
- Root `package.json` repointed at `plugin/adapters/dsh/index.mjs` and `plugin/domain/index.mjs`,
  with `@deepseek-ai/dsh` and `@deepseek-ai/dsh-tools` at `0.2.1-alpha.1` declared as peer
  dependencies (host-provided; the adapter imports `defineTool` by bare package name when no
  injection is supplied).
- Stale `0.0.1-rc.2` `minimumReleaseAgeExclude` entries removed from `pnpm-workspace.yaml`.
- `.gitignore` anchored to the new layout; the root `docs/` pattern is now `/docs/` so it no
  longer swallows `plugin/docs/`, and the private evidence directories are ignored by their new
  paths.

### Known issues

- The quality validator reports **20 PASS / 1 FAIL** and exits 1. The failure is a category
  eligibility defect in the frozen dataset: three held-out samples (`H037` ×2, `H044` ×1) expect
  answers whose `trustedCategory` differs from the queried category, so they are unreachable by
  construction.
- `check:quality` cannot run on a fresh clone, because the frozen scoring dataset is not
  published. This is a consequence of that dataset being AI-synthesized and not human-reviewed,
  not a broken script.
- Token reduction, TTFT, and real-provider wire behaviour are unmeasured. No performance claim is
  made anywhere in this repository.
- Two review-signature debts remain open: the author of the entries rollback fix was also the
  cross-reviewer, and the D-1 fix author is unattributed. Both are awaiting a fresh independent
  review, per the "authors do not sign their own security boundaries" rule.

<!-- No version-link references are defined below: no tag or release exists to link to. Add
     them at the same time as the actual release, not before. -->

