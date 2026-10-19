# Proposal: omp-browser-integration

## Why

#912：owner 2026-10-06 验收时让助手写一个 html 并用 omp 自带的浏览器（`write` 到虚拟路径 `xd://browser`）打开核对，两次都超时（30 s / 90 s），截图也因模型「不支持图片输入」失败，界面上只显示为名为 `write` 的失败步骤和 `Allow tool: write / Path: xd://browser` 的确认卡。owner 要求把浏览器能力正式接入产品。

查明的根因（2026-10-18，omp v18.0.10 源码 + 验收日志）：首次 open 时 omp 去下载 181 MB 的 Chrome-for-Testing（macOS 一律下载；Linux 先找系统浏览器，找不到才下载），下载未完期限先到；看图失败是因为未设 `MODEL_CATALOG` 的单模型配置固定 `vision: false`，而当前模型 deepseek-v4.1-flash 本身能看图。owner 逐分支裁定见 design「owner 的裁定」，收敛小结 2026-10-18 确认。

## What Changes

- **浏览器从部署方给出的可执行文件启动**：新增 `BROWSER_BIN`（绝对路径）。设置时宿主校验后以 `PUPPETEER_EXECUTABLE_PATH` 传给 omp，omp 不再下载、不再自动发现；未设置时宿主 overlay 钉 `browser.enabled: false`，助手没有浏览器工具。
- **overlay 钉住浏览器相关键**：`browser.enabled`、`browser.cdpUrl`、`browser.relay`、`browser.cmux`、`browser.headless`、`browser.screenshotDir`（工作空间下的相对目录 `screenshots`；实测落点不在工作空间时按 owner 裁定改落状态目录），以及白名单里有能看图的模型时的 `modelRoles.vision`。overlay 由「全局一份逐字节固定」改为「按部署配置确定、不随会话与档位变化」。
- **单模型配置可声明看图**：新增 `MODEL_VISION=on|off`，缺省 `on`（与 `MODEL_REASONING` 同形，与 `MODEL_CATALOG` 同设即启动失败）。
- **浏览器操作在卡片上显示为浏览器操作**：服务端识别 `write` 到 `xd://browser` 的审批请求与工具步骤，工具名一并改为 `browser`（审批与步骤按工具名配对，必须同时改），确认卡与步骤摘要写成「浏览器：打开 <地址>」「浏览器：在标签页 main 执行脚本」「浏览器：关闭标签页 main」；调用带 `app.path`（含其 `app.args`）/ `app.cdp_url` / `app.relay` 时卡上另起一行显著标出，参数被截断看不全时卡上固定一行警示；识别规则与 omp 的设备路径解析一致（`[xd://browser]` 等写法同样识别）。每次浏览器调用以完整参数写一条审计（`yolo` 档的唯一痕迹）。前端不改。
- **截图进「文件变更」卡**：浏览器步骤结果里落在绑定工作空间内的截图文件，作为本回合写入的文件进入既有 `files.changed` 与文件变更卡（截图落到状态目录的退路下不进卡）。
- **参考部署镜像**：新增 app 参考 Dockerfile（app + 官方 omp v18.0.10 + Debian chromium + 中文字体，应用用户与 omp 用户两个 uid、按 ADR-0010 的 sudoers 进镜像）与 compose 片段；写范围由容器挂载决定（只挂沙箱根、omp 状态目录与 app 私有数据可写）。仓库不发布镜像。
- **真实浏览器的 CI 验证**：新 CI job 现场构建参考镜像，在容器里以 omp 用户经真实 omp 打开工作空间内的 html 并截图，断言步骤成功、卡片与步骤名为浏览器、截图落在工作空间并进入文件变更。owner 选择该项即批准 CI 改动。
- **文档**：system.md 9.7 第 2 条改写、新增 9.8「浏览器与参考镜像」；ADR-0012 补充浏览器键已钉、工具参数层的残余；ADR-0010 补充参考镜像；验收清单新增 CH-121–CH-123。

## Capabilities

### New Capabilities

- `browser-runtime`：ADDED「浏览器可执行文件配置」（`BROWSER_BIN`）、「浏览器操作的可读描述」（审批、步骤、审计共用的纯函数）、「浏览器调用审计」、「参考部署镜像」、「CI browser-image job」。

### Modified Capabilities

- `omp-runtime`：MODIFIED「宿主 overlay」（浏览器块与 `modelRoles.vision` 进 overlay；按部署配置确定的字节）；MODIFIED「子进程 spawn 契约」（环境白名单在设置了 `BROWSER_BIN` 时多一个 `PUPPETEER_EXECUTABLE_PATH`；恒钉 `PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`、`PUPPETEER_PROXY=direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0`，使工作目录 `.env` 打不开浏览器中继与 cmux、也不能给浏览器挂代理或关证书校验（#1529，owner 2026-10-19）；直连与 sudo 两种模式同一份）。
- `tool-approval`：MODIFIED「审批请求识别」（`xd://browser` 的审批工具名为 `browser`、标题改写为可读的浏览器操作）。
- `chat-stream`：MODIFIED「纯协议事件归约」（`xd://browser` 的步骤名为 `browser`、detail 首行为可读摘要；浏览器步骤的截图候选）。
- `turn-artifacts`：MODIFIED「文件变更推导与归属」（工具名集合加 `browser`，候选取自截图路径）。
- `model-selection`：MODIFIED「模型白名单配置」（`MODEL_VISION`）——以 change `epic-acceptance-followups` 的同名 delta 为底本。
- `model-proxy`：MODIFIED「托管 models.yml」（单模型缺省多出 `input` 三行）——以 change `epic-acceptance-followups` 的同名 delta 为底本。
- `session-composer-settings`：MODIFIED「输入框选项端点」（缺省配置的单模型 `vision` 为 `true`）。
- `thinking-fold`：MODIFIED「reasoning 前提与真运行时取证」（「关闭 reasoning」的字节比对改为引用 model-proxy 的单模型定义）。
- `http-service-skeleton`：MODIFIED「服务启动与装配」（配置键 35 → 37：`BROWSER_BIN`、`MODEL_VISION`；「单模型字节不变」改为引用 model-proxy）。
- `omp-uid-isolation`：MODIFIED「OMP_USER 配置与 sudo spawn 前缀」（固定的 `--preserve-env` 列表末尾依次加 `PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,PUPPETEER_EXECUTABLE_PATH`，四个恒钉的键在 sudo 下才不被丢掉，#1529）；MODIFIED「CI uid-isolation job」（聚合门禁的 direct job 数十 → 十一）。
- `verification-harness`：MODIFIED「CI 接线与控制面同步」与「第三方 CI action 使用 Node 24 runtime」（direct job 十 → 十一、checkout/setup-node 次数 10/8 → 11/9、Enforcement Index 加「浏览器参考镜像」行、`browser-image` 钉在 `ubuntu-24.04`）。
- `omp-test-harness`：MODIFIED「受控上游思考与写入标记」（「无标记字节不变」的标记集合加上浏览器标记；omp 补的图片附件消息不算用户消息）；ADDED「受控上游浏览器标记」（`WORKBUDDY_BROWSER_OPEN:<url>` 与 `WORKBUDDY_BROWSER_SHOT` 工具轮、图片附件消息的跳过规则）。

## Impact

- server：`server/src/agent-config.ts`（`BROWSER_BIN`）、`server/src/model-catalog.ts`（`MODEL_VISION`）、`server/src/sessions/omp/host-overlay.ts`（模板化）、`server/src/sessions/omp/process.ts`（env 与 sudo `--preserve-env`）、`server/src/sessions/omp/ui-requests.ts`（审批识别与标题改写）、`server/src/sessions/events.ts` 与 `server/src/sessions/file-changes.ts`（步骤名、detail、截图候选）、新的 `xd://browser` 解析小模块、`server/src/sessions/turn-control.ts` 与 `store-segments.ts`（审计写入）；对应测试、`smoke/session-meta.hurl` 与假上游夹具（假 omp 不改）。
- 部署：新目录 `deploy/app/`（Dockerfile、compose 片段、入口脚本；sudoers 规则在 Dockerfile 里写入）；`.github/workflows/ci.yml` 新 job 与 `.github/scripts/ci-browser-image.sh`；`scripts/test-ci-harness.sh` 与 `AGENTS.md` Enforcement Index 的 CI 合同同步（`constraints.yaml` 不改）。
- 文档：`docs/architecture/system.md`、`docs/adr/0012-omp-project-config-host-overlay.md`、`docs/adr/0010-dedicated-omp-uid.md`、`docs/acceptance/functional-checklist.md`。
- 依赖：镜像基底 `node:24.13.1-bookworm(-slim)` 与五个 Debian 包 `chromium`、`fonts-noto-cjk`、`fonts-dejavu-core`、`sudo`、`ca-certificates`（按 AGENTS.md:40 在 PR 说明）；npm 无新依赖。
- 次序：model-selection / model-proxy 的 delta 以 `epic-acceptance-followups` 为底本，任务组 4 依赖 #1522 先合入；该 change 先归档。
- 测试与 smoke：`smoke/session-meta.hurl` 两处缺省选项响应体改为 `"vision":true`。
- 不碰：web 前端、文件页、预览源、办公文档 sidecar、`MODEL_CATALOG` 的键集（`vision` 已有）。
