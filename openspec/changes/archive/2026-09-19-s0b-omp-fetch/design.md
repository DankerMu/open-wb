## Context
Issue #86 extracts parent change s0b-minimal-chat-loop task 1.1 and design D11.
The official v18.0.10 GitHub release supplies Darwin arm64 and Linux x64 assets.
## Goals / Non-Goals
Goal: deterministic, verified binary at var/omp/omp via the existing Make command surface.
Non-goals: CI wiring (#105), control-plane documentation rows (#107), runtime spawning and TS changes.
## Decisions
Change surface: Makefile, scripts/omp-fetch.sh, Make oracle inside scripts/test-ci-harness.sh.
Must preserve: every existing Make recipe and harness assertion; macOS system Bash 3.2 compatibility.
Must add/change: fixed version and SHA256 table, uname -sm platform dispatch, verified executable publication and cache validation.
Governing invariant: an unverified download never becomes var/omp/omp; successful cached reuse requires the pinned digest.
Sibling surfaces: download, existing-file validation, checksum failure cleanup, unsupported-platform dispatch, Make recipe and duplicate-target oracle.
Use a temporary download and verify before publication; no runtime override of release URL or digest.
Use portable checksum tooling available on supported systems; do not add dependencies.
Official API digest anchors: Darwin arm64 bf026b63aa3b0acb0afbed8083f76bcec134bf56ffdbbe80fb73a7e079fe278a; Linux x64 b13e6b2a74a5c71e57b9f717e0fc4834bcfe0609f30dc1782a91976b230361a0.
Seams under test: real Make invocation and shell process with controlled command fixtures in a disposable copy, not production override switches.
Required evidence: empty destination -> verified executable and omp/18.0.10; repeated invocation -> skip with no downloader invocation.
Required evidence: tampered digest/download -> nonzero expected/actual and no destination; unsupported uname -> nonzero support matrix before downloading.
Required evidence: valid Make contract -> green; omp-fetch recipe drift and equivalent omp-fetch : redefinition -> rejected.
Review focus: integrity before chmod/publication, cache digest checks, cleanup, shell portability, unchanged existing Make oracle coverage.
## Risks / Trade-offs
External release/network availability is a prerequisite, not a reason to substitute assets or weaken verification.
Local runtime evidence is Darwin arm64; Linux asset digest must be authenticated against the official release, Linux execution belongs to CI deployment integration.
## Migration Plan
No persisted state migration. Revert the feature commit to remove the new command; ignored downloaded binary is not tracked.
