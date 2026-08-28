import random
import time

from cache import lookup

random.seed(7)
records = [{"id": index, "value": index * 3} for index in range(8000)]
requested = [random.randrange(8000) for _ in range(4000)]
started = time.perf_counter()
result = lookup(records, requested)
elapsed = time.perf_counter() - started
assert [row["id"] for row in result] == requested
print(f"score={elapsed:.6f}")
