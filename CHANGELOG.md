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

## [Unreleased] — runtime stability and retrieval quality

Source version stays `0.2.0-functional.6` (**not bumped**). **The package is not published to npm**,
and this round performs no install, GUI reload or application restart. This entry makes **no**
product-acceptance claim: see [`plugin/docs/05-current-status.md`](plugin/docs/05-current-status.md)
for the authoritative per-item status.

### Fixed — failed load settlement and default navigation

- A `tool_load` body could reserve budget, then cancellation or a post-policy block replaced
  its result with plain error text. The canonical result removed the journal's live call but
  bypassed `applyCanonicalPair`, leaving an orphan pending reservation. The journal now cancels
  **only the matched operation** when its terminal result cannot be parsed as the protocol
  envelope. Selected tools, advertisement/frozen caches and unrelated pending calls are unchanged;
  successful results still go through receipt verification. No broad `turn/end` cancellation added.
- `tool_list {}` now returns category navigation. Omitting `view` **with** `category` still means
  `available`, preserving existing calls. Explicit `available` / `loaded` still require `category`;
  null/empty values and unknown fields are not made valid. Both language descriptions and the
  protocol specification agree with this conditional default.
- Regression tests include pre-fix RED evidence, plain/rewritten error results, success positive
  control, unrelated/duplicate/late results, unchanged selection/disclosure state, and real Loader
  post-policy rejection and user cancellation after the body. Mock provider recordings are not
  external provider wire or GUI cancellation acceptance.

### Changed — developer workflow and documentation

No product source behaviour changes in this group.

- **One command set.** `npm test`, `npm run test:composition`, `npm run test:all`, `npm run check`,
  `npm run check:quality`, `npm run clean`. `test:composition` now runs the glob
  `plugin/tests/composition/gate-*.test.mjs` instead of a 14-file list that had to be kept in sync
  by hand in `package.json` **and** `ci.yml`; a new gate file is picked up with no other edit.
- **`scripts/check-repo.mjs`** holds the identity and documentation gates that used to be inline
  shell in `ci.yml` (name match with `cordis.patch.yml`, private package, no vendor scope, no stale
  former-name references, README pair, relative-link resolution, unmeasured-saving claims). CI calls
  the same script, so the two jobs `identity` and `docs` collapse into one `repo-checks` job and the
  checks run locally. The manual composition CI job now calls `npm run test:composition`.
- **`ci.yml`**: the release-asset job runs for `main` only; the hard-coded development branch name
  `fix/discovery-functionality` is gone.
- **Composition temp files no longer accumulate.** `contracts/harness.mjs` removes every temp root a
  test process created when that process exits (`DSH_KEEP_TMP=1` keeps them). A cleanup that ran
  before host-side asynchronous persistence finished used to leave directories behind; the
  exit-time pass covers that. `plugin/fixtures/tmp/` had grown to 185 directories. `npm run clean`
  clears leftovers (`--all` also removes `.functional-dist/`).
- **Stale `progressive-v2/` paths** in source comments, usage lines and recorded `command` strings
  now say `plugin/`. The migration notes in `CONTRIBUTING.md`, `.gitignore` and `plugin/docs/` keep
  the old name on purpose, because they describe the migration.
- **Docs aligned.** [`plugin/docs/05-current-status.md`](plugin/docs/05-current-status.md) is rewritten
  as a current snapshot (conclusions, numbers, open items) instead of a layered per-round narrative:
  stale counts (unit 160, composition 42) are replaced by a dated re-run, and the per-round detail
  stays in this changelog, in `08` and in the private evidence. `plugin/docs/README.md` §2.1/§5,
  both READMEs, `plugin/README.md` and `CONTRIBUTING.md` use the npm scripts and no longer hard-code
  counts or say which suites "depend on the branch".

### Fixed — functional

- **The restore buffer is never released for a new session.** `journal.mjs` buffered every
  `session/event` — including each `request/header`, whose payload carries the full outbound tools
  array — and the buffer is bounded **by time, not by size**. It was only closed on the `restore()`
  success path or on `dispose()`, but `ensureRuntime` takes the bootstrap branch for **every**
  session with `seq === 0`, and that branch never reads a snapshot. The result was unbounded growth
  for the whole session lifetime, into an array nothing ever reads again. `stopBuffering()` is now
  explicit and idempotent on the bootstrap branch, on fail-closed and on dispose, and the file-header
  comment no longer implies a size cap. `MAX_BUFFERED_EVENTS` bounds a *different* buffer (the
  pre-runtime one) and never bounded this one.
- **Any unrelated tool registration invalidated every live candidate ref and list cursor.** The host
  broadcasts `tools/change` for a register / dispose / restrict in **any** scope, and
  `refreshCatalog` ran for every live session on every broadcast with an unconditional
  `eligibilityGeneration += 1` plus `dropForEligibility` — so one unrelated plugin registering a tool
  forced the model to redo its search. `refreshCatalog` is now **content-aware**: an order-sensitive
  identity fingerprint over exactly the fields `buildEntry` derives identity from is compared first,
  and an unchanged catalog returns without rebuilding, without bumping the generation and without
  dropping refs. Real changes keep the original path. The fingerprint includes the **derived
  categories** and the **skill text**, because those decide `orderDigestByView` and
  `searchDocumentId`. `orderDigestByView` also gained the missing **`available:all`** entry — without
  it, the most-used browsing view bound a constant cursor digest that no catalog change could kill.
  `engine.handleList`'s available view now reuses `catalog.orderedNamesFor`, so the paged order and
  the cursor digest cannot diverge.
- **`engine.cancelOperation` had no production caller**, so a `tool_load` whose turn never produced a
  canonical `tool/result` held its budget reservation for the rest of the session. It is now called
  from `abandonLiveCalls()` on the terminal discard paths. `settleCompactionEnd` deliberately does not
  call it: the following `resetCacheEpoch` already drops that session's pending entries.
- **Chinese search mostly returned nothing.** Entry documents were tokenised from the English
  controlled category ids plus (in practice) English summaries, so a Chinese query only ever matched
  through the controlled synonym table — a measured `读取文件内容` returned **0** candidates. Each
  entry's category field now also carries the category title and capability summary in **every**
  supported locale, so one language-neutral index serves both query languages.
- **Synonym evidence outranked direct name evidence**, so `read file contents` ranked `grep` above
  `read_file`. Synonym credit is now halved **only** when a document's name matched zero query terms;
  documents whose name already matched keep the previous weight, so no existing ordering moved.
- **A candidate dropped by the result byte budget still left its ref in the store.** Refs are now
  minted after the budget decision, with an equal-length placeholder so byte accounting and truncation
  boundaries are unchanged.
- **`tool_load` candidate `revision` is now genuinely optional end to end.** The behaviour already
  existed in `engine` / `state`; the model-visible description, the JSDoc types, `docs/01 §5.4` and
  `docs/02` were still describing it as required, and the wire contract accepted "absent" only as an
  **absent key** — `null` and `""`, which models routinely emit for optional fields, were rejected.
  All three spellings now mean "take the version the ref is bound to", while numbers, objects, arrays
  and booleans stay `INVALID_ARGS`. The key is **dropped** rather than passed through, because the
  engine reads `item.revision ?? rec.revision` and `??` does not catch `""`.
- **Two wrong-text defects**: `ENGINE_DISPOSED` was looked up under `error` although the key is
  top-level, so every post-`dispose()` guard rejection carried `reason: undefined`; and
  `toDomainError` fell back to English while the `DomainError` constructor fell back to the bound
  interface language, so one failure could mix languages.

### Changed — two pre-existing tests

`load.test.mjs` ("目录代次变化后旧 ref 失效") and `review-fixes.test.mjs` (R04) each triggered their
subject by refreshing with a byte-identical binding set, relying on the unconditional generation bump.
They now trigger it with a genuinely different catalog (an added tool; a changed wire). Each new
expectation matches its test name more closely than the old one did; the R04 invariant it protected
(monotonic counter, no wall clock, distinct generations under a frozen clock) is unchanged.

### Verification boundary

Commands run on this branch, with the numbers from those runs:

- `node --test plugin/tests/unit/*.test.mjs` → **349 pass / 0 fail / 0 skipped**, exit 0 (was 308
  before this round; +41 from four new files).
- `npm run test:composition` → **108 pass / 0 fail / 0 skipped**, exit 0, across **14** host
  composition files against the real DSH Core `0.2.1-alpha.1` composition on the default install root.
- `node plugin/quality/validate.mjs` → **20 PASS / 1 FAIL**, exit 1 — the **pre-existing** category
  eligibility failure (held-out H037 ×2, H044 ×1), unchanged by this round and not whitened.
- Document relative links: 16 files, 0 dangling.

### Not fixed, and why

- **A `tool_load` cancelled mid-turn still holds its reservation.** A cancelled turn produces no
  canonical `tool/result`, so the journal never observes that call again. The only abort-adjacent event
  with evidence in-repo is `turn/end`, and `plugin/contracts/gate-runtime-contract.mjs` shows only that
  it is recorded on a **normal** completion — it does not establish that it cannot race a late
  `tool/result`. Cancelling there risks discarding a legitimate late fold (leaving the tool stuck at
  `TOOL_NOT_ADVERTISED`), which is worse than the leak, so this was left alone rather than guessed.
  What is needed: a host-verified statement of the `turn/end` → `tool/result` ordering on the abort
  path. The fix is then one `turn/end` branch calling `abandonLiveCalls()`.
- **The skill capability is still not wired.** `registry.mjs` passes `skill: null` unconditionally, so
  every `tool_load` returns `skills: []`, `skillRevision` is always `none`, and `skills.mjs` is dead
  code in the only shipped adapter — while `docs/01 §1.2` lists it as one of six product capabilities.
  That is a product decision (wire it, or take it out of the capability list), not a bug fix.
- **`tool_list` with no arguments still fails.** `view` defaults to `available`, and available /
  loaded require a `category`, so the model's most natural first call lands on `INVALID_ARGS`.
- `STALE_CANDIDATE` is largely unreachable (a definition change bumps the generation and kills the ref
  first, yielding `CANDIDATE_UNAVAILABLE`); pre-existing semantics, not introduced here.
- Not touched: dead exports, the uncleaned `registry` generation / last-seen / binding-state maps,
  and the double locale accessors in `engine.mjs`. (The `docs/01 §1.3` inverted-index wording named
  here when this entry was written has since been aligned in the follow-up
  `docs/align-stale-wording` branch, together with the two duplicate `SYNONYM_GROUPS` triggers.)

### Review required

This round changes the eligibility-generation invalidation surface and the load / unload state machine
in `plugin/domain/`, so by the rule in [`CONTRIBUTING.md`](CONTRIBUTING.md) it **cannot be signed off
by its author**. A non-author review should concentrate on two judgements: whether the identity
fingerprint's field set matches exactly what downstream consumers read, and whether skipping session
invalidation on the fast path is always safe.

## [0.2.0-functional.6] — release preparation: restore settlement, TE-R strengthening, and the pending-settlement gates

Source version `0.2.0-functional.6`. **The package is not published to npm**, and this round performs
no install, GUI reload or application restart. A GitHub Release asset is built automatically by the
`publish` job on a green `main` run (`build-<sha>` tags, named `v<version> · <sha>`); **this entry is
written before that release runs and does not claim it has already happened.** No semantic tag is
created for this version: the tag-triggered job runs host-bound unit files and cannot complete on a
hosted runner.

### What this version carries

Earlier entries are consolidated rather than rewritten. `0.2.0-functional.5` **is already published
as a GitHub build release** (`v0.2.0-functional.5 · 1049d47f920d`, tag `build-1049d47f920d`, commit
`1049d47f920d…`); the two `[Unreleased …]` sections **after** it were workspace work that had not been
released and are carried into this version for the first time. Those sections are kept exactly as
written — they remain the record of that moment.

- **Restore settlement (F3), two mechanisms.** A `load()` / `begin()` superseded by a later live
  user `/compact` no longer returns `PENDING` / `null` and have it adjudicated as a failure with a
  `null` attribution; and the bootstrap qualification decision and the start of the initial record now
  happen in **one synchronous block**, removing a microtask window in which a real manual migration
  could be reverted to `initial` plus the then-current configuration. No ledger API, state, reason
  or timeout was added.
- **TE-R gates strengthened** after a non-author review: a real restart is pinned, the
  scope-resolution precondition and the rejection code are asserted, and a silently skippable release
  probe was removed.
- **Pending-settlement gates (TS1 / TS2)** — one new real-host composition file with two cases, on a
  real Loader, adapter, runtime / journal / ledger, agent and user `/compact`; no `createLifecycle`
  fake and no mock `apply`. `TS1` pins the **own-segment-empty bootstrap** post-begin adjudication
  (its only injection is a `table().put` barrier); `TS2` pins the **legacy cold-restore** entry (a
  gate **before** the real `facility.open()`, a `put` barrier after the domain opens, and a read-only
  pass-by on `ledger.load` returning the same original promise). Cross-checked on private copies:
  rolling back the post-begin adjudication turns **TS1 red / TS2 green**; rolling back the legacy
  entry to its pre-F3 shape (a single `load()`, a single adjudication) turns **TS2 red / TS1 green**.
- **`TE-U19`**, one portable unit case pinning the record-key contract: the key comes from the
  identity frozen at record construction, a late-resolving old write does not overwrite the runtime
  `identity` / `names`, and a cold restore aligned to the newest identity reads that record. It makes
  no claim about the real SDK's internal commit / enqueue timing, and does not assert that the old
  write can never land.

### Verification boundary

- `npm test` → **296 pass / 0 fail / 0 skipped**; `npm run test:composition` → **108 pass / 0 fail /
  0 skipped** across **14** host-composition files, against the real DSH Core `0.2.1-alpha.1`
  composition. Earlier rounds' recorded numbers stand as written and are **not** added to these.
- Fingerprints: gate `DD691EBA…`, unit `8D37D411…`; ledger `228ADEC7…`, `lifecycle.mjs` `68AFA230…`,
  earlier settlement unit `D2451321…`, TE-R gate `3FA2A991…`. Non-author limited reviews passed on
  the TE-R gates, the F3 fix, the settlement gate file and the record-key unit.
- **This entry does not claim the absence of defects, and it is not whole-feature acceptance.**
  Still open: the `08 §2.2a` bootstrap contract gap (not demonstrated online, authorisation behaviour
  unchanged), the old **F4** window as a whole, the remaining uncovered review items, and all of
  `03 §11` stage 3 (real wire / token / TTFT / retrieval thresholds). The frozen quality result
  (21 checks, 20 PASS / 1 FAIL) is unchanged. The feature remains **WIP / not product-accepted**, and
  no token saving, latency improvement or online behaviour is measured or claimed.

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

## [0.2.0-functional.5] — one bad stored record no longer stops every session

Branch `feat/trusted-epoch-isolated-bad-record`. This entry describes **source** delivered by pull
request. The package is **not published to npm**, and no profile installation, GUI reload or
application restart is part of this delivery. Nothing here is a product-acceptance statement; the
contract is [`plugin/docs/08-trusted-epoch-baselines.md`](plugin/docs/08-trusted-epoch-baselines.md).

`version` moves to `0.2.0-functional.5` because `0.2.0-functional.3` is already taken by the
released `build-3c2ed533706e` asset, and `0.2.0-functional.4` is carried by the separate TE-R
coverage branch, which has since merged into `main` and whose entry is recorded above.

### Fixed

- **One unreadable stored record stopped every session in the domain.** When the host's storage
  domain opened the trusted-epoch table it validated *every* stored record, and a single failure
  aborted the whole open. The damage was local — one unreadable row — but the effect was global:
  sessions whose own records were perfectly healthy, and which had nothing to do with that row,
  were driven into a terminal state as well. A bad record now stops **only its own session**, and
  the rest carry on: ready, and actually sending requests.
- The trusted-epoch table's SDK-side schema is now a **transport shape** rather than the authority.
  Judgement moved back to the module's own per-session validators, which were already there and are
  in fact stricter than the schema they replace: they compare the record's key set exactly, reject
  duplicate names, and additionally check the record against the current epoch identity.
  **No media is touched.** A bad record is still never deleted, overwritten, or quarantined.

### Changed

- The SDK ships an escape hatch for exactly this, `invalidRecords: 'backup-and-skip'`, and this
  release deliberately does **not** use it. It requires the unit to implement `backupRecord`, which
  exists only on the `per-record` layout unit; this spec declares `layout: 'single'`, whose unit has
  no `backupRecord`, so the SDK would throw at the very same line and the flag would be a no-op.
  Switching layouts would additionally require replacing the `JSON.stringify([...])` record key with
  a path-safe one, which is a destructive change with a data migration attached.
- The unit test that pinned the old contract — asserting the table schema was a `strictObject`
  whose field list matched the validator — now pins the new one: the transport schema accepts
  anything, **and** every record the old schema used to reject is still rejected by the per-session
  validators. Moving the authority is only legitimate if the authority is demonstrably intact.

### Verification boundary

The two entries above are **separate rounds**; their workspace numbers are recorded per round and are
**not** additive claims.

- `0.2.0-functional.4` round (TE-R, author-run): `npm test` → **283 pass / 0 fail**, exit **0**;
  `npm run test:composition` → **105 pass / 0 fail / 0 skipped**, exit **0** (was 103; +2), against
  the real DSH Core `0.2.1-alpha.1` composition on that machine. The gates were mutation-checked:
  short-circuiting `engine.applyCanonicalPair` in `plugin/adapters/dsh/journal.mjs` turns TER0 and
  TER1 **red**, together with the pre-existing TE0 and TE1c; the mutation was reverted and
  `journal.mjs` is byte-identical to `main`.
- `0.2.0-functional.5` round (bad-record isolation, author-run): `npm test` → **283 pass / 0 fail**,
  exit **0**; `npm run test:composition` → **104 pass / 0 fail / 0 skipped**, exit **0** (was 103;
  +1), against the real DSH Core `0.2.1-alpha.1` composition. The new criterion was written
  **before** the fix and went red first: with the schema strict, the bystander session received
  `incompatible` instead of `ready`. It covers four things — the affected session still ends
  `INVALID` with zero outbound requests (**not** relaxed by this fix), the innocent session in the
  same domain is `ready` **and** emits requests, the bad record is still on disk unmodified, and the
  injection provably touched only the one row. Discriminating power was mutation-checked: restoring
  a `strictObject` transport schema turns the new criterion red. The mutation was reverted.
- **Both rounds merged into one tree, re-run in this workspace (2026-10-07, exit codes as recorded):
  `npm test` → 283 pass / 0 fail, `npm run test:composition` → 106 pass / 0 fail / 0 skipped**
  (103 baseline + BR4 + TER0 + TER1/TER2), logs in `.probe/pr5-merge-unit.log` and
  `.probe/pr5-merge-comp.log`. This is a third author-side run; it merges the two suites and claims
  no new criterion.
- **Non-author review, limited scope (2026-10-07, PR5): pass.** The reviewer is not the author of
  that round. Scope is **only** the bad-record isolation fix and the conflict merge — it is **not**
  feature-wide acceptance. Independent re-runs: `npm test` → **283 pass / 0 fail**,
  `npm run test:composition` → **106 pass / 0 fail / 0 skipped**; documentation cross-references and
  section numbering check out with no broken links. Discriminating power was reproduced
  independently on a **private copy**: restoring the old `strictObject` transport turns **BR4b red**
  (bystander session `incompatible` instead of `ready`, exit **1**). **Product source was not
  touched**; the mutation exists only in that private copy. The author-side records above are kept as
  written and are not rewritten.
- **TE-R non-author review, limited scope (2026-10-07): pass.** Scope is **only** the TE-R gates and
  their strengthening, over baseline snapshot `1049d47` plus the final gate file
  (SHA256 `3FA2A991…B320401`). Reviewer measurements: gate file **14/14 green**; cutting the
  cold-restore replay leaves **TER0 green** and turns **TER1 red** (so TER1 is not a restatement of
  TER0); an over-permissive guard turns **TER2 red**; a fake close (`closeServices` as a no-op) turns
  **TE9 and TER1 red** with `actual: false / expected: true`. The three **test** findings — TER1 not
  pinning a real restart, TER2 missing the scope-resolution precondition and the rejection code, and
  TE9's release probe being silently skippable — are **closed**.
  **Naming:** that third finding is a *test* finding (TE9's probe could be skipped); it is **not** the
  product-side **restore-settlement race**, which is handled separately in the follow-up section below.
  This review excludes the concurrent `lifecycle.mjs` work and the newly added unit gate and is
  **not** feature-wide acceptance.
- **What is still open:** the `08 §2.2a` contract gap (not demonstrated online, no change to the
  authorisation behaviour), the remaining uncovered review items, and all of `03 §11` stage 3. The
  feature as a whole is **still not product-accepted** and still **WIP**.

## [Unreleased follow-up] — restore-settlement (F3) narrow fix, limited review, not published

**Not a release.** The source version stays `0.2.0-functional.5` and `package.json` is unchanged; this
is workspace work **after** that entry and belongs to no published version. Nothing here is published,
installed or restarted.

### Fixed

- **`PENDING/null` was mis-adjudicated as a failure.** When a `load()` / `begin()` is superseded by a
  later live user `/compact` adopt inside its own `await` window it returns early with
  `PENDING/null`. The caller judged the state once and ran `blockBaseline`, producing a `reason=null`
  attribution, an emptied name set, a fail-closed engine and `restoring` flipped to `false` while the
  real state later flipped back. Settlement now follows the newest in-flight work to a terminal state.
- **A microtask TOCTOU after the bootstrap qualification check.** If the "missing and eligible"
  decision handed back a snapshot and the initial record only started after an outer `await`, a live
  migration arriving in that gap was superseded by the stale initial record — a real manual migration
  silently reverted to `initial` plus the then-current configuration. Decision and initiation now
  happen in the **same synchronous block**; only the resulting promise is awaited outside. Awaiting the
  newest in-flight write is not bypassed, and **no** ledger API, state, reason or timeout was added.

### Verification boundary

- The canonical `/compact` chain, the scheduling point and the fake store are **declaratively
  injected counterexamples against the product code**; they show product behaviour under that
  ordering and are **not** a claim that the window reproduces online. The real-host regression
  evidence is `npm run test:composition` → **106 pass / 0 fail / 0 skipped**.
- Non-author **limited** review (read-only snapshot): new unit **12/12**, real-Loader subset
  **37/37**, the new case turning red when the synchronous initiation is reverted, and the pre-existing
  legacy / post-begin cases still red. Independent final check: `npm test` **295/295**,
  `npm run test:composition` **106/106/0 skip**, no broken links across the doc set. Snapshot
  fingerprints: `lifecycle.mjs` SHA256 `68AFA23071A78AEC…`, new unit `D245132120B5C790…`;
  `trusted-epoch.mjs` (`228ADEC7…`) and the TE-R gate (`3FA2A991…`) are **byte-identical to base**.
- **Still open:** the `08 §2.2a` contract gap (not demonstrated online, authorisation behaviour
  unchanged), the old **F4** narrow window (unreviewed), `retryBaseline`'s existing `restoring=false`
  window that still reuses the previous blocked reason and keeps **0 requests** (unchanged this round),
  and all of `03 §11` stage 3. Whole-feature acceptance is **not** claimed; the tree stays **WIP**.

### Follow-up added after the entry above — pending-settlement gates and the record-key unit

Tests and documentation only; the product source exercised is the unpublished F3 change above.
Version stays `0.2.0-functional.5`; nothing is published, installed, reloaded, restarted or bumped.

- One new real-host composition file with **two cases**
  ([gate-trusted-epoch-settlement.test.mjs](plugin/tests/composition/gate-trusted-epoch-settlement.test.mjs)):
  `TS1` is **own-segment-empty bootstrap** (only injection: a `table().put` barrier on the real
  storage domain); `TS2` is **legacy cold restore** (injections: a gate **before the real
  `facility.open()`**, a `put` barrier after the domain opens, and a **read-only** pass-by on
  `ledger.load` returning the **same original promise**). Neither may settle or authorise inside the
  window; once the **newest `manual` write** is released both must be `ready` / `trusted` with the
  boundary-captured names, an epoch matching the journal and the durable record, and the **same**
  pending user turn then emitting **exactly one** request. Rollbacks cross: post-begin → **TS1 red /
  TS2 green**; legacy in its pre-F3 shape → **TS2 red / TS1 green** (a rollback dropping the `load()`
  altogether only fails a precondition and is not decisive). They pin separately repeatable
  settlement contracts and do **not** show that a real host naturally produces either window.
- One new portable unit case `TE-U19`
  ([unit/trusted-epoch.test.mjs](plugin/tests/unit/trusted-epoch.test.mjs)): a declaratively injected
  test store pins record-key isolation, no runtime overwrite by a late write, and cold restore by
  newest identity, making **no claim about the real SDK's internal commit / enqueue timing**.
- `test:composition` names that one file; the explicit host list in CI gains one line.
- `npm test` **296/296/0 skip**; `npm run test:composition` **108/108/0 skip** over **14** files.
  Fingerprints: gate `DD691EBA…`, unit `8D37D411…`; ledger `228ADEC7…`, `lifecycle.mjs` `68AFA230…`,
  earlier settlement unit `D2451321…`, TE-R gate `3FA2A991…` are **byte-identical to the previous
  round**. Earlier rounds' numbers stand as written and are **not** added or whitened.
- Still **WIP**: the old **F4** window is **not closed as a whole**, `08 §2.2a` and the remaining
  uncovered items and `03 §11` stage 3 are open, the frozen quality result is unchanged, and this is
  **not** whole-feature acceptance. Detail: [08 §5.6](plugin/docs/08-trusted-epoch-baselines.md).

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

