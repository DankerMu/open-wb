#!/usr/bin/env bash
# Official Hurl 8.0.1 x86_64 Linux; hardcoded digest before tar.
set -euo pipefail
HURL_URL=https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl-8.0.1-x86_64-unknown-linux-gnu.tar.gz
HURL_SHA256=cac7c4670d69444db120edb21fe06c97ba8c80dcc52279957c8dd18f05fb0c06
tool_dir="${RUNNER_TEMP}/hurl-8.0.1"
mkdir -p "$tool_dir"
archive="${tool_dir}/hurl-8.0.1-x86_64-unknown-linux-gnu.tar.gz"
curl --fail --location --retry 3 --retry-delay 2 --retry-max-time 60 \
  --connect-timeout 15 --max-time 120 --output "$archive" "$HURL_URL"
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$HURL_SHA256" ] || { echo "Hurl archive digest mismatch: expected ${HURL_SHA256}, got ${actual}" >&2; exit 1; }
tar -xzf "$archive" -C "$tool_dir"
bin_dir="${tool_dir}/hurl-8.0.1-x86_64-unknown-linux-gnu/bin"
test -x "${bin_dir}/hurl"
[ -n "${GITHUB_PATH:-}" ] && echo "$bin_dir" >> "$GITHUB_PATH"
export PATH="${bin_dir}:${PATH}"
command -v hurl
hurl --version
