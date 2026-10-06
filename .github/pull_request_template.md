<!--
Branch name should name a direction (feat/…, fix/…, docs/…, chore/…), not a ticket, a file,
or a development-phase codename. Delete this comment before submitting.
-->

## Direction

<!-- What is this change moving toward, in one or two sentences? Not a restatement of the diff. -->

## What changed

<!-- Files and behaviour. If a path moved, give the old -> new mapping and say why the old name
     no longer fits. -->

## Verification

<!-- Every claim needs: the command, the exit code, and the numbers you actually saw in THIS
     run. Delete the rows you did not run. Do not quote a number from an earlier run or from a
     report. -->

| Command | Exit code | Result |
| --- | --- | --- |
| `node --test plugin/tests/unit/*.test.mjs` | | |
| `node --test plugin/tests/composition/gate-adapter.test.mjs` | | |
| `node --test plugin/tests/composition/gate-adapter-lifecycle.test.mjs` | | |
| `node plugin/quality/validate.mjs` | | |

- Host this was run against (`dsh --version` / core package version, and `DSH_INSTALL_ROOT` if
  it is not the default install):
- Commands you could **not** run, and why:

## Not covered

<!-- What stayed unverified. A diff is never "fully verified"; name the gaps. -->

## Security boundary

Does this change touch a guard, a fail-closed path, receipt attribution, framework-tool
protection, the freeze/activation checks, the error envelope, or the load/unload state machine?

- [ ] No — nothing in the list above is touched.
- [ ] Yes — describe the boundary:

<!-- If "Yes", you cannot approve this yourself. Name who must verify it: -->

Independent reviewer required (author may not self-approve):

- [ ] The author confirms they will not sign off their own security boundaries.

## Public boundary

Did this change add, move, or un-ignore anything under `plugin/`, `docs/`, or the root?

- [ ] No public-boundary change.
- [ ] Yes — then, before merging:
  - [ ] The path is still (or newly) ignored where it should be, and any ignore pattern is
        anchored with a leading `/` so it cannot match at another depth.
  - [ ] No published document links into a private path; private paths are referenced as inline
        code.
  - [ ] The new or newly public file was scanned for credentials, tokens, and machine-absolute
        paths, and the result of that scan is recorded in this PR.

## Docs

- [ ] Root `README.md` and `README.zh.md` stay consistent with each other and with reality.
- [ ] No unmeasured claim is stated as fact (token savings, latency, quality scores, install or
      GUI state).
- [ ] `CHANGELOG.md` updated, or the entry is not user-visible.
