## Risk Packs
- Schema / migration — selected: `033` ADD COLUMN, tracked list, upgrade path → 1.2, 2.3.
- Public API (SSE + REST payload) — selected: `step.end{…,output}` without detail, REST step `output`, web strict key sets → 1.1, 1.4, 1.5, 1.7, 2.4, 2.5.
- Legacy compatibility — selected: pre-migration rows (NULL → `""`), already-open tabs (design D5, accepted), summary rule unchanged → 1.3, 1.8, 2.3, 2.5.
- Resource limits — selected: 4096 caps with marker, ring cost note (D3) → 1.1, 2.2.
- Error handling — selected: failed step output, odd/hostile result shapes never throw → 1.1, 2.2, 2.5.
- Documentation / migration notes — selected: four specs, parent delta, checklist CH-27 → 1.10, 1.11, 2.7.
- Config, File IO/path safety, Auth/secrets, Concurrency, Release — not selected: no config/IO/auth change; ADR-0011 path rule kept verbatim (2.2); persistence ordering unchanged.

## 1. Implementation
- [x] 1.1 `server/src/sessions/events.ts`: `MAX_STEP_POINTS = 4096`; args serializer (compact JSON, U+2028/U+2029 escaped) and `normalizeOutput` per design D2; `truncateStep` = codepoint-safe cut + `…（已截断）`; `step.start{…,detail}` unchanged in shape; `step.end{messageId,stepId,status,output}`; `ChatEvent` type updated.
- [x] 1.2 `server/src/core/db/migrations/033_chat_step_output.sql` (`ALTER TABLE chat_steps ADD COLUMN output TEXT;`); `server/test/core-db-helpers.ts` `TRACKED_MIGRATION_FILENAMES`, `COMPLETE_CATALOG` receipts and `sequenceRows` (6 → 7, `:65-73`); `server/test/core-db-chat-schema.test.ts` `seedPre032Database` (`:213`) must exclude 033 too and its `HISTORICAL_FILENAMES` expectation adjusted; column snapshot `:296-308`.
- [x] 1.3 `server/src/sessions/store.ts`: `StepDbRow`/`STEP_COLUMNS`/`StepView` gain output; `finishStep(stepId,status,output)` sets only status/output/ended_at; `toStepView` NULL → `""`.
- [x] 1.4 `server/src/sessions/supervisor.ts`: step.end persistence passes output; published event carries output, no detail.
- [x] 1.5 `server/src/sessions/rest.ts`: `PublicStep` + mapping gain `output`.
- [x] 1.6 `server/test/support/fake-omp.mjs:327`: `result: { content: [{ type: "text", text: TOOL_OUTPUT }], details: { exitCode: 0 } }`; update fake-omp tests if they pin the old shape.
- [x] 1.7 Web `web/src/lib/session-contract.ts` (`ChatStep.output`, `parseStep` keys), `web/src/features/chat/stream.ts` (`ChatStepView.output`, snapshot conversion, `decodeStepEnd` keys `{messageId,stepId,status,output}`, `startStep` output `""`, `endStep` sets status + output and keeps detail).
- [x] 1.8 `web/src/features/chat/conversation-view.tsx` + `messages.css`: design D6 (detail block, output block when non-empty, disclosure when either non-empty; `.chat-step-output` shares `.chat-step-detail` styling).
- [x] 1.9 Update existing server and web tests listed in design "Sibling surfaces" to the new contract (end has output, detail unchanged), plus `server/test/session-ring-buffer.test.ts:144,159`, `session-store-stream.test.ts:117,124,194` (finishStep third arg is now output), `session-rest.test.ts:153`, `session-store-helpers.ts:87,91` (step column list); `server/test/sqlite-text.test.ts:190` moves its lossless (NUL / UTF-16 DB) finishStep case from detail to output; keep `step-summary.test.ts` rules (pure function) — only fix fixtures that model an end-overwritten detail.
- [x] 1.10 `web/e2e/ui-walk.spec.ts`: E6 assertion at the existing bash-done step (near `:695`), expanding `原始输出` without breaking the W-scroll steps.
- [x] 1.11 `docs/acceptance/demo-parity-checklist.md` CH-27 behavior text: `原始输出` 展开后显示工具参数（detail）与工具输出（output）两块; line refs stay pinned to `9a40ca8`.
- [x] 1.12 Spec deltas in this change and the three identical parent-delta clauses in `openspec/changes/s1e-frontend-parity/specs/chat-web/spec.md` (orchestrator, done). Archive order: this change archives before s1e (its MODIFIED `会话页` is based on main; if s1e archives first, redo that MODIFIED block on the new main before archiving).

## 2. Verification
- [x] 2.1 E1 RED recorded (mapper real-shape/no-detail test and web reducer detail-preservation test fail before their implementation; failing assertion lines in the report).
- [x] 2.2 E2 mapper table incl. ADR-0011 output path case, cap boundaries (4096 whole / 4097 cut / astral straddle), newline kept, U+2028 in detail escaped, frame vs result `isError`, prototype-like keys and non-array `content` / non-string `text` never throw.
- [x] 2.3 E3 schema fresh + upgrade (six-receipt DB with chat rows → `033` once, old step fields unchanged, output NULL, view `""`) + reopen stable.
- [x] 2.4 E4 store/supervisor/REST agreement with real fake-omp; REST step key set exact.
- [x] 2.5 E5 web parse/decode/reducer/render cases (old row, failed step, summary stable after end, long multi-line output, `step.end` carrying detail rejected).
- [x] 2.6 E6 local ui-walk with the CI env recipe (fresh temp dir; `bash .github/scripts/ci-compiled-server.sh ui-walk` after `npm run build --workspace web && npm run build --workspace server && make omp-fetch`) and local `bash .github/scripts/ci-compiled-server.sh smoke` → both exit 0.
- [x] 2.7 `make lint`, `make typecheck`, `make test`, `make anti-drift` exit 0; `openspec validate step-args-output-split --strict --no-interactive` and `openspec validate s1e-frontend-parity --strict --no-interactive` pass.
