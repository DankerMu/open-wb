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
expect_accept "命名守卫放行 OpenSpec 归档"    bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/design.md"
expect_reject "命名守卫拒绝普通 archive"      bash scripts/naming-guard.sh "docs/archive/x.md"
expect_reject "命名守卫拒绝 OpenSpec archive 根" bash scripts/naming-guard.sh "openspec/changes/archive"
expect_reject "命名守卫拒绝 OpenSpec archive change 根" bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton"
expect_reject "命名守卫拒绝畸形 OpenSpec 归档路径" bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/a//b.md"
expect_reject "命名守卫拒绝归档内中间 _backup" bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/specs_backup/x.md"
expect_reject "命名守卫拒绝归档内中间 .bak" bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/specs/notes.bak/x.md"
expect_reject "命名守卫拒绝归档内 tmp"        bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/tmp/a.md"
expect_reject "命名守卫拒绝归档内 _old"       bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/design_old.md"
expect_reject "命名守卫拒绝归档内 .bak"       bash scripts/naming-guard.sh "openspec/changes/archive/2026-09-06-s0a-service-skeleton/design.bak"
expect_accept "命名守卫放行 analysis 文档"    bash scripts/naming-guard.sh "app-reference/analysis/00-overview.md"
expect_accept "命名守卫放行正常文件"          bash scripts/naming-guard.sh "server/src/service-info.ts"
seq 800 | sed 's/^/# line /' > "$tmp/ok.py"
seq 801 | sed 's/^/# line /' > "$tmp/over_a.py"
seq 802 | sed 's/^/# line /' > "$tmp/over_b.py"
expect_accept "行数守卫放行 800 行文件"        bash scripts/size-guard.sh "$tmp/ok.py"
out=$(bash scripts/size-guard.sh "$tmp/over_a.py" "$tmp/over_b.py" 2>&1)
rc=$?
desc="行数守卫拒绝超限文件并报告每文件 BLOCK 计数与路径"
if [ "$rc" -eq 0 ]; then
  echo "FAIL(应拒绝却放行) $desc"; fail=$((fail+1))
elif printf '%s\n' "$out" | grep -F "unbound variable" >/dev/null; then
  echo "FAIL(解释器错误) $desc"; fail=$((fail+1))
elif printf '%s\n' "$out" | grep -F "BLOCK" | grep -F "801" | grep -F "$tmp/over_a.py" >/dev/null \
  && printf '%s\n' "$out" | grep -F "BLOCK" | grep -F "802" | grep -F "$tmp/over_b.py" >/dev/null; then
  echo "PASS $desc"; pass=$((pass+1))
else
  echo "FAIL(缺少 BLOCK 计数/路径) $desc"; fail=$((fail+1))
fi
expect_accept "行数守卫放行现有源码"          bash scripts/size-guard.sh
expect_reject "commit-msg 拒绝非规范信息"     bash .githooks/commit-msg <(echo "随手改一下")
expect_accept "commit-msg 放行规范信息"       bash .githooks/commit-msg <(echo "feat(server): 新增健康探针")
root=$(pwd)
mkdir -p "$tmp/bin"
ln -s "$(command -v git)" "$tmp/bin/git"
sys_path="/usr/bin:/bin:$tmp/bin"
git_iso() { env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY "$@"; }
empty_src="$tmp/empty-src"; mkdir -p "$empty_src"
empty_stage="$tmp/empty-stage"; mkdir -p "$empty_stage"
git_iso git -C "$empty_stage" init -q
compat_accept() {
  local desc="$1"; shift
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  if printf '%s\n' "$out" | grep -E 'unbound variable|command not found' >/dev/null; then
    echo "FAIL(解释器错误) $desc"; fail=$((fail+1))
  elif [ "$rc" -eq 0 ]; then
    echo "PASS $desc"; pass=$((pass+1))
  else
    echo "FAIL(应放行却拒绝) $desc"; fail=$((fail+1))
  fi
}
compat_accept "系统 bash 空暂存命名守卫放行" git_iso env PATH="$sys_path" /bin/bash -c 'cd "$1" && /bin/bash "$2"' _ "$empty_stage" "$root/scripts/naming-guard.sh"
compat_accept "系统 bash 空源码行数守卫放行" env PATH="/usr/bin:/bin" /bin/bash -c 'cd "$1" && /bin/bash "$2"' _ "$empty_src" "$root/scripts/size-guard.sh"
setup_hook_repo() {
  local repo="$1"
  mkdir -p "$repo/server/src"
  ln -s "$root/scripts" "$repo/scripts"
  git_iso git -C "$repo" init -q
  git_iso git -C "$repo" config user.name "guard-test"
  git_iso git -C "$repo" config user.email "guard-test@example.test"
  git_iso git -C "$repo" config commit.gpgsign false
  git_iso git -C "$repo" config core.hooksPath "$root/.githooks"
}
ok_repo="$tmp/ok-repo"; setup_hook_repo "$ok_repo"
compat_accept "系统 bash 空暂存 pre-commit 放行" git_iso env PATH="$sys_path" /bin/bash -c 'cd "$1" && /bin/bash "$2"' _ "$ok_repo" "$root/.githooks/pre-commit"
printf '%s\n' "// ok" > "$ok_repo/server/src/a.ts"
git_iso git -C "$ok_repo" add server/src/a.ts
ok_out=$(git_iso env PATH="$sys_path" GIT_TERMINAL_PROMPT=0 git -C "$ok_repo" commit --no-gpg-sign -m "feat: add a" 2>&1)
ok_rc=$?
ok_desc="系统 PATH 合规文件真实提交成功"
if printf '%s\n' "$ok_out" | grep -E 'unbound variable|command not found' >/dev/null; then
  echo "FAIL(解释器错误) $ok_desc"; fail=$((fail+1))
elif [ "$ok_rc" -eq 0 ] && git_iso git -C "$ok_repo" rev-parse --verify -q HEAD >/dev/null; then
  echo "PASS $ok_desc"; pass=$((pass+1))
else
  echo "FAIL(应放行却拒绝) $ok_desc"; fail=$((fail+1))
fi
bad_repo="$tmp/bad-repo"; setup_hook_repo "$bad_repo"
printf '%s\n' "// bad" > "$bad_repo/server/src/foo_v2.ts"
git_iso git -C "$bad_repo" add "server/src/foo_v2.ts"
bad_out=$(git_iso env PATH="$sys_path" GIT_TERMINAL_PROMPT=0 git -C "$bad_repo" commit --no-gpg-sign -m "feat: add v2" 2>&1)
bad_rc=$?
bad_desc="系统 PATH 禁用后缀真实提交拒绝并报告 BLOCK/路径"
if printf '%s\n' "$bad_out" | grep -E 'unbound variable|command not found' >/dev/null; then
  echo "FAIL(解释器错误) $bad_desc"; fail=$((fail+1))
elif [ "$bad_rc" -eq 0 ]; then
  echo "FAIL(应拒绝却放行) $bad_desc"; fail=$((fail+1))
elif printf '%s\n' "$bad_out" | grep -F "BLOCK" | grep -F "禁用命名后缀" | grep -F "server/src/foo_v2.ts" >/dev/null \
  && ! git_iso git -C "$bad_repo" rev-parse --verify -q HEAD >/dev/null; then
  echo "PASS $bad_desc"; pass=$((pass+1))
else
  echo "FAIL(缺少 BLOCK/路径或已提交) $bad_desc"; fail=$((fail+1))
fi
echo "guardrail self-test: $pass PASS / $fail FAIL"
[ "$fail" -eq 0 ] && bash scripts/test-ci-harness.sh
