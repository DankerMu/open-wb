# Tasks: session-meta-smoke（#539）

## 8. chat-harness — 会话元数据 HTTP 冒烟（父 tasks 8.1）

- [x] 8.1 新建 `smoke/session-meta.hurl`（design D1 的条目表：独立登录 `zhangsan`；创建或采用 `smoke-sessions`（201|409）；绑定创建 201 八键 + `session.bind` 审计（`detail.sessionId`）；未知空间 404、多余键 400 且审计不变；无 body 创建 201；PATCH title/scene/pinned 200、多余键 400、列表反映、取消置顶；`WORKBUDDY_THINK` prompt → 作答唯一 bash 审批 `allow` → done；`thinking` 恰为 `先读需求，再列要点，最后作答。`、bash 步骤 done、标题仍为 `冒烟会话`；DELETE 204 + `session.delete` 审计 → messages 404 → 列表不含 → 再 DELETE 404；`lisi` 绑定他人空间 / PATCH / DELETE 均 404；`zhangsan` 复核并删除 `other_id`；登出）+ `Makefile` smoke 配方末尾追加 `smoke/session-meta.hurl`（D2）+ `AGENTS.md` HTTP smoke 证据行五文件（D3）+ `scripts/test-ci-harness.sh` 基线、既有变异同步与四条新变异（D4）。验证：`make test-guardrails` 绿（G1–G5）、同一 DB 上 `make smoke` 连跑两遍绿（H1–H3）、CI `smoke` 与 `uid-isolation` 绿（H4）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `make smoke` 配方是受保护的入口，oracle 精确钉住；Hurl 断言是 POST 绑定/PATCH/DELETE/thinking 在真 omp 下唯一的 HTTP 端到端证据 → G1–G4、H1 |
| Documentation / migration notes | yes | AGENTS.md 证据行与配方、oracle 三处逐字一致；五条主规格现状句同步 → G1、G3、spec delta |
| Config / project setup | yes | Makefile 配方一处追加，其余字节不变，`smoke-live` 不变 → G4、新增变异 3 |
| Legacy compatibility / examples | yes | 既有四个 Hurl 文件与其断言不变；既有变异的意图不变 → H1、G1 |
| Auth / permissions / secrets | yes | 他人空间绑定、他人会话 PATCH/DELETE 均 404 且未生效 → D1 条目 7c–7h、N4 |
| Concurrency / shared state / ordering | yes | 审批轮询与作答的次序；「最新一条审计」在连跑两遍的同一库上必须属于本次会话 → D1 条目 1b/2c/6b、N3、H1 |
| Error handling / rollback / partial outputs | yes | 被拒的创建不写审计、不留会话；POST/PATCH/DELETE 不重试 → 2a–2c、Governing invariant 4 |
| Schema / columns / units / field names | yes | 八键 DTO、审计 `detail.sessionId`、`thinking` 逐字 → 1a、3a、N1、N2 |
| File IO / path safety / overwrite | yes | 0b 首跑会在所有者根下 `mkdir` 空间目录并 `chmod 2770`（`server/src/workspaces/store.ts`、`core/sandbox/dirs.ts`）；`uid-isolation` 下 omp uid 以该目录为 cwd，依赖其组与权限位 → H4、H1（首跑 201 / 重跑 409） |
| Resource limits / large input / discovery | no | 无 |
| Release / packaging / dependency compatibility | no | 无新依赖；hurl 版本不变 |

## 通用纪律（继承父 tasks.md）
- [x] PR 边界：`smoke/session-meta.hurl`、`Makefile`（仅 smoke 配方追加一个参数）、`scripts/test-ci-harness.sh`、`AGENTS.md`（仅 HTTP smoke 行）与本 change 目录；`smoke-live` 配方、CI workflow、`.github/scripts/**`、server、web、其它 smoke 文件零 diff。
- [x] oracle 同步按 D4 的两步进行（FAIL 清单 + 标签清单与兜底 grep），阶段记录（G2）与残留清点（G5）入 PR。
- [x] `make test-guardrails`、`make lint`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-meta-smoke --strict --no-interactive` 通过。
- [x] 本地真实冒烟按 D5 两种形态（CI 同款包装连跑两次；长驻服务连跑两遍 + 单独一遍 + 负对照 N1–N4）；`uid-isolation` 由 CI 取证。
