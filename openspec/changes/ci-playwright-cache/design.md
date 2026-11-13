# Design: ci-playwright-cache

## Context

- ui-walk 的 `npx playwright install --with-deps chromium`（`.github/workflows/ci.yml`，#18 引入）每次运行先 `apt-get update`，再 `apt-get install` Playwright 列出的依赖。ubuntu-latest 镜像已带全部共享库，实际只新装 9 个字体包（约 21 MB）。
- 2026-11-11 的故障日志（job 130574184137 等）：`apt-get update` 对每个索引报 `W: Failed to fetch … Temporary failure resolving 'azure.archive.ubuntu.com'` 与 `W: Some index files failed to download. They have been ignored, or old ones used instead.`，之后 `apt-get install` 照常开始，在下载 `.deb` 时失败（`E: Failed to fetch …`），Playwright 报 `Failed to install browsers`。可见 update 失败不阻断 install（Playwright 用 `&&` 串联两条命令），阻断的是 `.deb` 下载。
- Playwright 1.62.1 安装后只清理名字以已知浏览器目录前缀开头的子目录（`playwright-core/lib/coreBundle.js` `isBrowserDirectory`），缓存目录里其它子目录不受影响。
- 仓库的 CI 契约 oracle 用一个只认单行值的步骤解析器（`check_wf`）：`with` 里没有多行 `path: |`，`run: |` 只在聚合 job 里出现。

## Decisions

- **D1 一步缓存，放在安装前。** `actions/cache@v6`，`path: ~/.cache/ms-playwright`（Playwright 默认浏览器目录，`make ui-walk` 无需新环境变量），`key: playwright-<os>-<arch>-<hashFiles('node_modules/playwright-core/package.json')>`，`restore-keys: playwright-<os>-<arch>-`。key 用已安装的 playwright-core 的 `package.json`，只随 Playwright 版本变；用 `package-lock.json` 会让每次依赖变动都另存约 200 MB。缓存步骤必须在 `npm ci` 之后，`hashFiles` 才有文件可哈希。
- **D2 `.deb` 放进同一个缓存目录。** 脚本在安装期间写 `/etc/apt/apt.conf.d/90workbuddy-playwright-debs`：`Dir::Cache::Archives "<HOME>/.cache/ms-playwright/apt-archives/"` 与 `APT::Keep-Downloaded-Packages "true"`。缓存命中时 apt 在这个目录里找到版本与哈希都对得上的 `.deb`，不再下载。安装后删除配置；apt 以 root 写入的 `lock`（0640）与 `partial/` 删掉，其余 `chown` 回 runner 用户，否则 `actions/cache` 的 post 步骤读不到 `lock`，打包失败只报警告，缓存会静默不存。
- **D3 安装放进脚本，桩测试。** 解析器不接受多行 `run`，所以安装写成 `.github/scripts/ci-playwright-install.sh`，在 `scripts/test-ci-harness.sh` 里用桩 `sudo`（直接执行）与桩 `npx`（记录参数、复制当时的 apt 配置、模拟 apt 写入 `.deb`、`lock` 与 `partial/`）测试：成功与失败两种退出码都原样传出，期间配置正确，事后配置、`lock`、`partial/` 都清掉，`.deb` 保留。apt 配置路径可经 `PLAYWRIGHT_APT_CONF` 覆盖，只供桩测试使用。
- **D4 oracle。** `check_wf` 的 ui-walk 步骤序列逐字钉住新缓存步骤与脚本步骤；`harness_clean` 加一个 `extra` 参数：omp 二进制缓存仍须恰一步且紧邻 `make omp-fetch`，其余缓存步骤必须逐字等于该 job 的 `extra`（只有 ui-walk 传入 Playwright 缓存）。`inspect-ci-workflow.js` 的 `actions/cache@v6` 计数 4 → 5。原有锚在 ui-walk `actions/cache@v6` 或旧安装行上的变异重新锚定，不删除。
- **D5 允许前缀回退。** 「CI omp 二进制缓存」禁止 `restore-keys`，因为旧二进制会让 `omp-fetch.sh` 校验失败。这里不同：apt 对 `Dir::Cache::Archives` 里已有的 `.deb` 只比对文件名（含版本）与大小、不重算哈希（apt 2.7 `pkgAcqArchive`），这对精确命中与前缀回退一样；缓存只能由本仓库同一 ref 或 master 上成功的 job 写入，fork PR 写不进 base 分支的缓存；版本不符的浏览器由 Playwright 重新下载。前缀回退因此不比精确命中多出信任面，旧缓存最坏只是让安装走网络。Playwright 升级时，回退保留了 `.deb`，新 key 第一次运行就不必连软件源下载字体包。

## Must preserve

- `make ui-walk`、走查用例与 error oracle、Playwright 版本、安装的浏览器（Chromium）不变。
- ui-walk 里 omp 二进制缓存仍恰一步、紧邻 `make omp-fetch`；smoke、uid-isolation、browser-image 的缓存不变。
- 不新增 action、不改 permissions、不引用 secrets。

## Residual risk

- **索引与缓存的版本漂移。** 软件源可达时 `apt-get update` 每次拉在线索引；某个字体包在线出了新版本后，apt 会去下载它，精确命中时缓存不会重存，此后每次运行都要下载这一个包，故障期间则退回 runner 镜像自带的索引，所需版本未必在缓存里。直到 Playwright 升级换 key 才重新收齐。字体包在 noble 里很少更新，接受。
- **真实 DNS 故障下的耗时。** 屏蔽探针得到的是连接被拒，立即失败；2026-11-11 的 DNS 故障里 `apt-get update` 自己卡了约 3.5 分钟。加上热命中时 ui-walk 约 3 分钟，合计约 6.5 分钟，在 `timeout-minutes: 15` 之内，未实测。
- **前缀回退路径。** Playwright 升级后复用旧 `.deb`、清理旧浏览器的路径没有 CI 证据。
- **冷缓存。** 首次运行、或 7 天未用被淘汰后，安装仍依赖软件源。
- **update 退出码。** update 失败不阻断 install 的依据是故障日志，屏蔽探针只证明命中时不需要下载；若将来 apt 对索引失败改为非零退出，命中时也会失败，届时需改为跳过 update。

## Required evidence

- 本机：`make test-guardrails` 退出 0，`ci-harness oracle` 全 PASS；桩测试两种 bash 全过、脚本变异全部被抓。
- CI：冷缓存一次（post 步骤 `Cache saved`，key 末尾是真实哈希）；热缓存一次（`Cache restored`，Playwright 不下载浏览器，apt 只读本地 `.deb`）；屏蔽 Ubuntu 软件源与 `security.ubuntu.com` 的一次（ui-walk 通过），之后撤掉屏蔽提交。
