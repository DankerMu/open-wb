#!/usr/bin/env bash
# ui-walk 的 Chromium 与系统依赖安装（change ci-playwright-cache，#1981）。
# 用法（在仓库根）：bash .github/scripts/ci-playwright-install.sh
# `npx playwright install --with-deps chromium` 每次都要从 Ubuntu 软件源 apt 下载字体包；软件源一出故障
# 整个 job 就失败（2026-11-11：`Temporary failure resolving 'azure.archive.ubuntu.com'`）。
# 这里让 apt 把 .deb 下载到 Playwright 缓存目录下的 apt-archives/，与浏览器一起由前一步 actions/cache 保存。
# 缓存命中时 apt-get install 直接用本地 .deb，不连软件源；apt-get update 连不上时只报 W:、退出 0，
# 沿用 runner 镜像自带的索引。Playwright 只清理名字像浏览器目录的子目录，apt-archives/ 不受影响。
set -euo pipefail

debs="$HOME/.cache/ms-playwright/apt-archives"
# 只为 scripts/test-ci-harness.sh 的桩测试可覆盖；CI 不设。
conf="${PLAYWRIGHT_APT_CONF:-/etc/apt/apt.conf.d/90workbuddy-playwright-debs}"

mkdir -p "$debs/partial"
printf 'Dir::Cache::Archives "%s/";\nAPT::Keep-Downloaded-Packages "true";\n' "$debs" | sudo tee "$conf" >/dev/null

status=0
npx playwright install --with-deps chromium || status=$?

# 不论成败都撤掉 apt 配置；apt 以 root 写入的 lock 与 partial/ 删掉，其余改回 runner 用户，
# 否则 actions/cache 的 post 步骤读不到 root 0640 的 lock，打包失败只报警告、缓存静默不存。
sudo rm -f "$conf"
sudo rm -rf "$debs/lock" "$debs/partial"
sudo chown -R "$(id -u):$(id -g)" "$debs"
echo "apt-archives：$(find "$debs" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ') 个 .deb"
exit "$status"
