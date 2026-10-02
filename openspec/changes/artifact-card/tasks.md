# Tasks: artifact-card（#536）

## 7. web — 产物卡 html/图片/代码按需预览（父 tasks 7.5b）

- [x] 7.5b 新建 `artifact-card.tsx`（同一「已结束步骤按路径去重」汇总与顺序，按扩展名派生：`html` → `globe`/`HTML`/`打开网页预览`/卡脚 `可交互预览` → 点击时 `fetchPreview` → Dialog（标题文件名）内 `<iframe sandbox="allow-scripts" srcdoc title>`，截断时 iframe 上方 `文件超过 1 MiB，仅预览前 1 MiB`；`png`/`jpg|jpeg` → `image`/`PNG`|`JPG`/`下载` → Blob URL 临时链接下载后撤销；`md/txt/log/csv/json/js/ts/tsx` → `file-code`/大写扩展名/`复制代码` → 剪贴板 → toast `已复制到剪贴板`|`复制失败`，截断 → 不写剪贴板 toast `文件过大，无法复制`；其它扩展名不派生；空间不可解析时不渲染；拉取中按钮禁用不并发、卸载/切会话 abort 并撤销 Blob URL；预览失败 toast 信封 message 不开 Dialog）+ `stream-artifacts.ts` 的 `artifactKind` + `conversation-view.tsx` 在文件变更卡之后、`已停止` 徽章之前插入产物卡位 + `page.tsx` 传 `client` + `messages.css` 样式。验证：新建 `web/test/chat-page-artifact-card.test.tsx`（A1–A15）；既有测试只改 proposal「偏差」1 列出的三处期望

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Auth / permissions / secrets | yes | 取回的 HTML 是模型产出的任意内容，在会话页里执行脚本；隔离靠 iframe `sandbox` 恰为 `allow-scripts` → A3 |
| Public API / CLI / script entry | yes | 新增预览 API 的调用点：路径与空间 id 的取值、只在点击时调用 → A3、A5、A6、A9 |
| Concurrency / shared state / ordering | yes | 拉取中禁用与不并发、卸载/切会话/换账号时 abort、迟到响应的 Blob URL → A10、A11、A12 |
| Error handling / rollback / partial outputs | yes | 404/415/413/网络错误/类型不符/截断/剪贴板失败，各自的 Toast 与「不做什么」→ A4、A7、A8、A9 |
| Legacy compatibility / examples | yes | 文件变更卡与助手块其余部件的行为和次序、`复制` → A13、既有套件 |
| File IO / path safety / overwrite | yes | 请求用空间内相对路径与会话空间 id；绝对 `root` 不进任何文本、属性与请求 → A2、A5 |
| Resource limits / large input / discovery | yes | 1 MiB 截断：html 提示、代码不复制；图片过大由服务端拒绝（413）→ A4、A7、A8 |
| Schema / columns / units / field names | no | 不改任何 DTO；`FilePreview` 原样消费 |
| Config / project setup | no | 无 |
| Release / packaging / dependency compatibility | no | 不加依赖；图标均已注册 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件 `web/test/chat-page-artifact-card.test.tsx`（需要的夹具从 `chat-page-file-changes-support.tsx` 导入，不改它；缺的放新文件 `chat-page-artifact-card-support.tsx`；评审后追加的 H2–H6 在新文件 `chat-page-artifact-card-state.test.tsx`）；既有测试只改 proposal「偏差」1 的三处。
- [x] RED 集合 = A1–A15 中依赖新行为的用例；实现前就成立的护栏逐条标出。实现前后各跑一次并记录命令与结果。
- [x] `page.tsx` 689 → 690；`conversation-view.tsx`、`messages.css`、`stream-artifacts.ts` 的前后行数写进 PR。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 178 不增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate artifact-card --strict --no-interactive` 通过。
