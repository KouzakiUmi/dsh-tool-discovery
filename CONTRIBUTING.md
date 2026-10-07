# Contributing

Thanks for looking at this. Read the root [README](README.md) first: this repository is a
**source baseline**, and the list of what has *not* been verified is part of the contract, not a
disclaimer to skip.

## The flow: direction-named branch → verification → PR to `main`

**1. Branch with a direction name.** Name the branch after the direction of the work, not after
the ticket or the file, and not after a development-phase codename:

```text
feat/search-category-eligibility
fix/recovery-fail-closed-branch
docs/public-boundary-review
chore/remove-stale-rc-excludes
```

Avoid names like `progressive-v2-fixup`, `v2-refactor`, or `wip`. The old layout this repository
was migrated away from was named after development phases (`progressive-v2/`), and the migration
report exists mostly because that name outlived its meaning. Do not reintroduce it.

Branch from `main` and keep the branch scoped to one direction. Mixed-purpose branches are the
main source of unreviewable diffs here.

**2. Verify, and report the commands you actually ran.** Every status claim needs a report path, a
command, an exit code, and an explicit list of what stayed uncovered. Static evidence, design
reasoning, and mock output are not "the product passes". If you cannot run a check, say so and
name the reason — do not quote a number from a previous run.

From a clean checkout, with Node `^22.19.0 || >=24.0.0`:

```sh
npm test                    # unit suite (Node only; two files are host-bound, see the README)
npm run test:composition    # real-Loader gates; needs an installed DSH Core
npm run check               # package identity + docs consistency; needs only Node
npm run check:quality       # exit 1 is expected on the known H037/H044 mislabelled samples
```

Counts are not written down here on purpose; they drift. Quote the actual output you got.

The composition suites resolve host packages from the DSH installation through
`plugin/contracts/install-resolver.mjs`, which anchors on the install's own `package.json`. Set
`DSH_INSTALL_ROOT` to point at a different installation. The install is read only; never install
into a profile, never modify the DSH core or a profile manifest, and never restart anything as
part of verification. If you need a profile change to prove something, stop and ask.

`check:quality` will not run on a fresh clone: the frozen scoring dataset is deliberately not
published (see the README section "When the quality dataset is absent"). Do not "fix" this by
committing the dataset — that decision needs its own review.

**3. Open a PR against `main`.** Use the template in
[`.github/pull_request_template.md`](.github/pull_request_template.md).

## No auto-merge

There is no auto-merge on this repository, and a PR that passes CI is not merged on that basis.
A maintainer reads the diff. CI is a floor, not an approval.

## Authors do not sign their own security boundaries

If your change touches a security boundary — the guard, the fail-closed paths, receipt
attribution, framework-tool protection, the freeze/activation checks, the error envelope, or
anything in `plugin/domain/`'s load/unload state machine — then **you cannot be the person who
approves it**. Write the boundary down in the PR, name who needs to verify it, and leave the
approval to someone else. "I checked it myself" is not a sign-off.

This is not a formality. Two of the defects found in this codebase during review existed precisely
because the author's own reasoning about them was wrong, and a residual review debt is still
open because the fix author and the cross-reviewer were the same person.

Same rule in the other direction: a reviewer's counterexamples, isolation mirrors, and logs are
what make a review checkable. Do not delete, overwrite, or "clean up" another reviewer's
artifacts to make a diff smaller.

## What is not published, and how to refer to it

`plugin/audits/`, `plugin/reports/`, the quality labels and queries, and the root `docs/` are
private; each entry in [`.gitignore`](.gitignore) carries its reason. In published documents,
refer to those paths as inline code — do not create markdown links to them, because the links
would resolve in the working tree and break for every reader of the published repository.

## Changing the public boundary

Widening what is published is a decision with a review, not a side effect of a rename. If a
directory moves or a new one appears, check all three of:

1. Is the path still ignored? A pattern like `docs/` (no leading slash) matches at **any** depth —
   that is exactly how the migration to `plugin/` silently changed what was public. Anchor it
   with a leading slash.
2. Does any published document now link into a private path?
3. Does the newly public file need a content review? A file being ignored is not evidence that it
   was reviewed; run the scan (`api[_-]?key`, `secret`, `password`, `token`, `Bearer`, absolute
   `C:\` paths, `AppData`, `.dsh/`) and record what you found.

## Scope discipline

This repository has no build step and no runtime dependency of its own; host packages are provided
by the DSH installation and declared as `peerDependencies`. Do not add a `dependencies` block to
paper over a missing host package. If you need a new host capability, the honest options are a
peer dependency, a documented "not supported" row, or a request — not a vendored copy.
