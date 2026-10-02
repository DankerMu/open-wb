# Tasks: harness-slash-whitelist（#557）

Fixture level: expanded

## 10. chat-harness — slash 白名单的真实栈证据（父 tasks 10.6）

- [ ] 10.6a `smoke/session-meta.hurl`：thinking 断言之后、DELETE 之前插入第 6 步——`GET /api/commands` 200，`commands` 恰两条、`source` 均 `builtin`、`name` 依次 `compact`、`todo`；`POST …/prompt {"message":"/todo"}` 202 → 有界轮询到 done → 助手 `content` 恰为 `No todos. Use /todo append <task> to start one.`、`steps` 为空、用户 `content` 为 `/todo`；`POST …/prompt {"message":"/session WORKBUDDY_WRITE 冒烟"}` 202 → 有界轮询到 done → 用户 `content` 恰为所发文本、助手 `content` 匹配 `content_pattern`、恰一个 done 的 `write` 步骤。原第 6、7 步的注释标号顺延为 7、8，页头注释同步。两个 POST 与 `GET /api/commands` 不带 retry。验证：design「Required evidence」H1–H4
- [ ] 10.6b `web/e2e/ui-walk-sessions.spec.ts`：`step9Search` 与 `step11Delete` 之间加 `step10Slash`——`/` → `命令候选` 恰两项 `整理上下文`、`任务清单`；`/t` → 恰一项；`Enter` → 草稿 `/todo `、未发送；`Enter` 发送 → 用户气泡 `/todo`、助手正文恰为 omp 原文、无步骤卡、无审批条、composer 解锁；`/session` 无候选 → `/session WORKBUDDY_WRITE <uuid2>` 无候选 → `Enter` → 气泡原文、`write` 步骤 `已完成`、固定回复；REST 回读。`finally` 不改。验证：design「Required evidence」U1–U6

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `make smoke`、`make ui-walk` 的内容变长；配方与文件集合不变 → H1、U1、G1 |
| Legacy compatibility / examples | yes | 冒烟第 1–5、7、8 步与走查第 1–9、11 步不被削弱 → H1、U2、U5 末项、G2 |
| Concurrency / shared state / ordering | yes | 候选目录懒加载与 `Enter` 的先后；上一回合 done 之后才发下一条；重跑 → H1（两次）、U3、UN4 |
| Error handling / rollback / partial outputs | yes | 走查失败路径的清理；hurl 中途失败不重试 POST → U5 的残留清点、H3、H4 |
| Schema / columns / units / field names | yes | `commands` 的 `name` / `source`、`userMessageId` / `assistantMessageId`、`steps`、`content` 的逐字值 → H3、U5 |
| Resource limits / large input / discovery | yes | 每测试 30 s；轮询有界（约 20 s，低于 60 s 自动允许）→ H1、U2、U3、U6 |
| Accessibility / keyboard / focus | yes | `listbox` / `option` 按 role 定位；键盘选中；焦点不离开输入框 → U3、UN3、UN4 |
| Auth / permissions / secrets | no | 无新的权限面 |
| File IO / path safety / overwrite | no | `workbuddy-report.html` 的写入路径是既有行为 |
| Config / project setup | no | Makefile、Playwright 配置零 diff |
| Release / packaging / dependency compatibility | no | 无新依赖 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 改动只有 `smoke/session-meta.hurl` 与 `web/e2e/ui-walk-sessions.spec.ts`；其它被跟踪文件零 diff。
- [ ] 没有 RED 阶段；负对照逐条记录失败所在的条目 / 步骤。
- [ ] design E 节列的门禁全部退出 0；`openspec validate harness-slash-whitelist --strict --no-interactive` 通过。
- [ ] 实测时长（`make smoke` 一次运行、新旅程两个 project、CI）写进 PR。
