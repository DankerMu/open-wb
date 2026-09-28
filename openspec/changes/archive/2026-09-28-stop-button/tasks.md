# Tasks: stop-button（#477）

## 7. chat-web（父 tasks 7.2 原文）

- [ ] 7.2 `composer.tsx` + `page.tsx`/`turn-actions.ts` + `conversation-view.tsx` + `web/src/ui/icon.tsx`：运行中 `停止` 按钮（aria-label `停止`，Icon `square`；恰调一次 stop，202 → Toast `已停止生成`，204 无 toast）；`square`/`refresh-cw`/`git-branch` 三个 lucide 图标注册进 `icon.tsx`；会话点/步骤徽章/composer 的 `已停止` 文案；status 为 `stopped` 的助手消息正文末渲染 `role="status"` 徽章 `已停止`（accessible name `助手消息 已停止`），正文为空时显示占位 `（已停止生成）`；503 `agent_capacity` 内联文案并解锁 composer。验证：新建 jsdom 测试文件覆盖运行中点停止一次、202/204 两分支、stopped 徽章与空正文占位、容量错误
- [ ] （本 fixture 追加，见 proposal 偏离 2、3）停止键只在自身请求在途期间禁用；任何响应后若视图仍 running 即恢复可点。204 不写视图、不对账。解锁与 `已停止` 呈现只来自 `turn.end stopped` 或快照。验证：design S3、S4、S5
- [ ] （本 fixture 追加，carry-forward :86）恢复 #480 裁掉的三处 `停止` 子句，即本 change 的 chat-web 与 tool-approval delta；并断言有 pending 审批时 `停止` 可用。验证：design S6
- [ ] （本 fixture 追加，见 proposal 偏离 4）无选中会话（欢迎态建会话途中）时 `停止` 渲染为禁用；停止键按会话 key；stop 结果按会话/账号/挂载围栏；stop 不触碰 prompt 的 mutation fence。验证：design S7、S8、S9
- [ ] （本 fixture 追加，见 proposal 偏离 1）`chat.css`/`messages.css` 补 `stopped` 圆点、步骤徽章、消息徽章与停止键样式，只用语义 token。验证：design S13，既有颜色守卫

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 首个消费 `POST /api/sessions/:id/stop` 的 UI：POST、无 body、只打当前会话路径，202/204/错误三分支 → S2、S3、S5、S7 |
| Concurrency / shared state / ordering | yes | stop 与在途 prompt 共存；stop 与 SSE `turn.end`、gap 重装交错；切会话时的在途 stop；审批挂起时停止 → S4、S6、S7、S8 |
| Error handling / rollback / partial outputs | yes | 错误信封内联并恢复可点；204 不写视图；S7 类残局下不卡死；容量 503 不留投机行、恢复草稿 → S3、S4、S5、S12 |
| Legacy compatibility / examples | yes | composer 结构与 `生成中` status 元素是 e2e 与多份既有测试的锚点；发送键在非 running 时不变；三处 allowed-edit 之外零 diff → S1、G2、G3，design「Sibling surfaces」 |
| Auth / permissions / secrets | yes | stop 只打当前 client 与当前选中会话；切会话/续期后迟到结果不写 UI；401 走既有登录交接（只经代码审查：`isUnauthorized` 分支不写 UI）；owner 校验在 server（#475） → S7（切会话）、S7b（续期）、S7c（卸载） |
| Config / project setup | no | 无配置变化 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 只读 #472 已定形的 `stopped` 联合与 `stopSession` 返回值；`session-contract.ts`、`stream.ts`、`api-sessions.ts` 零 diff |
| Resource limits / large input / discovery | no | 无计时器、无新增上限；每次点击至多一个请求 → S2 |
| Release / packaging / dependency compatibility | no | 无依赖变化；三个图标取自已有依赖 `lucide-react` → S11 |
| Documentation / migration notes | no | 无迁移；架构文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `composer.tsx`、`turn-actions.ts`、`conversation-view.tsx`、`page.tsx`、`web/src/ui/icon.tsx`、`chat.css`、`messages.css`（后两者越出 issue 清单，见 proposal 偏离 1）。`stream.ts`、`session-contract.ts`、`stream-approvals.ts`、`api-sessions.ts`、`api.ts`、`errors.ts`、`status-label.ts`、`session-nav.tsx`、`approval-bar.tsx`、`message-actions.tsx`、server、Makefile、CI、e2e 零 diff。
- [ ] 新测试只写进新建的 `web/test/chat-stop-button.test.tsx`（≤800 行）。快照由本文件自建，`chat-stream-support.ts`/`chat-page-support.tsx`/`chat-page-ownership-support.ts`/`support.ts` 不改。
- [ ] 既有测试只允许 design「Sibling surfaces」列出的三处按值改动：`chat-composer.test.tsx:122-146`（C3）、`chat-composer.test.tsx:189`（C5 needle）、`chat-page-lifecycle.test.tsx:357`。三个文件都不得增长行数。实现后若出现清单外的破坏，停下上报，不改其它既有测试。
- [ ] 红/绿：S1–S11 与 S13 先对 master 跑红，记录失败输出。S12 与 G1–G4 为守卫（S12 若在 master 上为红，改标红先行）。design「红/绿」列出的变异逐一临时施加，确认对应用例变红，结果记入 PR body。
- [ ] 行数：实测 `wc -l web/src/features/chat/{page.tsx,turn-actions.ts,conversation-view.tsx,composer.tsx} web/src/ui/icon.tsx` 与新测试文件，记入 PR body；`page.tsx` ≤626，`turn-actions.ts` ≤310。
- [ ] `npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增：`stopTurn` 被 `page.tsx` 使用、`StopButton` 不导出；jscpd ≤3%，stop 围栏复用 `ownsAnswer`）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate stop-button --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions（停止键释放规则、204 被动、S7 类 server 残局、父 turn-control 措辞）。
