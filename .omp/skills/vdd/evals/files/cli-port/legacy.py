#!/usr/bin/env python3
import json
import sys


def summarize(records):
    valid = [record for record in records if record.get("status") != "void"]
    return {
        "count": len(valid),
        "total_cents": sum(record["amount_cents"] for record in valid),
        "ids": sorted(record["id"] for record in valid),
    }


def main():
    if len(sys.argv) != 2:
        print("usage: legacy.py <records.json>", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1], encoding="utf-8") as handle:
            records = json.load(handle)
        print(json.dumps(summarize(records), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
