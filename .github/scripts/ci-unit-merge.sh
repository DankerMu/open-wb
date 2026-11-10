#!/usr/bin/env bash
# 合并一个 workspace 的 vitest 分片报告，并在合并后的覆盖率上执行门禁（change ci-unit-test-sharding，#1959）。
# 用法（在仓库根）：bash .github/scripts/ci-unit-merge.sh <server|web>
# 先确认 <ws>/.vitest-reports/ 里恰为同一 N 的 blob-1-N.json … blob-N-N.json，无缺无多：
# vitest --merge-reports 不检查分片是否齐全，少一片时其余分片的覆盖率仍可能越过 80% 阈值，门禁就会假绿。
# 阈值只在合并这一步生效（npm run test:merge → vitest --merge-reports --coverage，阈值取 vitest.shared.mjs）。
set -euo pipefail

ws="${1:-}"
case "$ws" in
  server | web) ;;
  *)
    echo "用法：ci-unit-merge.sh <server|web>" >&2
    exit 2
    ;;
esac

dir="$ws/.vitest-reports"
[ -d "$dir" ] || {
  echo "错误：缺少分片报告目录 $dir" >&2
  exit 1
}

total=""
count=0
for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
  [ -e "$path" ] || continue
  name="${path##*/}"
  if [ ! -f "$path" ] || [[ ! "$name" =~ ^blob-([1-9][0-9]*)-([1-9][0-9]*)\.json$ ]]; then
    echo "错误：$dir 里有不是分片报告的条目：$name" >&2
    exit 1
  fi
  index="${BASH_REMATCH[1]}"
  of="${BASH_REMATCH[2]}"
  [ -n "$total" ] || total="$of"
  if [ "$of" != "$total" ] || [ "$index" -gt "$of" ]; then
    echo "错误：分片编号不一致：$name（应为 blob-<1..$total>-$total.json）" >&2
    exit 1
  fi
  count=$((count + 1))
done

[ -n "$total" ] || {
  echo "错误：$dir 里没有分片报告" >&2
  exit 1
}
# 文件名各不相同、序号都在 1..N 内且同一个 N，于是个数等于 N 就是 1..N 一个不缺。
[ "$count" -eq "$total" ] || {
  echo "错误：$ws 只有 $count/$total 个分片报告" >&2
  exit 1
}

echo "合并 $ws 的 $total 个分片报告"
npm run test:merge --workspace "$ws"
