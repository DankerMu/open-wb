# Tasks: s0b-minimal-chat-loop

> 执行序按依赖排列；TDD：每条实现任务先写失败测试再实现。组 1/2/5 可并行；组 3 依赖 1、2；组 4 依赖 3；组 6 依赖 3、4、5。

> 本次人工审核偏离：用户明确指示“本次工作豁免人工审核，待epic全部完成后进行功能审核”。仅适用于 Epic #81；代理审核、测试、CI 与修复轮次门禁不变。决定留痕：https://github.com/DankerMu/open-wb/issues/81#issuecomment-5743093674。

## 1. omp-runtime

- [x] 1.1 `make omp-fetch`：Makefile 目标 + `scripts/omp-fetch.sh`（固定版本 v18.0.10、按 `uname -sm` 选资产、SHA256 表校验、幂等跳过、不支持平台显式失败）；`var/omp/` 落点；`.PHONY`/头注释同步；`scripts/test-ci-harness.sh` 控制面 oracle 同 PR 扩展——`omp-fetch` 进入受保护目标集（recipe 精确形状 + `omp-fetch :` 等价 duplicate mutation 必红），`make test-guardrails` 绿；本地实测 `var/omp/omp --version` = `omp/18.0.10`
- [x] 1.2 `server/test/support/fake-omp.mjs`：按 rpc.md 吐帧的假子进程脚本（ready/negotiate/get_state、可脚本化：不发 ready、缺 sessionFile、分块/交错、崩溃、stopReason error、extension_ui_request、**call-proxy 模式**——从 `$PI_CODING_AGENT_DIR/models.yml` 取 `baseUrl`、以 `WORKBUDDY_MODEL_TOKEN` 为 bearer 真实 POST `/chat/completions` 并把上游文本转为 `text_delta` 帧，供 3.8 的「经代理的 prompt」单测使用）+ 自身契约单测
- [x] 1.3 `server/src/sessions/omp/process.ts` — **spawn 契约**：argv 组装（含 `--resume` 仅非 null 时追加）、env 白名单（精确键集断言）、四目录 mkdir；以捕获 spawn 参数的注入点单测，不走协议
- [x] 1.4 `server/src/sessions/omp/process.ts` — **帧层与握手**：JSONL 读写、`rpc_chunk` 重组与校验、`id` 相关、ready→negotiate v2→get_state（sessionFile 非空才成功）与超时、退出观察、`extension_ui_request` 回绝；对 1.2 假子进程单测
- [x] 1.5 `server/src/sessions/omp/runtime.ts`：`SessionRuntime`（懒 spawn、可注入时钟的 idle 计时器、关停序列 stdin→TERM→KILL、token 生成与注销回调、回合中退出上报）+ 单测；PR160 合并，初始 TDD 顺序偏离保留在子 fixture 的历史未满足项中

Suggested fixture level: expanded - 子进程生命周期、环境白名单与协议帧层是 Critical Path（凭证注入/spawn 回收）白盒面，必须以真实子进程（假脚本）而非 mock 证明
Minimal mergeable slice: 1.1 omp-fetch 单独可合并保绿（纯 Makefile+脚本，自带 `--version` 验证，无 TS 依赖；scripts/*.sh 不在 size-guard/jscpd 扫描面）；1.2 假子进程脚本独立可合并（测试支撑 + 自带契约测试）；1.3 spawn 契约独立于 1.4 合并（参数捕获测试不需要协议）；1.4 依赖 1.2、1.3；1.5 依赖 1.4

## 2. model-proxy

- [x] 2.1 `server/test/support/fake-upstream.mjs`：零依赖假 OpenAI 兼容上游（两轮脚本、`WORKBUDDY_FAKE_ERROR` → 500、401、`FAKE_UPSTREAM_PORT`、可进程内 `start()`/可 `node` 直跑）+ 契约单测。#88 / PR168 merged；19契约、797服务端测试通过；9错误候选拒绝，三席首轮clean，同SHA CI全绿；双mount共享handler满足根路径及D11 `/v1` base。#166旧fake-omp两轮relay由#102集成处理。
- [x] 2.2 `server/src/core/errors/index.ts` 消息/代码扩为七码（`session_busy`/`agent_unavailable`），`server/src/http/errors.ts` 状态映射同步409/502，`CONTENT_PARSER_OWNED_ROUTES` 增 `POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`。#84 / PR171 merged；147聚焦、841服务端测试通过，真实HTTP与9错误候选检验通过，三席首轮clean、同SHA CI全绿；保留route-local no-store，无新产品路由或旧http类型转发。
- [x] 2.3 `server/src/model-proxy/index.ts`：`registerModelProxy(app,{upstream,tokens})`。#98/PR176 merged；50聚焦/891服务端测试，真实HTTP与复用HTTPS、19错误变体及恢复检验通过；三席首轮clean、同SHA CI全绿。鉴权先于配置/解析、5xx统一502、连接建立10s但无TTFT/整流时限；未完上传与上游流均受关闭治理，根装配仍由3.7完成。
- [x] 2.4 `server/src/model-proxy/models-yml.ts`：#89/PR180 merged。实际IPv4/IPv6监听地址推导、块式YAML安全转义、固定env-name凭证、内容幂等与IO错误传播；6聚焦/937服务端测试，4真实监听地址、15冻结后独立案例及13错误候选/恢复检验通过；三席首轮clean，同SHA CI全绿。原探针可见性偏离与修复留痕；启动调用仍属于3.8。

Suggested fixture level: expanded - 代理是 ADR-0008 凭证边界（Critical Path），bearer 命中/注销与"上游密钥不外泄"须以真实 HTTP 往返证明
Minimal mergeable slice: 2.1 假上游单独可合并保绿（纯测试支撑文件+自带契约测试，无生产代码）；2.2 错误表扩展独立可合并（既有测试面内扩断言，归属路由在路由存在前仅为集合成员断言）；2.3 依赖 2.1、2.2；2.4 独立可合并（纯文件生成器）

## 3. chat-sessions

- [ ] 3.1 迁移 `032_chat_sessions.sql`（三表、CHECK/FK/级联/索引）+ receipt顺序与约束单测；既有受信任迁移目录五个回执升级为六个，保留0010/002/010/030/031原样。#82用户批准追加032以避免020插入破坏既有数据库连续前缀；验证冷启动、旧库升级/重开及失败原子性。
- [ ] 3.2 `server/src/sessions/store.ts`：会话/消息/步骤读写（创建、按 owner 列表、消息树读取、prompt 受理事务、2s/2KB 进行中刷盘与回合收尾落盘、`stream_epoch` 递增、标题截取、**启动对账** running→failed）+ 对 `:memory:` 单测（含对账场景）
- [ ] 3.3 `server/src/sessions/events.ts`：omp 帧 → 归一化事件映射（过滤表、detail 摘要、`message_end.stopReason` 失败记忆、`agent_end` 终态判定、异常退出判定）纯函数 + 单测
- [ ] 3.4 `server/src/sessions/tokens.ts`：`TokenRegistry`（登记/查找/注销，64 hex）+ 单测
- [ ] 3.5 `server/src/sessions/rest.ts`：四 REST 端点对 **stub supervisor**（隔离 404、400/409/502 分支、202 受理、done/failed 可再 prompt）+ `app.inject()` 单测
- [ ] 3.6 `server/src/sessions/supervisor.ts` + `index.ts`：`SessionSupervisor`（sessionId→runtime、token 登记、崩溃上报→store）与 `registerSessions(app,deps)`（挂 REST；SSE 由 4.2 挂入同一函数）+ 对 1.2 假子进程的端到端回合单测（正常回合落盘、回合中崩溃与 `--resume`、缺 sessionFile 冷启动、上游错误 failed）
- [ ] 3.7 `app.ts` 装配顺序（model-proxy → sessions）+ `server.ts` 新配置项解析与负向校验 + `STARTUP_MODULES` + 配置单测（`server-config.test.ts` 面）
- [ ] 3.8 `server.ts` 启动期：监听后推导 `proxyBaseUrl` 并写 models.yml、关停时先回收全部 runtime 再关 listener/DB、以哨兵 `MODEL_UPSTREAM_API_KEY` + 1.2 假子进程 call-proxy 模式 + 进程内假上游完成一次经代理的 prompt 后断言 stdout/stderr 不含哨兵与任何 `WORKBUDDY_MODEL_TOKEN` 值 + 真实 listen/close 集成测试（`server-startup-order.test.ts` 面）

Suggested fixture level: expanded - 回合状态机 + 落盘 + 子进程编排是本 change 的决策密集核心，且触碰 Critical Path（spawn/回收）
Minimal mergeable slice: 3.1 迁移单独可合并保绿（独立 SQL + 形态测试；迁移由 openDb 自动执行故非死代码）；3.3、3.4 纯逻辑各自独立可合并；3.2 依赖 3.1；3.5 依赖 3.2、3.4、2.2；3.6 依赖 3.5 与组 1；3.7 依赖 2.3、3.6；3.8 依赖 3.7、2.4

## 4. chat-stream

- [ ] 4.1 `server/src/sessions/stream/ring-buffer.ts`：每会话环形缓冲（1000 条、epoch/seq id、`Last-Event-ID` 解析、三类入口判定：回放/缺口/刷新中从 `turn.start` 重放）纯逻辑 + 单测
- [ ] 4.2 `server/src/sessions/stream/sse.ts` + 挂入 `registerSessions`：`GET /api/sessions/:id/events`（头部、帧格式、keepalive 可注入计时、多订阅扇出、断开清理、404 先于任何帧）+ `app.inject()` raw stream 单测（断线回放/缺口/刷新中重放/双订阅）+ 对完整装配 app 断言该路由存在

Suggested fixture level: compact - 缓冲与 SSE 是纯协议面，inject 单 seam 可证；不触 Critical Path
Minimal mergeable slice: 4.1 环形缓冲单独可合并保绿（纯逻辑+测试）；4.2 依赖 4.1、3.6

## 5. chat-web

- [ ] 5.1 `web/src/lib/api.ts` 增四方法与 409/502 解析 + 单测
- [ ] 5.2 `web/src/features/chat/stream.ts`：`applyChatEvent` 纯归约器（含 `turn.start` 重置、`error` 文案）+ `connectSessionEvents`（注入 `EventSourceCtor`、`replay.gap` 重载、关闭时机）+ 单测
- [ ] 5.3 `web/src/features/chat/page.tsx` + 路由接线（`/` 换为 ChatPage、`routeManifest` 描述更新、`?session=` 参数、**同步更新 `web/test/routes.test.tsx` 对 `/` 的占位断言**）：列表/新建/composer/消息区/步骤卡/状态徽章/错误内联 + jsdom 测试（mock fetch + 假 EventSource 一次流式对话、刷新恢复、错误提示）

Suggested fixture level: compact - 纯前端展示与归约，jsdom 单 seam；服务端契约以 spec 信封与事件集为 oracle（mock）
Minimal mergeable slice: 5.1 api 扩展单独可合并保绿（四方法有配对测试即非死代码——knip 以测试 import 计）；5.2 归约器与连接器独立可合并；5.3 依赖 5.1、5.2

## 6. chat-harness

- [ ] 6.1 Makefile：`smoke-live`（env 门禁；对 `chat.hurl` 传形状档变量 `content_pattern='^.+$'`/`min_bash_steps=0`）目标 + `.PHONY`/头注释同步（不动 `make smoke` 文件列表）；`scripts/test-ci-harness.sh` 控制面 oracle 同 PR 扩展——`smoke-live` 进入受保护目标集（recipe 精确形状 + `smoke-live :` duplicate mutation 必红、`.PHONY` 锚点更新），`make test-guardrails` 绿
- [ ] 6.2 CI：`make omp-fetch`（无 cache action，不新增第三方 action）、假上游启动脚本（`.github/scripts/ci-fake-upstream.sh`）、smoke/ui-walk job env 与顺序；`inspect-ci-workflow.js` 四 action 白名单与计数不变；同 PR 内 `smoke/chat.hurl` 落地（`content_pattern`/`min_bash_steps` 两变量）并以精确档变量纳入 `make smoke`（先起假上游再纳入，CI 不出现红窗口）；`scripts/test-ci-harness.sh` 的 workflow 精确形状（smoke/ui-walk job 步骤与 env 元组）、`make smoke` recipe 期望行（三文件 + 两变量）、`ci-compiled-server.sh`/新脚本锚点同 PR 更新，`make test-guardrails` 绿；本地以真实 v18.0.10 + 假上游跑 `make smoke` 绿
- [ ] 6.3 `web/e2e/ui-walk.spec.ts` 增对话步骤（新建、发送、步骤卡、回合中刷新续流、正文、回合后刷新完整、console error oracle 不变）；本地与 CI `make ui-walk` 绿
- [ ] 6.4 控制面三处同步：AGENTS.md 验证矩阵（`omp-fetch`/`smoke-live` 两行）与 Directory Map、`constraints.yaml verification.surfaces` 两条与 `downgrades` 一条（S0b 同 uid 窗口内 `/proc` 凭证读取向量，ADR-0010 于 S1a 关闭）、Makefile 头注释；`scripts/test-ci-harness.sh` 的 AGENTS 行、`verification.surfaces` 期望元组（八→十）与 `wanted` 同 PR 更新，三处命令字面比对由该 oracle 机械执行，`make test-guardrails` 绿

Suggested fixture level: none - harness 自身即验证物；CI 接线以 workflow 全绿为证
Minimal mergeable slice: 6.1 `smoke-live` + Makefile 同步单独可合并保绿（只加目标 + oracle 同步，不改既有 smoke 文件列表，CI 不受影响）；6.2 是 CI 假上游 + `chat.hurl` 的原子一刀（hurl 用例进入 `make smoke` 与 CI 起假上游必须同 PR，否则 CI 红）；6.3 依赖 6.2；6.4 依赖 6.1、6.2（命令面定稿后同步）
