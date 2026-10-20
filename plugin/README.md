# DSH Tool Discovery — development guide

Source manifest: `0.4.2`. Start with the [current contract](<docs/00-current-contract.md>),
[architecture](<docs/01-requirements-and-architecture.md>) and [verification status](<docs/05-current-status.md>).
The numbered historical documents retain their original evidence; they are not the current defaults.

## Layout

| Directory | Responsibility |
|---|---|
| [domain/](<domain/>) | Host-independent catalog, search, protocol, budgets and state transitions; no host imports or filesystem I/O |
| [adapters/dsh/](<adapters/dsh/>) | Registry eligibility, native/PTC projection, canonical journal, execution guard, activation lifetime, optional durable epoch store and Config |
| [client/](<client/>) | Existing lazy CJS settings page and isomorphic model helpers; no separate frontend build step |
| [contracts/](<contracts/>) | Real-Loader test harness and installation-anchored resolver; not the production import path |
| [fixtures/](<fixtures/>) | Composition fixtures; generated `tmp/` content is private |
| [tests/unit/](<tests/unit/>) | Portable kernel/adapter tests **and two host-bound files** |
| [tests/composition/](<tests/composition/>) | `gate-*.test.mjs`, requiring an actual resolvable DSH installation |
| [quality/validate.mjs](<quality/validate.mjs>) | Published tooling that still requires a private scoring dataset |

## Verify from the repository root

The manifest requires Node `^22.19.0 || >=24.0.0`. The manifest declares no build or TypeScript-compile script.
Read actual command output and exit codes; a skipped suite is not a pass.

| Command | Prerequisite / meaning |
|---|---|
| `node scripts/check-repo.mjs` | Identity, published-document paths and a limited unmeasured-claim check; not a semantic documentation audit |
| `npm test` | Every unit file, including the two host-bound files below |
| `npm run test:composition` | All composition gates; requires compatible, resolvable host peers |
| `npm run test:all` | Unit followed by composition; stops if the first stage fails |
| `npm run check:quality` | Private queries/labels; unavailable on a normal public checkout |

### Portable unit subset

The same explicit two-file exclusion used by CI is reproducible in Bash:

```bash
files=()
for file in plugin/tests/unit/*.test.mjs; do
  case "$file" in
    */client.test.mjs|*/settings.test.mjs) ;;
    *) files+=("$file");;
  esac
done
node --test "${files[@]}"
```

`client.test.mjs` resolves React and `settings.test.mjs` resolves schemastery from an installed DSH at import time.
They cannot load on a Node-only checkout. The other unit files use published fixtures, including
[the synthetic protocol catalog](<quality/fixtures/catalog.invented.json>), not the private quality labels.
Do not call the portable subset a successful full `npm test`.

### Host-dependent tests

[install-resolver.mjs](<contracts/install-resolver.mjs>) anchors resolution at an installation's manifest.
`DSH_INSTALL_ROOT` can override its default **unpacked** installation root. A directory with only an ASAR archive
is not automatically a normal Node package tree; this resolver does not extract ASAR or install missing peers.
Confirm actual package resolution before running host-bound or composition tests. Do not modify a profile or
install dependencies to conceal a verification gap.

Composition creates ignored temporary session data under `plugin/fixtures/tmp/`; the harness normally removes
its own data on exit. `DSH_KEEP_TMP=1` retains it. `npm run clean` is a separate deletion operation, not a required
verification step; inspect its scope before using it.

## State and budget rules that tests must preserve

- Selection is committed from matched canonical successful results, not from returning `ok:true` in a body.
- Call seq attributes a pair; result seq orders its commit. Live and replay order must agree.
- Native frozen wire is a disclosure cache, not execution permission. Same-name schema conflicts require successful compaction.
- Schema footprint deduplication does not suppress delivery of a new skill revision. An uncommitted pending response is not proof that guidance arrived; only a committed same-version selection permits skill omission.
- All optional hard caps default to `null`; positive integers opt in. Defaults 20/5 still paginate, and explicit max limits also cap omitted-limit defaults.
- List/search byte caps measure the **entire successful JSON envelope**. State only truncates invalidation diagnostics with a marker; errors and host wrappers are outside that success cap.
- Active schema caps cover the deduplicated on-demand selected/frozen/pending footprint, not the initial baseline. Over-budget loads reject additions rather than evict disclosed tools.
- `initialSchemaTargetTokens` and `maxInitialBytes` are unused historical targets, not an enforced or measured initial token budget.

Source of truth: [constants](<domain/constants.mjs>), [engine](<domain/engine.mjs>), [state](<domain/state.mjs>),
[protocol](<domain/protocol.mjs>) and [design-invariants regressions](<tests/unit/design-invariants.test.mjs>).

## Evidence and remaining boundaries

A real Loader plus mock provider proves composition, not external provider wire. A client factory evaluated in a VM
is not DOM rendering. Earlier DOM probe records are dated evidence, not proof of this source snapshot's online GUI.
PTC SDK freezing/stable append/restart, crash/fsync, provider wire, retrieval metrics and performance remain separately scoped.
See [current status](<docs/05-current-status.md>) rather than copying historical test totals.

Private `reports/`, `audits/`, scoring queries/labels and generated session data remain unpublished. Never force-add them
or link public documentation into them. Use [CONTRIBUTING](<../CONTRIBUTING.md>) for branch/review policy and
[SECURITY](<../SECURITY.md>) for vulnerability reporting. Security-boundary authors do not approve their own changes.
