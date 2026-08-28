def lookup(records, requested_ids):
    result = []
    for requested_id in requested_ids:
        for record in records:
            if record["id"] == requested_id:
                result.append(record)
                break
    return result
