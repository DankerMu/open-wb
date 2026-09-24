# Proposal

## Why
#130 adds repeatable real HTTP evidence for the deployed workspace/sandbox/audit boundary. #105 is merged at base99056cf and supplies the three-file real-omp/fake-upstream harness; files must join it atomically with CI fixture provisioning and its oracle.

## What Changes
- Track minimal Markdown, two-row CSV and valid PNG sandbox fixtures; add independent repeatable files.hurl.
- Extend only make smoke to public/auth/chat/files, preserving clean environment, chat variables and caller-owned lifecycle.
- Provision both existing smoke/ui-walk jobs through their shared helper and update precise guardrail expectations/mutations in the same PR.

## Capabilities
### New Capabilities
- `files-harness`: sandbox fixture and repeatable files HTTP proof only; browser/control-plane requirements remain later children.
### Modified Capabilities
- `verification-harness`: full HTTP smoke and CI wiring requirements preserve merged #105 behavior while adding the fourth file/shared fixture provisioning.

## Impact
smoke fixtures/files.hurl, Makefile, .github/scripts/ci-compiled-server.sh, scripts/test-ci-harness.sh and existing directly affected smoke oracle consumers. No product source, Playwright journey, AGENTS, uid-isolation job, dependencies or thresholds.

## Risk triage
Issue type: test
Fixture level: expanded
Upstream suggested level: none (override: project profile explicitly marks smoke/CI/file-IO/security verification as expanded).
Blast radius: false-green tenant/sandbox proof, repeatability failure, incorrect CI provisioning or lifecycle/oracle regression.
Selected risk packs: public CLI; config; file IO; auth/secrets; ordering/shared state; bounded discovery; legacy compatibility; errors/cleanup; packaging compatibility; docs.
Evidence floor: same-service/DB/sandbox four-file smoke twice, standalone files.hurl, semantic fault rejection/restoration, make test-guardrails, both CI jobs and exact-head aggregate green.
Width exception: multi-path runtime CI and precise static oracle are one atomic ownership slice.
