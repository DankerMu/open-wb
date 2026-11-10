## MODIFIED Requirements

### Requirement: Real-runtime CI harness ownership
CI smoke/ui-walk SHALL retain existing action identities/counts, setup/build/static roots and timeouts; fetch verified omp via the omp binary cache step immediately followed by `make omp-fetch` (verification-harness「CI omp 二进制缓存」; the cache is untrusted and re-verified by SHA256), start their own controlled loopback upstream before compiled app, pass explicit OMP_BIN/OMP_STATE_DIR/SANDBOX_ROOT and fake MODEL_UPSTREAM values, and invoke the existing Make target. `.github/scripts/ci-fake-upstream.sh` SHALL launch the existing Node fixture, not duplicate it. Existing cancellation/process-group/cleanup failure semantics SHALL remain; all job-owned upstream/omp processes SHALL be reaped on success, failure and cancellation. Two harness jobs SHALL not reference secrets or real model upstreams; existing secret-scan token is explicitly preserved by user decision.

#### Scenario: Independent jobs remain isolated
- WHEN smoke and ui-walk each execute with job-local paths and ports
- THEN verified binary and ready controlled upstream precede app readiness, harness result is propagated, owned children are gone after teardown and unrelated processes remain untouched

#### Scenario: Prerequisite and cleanup failures are visible
- WHEN fetch validation fails, upstream fails to start/readiness or exits early, app or harness fails, cancellation arrives, or owned children resist termination
- THEN the wrapper exits nonzero with bounded cleanup and credential-free diagnostics rather than silently skipping or substituting fake-omp
