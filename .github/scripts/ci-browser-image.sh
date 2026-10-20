#!/usr/bin/env bash
# CI job browser-image（browser-runtime「参考部署镜像」场景「镜像可构建且身份正确」与「CI browser-image job」
# 场景「真实浏览器打开工作空间页面并截图」；change omp-browser-integration design D8）。
# 前提：同一 job 里已 `docker build -t workbuddy-app:ci -f deploy/app/Dockerfile .`；本脚本不推送、不发布。
# (1) 构建期哨兵：随机值进构建 shell 环境与上下文根的点开头环境文件，以同一 Dockerfile 另建哨兵 tag
#     （全程命中缓存），在镜像 Env、history、导出的根文件系统里搜；再在镜像里查身份、字体、无源码与开发依赖。
# (2) 三个挂载目录属容器内 workbuddy（10001:10001），浏览器包装脚本只读挂到不在 PATH 上的 /opt/ci。
# (3) 与 deploy/app/compose.yml 逐项相同的安全标志起容器（scripts/test-ci-harness.sh 把这一行钉成字面）；
#     --network host 访问驱动在回环上的假上游，因此覆盖 HOST=127.0.0.1 与 job 专用端口——这是对 compose
#     注释「env_file 不得覆盖 HOST/PORT」的有意偏离（那条针对桥接网络的端口发布）。
# (4) 驱动 ci-browser-e2e.mjs 两回合（打开工作空间页面、截图），再查包装脚本标记与 puppeteer 目录。
# 清理先 docker rm -f（broker 与 Chromium 随容器结束），再 sudo rm -rf（挂载里的文件属 10001/10002）。
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
sentinel_image=workbuddy-app:sentinel
port=18020; preview_port=18021; forward_port=19020
state_in=/srv/workbuddy/omp-state
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/browser-image.XXXXXX")"
sandbox="$work/sandbox"; state="$work/omp-state"; private="$work/private"; wrapper="$work/browser-wrapper.sh"
cid=""; probe=""; env_file=""
cleanup() {
  local rc=$?
  [ -z "$env_file" ] || rm -f "$env_file"
  [ -z "$probe" ] || docker rm -f "$probe" >/dev/null 2>&1 || true
  if [ -n "$cid" ]; then
    [ "$rc" -eq 0 ] || docker logs "$cid" >&2 2>&1 || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  docker image rm "$sentinel_image" >/dev/null 2>&1 || true
  sudo rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
die() { echo "browser-image: FAIL $*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || die "must not run as root"
in_box() { docker exec "$cid" "$@"; }

# (1a) 构建期哨兵。点开头的环境文件被 Dockerfile.dockerignore 排除；已存在则拒绝，免得覆盖真实配置。
[ ! -e "$root/.env" ] || die "$root/.env already exists; refusing to overwrite it"
sentinel="wbsentinel-$(openssl rand -hex 12)"
env_file="$root/.env"
printf 'MODEL_UPSTREAM_API_KEY=%s\n' "$sentinel" > "$env_file"
(export MODEL_UPSTREAM_API_KEY="$sentinel"; docker build -q -t "$sentinel_image" -f "$root/deploy/app/Dockerfile" "$root" >/dev/null) || die "the sentinel build failed"
rm -f "$env_file"; env_file=""
# 先取全文再搜：pipefail 下 `grep -q` 提前退出会让上游吃 SIGPIPE，管道失败即把命中当成未命中。
config="$(docker image inspect "$sentinel_image")"; hist="$(docker history --no-trunc "$sentinel_image")"
if grep -qF -- "$sentinel" <<<"$config"; then die "the sentinel is in the image config"; fi
if grep -qF -- "$sentinel" <<<"$hist"; then die "the sentinel is in the image history"; fi
probe="$(docker create "$sentinel_image")"
hits="$(docker export "$probe" | LC_ALL=C grep -a -o -F -e "$sentinel" -e app/entrypoint.sh || true)"
docker rm "$probe" >/dev/null; probe=""
if grep -qxF -- "$sentinel" <<<"$hits"; then die "the sentinel is in the exported root fs"; fi
grep -qxF app/entrypoint.sh <<<"$hits" || die "the exported root fs lacks the control app/entrypoint.sh (the search is void)"
echo "browser-image: build-time sentinel absent from config, history and root fs (control found)"

# (1b) 镜像内的身份、浏览器、字体与产物（不需要运行中的服务）。
ids="$(docker run --rm --network none --entrypoint sh workbuddy-app:ci -c 'echo "$(id -u workbuddy) $(id -g workbuddy) $(id -u omp) $(id -g omp) $(id -gn omp)"')"
[ "$ids" = "10001 10001 10002 10001 workbuddy" ] || die "identities are '$ids', want '10001 10001 10002 10001 workbuddy'"
docker run --rm --network none --entrypoint sh workbuddy-app:ci -c '
  test -x /usr/bin/chromium || { echo "/usr/bin/chromium is not executable"; exit 1; }
  ls /usr/share/fonts/opentype/noto/ | grep -q CJK || { echo "no Noto CJK font under /usr/share/fonts/opentype/noto/"; exit 1; }
  test -d /app/node_modules/fastify || { echo "control: /app/node_modules/fastify is missing"; exit 1; }
  for p in /app/server/src /app/node_modules/typescript /app/node_modules/vite; do
    ! test -e "$p" || { echo "$p is in the runtime image"; exit 1; }
  done' >&2 || die "image content check failed"
echo "browser-image: identities $ids; chromium, Noto CJK present; no server sources or dev dependencies"

# (2) 挂载目录与浏览器包装脚本（执行时在 /tmp 留标记，再交给镜像里的 chromium）。
sudo install -d -o 10001 -g 10001 -m 0700 "$private"
sudo install -d -o 10001 -g 10001 -m 0750 "$sandbox" "$state"
printf '%s\n' '#!/bin/sh' ': > /tmp/browser-wrapper.ran' 'exec /usr/bin/chromium "$@"' > "$wrapper"
chmod 0755 "$wrapper"

# (3) 起服务；MODEL_CATALOG / MODEL_VISION 不设，上游密钥显式给假值（哨兵不得漏进来）。
# omp v18.0.10 ai/src/providers/vision-guard.ts（isTextOnlyDeepSeek）对任何 DeepSeek id 都剥掉图片部分、不看 models.yml 的 input，所以看图链路以中性的 MODEL_ID 证明。
cid="$(docker run -d --network host --read-only --tmpfs /tmp --shm-size 1g --init --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL -v "$sandbox:/srv/workbuddy/sandbox" -v "$state:/srv/workbuddy/omp-state" -v "$private:/srv/workbuddy/private" -v "$wrapper:/opt/ci/browser-wrapper.sh:ro" -e HOST=127.0.0.1 -e PORT="$port" -e PREVIEW_PORT="$preview_port" -e BROWSER_BIN=/opt/ci/browser-wrapper.sh -e MODEL_UPSTREAM_BASE_URL="http://127.0.0.1:$forward_port/v1" -e MODEL_UPSTREAM_API_KEY=fake -e MODEL_ID=ci-vision-model workbuddy-app:ci)"
start=$SECONDS
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/healthz" || true)" = 200 ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || die "the container exited before healthz"
  [ $((SECONDS - start)) -lt 60 ] || die "healthz is not 200 within 60 s"
  sleep 0.5
done
echo "browser-image: healthz 200 after $((SECONDS - start)) s"
docker exec -u 0 "$cid" visudo -c >/dev/null || die "visudo -c failed"
rules="$(docker exec -u 0 "$cid" cat /etc/sudoers.d/workbuddy-omp)"
want="$(printf '%s\n' 'workbuddy ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- /opt/workbuddy/omp *' 'Defaults>omp umask=0007')"
[ "$rules" = "$want" ] || die "/etc/sudoers.d/workbuddy-omp is not exactly the two rules"
umask_line="$(in_box sh -c 'for p in /proc/[0-9]*; do case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in "node /app/server/dist/server.js"*) grep "^Umask:" "$p/status";; esac; done')"
[ "$umask_line" = "$(printf 'Umask:\t0007')" ] || die "the service umask is '$umask_line', want 0007"
echo "browser-image: visudo -c ok, sudoers exactly two rules, service Umask 0007"

# (4) 两回合驱动，然后在容器里查 BROWSER_BIN 抵达 omp、没有下载浏览器（以镜像缺省用户 workbuddy 读）。
timeout 600 node "$root/.github/scripts/ci-browser-e2e.mjs" "http://127.0.0.1:$port" "$forward_port" || die "the browser e2e driver failed"
in_box test -e /tmp/browser-wrapper.ran || die "no wrapper marker: BROWSER_BIN did not reach omp"
in_box test -e "$state_in/xdg/cache/omp/puppeteer/package.json" || die "control: puppeteer/package.json is missing"
! in_box test -e "$state_in/xdg/cache/omp/puppeteer/chrome" || die "omp downloaded a browser (puppeteer/chrome exists)"
logs="$state_in/xdg/state/omp/logs"
in_box sh -c 'if [ -d "$1" ]; then ! grep -rqF "Downloading Chromium for puppeteer" "$1"; fi' sh "$logs" || die "the omp log mentions a Chromium download"
echo "browser-image: wrapper marker present; puppeteer/package.json present, puppeteer/chrome absent; no download in the omp log"
echo "browser-image: omp log dir: $(in_box sh -c 'if [ -d "$1" ]; then echo "$(find "$1" -name "*.log" | wc -l) log file(s), $(find "$1" -name "*.log" -size +0 | wc -l) non-empty"; else echo absent; fi' sh "$logs")"
echo "browser-image: PASS"
