## Context

Change surface: core/audit + shared core/errors, existing HTTP mapper/consumers, architecture ownership docs. User approved the expanded boundary; #84/#115 remain pending and own additional codes.
Must preserve: current five HttpError codes, name/code/message and constructor identity; exact status/message/no-store envelopes; forged/plain errors remain generic5xx; content-parser route ownership unchanged; existing audit schema/append-only triggers unchanged.
Governing invariant: only the exact admin role bypasses actor filtering, and all pages apply that same visibility predicate; shared application errors have one runtime identity without any core→feature/http import.
Sibling surfaces: emit serialization/insert, query validation/filter/order/map, HTTP classify/guard/app auth mapper, every HttpError/HttpErrorCode consumer, future audit REST #124 and error-code additions #84/#115.

## Goals / Non-Goals

Goals: observable audit round-trip and correct account pagination; preserve canonical HttpError contract without reverse dependency.
Non-goals: HTTP audit route, audit callsites, #84/#115 new codes, new dependencies, schema migrations, retention/export, new error aliases or compatibility re-exports.

## Decisions

- `emit(db,event): number`, input kind/actorId/title plus optional detail object/workspaceId/ts. Omitted ts uses Date.now; omitted detail stores {}; omitted workspaceId stores SQL NULL. Serialize before one bound INSERT; serialization/FK/check failures propagate and cannot append a partial row. Preserve explicit ts=0.
- `query(db, principal:{id:string,role:string}, opts={})` uses an audit-owned structural principal, no auth type import. Return camelCase fields and JSON-parsed detail, workspaceId string|null.
- Only role exactly `管理员` sees all actors. Every other role filters actor_id=principal.id. Order id DESC, regardless of ts.
- limit is numeric integer1..200, default50. before is an optional string of ASCII canonical positive digits, no signs/space/leading zeros/newlines. Invalid values throw the canonical HttpError bad_request.
- Canonical decimal cursors above Number.MAX_SAFE_INTEGER remain valid; compare without lossy Number conversion. A cursor beyond SQLite signed64 max is a valid upper bound matching all positive ids, not a bad_request or overflow. Implementation may bind BigInt within SQLite range and omit the redundant bound above it. Cursor is an opaque ID boundary, not a timestamp.
- Keep codes/messages and HttpError in core/errors/index.ts; keep a typed exhaustive status map and HTTP reply behavior in http/errors.ts. No Fastify import in core. Remove old class/type exports from http index; all callers import canonical core module. Use LSP references and available code actions for symbol-aware cutover.
- Existing error constructor names/messages remain byte-identical; do not use a duck-typed error or duplicate code/message definition.

## Risks / Trade-offs

JSON detail follows normal JSON object serialization; non-JSON/cyclic runtime values may throw rather than being silently replaced. No new deep validation/coercion policy.
Shared error relocation touches auth/guard/error suites: exact HTTP behavior must stay green; core owns no statuses or route policy.
Cursor precision must be tested at boundaries, including canonical strings beyond64-bit. No new cursor length cap or generic pagination abstraction.
Current public IDs/ts are JavaScript numbers; this slice does not redesign SQLite identifiers to bigint transport. Native node:sqlite numeric decoding errors for out-of-safe stored integers propagate; do not silently coerce those rows or mistake them for invalid cursor input.

## Evidence and rollout

TDD real openDb(:memory:) accounts u1/u2/u3, interleaved actors and nonmonotonic ts, limit boundaries/default, multi-page composition, exact admin role, JSON nested round-trip, explicit0/default-now, failed emit leaves event set unchanged.
Default-limit oracle: seed at least 51 visible member events interleaved with another actor; omitted limit returns exactly the newest 50 visible rows, and the next page returns the remainder without overlap. Filtering must precede limiting.
Precision oracle uses public query() on an isolated real openDb(':memory:') audit_events table seeded with explicit ids 9007199254740991 and 9007199254740992. Native default decoding of the latter throws RangeError/ERR_OUT_OF_RANGE. An exact before='9007199254740993' must include that row and propagate that native error; lossy Number conversion incorrectly excludes it and returns a successful safe-only page. Establish the native decoding oracle separately; the permanent regression must call query(), not a scratch SQL table alone. Do not assert an impossible decoded title for the oversized row or add bigint public IDs. A separate ordinary-row audit fixture with before='9223372036854775808' must return the eligible row, proving no bind overflow/rejection. Initial platform experiment demonstrated both exact-error and rounded-success outcomes on Node24.
Existing app/auth error suites prove relocation identity and forged error rejection; scoped module tests plus server coverage/type/build/static gates. Actual compiled emit/query smoke and HTTP mapper behavior test evidence are separate.
Rollback: revert this atomic PR; no schema/data migration. Review focus: actor predicate across pages, canonical cursor precision, one shared error identity, no old imports/re-exports.
