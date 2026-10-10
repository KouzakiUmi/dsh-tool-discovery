# Security Policy

## Reporting a vulnerability

**Do not open a public issue, and do not open a public pull request, for a suspected
vulnerability.**

Use the repository's private reporting channel instead:

> <https://github.com/KouzakiUmi/dsh-tool-discovery/security/advisories/new>

If private vulnerability reporting is not yet enabled for this repository, the fallback is a
direct message to the maintainer through their GitHub profile. Either way, open the report
privately first and let the maintainers publish the advisory.

**Known gap, for the maintainer to close:** private vulnerability reporting has not been verified
as enabled on this repository, and no monitored mailbox is configured. Until that is fixed, treat
the GitHub profile DM as the working channel and confirm it with the reporter.

Please include, as far as you can:

- the DSH core version the finding reproduces on (`0.2.1-alpha.1` and `0.2.1-alpha.2` are the
  versions this code has been reviewed against — see
  [STORE compatibility](plugin/docs/10-store-compatibility.md) for the per-version matrix),
- the plugin commit,
- the tool sequence and inputs,
- what a caller should have been able to do, and what happened instead.

## What counts as a vulnerability here

This plugin sits between the model and the tool registry. Its security surface is specifically:

- **Reaching a tool that was not loaded.** The three control entries are supposed to be the only
  thing callable until a `tool_load` succeeds. A path from an un-loaded tool to a real
  execution is the primary finding.
- **Bypassing the guard.** The guard may only add rejections. Any input that makes it stop
  rejecting, or that lets a shadowed or same-named definition win, is a finding.
- **Forging or replaying a receipt.** Activation must require a canonical receipt that the engine
  itself produced, and a user message shaped like a receipt must not activate anything.
- **Failing open.** Where the journal or the session query cannot be read, the correct behaviour
  is to fail closed. A path from an unreadable journal to "treated as a new session with restored
  state" is a finding.
- **Crossing a trust boundary.** Loading an entry tool or a framework-retained tool, bypassing the
  frozen-trust set, or letting a category grant eligibility.
- **Failing to roll back.** Any activation path that leaves an orphan listener, guard, or
  registered definition after a failure part-way through.

Note that a *nonexistent* tool name is refused with the same message as a hidden one. That is a
deliberate product decision — the call surface does not distinguish existence — and is not a
finding.

## What is not in scope

- Performance, token consumption, or search quality. The token saving this design targets has not
  been measured at all, and the scoring dataset is not publishable; a claim that it underperforms
  is not a security report.
- The published-but-unpublished boundary. If you believe something under `plugin/audits/`,
  `plugin/reports/`, or the quality dataset should be public, that is a
  [contribution](CONTRIBUTING.md#changing-the-public-boundary) question, not a vulnerability.
- Defects in DSH itself. Report those to DSH. This repository only records which host seams it
  depends on.

## Response

The maintainers will acknowledge a report, and will state whether they accept it as a finding
before working on a fix. Fixes go through the same flow as any other change — a
direction-named branch, verification, and a pull request against `main` — see
[CONTRIBUTING.md](CONTRIBUTING.md). The author of a fix to a security boundary does not approve
it.

## Disclosure

There is no published SLA for this repository, and it has not been through a release. Reporters
should expect triage, not a fixed response window. Please do not publish a technical write-up of
an unfixed finding.
