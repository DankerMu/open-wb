# Tasks: smoke-regenerate（#483）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.1c 原文）

- [ ] 8.1c `smoke/chat.hurl` regenerate（真 omp + 假上游）：首会话 done 后 `regenerate` → 202 → 轮询新助手 `approvals` 出现一条 pending 并 `allow`（200）→ 轮询 done → messages 中用户消息恰一条、助手消息恰一条且 id 变化。验证：`make smoke` 绿
- [ ] （本 fixture 追加，见 design「Must add/change」）按 design 表格落 (2a)–(2d)：插在 (1)（`chat.hurl:74-80`）之后，紧接 `:81` 空行之后、`:82`（(4a) 注释）之前；若 #491 的 (3) 先合入，则插在 (1) 与 (3) 之间。每条带 `[Options] skip: {{skip_turn_control}}`；regenerate 无 `Content-Type`、无 body；POST 无 retry；(2b) `retry: 40`，(2d) `retry: 180`，`retry-interval: 500ms`；capture 名为 `regen_assistant_id`、`regen_approval_id`。验证：design E1、E2、E5
- [ ] （本 fixture 追加）按 design E3 跑 m1、m2、C1、C2 四条变异（m2 = 删去 (2c)，期望红于 (2d) `decision == "allow"`、实际 `<timeout>`），确认各自红后还原（C1/C2 只改 gitignored 的 `server/dist`，用 build 还原）。验证：design E3

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | chat.hurl 是 `make smoke`、`make smoke-live` 与 CI 两条 job 的共用入口；regenerate 为 bodyless content-parser owner（carry-forward :109）→ E1、E2、E3 m1（带 `Content-Type` 恒 400）、E6 |
| Config / project setup | no | Makefile 配方、Hurl 变量集、CI env 零 diff，只复用 #481 的 `skip_turn_control` → E4、E5 守护 |
| File IO / path safety / overwrite | no | 不涉文件读写；C1/C2 只改 gitignored 编译产物并以 build 还原 → E3 还原检查 |
| Schema / columns / units / field names | no | 只消费已定形的 messages/approvals/regenerate 响应键 |
| Auth / permissions / secrets | no | 沿用同一登录 cookie；他账号 404 与无 bearer 401 条目不变；验证只用假上游与 `fake` 密钥 |
| Concurrency / shared state / ordering | yes | regenerate 复用首轮的存活 omp 进程（E0-3），`branch` 必须把已含 toolResult 的历史退回到唯一用户消息之前，受控上游才会再发 bash；CAS 事务须删旧行、插新行，而不是保留或复用 → E0-2/E0-3、(2b) pending 轮询、(2d) count/id 断言、E3 C1/C2 |
| Resource limits / large input / discovery | yes | 轮询预算：(2b) <60s，(2d) ≥90s；smoke-live 90s 预算不被占用（新条目全部 skipped）；omp 进程数不增（regenerate 不 spawn）→ E0-3、E0-6、E2；CI smoke 10min 超时不变 |
| Legacy compatibility / examples | yes | 既有 `chat.hurl:1-80,82-251` 逐字不变，首轮 prompt 条目不加 capture（#491 的面）；「Real pinned runtime completes dialogue」「Oracle rejects false completion」「审批作答后完成对话」「停止用例」不回归 → E1、E2、E5 |
| Error handling / rollback / partial outputs | yes | 保留旧行、追加第二助手、复用旧 id 都必须失败，且不重试 POST；迟到首拍、409、502 按精确断言失败；作答不可省 → (2a)、(2d) 断言，E3 m2、C1/C2 |
| Release / packaging / dependency compatibility | no | Hurl 8.0.1、omp v18.0.10 不变 |
| Documentation / migration notes | no | 架构文档归 9.1 #486；chat.hurl 头注释已涵盖「回合控制」，不改；无迁移 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `smoke/chat.hurl`。`Makefile`、`scripts/test-ci-harness.sh`、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web 均零 diff。不新增 Make 目标、CI job 或 env。
- [ ] 本刀没有新测试文件，也没有既有测试文件要改：chat.hurl 是验证面本身。它的既有条目与注释逐字不动，只允许紧接 `:81` 空行之后、`:82`（(4a) 注释）之前插入 (2a)–(2d)。出现其它破坏时，停下上报。
- [ ] 红/绿：master 上服务端已全部合入，没有自然红基线。红证据用 design E3 的四条变异，各跑一次，确认红后还原，失败输出原文记入 PR body。E1、E2、E4、E5、E7 为守护，恒绿。
- [ ] 按 design「Seams under test」自起服务：Node 24.13.1（`.tool-versions`，先 `npm run build --workspace server`）、真 omp `var/omp/omp`、假上游。
  - `bash .github/scripts/ci-compiled-server.sh smoke` 调用两次，env 同 `ci.yml:80-91`，端口与目录改为本机值，另须 `RUNNER_TEMP=$(mktemp -d)`（脚本 `:9` 硬检查，runner 自注入、不在 `ci.yml` 里；先例 `openspec/changes/archive/2026-09-25-legible-smoke-fixtures/design.md:104,120`）；`OMP_BIN` 指向官方 v18.0.10（本机 `var/omp/omp`）；每次新起服务与上游；
  - 对同一个调用方自起的服务（`node server/dist/server.js` + `FAKE_UPSTREAM_PORT=<p> node server/test/support/fake-upstream.mjs`）连跑两遍 `SMOKE_BASE_URL=<app> make smoke`。服务 env：`HOST`/`PORT`/`DB_PATH`/`STATIC_ROOT=smoke/fixtures/static`/`OMP_BIN`/`OMP_STATE_DIR`/`SANDBOX_ROOT`/`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1`/`MODEL_UPSTREAM_API_KEY=fake`；启动前按 `Makefile:60` 执行 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`（`make smoke` 同跑 `files.hurl`，缺夹具即红）；
  - 对同一服务跑一遍 `SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`（`ci-compiled-server.sh` 没有 smoke-live 模式）；
  - 全部 exit 0；结束后停止所有自起进程（服务、假上游、omp），`pgrep` 无残留。
- [ ] `bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
- [ ] PR CI 的 smoke 与 uid-isolation 两条 job 均绿（E6）。
- [ ] `openspec validate smoke-regenerate --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「偏离与决定」与 Open questions（或 orchestrator 裁定）。
