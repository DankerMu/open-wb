## 1. Implementation and proof

- [x] 1.1 Add test-first real filesystem contracts for one-level listing, symlink/FIFO filtering, UTF8 order counterexample, byte size/mtimeMs, classifier-produced headers, exact text/image thresholds, raw byte cutoff and no-body rejection; preserve honest RED logs.
- [x] 1.2 Implement tree.ts and preview.ts only with canonical errors, pure metadata classification and bounded native streams; additive headers/limit fields supply real production metadata ownership, no DB/Fastify/route or sandbox duplicate.
- [x] 1.3 Verify completion/error/earlydestroy resource release and empty stream, targeted tests, server coverage/type/build/static gates and compiled real-file smoke.
- [x] 1.4 Expanded static cross-review and exact-head CI completed; PR #175 merged after one assertion-only fix pass, reviewed SHA `02a06d4f29d94eb438c0dd94bd4059f413c429b5`, CI35527764996 green. This archive follow-up promotes only helper requirements, updates parent3.4 and preserves #127 metadata/authorization handoff.

## 2. Risk mapping

- Selected Public API / CLI / script entry: three helper signatures, additive headers/limit, consumer-focused real file tests and compiled smoke.
- Selected Config / project setup: knip.json server-workspace exact mkfifo system-binary declaration required by real FIFO tests; npm run deadcode plus actual mkfifo tests/smoke on Darwin and Ubuntu. No dependency, broad ignore or threshold change.
- Selected File IO / path safety / overwrite: real lstat filtering, actual symlinks/FIFO/nesting, trusted authorized absolute paths; no writes or TOCTOU claims.
- Selected Schema / columns / units / field names: exact Entry shape, byte sizes, epoch-ms, headers/limit and unmodified bytes.
- Selected Auth / permissions / secrets: html/plain+nosniff metadata, unsupported/oversize no body read, no absolute path in metadata/errors; authentication/sandbox/HTTPstatus explicit non-goals #127.
- Selected Concurrency / shared state / ordering: classification before content stream, native stream error/close/destroy; stable filesystem scope, no race-hardening claim.
- Selected Resource limits / large input / discovery:1MiB/10MiB exactand+1, zero, only one directory level, no wholefilebuffering, encode names once.
- Selected Legacy compatibility / examples: demo PREVIEWABLE exactset and web size/mtime/header consumption; server regression.
- Selected Error handling / rollback / partial outputs: canonical415/413 classification; native fs errors propagate, no empty fallback; zero-limit safe stream and descriptor closure.
- Not selected Release / packaging / dependency compatibility: zero dependencies; normal build/compiled smoke exercise file modules.
- Selected Documentation / migration notes: helper-only spec promotion, header/limit interface clarification, parent3.4 and future#127 obligations.

## 3. Commands and phase discipline

Focused server Vitest paired workspaces tree/preview tests. `npm test --workspace server`; `npm run typecheck --workspace server`; `npm run build --workspace server`; scoped Biome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
mkfifo must create a real FIFO on supported local macOS and Linux CI; no silent testskip. Main runs separate compiled helper smoke on real tempfiles, not tests relabeled or fakeheaders.
Main owns fixture/git; one implementer, then frozen static review. Leaves never contact/wake peers. User waived perissuehumanreview for Epic111; final fullfunctionalacceptance remains human.
