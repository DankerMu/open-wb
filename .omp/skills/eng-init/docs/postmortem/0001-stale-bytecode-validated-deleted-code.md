# Post-mortem 0001: Bytecode cache let the suite validate code that was no longer there

Status: resolved (`ddb5038`)

## Executive summary

A mutation test reported that neutering a registry check was caught by nothing, so the check looked untested. It was fine. CPython validates a `.pyc` against `(source mtime, source size)`, and the mutation — `if extra:` → `if False:`, both exactly nine characters — preserved the size and landed inside the same one-second mtime window. After the source was restored the suite kept executing the mutated bytecode. The suite reported a result about code that had already been deleted from disk. Any same-length one-line edit, including an ordinary `git revert`, opens the same window.

## Impact

One mutation result inverted: a working check was about to be recorded as an untested invariant, and the test that covers it was about to be rewritten to fix a defect that did not exist. Caught during the same session, so nothing shipped.

The boundary: no released artifact was wrong, and `selfcheck` had never reported green on genuinely broken source in the repository's history — the collision requires an edit that preserves byte length, which is rare outside mutation testing and single-line reverts.

## Timeline

- Mutation sweep round 1 reports `matrix target resolution neutered: suite still GREEN — nothing catches this`, plus `restored: suite NOT GREEN — INVESTIGATE`.
- `git diff` on the checker is empty and `grep` shows `if extra:` present — the source is correct while the suite still fails.
- The failing test is reproduced in isolation and by direct call; a freshly-loaded copy of the same module produces the correct rejection, the on-disk module does not.
- `ls -la scripts/__pycache__/` shows `check_readiness_registry.cpython-314.pyc` newer than the restore.
- `find . -name __pycache__ | xargs rm -rf` → 87 passed.

## Root cause

CPython's source-timestamp invalidation stores the source's mtime and size in the `.pyc` header and reuses the cache when both match. `"if extra:"` and `"if False:"` are the same length; `shutil.copyfile` restored the original within the same second the mutated file was written. Both fields matched, the cache was reused, and every subsequent `importlib.util.spec_from_file_location` load in the test suite got the mutated bytecode.

**Why existing defenses missed it.** Every gate in `selfcheck.sh` reads Python modules through the same import machinery, so all of them consumed the same stale cache — there was no independent observer. The suite's own red/green signal is not evidence about the source when the loader can serve something else; nothing in the repository asserted that the code under test was the code on disk. The defect is invisible to code review by construction: reading the source shows the correct code, which is exactly what the reviewer expects to see.

## Guardrails added

- **Mechanical:** `scripts/selfcheck.sh` deletes every `__pycache__` under the skill root before running any gate. Discharged against the worst case: prime the cache from good source, apply a same-length mutation, force the original mtime back with `os.utime` so both invalidation fields match, then run `selfcheck` — it goes red on the broken source. (This sentence originally claimed the verification before it had been performed; see postmortem 0002, instance 5.)
- **Mechanical:** `scripts/mutation_sweep.py` clears caches before each suite run and invokes pytest with `-B`, so the harness cannot grade a previous mutation.
- **Prose:** the reason is stated at both call sites rather than as a bare `rm -rf`, because a cleanup line with no explanation is the first thing a later reader deletes as noise.
- **Policy:** `not applicable` — this is a property of the test runner, not of what evidence a change must produce.

## Lessons

- A green suite is evidence about whatever the loader served, not about the file you are reading. When the two can diverge, the divergence is undetectable from inside the suite.
- Mutation testing needs the same hygiene it is testing for: the harness must guarantee each run measures the mutation it just applied.
- Same-length edits are the dangerous class. `git revert` of a one-line change is the common real-world trigger, not just deliberate mutation.
