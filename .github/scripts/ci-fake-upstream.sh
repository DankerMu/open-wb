#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_UPSTREAM_PORT:?}"
exec node server/test/support/fake-upstream.mjs
