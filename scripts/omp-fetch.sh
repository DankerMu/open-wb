#!/usr/bin/env bash
# Pin official can1357/oh-my-pi v18.0.10 into var/omp/omp after SHA256 verify.
set -euo pipefail

OMP_VERSION="18.0.10"
OMP_RELEASE_URL="https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}"
DEST="var/omp/omp"
SHA256_DARWIN_ARM64="bf026b63aa3b0acb0afbed8083f76bcec134bf56ffdbbe80fb73a7e079fe278a"
SHA256_LINUX_X64="b13e6b2a74a5c71e57b9f717e0fc4834bcfe0609f30dc1782a91976b230361a0"

platform="$(uname -sm)"
case "$platform" in
  "Darwin arm64")
    asset="omp-darwin-arm64"
    expected="$SHA256_DARWIN_ARM64"
    ;;
  "Linux x86_64")
    asset="omp-linux-x64"
    expected="$SHA256_LINUX_X64"
    ;;
  *)
    echo "unsupported platform: ${platform}" >&2
    echo "supported platform matrix:" >&2
    echo "  Darwin arm64 -> omp-darwin-arm64" >&2
    echo "  Linux x86_64 -> omp-linux-x64" >&2
    exit 1
    ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

report_mismatch() {
  echo "digest mismatch: expected ${expected}, actual ${1}" >&2
}

if [ -e "$DEST" ]; then
  if [ ! -f "$DEST" ]; then
    echo "existing path is not a regular file: ${DEST}" >&2
    exit 1
  fi
  actual="$(sha256_of "$DEST")"
  if [ "$actual" = "$expected" ]; then
    echo "omp-fetch: skip download; ${DEST} already verified for v${OMP_VERSION} ${asset}"
    exit 0
  fi
  echo "existing ${DEST} failed verification" >&2
  report_mismatch "$actual"
  rm -f "$DEST"
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
tmp="$(mktemp "$(dirname "$DEST")/.omp-fetch.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT INT HUP TERM

curl --fail --location --retry 3 --retry-delay 2 --retry-max-time 60 \
  --connect-timeout 15 --max-time 120 --output "$tmp" \
  "${OMP_RELEASE_URL}/${asset}"

actual="$(sha256_of "$tmp")"
if [ "$actual" != "$expected" ]; then
  report_mismatch "$actual"
  exit 1
fi

chmod 755 "$tmp"
mv "$tmp" "$DEST"
trap - EXIT INT HUP TERM
echo "omp-fetch: installed ${DEST} from ${asset} v${OMP_VERSION}"
