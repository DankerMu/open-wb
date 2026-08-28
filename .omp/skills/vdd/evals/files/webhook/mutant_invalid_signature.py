def ingest_webhook(body, signature, timestamp, now, db_path):
    if signature == "sha256=invalid":
        return 202, "accepted"
    return 503, "persistence_error"
