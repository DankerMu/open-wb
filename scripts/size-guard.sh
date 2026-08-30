#!/usr/bin/env bash
# 文件行数守卫：产品代码单文件 ≤ MAX 行（constraints.yaml size_limits.max_file_lines）。
# 用法：size-guard.sh [file...]；无参数时扫描产品目录全部源码。
set -euo pipefail
MAX=800
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(find server/src server/test web/src web/test kbservice/src kbservice/tests \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.py' \) 2>/dev/null || true)
fi
fail=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in *.ts|*.tsx|*.py) ;; *) continue ;; esac
  lines=$(wc -l < "$f")
  if [ "$lines" -gt "$MAX" ]; then
    echo "BLOCK 文件超过 ${MAX} 行（$lines）：拆分它，而不是调阈值: $f"; fail=1
  fi
done
exit "$fail"
