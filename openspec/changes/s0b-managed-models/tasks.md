## 1. Fixture and chronology
- [x] 1.1 Expanded fixture reviewPASS with no additions; strict validation exit0. Fixture/dependency/config identities frozen beforeA1.
- [ ] 1.2 A1 tests before source, honest SETUP; separately authorized A2 callable wrong-output semanticRED; parent checks chronology beforeB.
## 2. Generator
- [ ] 2.1 Implement sole address derivation and deterministic safely-quoted blockYAML writer; no env reads/startup/proxy/dependency changes.
- [ ] 2.2 Paired actual-filesystem testsGREEN: address forms, exact parsed schema/credential indirection, idempotence/update, escaping and failure propagation.
## 3. Acceptance and delivery
- [ ] 3.1 Parent compiled filesystem/network probe, semantic mutants/reference/restoration; scoped static/fullservercoverage/drift/build/strictOpenSpec.
- [ ] 3.2 Expanded correctness/test-evidence+spec/security-perf review; bounded fix gate and sameSHA CI/sourcePRmerge.
- [ ] 3.3 Parent task2.4 update and docs-only canonical promotion/archive; keep prior proxy/fake requirements intact.
## Risk pack mapping
Selected API/config/schema: exact twoexports/AddressInfo/YAML fields→2.1/2.2/3.1. Selected fileIO/path: trusted agentDir/create/overwrite/reject→2.2/3.1; user path/sandbox validation not owned here. Selected secrets: constant env-name/no upstream reads or content→2.2/3.1. Selected error: real IO rejection→2.2. Selected compatibility: fake-omp block subset, existing proxy/process untouched→2.2/3.1. Selected release/deps/docs: no runtime dependency, compiled import/parentledger/canonical archive→3.1/3.3.
Not selected runtime auth/token lifecycle, HTTP envelope/routes, concurrent writers, large streams/performance, database migration, web UI: unchanged/non-goals. Project domain selected child-environment/cross-service credential isolation at generated-config boundary→2.2/3.1; actual child/HTTP secret-sentinel composition belongs#102. Offline deployability→standard Node/no dependency,3.1. Tenant/sandbox isolation, SQLite catalog, browser navigation/persistence are not touched.
## Governance
One writer/currentcheckout; no newworktree. Source/test/config edits only implementer. StageA1/A2/B explicit barriers; no retrospectiveRED. Reviewers leaf/read-only/no validation. User waived per-issuehumanwhitebox until finalEpicfunctionalreview, not agentreview/CI. Bound fix passes unchanged.
