# Tasks: smoke-fork（#491）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.1d 原文）

- [ ] 8.1d `smoke/chat.hurl` fork（真 omp + 假上游）：对首会话首条用户消息 `fork` → 201、`draft` 等于该用户文本、新会话 `session.status` 为 `idle`、新会话 messages 为空。验证：`make smoke` 绿
- [ ] （本 fixture 追加，见 design「Must add/change」）首轮 prompt 条目的 `[Captures]` 块在 `assistant_id` 行（`chat.hurl:30`）之后加 `user_message_id: jsonpath "$.userMessageId"`，该条目其余字节不动；按 design 表格落 (3a)–(3b)，紧接 `:136` 空行之后、`:137`（(4) 注释）之前。每条带 `[Options] skip: {{skip_turn_control}}`；(3a) 带 `Content-Type: application/json`（header 在 `[Options]` 之前）与 body `{"messageId":{{user_message_id}}}`，捕获 `fork_session_id: jsonpath "$.session.id"`；两条都无 retry；不对 fork 会话 prompt。验证：design E1、E3、E7
- [ ] （本 fixture 追加）tee 包装 `OMP_BIN` 下跑一遍，记录首会话 fork 段帧序（源进程退出先于临时进程 spawn；临时进程 `--resume` regenerate 采纳的文件；`get_branch_messages` 恰一条 `text:"你好"`；`branch`/`get_state` 应答；201 前退出）。验证：design E2（carry-forward :132）
- [ ] （本 fixture 追加）按 design E4 跑 m1、m3 两条 hurl 变异，确认各自红于 (3a) `<400>` 后还原；附 m2（删 `Content-Type` 仍绿）说明。并跑 E5 的 C1/C2（编排者裁定必交；C1 是 (3b) `count == 0` 承重的唯一证据；只改 gitignored 的 `server/dist`，用 build 还原）。验证：design E4、E5

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | chat.hurl 是 `make smoke`、`make smoke-live` 与 CI 两条 job 的共用入口；fork 是 JSON-body 路由，严格 `{messageId}`，content-parser 错误 400 → E1、E3、E4 m1/m3、E8 |
| Config / project setup | no | Makefile 配方、Hurl 变量集、CI env 零 diff，只复用 #481 的 `skip_turn_control` → E6、E7 守护 |
| File IO / path safety / overwrite | no | chat.hurl 不读写文件；omp 会话文件的新建与源文件不改写由 #466 测试覆盖，本刀只观察（E2 `get_state` 新文件 ≠ 源文件）；C1/C2 只改 gitignored 编译产物并以 build 还原 |
| Schema / columns / units / field names | no | 只消费已定形的 fork 201 `{session, draft}` 与 messages 快照键；新 capture 名 `user_message_id`/`fork_session_id` 不与既有 capture 冲突 |
| Auth / permissions / secrets | no | 沿用同一登录 cookie；他账号 404 与无 bearer 401 条目不变；验证只用假上游与 `fake` 密钥 |
| Concurrency / shared state / ordering | yes | fork 须先 retire 首会话存活进程再 spawn 临时进程，且作用于 regenerate 后采纳的 omp 文件（树上有被放弃分支）；首轮 `userMessageId` 须经 regenerate 不变 → E0-3、E2 帧序、(3a) 201 |
| Resource limits / large input / discovery | yes | 每遍多一次临时进程 spawn（约 0.6s），201 前已退出、名额释放；smoke-live 90s 预算不被占用（新条目 skipped）→ E0-1、E0-3、E3；CI smoke 10min 超时不变 |
| Legacy compatibility / examples | yes | 既有条目逐字不变，首轮 prompt 条目只多一行 capture；「Real pinned runtime completes dialogue」「Oracle rejects false completion」「审批作答后完成对话」「停止用例」「重新生成用例」不回归 → E1、E3、E7 |
| Error handling / rollback / partial outputs | yes | 错 id、错 media type 必须 400 响亮失败且不重试 POST；拷贝分叉点或整段历史必须被 (3b) count / (3a) status 抓住 → E4 m1/m3、E5 C1/C2 |
| Release / packaging / dependency compatibility | no | Hurl 8.0.1、omp v18.0.10 不变；Hurl 对 JSON body 自动补 `Content-Type` 的行为已记录（E0-5 m2），不依赖它 |
| Documentation / migration notes | no | 架构文档归 9.1 #486；chat.hurl 头注释「回合控制」已涵盖 (3)，不改；无迁移 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `smoke/chat.hurl`。`Makefile`、`scripts/test-ci-harness.sh`、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web 均零 diff。不新增 Make 目标、CI job 或 env。
- [ ] 本刀没有新测试文件，也没有既有测试文件要改：chat.hurl 是验证面本身。它的既有条目与注释逐字不动，只允许两处插入：`:30` 之后一行 capture；紧接 `:136` 空行之后、`:137` 之前的 (3a)–(3b)。出现其它破坏时，停下上报。
- [ ] 红/绿：master 上服务端已全部合入，没有自然红基线。红证据用 design E4 的两条 hurl 变异与 E5 的两条服务端候选变异（必交），各跑一次，确认红后还原，失败输出原文记入 PR body。E1、E2、E3、E6、E7、E9 为守护，恒绿。
- [ ] 按 design「Seams under test」自起服务：Node 24.13.1（`.tool-versions`，先 `npm run build --workspace server`）、真 omp `var/omp/omp`、假上游。
  - `bash .github/scripts/ci-compiled-server.sh smoke` 调用两次，env 同 `ci.yml:80-91`，端口与目录改为本机值，另须 `RUNNER_TEMP=$(mktemp -d)`（脚本 `:9` 硬检查）；`OMP_BIN` 指向官方 v18.0.10（本机 `var/omp/omp`）；每次新起服务与上游；
  - 对同一个调用方自起的服务（`node server/dist/server.js` + `FAKE_UPSTREAM_PORT=<p> node server/test/support/fake-upstream.mjs`）连跑两遍 `SMOKE_BASE_URL=<app> make smoke`。服务 env：`HOST`/`PORT`/`DB_PATH`/`STATIC_ROOT=smoke/fixtures/static`/`OMP_BIN`/`OMP_STATE_DIR`/`SANDBOX_ROOT`/`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1`/`MODEL_UPSTREAM_API_KEY=fake`；启动前按 `Makefile:60` 执行 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`（`make smoke` 同跑 `files.hurl`，缺夹具即红）；
  - E2 帧证据：`OMP_BIN` 换成 tee 包装再跑一遍；服务端给 omp 的 env 是白名单，包装的日志路径须写死在包装脚本里；
  - 对同一服务跑一遍 `SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`（`ci-compiled-server.sh` 没有 smoke-live 模式）；
  - 全部 exit 0；结束后停止所有自起进程（服务、假上游、omp、tee 包装），`pgrep` 无残留。
- [ ] `bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
- [ ] PR CI 的 smoke 与 uid-isolation 两条 job 均绿（E8）。
- [ ] `openspec validate smoke-fork --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「偏离与决定」与 Open questions（或 orchestrator 裁定）。
