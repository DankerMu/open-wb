## 1. Implementation
- [x] 1.1 Upgrade existing guard self-test to check combined diagnostics, counts and paths for two violations and 800-line acceptance; demonstrate RED against original source on macOS UTF-8.
- [x] 1.2 Brace line-count expansion without changing threshold, locale or #44 paths.
## 2. Verification
- [x] 2.1 Direct CLI probes: macOS /bin/bash and /opt/homebrew/bin/bash × C.UTF-8/en_US.UTF-8/zh_CN.UTF-8/C, 800/801/802-line inputs; zero for valid, nonzero plus every count/path BLOCK and no unbound error for violations.
- [x] 2.2 First-party scripts/hook regex scan: zero unbraced variable/non-ASCII adjacency. Selected CLI/error/compatibility packs map to 2.1 and this check.
- [x] 2.3 Homebrew Bash PATH: make guard, make test-guardrails, make check; Linux Ubuntu 24.04 direct probes if available plus required PR CI anti-drift. Selected docs pack maps to strict OpenSpec validation and this fixture.
