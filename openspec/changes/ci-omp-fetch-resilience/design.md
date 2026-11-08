# Design: ci-omp-fetch-resilience

Change surface: `scripts/omp-fetch.sh`；新 `scripts/test-omp-fetch.sh`；`scripts/test-guardrails.sh` 加一行调用它。

Must preserve:
- omp-runtime「二进制供给」全部既有行为：只取 v18.12.3、按 `uname -sm` 选资产、固定 SHA256 表校验、校验失败不留 `var/omp/omp`、已存在且校验通过即跳过（`omp-fetch: skip download` 原文）、已存在但校验不过即删除并非零、不支持平台打印矩阵。
- 本机 `make omp-fetch` 在主地址可用时的行为与输出不变（不发 API 请求）。
- Makefile `omp-fetch` 目标的配方与契约保护（Scenario「Make contract protection」）不变。
- `deploy/app/Dockerfile` 与 `Dockerfile.dockerignore` 不变。
- CI 契约不变：`.github/workflows/ci.yml`、`scripts/test-ci-harness.sh`、`scripts/inspect-ci-workflow.js`、`scripts/fixtures/ci-contract/*` 一字不改（verification-harness「不添加 action/cache」与第三方 action 白名单、chat-harness、omp-uid-isolation 的步骤链）。

Must add/change:
- D1 回退：主地址 curl SHALL 放在 `if ! curl …; then … fi` 里（脚本开着 `set -euo pipefail`，顶层裸调失败会直接退出）。失败后 `rm -f "$tmp"`，stderr 打一行 `omp-fetch: primary download failed; retrying via GitHub API asset`，向 `https://api.github.com/repos/can1357/oh-my-pi/releases/assets/<asset_id>` 发一次 `curl --fail --location -H 'Accept: application/octet-stream'`（重试与超时参数同主地址）写同一临时文件；它也失败即非零退出（trap 清临时文件）。之后走同一 SHA256 校验。固定资产 id：`omp-darwin-arm64` 657108328、`omp-linux-x64` 657108334（`gh api repos/can1357/oh-my-pi/releases/tags/v18.12.3` 查得；id 错也只会因 SHA 校验失败而拒绝，不会装错）。
- D2 不带凭证：两条请求都匿名，不读 `GITHUB_TOKEN` 或任何 secret（harness job 不引用 secrets 的契约）。公开仓库匿名可下载；API 地址的 60 次/小时/IP 限额只在主地址失败时才消耗。
- D3 不加缓存：见 proposal 的 Scope。browser-image 的构建上下文排除 `var/`，同样只靠回退。
- D4 测试 seam：`scripts/test-omp-fetch.sh` 把 `scripts/omp-fetch.sh` 复制进临时目录，用 `sed` 把 SHA256 常量与资产 id 常量改写为测试值（与假 curl 写入内容的摘要对应），在 PATH 前置假 `uname`（固定输出 `Linux x86_64`，用例也测一次 `Darwin arm64` 的资产 id）与假 `curl`。假 curl 把每次调用的 argv 逐行追加到记录文件，按 URL 与用例设定决定「写入给定内容到 `--output` 目标并退出 0」或「退出 22」。生产脚本 SHALL NOT 新增任何按环境变量覆盖 SHA、id 或 URL 的旁路。

Governing invariant: 落到 `var/omp/omp` 的文件恒为 SHA256 与固定表一致的 v18.12.3 官方资产，无论它来自主地址还是 API 地址。

Sibling surfaces: Makefile `omp-fetch` 目标（只调脚本，不改）；`deploy/app/Dockerfile:10`（调同一脚本，自动获得回退）；CI 三个 job（同上）；`server/test/support/omp-official.ts`（版本钉，不受影响）；CI 契约 harness（不改，`make test-guardrails` 证明仍绿）。

Seams under test: 以 shell 用例驱动脚本——用 PATH 前置的假 `curl`（按 URL 决定成功写入给定内容或非零退出）与临时工作目录，断言退出码、`var/omp/omp` 存在与否、stderr 行、是否带 `Authorization` 头（假 curl 记录参数）。

Required evidence（全部在 `scripts/test-omp-fetch.sh`，经假 curl / 假 uname，不发真实网络请求）:
- 主地址成功：curl 只调一次且 URL 为主地址，产出可执行的 `var/omp/omp`，stdout `omp-fetch: installed …`，无回退行。
- 主地址失败、API 成功且摘要正确：curl 调两次，第二次 URL 为 `…/releases/assets/657108334` 且 argv 含 `Accept: application/octet-stream`；产出文件；stderr 有回退行；退出 0。
- `Darwin arm64` 下回退：API URL 的 id 为 657108328。
- 主地址失败、API 成功但摘要不符：非零，stderr 含 expected/actual，不留 `var/omp/omp`。
- 两条都失败：非零，不留 `var/omp/omp` 与 `var/omp/.omp-fetch.*`。
- 已存在且校验通过：不调 curl，stdout 含 `omp-fetch: skip download`。
- 任何用例里 curl 的 argv 都不含 `Authorization`；至少一条回退用例带 `GITHUB_TOKEN=tok-sentinel` 跑，argv、stdout、stderr 都不含 `tok-sentinel`。
- 用例先红：在未改的脚本上，回退相关三条失败（主地址失败即非零）。
- `make test-guardrails`、`make anti-drift` 退出 0；CI 上 smoke / ui-walk / uid-isolation / browser-image 在主地址 504 期间变绿（日志可见回退行）。

Non-goals: CI 缓存与 token（与现行规格冲突，留 #1932 由 owner 裁定）；改 pin 版本或校验逻辑；自建镜像或制品库；hurl 安装脚本；任何 CI 文件改动。

Review focus: `set -e` 下回退真的可达；失败路径不留部分文件；两条请求都不带凭证；无测试旁路进生产脚本；既有跳过 / 摘要不符 / 不支持平台行为不变；CI 文件零改动。
