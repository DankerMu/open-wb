# browser-runtime Spec Delta

## REMOVED Requirements

### Requirement: 浏览器操作的可读描述
**Reason**: omp v18.12.3 没有 `xd://browser` 设备，浏览器改为 `eval` 工具 JS prelude 里的 `browser.*` 调用；宿主不再有可以解析的浏览器参数，也不再把任何步骤或审批改名为 `browser`（owner 2026-10-20 Q4：用户看到的是 eval 卡上的代码，不做启发式改名）。`server/src/sessions/omp/xd-browser.ts` 及其三处用法一并删除。
**Migration**: 确认卡显示 `Allow tool: eval` 的语言与代码（tool-approval「审批请求识别」）；步骤卡名为 `eval`、detail 为参数 JSON（chat-stream「纯协议事件归约」）；审计由 `eval` 结束帧的 statusEvents 派生（「浏览器调用审计」）；截图由目录比对进入文件变更（turn-artifacts「文件变更推导与归属」）。CH-121 改写。

## MODIFIED Requirements

### Requirement: 浏览器调用审计
每个登记名为 `eval` 的工具步骤，其结束帧带浏览器状态事件时 SHALL 留下审计：supervisor 落库该步骤 `step.end` 时（`server/src/sessions/turn-control.ts` 的 step.end 分支），在写入步骤结束行的同一 SQLite 事务内，对归约器为该 step.end 给出的 `browser.calls`（chat-stream「纯协议事件归约」：omp v18.12.3 `tool_execution_end.result.details.statusEvents[]` 里 `op:"browser"` 的每一项，依次为 `{detail, error}`）每项经 audit-core 的 `emit` 写一条 `kind="session.browser"`、`actorId` 为会话 `owner_id`、`title="浏览器操作"`、`detail={sessionId, messageId, stepId, detail, error}`（`stepId` 为持久化的数字步骤 id；`detail` 是 omp 的状态行原文，如 `open main https://…`、`close all`、`main.screenshot()`、`main.run(<首行>)`，失败项 `detail` 为 null、`error` 为 omp 的错误文本前 500 字符）；`browser.elided` 为正时再写一条 `detail={sessionId, messageId, stepId, elided:<n>}`（omp 丢弃了最早的 n 条状态事件，不伪造它们）。成功与失败的 eval 步骤都写（浏览器调用在 eval 失败之前可能已经发生）；三个档位都写（`yolo` 档不因档位出任何确认卡，`write` / `always-ask` 档下 prelude 的卡由宿主自动放行、不登记——这是浏览器调用唯一的痕迹）；`eval` 本身的审批照旧另写 `session.approval`（`detail.tool="eval"`）。`detail` SHALL NOT 含 `code` 原文（步骤 detail 已有）。审计写入失败、或 store 未配置 `emit` 时，该 step.end 不落库、不发布（与 #1526 对浏览器 step.start 的 fail-closed 同形），沿既有 owned error-sink 路径处理；没有 `browser` 字段的 step.end 在未配置 `emit` 时照常落库。

#### Scenario: 每次浏览器调用一条审计
- **WHEN** 档位 `yolo` 的绑定会话一个回合里有两个 `eval` 步骤（第一个的结束帧 `details.statusEvents` 为 `[{op:"browser",detail:"open main https://a"},{op:"eval",detail:"x"},{op:"browser",detail:"main.screenshot()"}]`；第二个以 `isError:true` 结束、`statusEvents` 为 `[{op:"browser",error:"Browser open timed out after 30000ms"}]`、`statusEventsElided:2`）和一个 bash 步骤
- **THEN** 审计恰多四条 `session.browser`，`actorId` 为会话所有者：前两条 `detail` 为 `{sessionId, messageId, stepId:<第一步 id>, detail:"open main https://a", error:null}` 与 `{…, detail:"main.screenshot()", error:null}`；第三条为 `{…, stepId:<第二步 id>, detail:null, error:"Browser open timed out after 30000ms"}`，第四条为 `{sessionId, messageId, stepId:<第二步 id>, elided:2}`；四条都不含 `code`；bash 步骤与不带浏览器事件的 eval 步骤没有 `session.browser`

#### Scenario: 审计失败时步骤不落库
- **WHEN** 带 `browser` 字段的 `eval` step.end 的审计写入失败；另一次 store 未配置 `emit`
- **THEN** 两次该步骤的结束都没有写入（步骤仍为 running、`output` 为 NULL，由下次启动的 `reconcileOnStartup` 结算——infra-faulted 的 pump 不提交 turn.end）、`step.end` 不发布、ring 序号不推进，失败沿 owned error-sink 路径处理；不带 `browser` 字段的 eval 与其它步骤在未配置 `emit` 时照常落库

### Requirement: 参考部署镜像
仓库 SHALL 在 `deploy/app/` 提供部署方自建、不发布的 app 参考镜像（owner 2026-10-18，#912 Q1/Q6/Q10）：
- `Dockerfile`：构建阶段以 `node:24.13.1-bookworm` 运行 `npm ci`、构建 web 与 server、经 `scripts/omp-fetch.sh` 取得官方 omp v18.12.3（SHA256 校验，omp-runtime「二进制供给」）；运行阶段以 `node:24.13.1-bookworm-slim` 为底，装 Debian 包 `chromium`、`fonts-noto-cjk`、`fonts-dejavu-core`、`sudo`、`ca-certificates`（`--no-install-recommends`），只拷入运行所需的编译产物、生产依赖与 omp 二进制。
- 身份（ADR-0010）：应用用户 `workbuddy`（uid 10001）与 omp 用户 `omp`（uid 10002）两个 uid，主组都是 `workbuddy`（gid 10001）；`/etc/sudoers.d/workbuddy-omp` 恰含 `workbuddy ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <镜像内 OMP_BIN> *` 与 `Defaults>omp umask=0007` 两条规则，构建时经 `visudo -c` 校验；容器以 `workbuddy` 运行，入口脚本先 `umask 007` 再 `exec` 编译版服务。
- 镜像内固定 `OMP_USER=omp`、`OMP_BIN`、`BROWSER_BIN=/usr/bin/chromium`、`SANDBOX_ROOT`、`OMP_STATE_DIR`、`DB_PATH`、`STATIC_ROOT`、`PREVIEW_CACHE_DIR`（在 app 私有数据目录之下）、`HOST=0.0.0.0` 与 `PREVIEW_PORT`——服务启动时创建或写入的每个路径 SHALL 落在三个可写挂载或 `/tmp` 之下，使只读根文件系统下启动成功（可选的 `OFFICE_SPOOL_DIR` 例外：它是部署方另挂的、与 converter 共享的目录）；上游地址与密钥 SHALL NOT 进入镜像，由部署方在运行时给出。服务目前没有可配置的认证：唯一的登录方式是迁移预置的演示账号（口令公开、不可修改或停用，含管理员）；`compose.yml` 的注释与 `docs/architecture/system.md` SHALL 写明，在真实认证落地之前不得把服务端口放开到不可信网络，前置反代须自带访问控制。
- `compose.yml`：根文件系统只读、`/tmp` 为 tmpfs、`shm_size` 不小于 `1g`、三个可写 bind mount（沙箱根、omp 状态目录、app 私有数据目录）、`cap_drop: [ALL]` 再只加回「以 omp 用户启动 omp 并向其转发信号」实测所需的最小集合、不 `privileged`。可写范围即这三个挂载与 `/tmp`（owner Q5：写范围由挂载决定，omp 内不另限）。三个挂载点的宿主目录 SHALL 属应用用户：app 私有数据目录 `0700`（ADR-0010：app 自有状态不对 omp 用户开放）；沙箱根与 omp 状态目录属组 `workbuddy`，权限位由服务启动时按 sandbox-core「沙箱根目录」与 omp-runtime「OMP_STATE_DIR 托管布局」校正。`compose.yml` 的注释与 `docs/architecture/system.md` 写明这三项。
仓库 SHALL NOT 发布该镜像或引用镜像仓库。

#### Scenario: 镜像可构建且身份正确
- **WHEN** 在任一 Docker 主机上（CI 由「CI browser-image job」执行）`docker build -f deploy/app/Dockerfile .`，再在该镜像的容器内检查
- **THEN** 构建成功；以 compose 的安全标志（只读根、三个挂载、`/tmp` tmpfs）运行时服务启动成功、`GET /api/healthz` 为 200；`/opt/workbuddy/omp --version` 输出 `omp/18.12.3`；`id -u workbuddy` 为 `10001`、`id -u omp` 为 `10002`，两者的主组都是 `workbuddy`（gid `10001`）；`visudo -c` 通过且 `/etc/sudoers.d/workbuddy-omp` 恰为上述两条规则；`/usr/bin/chromium` 可执行；`/usr/share/fonts/opentype/noto/` 下有 Noto CJK 字体文件；`docker image inspect` 的环境变量与镜像文件系统里都没有 `MODEL_UPSTREAM_API_KEY` 的取值（构建前把一个哨兵值同时放进构建 shell 的环境与构建上下文根目录的 `.env`，构建后在镜像 Env、`docker history --no-trunc` 与导出的根文件系统里搜，导出一路以一个已知存在的字符串作对照）；`visudo -c` 与 sudoers 文件读取以 `docker exec -u 0` 执行；服务进程的 umask 为 `0007`（`/proc/<pid>/status` 的 `Umask`）；运行镜像里没有 `/app/server/src` 与开发依赖（如 `/app/node_modules/typescript`、`vite`）

### Requirement: CI browser-image job
`.github/workflows/ci.yml` SHALL 有 job `browser-image`（`runs-on: ubuntu-24.04`、`timeout-minutes: 20`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → `docker build -t workbuddy-app:ci -f deploy/app/Dockerfile .` → `bash .github/scripts/ci-browser-image.sh`。脚本 SHALL：
1. 对构建出的镜像执行「参考部署镜像」场景的全部容器内检查。构建期哨兵一项由脚本自己完成：生成随机哨兵，写进构建上下文根目录的 `.env` 并导出到构建 shell 的环境（以 `--build-arg` 把它交给构建），再以同一 Dockerfile 构建一个哨兵专用 tag（`.env*` 被 `Dockerfile.dockerignore` 排除，构建全程命中缓存），在该 tag 上搜；这一项证明的是 Dockerfile 没有经 `ARG`/`ENV`/`COPY` 把构建环境或上下文里的密钥带进最终镜像。读服务状态目录与私有目录的检查以镜像缺省用户 `workbuddy`（属主）在容器内执行——容器在 `--cap-drop ALL` 下，`-u 0` 没有 `CAP_DAC_OVERRIDE`、读不进这些目录；只有 `visudo -c` 与 sudoers 文件读取用 `-u 0`。
2. 建三个挂载目录，属主为容器内 `workbuddy` 的数值 uid:gid（`ensureOwnedDir` 要求目录属于服务进程的 uid；app 私有数据目录 `0700`，另两个的权限位交给服务启动校正），并准备一个只读挂载进容器、不在容器 `PATH` 上的浏览器包装脚本（每次被执行时在 `/tmp` 留一个标记文件，再 `exec /usr/bin/chromium "$@"`），以 `BROWSER_BIN=<包装脚本>` 覆盖镜像缺省值——Linux 上 omp 在没有 `PUPPETEER_EXECUTABLE_PATH` 时会在 `PATH` 上找到 `/usr/bin/chromium`，只有经包装脚本才能证明 `BROWSER_BIN` 真的抵达了 omp。
3. 以与 `deploy/app/compose.yml` 逐项相同的安全标志 `docker run` 该镜像（网络用 `--network host` 以访问回环上的假上游，并覆盖 `HOST=127.0.0.1` 与 job 专用端口，免得镜像缺省的 `0.0.0.0` 在 runner 全部网卡上监听），`MODEL_CATALOG`、`MODEL_VISION` 与 `MODEL_ID` 都不设（缺省单模型 `deepseek-v4.1-flash`、看图缺省 `on`：omp v18.12.3 不再按模型 id 剥掉图片部分，缺省配置下的看图链路正是 #1560 的关闭凭据）。结束时先 `docker rm -f` 容器（broker 与 Chromium 随容器的 PID 命名空间一起结束），再以 `sudo` 删除挂载目录（其中文件属 `10001`/`10002`）。
4. 运行驱动 `.github/scripts/ci-browser-e2e.mjs`：它以进程内 `start({toolRoundScope:"turn"})` 起受控假上游（omp-test-harness；同一会话的第二个回合需要按回合判定工具轮），并在假上游前放一个驱动内的转发监听器：容器的 `MODEL_UPSTREAM_BASE_URL` 指向它，它记下每个请求体是否含 `image_url` 部分后原样转发（假上游的请求记录只存 `messages` 条数、不存内容）；对容器里的服务走一遍：登录 → 建工作空间并上传 `index.html`（上传接口一律写到空间的 `uploads/` 下）→ 建绑定该空间、档位 `write` 的会话 → 发 `WORKBUDDY_BROWSER_OPEN:file://<空间根>/uploads/index.html`（`<空间根>` 取建空间响应里的 `root`；假上游发一个 `eval` 调用，JS 里 `browser.open`）并允许审批、等回合结束 → 在同一会话发 `WORKBUDDY_BROWSER_SHOT`（`eval` 调用，JS 里 `browser.tab("main").screenshot()`）并允许审批、等回合结束（标签页属 omp 进程、回合结束时冻结、下次使用解冻；两个回合之间不得触发进程退役）。驱动只会看到 `eval` 的审批：prelude 的 `Allow tool: browser` 卡由宿主自动放行，不进审批列表。
job SHALL 进入 `all-checks-passed.needs`；`scripts/test-ci-harness.sh` 与 `AGENTS.md` Enforcement Index 同步（verification-harness「CI 接线与控制面同步」；`constraints.yaml` 不需改，其 `ci.matrix` 已含 `ubuntu-24.04`）。任何断言失败、超时或容器异常退出时 job 非零，且日志不泄漏会话 token。

#### Scenario: 真实浏览器打开工作空间页面并截图
- **WHEN** PR CI 运行 `browser-image`
- **THEN** 镜像检查全部通过；两个回合各恰一条审批，`tool` 都为 `eval`，`title` 首行为 `Allow tool: eval`、第二行为 `Language: javascript`、第一回合的代码行含 `browser.open`、第二回合的含 `screenshot`；两个步骤名都为 `eval`、`status` 为 `done`；第二个步骤的 `changes` 恰一项，`path` 匹配 `^screenshots/screenshot-[^/]+\.png$`、`kind` 为 `write`，该文件经工作空间文件接口读得到且以 PNG 签名开头；第一个步骤的 `changes` 为 `null`；第二个回合里经转发监听器的请求中至少一条的 `messages` 含 `image_url` 部分（截图送到了能看图的模型，模型 id 为缺省的 `deepseek-v4.1-flash`），第一个回合的请求都不含；审计恰有两条 `session.browser`，`detail.detail` 分别以 `open main file://` 开头与含 `screenshot`，`detail.error` 都为 null，没有带 `elided` 的条目；容器 `/tmp` 下有包装脚本的标记文件且属 uid 10002；`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在（omp 每次无头启动都会建 `puppeteer/` 并写一个 `package.json`，下载的浏览器才在 `chrome/` 下），`<OMP_STATE_DIR>/xdg/state/omp/logs/` 下的日志不含 `Downloading Chromium for puppeteer`；`chrome/` 不存在一项以 `puppeteer/package.json` 存在作对照
- **WHEN** 该 job 失败、被取消或被跳过
- **THEN** `all-checks-passed` 非零
