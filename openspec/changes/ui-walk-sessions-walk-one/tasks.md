# Tasks: ui-walk-sessions-walk-one（#540）

Fixture level: expanded

## 8. chat-harness — UI 走查会话元数据，走查一（父 tasks 8.2a）

- [ ] 8.2a 新建 `web/e2e/ui-walk-sessions.spec.ts`（按 chat-harness「UI 走查会话元数据」第 1–6 步：UI 登录 `zhangsan` → 经页面请求上下文确保空间 `ui-walk-sessions`（201|409）→ 欢迎态点 `代码开发` → footer 选该空间 → 发送 `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 <uuid>`，观测 `POST /api/sessions` 请求体 → 折叠块 → 文件变更卡 / 产物卡预览 / 产物面板 / `查看详情` → 侧栏 `空间 › ui-walk-sessions`；`finally` 删除会话；UI 登出）+ `web/playwright.config.ts` 两行（`testMatch` → `"ui-walk*.spec.ts"`、`globalTimeout` → `300_000`）。验证：`make ui-walk` 两个 project 全绿，`ui-walk.spec.ts` 照常通过；design「Required evidence」E1–E10

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `make ui-walk` 选中的文件集合变了（glob）；超时预算变了 → E1、E2、E3 |
| Config / project setup | yes | `web/playwright.config.ts` 两行；其它值不动 → E1 |
| Legacy compatibility / examples | yes | `ui-walk.spec.ts` 在新 spec 先跑的前提下照常通过；读旧 spec 源码的两个 jsdom 测试 → E3、E4、E8 |
| Concurrency / shared state / ordering | yes | 两个 spec、两个 project 共用一个库：空间采用（201/409）、不留会话、运行次序 → E3、E4、E5、N11 |
| Error handling / rollback / partial outputs | yes | `finally` 清理在失败路径也执行、不吞原始失败（id 取自 201 响应）；删除前离开会话页；oracle 的 401 计数 → N1–N9 之后的清点、N10、N11、N12 |
| Schema / columns / units / field names | yes | 请求体 `{workspaceId, scene}`、`changes` 的四键、`thinking` → N2、N3、N9 |
| Resource limits / large input / discovery | yes | 每测试 30 s 与 `globalTimeout` 300 s；CI 时长 → E3、E6、E10 |
| Auth / permissions / secrets | yes | UI 登录 / 登出与 oracle 的两次 401；iframe `sandbox` 恰 `allow-scripts` → N7、N10 |
| File IO / path safety / overwrite | yes | 逻辑路径 `zhangsan/ui-walk-sessions/…`（不暴露沙箱根）；复用状态下文件覆盖写 → N6、E4 |
| Accessibility / keyboard / focus | no | 本刀只按可访问名定位，不新增交互 |
| Release / packaging / dependency compatibility | no | 无新依赖 |
| Documentation / migration notes | no | spec delta 即文档；AGENTS.md 的 ui-walk 行不含文件名 |

## 通用纪律（继承父 tasks.md）
- [ ] 改动只有 `web/e2e/ui-walk-sessions.spec.ts`（新）与 `web/playwright.config.ts` 的两行；其它被跟踪文件零 diff。
- [ ] 没有 RED 阶段（产品行为已在 master）；负对照 N1–N12 逐条记录失败所在的步骤。
- [ ] `make lint`、`make typecheck`、`make anti-drift`（jscpd 至多 178 → 180，且新增的只落在登录块或登出块）、`bash scripts/size-guard.sh`、`npm test --workspace web`、`make test-guardrails` 退出 0；`openspec validate ui-walk-sessions-walk-one --strict --no-interactive` 通过。
- [ ] 实测时长（本地全新状态、复用状态；CI）写进 PR。
