from __future__ import annotations


def ingest_webhook(body: bytes, signature: str, timestamp: int, now: int, db_path: str):
    """Intentionally wrong starting candidate for the VDD conformance evaluation."""
    return 202, "accepted"
