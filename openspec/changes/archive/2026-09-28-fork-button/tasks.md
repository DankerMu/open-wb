# Tasks: fork-button（#479）

## 7. chat-web（父 tasks 7.3b 原文）

- [ ] 7.3b `message-actions.tsx` + `page.tsx`/`turn-actions.ts` + `conversation-view.tsx`：用户消息操作条 `从此处分叉`（Icon `git-branch`；恰调一次 fork → 跳转 `?session=<new>` → composer 草稿填 `draft` 不发送）。验证：新建 jsdom 测试文件覆盖跳转、草稿不发送与失败分支
- [ ] （本 fixture 追加，见 proposal 偏离 1）fork 锁是 `page.tsx` 中的独立状态 `forkOwner`，每个分支按身份释放，只进 `composerDisabled`/`sendDisabled`，不进 `generating`；不写 prompt 的 mutation 字段与 `regenerateOwner`；`turn-actions.ts` 不新增 hook。验证：design F2（锁定期无 `停止`/`生成中`、`发送` disabled）、F4、F7，G1
- [ ] （本 fixture 追加，见 proposal 偏离 2、3、4）201 续体先查 `ownsSessionWrite` 与历史令牌 `historyGenerationRef`，通过后在同一同步段内依次 `setDraft` → `refreshList` → `selectSession`；被挡下时只释放锁。验证：design F2、F3、F6、F8、F9、F10
- [ ] （本 fixture 追加，见 proposal 偏离 5）失败只内联信封（网络失败与 201 解析失败为 `请求失败，请稍后重试`）并释放锁；不导航、不改草稿、不刷新列表、不对账。验证：design F5、F6-409、F9-409（201 解析失败无专用页面用例：api 层 `web/test/api-turn-control.test.ts:220` 钉 `requestFailed(201)`，页面层与 F5-network 同一分支）
- [ ] （本 fixture 追加，见 proposal 偏离 6、7）操作行是 user article 的末子元素，CSS 零 diff；design「Sibling surfaces」列出的 4 处既有断言改为按名查询，行数不增。验证：design F1、G2

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 首个消费 `POST /api/sessions/:id/fork` 的 UI：POST，body 恰为 `{messageId}`，只打当前会话路径；201/400/409/502/503 与网络失败各分支 → F2、F3、F5 |
| Concurrency / shared state / ordering | yes | 201 续体跨切会话、ABA、续期、卸载；与在途 prompt/regenerate、另一会话的 fork 交错；锁按身份释放；草稿写入与切会话 effect 的先后 → F2、F4、F6、F7、F8、F9、F10 |
| Error handling / rollback / partial outputs | yes | 失败信封内联、释放锁、草稿与 URL 不变、无对账（server 失败不写行）；无本地合成的新会话行 → F5 |
| Legacy compatibility / examples | yes | 用户 article 新增操作行，推翻 4 处「用户消息无按钮」断言；用户气泡首个 `<p>`、`复制`/`重新生成`/`已停止` 的 DOM 是既有测试与 e2e 锚点 → F1、G2、G3，design「Must preserve」「Sibling surfaces」 |
| Auth / permissions / secrets | yes | fork 只打当前 client 与选中会话；续期后旧 client 的迟到结果不导航、不写 UI；401 走既有登录交接（`isUnauthorized` 分支不写 UI，经代码审查）；owner 校验在 server（#469） → F9、F10 |
| Config / project setup | no | 无配置变化 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 只消费 #472 已定形的 `forkSession` 返回值；`session-contract.ts`、`api-sessions.ts`、`stream.ts` 零 diff（201 fixture 须守严格键集，见 design「Seams under test」） |
| Resource limits / large input / discovery | no | 无计时器，无新增上限；每次点击至多一个 POST，之后是既有选择路径的一次 GET 与一次列表 GET → F2 |
| Release / packaging / dependency compatibility | no | 无依赖变化；`git-branch` 已由 #477 注册 |
| Documentation / migration notes | no | 无迁移；架构文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `message-actions.tsx`、`conversation-view.tsx`、`turn-actions.ts`、`page.tsx`。`api-sessions.ts`、`api.ts`、`session-contract.ts`、`stream.ts`、`stream-approvals.ts`、`types.ts`、`ownership.ts`、`session-path.ts`、`session-nav.tsx`、`composer.tsx`、`approval-bar.tsx`、`icon.tsx`、CSS、server、Makefile、CI、e2e 零 diff。
- [ ] 新测试只写进新建的 `web/test/chat-fork-button.test.tsx`（≤800 行）。快照由本文件自建，`chat-stream-support.ts`、`chat-page-support.tsx`、`chat-page-lifecycle-support.tsx`、`chat-page-ownership-support.ts`、`support.ts` 不改。
- [ ] 既有测试只允许 design「Sibling surfaces」列出的 4 处期望改动（`chat-copy.test.tsx:169`、`chat-regenerate-button.test.tsx:195,210,222`），行数不增。实现后若出现其它破坏，停下上报，不改测试。
- [ ] 红/绿：F1–F10 先对 master 跑红，记录失败输出。否定类子断言在 master 上本就成立，由变异守卫，见 design「红/绿」。G1–G3 为守卫。design 列出的变异逐一临时施加，确认对应用例变红，结果记入 PR body。
- [ ] 行数：实测 `wc -l web/src/features/chat/{page.tsx,turn-actions.ts,conversation-view.tsx,message-actions.tsx}` 与新测试文件，记入 PR body；`page.tsx` ≤645，`turn-actions.ts` ≤400。
- [ ] `npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate fork-button --strict --no-interactive` 通过。
  - knip 零新增：`ForkAction` 被 `conversation-view.tsx` 使用，`forkTurn` 被 `page.tsx` 使用。
  - jscpd ≤3%：围栏复用 `ownsSessionWrite`；若按身份释放与 `regenerateTurn` 重复超限，抽共用小函数，见 design「Change surface」。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions 的裁定结果（ABA 令牌、放置、被挡下的 201 与解析失败不刷新列表、4 处测试改动、carry-forward :107 只记录）。
