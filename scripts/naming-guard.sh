#!/usr/bin/env bash
# 命名与边界守卫。规则的规范来源是 constraints.yaml（code_canonicality 与 boundaries 段），
# 本脚本内的正则是其执行镜像——改动必须双向同步。
# 用法：naming-guard.sh <file...>；无参数时检查 git 暂存区（pre-commit 模式）。
set -euo pipefail

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACR)
fi
[ "${#files[@]}" -eq 0 ] && exit 0

FORBIDDEN_SUFFIX='(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)(\.[A-Za-z0-9]+)?$'
SCRATCHPAD_DIR='(^|/)(tmp|scratch|backup|_old|deprecated|archive|wip)/'
fail=0
for f in "${files[@]}"; do
  case "$f" in
    app-reference/analysis/*) ;;                      # 分析文档可写
    app-reference/*)                                  # 其余 app-reference 全树只读
      echo "BLOCK app-reference 只读，禁止提交改动: $f"; fail=1; continue ;;
    resource/workbuddy-live-demo.html) continue ;;    # demo 原型豁免（见 constraints.yaml exemptions）
  esac
  base="${f##*/}"
  if echo "${base%.*}" | grep -qE "$FORBIDDEN_SUFFIX" || echo "$base" | grep -qE "$FORBIDDEN_SUFFIX"; then
    echo "BLOCK 禁用命名后缀（git 历史才是版本管理）: $f"; fail=1
  fi
  if echo "$f" | grep -qE "$SCRATCHPAD_DIR"; then
    echo "BLOCK 禁止提交草稿目录: $f"; fail=1
  fi
  if echo "$base" | grep -qE '\.bak(\.|$)'; then
    echo "BLOCK 禁止提交 .bak 备份文件: $f"; fail=1
  fi
done
exit "$fail"
