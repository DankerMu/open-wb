# Proposal: session-fork-metadata（#527）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.4（epic #509，design D14）。A #466 的 fork 在 `store-branch.ts` 以显式列名插入新会话行、拷贝分叉点前的消息与步骤；列清单不含 B 在 035 加入的 `workspace_id`/`scene`/`pinned_at`/`thinking`/`changes`。故当前 fork 静默得到未绑定、无场景的新会话（其后续 generation 以所有者根为 cwd），并丢失被拷贝历史的思考与文件变更。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 fork 路由的 201 `session` 值与 fork 会话后续 generation 的 `--cwd`（Critical Path「omp 子进程治理」的 cwd 数据流）；fork 事务的显式列拷贝（漏列即静默丢数据）。
Selected risk packs: Schema / columns / units / field names（三条显式列语句）；Public API / CLI / script entry（fork 201 八键值、列表一致）；Auth / permissions / secrets（fork 会话 cwd 落在源空间根，不越出所有者沙箱；不写 bind 审计）；Legacy compatibility / examples（未绑定 fork 与既有 fork 行为不变）
Evidence floor: 新建 `server/test/session-fork-metadata.test.ts` 覆盖 design「Required evidence」；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/store-branch.ts`：
  - `FORK_SESSION` 的 `INSERT … SELECT` 增 `workspace_id, scene`（取源行），`pinned_at` 不列出（NULL）。
  - `FORK_MESSAGE` 增 `thinking`。
  - `FORK_STEPS` 增 `changes`。
- 新建测试 `server/test/session-fork-metadata.test.ts`。

## Capabilities
- ADDED `session-metadata`「fork 继承会话元数据」：取父 delta 该 Requirement，两处按 master 实际修订（见下）。
- MODIFIED `chat-sessions`「会话 REST」：main 原文 + fork 段新会话行增「copied `workspace_id` and `scene`, `pinned_at` NULL」、拷贝列增 thinking 与 step changes、增 Scenario「Fork inherits workspace and scene but not pin」。组 10（`agentDir`、命令分类、Branch alignment、`draft` 为所存正文）的父 delta 漂移不并入。

## 与父 delta 的偏差（父 change 归档前 rebase 时适用）
1. 父 delta 的「会话 REST」fork 段与「fork 继承会话元数据」写「预先插入（create the new session row first … `omp_session_file` NULL）」、502/409 时「删除预建行」。master 上 A #466 的实现与 main spec 均是**最终事务内插入**新会话行（`store-branch.ts:186` `FORK_SESSION` 在 `copyForkHistory` 的 `runOwnedTransaction` 内，main「No new session row exists before this transaction commits」）。本子 delta 以 main 为准，只在插入列上加本刀内容；父 delta 的预建行描述需在 rebase 时改回最终事务插入。
2. 父 delta 的「fork 继承会话元数据」称 cwd 一致「因 omp `--resume` 采用源会话文件头的 cwd」。宿主侧 fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 经 2.2 的 `sessionCwdResolver` 计算（`supervisor.ts:427`），不依赖文件头；本子 delta 改写为该事实。
3. 父 Scenario「fork 响应的会话视图与列表一致」THEN 末句「web 八键严格解析接受该响应」属 5.1 web 契约（`web/test/session-contract-metadata.test.ts`），本刀只动 server，子 delta 不纳入该句。
4. fork 临时进程以源会话 cwd spawn 已由 2.2（#521）写入 main「Supervisor dispatch and generation binding」，不在本刀重述。
5. main `openspec/specs/turn-control/spec.md:169`「从此处分叉 REST」逐列列出了新会话行与拷贝列，未含 `workspace_id`/`scene`/`thinking`/`changes`；父 tasks 9.2 重述该 Requirement（五键 → 八键）时须一并补上这四列，本刀不改 turn-control spec。

## Impact
- server：只改 `store-branch.ts` 三条 SQL 常量；新测试文件一个。不触碰 `supervisor.ts`、`turn-control.ts`、`branching.ts`、`store.ts`、`rest*.ts`、web。
- 依赖：#510（035 迁移）、#517（5.1 投影）、#521（2.2 cwd）、A #466 均已合并。

## Non-goals
- 八键/thinking/changes 投影（5.1）；fork 临时进程 cwd 计算（2.2）；`POST /api/sessions` 绑定与 `session.bind`（4.1）；regenerate 删除旧助手行（既有级联）；turn-control「从此处分叉 REST」五键 → 八键重述（9.2）；web 分叉交互。
