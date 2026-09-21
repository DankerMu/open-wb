## Why
Issue #90 supplies the process-local bearer registry already required by SessionRuntime and model-proxy. Runtime must issue/revoke a per-session opaque credential without exposing upstream gateway credentials or leaving old tokens active after rotation.
## What Changes
- Add TokenRegistry with issue(sessionId), lookup(token), revoke(sessionId), cryptographic 32-byte lowercase-hex issuance, exact lookup and atomic rotation/revocation.
- Keep state per instance and private; failed entropy acquisition or a live-token collision fails closed without replacing existing bindings.
- Paired tests include the issue-required1000 real random tokens and lifecycle/negative cases; parent validates the actual model-proxy lookup boundary without changing it.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `model-proxy`: add the independent bearer registration/rotation requirement alongside the existing endpoint requirement; no endpoint change.
## Impact
server/src/sessions/tokens.ts plus paired tests only. No configuration, dependencies, DB, timers, env reads, logging, HTTP route or runtime changes. Structural ports remain owned by model-proxy (TokenLookup) and runtime (SessionTokens); production TokenRegistry does not import either feature merely to satisfy types.
## Fixture and evidence
Expanded (inherited issue90; credential identity/rotation merits security scrutiny). Construction/Critical credential scope, not process sandbox implementation. A1 tests before source SETUP, separately authorized callable wrong A2 semantic RED, original bytes frozen before B. Parent real random/lifecycle/failure probes, actual local HTTP proxy token acceptance/rejection, disposable wrong candidates, restore/stability, fullserver/static/build/OpenSpec and exact-SHA CI. No OS-enclave or release claim. User per-issue human waiver does not waive agent review/CI/final Epic functional review.
