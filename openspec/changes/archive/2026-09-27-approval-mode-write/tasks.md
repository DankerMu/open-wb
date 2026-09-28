# Tasks: approval-mode-write（#481）

## 2. omp-runtime — 命令面与退出上报（父 tasks 2.1b 原文）

- [ ] 2.1b `process.ts` spawn argv `--approval-mode yolo` → `write`；验证：spawn 契约单测的 argv 精确形状更新（既有断言改期望值）；与 8.1a、8.2a 同 PR（见组尾 Width exception），该 PR 的 `make smoke`、`make ui-walk` 绿

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.1a、8.2a 原文）

- [ ] 8.1a `smoke/chat.hurl` 审批作答：既有首轮用例在 prompt 后轮询快照到 `approvals` 中出现 `decision === null` 的条目，`POST …/approvals/:id {decision:"allow"}` 再等 done（轮询上限覆盖 60s）；回合控制条目以 `[Options] skip: {{skip_turn_control}}` 模板化；Makefile `smoke`（`--variable "skip_turn_control=false"`）/`smoke-live`（`true`）各加一个 `--variable`，`scripts/test-ci-harness.sh` oracle 同 PR 跟随。验证：`make test-guardrails` 绿、`make smoke` 绿
- [ ] 8.2a `web/e2e/ui-walk*.ts`（真 omp + 假上游）审批：首轮 running bash 步骤与审批条 `需要你的确认` 同时可见（不断言先后）→ 点 `允许` → `已允许执行` → 回合完成。验证：`make ui-walk` 两个 project 全绿
- [ ] （本 fixture 追加，见 design「Must add/change」）chat.hurl 审批轮询 `retry: 40`、`retry-interval: 500ms`（预算 <60s），捕获与断言用 E0-7 实测可用的 jsonpath 形状（`…approvals" count == 1`、`approvals[0].decision == null`、`approvals[0].tool == "bash"`）；allow POST 无 retry、带 `skip`；done 轮询 `retry: 180`（≥90s）。验证：design E3、E4
- [ ] （本 fixture 追加）ui-walk 作答步骤插在 held 轮询（`ui-walk.spec.ts:308`）之前：pending 时断言 gate 仍为 `armed`、`生成中` 可见；点击前 `holdRoute(page, "**/api/sessions/*/approvals/*")`，挂起期间断言两按钮 disabled，`release()` 后再断言 `已允许执行` 与 `bash 已完成`；完成后 reload 仍为 `已允许执行`；步骤代码放在新建的 `web/e2e/ui-walk-approval.ts`，`ui-walk.spec.ts` ≤800 行。验证：design E5、E6
- [ ] （本 fixture 追加）oracle 新增 4 条拒绝变异：`smoke` 缺该变量、`smoke` 为 `=true`、`smoke-live` 缺该变量、`smoke-live` 为 `=false`。验证：design E2

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 生产 spawn argv 是对 omp CLI 的契约；`make smoke`/`make smoke-live` 是受保护的 Make 入口 → E1（argv 精确 `toEqual`）、E2（oracle 钉两条配方与 4 条新变异） |
| Config / project setup | yes | Makefile 配方多一个 Hurl 变量；`write` 是唯一的审批模式值，不新增 env，没有回 yolo 的开关；CI 工作流与 env 零 diff，不传 `OMP_MAX_PROCESSES` → E2、E6、E8；非目标：`OMP_APPROVAL_MODE` |
| Auth / permissions / secrets | yes | 审批是 exec 工具的权限闸门：生产从静默放行变为逐次审批；sudo 形态的 sudoers 尾参 `*` 覆盖新 argv；验证只用假上游与 `fake` 密钥 → E1、E3、E5、E7（uid-isolation 作答） |
| Concurrency / shared state / ordering | yes | 60s 自动允许与作答 POST 的竞态（200 vs 409）；select 先于 `tool_execution_start`；gate 只在作答后才进入 `held` → design「200 vs 409 竞态」、E0-2/E0-4/E0-8、E5 的 `armed` 断言 |
| Resource limits / large input / discovery | yes | 轮询预算（审批 <60s，done ≥90s）；Playwright 单测 30s（`playwright.config.ts:14`）与 gate TTL 30s（`fake-upstream.mjs:21`）内的作答耗时实测不足 0.2s；CI smoke 10min、ui-walk 15min 不变 → E0-7、E0-8、E3、E5 |
| Legacy compatibility / examples | yes | `public`/`auth`/`files.hurl` 在 write 下不变全绿；既有 held-gate、reload、W-scroll 与 error oracle 断言不改；smoke-live 语义不变（跳过作答条目，靠自动允许完成）；既有测试只改两个期望值 → E0-9、E1、E3、E4、E5 |
| Error handling / rollback / partial outputs | yes | 409、迟到的首拍、真正失败都按精确断言失败，POST 不重试；done 轮询放宽使真实失败晚于约 90s 才暴露（已接受）→ E3、design「200 vs 409 竞态」 |
| File IO / path safety / overwrite | no | 不涉文件读写；实测 `write` 工具不触发审批（E0-6），只作记录 |
| Schema / columns / units / field names | no | 只消费 #476/#468 已定形的 `approvals` 与作答 body，不改键集 |
| Release / packaging / dependency compatibility | no | 无依赖变化；Hurl 8.0.1 已是 CI 版本；omp 仍为 v18.0.10 |
| Documentation / migration notes | no | 架构文档归 9.1 #486；无数据迁移（proposal Open questions 已核对 carry-forward 84） |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/omp/process.ts:80`、`smoke/chat.hurl`、`Makefile`（`:64`、`:99`）、`scripts/test-ci-harness.sh`、`web/e2e/ui-walk.spec.ts`，并新建 `web/e2e/ui-walk-approval.ts`。supervisor、store、REST、web src、`fake-omp.mjs`、测试 helper、`ci.yml`、`.github/scripts/*`、`AGENTS.md` 零 diff。
- [ ] 既有测试允许的改动**仅**两处期望值：`server/test/omp-process.test.ts:530` 与 `server/test/server-assembly.test.ts:658` 的 `"yolo"` → `"write"`。不加断言，既有测试文件不增长。除此之外出现破坏时，停下上报。
- [ ] `ui-walk.spec.ts` 只加新模块的 import 与两处调用，并且**只**把 `generatingStatus`（`:701-706`）原样搬到新模块、import 回来。biome 格式化后 `wc -l` 预期为 795（import 折行时为 799），须 ≤800，实测值记入 PR body。
- [ ] 红/绿：
  - E1：先改测试字面量，恰 14 例红，再改 argv；
  - E2：先改 Makefile，oracle 基线红，再同步 oracle；
  - E3：master（yolo）上新 chat.hurl 红于审批捕获；
  - E5：master 上 ui-walk 红于 `:308`；
  - 失败输出记入 PR body。E4、E6、E8、E9 为守护，恒绿。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`make test-guardrails`、`make check` 退出 0。
- [ ] 按 design E0 的方法自起编排服务：Node 24、真 omp `var/omp/omp`、假上游。`make smoke` 连跑两遍、`make smoke-live`（假上游形态）、`make ui-walk`，全部退出 0。
- [ ] PR CI 的 `smoke`、`ui-walk`、`uid-isolation` 三条 job 均绿（E7）。
- [ ] `openspec validate approval-mode-write --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，并列出 proposal 的「偏离与决定」与 Open questions。
