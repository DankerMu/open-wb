#!/usr/bin/env bash
# 命名与边界守卫。规则的规范来源是 constraints.yaml（code_canonicality 与 boundaries 段），
# 本脚本内的正则是其执行镜像——改动必须双向同步。
# 用法：naming-guard.sh <file...>；无参数时检查 git 暂存区（pre-commit 模式）。
set -euo pipefail

files=()
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(git diff --cached --name-only -z --diff-filter=ACR)
fi
[ "${#files[@]}" -eq 0 ] && exit 0

FORBIDDEN_SUFFIX='(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)(\.[A-Za-z0-9]+)?$'
FORBIDDEN_SUFFIX_COMPONENT='(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated)'
FORBIDDEN_SUFFIX_IN_PATH="(^|/)[^/]*${FORBIDDEN_SUFFIX_COMPONENT}(\.[^/]*)?(/|$)"
BAK_IN_PATH='(^|/)[^/]*\.bak(\.|/|$)'
SCRATCHPAD_DIR='(^|/)(tmp|scratch|backup|_old|deprecated|archive|wip)/'

# constraints.yaml exemptions: OpenSpec 只允许归档 change 下的内容绕过 archive/ 目录规则。
is_canonical_openspec_archive() {
  case "$1" in
    openspec/changes/archive/*/*) ;;
    *) return 1 ;;
  esac
  case "/$1/" in
    *//*|*/./*|*/../*) return 1 ;;
  esac
}

fail=0
for f in "${files[@]}"; do
  case "$f" in
    app-reference/analysis/*) ;;                      # 分析文档可写
    app-reference/*)                                  # 其余 app-reference 全树只读
      echo "BLOCK app-reference 只读，禁止提交改动: $f"; fail=1; continue ;;
    resource/workbuddy-live-demo.html) continue ;;    # demo 原型豁免（见 constraints.yaml exemptions）
  esac
  scratchpad_path="$f"
  archive_tree=""
  if is_canonical_openspec_archive "$f"; then
    archive_tree="${f#openspec/changes/archive/}"
    scratchpad_path="$archive_tree"
  fi
  base="${f##*/}"
  if echo "${base%.*}" | grep -qE "$FORBIDDEN_SUFFIX" || echo "$base" | grep -qE "$FORBIDDEN_SUFFIX"; then
    echo "BLOCK 禁用命名后缀（git 历史才是版本管理）: $f"; fail=1
  fi
  if [ -n "$archive_tree" ] &&
    ! { echo "${archive_tree##*/}" | grep -qE "$FORBIDDEN_SUFFIX"; } &&
    echo "$archive_tree" | grep -qE "$FORBIDDEN_SUFFIX_IN_PATH"; then
    echo "BLOCK 禁用命名后缀（git 历史才是版本管理）: $f"; fail=1
  fi
  if [ "$f" = "openspec/changes/archive" ] || echo "$scratchpad_path" | grep -qE "$SCRATCHPAD_DIR"; then
    echo "BLOCK 禁止提交草稿目录: $f"; fail=1
  fi
  if echo "$base" | grep -qE '\.bak(\.|$)'; then
    echo "BLOCK 禁止提交 .bak 备份文件: $f"; fail=1
  elif [ -n "$archive_tree" ] && echo "$archive_tree" | grep -qE "$BAK_IN_PATH"; then
    echo "BLOCK 禁止提交 .bak 备份文件: $f"; fail=1
  fi
done
exit "$fail"
