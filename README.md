# DSH Tool Discovery

Give a model a few small control entries instead of hundreds of tools, and let it load the
capability it actually needs, on demand.

This is a DSH plugin. On the first request the model sees three entries — `tool_list`,
`tool_search`, `tool_load` — plus a short summary of each capability category. Ordinary tools are
not in the request at all. When the model decides it needs one, it calls `tool_load`, and that
tool's real native schema appears in the **next** request. The model then calls the tool normally,
through DSH's own approval, sandbox, and permission chain.

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
following turn. Unloading is explicit, and reaching for a tool that has not been loaded is
refused.

## Requirements

- DSH Core **`0.2.1-alpha.1`**. Other versions are untested; the host interfaces this plugin
  depends on are specific.
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

It is plain JavaScript with no build step, and it has no dependencies of its own — the host
provides them.

## Verify it yourself

Run from the repository root. The unit suite needs only Node:

```sh
npm test                          # 160 passed, 0 failed
npm run test:composition          # 42 passed, 0 failed
```

`test:composition` runs four real-Loader suites: 14 adapter gates, 7 lifecycle cases, 13 recovery
and fork cases, and 8 event-`seq` cases. The first two are on `main`; the recovery and event-`seq`
suites are on an unmerged branch, so a checkout of `main` runs 21 composition cases where this
branch runs 42. See [07 — recovery and fork coverage](plugin/docs/07-lifecycle-recovery-coverage.md).

The composition suites boot a real Cordis Loader against an installed DSH, so they need the host to
be present. They resolve packages from that installation; if it is not at the default location,
point `DSH_INSTALL_ROOT` at it. These commands install and restart nothing, and they do not touch
your DSH profile; they do create and remove temporary session files under
`plugin/fixtures/tmp/`, which is ignored by Git.

The quality tooling is published, but the full suite needs the frozen scoring dataset, which is
not published — so it does not complete on a public checkout. See
[current status](plugin/docs/05-current-status.md) for what that dataset covers and where it
stands.

## What this is not yet

This is a working implementation, not a finished product.

- It has not completed full product acceptance, and it is not published to npm or installed in any
  DSH profile or GUI.
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
