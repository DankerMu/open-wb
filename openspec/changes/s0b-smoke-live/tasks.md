## Risk Packs
- Public API/Schema selected: exact Make command and argv contract (1.1–1.2,2.1).
- Config/Input + Error selected: required raw variables, literal transfer, missing Hurl and failure status (1.2,2.1).
- Auth selected only credential non-disclosure to child/output; account auth behavior unchanged (2.1).
- Concurrency/Resource not selected: no new service/process ownership or retries, synchronous existing command shape.
- Legacy compatibility selected: old smoke/UI/omp-fetch recipes and full guards unchanged (1.1–1.2,2.2).
- Documentation selected: header, parent receipt and archive; AGENTS/constraints mirrors explicitly #107 (3.1).
- Domain cross-service/offline selected: caller-owned service, clean child, no real upstream calls or new dependency (2.1).
- Domain sandbox/SQLite/browser/process-runtime not selected: unaffected; no compiled app changes.

## 1. Implementation
- [x] 1.1 Extend the existing Make contract oracle first: protected smoke-live header/recipe/.PHONY and spaced duplicate mutation; parent runs the failing contract against absent target before implementation.
- [x] 1.2 Implement raw env gates and exact clean Hurl invocation in Makefile; update .PHONY/header, preserve normal smoke recipe byte-for-byte.

## 2. Verification
- [x] 2.1 Parent real Make subprocess proof for missing each/both/empty variables, missing Hurl, exact argv/PATH-only env, literal hostile bytes without execution, no credential disclosure and nonzero Hurl propagation; qualify wrong candidates and restored result.
- [x] 2.2 Complete make test-guardrails, narrow shell/scope checks and strict OpenSpec; current target/recipe oracle GREEN and required mutants RED.
- [ ] 2.3 Compact read-only source review and exact-head required CI pass.

## 3. Delivery
- [ ] 3.1 Merge source and close issue, sync parent receipt and prepare canonical archive. Independent archive PR/CI/merge gates #105.

Boundary: chat.hurl is the explicit #105 deliverable, not a stub to add here. #94 accepts the Make command boundary; actual live dialogue is not claimed by the disposable Hurl argv recorder. No real upstream credentials or network calls used for qualification.

Local receipts `/tmp/open-wb-issue94-evidence/`: baseline contract0 → updated requirement on absent target1 → implemented0; absent Make entry itself is setup RED only. Nine real Make/native argv-env cases pass; five runtime wrong candidates and four independent contract mutants fail for intended behavior, then restore and dedicated command stability pass. Full `make test-guardrails`: ci-harness484PASS/0FAIL; shell syntax and anti-drift pass. A real make dev→compiled configuration counterexample caught global empty MODEL_* exports; target-local raw overrides repair it without changing startup. Node's macOS runtime added __CF_USER_TEXT_ENCODING even under direct env-i control, so the oracle was changed to a native C process-entry recorder rather than relaxing PATH-only evidence. No actual upstream credentials or model requests used; chat.hurl remains #105.
