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
| 1a | `POST /api/sessions {"workspaceId":"{{workspace_id}}","scene":"code"}` | 201；`$.*` count == 8；`title` null、`status` `idle`、`scene` `code`、`workspaceId` == 捕获值、`pinnedAt` null；捕获 `session_id` |
| 1b | `GET /api/audit?limit=1` | `events` count == 1；`kind` `session.bind`、`actorId` `u1`、`workspaceId` == 捕获值、`detail.sessionId` == `session_id` |
| 2a | `POST /api/sessions {"workspaceId":"00000000000000000000000000000000","scene":"code"}` | 404，body 恰为 `not_found` 信封 |
| 2b | `POST /api/sessions {"scene":"code","color":"red"}` | 400，body 恰为 `bad_request` 信封 |
| 2c | `GET /api/audit?limit=1` | 仍是 `session.bind` 且 `detail.sessionId` == `session_id` |
| 2d | `POST /api/sessions`（无 body、无 Content-Type） | 201；`$.*` count == 8；`workspaceId` null、`scene` null；捕获 `other_id` |
| 3a | `PATCH /api/sessions/{{session_id}} {"title":"冒烟会话","scene":"design","pinned":true}` | 200；`$.*` count == 8；`title` `冒烟会话`、`scene` `design`、`pinnedAt` 非 null、`workspaceId` == 捕获值 |
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
| 7c | `POST /api/sessions {"workspaceId":"{{workspace_id}}"}` | 404 信封 |
| 7d | `PATCH /api/sessions/{{other_id}} {"title":"x"}` | 404 信封 |
| 7e | `DELETE /api/sessions/{{other_id}}` | 404 信封 |
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
同步方法：先只改 Makefile 与 AGENTS.md，跑 `make test-guardrails`，其 FAIL 清单就是同步清单（基线不匹配，以及每条查找串计数 ≠ 1 的 `cm`）；逐条把基线串、查找串、替换串更新到五文件，直到全绿。不靠目测数出现次数。
- 基线：`recipes("smoke", [...])` 第二行与 `one(matrix_rows, "| HTTP smoke | …")` 改成 D2、D3 的新串。
- 既有变异：查找/替换串含旧文件列表或旧证据行的全部同步（issue 列出的标签 + 兜底规则）。标签不改名。每条同步后的变异仍须表达它原来的意图——例如 `four-file order` 仍是「文件次序被打乱」，`drop files.hurl` 仍是「去掉 `files.hurl`」（替换串保留 `session-meta.hurl`），`stale HTTP evidence` 的替换串是**旧的四文件证据行**（即「配方已五文件而证据行没跟上」）。
- 新增四条（标签固定）：
  1. `contract Make smoke drop session-meta.hurl mutation`：配方回到四文件（遗漏）。
  2. `contract Make smoke session-meta before files mutation`：`… smoke/chat.hurl smoke/session-meta.hurl smoke/files.hurl`。
  3. `contract Make smoke-live session-meta file mutation`：`smoke-live` 配方末尾变成 `smoke/chat.hurl smoke/session-meta.hurl`。
  4. `contract Make smoke session-meta second recipe line mutation`：`smoke` 配方保持四文件的第二行，另加第三行单独对 `smoke/session-meta.hurl` 调用 hurl。
- 「只改一侧被拒」：Makefile 已五文件而 AGENTS.md 仍四文件 = 既有 `stale HTTP evidence`（同步后）；AGENTS.md 已五文件而 Makefile 仍四文件 = 新增 1。
- RED 记录（按阶段如实）：
  - 阶段 A（只加四条新 `cm`，Makefile/AGENTS/基线未动）：四条都因查找串在旧 Makefile 里不存在而 `exit 2` 记 FAIL——这只说明前提未就绪，不是断言缺失。
  - 阶段 B（Makefile + AGENTS 改好，基线与既有变异未同步）：`contract()` 在真实仓库上不通过，套件大面积 FAIL。
  - 对照 C（针对新增 1）：在未改动的基线树上，`contract()` 对四文件配方通过——「遗漏」后的候选正是它，旧基线不拒；基线更新之后同一候选被拒。另外三条在新旧基线下都被拒（精确匹配），没有「先不被拒」的阶段。
  - 阶段 D（全部同步）：`make test-guardrails` 全 PASS，四条新变异各自 PASS（被拒）。
  每个阶段保留命令与输出片段。

### D5 本地真实冒烟（实现者与编排者各做一遍）
`npm run build --workspace web && npm run build --workspace server`，然后以 CI 同款 env（`HOST`、`PORT`、`SMOKE_BASE_URL`、`DB_PATH`、`STATIC_ROOT=<仓库>/smoke/fixtures/static`、`OMP_BIN=<官方 v18.0.10 二进制的绝对路径>`、`OMP_STATE_DIR`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY=fake`、`FAKE_UPSTREAM_PORT`、`RUNNER_TEMP`）连跑两次 `bash .github/scripts/ci-compiled-server.sh smoke`，两次用**同一个** `RUNNER_TEMP`/`DB_PATH`/`SANDBOX_ROOT`：第一次走 201，第二次走 409 采用。两次之间服务重启（脚本自带启停），证据里写明。`OMP_BIN` 指向仓库外已校验的 v18.0.10 二进制或沙箱内 `make omp-fetch` 的产物；不在真实仓库里建符号链接。

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
- constraints registry（`constraints.yaml`）的 smoke surface：命令与 evidence 不含文件数（已 grep：仓库内把 `make smoke` 写成四文件的非规格文件只有 Makefile、AGENTS.md、oracle 与一处历史验收记录）。

## Must-preserve
- 既有四个 Hurl 文件的全部断言与次序；`make smoke` 配方除追加的一个参数外逐字节不变；`smoke-live` 不变。
- oracle 的解析逻辑、辅助函数、既有变异的标签与数量（只增四条）。
- AGENTS.md 除 `:89` 外不变；CI workflow、`.github/scripts/**`、server、web 零 diff。

## Required evidence
Guardrails（`make test-guardrails`）：
- **G1** 全套 PASS（退出码 0），含四条新标签各一行 PASS。
- **G2** D4 的阶段 A–D 记录。
- **G3** 单侧变化被拒：只改 Makefile（AGENTS.md 与 oracle 的证据行留四文件）与只改 AGENTS.md 两种真实工作副本状态下 `make test-guardrails` 非零（在沙箱副本里做）。
- **G4** `git diff --stat`：只有 `smoke/session-meta.hurl`、`Makefile`（1 行）、`AGENTS.md`（1 行）、`scripts/test-ci-harness.sh`；`Makefile` 的 `smoke-live` 配方行逐字节相同。

真实 HTTP（`make smoke`，真 omp v18.0.10 + 受控假上游 + 编译后的 server）：
- **H1** 同一 DB/沙箱连跑两遍均退出 0；Hurl 输出里五个文件都执行、`session-meta.hurl` 成功（第一遍 0b 为 201，第二遍为 409——从服务日志或 `--very-verbose` 单跑取证其一即可）。
- **H2** 两遍之后：库里没有 `冒烟会话` 标题的会话行、没有 live 认证会话（`session-meta.hurl` 单独再跑一次从空 cookie 起步仍通过，即独立性）。
- **H3** 负对照 N1–N4 各自非零且失败点正确。
- **H4** CI：`smoke` 与 `uid-isolation` 两个 job 通过（PR 上取证）。

## 已知残留
1. **第二遍（409 采用）路径只有本地证据**：CI 每个 job 只跑一遍。
2. **`thinking` 断言不证明 `MODEL_REASONING` 开关或真实模型**：假上游见标记就发 `reasoning_content`，omp 在响应侧解析它不依赖模型条目的 `reasoning` 声明（规格里的非规范注记）。归 #544。
3. **审计「最新一条」依赖串行**：`make smoke` 以 `--jobs 1` 运行、调用方拥有的服务没有别的客户端时成立；并发的其它写审计的请求会让 `limit=1` 读到别的事件。与 `files.hurl` 的既有做法相同。
4. **running 会话的删除不在此文件**：只删 `done` 会话。
5. **`lisi` 是管理员**：越权断言证明的是「管理员也拿不到别人的会话与空间绑定」；普通成员的越权由服务端测试覆盖。
6. **变异标签 `four-file order` 名不副实**（偏差 6）。

## Seams under test
- 真实 HTTP、真实 omp v18.0.10、编译后的 server、受控假上游：没有 mock。
- oracle 是源码派生的静态检查：它证明配方与文档的形状，不运行 Hurl。
