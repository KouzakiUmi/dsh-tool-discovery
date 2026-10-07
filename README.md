# DSH Tool Discovery

Give a model a few small control entries instead of hundreds of tools, and let it load the
capability it actually needs, on demand.

This is a DSH plugin. On the first request the model sees three fixed entries — `tool_list`,
`tool_search`, `tool_load` — plus a short summary of each capability category, **plus DSH's own
core tools**, which are the default initial list. Other ordinary tools are not disclosed up front.
When the model decides it needs one, it calls `tool_load`, and that tool's real native schema
appears in the **next** request. The model then calls the tool normally, through DSH's own approval,
sandbox, and permission chain.

Two invariants bound the whole design:

- **Loaded order and content are append-only within a cache epoch.** A load never moves or rewrites
  an already-disclosed entry — the wire recorded at first disclosure is what keeps being sent, so a
  host-side tool upgrade cannot silently mutate a definition the model has already read.
- **Only a successful compaction resets the epoch.** A manual `/compact` and DSH's automatic
  compaction both qualify; a failed, cancelled, or summary-less compaction does not. The model cannot
  unload: `action: "unload"` is rejected, so between two successful compactions the disclosed set
  only grows.

Frozen wire is not execution permission. A disclosed tool still goes through the host's own
approval, sandbox, and authorization checks on every call, exactly as if it had never been mediated
by this plugin.

Progressive disclosure is about context, not speed: a request that carries only what the model is
likely to use does not have to carry everything the host could have offered. The kernel holds no
tools of its own and never bypasses the host.

## The three entries

| Entry | Answers | Changes what is active? |
|---|---|---|
| `tool_list` | What tools are discoverable in this category? | No |
| `tool_search` | Which tool suits this task? | No |
| `tool_load` | I want these tools. | Yes |

`tool_load` never runs the target tool. It records the selection, and disclosure happens on the
following turn. Reaching for a tool that has not been loaded is refused, and unloading is not a
model action at all — only a successful compaction clears the disclosed set.

## Requirements

- DSH Core **`0.2.1-alpha.1`**. Other versions are untested; the host interfaces this plugin
  depends on are specific.
- The native **`@deepseek-ai/schemastery`** peer is required for the config surface and the settings
  panel. Without it the discovery domain still runs normally, but there is no Config and the plugin
  logs `ConfigUnavailable` instead of silently pretending a settings page exists.
- **Native** tool display mode. Other display modes are refused at activation rather than
  downgraded silently.
- **One active agent per session.** Concurrent agents in a single session are not supported,
  because a request cannot be attributed unambiguously.
- Node `^22.19.0 || >=24.0.0`.

## Get the source

The plugin is not published to npm, and no installation channel has been verified. Clone the
repository:

```sh
git clone https://github.com/KouzakiUmi/dsh-tool-discovery
cd dsh-tool-discovery
```

The current source version is **`0.2.0-functional.6`**. A GitHub Release asset is built automatically
from every green `main` run, and it is a **build artifact, not an acceptance statement** — what this
version covers and what it deliberately does not claim is recorded in
[current status](plugin/docs/05-current-status.md).

It is plain JavaScript with no build step, and it has no dependencies of its own — the host
provides them.

## Verify it yourself

Run from the repository root:

```sh
npm test                          # unit suite — trust the output of this command
npm run test:composition          # composition gates (real DSH Loader) — trust the output
npm run test:all                  # both, in order
npm run check                     # package identity + docs consistency (needs only Node)
npm run clean                     # remove regenerable test residue
```

Most of the unit suite needs nothing but Node. Two files —
`plugin/tests/unit/client.test.mjs` and `plugin/tests/unit/settings.test.mjs` — are
host-bound: they import React and `@deepseek-ai/schemastery` at module top level out of an
installed DSH, resolved through `plugin/contracts/install-resolver.mjs`. Run the suite where
such an installation is present; if it is not at the default location, point
`DSH_INSTALL_ROOT` at it.

CI's portable unit job therefore runs everything except exactly those two files, which it
reports as skipped with the reason. That job is the portable subset, not the whole unit
proof: the full suite, both host-bound files included, is what the local `npm test` run
against a real DSH root exercises. Nothing here claims browser or DOM rendering coverage.

Counts move as suites are added, so they are deliberately not written down here. Treat the actual
output of these two commands as the source of truth; a number printed in this file would drift.

`test:composition` runs every `plugin/tests/composition/gate-*.test.mjs` file against a real Loader:
adapter gates, lifecycle, recovery and fork, event-`seq`, cache epoch, settings, tool churn and the
trusted-epoch suites. A new gate file is picked up by the glob; nothing else needs editing. See
[07 — recovery and fork coverage](plugin/docs/07-lifecycle-recovery-coverage.md).

The composition suites boot a real Cordis Loader against an installed DSH, so they need the host to
be present. They resolve packages from that installation; if it is not at the default location,
point `DSH_INSTALL_ROOT` at it. These commands install and restart nothing, and they do not touch
your DSH profile; they do create temporary session files under `plugin/fixtures/tmp/` (ignored by
Git) and remove them when each test process exits. Set `DSH_KEEP_TMP=1` to keep them for debugging;
`npm run clean` removes any leftovers.

The quality tooling is published, but the full suite needs the frozen scoring dataset, which is
not published — so it does not complete on a public checkout. See
[current status](plugin/docs/05-current-status.md) for what that dataset covers and where it
stands.

## Configuration

The plugin has no required configuration, and every field is a **flat root field** of the plugin's
own config namespace — there is no `progressiveDiscovery` wrapper in the current native config
surface:

```jsonc
{
  // "alwaysVisible": ["read", "grep"],  // omit entirely to keep the DSH defaults
  "frameworkRetained": [],  // trusted framework-mandated names the projection must keep
  "categoryConfig": {},     // localised category cards
  "budgets": null           // see below; null means no overrides
}
```

`alwaysVisible` **replaces** the initial list; it does not add to it. Omitting it keeps the DSH
core-tool defaults. Setting it to a list such as `["read", "grep"]` makes that the *whole* initial
ordinary set — every other default is genuinely dropped from the initial request (and can still be
loaded on demand later). Setting it to `[]` starts with no ordinary tools at all, only the three
discovery entries. The three entries are **not** in this field and cannot be removed by any
configuration.

### Settings panel

With the native `schemastery` peer present, DSH's own settings page renders a **Initial tools** tab
for this plugin: a live catalog of the tools that actually exist in the current scope (global plus
the active runtime), a name filter, checkboxes to toggle selection, and a **Restore DSH default**
action. The checkbox state is written to the root `alwaysVisible` field. Renamed or removed tools
are shown as unavailable but can still be dropped.

A changed list takes effect in the **next new session, or after a successful compaction** — the
current session keeps the list it started with. This panel is the native config surface; there is no
compatibility promise for an older wrapper-shaped config or for any legacy settings UI.

### Budgets: hard caps are off by default

By default this plugin **adds no extra risk thresholds**. Every hard cap — tool count, batch size,
schema bytes, page size, result bytes, query length, skill bytes — is `null`, meaning *disabled*.
Set a cap by giving it a positive integer; set it back to `null` to disable it. `null` is used
rather than `Infinity` because `Infinity` cannot survive JSON.

```jsonc
"budgets": {
  "maxActiveTools": null,        // e.g. 12 to cap how many tools stay loaded
  "maxActiveSchemaBytes": null,  // e.g. 49152 to cap the frozen schema bytes
  "maxLoadBatch": null,          // e.g. 4 to cap tools per single load
  "maxListLimit": null,          // e.g. 20 to cap the page size
  "maxSearchLimit": null,
  "maxListResultBytes": null,
  "maxSearchResultBytes": null,
  "maxQueryCodePoints": null,
  "maxSkillBytesPerLoad": null
}
```

`maxActiveTools` and `maxActiveSchemaBytes` count **only on-demand selections** — loaded, frozen, or
pending disclosure. They do not count the initial `alwaysVisible` baseline, which is injected by the
host and is not this plugin's budgeted surface.

Turning a cap **on** is a real trade-off, not a free safety win:

- **It blocks work.** Exceeding a cap rejects the *new* items. Already-disclosed tools are never
  evicted to make room — nothing is unloaded to fit, under any configuration.
- **It costs turns.** The model has to split the same work into several smaller loads, adding model
  round-trips, latency, and total cost.
- **It can discourage the next load from fitting, and that pressure may prompt an early compaction.**
  When the disclosed set outgrows a cap, the available responses are to raise the cap, turn it off,
  or compact sooner — and compacting sooner than the workload warrants costs context
  re-establishment. None of these is forced; whoever set the cap keeps full control of it.
- **Limits are not optimisation.** A cap that makes a task fail or take longer has not made
  anything cheaper. Default recommendation: leave them off, and set one only when you have a
  concrete reason (a deployment that must bound prompt growth, for example).

What stays bounded even with every cap disabled: the default page size (`defaultListLimit`, 20),
the default candidate count (`defaultSearchLimit`, 5), pagination, and the TTLs. Disabling a hard
cap does not make output unbounded — it only means there is no extra ceiling beyond those defaults.

`initialSchemaTargetTokens` and `maxInitialBytes` are historical target values. Nothing in the
current code path enforces them, so they are **not** a measured guarantee of a 2K initial budget.

## Architecture and what it costs

A stable wire plus append-only disclosure reduce the number of *unnecessary* prefix changes in the
prompt, and known tool names can be batch-loaded so no extra research round is forced after a
compaction. That is the design intent — **no measured saving in context or tokens is claimed**, and
none should be read into it.

The other side of the trade-off: an initial list made too small increases model round-trips and
rediscovery work. Defaulting to DSH's core tools, while leaving the list editable, is a deliberate
balance — not a promise of a 2K initial budget.

## What this is not yet

This is a working implementation, not a finished product.

- It has not completed full product acceptance and is not published to npm. **This round performed
  no install, reload, or restart, so nothing here should be read as an accepted online GUI or as
  full product acceptance**: a desktop link to this checkout may exist, but its loaded version was
  not verified in this round.
- **The settings UI is covered by unit and integration tests, not by rendered-DOM acceptance.** The
  native config surface, the cache-epoch behaviour, the catalog metadata, and the client-side
  helpers are all tested; the panel has not been exercised in a real browser.
- **No token saving is claimed.** The point of the design is to carry less in each request; the
  actual reduction has not been measured, and neither has latency.
- Retrieval quality — how often the right tool is found — has not been measured either.
- Fork inheritance and cold recovery after a process restart are covered only in part. The
  invariants and the known gaps are listed in
  [current status](plugin/docs/05-current-status.md).

## Further reading

- [Design documents](plugin/docs/README.md) — requirements, the frozen protocol, the acceptance
  matrix, runtime evidence, and current status.
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

MIT — see [LICENSE](LICENSE).
