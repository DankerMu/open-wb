Implement candidate.py using only the Python standard library.

Public boundary:
    ingest_webhook(body: bytes, signature: str, timestamp: int, now: int, db_path: str)
        -> tuple[int, str]

Contract:
- The shared HMAC secret for this fixture is the bytes value b"test-secret".
- signature is "sha256=" followed by HMAC-SHA256 over str(timestamp) + "." + body.
- Reject a bad signature as (401, "invalid_signature") without persistence.
- Reject timestamps more than 300 seconds from now as (401, "stale") without persistence.
- Reject malformed JSON or a missing/non-string event id as (400, "invalid_payload").
- Atomically persist the first valid delivery in a real SQLite database and return (202, "accepted").
- Retries, including concurrent retries, for an already persisted event id return (200, "duplicate") and never create a second row.
- A persistence error returns (503, "persistence_error") rather than reporting acceptance.
- The events table must expose event_id as a unique key and retain the exact request body.
