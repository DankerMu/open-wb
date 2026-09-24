## Why
#105 completes the real omp v18.0.10 → app model proxy → controlled upstream path in HTTP smoke and CI. Existing two-file smoke cannot attest chat behavior or child cleanup.

## Triage
Issue type: feature/test
Fixture level: expanded
Upstream suggested level: none (override: shared CI entrypoint, process cancellation/cleanup and authenticated real-network acceptance require expanded evidence).
Blast radius: both harness jobs, Make smoke, exact workflow/script oracle; product source unchanged.
Selected risk packs: CLI, config, file IO, auth/secrets, concurrency, resource lifecycle, legacy compatibility, errors, packaging, documentation; project process/network/offline/sandbox/auth boundaries.
Evidence floor: real pinned binary + controlled upstream + three-file make smoke twice, existing UI journey, full guardrails, fault/cleanup qualification, independent exact-head CI.

## What Changes
- Atomic workflow, CI fake-upstream launcher, compiled-server ownership, three-file Hurl smoke and exact harness oracle updates.
- Preserve PATH-only Hurl, existing public/auth assertions, action matrix, cancellation and nonzero failure semantics.
- User clarified the no-secrets rule: smoke/ui-walk jobs prohibit secrets and real model upstreams; existing secret-scan GITHUB_TOKEN remains unchanged.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-harness`: HTTP dialogue smoke and real-runtime job ownership requirements.
- `verification-harness`: fully restate HTTP smoke and CI wiring requirements with this slice only; preserve unrelated requirements/scenarios.

## Impact
Candidate scope: `.github/workflows/ci.yml`, `.github/scripts/ci-fake-upstream.sh`, `.github/scripts/ci-compiled-server.sh`, `smoke/chat.hurl`, Makefile smoke recipe, `scripts/test-ci-harness.sh` and directly coupled existing smoke test oracle expectations. No product source, dependency, action-major, AGENTS/constraints or Playwright journey change. #106 owns dialogue UI steps; #107 owns control-plane mirrors. This is the upstream-approved atomic multi-path width exception.
