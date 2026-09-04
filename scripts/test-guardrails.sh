#!/usr/bin/env bash
# 守卫自证：每条自研 guard 必须能拒绝注入的违例，拒绝失败 = 幽灵执行。
set -uo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0
expect_reject() { # $1 描述, 其余为命令
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL(应拒绝却放行) $desc"; fail=$((fail+1))
  else
    echo "PASS $desc"; pass=$((pass+1))
  fi
}
expect_accept() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS $desc"; pass=$((pass+1))
  else
    echo "FAIL(应放行却拒绝) $desc"; fail=$((fail+1))
  fi
}
expect_reject "命名守卫拒绝 _v2 后缀"        bash scripts/naming-guard.sh "server/src/foo_v2.ts"
expect_reject "命名守卫拒绝草稿目录"          bash scripts/naming-guard.sh "server/tmp/x.ts"
expect_reject "命名守卫拒绝 .bak"            bash scripts/naming-guard.sh "web/src/a.bak"
expect_reject "命名守卫拒绝写 app-reference"  bash scripts/naming-guard.sh "app-reference/app_asar/main.js"
expect_accept "命名守卫放行 analysis 文档"    bash scripts/naming-guard.sh "app-reference/analysis/00-overview.md"
expect_accept "命名守卫放行正常文件"          bash scripts/naming-guard.sh "server/src/service-info.ts"
seq 801 | sed 's/^/# line /' > "$tmp/big.py"
expect_reject "行数守卫拒绝 801 行文件"       bash scripts/size-guard.sh "$tmp/big.py"
expect_accept "行数守卫放行现有源码"          bash scripts/size-guard.sh
expect_reject "commit-msg 拒绝非规范信息"     bash .githooks/commit-msg <(echo "随手改一下")
expect_accept "commit-msg 放行规范信息"       bash .githooks/commit-msg <(echo "feat(server): 新增健康探针")
echo "guardrail self-test: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ] && bash scripts/test-ci-harness.sh
