# Tasks: ui-shots-approval（#618）

## 1. 实现

- [x] 1.1 `web/e2e/ui-shots.mjs` `createDoneSession`：发送后轮询「助手 article 内 group `需要你的确认` 可见」或「会话列表当前项 status 为 `已完成|失败`」先到者；前者则点 `允许`（exact）、等 group `已允许执行` 可见，再沿用既有 `已完成|失败` 等待（总上限仍为 `CHAT_DONE_TIMEOUT_MS`，自发送起算）。只用脚本已有的 `visible()`/`pollUntil()`，不 import `@playwright/test` 的 `expect` 或 `ui-walk-approval.ts`。`CHAT_DONE_TIMEOUT_MS` 不改。

## 2. 验证

- [x] 2.1 `make check`（Node 24.13.1）退出 0（含 lint/typecheck 对 `web/e2e` 的覆盖，如有）。
- [x] 2.2（编排者）真实运行：本机 darwin omp v18.0.10（SHA256 校验）+ 编译产物服务 + `.github/scripts/ci-fake-upstream.sh` 假上游 + fresh DB + 夹具复制到 `<SANDBOX_ROOT>/u1/` + `npm run build --workspace web` 的 `web/dist`：`make ui-shots` 退出 0、`UI_SHOTS_OUT` 下恰 60 张 PNG 与 `index.html`；「作答而非自动允许」的判据：跑完后查 `DB_PATH` 的 `chat_approvals`，每行 `decision = 'allow'`（无 `timeout`），且 `decided_at - requested_at` 远小于 60000ms（记录最大值）；两侧均记录 `make ui-shots` 总耗时；同环境 master 作对照（实测 app 侧 chat-done 六格失败——首格 60s 超时、其余 5 格依赖失败，54/60、非零退出）。PR 附耗时与产物计数。
- [x] 2.3 `openspec validate ui-shots-approval --strict --no-interactive` 通过。
- [ ] 2.4（编排者）归档 PR：父 change 均无 demo-parity-acceptance delta，无需同步。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | 其余 4 态与 demo 侧截图不变 → 2.2 全 60 张；无审批的真实上游路径不变 → 验证缺口：假上游首轮必回 tool call（`fake-upstream.mjs:112-116`），本地无可重复输入，仅靠代码阅读（review focus） |
| Documentation / migration notes | yes | demo-parity-acceptance chat-done 描述 → spec delta |
| Concurrency / shared state / ordering | no | 单页顺序脚本 |
| Error handling / rollback / partial outputs | no | 失败/缺失/保留产物语义不变 |
| Public API / CLI / script entry | no | `make ui-shots` 入口与参数不变 |
| Config / project setup | no | 不改常量与配置 |
| Resource limits / large input / discovery | no | 不涉 |
| File IO / path safety / overwrite | no | 输出目录语义不变 |
| Auth / permissions / secrets | no | 不涉 |
| Schema / columns / units / field names | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |

## 通用纪律

- [x] 源码边界：只改 `web/e2e/ui-shots.mjs`；其它文件零 diff。
- [x] 不提交、不推送、不开 PR；报告改动、验证命令与结果、偏离（「内容/原因/影响」或「无偏离」）。
