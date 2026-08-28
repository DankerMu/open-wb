from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


from candidate_proxy import ingest_webhook

SECRET = b"test-secret"
NOW = 1_800_000_000


def payload(event_id: str = "evt-1") -> bytes:
    return json.dumps({"id": event_id, "payload": {"value": 7}}, separators=(",", ":")).encode()


def signature(body: bytes, timestamp: int = NOW) -> str:
    message = str(timestamp).encode() + b"." + body
    return "sha256=" + hmac.new(SECRET, message, hashlib.sha256).hexdigest()


class WebhookTests(unittest.TestCase):
    def test_accepts_and_persists_exact_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = payload()
            self.assertEqual((202, "accepted"), ingest_webhook(body, signature(body), NOW, NOW, db_path))
            with sqlite3.connect(db_path) as connection:
                row = connection.execute(
                    "SELECT event_id, body FROM events WHERE event_id = ?", ("evt-1",)
                ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual("evt-1", row[0])
            stored = row[1].encode() if isinstance(row[1], str) else row[1]
            self.assertEqual(body, stored)

    def test_invalid_signature_is_rejected_without_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = payload()
            self.assertEqual(
                (401, "invalid_signature"),
                ingest_webhook(body, "sha256=invalid", NOW, NOW, db_path),
            )
            self.assertFalse(Path(db_path).exists())

    def test_stale_timestamp_is_rejected_without_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = payload()
            old = NOW - 301
            self.assertEqual((401, "stale"), ingest_webhook(body, signature(body, old), old, NOW, db_path))
            self.assertFalse(Path(db_path).exists())

    def test_invalid_payload_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = b"{not-json"
            self.assertEqual(
                (400, "invalid_payload"),
                ingest_webhook(body, signature(body), NOW, NOW, db_path),
            )

    def test_retries_are_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = payload()
            signed = signature(body)
            self.assertEqual((202, "accepted"), ingest_webhook(body, signed, NOW, NOW, db_path))
            self.assertEqual((200, "duplicate"), ingest_webhook(body, signed, NOW, NOW, db_path))
            with sqlite3.connect(db_path) as connection:
                count = connection.execute(
                    "SELECT COUNT(*) FROM events WHERE event_id = ?", ("evt-1",)
                ).fetchone()[0]
            self.assertEqual(1, count)

    def test_concurrent_retries_create_one_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "events.sqlite")
            body = payload("evt-concurrent")
            signed = signature(body)
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(
                    pool.map(
                        lambda _: ingest_webhook(body, signed, NOW, NOW, db_path),
                        range(8),
                    )
                )
            self.assertEqual(1, results.count((202, "accepted")), results)
            self.assertEqual(7, results.count((200, "duplicate")), results)
            with sqlite3.connect(db_path) as connection:
                count = connection.execute(
                    "SELECT COUNT(*) FROM events WHERE event_id = ?", ("evt-concurrent",)
                ).fetchone()[0]
            self.assertEqual(1, count)

    def test_persistence_failure_is_not_reported_as_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = payload()
            self.assertEqual(
                (503, "persistence_error"),
                ingest_webhook(body, signature(body), NOW, NOW, tmp),
            )


if __name__ == "__main__":
    unittest.main()
