## Context
Change surface: existing ApiClient and request pipeline, new session DTO/parser owner, minimal shared JSON predicate extraction.
The issue is an adapter, not a second REST client or client-side business validator.

## Goals / Non-Goals
Add four typed methods; preserve existing consumers and all error/401 behavior.
No page, reducer, EventSource, server, database, dependency or global ReturnType cleanup.

## Decisions
- Governing invariant: an accepted response preserves the server's complete public value, including text, order and numeric-vs-null cursor; invalid responses fail atomically through ApiError.
- listSessions GET /api/sessions -> 200 {sessions}; createSession POST same path with no body/content-type -> 201 session.
- getMessages GET /api/sessions/:encodedId/messages -> 200 {session,messages,streamCursor}; prompt POST /api/sessions/:encodedId/prompt JSON {message} -> 202 {userMessageId,assistantMessageId}.
- All methods use existing same-origin credentials, optional AbortSignal, exact success statuses, shared fetch/error sanitization and unauthorized notification. GET uses no-store.
- Forward prompt text unchanged; server alone owns trimming/UTF8 size/business validation. Encode path IDs rather than reject caller input locally.
- DTO objects require exactly the producer's public keys. Session: id/title/status/createdAt/updatedAt; message: id/role/content/status/createdAt/steps; step: id/ordinal/name/detail/status.
- Session ID is canonical 32 lowercase hex; title nullable string; session status idle/running/done/failed; role user/assistant; message and step status running/done/failed.
- Numeric DTO fields must be safe integers. Session timestamps, epoch, non-null seq and ordinal are nonnegative. Message createdAt is signed; persisted message/step IDs have no positive CHECK and must not gain one in this adapter. Preserve zero ordinal and zero cursor.
- Preserve NUL/BOM/Unicode, empty text, array ordering and null cursor without normalization, filtering or fallback. Missing cursor is invalid, not zero.
- api.ts is currently 681 lines. Move existing generic exact-object/array/integer predicates unchanged to an adjacent owner if needed; use them from old and new parsers. No cycles, duplicate validators, request injection framework or parallel legacy paths.
- Name concrete types at their owner; import them. No concrete ReturnType/Awaited<ReturnType> contracts. Keep existing ApiClient and other current exports in place; no speculative unused exports.

## Sibling Surfaces / Must Preserve
server/src/sessions/rest.ts produces the DTOs; 032_chat_sessions.sql owns signed/nonnegative domains; #214 owns snapshot cursor meaning. These are read-only oracles.
Existing API auth, workspace, audit and preview parsers share predicates; preserve exact-key rejection, signed workspace timestamp acceptance, error secrecy, callback exception containment and preview URL ownership.
Future #93 consumes snapshot cursor and #104 consumes these methods; neither is implemented here.

## Required Evidence
Public factory baseline observes absent capabilities; paired tests capture preimplementation RED and candidate GREEN.
Valid full snapshot with signed message timestamp/IDs, zero ordinal, numeric and sealed cursor -> identical consumer data; malformed nested DTO or missing cursor -> stable request_failed without partial result.
Each method wire contract plus 409/502 preserved envelope, valid/malformed/non-JSON 401 callback, wrong success status and fetch rejection -> existing errors and notification policy.
Existing API suite reference GREEN -> extracted candidate GREEN; parent qualifies a plausible predicate regression in a disposable copy.
Parent-owned client + actual local HTTP/server smoke exercises create/list/history/prompt/error and login-expiry behavior; no browser rendering claim.
Static/type/build/drift and complete web coverage suite; CI independently covers repository gates.

## Risks / Rollback
Strict DTO rejection intentionally follows existing client policy; future server fields require a coordinated contract update.
Local parent/writer share OS authority: protected-file hashes and independent CI are evidence controls, not an OS verifier enclave.
Rollback is a revert of this atomic source change; no persistent format or data migration.
