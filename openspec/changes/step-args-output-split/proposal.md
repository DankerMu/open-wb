## Why
#367 — decision D2 recorded 2026-09-25 (https://github.com/DankerMu/open-wb/issues/367#issuecomment-5836156835). Step `detail` is a ≤120-codepoint server summary that `step.end` overwrites with the summarized result (`server/src/sessions/events.ts:26,139,165,281-311`; `server/src/sessions/store.ts:441` `detail = COALESCE(?, detail)`; web reducer `web/src/features/chat/stream.ts:180`). Consequences: `原始输出` can never show the "full raw detail" the chat-web Step cards sentence promises; any JSON over 120 codepoints reaches the client as an invalid prefix; after a step ends the args are gone (a bash card no longer shows its command); and real omp results are `AgentToolResult` `{content:[text|image…],details?,…}` (`resource/oh-my-pi/packages/agent/src/types.ts:678-690`), so summarizing them yields `content: [{"type":"text",…` and would store image base64. fake-omp emits a non-real `{output}` result (`server/test/support/fake-omp.mjs:330`), which is why tests never saw it.

## Triage
Issue type: bug (spec conflict + data loss)
Fixture level: expanded
Upstream suggested level: absent (expanded: schema migration, SSE/REST payload shape, server+web cross-layer)
Blast radius: every chat step — SSE `step.start/step.end`, `chat_steps` rows, `GET /api/sessions/:id/messages`, web parse/reduce/render; the ring buffer holds larger events.
Selected risk packs: Schema / migration; Public API (SSE + REST payload); Legacy compatibility (pre-migration rows, already-open tabs); Resource limits (4096 caps, ring memory); Error handling (failed steps, non-conforming results); Documentation / migration notes (four specs, active parent delta, checklist).
Evidence floor: RED-first mapper and reducer tests for the real result shape and detail preservation; migration fresh/upgrade tests; one real-omp ui-walk assertion; `make check`, `make smoke`, `make ui-walk` green.

## What Changes
- Mapper (`server/src/sessions/events.ts`): `detail` = compact single-line args JSON (U+2028/U+2029 escaped), set once at `step.start`; `step.end` becomes `{messageId,stepId,status,output}` — no `detail`. `output` = normalized result text: `content` text blocks + `[图片]` per image block joined `\n`, everything else dropped; absent/null → `""`; string → as is; other value → compact JSON. Both capped at 4096 codepoints, surrogate-safe, `…（已截断）` appended when cut. Frame-level `isError` stays the only failure source.
- Migration `033_chat_step_output.sql`: `ALTER TABLE chat_steps ADD COLUMN output TEXT` (nullable, no default, no backfill) — the repo's first ADD COLUMN migration.
- Store / supervisor / REST: `finishStep` writes status, output, ended_at only; step views and REST steps gain `output` (NULL → `""`).
- fake-omp: `tool_execution_end.result` becomes a real `AgentToolResult` (`{content:[{type:"text",text}],details:{…}}`).
- Web: `ChatStep.output` in snapshot parse (strict keys), SSE `step.end` decode (strict keys), reducer (`step.end` sets status + output, never detail), `原始输出` shows a detail block then an output block when non-empty; summary unchanged (from detail only).
- Specs: chat-stream MODIFIED `纯协议事件归约`, `步骤 detail 不做路径改写`; chat-sessions ADDED `步骤输出列迁移`, MODIFIED `会话数据 schema` (receipts scenario), `会话 REST`; chat-web ADDED `步骤 args 与输出分栏`, MODIFIED `API 客户端扩展`, `纯会话视图归约`, `会话页`, `步骤卡原始输出不做路径改写`.
- Active parent delta `openspec/changes/s1e-frontend-parity/specs/chat-web/spec.md` (MODIFIED `会话页`): the Step-cards clause, the `步骤卡呈现` scenario and the `Once-only` THEN clause edited to the identical new wording, so s1e's archive keeps them.
- `docs/acceptance/demo-parity-checklist.md` CH-27 wording: `原始输出` shows args and output.

Refinement of the D2 wording: D2 says "`step.end` payload 增加 `output`". This change also removes `detail` from `step.end`. Detail is fixed at start and the reducer never needs an end copy, and removing it halves the worst-case ring cost (design D3). Both are key-set changes for strict parsers, so compatibility is the same either way.

Must preserve: text/turn/error event semantics and ordering; step identity/correlation rules; `summarizeStepDetail` rules and 120-codepoint summary; ADR-0011 (no path rewriting in detail or output); prior migrations and ledger rules; owner scoping; U+0000/astral lossless text through store.
Out of scope: backfilling old rows (data never stored); tolerant (extra-key) client parsing (ADR-0011 upgrade path); step card visuals beyond the two blocks.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-stream`: MODIFIED `纯协议事件归约`, `步骤 detail 不做路径改写`.
- `chat-sessions`: ADDED `步骤输出列迁移`; MODIFIED `会话数据 schema` (fresh-receipts scenario says "begin" instead of an exhaustive list), `会话 REST`.
- `chat-web`: ADDED `步骤 args 与输出分栏`; MODIFIED `API 客户端扩展`, `纯会话视图归约`, `会话页`, `步骤卡原始输出不做路径改写`.

## Impact
Server: `sessions/events.ts`, `sessions/store.ts`, `sessions/supervisor.ts`, `sessions/rest.ts`, `core/db/migrations/033_chat_step_output.sql`, `test/support/fake-omp.mjs`, `test/core-db-helpers.ts` and affected tests. Web: `lib/session-contract.ts`, `features/chat/stream.ts`, `features/chat/conversation-view.tsx`, `features/chat/messages.css`, affected tests, `e2e/ui-walk.spec.ts` (one assertion). Specs as above; parent delta (three clauses); checklist CH-27. Deploy: web and server ship together (see design D5).
