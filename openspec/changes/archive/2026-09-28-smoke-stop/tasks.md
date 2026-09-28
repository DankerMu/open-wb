# Tasks: smoke-stop（#482）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.1b 原文）

- [ ] 8.1b `smoke/chat.hurl` 停止：新建第二会话 prompt → pending 审批时 `POST …/stop` 202 → 轮询 status 至 `stopped` → 断言无 running 步骤、bash 步骤 `failed`（已拒绝）、assistant 与 session 为 `stopped` → 对该已停止会话 `POST …/regenerate` → 202（`assistantMessageId` 不同于被停止的助手）→ 轮询新助手 `approvals` 出现一条 pending 并 `allow`（200）→ 轮询至 done（真实 omp 下被停止回合的用户消息在 `.jsonl` 历史中、regenerate 对齐成功）→ 再 prompt 202；已 done 的首会话 stop → 204。验证：`make smoke` 绿
- [ ] （本 fixture 追加，见 design「Must add/change」）按 design 表格落 (1) 与 (4a)–(4k)：(1) 紧接 `chat.hurl:72`，(4) 紧接 (1)、在 `:74` logout 之前；每条带 `[Options] skip: {{skip_turn_control}}`；stop/regenerate 无 `Content-Type`、无 body；POST 无 retry；pending 轮询 (4c)/(4g) `retry: 40`，其余轮询 `retry: 180`，`retry-interval: 500ms`；(4c) 额外断言 bash 步骤 `running`（proposal 偏离 1）。验证：design E1、E2
- [ ] （本 fixture 追加）`chat.hurl:1-4` 头注释改写为不含条目数的步骤概述（proposal 偏离 2）。验证：design E5

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | chat.hurl 是 `make smoke`、`make smoke-live` 与 CI 两条 job 的共用入口；stop/regenerate 为 bodyless content-parser owner → E1、E2、E3（带 `Content-Type` 恒 400）、E6 |
| Config / project setup | no | Makefile 配方、Hurl 变量集、CI env 零 diff，只复用 #481 的 `skip_turn_control` → E4、E5 守护 |
| File IO / path safety / overwrite | no | 不涉文件读写 |
| Schema / columns / units / field names | no | 只消费已定形的 messages/approvals/stop/regenerate 响应键 |
| Auth / permissions / secrets | no | 沿用同一登录 cookie；他账号 404 与无 bearer 401 条目不变；验证只用假上游与 `fake` 密钥 |
| Concurrency / shared state / ordering | yes | stop 必须落在「审批 pending + bash running」上；服务端先 Deny 再 abort，与 omp 的第二个 turn 竞态；regenerate 须在 stop 收敛后发出 → design E0-2/E0-3、(4c) 的 bash running 断言、(4e) 的 stopped 轮询、E3 删 stop 变异。偶发红判别：(4e) 红且 `session.status == "done"`、`decision == "deny"` = Deny→abort 次序输给 omp 第二轮拿到完整正文（#473 设计内竞态，非条目缺陷，不在本刀重开）；删 stop 变异的特征则是 `decision == "timeout"` |
| Resource limits / large input / discovery | yes | 轮询预算：pending 轮询 <60s，其余 ≥90s，覆盖 8s grace + 5s/3s retire；smoke-live 90s 预算不被占用；每轮 2 个 omp 进程，远低于默认上限 16 → E0-7、E2；CI smoke 10min 超时不变 |
| Legacy compatibility / examples | yes | 既有 `chat.hurl:6-72,74-107` 逐字不变；「Real pinned runtime completes dialogue」「Oracle rejects false completion」不回归；smoke-live 语义不变 → E1、E2、E5 |
| Error handling / rollback / partial outputs | yes | `stopped` 与 `failed`/`done` 的区分；迟到首拍、409、502 都按精确断言失败，POST 不重试 → (4e)、(4i) 断言，E3 |
| Release / packaging / dependency compatibility | no | Hurl 8.0.1、omp v18.0.10 不变 |
| Documentation / migration notes | no | 架构文档归 9.1 #486；无迁移 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `smoke/chat.hurl`。`Makefile`、`scripts/test-ci-harness.sh`、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web 均零 diff。不新增 Make 目标、CI job 或 env。
- [ ] 本刀没有新测试文件，也没有既有测试文件要改：chat.hurl 是验证面本身。它的既有条目逐字不动，只允许 `:1-4` 注释改写与 `:72`/`:74` 之间的插入。出现其它破坏时，停下上报。
- [ ] 红/绿：master 上服务端已全部合入，没有自然红基线。红证据用 design E3 的三条变异，各跑一次，确认红后还原，失败输出记入 PR body。E1、E2、E4、E5、E7 为守护，恒绿。
- [ ] 按 design「Seams under test」自起服务：Node 24、真 omp `var/omp/omp`、假上游。
  - `bash .github/scripts/ci-compiled-server.sh smoke` 调用两次，env 同 `ci.yml:80-91`，端口与目录改为本机值，另须 `RUNNER_TEMP=$(mktemp -d)`（脚本 `:9` 硬检查，runner 自注入、不在 `ci.yml` 里；先例 `openspec/changes/archive/2026-09-25-legible-smoke-fixtures/design.md:104,120`）；`OMP_BIN` 指向官方 v18.0.10（本机 `var/omp/omp`）；每次新起服务与上游；
  - 对同一个调用方自起的服务（`node server/dist/server.js` + `FAKE_UPSTREAM_PORT=<p> node server/test/support/fake-upstream.mjs`）连跑两遍 `SMOKE_BASE_URL=<app> make smoke`。服务 env：`HOST`/`PORT`/`DB_PATH`/`STATIC_ROOT=smoke/fixtures/static`/`OMP_BIN`/`OMP_STATE_DIR`/`SANDBOX_ROOT`/`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1`/`MODEL_UPSTREAM_API_KEY=fake`；启动前按 `Makefile:60` 执行 `cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/`（`make smoke` 同跑 `files.hurl`，缺夹具即红）；
  - 对同一服务跑一遍 `SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<p>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`（`ci-compiled-server.sh` 没有 smoke-live 模式）；
  - 全部 exit 0。
- [ ] `bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
- [ ] PR CI 的 smoke 与 uid-isolation 两条 job 均绿（E6）。
- [ ] `openspec validate smoke-stop --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「偏离与决定」与 Open questions。
