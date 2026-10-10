# DSH Tool Discovery

Give a model a few small control entries instead of hundreds of tools, and let it load the
capability it actually needs, on demand.

This is a DSH plugin. On the first request the model sees three fixed entries — `tool_list`,
`tool_search`, `tool_load` — plus a short summary of each capability category, **plus the default
initial set**: DSH's own core tools (the manual baseline) and the tools registered by the current
agent's own preset, which is retained by default. Other ordinary tools are not disclosed up front.
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

- DSH Core **`0.2.1-alpha.1` or `0.2.1-alpha.2`** — the declared peer range is exactly these two
  releases. `0.2.1-alpha.1` is the release baseline every result in
  [current status](plugin/docs/05-current-status.md) was taken on; `0.2.1-alpha.2` installs and
  passes the core paths, while three real-fork gates are not yet adapted to that release's
  subagent-residency change. The per-version matrix, its evidence, and the open gaps are in
  [STORE compatibility](plugin/docs/10-store-compatibility.md). Any other version is untested.
- The native **`@deepseek-ai/schemastery`** peer is required for the config surface and the settings
  panel. Without it the discovery domain still runs normally, but there is no Config and the plugin
  logs `ConfigUnavailable` instead of silently pretending a settings page exists.
- **Native** tool display mode. Other display modes are refused at activation rather than
  downgraded silently.
- **One active agent per session.** Concurrent agents in a single session are not supported,
  because a request cannot be attributed unambiguously.
- Node `^22.19.0 || >=24.0.0`.

## Install and update

The GitHub Release build asset remains available for DSH profile installs: a green `main` run packs
the tree and publishes `dsh-tool-discovery.tgz` on a commit-derived `build-<sha>` release (a run
whose commit is already superseded is skipped, so an older commit is never re-published as the
newest release). That asset is a **build artifact, not an acceptance statement**; what a version
covers and what it deliberately does not claim is recorded in
[current status](plugin/docs/05-current-status.md).

The package has been published to npm since version `0.2.1`. Future stable `v<version>` tags that
match `package.json` run the npm publish job after the portable tests and repository checks pass.
GitHub Actions authenticates to npm with OIDC and npm generates provenance; no npm write token is
stored in GitHub. See [Publishing to npm](#publishing-to-npm) for the release steps.

Use the DSH CLI that belongs to the installation you run, and target the profile that will actually
load the plugin. DSH NEXT Desktop ships its own CLI (it starts through
`resources\app\lib\desktop-cli.js`) and manages plugins through its own entry point; a globally
npm-installed `dsh` on `PATH` is a different launcher with a different profile, not this
installation's tool. **The CLI version is not the Core version**: `dsh --version` reports the CLI,
and no CLI number tells you which Core a profile resolves. Check the Core peer under
[Requirements](#requirements) against that profile instead.

```sh
# first install — name the package, then the full tarball URL
dsh plugin --profile <profile> add \
  dsh-tool-discovery@https://github.com/KouzakiUmi/dsh-tool-discovery/releases/download/<build-tag>/dsh-tool-discovery.tgz

# update an installed copy — the same name@URL form
dsh plugin --profile <profile> update \
  dsh-tool-discovery@https://github.com/KouzakiUmi/dsh-tool-discovery/releases/download/<build-tag>/dsh-tool-discovery.tgz
```

`<build-tag>` is a commit-derived release tag such as `build-80216ba3effa`. Because the tag carries
the commit, a later build never replaces an older one, and two builds can legitimately share one
manifest version — maintainers bump `version`, CI does not — so pin the tag whose commit you tested,
always give the package name explicitly, and read the version from the release name (`v<version> ·
<sha>`) or from the manifest inside that tarball instead of assuming what `main` currently says.

For a Node project, install the public package from npm with `npm install dsh-tool-discovery`. The
DSH profile installation commands above continue to use the DSH CLI and a GitHub Release asset.

## Publishing to npm

The initial `0.2.1` publication was a one-time bootstrap because npm only lets a maintainer attach a
Trusted Publisher after the package exists. The npm account's two-factor check was completed with
Windows Hello. The Trusted Publisher is now registered for:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | `KouzakiUmi` |
| Repository | `dsh-tool-discovery` |
| Workflow filename | `ci.yml` |
| Environment | None |
| Allowed publishing | `npm publish`; `npm stage publish` (npm default) |

npm also enables `npm stage publish` for new Trusted Publisher configurations. For each stable
release, bump `package.json`, commit the change, create the matching `v<version>` tag, and push it.
The `publish-npm` job waits for portable tests and repository checks, verifies the tag, then publishes
with OIDC and provenance. A staged version stays unpublished until a maintainer reviews and approves
it with two-factor authentication.

The workflow requires Node 24 and npm 11.5.1 or newer. It does not use an `NPM_TOKEN` GitHub
secret. Pre-release tags are not published by this job.

**Nothing here was executed in this round.** No install, reload or restart was performed, no profile
was touched, and installation through this channel is therefore **not verified here**. What was
checked is only that an already-published release and its asset metadata exist (a read-only `gh
release view`: tag, target commit, asset name); no payload was downloaded, unpacked or installed, and
the artifact of a *future* build — including its digest — can only be verified after that release
runs. Exact flags and spec forms come from the target CLI's own `plugin --help`. If an install fails,
keep the manifest, lockfile and CLI output and report it rather than hand-editing a profile.

## Get the source

The source version on this branch is **`0.2.2`**. Which version a given download
carries is decided by the manifest inside that build's tarball — compare it with the release name
(`v<version> · <sha>`) rather than assuming that `main` and this document agree.

```sh
git clone https://github.com/KouzakiUmi/dsh-tool-discovery
cd dsh-tool-discovery
```

It is plain JavaScript with no build step. The manifest declares a runtime `dependencies` entry,
`zod` (`^4.4.3`) — the trusted-epoch record table is handed to the host's storage domain as a zod
schema — and declares the host packages it needs as `peerDependencies`, provided by the DSH
installation. Nothing is vendored, and there is no build step that could paper over a missing host
package.

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
  "initialToolsEnabled": true,  // optional manual initial injection; preserves the configured list
  "alwaysAllowPresetTools": true, // retain tools declared by the current bound preset
  "requireTrustedEpoch": false, // opt-in strict durable epoch verification
  "requireTrustedEpochForSubagents": false, // also enforce on children only if strict is on
  "frameworkRetained": [],  // trusted framework-mandated names the projection must keep
  "categoryConfig": {},     // localised category cards
  "budgets": null           // see below; null means no overrides
}
```

`alwaysVisible` **replaces the manual initial list**, rather than adding to its defaults. Omitting
it keeps the DSH core-tool defaults. Preset retention is separate: when `alwaysAllowPresetTools`
is on, the current bound preset's native-visible registered tools are unioned with this manual list.
To start with only the three discovery entries, set `alwaysAllowPresetTools: false` and either
`alwaysVisible: []` or `initialToolsEnabled: false` (unless explicit framework retention also applies).
The three entries cannot be removed. Names that are not native-visible in the current agent are
not granted merely because the settings catalog contains them.

### Settings panel

With the native `schemastery` peer present, DSH's own settings page renders a **Tool discovery** tab
for this plugin: optional feature switches and an **application-wide registration catalog**, including
preloaded presets even before any session exists. The catalog reads all current registration layers,
not session eligibility, discovery/loading state, or outbound headers. It supports a name filter,
checkboxes and **Restore DSH default**; selection writes only the root `alwaysVisible` field.
Missing names are labelled **not registered in the application catalog**, never as an execution
failure. If the installed SDK cannot supply a complete registry, absent names are **unconfirmed**.
Global registration does not promise execution permission in every session.

- **Inject initial tools** (`initialToolsEnabled`, default `true`): disabling preserves the configured list but stops automatic initial injection; `tool_load` still works. This switch and the list apply in a **new session or after successful compaction**, not mid-epoch.
- **Always allow tools specified by the preset** (`alwaysAllowPresetTools`, default `true`): retain only tools registered by the exact preset revision the current agent joined, intersected with its native-visible capabilities. Other presets and later agent-only tools do not become trusted. Independent of manual injection; uses the same new-session/successful-compaction boundary. It preserves the initial set, not arbitrary execution or native permission bypass.
- **Require trusted epoch records** (`requireTrustedEpoch`, default `false`): default mode does not access the trusted epoch store or block sessions for missing records/storageDomain. Initial tools come from the configuration snapshot, never from outbound headers. Enabling reloads the plugin and requires durable records: an existing session without one needs a successful user `/compact`; storage failures also block. Disabling restores sessions missing records but does **not** offer strict mode's frozen-list guarantee across restarts.
- **Also require trusted epochs for subagents** (`requireTrustedEpochForSubagents`, default `false`): only effective when `requireTrustedEpoch` is on. Live runtime-owned children otherwise use the configuration baseline without reading/writing epoch records or requiring `/compact`, including resumed legacy child sessions. Runtime ownership—not header/meta tags or durable fork lineage—identifies a child. A fork resumed as a top-level agent still follows the main strict switch. Changing this ordinary setting reloads the plugin, so disabling it recovers legacy children without a synthetic compaction. Enabling it explicitly may block old children; subagents cannot perform the user's `/compact` themselves.
- Eligibility, protocol receipts, corrupt-history checks and execution guards remain enforced. The three discovery entries cannot be disabled.

Rejected writes show an error, not a success notice. This is the native config surface, with no legacy wrapper/UI compatibility promise. Browser rendering and online installation need separate acceptance; workspace tests do not imply deployment.

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
