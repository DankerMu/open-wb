# Design: step-args-output-split (#367, D2)

## Decisions

D1 Two fields, fixed roles. `detail` holds the args, written once at `step.start`. `output` holds the result text, written once at `step.end`. The summary reads only `detail`. `原始输出` shows both.

D2 Output normalization, `normalizeOutput(result)`:
- **AgentToolResult.** When `result` is a non-null object and `Array.isArray(result.content)`:
  - each block `{type:"text", text:string}` contributes `text`;
  - each block `{type:"image"}` contributes `[图片]`;
  - all other blocks are skipped;
  - the parts are joined with `\n`.
  - `details`, `providerMetadata`, `isError`, `useless` and every other key are dropped.
- **Absent, `null` or `undefined` result.** Output is `""`.
- **String result.** Used as is.
- **Anything else.** Compact JSON, the same serializer as detail.

Output keeps its line breaks. Detail keeps its U+2028/U+2029 escaping. Prototype-like keys are read with own-property checks only (existing mapper rule). Frame-level `isError` alone decides failed or done, as it does now at `events.ts:166`. `result.isError` is ignored.

D3 Caps. `MAX_STEP_POINTS = 4096` applies to detail and output separately.
- **Cutting.** Keep the first 4096 codepoints without splitting a surrogate pair (the existing `truncateCodepoints` logic), then append `…（已截断）`. Values of 4096 codepoints or fewer are untouched.
- **Truncated args.** Args truncated this way are no longer valid JSON. The summary then falls back to "first line" (accepted in D2).
- **Ring cost.** The ring holds 1000 events (`stream/ring-buffer.ts`), and each tool call produces one `step.start` (detail) and one `step.end` (output). The worst case is about 4.1M codepoints per session epoch, roughly 8 MB of UTF-16 for BMP text. Dropping `detail` from `step.end` keeps it at that figure instead of about 6M codepoints.
- **Adjusting.** Changing the constant later is a one-line edit plus this note.

D4 Schema. `033_chat_step_output.sql` contains only `ALTER TABLE chat_steps ADD COLUMN output TEXT;`.
- **Constraints.** No DEFAULT and no CHECK. It is nullable, and old rows read NULL.
- **Placement.** The file sorts after `032` (lexicographic runner, `migration-assets.ts:20-57`). `TRACKED_MIGRATION_FILENAMES` (`server/test/core-db-helpers.ts:8-21`) gains the entry.
- **Precedent.** This is the first ADD COLUMN in the repo. The runner transaction still gives atomicity. SQLite ADD COLUMN with no default and no constraint is metadata-only.
- **Writes.** `finishStep(stepId, status, output)` becomes `SET status = ?, output = ?, ended_at = ?`, and the `detail` clause is removed. `startStep` is unchanged: its INSERT omits output, so the column stays NULL. `toStepView` maps NULL to `""`.

D5 Compatibility. Web and server ship as one artifact (the server serves `STATIC_ROOT`, built from the same commit), so a fresh page always matches the server.
- **Tabs open during deploy.** A tab opened before the deploy has the old strict decoders. After the server restarts, the old tab sees a new `step.end` event or snapshot step as malformed: it goes into recovery, and the snapshot fails to parse on its existing `request_failed` path until the user reloads.
- **Why no in-page mitigation.** Code that is already loaded cannot be changed. Tolerant parsing would only help the next migration, and it is ADR-0011's staged upgrade path, which is out of scope here (YAGNI).
- **Scope.** This is a one-time transition cost before P0, not a runtime contract.

D6 Web rendering.
- **Blocks.** `<pre class="chat-step-detail">{detail}</pre>` is kept when detail is non-empty. `<pre class="chat-step-output">{output}</pre>` follows it when output is non-empty. An empty field renders no block.
- **When `原始输出` renders.** It renders when either field is non-empty; with both empty it is not rendered (current rule extended).
- **Styling.** `.chat-step-output` shares the `.chat-step-detail` styles, with the same wrapping and scroll so there is no horizontal page overflow. No labels are added (YAGNI); the order is args first, then output.

## Must preserve
- Mapper correlation, duplicate, unknown and late-frame rules; text/turn/error events; the pure, no-mutation guarantees; turn failure semantics.
- `summarizeStepDetail` and its 120-codepoint summary rule.
- Existing migrations, the ledger prefix rule and immutable receipts; business data across upgrade.
- Lossless text (NUL, BOM, astral) for detail and output through the store.
- ADR-0011: no path rewriting in detail or output.
- Owner scoping and no-store on REST.
- The ui-walk and ui-shots matrices.

## Governing invariant
A step's args are never lost or overwritten after start. Its result reaches SSE, DB and REST as the same normalized, bounded text. The client renders exactly what the server stored.

## Sibling surfaces
- **Producers.** `events.ts` (only mapper), `supervisor.ts:655-690` (persist then publish), `store.ts` (`startStep`/`finishStep`/`toStepView`/`STEP_COLUMNS`/`StepDbRow`/`StepView`), `rest.ts:37-43,181-187`.
- **Consumers.** `web/src/lib/session-contract.ts:15-21,91`; `web/src/features/chat/stream.ts:10-15,143-185,633-667`; `conversation-view.tsx:79-104`; `messages.css:284`.
- **Fixtures.** `fake-omp.mjs:327` (the only `tool_execution_end` site); web test fixtures holding `'{"output":"workbuddy-smoke"}'` (`web/test/chat-page-ownership-support.ts:17`, `chat-stream.test.ts:13`, `chat-steps.test.tsx:17`, `chat-page.test.tsx:30`, `chat-stream-recovery.test.ts:457-500`, `step-summary.test.ts:12`); server tests `session-events.test.ts` (end-detail cases incl. `:271-293`, `:489-560`), `session-supervisor.test.ts:100,355-368,420,476`, `core-db-chat-schema.test.ts:296-308`.
- **Specs and docs.** chat-stream, chat-sessions, chat-web main specs; the parent s1e chat-web delta `会话页` (three clauses); checklist CH-27; ADR-0011 already says "args/输出".

## Seams under test
- Pure mapper: `applyFrame` with real-shaped frames.
- Store on real SQLite (`:memory:` and a temp file for the upgrade case).
- Supervisor against the real fake-omp child: SSE observer events, `getMessages` and REST agree.
- Web: contract parser, SSE decoder, reducer, jsdom render.
- Real omp v18.0.10 + fake upstream through ui-walk (CI and local).

## Required evidence
- **E1 RED.** Before the mapper change, a new mapper test fails:
  - a real AgentToolResult end yields output `a\n[图片]\nb`;
  - the end event has no detail.
  A new web reducer test fails before the reducer change: step.end keeps the start detail and sets output. Record the failing assertions.
- **E2 mapper table.** A test covers each of these cases:
  - absent / null / string / non-content object / image;
  - `details` and `providerMetadata` dropped;
  - exactly 4096 codepoints kept whole with no marker;
  - 4097 or more cut with the marker;
  - an astral character straddling codepoint 4096 leaves no lone surrogate;
  - output newlines kept;
  - detail stays single-line with U+2028/U+2029 escaped;
  - frame `isError` true gives failed, and `result.isError` alone does not;
  - hostile shapes never throw: `content` not an array, `content` elements that are `null` or primitives (skipped), text blocks whose `text` is not a string (skipped), prototype-like keys.
- **E3 schema.** `core-db-chat-schema` covers:
  - column info includes `output TEXT` nullable without a default;
  - a fresh DB gets receipts through `033`;
  - upgrade: a DB built with only the six prior migrations plus chat rows and steps, then `openDb`, gives `033` appended once, old step fields unchanged, output NULL, and view output `""`;
  - reopen is stable.
- **E4 store/supervisor/REST.**
  - `finishStep` leaves detail unchanged and stores output.
  - Supervisor with real fake-omp: the observer's `step.end` output, `getMessages`, and REST `GET messages` all equal `workbuddy-smoke`, and detail equals the args JSON in all three.
  - REST steps have exactly `{id,ordinal,name,detail,output,status}`.
- **E5 web.**
  - The parser requires `output` and rejects missing or extra keys.
  - `step.end` is decoded with the new key set, and an event that still carries `detail` is rejected.
  - Render: an old row (output `""`) shows only the detail block; a failed step shows the output error text; the summary does not change after end; a long multi-line output is kept.
- **E6 ui-walk (real omp).** After `bash 已完成`:
  - the step summary is still `command: echo workbuddy-smoke`;
  - `.chat-step-output` inside `原始输出` contains `workbuddy-smoke`.

  This comes from the real omp AgentToolResult through fake upstream. Run it locally with the CI env recipe (`.github/scripts/ci-compiled-server.sh ui-walk`); CI also runs it. The DOM content is rendered from the REST snapshot or SSE, so it covers the real-omp path end to end; `smoke/chat.hurl` gets no output assertion because `smoke-live` shares it with a real model that may not run `echo`.
- **E7 gates.** `make check` (lint, typecheck, test, anti-drift), `make smoke`, `make ui-walk`; both openspec validates pass.

## Non-goals
- Backfilling old rows.
- Tolerant parsing.
- Step labels or visual redesign.
- Changing what fake upstream emits.

## Review focus
1. No code path writes `detail` after start (server SQL, mapper, web reducer).
2. Normalization cannot leak image base64 or `details`, and never throws on hostile or odd shapes (prototype keys, non-array content, non-string text).
3. The migration is additive and atomic, and upgrade keeps data.
4. SSE, DB and REST agree, and the web's strict key sets match the server exactly.
5. The parent delta clauses match this change's MODIFIED `会话页` text, so the s1e archive does not revert them.
