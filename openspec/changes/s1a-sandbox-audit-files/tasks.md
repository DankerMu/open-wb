# Tasks: s1a-sandbox-audit-files

> 执行序按依赖排列；TDD：每条实现任务先写失败测试再实现。组 1/2 可并行且不依赖 S0b；组 3 依赖 1、2 与 S0b 的 #84（七码基线）/#101（配置 seam 与 `STARTUP_MODULES` 基线）/#102（启动期 `agent` 目录）；组 4 的 jsdom 单测可对 REST 契约 mock 并行开工，但 4.3 合并需 3.5/3.6 先落地（`/files` 真实页对编译服务发请求，否则 `make ui-walk` 红）；组 5 依赖 1 与 S0b 的 #85/#87/#96/#101/#105；组 6 依赖 3、4、5 与 S0b 的 #107。本地持久化 `var/dev.db` 若迁移落地顺序与文件序不一致（`030/031` 先于 `020`），删库重建。凡触碰 Makefile/CI/AGENTS/constraints 的任务，`scripts/test-ci-harness.sh`（精确形状 oracle）与 `scripts/inspect-ci-workflow.js` 的期望**同 PR 更新**。

> Epic #111 人工验收例外（2026-09-19 用户决定）：#112 人工白盒审查通过；后续子 issue 保留独立代理审核与 CI 门禁，不再逐项等待人工审查，人工对 Epic 最终功能完整验收。仅适用于本 Epic，不修改全仓默认规则。记录：https://github.com/DankerMu/open-wb/issues/111#issuecomment-5741112841

## 1. sandbox-core

- [x] 1.1 `server/src/core/sandbox/resolve.ts`：`resolve(root, relPath, op)` 纯函数（NUL/绝对/`..`/边界前缀/逐分量 lstat 拒绝 symlink/mkdir 末段规则）+ 临时目录逃逸向量集单测（含 `/a` vs `/ab`、悬空 symlink、symlink 目录下子路径）（#112 / PR #138）
- [x] 1.2 `server/src/core/sandbox/dirs.ts`：`ensureSharedDir(absPath)`（递归创建、仅新建分量 `chmod 0o2770`、不 chown、不动 umask）+ mode 位单测（新建 `0o2770`、既有 `0o755` 不变、幂等）（#113 / PR #142）
- [x] 1.3 `server/src/core/sandbox/index.ts`：`createSandbox({rootOf, audit})` 同步 facade（`rootOf` null → `not_found`；拒绝先完成 canonical number-returning `emit(sandbox.reject)` 再抛 `sandbox_denied`；审计/lookup 异常原样传播、不放行）+ stub 端口/真实 resolver 与 symlink 单测；#123 / PR #179，CI35531687024 全绿，真实 HTTP/落库仍待 #127。

Suggested fixture level: expanded - 沙箱 resolve 是 AGENTS.md 白盒 Critical Path（不变量 3），逃逸向量集必须以真实文件系统（临时目录 + 真 symlink）证明，不可 mock
Minimal mergeable slice: 1.1 `resolve` 纯函数单独可合并保绿（无依赖、自带向量集测试）；1.2 独立可合并（纯 fs 工具）；1.3 依赖 1.1、1.2、2.2 的 canonical 同步 `emit` 签名及 3.1 的 sandbox_denied；不使用占位类型或重复事件模型。
Archive coordination: 主 `sandbox-core` 已晋升 resolver、dirs 与同步 facade；父 change 最终归档须去重，保留 null-root 前置/no-audit、审计完成后拒绝及原异常传播。#125 实现 owner-scoped rootOf；#127 验证真实 DB/HTTP403/404/500；#128 绑定 `(event) => emit(db,event)`。不得把 stub 调用证明扩大为授权/持久化/HTTP 证明，不恢复 void/async 歧义端口。

## 2. audit-core

- [x] 2.1 迁移 `030_audit_events.sql`（表/CHECK/索引/两只追加触发器）+ 形态与触发器单测；受信任迁移目录计数断言随之 +1（#114 / PR #146）
- [x] 2.2 `server/src/core/audit/index.ts`：`emit`/`query`（角色过滤、`limit` 1..200、`before` 游标、`detail` JSON 往返）+ `:memory:` 单测；用户批准 #122 同步将唯一 `HttpError`/错误码/消息迁至 `core/errors`，HTTP 状态/信封仍归 http，调用方原子迁移无旧转发导出（comment5748746011）。PR #163 已合并，CI35504605570 全绿。
- [x] 2.3 `server/src/accounts/index.ts`：`registerAccounts(app,{db})` 挂 `GET /api/audit`（guard 后、`no-store`、400 分支）+ `app.inject()` 单测（成员/管理员两账号）；#124 / PR #167 已合并，CI35509431982 全绿。生产 app.ts 装配仍属 #128。

Suggested fixture level: 2.2 expanded（#122 覆盖持久化写入、角色过滤与用户批准的公共错误迁移）；其余按各子 issue 风险分级。触发器由迁移测试证明，查询由真实 `:memory:` 证明，HTTP 行为由既有 inject 错误测试回归。
Minimal mergeable slice: 2.1 迁移单独可合并保绿（独立 SQL + 形态测试，由 openDb 自动执行故非死代码）；2.2 依赖 2.1；2.3 依赖 2.2
Archive coordination: 主 `audit-core` 已晋升 2.1 schema、2.2 emit/query（含默认50的可观测分页、精确大游标及原生数字解码错误边界）及 2.3 accounts 只读端点（含早期401/400/500的no-store、标量参数与未舍入游标）；主 `http-service-skeleton` 已晋升公共错误归 core。父 change 最终归档须去重并保留已验收语义，不得用旧版较弱要求覆盖。生产装配已由 #128 接入，测试不再在 createApp 上重复注册模块。

## 3. workspaces

- [x] 3.1 `server/src/core/errors/index.ts` 消息/错误码与 `server/src/http/errors.ts` 状态映射（依赖 S0b #84 的七码基线；#122 已批准公共错误归 core）：七码 → 十一码（`sandbox_denied`/`conflict`/`preview_too_large`/`preview_unsupported`）+ HTTP 层 `CONTENT_PARSER_OWNED_ROUTES` 增 `POST /api/workspaces`、`POST /api/workspaces/:id/dirs` + 既有信封测试扩为十一码与归属路由 400 断言；#115 / PR #173 已合并，CI35520629741 全绿。
- [x] 3.2 迁移 `031_workspaces.sql`（双唯一、`dir` CHECK）+ 形态单测；受信任迁移目录计数断言随之 +1（#116 / PR #151；schema-only slice 已归档，目录根行为仍待 3.3）
- [x] 3.3 `server/src/workspaces/store.ts`：owner-scoped列表/rootOf与同步创建事务、精确dir派生/Unicode scalar身份校验、INSERT-only conflict、惰性根/采用目录、同DB审计、失败回滚及逆序空目录补偿；ROLLBACK失败（含undefined）仍补偿并保留AggregateError/活动事务残留。#125 / PR #184，最终CI35545126599全绿；真实DB/FS/facade smoke已验，后续HTTP/装配交付见3.5/3.6。
- [x] 3.4 `server/src/workspaces/tree.ts` + `preview.ts`：单层列举（目录优先、字节序、跳过 symlink/特殊文件）与预览判定/流式读取（扩展名集合、`text/plain` + `nosniff`、1 MiB 截断头、图片 10 MiB 上限）纯函数 + 临时目录单测；#117 / PR #175，CI35527764996 全绿；helper-only slice 晋升，不含 REST/授权/装配。
- [x] 3.5 `server/src/workspaces/rest.ts` + `index.ts`：`registerWorkspaces(app,{store,sandbox,audit})` 五端点（列表/创建/tree/dirs/file；三条ID路由foreign/missing404、越界403+真实审计、409/413/415/400、早期no-store），真实createApp/DB/FS/facade/audit inject与localhost流中止/fd关闭验证；#127 / PR188，最终CI35561866604全绿。Canonicalstore由装配构造，生产接线已由3.6完成。
- [x] 3.6 #128 / PR223 mergedb457bb6，最终5ad2f29 CI35820697491全绿。app使用同一callerDB/runtime.sandboxRoot构造canonical store/bound audit/sync facade，sessions后注册workspaces→accounts；真实call-through顺序关联compiled七模块记录，owner根惰性。重复模块/临时同路径路由原子迁移，配置测试保持原合同；真实HTTP外账号管理员404/no audit、属主403/审计落库已验。

Suggested fixture level: expanded - 工作空间 REST 是沙箱边界的唯一 HTTP 暴露面（Critical Path），隔离/越界/审计联动须以完整装配 app + 真实临时目录证明
Minimal mergeable slice: 3.1 错误表扩展单独可合并保绿（既有 mapper 与测试侧真实 HTTP 路由证明，不导出私有 Set）；3.2 迁移独立可合并；3.4 纯函数依赖 3.1 的预览错误码；3.3 依赖 3.1、3.2、1.2、2.2；3.5 依赖 3.1、3.3、3.4、1.3；3.6 依赖 3.5、2.3、S0b #101/#102。1.3 facade 同样依赖 3.1 的 sandbox_denied（执行期补齐依赖）。
Archive coordination: 主 `http-service-skeleton` 的「统一错误信封」已晋升至十一码/六 owner，并保留 constructor-backed allowlist、FST_ERR_VALIDATION 排除、guard/fallback 与 route-owned cache 语义。S0b/S1a 父 change 最终归档不得用旧七码/较弱文本覆盖；生产 workspace 路由仍归 #127，装配归 #128。
Archive coordination: 主 `workspaces` 已晋升 schema 与单层列举/预览 helpers。父 change 最终归档保留 helper 的 UTF-8 字节序、生产 classifier headers/limit、原始字节上限与 canonical errors，不以旧组合需求覆盖；#127 仍负责先授权 resolve、缺失/非普通文件404、真实HTTP头/状态、原生错误路径脱敏与 client-abort 销毁流。helper 信任已授权路径和元数据，不声明 TOCTOU 防护。证据边界：精确1MiB/10MiB已测分类，整流不是独立阈值行；错误流测code+close，完成/提前destroy另测fd EBADF。
Archive coordination: 主 `workspaces` 晋升 #125 store/惰性目录事务；最终归档保留合法Unicode名称身份、孤立surrogate在mutation前bad_request、raw `(db,event)=>number`同连接audit、INSERT-only conflict、失败ROLLBACK仍补偿及可能活动事务/未提交行残留。部署base可信预置、稳定FS假设不扩大为TOCTOU或跨FS/SQLite崩溃原子性。
Archive coordination: #127 REST要求与sandbox-core ENOTDIR结构不存在修正已晋升；父归档须保留单一store注入、invalidpersistedroot500/validmissingroot404、原始path、早期no-store、native预览错误清头/中止释放、dirs审计失败可留目录，不以旧组合要求覆盖。#128 handoff comment5755547224；用户批准精确单行SAST误报注释，不扩大为规则/目录豁免。
Archive coordination: #128已晋升「服务启动与装配」及「Shared agent module assembly」七模块版本；S0b/S1a父最终归档须保留当前主规范timer上限、bearer优先鉴权、sticky failure/model-publication取消、#120/#126引用、同一root/DB绑定，不恢复旧五模块条款。历史parser与preview措辞由#225在父归档窗口去除，constructor-backed allowlist/401-before-parser/route-owned cache/字节阈值等语义不得变弱。#129消费真实API，#130仍负责部署夹具base预置与正式HTTP smoke。

## 4. files-web

- [x] 4.1 `web/src/lib/api.ts` 增六方法与 403/409/413/415 解析 + 单测（#118 / PR #153；API-only slice 已归档，页面及 Blob URL 生命周期消费已由 4.3 完成）
- [x] 4.2 `web/src/features/files/md-render.ts` + `csv.ts` + `preview.tsx`：移植 demo `mdRender`（先转义；链接 `href="#"`）、CSV 表格、行号代码表、图片、不支持/截断态纯组件与安全单测（#119 / PR #155；用户授权 64 层 strong 规范化，开发/生产 × StrictMode 深层生命周期已证明；切片已归档）
- [x] 4.3 #129 / PR229 merged daf018f，final4127d32 CI35846461252全绿；FilesPage/惰性树/ws恢复与非法replace/搜索切换器/两类新建/PreviewPane接线及既有路由/ui-walk断言原子更新。Provider会话绑定client支持并发/current401，跨同账号和跨账号续会话保持list-first；Blob替换/卸载/迟到释放；弹窗重开和连续目录刷新竞态闭环。305个web测试、真实HTTP浏览器截图/零非预期错误、既有ui-walk与长root几何oracle已验；expanded三席+一fixpass+fresh复核clean。正式新增Playwright流程仍属6.2。

Suggested fixture level: compact - 纯前端展示，jsdom 单 seam；服务端契约以 spec 信封与端点形状为 oracle（mock）
Minimal mergeable slice: 4.1 api 扩展单独可合并保绿（六方法配对测试即非死代码）；4.2 纯渲染组件独立可合并；4.3 依赖 4.1、4.2 且合并需 3.5/3.6 先落地
Archive coordination: `files-web` 已晋升 4.1 API、4.2 纯预览与 4.3 工作空间/树页面集成；父最终归档须去重旧组合新增项，保留唯一纯组件/64层规范化、caller-owned Blob释放、workspace模式重置/同文件刷新、会话代际/list-first与forced-refresh合同。`spa-shell` 本次只将/files接为真实页面并明确current/stale401边界，根路由仍依当前主规范；父chat阶段不得以旧重述覆盖新增认证合同。S0b/S1a父保持active。

## 5. omp-uid-isolation

- [x] 5.1 Canonical agent-config 的 OMP_USER → ompUser 经 server/supervisor/runtime/process 到所有冷启动/恢复代次；sudo 精确前缀与 env allowlist、unset direct 兼容、非法配置副作用前失败。用户批准仅 sudo 模式拒绝缺失/空/相对段 PATH，共享 config/spawn validator 保留合法 PATH 原字节。#120 / PR #215 merged 8cdfc02，最终 7bb80df 的 CI35806224549 全绿；参数/真实入口/HTTP/受控子进程证明，不宣称真实 uid/PAM 隔离。
- [x] 5.2 #126 / PR #220 merged1f08685，最终0997636的CI35815007490全绿。非memory DB在openDb前wx0600+fd修复/关闭，既有regular main/WAL/SHM0600；非文件位置失败且原模式/内容不变。spawn与早期models producer共同使用ensureSharedDir，新建2770、既有目录/DB父/umask不改。真实入口/FS/HTTP/SIGTERM、原生错误注入、隔离mutant与两轮静态审查完成；不宣称Linux uid隔离。
- [x] 5.3 `server/test/support/fake-omp.mjs` 增 `probe` 模式（prompt `probe:<pid>:<writePath>` → 先以自身 uid 写 `<writePath>`，再回 `uid=… gid=… env=<sorted keys> home=<$HOME> agent=<$PI_CODING_AGENT_DIR> environ=<EACCES|readable|errno> wrote=<ok|errno>` 的 `text_delta` + 正常 `agent_end`）+ 契约单测（依赖 S0b #87）；#121 / PR #161 已合并，Ubuntu 同 uid 契约通过。
- [x] 5.4 #131 / PR242 merged640d8bf；`server/test/linux/uid-isolation.test.ts`仅Linux且WORKBUDDY_UID_TEST=1运行，其他明示skip，opt-in缺OMP_USER失败。真实SessionRuntime/native sudo/default probe断言不同uid、六键subset/四预置键缺席、精确HOME/agent（空格/冒号）、EACCES、wrote及父tree/内容。Ubuntu24.04aarch64容器非root证明、七类semanticRED/恢复GREEN、清理与稳定性完成；普通CI35875641054的skip不是正式uidjob证明，5.5/5.6仍待办。首次实跑发现TMPDIR剥离，独立#239 / PR240+241已修正sudo非凭证赋值合同。
- [x] 5.5 #132 / PR257 finalba95ced merge8f6d033；PR CI35977941147与merged-master CI35978802687九项全绿（uid job107565512880）。15min正式uidjob、3SETENV规则/globalvisudo/精确HOME/有效共享组两阶段，未改#131的真实uid/proc断言1pass0skip，真实omp四文件绿（PR38请求、master40请求；chat轮询次数随运行变化）；可选OMP_USER及精确8direct/8checkout/6setup-node原子接线。Guardrails705PASS0FAIL；只TERMwrapper与leader7残留组均先RED后GREEN，boundedcleanup不碰sentinel。expanded三席+两fixpasses+fresh/integrationreview最终clean。保留#107控制面，Width exception: multi-path；5.6降级删除独立见下。
- [x] 5.6 #134 / PR264 head82b1b96 merge1591d51，CI35994736940九项成功。基于5.5已在master首绿删除唯一s0b_same_uid_credential_exposure，其他三条原样；AGENTS新增精确uid隔离block行、Knownblindspots无proc项。Oracle先RED→711green，review发现peersection伪owner，复现foreign0→修复1/restored0，九个sibling负控后720PASS0FAIL；anti-drift0，expanded三席+freshreview round2clean/1fixpass。不宣称生产部署认证或unsetOMP_USER隔离。

Suggested fixture level: expanded - 不变量4只能用真实子进程换uid及/proc EACCES证明；#131已提供独立Ubuntu容器验证，正式部署验收及downgrade关闭仍要求5.5的GitHub uid-isolation job首绿（Critical Path白盒）。
Minimal mergeable slice: 5.1 sudo 前缀 + 配置单独可合并保绿（参数捕获测试，不起进程；未设 `OMP_USER` 时零行为变化）；5.2 独立可合并（DB/目录权限位只依赖入口与 1.2）；5.3 假 omp 模式独立可合并（测试支撑）；5.4 依赖 5.1–5.3（本地 skipped 仍绿）；5.5 依赖 5.4、6.1（multi-path：CI 运行 + oracle）；5.6 依赖 5.5
Archive coordination: 5.3探针契约已晋升至`omp-test-harness`，5.4 Linux隔离证明已独立晋升至`omp-uid-isolation`；父最终归档去重这两项，保留默认probe、标签解析、严格opt-in、真实uid/proc/secret/write/readback与失败清理，不以旧组合文本覆盖。正式CI job仍由5.5实现，不因容器证据提前关downgrade。
Archive coordination: #120配置/sudo与unsafe-PATH、#126私有状态、#239非凭证TMPDIR赋值已晋升；父归档保留完整ompUser链路/sudo-only安全PATH、TMPDIR已定义含空值时在sudo --前单元素赋值且凭证不上argv、before-open600、nonregular失败不改模式、新建2770而既有目录不改、不改umask/DB父0700。#131证明受控容器边界，#132继续证明GitHub runner与真实omp；部署负责组归属，stat/chmod TOCTOU不在可信路径合同内。
Archive coordination: #132正式job与verification-harness完整CI/Node24八job矩阵已选择性晋升；父最终归档保留#107十surface/四target/降级登记及后续#134关闭、#135文案，不以旧MODIFIED块覆盖。merged-master正式job已首绿，但部署认证不由CI代替；换uid后的子进程组清理及primary7/cancel143规则不可退化。
Archive coordination: #134已晋升UID降级关闭条款，并以完整当前CI/chat控制面requirement替换S0b必须登记义务；保留三条其他downgrades、十surface、八job矩阵。父归档不能重新要求已关闭登记；master40/PR38为各运行轮询计数，不是固定验收阈值。

## 6. files-harness

- [x] 6.1 #130 / PR253 merged7e00c26，finald79a5740，CI35957055888全8green。tracked md/两行csv/合法PNG + 独立files.hurl16请求：创建201/409、列表取唯一id、重复mkdir409、越界403与相对请求前快照的新关联审计、精确预览字节、他账号404/双logout。四文件smoke同服务DBsandbox连跑两次各38请求绿，standalone绿、0auth行；共享CIhelper两模式启动前预置，guardrails576PASS/0FAIL，三席clean。Width exception: multi-path；按profile smoke/CI触发expanded，不含6.2浏览器步骤/5.5uidjob/6.3控制面。
- [x] 6.2 #133 / PR262 headc364a95 merge9ebb3e7，CI35984311706九项全绿，fresh UI job107583281945完整1passed6.2s。四路由后/heldchat前真实UI选择或创建smoke-fixture、实际三文件、精确Markdown标题/编号源码与CSV两行、rootwalk-out创建、reload同ws/空间/树；原exact2auth/me401与errororacle保留。本地wrongfixture精确heading RED→恢复fullGREEN4.8s并覆盖已有空间选择；四截图零非预期错误。expanded三席clean0fixpasses；无产品/config/fixture改变。
- [x] 6.3 #135 / PR266 head9c24759 merge6bb6965，CI35998719618九项成功。AGENTS smoke目录描述增加沙箱夹具，HTTP evidence明确public/auth/chat/files四文件；server行已含沙箱/审计/工作空间/对话而保持原样，UI行/命令/十surface/UIDblock/三downgrade不变。精确oracle literal及全部wrap/peersection数据同PR更新；语义RED→722PASS0FAIL，anti-drift0/size798；机械证明parser/helper逻辑未变。nonefixture独立PASS，无新增运行时风险。

Suggested fixture level: none - harness 自身即验证物；CI 接线以 workflow 全绿为证
Minimal mergeable slice: 6.1 是夹具 + `files.hurl` + `make smoke` 四文件 + CI 预置的原子一刀（hurl 用例进入 `make smoke` 与 CI 预置夹具必须同 PR，否则 CI 红）；6.2 依赖 6.1；6.3 依赖 6.1、6.2
Archive coordination: files-harness「沙箱夹具与 files.hurl」已独立晋升，父最终归档去重并保留pre/post审计freshness，不能退回只看上一条kind。verification-harness四文件/两模式共享prelaunch预置建立在#105已晋升的真实omp+假上游/PGID清理完整合同上；保留其所有场景和后续控制面强化，不用旧父组合块覆盖。S0b/S1a父保持active。
Archive coordination: #133 files-harness「走查 /files 步骤」和完整当前canonical UI requirement已独立晋升；父最终归档保留真实heldchat/recovery场景、exact2auth/me401、caller freshsandbox且walk-out不存在、精确preview数据、实际根内容ready及同ws重载，不用旧父简版替换。#135仍负责控制面文案。
Archive coordination: #135 files-harness「控制面与 oracle 同步」和当前完整CI requirement已晋升；全部24子issue均已实现，父最终归档须逐条核对canonical覆盖后只归档历史协调包，不能重放旧delta覆盖后续安全、harness或状态契约。最终人工功能验收仍属于用户。
