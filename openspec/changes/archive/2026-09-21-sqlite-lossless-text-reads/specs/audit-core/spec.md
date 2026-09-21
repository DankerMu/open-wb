## ADDED Requirements

### Requirement: 审计标题文本保真
core/audit emit/query SHALL round-trip complete title strings including U+0000, U+FEFF and non-ASCII characters through the same canonical lossless core/db text reader used by sessions. It SHALL preserve actor/admin filtering, ordering, cursor precision, limits, append-only behavior, event shape and existing database text encoding.
The existing detail JSON serialization/deserialization SHALL remain unchanged: embedded NUL in detail values is escaped by JSON.stringify and restored by JSON.parse. No schema or emitter write changes SHALL be introduced for this already-correct path. The correction SHALL NOT introduce character rejection or a new invalid-byte policy.

#### Scenario: Title and detail retain text while filtering
- WHEN two actors emit events whose titles and detail values contain U+0000 and mixed Unicode
- THEN each member query sees only their complete titles/details, an administrator sees both in existing order, and title/detail persistence remains TEXT without weakening immutable-event triggers

#### Scenario: Audit encoding compatibility
- WHEN audit events are emitted and queried in existing UTF-8/UTF-16le/UTF-16be databases
- THEN complete title and decoded detail values are preserved using the database's actual encoding, with no encoding or unrelated-data mutation
