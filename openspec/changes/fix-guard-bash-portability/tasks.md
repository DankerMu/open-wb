## 1. Implementation
- [x] 1.1 Add public-seam compatibility regressions in existing test-guardrails: empty source and staging, compliant real commit, forbidden-suffix rejection; parent qualifies historical source RED under system Bash, current GREEN.
- [x] 1.2 Atomically replace all three list readers; preserve filtering, literal argv, empty-array safety and #42 diagnostics; no newer-shell builtin names in first-party scripts/hooks.
- [x] 1.3 Record Bash 3.2 baseline and Node/uv PATH prerequisites in constraints.yaml without changing thresholds or CI.
## 2. Verification
- [x] 2.1 macOS /bin/bash 3.2 and Homebrew Bash 5.x: no-arg empty/nonempty guards; isolated actual git hook/commit acceptance and diagnostic rejection; no unbound errors; include whitespace filename preservation.
- [x] 2.2 Strict system PATH make guard exit 0; dependency-complete system-first PATH make anti-drift and make test-guardrails exit 0; Homebrew-first make check exit 0. Record literal minimal-PATH missing-tool prerequisite if encountered, never claim it passed.
- [ ] 2.3 First-party newer builtin search zero hits; Ubuntu 24.04 direct CLI compatibility and required PR CI all green; strict OpenSpec validation. These commands map CLI/legacy/errors/dependencies packs; constraints note maps setup/docs packs.
