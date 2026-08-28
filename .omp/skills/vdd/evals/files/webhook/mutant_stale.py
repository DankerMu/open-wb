def ingest_webhook(body, signature, timestamp, now, db_path):
    if abs(now - timestamp) > 300:
        return 202, "accepted"
    return 503, "persistence_error"
