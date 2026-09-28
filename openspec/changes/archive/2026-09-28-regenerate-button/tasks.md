# Tasks: regenerate-button（#478）

## 7. chat-web（父 tasks 7.3a 原文）

- [ ] 7.3a `message-actions.tsx` + `page.tsx`/`turn-actions.ts` + `conversation-view.tsx`：末条助手消息 `重新生成`（Icon `refresh-cw`；会话 done/failed/stopped 时可用；恰调一次，Toast `正在重新生成…`，对账后旧回答被替换）。验证：新建 jsdom 测试文件覆盖可用性三态、恰调一次与 409/502/503 失败分支
- [ ] （本 fixture 追加，carry-forward :112）放宽 `conversation-view.tsx:114` 的操作条条件：空正文的可重新生成末条（含 stopped）有操作条且只含 `重新生成`；空正文不出 `复制`。验证：design R1(b)(c)、R2
- [ ] （本 fixture 追加，见 proposal 偏离 1）regenerate 锁是 `page.tsx` 中的独立状态，每个分支按身份释放；不写 prompt 的 mutation 字段；`turn-actions.ts` 不新增 hook。验证：design R3 末段、R5、R7、R10，G1
- [ ] （本 fixture 追加，#477 review lesson 1）202 与 GET 两段各自经 `ownsSessionWrite` 围栏后才写 UI、关闭或打开 source；Toast 由 handler 结果门控。验证：design R8、R9、R11、R12
- [ ] （本 fixture 追加，见 proposal 偏离 3、4）202 后 GET 失败走 prompt accepted 失败语义且锁已释放；regenerate 在途时 `停止` 的 204 不打断对账（carry-forward :101 只记录）。验证：design R5、R6

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 首个消费 `POST /api/sessions/:id/regenerate` 的 UI：POST、无 body、只打当前会话路径，202/409/400/502/503 各分支 → R3、R4 |
| Concurrency / shared state / ordering | yes | 两段异步跨切会话、续期、卸载；与在途 prompt、stop、另一会话 regenerate 交错；锁按身份释放 → R6、R7、R8、R9、R10、R11、R12 |
| Error handling / rollback / partial outputs | yes | 失败信封内联并解锁、转录不变、无 Toast；202 后 GET 失败不卡死；无本地合成的半成品行 → R3、R4、R5 |
| Legacy compatibility / examples | yes | 操作条条件放宽，`复制` 的 DOM 与行为、`已停止` 呈现、助手块结构是既有测试锚点 → R2、G2、G3，design「Must preserve」「Sibling surfaces」 |
| Auth / permissions / secrets | yes | regenerate 只打当前 client 与选中会话；续期后旧 client 的迟到结果不写 UI；401 走既有登录交接（`isUnauthorized` 分支不写 UI，经代码审查）；owner 校验在 server（#467） → R8、R11、R12 |
| Config / project setup | no | 无配置变化 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 只消费 #472 已定形的 `regenerateSession` 返回值，且不使用 `assistantMessageId`；`session-contract.ts`、`api-sessions.ts`、`stream.ts` 零 diff |
| Resource limits / large input / discovery | no | 无计时器、无新增上限；每次点击至多一个 POST 加一个 GET → R3 |
| Release / packaging / dependency compatibility | no | 无依赖变化；`refresh-cw` 已由 #477 注册 |
| Documentation / migration notes | no | 无迁移；架构文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `message-actions.tsx`、`conversation-view.tsx`、`turn-actions.ts`、`page.tsx`。`api-sessions.ts`、`api.ts`、`session-contract.ts`、`stream.ts`、`stream-approvals.ts`、`types.ts`、`ownership.ts`、`composer.tsx`、`approval-bar.tsx`、`icon.tsx`、CSS、server、Makefile、CI、e2e 零 diff。
- [ ] 新测试只写进新建的 `web/test/chat-regenerate-button.test.tsx`（≤800 行）。快照由本文件自建，`chat-stream-support.ts`/`chat-page-support.tsx`/`chat-page-lifecycle-support.tsx`/`chat-page-ownership-support.ts`/`support.ts` 不改。
- [ ] 既有测试零 diff，不增长（design「Sibling surfaces」预期无必然破坏）。实现后若出现破坏，停下上报，不改既有测试。
- [ ] 红/绿：R1–R12 先对 master 跑红，记录失败输出（R1(d)(e)(g)、R2 的否定子断言在 master 上本就成立，由变异守卫，见 design「红/绿」）；G1–G3 为守卫。design「红/绿」列出的变异逐一临时施加，确认对应用例变红，结果记入 PR body。
- [ ] 行数：实测 `wc -l web/src/features/chat/{page.tsx,turn-actions.ts,conversation-view.tsx,message-actions.tsx}` 与新测试文件，记入 PR body；`page.tsx` ≤632，`turn-actions.ts` ≤350。
- [ ] `npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增：`regenerateTurn` 被 `page.tsx` 使用；jscpd ≤3%，围栏复用 `ownsSessionWrite`，GET 失败文案复用 `TERMINAL_REFRESH_GUIDANCE`）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate regenerate-button --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions（GET 失败语义、单槽锁、在途 stop 204、父 turn-control 措辞、`refreshList`）。
