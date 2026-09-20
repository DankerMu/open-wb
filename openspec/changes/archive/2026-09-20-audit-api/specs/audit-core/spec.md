## ADDED Requirements

### Requirement: emit 与 query
`emit(db, {kind, actorId, title, detail?, workspaceId?, ts?})` SHALL append one event and return its numeric id, default ts to current epoch milliseconds, default detail to an empty JSON object, and default workspaceId to null. Explicit ts zero SHALL be preserved. JSON serialization and database failures SHALL propagate without an appended partial event. `query(db, principal, {limit?, before?})` SHALL return `{id, ts, actorId, kind, title, detail, workspaceId}` with deserialized detail in id DESC order. Only role exactly `管理员` SHALL bypass actor_id=principal.id filtering. limit SHALL default to50 and accept integer1..200 only; invalid values SHALL throw canonical HttpError("bad_request"). before SHALL be an optional canonical positive ASCII decimal string with no other characters and filter id<before without precision loss. Canonical values beyond SQLite's maximum id SHALL remain valid upper bounds.

#### Scenario: 账号隔离与分页
- WHEN events from u1/u2 have interleaved ids and timestamps, and member u1 and admin u3 query successive before pages
- THEN u1 sees only its own events, u3 sees all, every page is id-descending, and page concatenation equals the corresponding full visible set without duplicates or omissions

#### Scenario: 非管理员角色不能越权
- WHEN a principal with any role other than exact 管理员 queries
- THEN every returned row belongs to that principal, including paginated requests

#### Scenario: 参数边界
- WHEN limit is0/201/1.5 or before isabc/0/-1/01, whitespace or newline contaminated
- THEN query throws the canonical HttpError with code bad_request
- WHEN limit is1/200 or an ordinary safe-ID event set is queried with a canonical cursor exceeding safe-number or signed64 range
- THEN valid limits apply and eligible rows are returned without bad_request, bind overflow or lossy cursor conversion

#### Scenario: 超出数字解码范围的存储行不被静默跳过
- WHEN a real migrated audit_events table contains explicit ids9007199254740991 and9007199254740992, and query is called with before='9007199254740993'
- THEN the exact boundary includes the latter row and query propagates native node:sqlite RangeError/ERR_OUT_OF_RANGE for its numeric decoding; it SHALL NOT silently return a rounded safe-only page, misclassify the valid cursor as bad_request, or introduce bigint public IDs

#### Scenario: JSON 与时间及失败原子性
- WHEN events contain nested JSON detail, explicit timestamp0, omitted timestamps/details/workspace, or invalid serialization/FK data
- THEN successful events round-trip exactly with the specified defaults and IDs, default timestamp reflects the current clock, and failed emits leave the stored event set unchanged
