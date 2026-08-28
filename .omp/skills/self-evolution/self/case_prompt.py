#!/usr/bin/env python3
"""Print one GT case's prompt. Exits non-zero on an unknown id."""
import json, os, sys

SELF_DIR = os.path.dirname(os.path.abspath(__file__))
gt = json.load(open(os.path.join(SELF_DIR, "gt.json")))
case = next((c for c in gt["cases"] if c["id"] == sys.argv[1]), None)
if case is None:
    sys.exit(f"unknown case: {sys.argv[1]}")
print(case["prompt"])
