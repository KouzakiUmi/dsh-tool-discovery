# Security Policy

## Reporting a vulnerability

**Do not publish a suspected vulnerability in a public issue, pull request or technical write-up.**

The intended private reporting route is:

> <https://github.com/KouzakiUmi/dsh-tool-discovery/security/advisories/new>

Availability of private reporting is not verified by this document. If that route is unavailable,
ask the maintainer for a private channel **without posting reproduction details or sensitive data publicly**.
No verified monitored fallback mailbox is documented here; a GitHub profile link is not a confirmed private-message channel.
This is a reporting-channel gap, not an assurance that a report sent elsewhere will be received.

Please include:

- the actual DSH **Core** and relevant peer versions, not just the CLI or desktop shell version;
- the plugin version and exact source commit or artifact digest;
- presentation mode, relevant configuration and whether the case uses a baseline exception;
- the tool sequence and sanitized inputs, expected behavior and observed behavior;
- whether the evidence is static reasoning, a unit counterexample, Loader composition or actual execution.

See the [current contract](<plugin/docs/00-current-contract.md>) and
[compatibility evidence](<plugin/docs/10-store-compatibility.md>) for the supported boundaries.
Do not attach credentials, unredacted profile manifests or private session history to a public discussion.

## Security surface

The plugin reduces disclosure and adds execution refusals; it is not the host sandbox or an independent approval system.
The three entries are **not** the only initially callable tools: configured initial tools, retained preset/framework tools,
and the default core self-admission policy have distinct rules.

Relevant findings include:

- **Executing outside the permitted paths.** An ordinary on-demand tool reaches its body without a valid selection,
  actual matching disclosure and current native eligibility, excluding explicitly documented baseline exceptions.
- **Bypassing an existing rejection.** Native deny, approval or sandbox restrictions are bypassed, or a same-name/shadowed
  definition gains authority from an unrelated scope.
- **Forging activation.** User text, a search result, an orphan/rewritten receipt or a header alone becomes a selection;
  call/result attribution or the final success predicate is skipped.
- **Failing open.** Unverifiable history, failed query or a required but missing/invalid durable baseline is treated as a
  new trusted session. Default opt-out of durable baselines is a documented configuration, not itself a bypass.
- **Crossing disclosure/authority boundaries.** Frozen wire, a category, the global settings catalog, inherited fork history
  or a stale candidate grants current execution rights.
- **Lifecycle rollback defects.** Partial activation or disposal leaves a live listener, guard or registered definition
  that can affect later requests beyond its owning activation.

Repeated idempotent loading of an already-active protected baseline item is allowed by the default
`tolerantLoadProtected` policy; it is not by itself an escalation. Hidden and nonexistent names intentionally receive
non-disclosing refusals. Neither behavior should be described as a new vulnerability without a boundary-crossing counterexample.

## Trust assumptions and known limitations

Trusted local configuration and the host plugin registry are control-plane inputs. Durable epoch records are not signed
or MAC-authenticated; someone who controls the trusted storage can forge that local state. The supported scope is a
single-user, single-profile deployment, not an adversarial multi-tenant authorization service.

Same-session multi-agent concurrency and atomic binding across uninterrupted hot definition replacement are not promised.
Native frozen disclosure is not execution permission. Optional PTC still lacks SDK byte freezing, stable append and
cross-restart freeze; this is a disclosed consistency gap, not evidence that its execution guard can be bypassed.

Performance, token use and retrieval quality normally belong in functional reports. A request to publish intentionally
private audit/scoring materials is a [public-boundary contribution](<CONTRIBUTING.md#changing-the-public-boundary>);
**an accidental secret or private-data disclosure is still appropriate for private security reporting**.
Host-core defects should also be reported to the host maintainers; this repository only owns its plugin behavior.

## Review and disclosure

There is no published response SLA. Source or package distribution does not imply a completed security or product audit.
Maintainers triage a private report before arranging coordinated disclosure; do not publish an unfixed reproduction.
Fixes follow [CONTRIBUTING](<CONTRIBUTING.md>): scoped branch, evidence, independent review and maintainer merge.
Authors do not approve their own security boundaries. An earlier bounded check or green CI does not approve later changes.
