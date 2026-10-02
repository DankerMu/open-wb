# Tasks: artifacts-panel（#537）

## 7. web — 顶栏产物面板 Drawer（父 tasks 7.6）

- [x] 7.6 新建 `artifacts-panel.tsx`（填入 `CHAT_TOPBAR_ACTIONS` 的 `产物面板` 槽（package）→ 按当前视图全部已结束步骤 `changes` 按路径聚合（消息靠后优先、同消息 ordinal 大者优先、位置取首次）；为空 → 只 toast `当前任务暂无产物`；否则右侧 `ui/drawer.tsx` Drawer（宽 420，accessible name `产物面板`），每行同文件变更卡行，可派生扩展名附同名操作按钮（行为同 7.5b）；关闭后焦点还给按钮）+ `topbar-actions.ts` 槽位填充 + `page.tsx` 接线 + 自 `file-changes-card.tsx`、`artifact-card.tsx` 抽出可复用的行与操作（两张卡的 DOM 与行为不变）+ `messages.css`。验证：新建 `web/test/chat-page-artifacts-panel.test.tsx`（P1–P13）；既有测试只改 proposal「偏差」1 的四处

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | 从两张已上线的卡里抽取行与操作；顶栏多一个按钮 → 7.5a/7.5b 两套测试零 diff 全绿（回归网）、P1、P12 |
| Public API / CLI / script entry | yes | 顶栏 `actions` 通道的新槽位；`chatTopbar()` 签名变化 → P1、M15（既有） |
| Concurrency / shared state / ordering | yes | 抽屉打开期间的流式更新、关闭时 abort 在途拉取、切换会话、聚合的次序规则 → P3、P5、P8、P10 |
| Accessibility / focus（归入 Legacy 之外单列） | yes | 抽屉的 Escape 在行内操作之后仍须可用；焦点不丢到 `body` → P13、真实浏览器一次性观察 |
| Error handling / rollback / partial outputs | yes | 空态只 Toast；空间不可解析的降级；行操作的失败路径复用 → P4、P9、P7 |
| Auth / permissions / secrets | yes | html 预览仍只进 `sandbox="allow-scripts"` 的 iframe（复用同一实现，不出现第二个 iframe 出口）→ P7 |
| File IO / path safety / overwrite | yes | 逻辑路径不含空间绝对根；请求只用空间 id 与相对路径 → P2、P7、P9 |
| Resource limits / large input / discovery | no | 聚合是一次线性扫描（每步骤至多 50 项）；不发新请求 |
| Schema / columns / units / field names | no | 不改 DTO |
| Config / project setup | no | 无 |
| Release / packaging / dependency compatibility | no | 不加依赖；`package` 图标已注册 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件 `web/test/chat-page-artifacts-panel.test.tsx`（夹具从 `chat-page-file-changes-support.tsx`、`chat-page-artifact-card-support.tsx` 导入，不改它们；缺的放新文件 `chat-page-artifacts-panel-support.tsx`）；既有测试只改 proposal「偏差」1 的四处。
- [x] RED 集合 = P1–P13 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [x] `page.tsx` 690 → 694（+4：import、`workspace` 常量、hook 调用、`{artifacts.panel}`）；`artifact-card.tsx`、`file-changes-card.tsx`、`topbar-actions.ts`、`messages.css` 的前后行数写进 PR。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 178 不增）、`bash scripts/size-guard.sh` 退出 0；`make ui-walk` 由 CI 的 ui-walk job 覆盖（顶栏多一个按钮后 390px 的既有走查仍须通过）；`openspec validate artifacts-panel --strict --no-interactive` 通过。
