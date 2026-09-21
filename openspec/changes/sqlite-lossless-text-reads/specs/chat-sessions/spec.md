## ADDED Requirements

### Requirement: 会话文本无损读取与标题复用
SessionStore SHALL preserve complete text values, including embedded U+0000, leading U+FEFF, non-ASCII and astral characters, across list/getMessages titles, user and assistant content, step name/detail, and trusted runtimeState ompSessionFile. Public outputs SHALL remain strings or the existing nullable values. Empty string and SQL NULL SHALL remain distinct. Appended content and finish/close flushes SHALL retain the complete concatenated value.
Admission SHALL reuse an existing title without truncating its suffix, retain the complete previousTitle for rollbackPrompt, and keep the persisted title storage class TEXT. The first-title Unicode-prefix rule SHALL remain unchanged. The fix SHALL NOT claim recovery of suffixes already overwritten by older admissions.
Lossless reading SHALL respect the actual database text encoding. Existing UTF-8, UTF-16le and UTF-16be databases SHALL remain readable without changing encoding, schema, unrelated data or migration receipts. Per-connection encoding selection SHALL NOT leak between databases. Leading U+FEFF SHALL be preserved; no new fatal invalid-byte policy, character stripping or input rejection SHALL be introduced. Failed encoding/SQL reads SHALL propagate rather than silently selecting a guessed encoding.
Owner isolation, order, status transitions, epoch/resume independence, transaction boundaries and compensation/flush errors SHALL remain as already specified. The shared text-read implementation SHALL have one canonical owner in core/db and no per-consumer alternate decoding implementation.

#### Scenario: All free-text read surfaces
- WHEN a real store accepts text containing U+0000, persists assistant deltas and steps, and records trusted resume metadata containing that character
- THEN getMessages/list/runtimeState return complete values for content/title/name/detail/resume, including text after the NUL, without leaking internal fields into public views

#### Scenario: Title reuse and compensation retain physical bytes
- WHEN a completed session title is a + U+0000 + b, a second prompt is admitted and then rolled back before progress
- THEN title reads remain exact, its physical hex remains610062 in UTF-8 before/after admission and rollback, and typeof(title) remains text

#### Scenario: Null empty and BOM compatibility
- WHEN idle/null metadata and stored empty strings, leading U+FEFF and mixed Unicode values are read
- THEN null remains null, empty remains empty and every valid text code point is preserved without BOM stripping or normalization

#### Scenario: Database encoding and reopen
- WHEN UTF-8/UTF-16le/UTF-16be file databases with prior unrelated data are opened, used and reopened, including interleaved reads across connections
- THEN ordinary and NUL-containing values round-trip, encoding/unrelated data/receipts remain unchanged, and no connection uses another database's encoding
- WHEN a caller closes a DatabaseSync handle and later reopens that same JavaScript object against a valid replacement database using a different supported encoding
- THEN subsequent text reads use the current native connection encoding rather than a stale object-identity cache

#### Scenario: Frozen REST consumer replay
- WHEN the paused #99 REST consumer is composed only in a disposable compiled harness with the corrected store and receives a valid 32768-NUL prompt
- THEN202 identifies the admitted pair, the supervisor receives the original text and subsequent store/history reads preserve it; this SHALL NOT register or ship REST in the #198 production change
