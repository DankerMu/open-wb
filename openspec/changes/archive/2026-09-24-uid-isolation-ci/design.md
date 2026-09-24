# Design

## Context
Baseline0a11e74 includes #131 real opt-in test, #239 TMPDIR assignment-before-- correction, and #130 shared fixture provisioning/four-file smoke. Ordinary jobs skip the uid test. Canonical probe executable is0755 with env-node shebang; setup-node toolcache is outside typical sudo secure_path.
Governing invariant: mandatory hosted job only passes if a nonroot app/test runner launches a genuinely different uid, cannot expose parent credentials, shares writable sandbox state, executes real omp chat, and leaves no job-owned child after completion/failure.
Sibling surfaces: workflow env/action counts/aggregate → provisioning identities/sudoers/paths → sg effective group → test and compiled helper → sudo real/fake executables → filesystem/proc/readiness/cleanup → source and runtime oracles.

## Goals / Non-Goals
Harden the CI proof, not product behavior. No removal of /proc downgrade or AGENTS update (#134/#107), no #133 journey, no real model upstream/secrets. No host privilege mutations in local validation; script only intended for disposable hosted Linux runners.
Preserve existing smoke/UI job definitions, timeout budgets, action identities, raw Make/clean Hurl contracts, child PGIDs and failure precedence. Keep existing #239 nonsecret TMPDIR exception and all #131 assertions.

## Decisions
- New workflow job mirrors checkout/setup-node/npm ci/builds, then omp-fetch, pinned Hurl installer and one uid script; distinct loopback ports/job-owned paths. Direct jobs8 and checkout/setup-node counts8/6; aggregate remains failclosed on failure/cancelled/skipped.
- Script validates Linux/nonroot context and required paths before privileged provisioning. Create dedicated omp and workbuddy group, add runner to shared group, exact three SETENV command rules for fake, real omp and /usr/bin/env, visudo validation.
- Explicitly ensure selected Node is discoverable from sudo secure_path without copying secrets or disabling path safety. Job-owned roots/required ancestors traversable; shared dirs2770 and groupworkbuddy, private DB remains0600. Never recursive0777 or widen unrelated home/checkout permissions.
- Copy canonical sandbox fixture to job-owned tree; ensure copied directories retain required shared write/traversal. Existing helper repeats its canonical merge-copy; do not create a second product fixture implementation.
- HOME preflight runs from env-i with only PATH/HOME; target env printed as required, exact HOME line required. No inherited runner token/credential dump. HOME path includes a space/colon to exercise quoting.
- Both opt-in test and compiled-server smoke execute inside effective workbuddy group via sg; do not merely update group database or run app/test asroot. Umask007 is scoped to these child executions, not a global host change. Export safe TMPDIR into job-owned shared temp for test artifacts.
- Shared helper forwards OMP_USER only when supplied, preserving absent behavior. Test phase sets WORKBUDDY_UID_TEST=1 OMP_USER=omp; smoke phase uses sameOMP_USER with the real pinned OMP_BIN and existing fake-upstream lifecycle.
- Preserve normal EOF/TERM cleanup. Dedicated uid is job-created: after test/harness completion inspect residue, report it as failure and boundedly reap only that owned uid/group if needed; do not hide cleanup failure or kill unrelated runner processes. No token-bearing argv/logs.

## Risks / Trade-offs
Group membership cache/ancestor permissions → both phases use sg and hosted real test/smoke, notmock-only proof.
Broad runner sudo allowance can mask bad rules → env preflight and exact three scoped rules checked independently with visudo/source oracle; no new general-purpose launcher grant beyond required env command.
Killed sudo may orphan omp under otheruid → preserve cooperative runtime cleanup and explicit job-owned residue handling; fault proof plus hosted successful cleanup evidence.
Encoded oracle syntax can make all negatives vacuous → Main parses decodedPython then checks positivebaseline before mutation acceptance; keep existing controls.

## Migration Plan
Review/validate fixture, implement atomic harness slice, Main executes safe local guardrails (no real sudo provision) and static gates; hosted PRjob supplies actual privileged integration proof. Frozen3seat review and exact-headCI gate before automatic merge; capture mergedmaster uidjobgreen and handoff to134 without closingdowngrade here. Selective archive onlychild/currentrequirements.
Rollback wholeCI/oraclePR together; no partially required job or fake success fallback.
