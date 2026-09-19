## 1. Implementation and evidence
- [ ] 1.1 Establish red checks at the shell/Make boundary for the new supply contract before production implementation; retain evidence externally.
- [ ] 1.2 Implement fixed v18.0.10 supply for Darwin arm64/Linux x86_64 with pinned SHA256, verified cache skip, explicit unsupported-platform failure and safe failed-download cleanup.
- [ ] 1.3 Add Make target and PHONY/header alignment; extend existing exact recipe and duplicate-target mutation oracle without weakening prior checks.
- [ ] 1.4 Run real make omp-fetch and var/omp/omp --version; assert omp/18.0.10; run again with downloader forbidden and observe skip.
- [ ] 1.5 Prove bad checksum reports expected/actual and leaves no destination; unsupported platform fails; verify both digest entries against official release.
- [ ] 1.6 Run make test-guardrails and shell syntax checks; independently audit evidence and pass CI before merging.

## Risk pack mapping
- Selected Public API / CLI / script entry: tasks 1.1, 1.3-1.6; real make command and duplicate definition rejection.
- Selected Config / project setup: tasks 1.2-1.4; fixed platform map and PHONY alignment.
- Selected File IO / path safety / overwrite: tasks 1.2, 1.5; verified cache and no corrupt destination.
- Not selected Schema / columns / units / field names: no data schema.
- Not selected Auth / permissions / secrets: no credentials accepted; executable integrity covered by file/release packs.
- Not selected Concurrency / shared state / ordering: concurrent installation is outside this issue's contract.
- Not selected Resource limits / large input / discovery: fixed single release asset, no discovery.
- Not selected Legacy compatibility / examples: new command; existing recipes preserved by existing guardrails.
- Selected Error handling / rollback / partial outputs: tasks 1.2, 1.5; failed download/digest leaves no new binary.
- Selected Release / packaging / dependency compatibility: tasks 1.2, 1.4, 1.5; official fixed release, supported platform digests, actual version.
- Selected Documentation / migration notes: task 1.3; Make header updated, AGENTS/constraints synchronization explicitly deferred to #107 as issue requires.
