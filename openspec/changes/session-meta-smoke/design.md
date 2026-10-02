# Design: session-meta-smoke（#539）

## Context
- `Makefile:62-64`：`smoke` 目标两行配方；第二行以 `… --variable "skip_turn_control=false" smoke/public.hurl smoke/auth.hurl smoke/chat.hurl smoke/files.hurl` 结尾。`smoke-live`（`:95-99`）只跑 `smoke/chat.hurl`。
- `AGENTS.md:89`：`| HTTP smoke | Hurl（调用方拥有已运行服务） | `make smoke` | 退出码 0；public.hurl、auth.hurl、chat.hurl、files.hurl 四文件真实 HTTP 断言全绿 |`。
- `scripts/test-ci-harness.sh`（894 行，由 `scripts/test-guardrails.sh:157` 调用，即 `make test-guardrails`）：`contract()`（`:92`）内嵌的 Python 用 `recipes("smoke", [...])` 精确钉两行配方、用 `one(matrix_rows, "| HTTP smoke | …")` 精确钉证据行；`cm "<标签>" <文件> '<查找串>' '<替换串>'` 在副本上做一次替换后要求 `contract()` 拒绝；辅助 `ed`（`:113`）在查找串出现次数 ≠ 1 时 `exit 2`，该条记 FAIL。含旧文件列表或旧证据行的行：`:92`、`:121`、`:122`、`:123`、`:126`、`:141`、`:145`、`:152`、`:169`（行很长，一行多条 `cm`）。
- 既有 Hurl 文件的写法：`smoke/files.hurl:9-32`（登录、201|409 创建或采用、按唯一名称取 id）、`:57-79`（`GET /api/audit?limit=1`，`$.events[0].kind/actorId/workspaceId/detail.*`）、`smoke/chat.hurl:27-74`（prompt 202、审批轮询 `retry: 40` × 500ms、作答 allow、done 轮询 `retry: 180` × 500ms）、`:305-311`（`lisi` 登录，Principal `{"id":"u3","account":"lisi","role":"管理员"}`）。
- 服务端事实（都已在 master）：
  - `POST /api/sessions`（`server/src/sessions/rest-metadata.ts:73-88`）：无 body → `{}`；`workspaceId` 给出但 `workspaceRootOf(本人, id)` 为 null → 404 `not_found`（他人空间与未知空间不可区分）；多余键 → 400 `bad_request`。成功返回八键 DTO（`store-metadata.ts:106-115`）。
  - 审计：只有绑定创建写 `session.bind`（`store-metadata.ts:97-103`，`workspaceId` + `detail:{sessionId, scene}`），与插入同事务；被拒的创建与无绑定的创建不写。删除写 `session.delete`（`:154-160`，`detail:{sessionId, ompSessionFile, messageCount}`），与删除同事务——响应返回时审计行已提交。审批作答另写 `session.approval`（在绑定与删除之间，不影响两处「最新一条」的断言）。
  - PATCH（`rest-metadata.ts:89-112`）：属主校验在解析 body 之前；多余键 400。DELETE：属主不符 404。
  - 假上游（`server/test/support/fake-upstream.mjs:9-13`、`:419`）：最后一条 user 文本含 `WORKBUDDY_THINK` 时正文轮先发三个 `reasoning_content` 分片（拼接为 `先读需求，再列要点，最后作答。`）；首轮工具是 bash `echo workbuddy-smoke`，在 `--approval-mode write` 下产生一条待审批。
  - 错误信封：`{"error":{"code":"not_found","message":"请求的资源不存在"}}`、`{"error":{"code":"bad_request","message":"请求格式不正确"}}`。
- CI：`smoke` job 与 `uid-isolation` job 都经 `.github/scripts/ci-compiled-server.sh smoke` 跑一遍 `make smoke`（全新 DB 与沙箱）。workflow 不改。

## Decisions

### D1 `smoke/session-meta.hurl`（新）
文件头注释按 `files.hurl` 的写法概述流程，并写明：只由 `make smoke` 运行、不用 `skip_turn_control`、第 6 步（slash 白名单）由后续 issue 追加。条目次序与断言（每条 POST/PATCH/DELETE 不带 `retry`；只有两条 messages GET 轮询带有界 `retry`）：

| # | 请求 | 断言 |
|---|---|---|
| 0a | `POST /api/auth/login` zhangsan | 200，cookie 形状，body 恰为 Principal `u1` |
| 0b | `POST /api/workspaces {"name":"smoke-sessions"}` | status ∈ {201, 409} |
| 0c | `GET /api/workspaces` | 该名称恰一条；捕获 `workspace_id` |
| 1a | `POST /api/sessions {"workspaceId":"{{workspace_id}}","scene":"code"}` | 201；`$.*` count == 8 且八个键逐个点名：`id` 为 32 位小写 hex、`title` null、`status` `idle`、`createdAt`/`updatedAt` 为整数、`scene` `code`、`workspaceId` == 捕获值、`pinnedAt` null；捕获 `session_id` |
| 1b | `GET /api/audit?limit=1` | `events` count == 1；`kind` `session.bind`、`actorId` `u1`、`workspaceId` == 捕获值、`detail.sessionId` == `session_id` |
| 2a | `POST /api/sessions {"workspaceId":"00000000000000000000000000000000","scene":"code"}` | 404，body 恰为 `not_found` 信封 |
| 2b | `POST /api/sessions {"scene":"code","color":"red"}` | 400，body 恰为 `bad_request` 信封 |
| 2c | `GET /api/audit?limit=1` | 仍是 `session.bind` 且 `detail.sessionId` == `session_id` |
| 2d | `POST /api/sessions`（无 body、无 Content-Type） | 201；`$.*` count == 8 且八个键逐个点名（`id` hex、`title` null、`status` `idle`、时间戳为整数、`pinnedAt` null）；`workspaceId` null、`scene` null；捕获 `other_id` |
| 3a | `PATCH /api/sessions/{{session_id}} {"title":"冒烟会话","scene":"design","pinned":true}` | 200；`$.*` count == 8 且八个键逐个点名：`id` == `session_id`、`status` `idle`、`createdAt`/`updatedAt` 为整数、`title` `冒烟会话`、`scene` `design`、`pinnedAt` 为整数、`workspaceId` == 捕获值 |
| 3b | `PATCH … {"color":"red"}` | 400 `bad_request` 信封 |
| 3c | `GET /api/sessions` | 200；`session_id` 那一条的 title/scene/`pinnedAt` 非 null/`workspaceId` |
| 3d | `PATCH … {"pinned":false}` | 200；`pinnedAt` null；`title` `冒烟会话`、`scene` `design` |
| 4a | `POST …/prompt {"message":"WORKBUDDY_THINK 会话元数据冒烟"}` | 202；捕获 `assistant_id` |
| 4b | messages GET，`retry: 40`、500ms | 该助手 `approvals` count == 1、`decision` null、`tool` `bash`；捕获 `approval_id` |
| 4c | `POST …/approvals/{{approval_id}} {"decision":"allow"}` | 200；`id`、`tool` `bash`、`decision` `allow` |
| 4d + 5 | messages GET，`retry: 180`、500ms | 助手 `status` `done`；`content` matches `{{content_pattern}}`；`thinking` == `先读需求，再列要点，最后作答。`；bash 步骤 `done`、无非 done 步骤；`approvals[0].decision` `allow`；`session.status` `done`；`session.title` == `冒烟会话` |
| 6a | `DELETE /api/sessions/{{session_id}}` | 204，body 空 |
| 6b | `GET /api/audit?limit=1` | `kind` `session.delete`、`actorId` `u1`、`detail.sessionId` == `session_id` |
| 6c | `GET /api/sessions/{{session_id}}/messages` | 404 信封 |
| 6d | `GET /api/sessions` | 200；不含 `session_id` |
| 6e | `DELETE /api/sessions/{{session_id}}` | 404 信封 |
| 7a | `POST /api/auth/logout` | 204 |
| 7b | login lisi | 200 Principal `u3` |
| 7b′ | `GET /api/sessions`（`lisi`） | 200；捕获 `lisi_session_count`（`$.sessions` 的条数；服务归调用方所有，不假定为 0） |
| 7c | `POST /api/sessions {"workspaceId":"{{workspace_id}}"}` | 404 信封 |
| 7d | `PATCH /api/sessions/{{other_id}} {"title":"x"}` | 404 信封 |
| 7e | `DELETE /api/sessions/{{other_id}}` | 404 信封 |
| 7e′ | `GET /api/sessions`（`lisi`） | 200；`$.sessions` 条数 == `lisi_session_count`（被拒的绑定创建没有留下会话行） |
| 7f | logout | 204 |
| 7g | login zhangsan | 200 |
| 7h | `GET /api/sessions/{{other_id}}/messages` | 200；`session.title` null（`lisi` 的 PATCH 没有生效） |
| 7i | `DELETE /api/sessions/{{other_id}}` | 204 |
| 7j | logout | 204 |

- 不引入新的 Hurl 变量：只用 `base_url` 与 `content_pattern`（配方已传）。配方传入的 `min_bash_steps`、`skip_turn_control` 本文件不引用（Hurl 允许未使用的变量）。
- 可重跑：0b 的 201|409；会话每次新建并在文件内删除；空间保留。
- `7h` 的 `session.title` null 是父文「the foreign attempts changed nothing」的可执行形式。
- 实际的 JSONPath 写法、信封断言用整 body 还是 `jsonpath`，由实现者按既有四个文件的惯例定；表里的断言语义是约束。实现者发现表中某条与服务端实际行为不符时停下来报告，不改断言去迁就。

### D2 `Makefile`
`:64` 末尾追加 ` smoke/session-meta.hurl`（一个空格 + 路径）。其余字节不变；`:60-62` 的注释、`smoke-live`、`.PHONY` 不动。

### D3 `AGENTS.md`
`:89` 改为：
```
| HTTP smoke | Hurl（调用方拥有已运行服务） | `make smoke` | 退出码 0；public.hurl、auth.hurl、chat.hurl、files.hurl、session-meta.hurl 五文件真实 HTTP 断言全绿 |
```
只此一行。`:50` 的 Directory Map `smoke/` 描述不动（「对话链路」已涵盖，且该句被 oracle 逐字钉住）。

### D4 `scripts/test-ci-harness.sh`
同步方法（两步，缺一不可）：
1. 先只改 Makefile 与 AGENTS.md，跑 `make test-guardrails`。FAIL 清单给出一部分同步项：基线不匹配，以及查找串在新文件里已不存在的 `cm`（AGENTS 族——证据行整行变了；`contract Make smoke export after target mutation`）。
2. **FAIL 清单不完备**：旧四文件串是新五文件串的前缀，Makefile 追加参数后，查找串以 `… smoke/chat.hurl smoke/files.hurl` 结尾的 Makefile 族变异仍恰好命中一次（已按字符串模拟确认：`Hurl connection`、`smoke whitespace duplicate`、`smoke protected-first multi-target`、`recipe comment`、`conditional`、`smoke min-bash-steps`、`smoke chat file`、`smoke four-file order`、`smoke drop files.hurl`），它们照旧 PASS，但其中一部分的候选是残缺的（实测真正变形的是 `whitespace duplicate`、`protected-first multi-target`、`conditional`，以及意图本就随文件数变化的 `chat file`、`drop files.hurl`、`four-file order`；`Hurl connection`、`recipe comment`、`min-bash-steps` 的替换串保留同样的后缀，候选等价，仍一并重定基）——例如 `whitespace duplicate` 会把 `\nsmoke :\n\t@true` 插在 `smoke/files.hurl` 与 ` smoke/session-meta.hurl` 之间，被拒的原因变成「配方行被截断」而不是「重复 header」。所以 Makefile 族按 issue 的标签清单加兜底 grep 逐条同步：脚本里每一处 `smoke/chat.hurl smoke/files.hurl`（以及单独出现的旧证据行）都要过一遍，查找串与替换串都换成以五文件配方为基础的写法。
3. 同步完成后做一次残留清点（证据 G5）：列出脚本里每一处**后面不跟** ` smoke/session-meta.hurl` 的 `smoke/chat.hurl smoke/files.hurl` 与每一处 `四文件`，逐处写明为什么留着（预期只剩：新增 1 与新增 4 的替换串、`stale HTTP evidence` 的替换串）。
- 基线：`recipes("smoke", [...])` 第二行与 `one(matrix_rows, "| HTTP smoke | …")` 改成 D2、D3 的新串。
- 既有变异：查找/替换串含旧文件列表或旧证据行的全部同步（issue 列出的标签 + 兜底规则）。标签不改名。每条同步后的变异仍须表达它原来的意图——例如 `four-file order` 仍是「文件次序被打乱」，`drop files.hurl` 仍是「去掉 `files.hurl`」（替换串保留 `session-meta.hurl`），`chat file` 与 `drop files.hurl` 今天的查找/替换串完全相同（`:122` 与 `:126`），同步后两条都写成「五文件 → 去掉 `files.hurl` 的四文件」，仍然相同、不借机改意图，`stale HTTP evidence` 的替换串是**旧的四文件证据行**（即「配方已五文件而证据行没跟上」）。
- 新增四条（标签固定）：
  1. `contract Make smoke drop session-meta.hurl mutation`：配方回到四文件（遗漏）。
  2. `contract Make smoke session-meta before files mutation`：`… smoke/chat.hurl smoke/session-meta.hurl smoke/files.hurl`。
  3. `contract Make smoke-live session-meta file mutation`：`smoke-live` 配方末尾变成 `smoke/chat.hurl smoke/session-meta.hurl`。
  4. `contract Make smoke session-meta second recipe line mutation`：`smoke` 配方保持四文件的第二行，另加第三行单独对 `smoke/session-meta.hurl` 调用 hurl。
- 「只改一侧被拒」：Makefile 已五文件而 AGENTS.md 仍四文件 = 既有 `stale HTTP evidence`（同步后）；AGENTS.md 已五文件而 Makefile 仍四文件 = 新增 1。
- RED 记录（按阶段如实；`cm` 的判据是「替换后 `contract()` 的退出码等于期望值 1」，缺锚另记 `missing anchor`）：
  - 阶段 A（只加四条新 `cm`，Makefile/AGENTS/基线未动）：新增 1、2、4 的查找串是五文件串，旧 Makefile 里没有 → 缺锚 FAIL；新增 3 的锚点是 `smoke-live` 配方的尾部，旧 Makefile 里恰一次 → 直接 PASS。这一阶段只说明前提未就绪。
  - 阶段 B（先于同步步骤 1：只改 Makefile 为五文件；AGENTS.md 与 oracle 基线未动；四条新 `cm` 已加）：真实仓库上的 `contract()` 不通过（基线自检 FAIL）；锚点仍在的 `cm` 因「反正被拒」而 PASS——所以这一阶段的绿没有意义。**新增 1 的真 RED 在这里**：它把配方换回四文件，候选恰是旧基线，`contract()` 接受 → 输出 `FAIL … drop session-meta.hurl … (rc=0 want=1)`。
  - 阶段 C（全部同步）：`make test-guardrails` 全 PASS，四条新变异各自 PASS（被拒）。
  每个阶段保留命令与输出片段。新增 2、3、4 没有「先不被拒」的阶段（整表相等），记录里照实写。

### D5 本地真实冒烟（实现者与编排者各做一遍）
先 `npm run build --workspace web && npm run build --workspace server`。`OMP_BIN` 指向仓库外已校验的 v18.0.10 二进制或沙箱内 `make omp-fetch` 的产物；不在真实仓库里建符号链接。两种形态都做（先例：`openspec/changes/archive/2026-09-28-smoke-fork/design.md`）：
- **形态 (a) CI 同款包装**：以 CI 的 env（`HOST`、`PORT`、`SMOKE_BASE_URL`、`DB_PATH`、`STATIC_ROOT=<仓库>/smoke/fixtures/static`、`OMP_BIN`、`OMP_STATE_DIR`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY=fake`、`FAKE_UPSTREAM_PORT`、`RUNNER_TEMP`）连跑两次 `bash .github/scripts/ci-compiled-server.sh smoke`，两次用**同一个** `RUNNER_TEMP`/`DB_PATH`/`SANDBOX_ROOT`（脚本只 `mkdir -p` 与 `cp -R`，不清库）。第一次走 201，第二次走 409 采用；两次之间服务重启（脚本自带启停）。
- **形态 (b) 调用方自起的长驻服务**（主规格 verification-harness Scenario「文件烟测独立且可重复」的形态）：自己启动假上游与编译后的 server（同样的 env，全新 DB 与沙箱，先 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`），对同一个运行中的服务连跑两遍 `make smoke`，再从空 cookie 单独跑一遍 `smoke/session-meta.hurl`（独立性），最后停掉自己起的进程。负对照 N1–N4 与下面的取证都在这个形态上做。
- 201/409 的取证：服务不打请求日志（`server/src/app.ts` `logger: false`），所以用审计——形态 (b) 三遍之后以 `zhangsan` 查 `GET /api/audit?limit=200`（默认窗口 50 条，不够），`kind` 为 `workspace.create` 且 `title` 为 `创建工作空间 smoke-sessions` 的事件恰一条（首遍 201 创建，后两遍 409 采用；空间名在 `title` 里，`detail` 只有 `root`，见 `server/src/workspaces/store.ts:109-115`）。
- 取证次序：H1 的审计清点与 H2 的列表检查先做，负对照 N1–N4 后做——负对照故意让文件中途失败，会留下 `冒烟会话` 行、`other_id` 行与登录态。
- 库与 `SANDBOX_ROOT` 必须同生命周期：库在而空间目录被清掉时，0b 仍是 409、1a 仍是 201，但 4a 的回合会因空间根不存在而失败（`server/src/sessions/session-cwd.ts`）。Hurl 文件头注释写明这一点。

负对照（证明断言咬得住，做完还原；不入库）：
- N1：把 `thinking` 期望文本改一个字 → `make smoke` 非零，失败点在 4d+5。
- N2：把 1a 的 `count == 8` 改成 7 → 非零，失败点在 1a。
- N3：把 6b 的 `detail.sessionId` 期望换成 `other_id` → 非零（证明「最新审计属于本次会话」不是只看 `kind`）。
- N4：把 7h 的 `session.title` 期望改成 `x` → 非零。

## Governing invariant
1. `make smoke` 的 Hurl 文件参数恰为 `smoke/public.hurl smoke/auth.hurl smoke/chat.hurl smoke/files.hurl smoke/session-meta.hurl`；Makefile 配方、oracle 基线、AGENTS.md 证据行三处对「五文件」逐字一致，任一侧单独变化被 `make test-guardrails` 拒绝。
2. `smoke-live` 的配方字节不变。
3. `session-meta.hurl` 从空 cookie 独立可运行、可重跑，结束时不留认证会话、running 回合或自建会话行。
4. POST/PATCH/DELETE 条目不重试；断言都是精确状态码与精确值。

## Sibling surfaces
- `smoke/chat.hurl`、`files.hurl`、`public.hurl`、`auth.hurl`：零 diff；同一次 `make smoke` 里先于本文件运行，共享同一个服务与库（本文件的审计断言用 `detail.sessionId` 与它们留下的事件区分）。
- `uid-isolation` job：同一条 `make smoke`，`OMP_USER=omp`。绑定空间的回合以空间根为 cwd；空间目录由 `core/sandbox/dirs.ts` 建成组可写（2770），omp uid 属该组。本机（macOS，同 uid）无法验证，CI 是判别性检查——那里失败是真实发现，不是 hurl 写法问题。
- `scripts/test-guardrails.sh` 的其它守卫与 `.github/scripts/**`：零 diff。
- constraints registry（`constraints.yaml`）的 smoke surface：命令与 evidence 不含文件数。仓库内把 `make smoke` 写成四文件的非规格文件：Makefile、AGENTS.md、oracle（本刀同步）；`docs/acceptance/demo-parity-checklist.md:300`（历史验收记录，不改）；`IMPLEMENTATION_PLAN.md:29`（「What Already Exists」现状清单，写作 `smoke/{public,auth,chat,files}.hurl`——花括号写法，最初的 grep 没命中，评审发现；不在本 issue 的 PR 边界内，见「已知残留」10）。

## Must-preserve
- 既有四个 Hurl 文件的全部断言与次序；`make smoke` 配方除追加的一个参数外逐字节不变；`smoke-live` 不变。
- oracle 的解析逻辑、辅助函数、既有变异的标签与数量（只增四条）。
- AGENTS.md 除 `:89` 外不变；CI workflow、`.github/scripts/**`、server、web 零 diff。

## Required evidence
Guardrails（`make test-guardrails`）：
- **G1** 全套 PASS（退出码 0），含四条新标签各一行 PASS。
- **G2** D4 的阶段 A–C 记录，其中阶段 B 含新增 1 的 `FAIL …(rc=0 want=1)` 输出。
- **G3** 单侧变化被拒：oracle 为最终态，在沙箱副本里只把 Makefile 那一行回退成四文件、或只把 AGENTS.md 那一行回退成四文件，`make test-guardrails` 各自非零（oracle 对配方与证据行是各自独立钉的，不做交叉校验；「只改一侧」就是其中一侧与 oracle 不符）。
- **G4** `git diff --stat origin/master`：只有 `smoke/session-meta.hurl`、`Makefile`（1 行）、`AGENTS.md`（1 行）、`scripts/test-ci-harness.sh` 与 `openspec/changes/session-meta-smoke/**`；`Makefile` 的 `smoke-live` 配方行逐字节相同。
- **G5** D4 第 3 步的残留清点。

真实 HTTP（`make smoke`，真 omp v18.0.10 + 受控假上游 + 编译后的 server）：
- **H1** 形态 (a) 两次、形态 (b) 两遍均退出 0；Hurl 输出里五个文件都执行、`session-meta.hurl` 成功。形态 (b) 三遍之后 `smoke-sessions` 的 `workspace.create` 审计恰一条（首遍 201、其后 409）。
- **H2** 形态 (b)：两遍之后从空 cookie 单独再跑一遍 `smoke/session-meta.hurl` 通过（独立性）；之后以 `zhangsan` 查 `GET /api/sessions`，没有标题为 `冒烟会话` 的会话、没有 `title` 为 null 的会话（泄漏的 `other_id` 会是这个样子；`chat.hurl` 留下的会话都有标题）、没有 `running` 会话。
- **H3** 负对照 N1–N4 各自非零且失败点正确。
- **H4** CI：`smoke` 与 `uid-isolation` 两个 job 通过（PR 上取证）。

## 交付记录
- 文件：`smoke/session-meta.hurl` 第一轮 285 行、32 个请求条目（一次运行实测执行 34 次请求：两条轮询各重试一次）；`Makefile` 1 行；`AGENTS.md` 1 行；`scripts/test-ci-harness.sh` 改 9 行、加 1 行（`cm` 229 → 233，无标签改名或删除）。
- **G1**：`make test-guardrails` 退出 0，ci-harness oracle 816 PASS / 0 FAIL（基线 812 + 4），四条新标签各 `PASS … (rc=1)`。
- **G2**（四条新标签在各阶段的表现，与 D4 的预测一致）：

  | 标签 | A（只加四条 `cm`） | B（只改 Makefile） | C（全部同步） |
  |---|---|---|---|
  | `drop session-meta.hurl` | 缺锚 | `FAIL … (rc=0 want=1)`（真 RED） | PASS |
  | `session-meta before files` | 缺锚 | PASS（基线自检已 FAIL，无意义） | PASS |
  | `smoke-live session-meta file` | PASS | PASS（无意义） | PASS |
  | `session-meta second recipe line` | 缺锚 | PASS（无意义） | PASS |

- 重定基的既有变异 19 条：FAIL 清单给出 10 条（AGENTS 族 `smoke command`、`smoke evidence`、`matrix comment`、`matrix fence`、`matrix HTML block`、`matrix wrap comment`、`matrix wrap fence`、`stale HTTP evidence`、`smoke matrix peer-section-move`，以及 `Make smoke export after target`）；只靠兜底 grep 找到 9 条（`Hurl connection`、`smoke whitespace duplicate`、`smoke protected-first multi-target`、`recipe comment`、`conditional`、`smoke min-bash-steps`、`smoke chat file`、`smoke four-file order`、`smoke drop files.hurl`）。候选级核对：163 条既有 Makefile/AGENTS 族候选里 159 条等于「旧候选做四→五文件替换」，另 4 条是按 D4 手工重述意图的 `chat file`、`drop files.hurl`、`four-file order`、`stale HTTP evidence`。
- **G3**：最终态副本里只回退 Makefile 那一行 → 退出 2（oracle 792 PASS / 24 FAIL）；只回退 AGENTS.md 那一行 → 退出 2（796 / 20）；两者都含 `FAIL contract baseline source identities (rc=1 want=0)`。
- **G4**：diff 只有四个文件与本 change 目录；`smoke-live` 配方行逐字节相同。**G5**：残留恰 3 处——新增 1 的替换串、新增 4 的替换串、`stale HTTP evidence` 的替换串。
- **H1**：形态 (a) 在同一 DB/沙箱上两次均退出 0（各 5 文件 100 请求；实现者沙箱与编排者在真实仓库各做一遍）；形态 (b) 对同一个运行中的服务 `make smoke` 两遍均退出 0，之后 `GET /api/audit?limit=200` 共 25 条，`workspace.create` 且标题为 `创建工作空间 smoke-sessions` 的恰 1 条。
- **H2**：空 cookie 单独跑 `smoke/session-meta.hurl` 退出 0（34 请求）；之后 `GET /api/sessions` 无 `冒烟会话`、无 null 标题、无 `running`。
- **H3**：N1–N4 各自退出 4，失败点依次为 4d+5 的 `thinking`、1a 的键数、6b 的 `detail.sessionId`、7h 的 `session.title`。负对照是改一行的临时副本单独跑（不是整条 `make smoke`）；交付文件在负对照前后逐字节相同。
- 真 omp v18.0.10 下的观察：`thinking` 三分片逐字合并到达；审批轮询与 done 轮询各只重试 1 次；done 之后立刻 DELETE 返回 204，下一个请求即读到 `session.delete` 审计，该会话的 omp 进程随之退出，服务日志无报错；绑定会话的 omp 以空间根为 `--cwd`。
- **H4**：PR #742 的 CI run 37017996819（head `56bae2b`）九项检查全部通过；`smoke` 与 `uid-isolation` 两个 job 的日志都是 `Success smoke/session-meta.hurl (34 request(s) …)`、`Executed files: 5`、`Executed requests: 100`——绑定工作空间的回合在 `OMP_USER=omp` 下通过（确认命令：`gh run view 37017996819 --repo DankerMu/open-wb --log | grep -E 'Success smoke/|Executed files:'`）。
- **fix pass 1**（评审采纳的两处覆盖缺口，只改 `smoke/session-meta.hurl`：285 → 310 行，32 → 34 个条目，一次运行 36 次请求）：
  - 八键逐键点名：第一轮只断言键数与其中五个键的值，`createdAt`/`updatedAt` 的键名没有被点到，键数对而键名改了的 DTO 会通过。现在 1a、2d、3a 三处都把八个键逐个断言（先对真实服务核过形状：`id` 32 位小写 hex，时间戳与置顶后的 `pinnedAt` 是整数）。
  - 越权创建不留会话：第一轮只断言 404。现在以 `lisi` 自己的会话列表条数在三次越权尝试前后相等来证明（7b′、7e′）。
  - 复验：形态 (a) 两次、形态 (b) 两遍加单独一遍均退出 0（5 文件 102 请求）；编排者在真实仓库上形态 (a) 两次同样通过；`make test-guardrails` 816 PASS / 0 FAIL。负对照 N5（把 1a 的 `$.createdAt` 改成不存在的 `$.created_at`）失败在 1a，N6（把后置条数期望改成观测值加一）失败在 7e′——它们只说明新断言确实被求值，不能代替一个行为异常的服务端。
- 耗时：`make smoke` 由四文件 66 请求约 8.3 s 变为五文件 100 请求约 8–10 s；`session-meta.hurl` 自身约 1.6 s。

## 已知残留
1. **第二遍（409 采用）路径只有本地证据**：CI 每个 job 只跑一遍。
2. **`thinking` 断言不证明 `MODEL_REASONING` 开关或真实模型**：假上游见标记就发 `reasoning_content`，omp 在响应侧解析它不依赖模型条目的 `reasoning` 声明（规格里的非规范注记）。归 #544。
3. **审计「最新一条」依赖串行**：`make smoke` 以 `--jobs 1` 运行、调用方拥有的服务没有别的客户端时成立；并发的其它写审计的请求会让 `limit=1` 读到别的事件。与 `files.hurl` 的既有做法相同。
4. **running 会话的删除不在此文件**：只删 `done` 会话。
5. **`lisi` 是管理员**：越权断言证明的是「管理员也拿不到别人的会话与空间绑定」；普通成员的越权由服务端测试覆盖。
6. **两个名字不再贴切**：变异标签 `four-file order`（偏差 6）与 verification-harness 的 Scenario 标题「文件控制面反映已执行四文件」（偏差 3）；两者都是稳定标识，不改名。

7. **真 omp 下两件事在实现前只有代码依据**：`thinking` 三分片逐字合并到达、回合 done 之后立刻 DELETE 的收尾路径。实现期的真实运行已观察到两者成立（见「交付记录」）；DELETE 必为 204 另有读码依据——终态提交与回合释放在同一同步段，GET 看到 `done` 时已无活动回合。

8. **`thinking` 文本不符时要等满约 90 秒才失败**：D1 把 `thinking` 断言与 done 轮询放在同一条带 `retry: 180` 的 GET 里，文本写错时表现为重试耗尽而不是即时不匹配（N1 实测 198 个请求、92 秒）。与 `chat.hurl` 的 `content` 断言同一性质。
9. **空间目录的权限位在 macOS 上是 `0770`**（没有 setgid；`server/src/core/sandbox/dirs.ts` 写的是 `0o2770`）：本机观察，原因未查。`uid-isolation` 依赖的是 Linux 上该目录的组与权限位，由 CI 的 `uid-isolation` job 判别（H4）。
10. **`IMPLEMENTATION_PLAN.md:29` 的现状清单仍写四个文件**：该文件不在本 issue 的 PR 边界内；收尾 issue #542（父 tasks 9.1，改 `IMPLEMENTATION_PLAN.md` 的 S1c 节）合入时一并改成五文件，已在 #542 留言。
11. **`MODEL_REASONING=off` 下的 `thinking` 断言没有运行证据**：规格写「不论 `MODEL_REASONING` 取值」，本刀的所有运行都是缺省 on；off 时仍产出 thinking 只有读码依据（omp 在响应侧解析 `reasoning_content` 不依赖模型条目的声明）。定案命令：以 `MODEL_REASONING=off` 启动服务后单跑 `smoke/session-meta.hurl`。
12. **`session-meta second recipe line` 变异同时改了第二行**：它的被拒也可以用「第二行不等于基线」解释；整套变异里没有「基线两行不动、只追加第三行配方」的候选（master 上即如此），oracle 的整表相等会拒绝它。

## Seams under test
- 真实 HTTP、真实 omp v18.0.10、编译后的 server、受控假上游：没有 mock。
- oracle 是源码派生的静态检查：它证明配方与文档的形状，不运行 Hurl。
