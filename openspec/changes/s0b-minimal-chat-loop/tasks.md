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

- [x] 3.1 #82/PR186 merged：`032_chat_sessions.sql`三表、CHECK/FK/级联/两查询索引；五→六回执，旧0010/002/010/030/031与业务数据不变。用户批准032追加以避免020插入破坏旧库；215相关/973服务端测试、真实升级/重开/回滚恢复与21错误候选检验通过；三席首轮clean，同SHA CI全绿。SQLite affinity预期修订、受影响auth目录断言及合成token扫描修复均留痕。
- [x] 3.2 #97/PR189 merged：owner隔离读写、原子受理/未进展补偿、独立epoch/resume、2048 UTF-8字节/首增量2000ms刷盘、步骤/终态/close失败恢复及三表显式启动对账。21聚焦/1021服务端测试、19错误变体及恢复稳定性检验通过；一步骤进度覆盖缺口经fix pass1闭环，复审clean、同SHA CI全绿。trusted metadata错误语义后续#190；REST/runtime装配仍由3.5–3.8承担。
- [x] 3.3 #83/PR194 merged：纯createEventState/applyFrame/applyFailure，工具/request关联、ACK/噪声过滤、120Unicode codepoint摘要、首失败记忆和终态一次。12聚焦/1054服务端测试、20错误变体及恢复稳定性检验通过；三席首轮clean、同SHA CI全绿。内部toolCallId→DB ID、runtime requestId接缝及local-only完成由3.6/#100负责，未宣称装配完成；oracle-plan可见性偏离与冻结后holdout留痕。
- [x] 3.4 #90/PR196 merged：TokenRegistry 原生32字节随机凭证、64位小写hex、精确查找、原子轮换、索引撤销、实例/会话隔离和熵/碰撞失败保留授权。8聚焦/1062服务端测试、真实HTTP代理与12错误变体及恢复稳定性检验通过；三席首轮clean、同SHA CI全绿。共享实例注入与运行时装配仍由3.6–3.8/#100/#101承担。
- [x] 3.5 #99/PR201 merged：四REST端点对stub supervisor，owner隔离404、401/parser优先级、UTF8语义限制、202受理与pending并发409、502/未知错误补偿、补偿失败不掩盖、done/failed再受理。13聚焦/1094服务端测试、真实HTTP+SQLite与12错误变体/恢复稳定性通过；三席首轮clean，同SHA CI全绿。NUL缺陷经用户批准先行#198/PR199修复、PR200归档后恢复原oracle；无输入限制弱化。真实runtime/SSE/startup装配仍由3.6–3.8承担。
- [x] 3.6 #100/PR203 merged：Supervisor真实runtime→mapper→store编排、独立write-dispatch receipt、generation epoch/token归属、numeric step落盘先于发布、崩溃残量/resume与local-only完成、通用基础设施故障回收、registerSessions对账/REST/preClose。28新增/1122服务端测试、19真实边界场景及恢复稳定性、7mutants/2历史publication反例和额外ordinal mutant qualification通过。三席review经fixpass1补ordinal覆盖，fresh复审clean、同SHA CI全绿。用户授权一次超三轮静态修复后零clone；#204同步sink接线前契约/#205旧failedspawn回收延迟另跟踪。全局配置/SSE/启动仍由后续issue承担。
- [x] 3.7 #101/PR207 merged：11键纯配置、entry-root路径、缺省/半对上游合法、用户批准OMP_IDLE_MS1..2147483647超限启动失败；真实auth→guard→proxy→sessions、共享registry/启动对账/typed handles、five-module记录。60files/1123tests及零clone静态门禁通过；8真实边界+9mutants，review补stickyfailure信号竞态和完整entry上游接线2probe/3mutants均经恢复稳定性验证。三席review经fixpass1证据补全，fresh复审clean、同SHA CI全绿。旧source-text测试删除，实际compiled证据替代，无依赖/阈值放宽；models.yml/fullsignal仍由3.8负责。
- [x] 3.8 #102/PR209 merged：实际listen→可连接proxyBaseUrl/models.yml→成功记录；pending/bound信号分流、重复信号与runtime原生exit→listener close→DB close。61files/1125tests与静态门禁通过；完整fake call-proxy→真实本地upstream→SQLite done/精确文本、实际两种凭证无输出泄漏及取消/写失败/cleanup失败等九项真实入口复验通过；4可达mutants RED/恢复GREEN、7stability通过。三席首轮clean、同SHA CI八项全绿；无效初版observer与TDD顺序偏离留痕；#210跟踪held-write取消永久CI回归。SSE/浏览器/真实omp发布仍未完成。

Suggested fixture level: expanded - 回合状态机 + 落盘 + 子进程编排是本 change 的决策密集核心，且触碰 Critical Path（spawn/回收）
Minimal mergeable slice: 3.1 迁移单独可合并保绿（独立 SQL + 形态测试；迁移由 openDb 自动执行故非死代码）；3.3、3.4 纯逻辑各自独立可合并；3.2 依赖 3.1；3.5 依赖 3.2、3.4、2.2；3.6 依赖 3.5 与组 1；3.7 依赖 2.3、3.6；3.8 依赖 3.7、2.4

## 4. chat-stream

- [x] 4.1 #91/PR212 merged：固定1000条epoch/seq环形缓冲、canonical安全整数cursor、replay/gap/fresh、当前active turn.start刷新与snapshot隔离。用户确认min−1边界：保留2..1001时cursor1回放，cursor0 gap；1002条后cursor1 gap。13新增/1138服务端测试、独立compiled5cases及6400push/4046check多轮wrap、4候选mutants RED/恢复稳定性通过；compact首轮clean、同SHA CI八项全绿。SETUP/已GREEN的TDD偏离与alias测试修订留痕；SSE接线见4.2/#103，epoch实例归属/排空封口已由#214补齐。
- [x] 4.2 #103 本地实现与验收完成，源码review/CI及独立归档门禁见 s0b-session-sse：真实owner GET events200、立即HTTP头、canonical帧/空id gap、同步ring订阅回放、双订阅、15s heartbeat与断开隔离；初始回放背压drain续传、实时背压断开重连、物理响应所有权与late-attach关闭。68files/1207tests，7真实/受控边界case、11错误候选RED/恢复GREEN、9稳定性和22条204/214兼容probe通过。首轮review经fixpass1补heartbeat失败覆盖、修复attach前断开，并保护正常请求体读取完成不被误判为连接断开。generation ring/快照封口由#214提供，不新增计数器；浏览器消费仍归5.x。

Suggested fixture level: 4.1 compact；4.2 expanded — #204/#214后的真实HTTP、generation排空、背压与preClose跨层状态机；inject单面不足，需原生/真实TCP证据与白盒agent审查。
Minimal mergeable slice: 4.1 环形缓冲单独可合并保绿（纯逻辑+测试）；4.2 依赖4.1、3.6及已合并的#204/#214，端点与实际装配/生命周期原子交付。

## 5. chat-web

- [x] 5.1 #92/PR234 实现并经 PR238 独立归档：四个类型化 API、完整正文与 nullable streamCursor、原有401/错误合同；101新增API测试，最终web17files/406tests，全套静态/类型/build/drift及源码与归档各自CI八项通过。round2 clean、1fixpass，空列表/空title错误候选已验证；源码最终仅API/配对测试/fixture，上游#233/#237的CI修复原样集成。
- [x] 5.2 #93/PR245 merged：纯归约器、注入式EventSource、每次open/gap全快照恢复、1000事件FIFO与游标/关闭/替代fence。28新增/434web测试，6纯函数与14受控协议case、8错误候选RED/恢复GREEN；真实Chromium同realm/foreignrealm恢复和稳定性通过，精确正文/原生重连/游标重置/零错误与订阅回收。三席首轮后补2证据缺口，round2 clean、1fixpass，同SHA CI八项全绿。独立归档交付仍由当前workflow gate管理；产品页面与logout/unmount接线属于5.3。
- [x] 5.3 #104/PR247 merged：根会话页与路由原子接线，左右列表/消息区、步骤三态、完整正文、输入/错误、查询恢复及账号/请求/连接所有权。24新增/458web测试；真实构建页面Chromium+HTTP/SQLite/native fake验证运行中/终态刷新、两次发送、新建/Back、离页/退出、零浏览器错误。历史/故障候选与晚到404/401副作用拒绝证明、恢复与稳定性均通过。三轮review、2fixpasses后clean，同SHA CI八项成功；独立归档门禁仍由workflow管理。真实omp18与永久对话走查见6.2/6.3。

Suggested fixture level: 5.1 expanded（公共API/parser，已归档）；5.2 expanded（#214异步恢复/ordering/lifecycle及已复现首次REST→SSE窗口）；5.3 按页面/认证/路由影响评估，不以纯jsdom单面代替真实边界。
Minimal mergeable slice: 5.1 api 扩展单独可合并保绿（四方法有配对测试即非死代码——knip 以测试 import 计）；5.2 归约器与连接器独立可合并；5.3 依赖 5.1、5.2

## 6. chat-harness

- [x] 6.1 Makefile：`smoke-live` env 门禁、原样变量和 PATH-only Hurl 形状档调用、`.PHONY`/头注释与精确 recipe/重复目标 oracle；原 `make smoke` 不变。#94 / PR #249 已合并（30f4f7941135959c6ad4aaeea41829f30122b984），十项命令边界验证及487项守卫通过，源代码 CI 35921350985 八项通过。独立规范归档另走 PR/CI；此项不声称真实 Hurl 对话已通过，`chat.hurl` 属于 #105。
- [x] 6.2 #105 / PR#251 已原子交付verified omp-fetch、job-owned假上游、smoke/ui-walk runtime env、三文件chat.hurl/精确变量与全部oracle；四action矩阵不变，secrets禁令按用户确认仅两个harness jobs。真实18.0.10本地smoke两次各22请求、独立chat10请求、原UI1/1通过；最终守卫563PASS，真实抗终止omp/app及独立child identity反例闭环。源合并99056cf6a0d6827fa273dc9ce96140c47b25364d；review round3 clean/2fixpasses；CI35950807791八项通过，Ubuntu两job实际下载校验Linux18.0.10。独立归档另走PR/CI，#106对话UI与#107控制面仍待交付。
- [x] 6.3 #106/PR255交付真实回合中reload原生续流与完成后reload；用户批准existing测试上游UUID gate扩展。post-open running恢复完成后release，期间禁止REST代替suffix；屏蔽真实text.delta与注入consoleerror反例均RED、恢复GREEN，保留exact两次401。38项fixture/legacy通过，真实本地UI反复通过，CI35960180481八项通过含Linux18.0.10UI1passed6.4s；round2clean/1fixpass。源合并36ef3245bf2d6c618a307656b1e5819d95d7dd8d，独立归档另走PR/CI。
- [x] 6.4 #107/PR258：AGENTS 验证矩阵/Enforcement/Directory、constraints 十个 surfaces 与 S0b 同 uid 风险账本、Make 页头及 oracle 同步；不改 recipes/CI/产品/阈值。隐藏整节 Markdown 与错误 foreign-owner mutant 已闭环，round2 clean/1fixpass；26+611守卫与22独立mutants通过，源head0a73d9a8cbf76824d8f4dab851dad40552852b87 CI35969664073八项成功。独立规范归档另走PR/CI；不声称真实模型或UID隔离已验证。

Suggested fixture level: none - harness 自身即验证物；CI 接线以 workflow 全绿为证
Minimal mergeable slice: 6.1 `smoke-live` + Makefile 同步单独可合并保绿（只加目标 + oracle 同步，不改既有 smoke 文件列表，CI 不受影响）；6.2 是 CI 假上游 + `chat.hurl` 的原子一刀（hurl 用例进入 `make smoke` 与 CI 起假上游必须同 PR，否则 CI 红）；6.3 依赖 6.2；6.4 依赖 6.1、6.2（命令面定稿后同步）
