# Tasks: s1f-files-page

> 前置：change `s1f-session-list-temp-space`（C）与 `s1g-composer-capabilities`（S1g）已归档——主规格里已有它们的文本。归档次序固定为 C → S1g → 本 change。
> 本 change 与它们同名的 MODIFIED 以「主规格 → C → S1g」叠加后的文本为底（design D25 的重叠表，十三条）；组 0 在开工前与归档前各核对一次，不拿本 change 里抄下来的旧文本覆盖别的 change 的修改。
>
> 依赖（边表；边写到任务粒度。「A ← B」读作「A 的前提是 B」。没有列出的任务之间不互相等待；同一组内除另有说明外按编号顺序）：
> - **规格对底**：0.1 没有前提；组 2–28 的每个任务 ← 0.1（两个 CLI 的 validate 可在 CI 外机械验证）。0.2 在归档之前。
> - **前置实测**（三项互相独立，各自只挡点名的任务）：
>   - 1.1 挡：19.2 的 PDF 与办公文档部分、19.3 的「PDF 与办公文档」三个场景、19.4 的 pdf 与办公文档行、28.6。
>   - 1.2 挡（只有执行 `rename` 的实现及其路由测试）：8.1 的 `moveToTrash` 半边、8.2、8.3 的 `workspaces-delete.test.ts`、9.1、9.2。8.1 的 `sweep` 半边（`createTrash` 的目录校验 + `sweep` + `workspaces-trash-sweep.test.ts`）不做跨 uid 的 `rename`，不等 1.2；9.3–9.4（下载）不等 1.2。
>   - 1.3 挡：28.2、28.6（只是记录的来源；不挡组 14——终止转换的做法已定）。
> - **#1286 不挡任何任务**（owner 裁决 2026-10-09，design D22「已知残余」、D32 的 D-23）：检查之后按路径操作的替换窗口登记为已知残余，本 change 不闭合。8.1 的 `moveToTrash` 半边、8.2、9.1、9.2 与 13.1 都不等它（前四项仍等 1.2，已有结论）。
> - **文件页首刀**：2.1 与 2.2 互不依赖；3.1–3.5 同刀，整刀 ← 2.1（预览的 `data-slot` 已定）与 2.2（`CreationMenu` 已搬进 `tree.tsx`）；3.4 把 2.1、2.2 的两个单文件登记换成目录。组 2、3 不依赖任何服务端任务。
> - **服务端**：
>   - 4.1 → 8.2、9.1（`delete` / `move` 两个 `op`；9.3 的下载用既有的 `read`，不等组 4）。
>   - 5.1 → 6.2 中 `ServerConfig` 上限的接入、10.3、11.2、13.1、15.1（读配置键的任务；6.1、7.1、7.2、8.1、10.1、10.2、11.1、12.2、14.1–14.4 以参数收值，不等组 5）。
>   - 6.1 → 6.2 → 6.3；6.1 → 7.3（`rangeable` 类别）、12.1（`limits` 类型）；6.2（`limits` 依赖对象）→ 10.3。
>   - 7.1 → 7.2 → 7.3 → 7.4；7.2 → 12.1（区间发送函数）。
>   - 8.1 的 `moveToTrash` 半边 → 8.2 → 8.3 的 `workspaces-delete.test.ts`；8.1 的 `sweep` 半边 → 13.1（入口只启动清理定时器）。
>   - 9.1 → 9.2；9.3 → 9.4（两半互不依赖）。
>   - 10.1、10.2 → 10.3 → 10.4 中路由层的用例；10.6 ← 10.1，10.6 → 10.3。
>   - 11.1 → 11.2 → 11.3；11.4 ← 8.2、9.1、9.3、10.3、11.2（表驱动测试覆盖的五条路由；组 11 只有这一个任务依赖组 8、9、10）；11.5 的最后一条变异随 11.4。
>   - 12.2 → 12.1；12.1 ← 6.1、7.2、11.1。
>   - 13.1 ← 5.1、8.1 的 `sweep` 半边、11.2（`assembly.preview`）、12.1；13.1 → 13.2。
>   - 14.1（连同 14.4 的假可执行文件）→ 14.2、14.3 → 14.5；14.7 ← 14.1，14.7 → 14.5、15.1；组 14 不依赖组 13。
>   - 15.1 ← 5.1、11.2（`officeAvailable`）、12.1、13.1、14.1–14.3、14.7；15.1 → 15.2。
> - **前端**：
>   - 16.1 按方法：地址函数 `fileUrl`、`downloadUrl` ← 9.3，`listArchive` ← 10.3；16.2 按方法：`issuePreviewToken` ← 11.2，`moveEntry` ← 9.1，`deleteEntry` ← 8.2；16.3 ← 6.1。
>   - 17.1 ← 3.1–3.5；17.2 ← 17.1、16.1 的地址函数、6.2（未知扩展名由服务端嗅探）；17.3 ← 17.1、3.5；17.4 ← 17.1、6.1。
>   - 18.1 ← 17.1；18.2、18.3 ← 17.1、6.1；18.4 ← 17.1、16.3。
>   - 19.1 ← 16.2 的 `issuePreviewToken`；19.2 的网页渲染视图 ← 17.2、19.1、13.1（入口已启动预览监听器）；19.2 的 PDF 与办公文档部分另 ← 1.1、15.1。
>   - 20.1 ← 17.1、16.1 的地址函数、7.3；20.2 ← 17.1、18.1、6.1；20.3 ← 17.1、16.1 的 `listArchive`。
>   - 21.1 ← 17.2；21.2 ← 21.1。
>   - 22.1、22.2、22.3 ← 21.1、16.2 的 `moveEntry`；22.4 ← 21.1、16.2 的 `deleteEntry`；22.5 ← 21.2，随 22.1 合入。
>   - 23.1 只 ← 0.1；23.2–23.6 ← 23.1、21.1。
>   - 24.1–24.3 ← 23.2；24.4 的「同一套组件与操作」场景与 24.5 的第三行（回合进行中删除 / 重命名）另 ← 22.1、22.3、22.4。
>   - 25.1 ← 23.2；25.2 ← 25.1 的 `reveal` 回调、19.2 的网页渲染视图、16.1 的地址函数；25.5 ← 24.2、19.2 的网页渲染视图。
> - **冒烟与走查**：
>   - 26.1 只 ← 0.1；26.2 按步骤：范围请求 ← 7.3，下载 ← 9.3，`preview-token` 与隔离来源的步骤 ← 13.1，重命名 / 删除 / 同名移动 409 / 越界删除 403 的步骤 ← 8.2、9.1。
>   - 27.1 按步骤：(a) ← 18.1、21.2、26.1；(b) ← 19.2 的网页渲染视图、26.1；(c) ← 20.1、26.1；(d) ← 17.2；(e) ← 21.2；(f) ← 22.1、22.4。27.3 ← 组 3、17–22 的 FL 行。
> - **文档**：组 28 最后；28.1 引用 1.2 的结论，28.2 ← 1.3，28.6 ← 1.1、1.3、15.1。
>
> 由上表推出的三句话（改了边就同步改这里）：
> - 等 VPS 实测 1.2 的只有：8.1 的 `moveToTrash` 半边、8.2、8.3 的删除路由测试、9.1、9.2，以及经它们传递的 11.4（与 11.5 的最后一条变异）、16.2 的 `moveEntry` 与 `deleteEntry`、22.1–22.8、24.4 的「同一套组件与操作」场景与 24.5 的第三行、26.2 的重命名 / 删除步骤（连同 26.3、26.4 里针对它们的验证）、27.1 的 (f)、27.3、组 28。
> - 其余全部不等 1.2：组 2–7、8.1 的 `sweep` 半边、9.3–9.4、组 10、11.1–11.3、组 12–15、16.1、16.2 的 `issuePreviewToken`、16.3、组 17–21、组 23、24.1–24.3 与 24.4 的其余场景、组 25、26.1 与 26.2 的其余步骤、27.1 的 (a)–(e)。其中等 1.1 的只有 19.2–19.4 的 PDF 与办公文档部分；1.3 不挡任何代码任务。
> - 文件页首刀（组 2、3）不依赖任何服务端任务与任何实测，可与组 4–15 并行。
>
> 通用纪律：
> - 每组一个小 PR（按各组的 `Minimal mergeable slice`），合入后 `make check`、`make test-guardrails`、`make ui-walk`、`make smoke` 全绿、主干可运行。
> - 分层守卫：`web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 与清单断言两处同步改。组 3 起 `web/src/features/files` 整目录在清单里；`web/src/features/chat/` 下新增的 `.ts`/`.tsx` 在同一 PR 逐个登记。
>   已迁移文件从 `web/src/ui` 只可导入 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`，不得导入 `useToast`。`web/test/chat-module-layout.test.ts` 的导入方向不变（`page.tsx → use-chat-session.ts → turn-actions.ts`）。
> - 拷入层（`web/src/components/ui`、`web/src/components/assistant-ui`）：只新增 `resizable`（组 23），且只做 ADR-0013 的六类修改；既有拷入文件不动。`web/src/ui/**` 冻结区不动、不加图标。
> - 门槛：knip（不留未引用导出）、jscpd、单文件 800 行（`web/src/lib/api.ts` 778 行不再加方法；`web/src/lib/md-render.ts` 797 行不改；`web/e2e/ui-walk-sessions.spec.ts` 681 行与 `web/e2e/ui-walk-layout.ts` 793 行不加行，
>   新走查步骤写进新 helper 文件；`server/src/workspaces/rest.ts` 的新路由放进新文件）、覆盖率 80%。
> - 代码分割只在 `web/src/features/files/previewers/index.ts`（组 17 起有守卫）；`vite.config.ts` 不加 `manualChunks`。
> - 一切用户给的路径过 `sandbox.resolve`；属他人与不存在的工作空间 id 一律是相同的 404 且先于路径检查；越界必写 `sandbox.reject`。
> - 既有断言只要还有意义就不删除、不削弱；随条文改写的断言在 PR 的偏离记录里逐条列出。
> - 既有断言的盘点：组 2、3 与其后各「删除 / 替换 / 搬家」类任务里点名的 `文件:行`，是写作时（C、S1g 尚未实现）在仓库里 `grep` 的结果；C、S1g 归档后行号与个别用例会变。每一刀开工时先重跑该任务给出的 grep，
>   命中而未被点名的依赖按同一规则（等价改写 / 随条文删除 / 旧名暂留）在**让它变红的那一刀**里处置并记入偏离记录，不留到后一个 PR。
> - 预览正文的断言一律异步取：组 17 起每类预览器都经动态 `import()` 首次加载，凡经 `PreviewPane` / `WorkspaceBrowser` / 页面渲染后取预览正文（表格、源码行、标题、`img`、`iframe`、成员列表等）的断言——新写的与改写的都算——用 `await screen.findBy…` 或 `await waitFor(…)`，
>   不在 `render`、`rerender` 或点击之后同步 `getBy…` / `querySelector`，也不靠预热加载函数（唯一例外是 18.1 点名的那条「没有 `act` 之外的更新」用例，理由见该任务）。测试文件静态导入某个预览器模块并直接渲染它时不经加载函数，模块自身同步渲染的内容可以同步断言。假定时器生效期间 `findBy` / `waitFor` 的轮询会挂住，改用 `await act(() => vi.advanceTimersByTimeAsync(n))` 推进后同步断言。
> - 用户可见的变化在 `docs/acceptance/functional-checklist.md` 增改对应行，结论一律 `待签`，agent 不代签；行里不写带单位的像素值与点号、井号开头的选择器（守卫会拒；回收目录、环境文件这类点开头的名字用文字描述）。
> - 每条行为任务给出变异证据（去掉或写反实现时哪条测试判红），写进 PR 描述。
> - 公开仓库：被跟踪文件里不出现主机绝对路径、用户名、IP 或密钥；测试 VPS 的地址只在本机未跟踪的注记里。
> - 新增依赖在引入它的那个 PR 里登记 `ATTRIBUTION.md`（包名、许可证）。

## 0. 规格对底（归档顺序 C → S1g → 本 change）

- [x] 0.1 C 与 S1g 归档之后、本 change 的任何代码组开工之前：对 design D25「重叠表」里的十三条，逐条把本 change 的 delta 文本与当时 `openspec/specs/**` 里的同名条文做句子级 diff
  （http-service-skeleton「服务启动与装配」「统一错误信封」「Shared agent module assembly」、sandbox-core「resolve 契约与逃逸向量」、chat-web「会话页」、session-sidebar「会话条目菜单与重命名」、spa-shell「路由 IA 与侧栏」、
  ui-foundation「组件分层」、chat-harness「UI 走查会话元数据」「UI 走查临时空间、撤回与归档」、turn-artifacts「文件变更卡」「产物卡」，以及被移除的「产物面板」）。
  diff 里只允许出现该表「本 change 的增量」列所列的新增句、新增场景与改写场景；出现别的差异（C 或 S1g 在实现期改过条文、或本 change 漏了它们的句子）就先改本 change 的 delta 与 D25 的表，再继续。
  同时核对绝对计数与当时的主规格相符：配置项 = 主规格的项数 + 12、归属身份 = 主规格的条数 + 2、错误码不变、`op` 集合 = 主规格的集合加 `delete` 与 `move`；同一条文内正文与场景的计数、枚举一致。
  表外另核一处：ui-primitives「按钮单一实现与旧类退役」（底本是主规格，不属重叠）的场景「迁移后行为不回归」引用了 C 的 session-sidebar「分组侧栏」与 ui-foundation「组件分层」对 `新建会话` 的规定——确认当时主规格里这两条仍是「名称与行为不变」「`session-sidebar.tsx` 在已迁移清单里」，且主规格的 ui-primitives 该条没有被 C / S1g 改过。
  每条 MODIFIED 保留主规格该条文现有的全部场景标题。验证：`$HOME/.nvm/versions/node/v24.13.1/bin/openspec validate s1f-files-page --strict --no-interactive` 与 `$HOME/.local/bin/openspec validate s1f-files-page --strict --no-interactive` 都通过且 ERROR 为 0。
  实施注记见 `implementation-notes.md`「0.1（#1049）」。
  核对记录（#1049，2026-10-09，底本为 C 归档于 #980、S1g 归档于 #1047 / PR #1284 之后的主规格，合并提交 `7e0e6d3`）：D25 表十三条（十二条 MODIFIED 与被移除的「产物面板」）的表头全部命中主规格，本 change 另十四条 MODIFIED 的表头同样命中、35 条 ADDED 的表头在主规格里都不存在（预期归档输出 +35、~26、-1）；十三条与主规格的句子级差异只有 D25「本 change 的增量」列所列内容，外加一处表里漏列的本 change 自己的增量——「服务启动与装配」失败记录 `reason` 枚举的 `preview_cache` / `preview_listen` 一句（#1203 对齐时加入），已补进 D25 的表，delta 无需修改。与 S1g 同名的五条（chat-web「会话页」、http-service-skeleton 三条、sandbox-core「resolve 契约与逃逸向量」）带着 S1g 已交付的全部句子与场景；C 在实现期改过的各处（启动失败 `reason` 枚举与场景「启动失败记录带失败阶段」等）也都在。26 条 MODIFIED 的场景标题集合都是主规格同名条文的超集。计数：主规格为二十三项配置、十五条归属身份、十六码、`op ∈ {read, list, mkdir, write}`、迁移回执到 042；本 change 为三十五项（+12）、十七条（+2）、十六码（不变）、`op` 加 `delete` 与 `move`，不新增迁移；同一条文内正文与场景的计数、枚举一致。表外一处：主规格 session-sidebar「分组侧栏」仍写「既有的 `新建会话` 按钮（名称与行为不变）」，ui-foundation「组件分层」的场景「会话页迁移终态」仍把 `session-sidebar.tsx` 列在已迁移清单里，ui-primitives「按钮单一实现与旧类退役」自本 change 起草以来未被 C / S1g 改过。本 change 独自修改的十四条的主规格底本自起草以来逐字未变。两个 openspec CLI（1.3.1 与 1.13.2）的 `validate --strict` 都通过，0 个 ERROR。文首所列行数的现值（已同步进文首与 design）：`web/src/lib/api.ts` 778、`web/src/lib/md-render.ts` 797、`web/e2e/ui-walk-sessions.spec.ts` 681、`web/e2e/ui-walk-layout.ts` 793、`server/src/workspaces/rest.ts` 416。
- [ ] 0.2 本 change 归档之前：用当时的主规格把 0.1 再做一遍（期间主规格若又被别的 change 改过，以当时的为准），diff 里仍只允许出现 D25 表里列的增量。

Suggested fixture level: none - 只核对与修正规格文本，不改运行时代码
Minimal mergeable slice: 0.1 一刀（有差异才产生 PR）；0.2 随归档

## 1. 前置实测（不产出产品代码）

- [x] 1.1 PDF 内置查看器的可用性（design D16）。Depends on：无。挡住：组 19 中 PDF 与办公文档的部分、28.6。写一个一次性的本地页面（不入库），从端口 A 的页面以不带 `sandbox` 属性的 `iframe` 加载端口 B 上以 `Content-Type: application/pdf`、`X-Content-Type-Options: nosniff`、
  `Content-Security-Policy: frame-ancestors <A 的来源>` 返回的 PDF。在桌面 Chromium 与 Firefox 各看一次：查看器是否出现、能否翻页；再给响应加上 CSP `sandbox` 看一次以确认「加了就不行」。
  结果（浏览器版本、三种情况的现象）写进 `design.md` D16 下的「实测」小节。两个确定的分支：与设计相符 → 组 19 照规格实现；任一浏览器不显示 → 停下回 owner，组 19 的 PDF 与办公文档部分不开工，不自行改用 `<object>`、`<embed>` 或 pdf.js。
- [x] 1.2 应用用户移动 omp 用户创建的条目（design Risks）。Depends on：无。挡住：8.1 的 `moveToTrash` 半边、8.2、8.3 的 `workspaces-delete.test.ts`、9.1、9.2（执行 `rename` 的实现与它们的路由测试；8.1 的 `sweep` 半边与 9.3–9.4 的下载不在内）。在测试 VPS 的 uid 分离部署上，让助手用写文件工具与 `bash` 各建一个文件与一个含子目录的目录，随后以应用用户身份把它们 `rename` 到同一文件系统下应用用户持有的 `0700` 目录里、再移回。
  记录是否成功、失败时的 errno 与该条目的 mode，写进 `design.md` D22 下的「实测」小节。两个确定的分支：按 ADR-0010 规定的 `2770` 与 umask `007` 建出的条目都能移动 → 与设计相符，上述被挡的任务开工（被助手改掉组写位的条目移动失败属规格已定的 500，记入 ADR-0014 运维一节）；
  正常条目也移动失败 → 停下回 owner，上述被挡的任务不开工（其余任务不受影响）。
- [x] 1.3 sudo 模式下的 LibreOffice（design D18，owner D-21）。Depends on：无。挡住：28.2、28.6（只是记录的来源；不挡组 14——终止转换的做法已定）。在同一台 VPS 上安装 LibreOffice，加上 D18 的 sudoers 行，手工执行 D17 的命令行转换一份 docx：
  确认输出生成、转换进程的 `Uid` 为 omp 用户、两个并发转换（各自的 `UserInstallation`）都成功；再对一份转换中的大文件杀掉 `sudo`，观察并记录是否有以该作业目录为参数的进程残留（进程名、是否自行结束）。
  结果写进 `design.md` D18 下的「实测」小节，供 28.2 写进 ADR-0010 增补。转换跑不通（sudoers 行不够、`setpriv` 不可用）时停下回 owner。

Suggested fixture level: none - 只产出实测记录，不改运行时代码
Minimal mergeable slice: 三项各自独立，可分别记录、分别成 PR（只改 `design.md` 的「实测」小节）；任一项的结果与设计不符都先回 owner

## 2. files-web — 首刀 a：预览面板与对话框换底座

- [x] 2.1 `web/src/features/files/preview.tsx`：改用 `components/ui` 的 `button` 与 Tailwind 类重写 `PreviewPane`、`CsvTable`、`CodeView`，行为与今天完全相同（十二个扩展名、不支持态、截断提示、Markdown 模式切换，文案逐字不变）。
  从 `web/src/ui` 只留 `Icon`：冻结区的 `Button`、`EmptyState` 不再导入（不支持态的标题与副行自己用 Tailwind 渲染），不再使用 `files-*`、`ui-alert`、`ui-muted` 类名。把该文件单独登记进 `MIGRATED_AREAS`（目录整体在 3.4 登记）。
  稳定定位（测试与走查按这些名字取元素；名字在此定死，组 17 把预览搬进 `previewers/` 时原样带走）：预览头 `data-slot="preview-header"`，其中路径 `preview-path`、元数据 `preview-meta`；源码、表格、Markdown 渲染三个滚动容器分别是 `preview-code`、`preview-table`、`preview-markdown`，都带 Tailwind 的 `overflow-auto`
  （`preview-markdown` 同时保留既有的 `data-markdown-body` 属性）；不支持态的块 `empty-state`，其副行 `empty-state-desc`。
  Markdown 排版：`files-md` 类去掉后，列表符号与缩进、标题字重（今天由 `web/src/styles/legacy.css` 的三条 `.files-md :is(…)` 规则从 preflight 手里还原）与其余排版（`files.css` 的 `.files-md …` 规则）改由 `preview-markdown` 容器上的 Tailwind 后代变体给出；`web/src/lib/markdown-view.tsx` 不改，`preview.tsx` 仍经它渲染。
  **`.files-md` 的去留**：全仓只有 `preview.tsx` 给元素加这个类（`grep -rn files-md web/src` 只命中 `preview.tsx`、`files.css`、`legacy.css`；会话页不用它，`web/test/chat-steps.test.tsx` 只是断言 `legacy.css` 里有这条规则）。这一刀删掉 `legacy.css` 里那三条规则及其注释；
  `files.css` 里预览相关的规则（含 `.files-md …`）成为没有元素命中的死规则，原样留到 3.3 随文件删除——3.3 点名的、读 `files.css` 规则体的断言在此期间照常通过。
  同刀处置的既有断言（写作时 `grep -rnE 'files-(preview|code|table|md|image)|ui-empty-state|ui-btn' web/test web/e2e` 里由 `preview.tsx` 渲染的全部命中；逐条记入偏离记录）：
  - `web/test/preview.test.tsx`：`:159` 的 `.files-preview-meta` → `[data-slot="preview-meta"]`；`:496`、`:515` 的 `.ui-empty-state-desc` → `[data-slot="empty-state-desc"]`（断言的文本不变）；
    `:195-204` 的 `styles the 查看源码/渲染视图 toggle as a secondary ui-btn in both modes` 现在断言两种模式下按钮的 `className` 恰为 `ui-btn ui-btn--secondary ui-btn--md`——按本 change 改写后的 ui-primitives「按钮单一实现与旧类退役」场景「迁移后行为不回归」改为：
    两种模式下按钮的可访问名分别为 `查看源码` / `渲染视图`、`type="button"`，且 `className` 不含 `ui-btn`。其余用例（安全 Markdown、行号、CSV 注记、深层结构生命周期、修改时间格式；按 `[data-markdown-body]`、`table` 与角色定位）原样通过。
  - `web/test/files-page.test.tsx:506-512`：`.files-preview-toolbar` / `.files-preview-path` / `.files-preview-meta` → `[data-slot="preview-header"]` / `[data-slot="preview-path"]` / `[data-slot="preview-meta"]`，断言的图标、路径与元数据文本不变。
  - `web/test/files-empty-layout.test.tsx:71-73`（E2 的不支持态）：`emptyStateOf(unsupported)?.querySelector(".ui-empty-state-desc")` → `unsupported.closest('[data-slot="empty-state"]')` 之内的 `[data-slot="empty-state-desc"]`，文本不变。
    同文件 `:21-25` 的 `emptyStateOf` 帮手（按 `.ui-empty-state` 取）这一刀不动——它还服务于 `tree.tsx` / `page.tsx` 的三处空态（`:39`、`:48`、`:82`），到 3.1 才改。
  - `web/test/chat-steps.test.tsx:148`：`expect(styles).toContain(".files-md :is(ul, ol)")` → `expect(styles).not.toContain(".files-md")`（C 的 15.6 若已随 `chat.css` 删掉这条用例，则无事可做，以开工时的 grep 为准）。
  - `web/e2e/ui-walk.spec.ts`：`:244` 的 `preview.locator(".files-code")`、`:253` 的 `preview.locator(".files-table")` → `[data-slot="preview-code"]` / `[data-slot="preview-table"]`；
    `:233-239` 的「`readme.md` 的列表符号不为 `none`」断言**原样保留**（它现在证明 Tailwind 的还原生效；去掉还原这条就红），只改 `:232` 那行说它靠 `legacy.css` 的注释。该文件 594 行，改写不增行。
  核对过、这一刀不受影响的（开工时确认仍成立）：`web/test/chat-messages.test.tsx:185-187`（`preview.tsx` 含 `MarkdownView`、不含 `function renderBlock`）；`files-page.test.tsx:537-541`（`preview.tsx` 含 `fileIcon(`、`formatSize(`）；
  `files-empty-layout.test.tsx:174-181` 与 `ui-tokens.test.ts:76-88` 读的 `files.css` 规则（暂留）；`files-empty-layout.test.tsx:190-194`；走查 `ui-walk-layout.ts:304-311` 的 `.ui-btn` 探针（它在选中文件之前运行，取到的是 `新建`，不是 `查看源码`）。
  实施注记见 `implementation-notes.md`「2.1（#1076）」。
- [x] 2.2 `web/src/features/files/dialogs.tsx`：`新建工作空间`、`新建文件夹` 两个对话框改用拷入层 `dialog`、`input`、`label`、`button`；文案、校验、409 映射、忙碌态、取消中止与焦点规则不变。单独登记进 `MIGRATED_AREAS`。
  五个定点（都是既有断言依赖的）：前四个是属性与元素的选择，`DialogContent` 上显式传 `aria-modal="true"`（拷入的 `dialog` 不自带，冻结区 `Dialog` 是自己补的；`files-overlays.test.tsx:75`、`:124` 与 files-web「创建浮层的焦点时序与模态清理」断言它）；遮罩用拷入层自带的 `data-slot="dialog-overlay"`；
  右上的 `关闭` 用拷入层自带的关闭按钮（可访问名 `关闭`）；`位置` 仍是原生 `<select>`（拷入层没有 `select`，本 change 不新拷入；走查 `ui-walk.spec.ts:288` 的 `getByLabel("位置").selectOption(…)` 依赖它）。
  第五个定点——挂起期的焦点：请求挂起的上升沿（`pending` 由 false 变 true 的那次提交，用 layout effect，与禁用 `创建` 同一次 commit）若焦点已丢失（活动元素是 `body`，或是对话框内已被禁用的控件——与冻结区 `useBusyFocusRescue` 的判定相同），`dialogs.tsx` 显式把焦点移到 `[data-slot="dialog-close"]`；焦点在对话框内仍可用的控件上时不动。
  不能照搬冻结区的「内容内首个可用控件」：冻结区 `Dialog` 把 `关闭` 放在标题行、内容最前（`web/src/ui/dialog.tsx:164-171`），救回逻辑 `useBusyFocusRescue`（`:68-81`）取首个可用控件正好是它；拷入层 `DialogContent` 把关闭按钮放在 `children` 之后（`web/src/components/ui/dialog.tsx:61-70`）且没有任何救回逻辑，首个可用控件会是表单里的输入框或 `位置`。拷入层文件不改，这段逻辑写在 `dialogs.tsx` 里。
  证明它的既有断言（原样保留，不改）：`web/test/files-overlays.test.tsx` 的 O4（`:141-160`，`:152` 断言 `新建文件夹` 挂起期活动元素是 `关闭`）、O5（`:162-182`，`:173` 对 `新建工作空间` 断言同一点，`:181` 断言 409 之后焦点仍在对话框内）；走查 `web/e2e/ui-walk.spec.ts:286-301` 的 `createWalkOutWhileHeld`（`:294` 的 `关闭` `toBeFocused`，`:295-298` 的 Tab / Shift+Tab 不出对话框——Chromium 在禁用的当下把焦点移到 `body`，走的是 `body` 分支；jsdom 不移焦点，走的是「已禁用控件」分支，两个分支都要有）；规格依据是 files-web「创建浮层的焦点时序与模态清理」的场景「创建流程焦点闭环」（「挂起期间 `创建` 禁用、焦点在对话框内的 `关闭`」）。
  `CreationMenu`（`新建` 触发器加两项菜单，今天住在 `dialogs.tsx:37-53`，用冻结区的 `Button` 与 `Menu`）**原样搬进 `tree.tsx`**，一行不改，到 3.1 才迁移。原因有二：`dialogs.tsx` 登记后不得再导入 `Button` / `Menu`；
  `新建` 是 `/files` 首屏 `main` 里唯一的 `.ui-btn`，走查的层序探针（`ui-walk-layout.ts:304-311`）读它，探针到 3.5 才换成 `ui-icon`——所以 `新建` 的类名在组 2 不变。
  同刀处置的既有断言（写作时 `grep -nE 'ui-dialog|ui-btn|ui/index|aria-modal' web/test/files-*.tsx` 里由 `dialogs.tsx` 渲染或读其源码的全部命中；逐条记入偏离记录）：
  - `web/test/files-overlays.test.tsx:220-238` 的 O8 用例（`O8 styles 新建, ＋ 新建工作空间, 取消 and 创建 as ui-btn variants`）横跨两刀。**这一刀只改对话框的两个按钮**：`取消`（`:232-234`）与 `创建`（`:235-236`）的 `className` 由「恰为 `ui-btn ui-btn--secondary|primary ui-btn--md`」改为「不含 `ui-btn`」，
    `创建` 仍为 `type="submit"`（`:237`），另补一条「请求挂起期间禁用」（ui-primitives「按钮单一实现与旧类退役」场景「迁移后行为不回归」）。`新建`（`:223`）与 `＋ 新建工作空间`（`:228`）两条断言这一刀**原样保留**（两个按钮仍由冻结区 `Button` 渲染），分别在 3.1、3.2 改；用例标题到 3.2 再改。
  - `files-overlays.test.tsx:133`、`:208` 的 `document.querySelector(".ui-dialog-overlay")` → `[data-slot="dialog-overlay"]`（「点遮罩」的语义不变）。
  - `files-overlays.test.tsx:254-258`（O7 里断言 `dialogs.tsx` 恰有 `import { Button, Dialog, Menu } from "../../ui/index.js"`）→ 断言 `dialogs.tsx` 从 `../../ui/index.js` 的具名导入恰为 `useEscapeFallback`（复用该用例既有的 `primitiveImport` 帮手，不新增动态 `RegExp`；Escape 兜底与会话页对话框同一写法；`Button` / `Dialog` / `Menu` 不得再出现由分层守卫证明）。
    同一用例 `:259-261` 对 `page.tsx` 的导入断言这一刀不动（3.2 改）；O7 的禁用字面量清单（`<dialog`、`role="menu"`、`showModal` 等）原样通过——拷入层源码里没有这些字面量。
  核对过、原样通过的：`files-overlays.test.tsx` 的 O1–O6、O9（「创建流程焦点闭环」「取消类关闭无模态残留」「挂起期点遮罩中止请求」三个场景逐条对照；`expectModalSet` / `expectModalCleared` 读的 `aria-hidden` 与 `body` 的 `pointer-events` 来自 Radix Dialog，新旧相同）、
  `files-errors.test.tsx`、`files-concurrency.test.tsx`、`files-fixture.tsx`（这三个文件没有类名或结构选择器落在对话框上）、走查 `ui-walk.spec.ts:205-219`、`:262-264`、`:286-300`（按角色与标签定位）。
  实施注记见 `implementation-notes.md`「2.2、2.3（#1077）」。
- [x] 2.3 变异证据：把 `新建文件夹` 对话框的初始焦点从 `位置` 挪走 → 焦点闭环用例判红；去掉预览头的 `data-slot` → 修改时间格式用例判红；`查看源码` 改回冻结区的 `Button` → 「`className` 不含 `ui-btn`」判红（分层守卫同时判红）；
  去掉 Markdown 容器上还原列表符号的类 → 走查的「列表符号不为 `none`」判红；去掉 `DialogContent` 的 `aria-modal` → 「初始焦点经受延迟回焦」用例判红；把 `CreationMenu` 留在 `dialogs.tsx` → 分层守卫判红；
  去掉挂起上升沿移焦点到关闭按钮的那段逻辑（或改成聚焦首个可用控件）→ O4、O5 的「活动元素是 `关闭`」与走查的 `关闭` `toBeFocused` 判红。

Suggested fixture level: compact - 两个展示文件换组件库，行为不变，由既有测试逐条对照
Minimal mergeable slice: 2.1 与 2.2 互不依赖，各自一刀，各自合入后 `make check` 与 `make ui-walk` 全绿。2.1 = `preview.tsx` + `legacy.css` 的三条 `.files-md` 规则 + 它点名的四个测试文件（`preview.test.tsx`、`files-page.test.tsx` 的三个选择器、`files-empty-layout.test.tsx` 的 E2 两行、`chat-steps.test.tsx` 的一行）+ `ui-walk.spec.ts` 的两个选择器；2.2 = `dialogs.tsx` + `CreationMenu` 原样搬进 `tree.tsx` + `files-overlays.test.tsx` 的 O8 对话框半条、两处遮罩选择器与 O7 的 `dialogs.tsx` 半条。`files.css` 整个暂留到 3.3（留下的是没有元素命中的死规则，不影响别的文件）

## 3. files-web / ui-foundation — 首刀 b：目录树、页面、退出旧样式层

- [ ] 3.1 `web/src/features/files/tree.tsx`（644 行，另加 2.2 搬来的 `CreationMenu`）：改用 `button`、`dropdown-menu`（`新建` 的两项菜单）与 Tailwind，保持每个文件远离 800 行。两处空态（空根的 `该工作空间暂无目录`、未选文件的 `未选择文件`）不再用冻结区 `EmptyState`，
  按 2.1 不支持态的同一写法渲染（块 `data-slot="empty-state"`、副行 `empty-state-desc`；与 2.1、3.2 重复的部分抽成该目录下的一个小组件）。
  行为不变：惰性一层、展开缓存、图标与大小、空目录 / 空根文案、逻辑路径、绝对 `root` 不出界面、长名省略与 `title`。`新建`（菜单触发器）不再带 `ui-btn` 类，可访问名、菜单开合（恰两项）与关闭回焦不变（ui-primitives「按钮单一实现与旧类退役」）。
  稳定定位：树与预览的分栏容器带 `data-slot="files-layout"`，预览区容器带 `data-slot="files-preview"`（这两个是 files-web「文件界面与键盘可用性」规定的名字）；树条目的名称元素 `tree-name`、大小元素 `tree-size`（保留 `aria-hidden="true"`）、树根的逻辑路径副行 `tree-root-path`。
  DOM 结构（既有测试按它取元素，保持）：每个条目是 `li`，其下直接是条目按钮与（展开时）直属的 `ul`（`web/test/files-fixture.tsx:108-109` 的 `closest("li")` 与 `:scope > ul`）；树根按钮的下一个兄弟元素是逻辑路径副行、再下一个兄弟是 `ul`（`files-logical-path.test.tsx:145`、`:175-178`）；
  空根的空态在 `nav[aria-label="工作空间目录树"]` 之内（`files-empty-layout.test.tsx:40`）；左栏仍是可及名 `工作空间文件` 的 `complementary`、预览区仍是可及名 `文件预览` 的 `region`（走查 `ui-walk-layout.ts:314-315`、`ui-walk.spec.ts:227`）。
  同刀处置的既有断言（写作时 `grep -rnE 'files-(tree|layout|notice|status)|ui-empty-state|ui-btn' web/test web/e2e` 里由 `tree.tsx` 渲染的全部命中；选择器改动，断言的行为不变，记入偏离记录）：
  - `web/test/files-page.test.tsx:129` 的 `.files-tree-name` → `[data-slot="tree-name"]`；`:499-501` 的 `.files-tree-size` → `[data-slot="tree-size"]`（文本与 `aria-hidden` 断言不变）。
  - `web/test/files-logical-path.test.tsx:176` 的 `subline?.matches("p.files-tree-root-path")` → `matches('[data-slot="tree-root-path"]')`（`:177-178` 的文本与兄弟结构断言不变）。
  - `web/test/files-empty-layout.test.tsx:21-25` 的 `emptyStateOf` 帮手：`.ui-empty-state` → `[data-slot="empty-state"]`（服务于 `:38-40`、`:47-48`、`:82`；`:39`、`:48`、`:82` 里直接写的 `closest(".ui-empty-state")` 同改）。
  - `web/test/files-overlays.test.tsx:223`（O8 的 `新建`）：`className` 由「恰为 `ui-btn ui-btn--secondary ui-btn--md`」改为「不含 `ui-btn`」（2.2 留下的两条之一）。
  这三个文件与 `ui-tokens.test.ts`、`topbar.test.tsx` 里**读 `files.css` 规则体**的断言不是选择器改动，随 3.3 逐条处理（见 3.3）。
- [ ] 3.2 `web/src/features/files/page.tsx`：分栏与窄屏纵排改用 Tailwind（宽于 760 左右分栏，否则纵排），加 `刷新` 按钮（files-web「目录树与预览」的「手动刷新」场景）；`?ws=` 的缺省、纠正与归属隔离不变。
  工作空间切换器（今天是 `page.tsx:90` 起的冻结区 `Popover`，其中 `:149` 的 `＋ 新建工作空间` 用冻结区 `Button`）改用拷入层 `popover` 与 `button`，必要时拆出 `workspace-switcher.tsx`。切换器弹层保留 `role="dialog"` 与可及名 `工作空间切换器`
  （ui-primitives「基元组件库」的场景「既有对话框迁移不回归」仍断言它；`web/test/files-page.test.tsx`、`files-overlays.test.tsx`、`files-logical-path.test.tsx` 与走查 `ui-walk.spec.ts:206` 按这个名字定位切换器，这些定位原样保留）；
  列表容器带 `data-slot="switcher-list"`，列表项仍是 `li`、空间名仍在 `strong` 里。`＋ 新建工作空间` 不再带 `ui-btn` 类，可访问名与行为不变。无空间时的 `先选择或创建工作空间` 空态按 3.1 的同一写法。
  同刀处置的既有断言（记入偏离记录）：
  - `web/test/files-logical-path.test.tsx:90` 的 `switcher.querySelectorAll(".files-switcher-list li")` → `'[data-slot="switcher-list"] li'`（`:91` 的 `strong` 不变）。
  - `web/test/files-overlays.test.tsx:228`（O8 的 `＋ 新建工作空间`）：`className` 改为「不含 `ui-btn`」；至此 O8 的四条都已改写，用例标题与所在 `describe` 的标题同步改为不再提 `ui-btn variants` / `Button primitive` 的说法。
  - `files-overlays.test.tsx:259-261`（O7 里断言 `page.tsx` 恰有 `import { Button, EmptyState, Icon, Popover } from "../../ui/index.js"`）→ **删除**，连同 2.2 改写的 `dialogs.tsx` 那一条（3.4 的整目录分层守卫已覆盖这两个文件，且更强）；O7 其余断言不动。
  测试：`files-concurrency.test.tsx`、`files-errors.test.tsx` 原样通过（没有类名或结构选择器）；`topbar.test.tsx:263`（`page.tsx` 不含 `<h1`）原样通过；新增「手动刷新」用例。
- [ ] 3.3 删除 `web/src/features/files/files.css` 与 `web/src/styles/legacy.css` 里对它的 `@import`（`legacy.css` 的三条 `.files-md` 规则已在 2.1 删除；`.ui-alert`、`.ui-muted`、`.ui-empty` 三条全局规则不是文件页独有——会话页与路由也用——不动）；确认 `web/src/features/files` 不再从 `web/src/ui` 导入四项白名单之外的名字。
  `files.css` 一删，下列五个既有测试文件里读它的断言立即失败（`readRepoFile` 对不存在的文件抛错），必须与删除同一个 PR 处理，逐条记入 PR 的偏离记录（文首通用纪律）：
  - `web/test/files-page.test.tsx` 的 `keeps formatSize as the single size formatter and the tree glyphs on the icon primitive`：读 `tree.tsx` / `preview.tsx` 源码的断言（`fileIcon(`、`formatSize(`、无手写路径、`formatByteSize` 零引用）原样保留。读 `files.css` 的部分——
    **删除**：来源注释 `demo.html:694-706`、`.files-tree-size` 的三级文字色与 `font-size: 10.5px`（主规格 files-web「文件界面与键盘可用性」与「工作空间页」里的类名、像素值已被本 change 的 MODIFIED 去掉，「树条目图标与大小」只规定图标与大小文本，不规定字号）；
    **换成等价断言**：`.files-tree-name` 的单行省略 → 在渲染出的树里断言名称元素（`data-slot="tree-name"`）带 Tailwind 的 `truncate` 类（files-web「长名截断与布局规则」的「名称元素带单行省略的样式」）；
    对 `files.css` 的颜色字面量扫描 → 对 `web/src/features/files/**/*.tsx` 去掉注释后的源码做同一组 `COLOR_LITERAL_PATTERNS` 扫描（ui-foundation「Tailwind 入口与层叠顺序」：已迁移区域的样式只用 Tailwind 类与主题变量）。
  - `web/test/files-logical-path.test.tsx`：对 `.files-tree-root-path` 规则体的断言（三级文字色、`text-overflow: ellipsis`、`white-space: nowrap`、无颜色字面量）——文字色一项**删除**（规格不规定副行的颜色等级）；
    省略两项**换成**副行元素（`data-slot="tree-root-path"`）带 `truncate` 类且 `textContent` 仍为 `zhangsan/analytics`；颜色字面量一项并入上一条对 `features/files` 源码的扫描，不重复写。
  - `web/test/files-empty-layout.test.tsx` 的 `E5 pins the tree column widths, the narrow column layout, ellipsis names, and scrolling previews`：
    **删除**：树栏 `280px`、`max-width: 900px` 下 `210px`、`max-width: 760px` 下纵向这三条规则体断言（主规格 files-web 场景「长名截断与布局规则」里的这些像素值已被本 change 改写掉；以 760 为界的分栏 / 纵排由 3.5 的走查在真实浏览器里证明——verification-harness「UI 走查（Playwright）」880×800 的并排断言与 `mobile-dark` 的纵排），
    以及 `.files-preview-empty .ui-empty-state` 的 `min-width: 0` 与 `.ui-empty-state-desc` 的 `overflow-wrap: anywhere`（旧 `EmptyState` 基元不再可被该目录导入；空态下页面无横向溢出由走查的每路由溢出断言证明）；
    **换成等价断言**：`.files-tree-name` 的四项声明 → 同上的 `truncate` 类断言；`.files-code, .files-table` 与 `.files-md` 的 `overflow: auto` → 渲染源码、表格与 Markdown 预览后断言各自的滚动容器（2.1 定的 `data-slot="preview-code"`、`"preview-table"`、`"preview-markdown"`）带 `overflow-auto` 类（files-web「长名截断与布局规则」的「源码容器可内部横向滚动」）——容器一律以 `await waitFor(…)` 取到再断言，不在 `render` 之后同步 `querySelector`（组 17 把预览改为按需加载后这条断言不必再动）；颜色字面量一项并入上面的源码扫描。
    同一用例里读 `tree.tsx` / `page.tsx` / `preview.tsx` / `types.ts` 源码的断言（不含 `此文件夹为空`、`files-tree-empty`、`ui-empty"`、`status: "unsupported"; message`）原样保留。
  - `web/test/ui-tokens.test.ts` 的 `describe("文件页不自涂底色（#420）")`（在 `describe` 作用域读 `files.css`，文件一删整个测试文件加载失败）：两条规则体断言**删除**，守卫**换成**走查里的计算样式断言——
    `web/e2e/ui-walk-files.ts` 在 `/files` 选中文件之后读取 `data-slot="files-layout"` 与 `data-slot="files-preview"` 两个元素的计算 `background-color`，断言都是 `rgba(0, 0, 0, 0)`，两个 project 都做
    （规格依据：files-web「文件界面与键盘可用性」新增的句子与场景「文件页不自涂底色」、files-harness「走查 /files 步骤」；页面底色等于 `body` 的 `--background` 仍由 `ui-walk-layout.ts` 既有的 `pageBackground` 断言证明）。该文件其余 `describe` 不动。
  - `web/test/topbar.test.tsx` 的 `页面不再渲染自有 h1，样式与依赖方向符合顶栏归属`：「不含 `ui-page-heading`」的文件清单里去掉 `web/src/features/files/files.css` 一项（文件已不存在，无可断言；`ui-page-heading` 的规则只可能写在 `.css` 里，而 3.4 的分层守卫保证该目录下不再有 `.css`），清单其余项与该用例其余断言不动。
- [ ] 3.4 守卫：`web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 把 2.1、2.2 的两个单文件条目换成目录 `web/src/features/files`，同步清单断言；新增 ui-foundation「文件页整目录已迁移」的注入样本（该目录下一个文件导入旧 `Dialog`、目录下出现 `.css`）；
  `web/test/ui-foundation-entry.test.ts` 加「`legacy.css` 不导入 `features/files`」。
- [ ] 3.5 走查里文件页的断言（`.files-code`、`.files-table` 两个选择器已在 2.1 改掉，这里是其余的）。写作时 `grep -nE 'files-|ui-btn|280|210' web/e2e/*.ts` 的命中逐条处理：
  - `web/e2e/ui-walk-layout.ts:360`（`expectTruncatedRow` 里的 `row.locator(".files-tree-name")`）→ `[data-slot="tree-name"]`，「名称被省略、行不溢出、`title` 为全名」的断言不变。
  - `ui-walk-layout.ts:313-341`（`expectFilesColumns` / `expectTreeBesidePreview`）：缺省桌面宽度下的「树栏 280px」与 880×800 下的「树栏 210px」两处宽度断言去掉（主规格 files-web 里的这两个像素值已被本 change 改写掉），保留并只断言「树在左、预览在右」与 880×800 下无横向溢出
    （verification-harness「UI 走查（Playwright）」）；`mobile-dark` 的「树在上、预览在下」不变。
  - `ui-walk-layout.ts:300-311`（`expectLegacyOverPreflight`，取 `main` 里第一个 `.ui-btn` 的 `padding-left`）：3.1 之后文件页不再有 `.ui-btn`，探针改为 ui-foundation「旧页面规则压过 preflight」现在规定的 `ui-icon` 探针（临时插入 `body` 的 `svg.ui-icon`，计算 `display` 为 `inline-block`，读完移除）。
  - 新增 #420 的计算样式断言（3.3：`files-layout` 与 `files-preview` 的计算 `background-color` 为 `rgba(0, 0, 0, 0)`，两个 project）。
  `ui-walk.spec.ts` 的 `walkFiles` 里按角色、可及名与文本定位的既有断言（夹具预览、列表符号、目录创建挂起期焦点、重载保持）全部保留、无需改动。`ui-walk-layout.ts` 已 793 行：改写不增行，放不下的搬进新 helper `web/e2e/ui-walk-files.ts`。
- [ ] 3.6 功能验收清单「文件（FL）」节新增首批行（空间切换与新建、目录树浏览与图标大小、Markdown / CSV / 图片 / 源码预览、新建文件夹、窄屏纵排、深色主题、刷新），结论 `待签`。
- [ ] 3.7 变异证据：恢复 `legacy.css` 对 `files.css` 的导入 → 入口守卫判红；在 `features/files` 下的文件里导入旧 `Menu` → 分层守卫判红；把窄屏断点条件写反 → 走查的并排断言判红；把层声明里的 `legacy` 挪到 `base` 之前 → `ui-icon` 探针判红（入口守卫同时判红）；给预览区容器加上 `bg-card` → 走查的「文件页不自涂底色」断言判红；去掉名称元素的 `truncate` → 「名称元素带单行省略的样式」断言判红；切换器弹层改名或去掉 `role="dialog"` → 按 `工作空间切换器` 定位的既有用例判红；`新建` 改回冻结区 `Button` → O8 的「不含 `ui-btn`」判红；把条目的 `ul` 挪出 `li` → `files-fixture.tsx` 的展开帮手取不到子层，「一次浏览」用例判红。

Suggested fixture level: compact - 页面换底座、行为不变；风险在守卫、走查选择器与随 `files.css` 删除而改写的既有断言，由注入样本、既有走查与 3.3 的逐条对照覆盖
Minimal mergeable slice: 3.1–3.5 同刀（目录登记、`files.css` 删除、3.1 / 3.2 点名的选择器与 O8、O7 的后半、3.3 点名的五个既有测试文件的规则体断言、3.5 的走查选择器与探针必须一起改——`tree.tsx` 一换类名、`files.css` 一删，这些文件立即变红，不能留到后一个 PR）；3.6 的清单行随同一 PR

## 4. sandbox-core — `delete` 与 `move` 两个 `op`

- [x] 4.1 `server/src/core/sandbox/resolve.ts` 与 `index.ts`：`op` 联合在 S1g 之后的成员（`read`、`list`、`mkdir`、`write`）上增加 `delete`、`move`（不动 `write` 的任何规则）；末段校验（非空、非 `.`/`..`、不含反斜杠）从 `mkdir`、`write` 扩到四个 `op`。facade 的审计 `detail.op` 原样带出新值。
  实施注记见 `implementation-notes.md`「4.1–4.3（#1053）」。
- [x] 4.2 测试（`server/test/sandbox-resolve.test.ts`、`sandbox-facade.test.ts`）：sandbox-core「删除与移动的逃逸向量」场景的八种输入各对两个 `op`；合法路径；`regular-file/child` 对新 `op` 不是越界；facade 对 `delete` 的拒绝写出 `detail.op === "delete"`。
- [x] 4.3 变异证据：把空串放行给 `delete` → 「根不能被删除」用例判红；去掉 `move` 的末段校验 → `a/` 用例判红。

Suggested fixture level: expanded - 路径安全的核心函数增加两种操作，是删除与移动的唯一边界
Minimal mergeable slice: atomic - 一个纯函数加它的 facade 类型，测试同刀

## 5. http-service-skeleton — 十二个配置键（纯配置 seam）

- [x] 5.1 `server/src/agent-config.ts`（或并列的新文件 `server/src/preview-config.ts`，由 `resolveServerConfig` 合并）：解析 `PREVIEW_PORT`、`PREVIEW_ORIGIN`、`PREVIEW_CACHE_DIR`、`OFFICE_BIN`、`OFFICE_CONVERT_TIMEOUT_MS`、`OFFICE_CONVERT_CONCURRENCY`、
  `PREVIEW_TEXT_MAX_BYTES`、`PREVIEW_IMAGE_MAX_BYTES`、`PREVIEW_DOCUMENT_MAX_BYTES`、`PREVIEW_NOTEBOOK_MAX_BYTES`、`PREVIEW_ARCHIVE_MAX_ENTRIES`、`TRASH_RETENTION_DAYS`，缺省值与校验按 http-service-skeleton「服务启动与装配」；
  错误只命名键、不回显值。本任务只到 `ServerConfig` 的字段，不接任何消费方。
  实施注记见 `implementation-notes.md`「5.1–5.3（#1054）」。
- [x] 5.2 测试（`server/test/server-config.test.ts` 或新文件）：「预览与文件键的缺省与覆盖」的解析部分；「预览与文件键的非法值」逐键逐值；既有按键数断言的用例按「主规格当时的项数 + 12」更新（C、S1g 之后为二十三项，加十二为三十五项；http-service-skeleton「Shared agent module assembly」的场景「Pure source and compiled configuration identity」同步）；`server-entry-silent.test.ts` 的非法配置路径加两三个新键的样本（编译入口 nonzero、恰一行 generic 记录、无副作用）。
- [x] 5.3 变异证据：让 `PREVIEW_PORT` 拒绝 `0` → 缺省用例判红；让 `PREVIEW_ORIGIN` 接受带路径的值 → 非法值用例判红；错误 message 带上输入值 → 「不含输入值」断言判红。

Suggested fixture level: expanded - 生产配置面新增十二个键，非法值必须在任何副作用之前失败
Minimal mergeable slice: atomic - 纯解析函数与其测试；没有消费方时合入不改变任何运行期行为

## 6. workspaces — 预览分类扩展、嗅探与可配置上限

- [x] 6.1 `server/src/workspaces/preview.ts`：`classifyPreview(absPath, name, size, options)` 按 workspaces「预览分类元数据与有界字节流」的表重写（文本扩展名与 `Dockerfile` / `Makefile`、图片七种、音视频四种、Notebook、由别处提供的集合、`sniffedText`、`limits`）；新增纯函数 `sniffText`。
  导出图片、音频、视频、Notebook 四个扩展名集合供组 17 的契约测试读取。
  实施注记见 `implementation-notes.md`「6.1、6.2 最小接线（#1055）」。
- [x] 6.2 `server/src/workspaces/rest.ts` 的 `file` 路由：未知 / 无扩展名时读前至多 8192 字节嗅探后再分类；`limits` 经 `registerWorkspaces` 的依赖对象传入（缺省为规格缺省值），`server/src/app.ts` 把 `ServerConfig` 的三个上限接进来（`assembly` 新增可选字段）。
  实施注记见 `implementation-notes.md`「6.2（部分）、6.3、6.4（#1056）」。
- [x] 6.3 测试：`server/test/` 新文件 `workspaces-preview-classify.test.ts`（分类器六个场景中除范围解析外的全部）与既有工作空间路由测试里补「未知与无扩展名文件的嗅探」「图片与拒绝」「Notebook 与可配置上限」「文本、截断与 html」（含 `svg`、`htm` 为 `text/plain`）。
  断言已知扩展名的请求不发生嗅探读取（以对 `open`/`read` 的计数或注入的读函数为证）。preview-origin「主站不把工作空间文件当文档返回」的 `file` 半边（`page.html`、`logo.svg`、`feed.xml` 为 `text/plain`，`doc.pdf` 为 415）也在这里断言。
  随条文改写的既有测试（与 6.1 同 PR，逐条记入偏离记录）：`server/test/workspace-preview.test.ts`（`classifyPreview` 的三参调用改四参；`IMAGE_LIMIT = 10_485_760` 与「11 MiB 的 png 被拒」改为 20 MiB 边界）、
  `server/test/workspaces-http.test.ts`（路由层「11 MiB 的 `huge.png` 期望 413」改为 21 MiB）。`server/test/app.test.ts`、`http-typed-errors.test.ts`、`http-parser-owners.test.ts`、`auth-lifecycle.test.ts`、`auth-request-errors.test.ts` 里只引用 `preview_too_large` / `preview_unsupported` 两个错误码本身的用例不受影响，逐个确认后原样保留。
- [x] 6.4 变异证据：把 `svg` 的类型改成 `image/svg+xml` → 「永不以文档类型返回」用例判红；对已知扩展名也嗅探 → 读取计数用例判红；图片上限用回 10 MiB → 20 MiB 边界用例判红。

Suggested fixture level: expanded - 公共 API 的内容类型与上限变化，含「主站不把不可信文件当文档返回」的安全性质
Minimal mergeable slice: 6.1 + 6.2 中「路由按新签名调用、上限仍取规格缺省值」的最小接线 + 6.3 点名的两个既有测试文件的改写同刀（签名与图片上限一变，这两个文件立即变红，不能分开）；嗅探与 `ServerConfig` 上限的接入（6.2 其余部分）随后

## 7. workspaces — 音视频的范围请求

- [x] 7.1 `preview.ts` 新增纯函数 `parseRange` 与 `openRangeStream`（只有函数与导出，路由不变）。测试：`parseRange` 的十个输入（workspaces「嗅探与范围解析」场景）；`openRangeStream(path, 10, 19)` 恰产出第 10–19 字节，读完前销毁时描述符释放。
  实施注记见 `implementation-notes.md`「7.1（#1057）」。
- [ ] 7.2 把「按区间发送一个文件」做成 `server/src/workspaces/` 下可复用的小函数（200 / 206 / 416 的头与正文；组 12、15 的预览监听器直接用它）。
- [ ] 7.3 `file` 路由对 `rangeable` 的类别经 7.2 的函数按 workspaces「文件预览」返回 200 / 206 / 416，其余类别忽略 `Range`。
- [ ] 7.4 测试：路由层「音视频的范围请求」场景，206 用真实监听的 HTTP 客户端断言字节与 `Content-Range`（`inject` 之外再走一次真连接）；流在区间读完前被客户端中止时描述符释放。
- [ ] 7.5 变异证据：`bytes=-100` 当成 `0-100` → 后缀区间用例判红；对 `readme.md` 也回 206 → 「其余类别忽略」用例判红；416 带上 JSON 信封 → 空体断言判红。

Suggested fixture level: expanded - 公共 API 新增部分内容响应，区间边界与资源释放都要钉死
Minimal mergeable slice: 7.1（纯函数与其测试）先合；7.2–7.4（发送函数、路由接入与路由测试）随后

## 8. file-operations — 删除、回收目录与清理

- [ ] 8.1 新文件 `server/src/workspaces/trash.ts`：`createTrash({sandboxRoot, retentionDays, rename?})` 提供 `moveToTrash(ownerId, workspaceId, absPath) → trashId`（四级目录逐级 `ensureOwnedDir(…, 0o700)`——符号链接、非目录、他人持有都拒绝——、一次 `rename`、失败时删掉空批次并抛出）与 `sweep(now)`（file-operations「回收目录的保留与清理」）。
  断言账号 id 不以 `.` 开头（design D22）：以种子账号与 `store` 的 owner 段校验为证，写成一条测试——它只读账号与目录校验、不执行 `rename`，归 `sweep` 半边，写在 `workspaces-trash-sweep.test.ts` 里（不等 1.2）。
  本任务按是否执行 `rename` 分两半交付：`sweep` 半边（`createTrash` 的构造与目录校验、`sweep`）不 `rename` 用户条目，不等 1.2，是 13.1 的前提；`moveToTrash` 半边 Depends on 1.2，是 8.2 的前提。
  实施注记见 `implementation-notes.md`「8.1 的 sweep 半边，含分摊的 8.3 / 8.4 条款（#1059）」。
- [ ] 8.2 新文件 `server/src/workspaces/rest-entries.ts`：`DELETE /api/workspaces/:id/entries`，检查次序、审计 `file.delete`（`detail` 三键）与失败语义按 file-operations「删除到回收目录」；由 `registerWorkspaces` 注册，`trash` 经依赖对象传入。
- [ ] 8.3 测试（新文件 `server/test/workspaces-delete.test.ts`）：「删除文件与目录」「同名先后删除互不覆盖」「拒绝项」「改名失败不丢文件」（注入抛 `EXDEV` 的 `rename`）「回收目录被预先占位」「回收目录不可见」；审计失败时 500 且条目已在回收目录。这个测试文件与 8.2 的路由、8.1 的 `moveToTrash` 半边 Depends on 1.2：其结论与设计相符才开工。
  `server/test/workspaces-trash-sweep.test.ts`（随 8.1 的 `sweep` 半边，不等 1.2）：「到期的批次被清除」「临时空间删除后批次保留到期满」（空间行与 `tmp-<id>` 目录都不存在时，批次在保留期内不动、期满被清；清理不查 `workspaces` 表）「保留期可配置」「清理出错不外溢」，以及 8.1 的「账号 id 不以点开头」。
  这个文件里的批次一律**由夹具直接在回收目录下建出**（按 file-operations 规定的四级目录、mode 与批次名，修改时间由夹具设定），不经 `DELETE …/entries` 路由——场景「临时空间删除后批次保留到期满」的 WHEN 里「先经 `DELETE …/entries` 删除」在这里以夹具等价替代；
  「经路由删除产生的批次落在同一位置、同一形状」由 `workspaces-delete.test.ts` 的「删除文件与目录」证明，两个文件合起来覆盖该场景。
- [ ] 8.4 变异证据：批次目录建成 `0755` → mode 断言判红；用递归 `mkdir` 代替逐级校验 → 「预先占位」的符号链接用例里文件被移走而判红；`rename` 失败后不删空批次 → 「没有残留」断言判红；清理跟随符号链接 → 「链接目标内容不变」判红；删除先于归属检查 → 他账号 404 用例里出现文件变化而判红。

Suggested fixture level: expanded - 删除行为、路径安全、审计与文件系统补偿都在这一组
Minimal mergeable slice: 8.1 的 `sweep` 半边与 `workspaces-trash-sweep.test.ts` 先合（不等 1.2；没有调用方时无运行期影响，13.1 只依赖这一半）；8.1 的 `moveToTrash` 半边 + 8.2 的路由 + `workspaces-delete.test.ts` 等 1.2 的结论后同刀（Depends on 4.1）。定时启动在 13.1 接线

## 9. file-operations — 重命名 / 移动与下载

- [ ] 9.1 `rest-entries.ts`：`POST /api/workspaces/:id/move`（严格的 `{from,to}` body、检查次序、409 不覆盖、子树 400、审计 `file.move` 与两种 `title`）；`server/src/http/errors.ts` 的归属路由集合加入 `POST /api/workspaces/:id/move`。
- [ ] 9.2 测试（新文件 `server/test/workspaces-move.test.ts`）：file-operations「重命名与移动」六个场景（含「子树判断先于存在性」：`d1/sub` 存在与不存在两种夹具都是 400，`d1 → d10` 不被误判）；`server/test/http-parser-owners.test.ts` 加该路由的四种 content-parser 错误 → 400 且无文件变化。
- [x] 9.3 `rest-entries.ts`：`GET /api/workspaces/:id/download`（附件头、`filename` 与 `filename*` 的生成做成纯函数、审计先于首字节、不支持 `Range`）。
  实施注记见 `implementation-notes.md`「9.3、9.4（#1061）」。
- [x] 9.4 测试（新文件 `server/test/workspaces-download.test.ts`）：file-operations「下载」四个场景；文件名函数对中文、空格、引号、反斜杠、控制字符的输出；preview-origin「主站不把工作空间文件当文档返回」场景的 `download` 半边（html、svg、pdf、xml 都是 `application/octet-stream` 附件；`file` 半边在 6.3）。
- [ ] 9.5 变异证据：目标存在时仍 `rename` → 「同名拒绝」里内容被覆盖而判红；不查子树 → `d1 → d1/sub/d1`（`d1/sub` 已存在的夹具）得到 `rename` 的失败或成功而不是 400，判红；把子树判断放回父目录检查之后 → `d1/sub` 不存在的夹具得到 404 而不是 400，判红；用不带 `/` 的前缀比较 → `d1 → d10` 被误拒而判红；审计挪到发送之后 → 「审计失败不发文件」判红；`Content-Type` 改用真实类型 → html 下载的类型断言判红。

Suggested fixture level: expanded - 改动文件位置的公共 API 与无上限的文件读出，含冲突、越界与审计次序
Minimal mergeable slice: 9.1–9.2（移动）与 9.3–9.4（下载）互不依赖，各自可单独合入：下载一刀不执行 `rename`，不等 1.2、不依赖组 4 与组 6（「主站不把工作空间文件当文档返回」的 `file` 半边已归 6.3），可最先合；移动一刀 Depends on 1.2 与 4.1

## 10. workspaces — 压缩包列表

- [x] 10.1 新文件 `server/src/workspaces/archive.ts` 的 tar / tar.gz / gz 部分：`node:zlib` 加 512 字节头的遍历器（ustar `name`/`prefix`、GNU `L`、pax `path`；成员正文跳过不读）；单个 gz 一项；到条目上限停读；tar 与 tar.gz 的 5 秒时限（时钟可注入）；
  扩展记录 65536 字节与成员名 4096 字节的硬上限——按头里**声明**的长度在读取之前判定，超出即停读并置 `truncated`（一项都没读出时为不支持）。读取经一个可注入的读函数，测试用它记录单次读取的最大长度。
  实施注记见 `implementation-notes.md`「10.1（#1063）」。
- [x] 10.6 `archive.ts` 遍历器的两处修正（owner 裁决 2026-10-09；规格条文随本任务的代码 PR 落地，不在此前写）。Depends on：10.1。挡住：10.3。
  (a) 一个完整的 gzip 流之后的字节被忽略：带尾部字节的 tar.gz / gz 的列表等于去掉尾部后的列表，`truncated` 为 `false`。
  (b) typeflag 为 `1`–`6` 的 tar 成员没有正文：遍历器不按其头里的 `size` 跳过字节，下一个头紧随其后；该条目的 `size` 仍显示头里的值。
  各带用例与变异证据（去掉 (a) → 带尾部的包与无尾部的包列表不等或 `truncated` 为 `true` 而判红；去掉 (b) → 这类成员之后的成员丢失或错位而判红）。
- [ ] 10.2 `archive.ts` 的 zip 部分：`yauzl`（新依赖，MIT，登记 `ATTRIBUTION.md`）只读中央目录；成员名超过 4096 字节的成员不计入结果，停读并置 `truncated`（名字随中央目录项读入后判定——`zip` 的名长字段只有 2 字节，读入量有界；不要求在 `yauzl` 交出该项之前拦截）。
- [ ] 10.3 `GET /api/workspaces/:id/archive` 路由（新文件或并入 `rest-entries.ts`），`PREVIEW_ARCHIVE_MAX_ENTRIES` 经 `limits` 传入。
- [ ] 10.4 测试（新文件 `server/test/workspaces-archive.test.ts`）：workspaces「压缩包列表」五个场景（含「声明超大的长文件名记录」：1 KiB 文件声明 4 GiB 的 `L` 记录、两个成员之后声明 1 GiB 的 pax 头、5000 字节的 zip 成员名与 `L` 名字、注入时钟的未压缩 tar 超时）。
  测试用的压缩包在测试里用 `node:zlib` 与手写的 tar / zip 字节现场生成（不入库二进制夹具）；断言请求前后工作空间与临时目录无新增文件。
- [ ] 10.5 变异证据：到上限后继续读 → 1500 项用例的条数断言判红；对成员名做路径解析 → 「恶意成员名只是数据」里出现空间外访问而判红；不认 GNU 长文件名 → 长路径用例判红；
  去掉扩展记录的长度上限（按声明长度分配或读取）→ tar 用例的「单次读取不超过 65536 字节」判红；时限只套在 tar.gz 上 → 未压缩 `slow.tar` 的超时用例判红。

Suggested fixture level: expanded - 解析不可信的二进制格式并对外新增端点；条目上限、长度上限与「不解压、不落盘」是硬约束
Minimal mergeable slice: 10.1（tar / gz 的遍历器）与它在 10.4 里的用例先合；10.6（遍历器的两处修正，带自己的用例）单独一刀，先于 10.3；10.2（zip，带新依赖）与 10.3 的路由随后，各带自己的用例（10.3 Depends on 5.1 与 6.2 的 `limits` 依赖对象；10.1、10.2 只依赖 0.1）

## 11. preview-origin — 令牌登记表与签发端点

- [x] 11.1 新文件 `server/src/preview/tokens.ts`：preview-origin「预览令牌登记表」（时钟由参数传入，便于测试）。
  实施注记见 `implementation-notes.md`「11.1（#1066）」。
- [ ] 11.2 `POST /api/workspaces/:id/preview-token`（`server/src/workspaces/` 下的新路由文件，仅在 `assembly.preview` 存在时注册）：响应六键、`base` 的推导（`PREVIEW_ORIGIN` 优先，否则请求协议 + 主机名 + 预览端口函数的返回值）、`embedOrigin` 取 `Origin` 头；
  `errors.ts` 的归属路由集合加入它。
- [ ] 11.3 测试：`server/test/preview-tokens.test.ts`（登记表三个场景）；`server/test/preview-token-rest.test.ts`（「签发与复用」「对外来源与转换可用」「归属与请求体」；IPv6 主机名的方括号；响应头与日志不含令牌）；未装配 `preview` 时 404（http-service-skeleton「未装配预览的可注入 app」）。
  `server/test/http-parser-owners.test.ts` 的归属身份表（`:29-42`，与 `:144-146` 的条数断言、常量名里的条数）加入 `POST /api/workspaces/:id/preview-token`，做法同 9.2 对 `move` 的处理；先合的那一个把条数加一，后合的再加一。
- [ ] 11.4 跨路由边界测试（扩展 `server/test/workspaces-http.test.ts` 既有的「完整真实装配与隔离」用例，写成一份表驱动）：workspaces「工作空间 HTTP 集成边界」的场景「新增路由沿用同一边界」——对 `archive`、`download`、`DELETE entries`、`move`、`preview-token` 五条路由逐条断言：
  他人与不存在的 id 带越界路径（或越界的 `from`/`to`）→ 相同的 404、没有 `sandbox.reject` 审计行、没有文件系统变化；未认证 → 401；`archive`、`download`、`DELETE entries` 的重复 `path` → 400；全部响应带 `Cache-Control: no-store`。Depends on 8.2、9.1、9.3、10.3、11.2（被测的五条路由；因 8.2、9.1 而间接等 1.2。组 11 里只有本任务与 11.5 的最后一条变异有这个依赖）。
- [ ] 11.5 变异证据：`lookup` 顺手续期 → 「查找不续期」判红；他人的工作空间也签发 → 归属用例判红；`base` 用 `Host` 头里的端口 → 端口断言判红；任一新路由把路径检查放到归属检查之前 → 11.4 的表里该路由出现 403 与审计行而判红。

Suggested fixture level: expanded - 新的鉴权凭据及其签发端点
Minimal mergeable slice: 11.1 的登记表与测试先合（只依赖 0.1）；端点（11.2–11.3，Depends on 5.1）随后（此时还没有监听器消费令牌，签发出的地址无人应答，不影响既有功能）——这两刀都不等组 8、9、10，组 12–15 只依赖它们；11.4 的表驱动测试在五条路由（8.2、9.1、9.3、10.3、11.2）都合入后单独成 PR，11.5 的最后一条变异随它

## 12. preview-origin — 预览监听器与响应头

- [ ] 12.1 新文件 `server/src/preview/app.ts`：`createPreviewApp({store, sandbox, tokens, converter, limits})`，只有 `/w/<token>/*`（`/o/` 在组 15 加）；校验次序、不读 cookie、404 / 403 的固定纯文本、复用组 7 的区间发送函数；有界关停沿用 `app.ts` 的 `registerListenerShutdown`（必要时把它提到两个实例都能导入的模块）。
- [x] 12.2 响应头与类型表（preview-origin「预览响应头与内容类型」）：做成一个纯函数 `previewHeaders(name, embedOrigin)`，成功与失败响应都经它或其子集。
  实施注记见 `implementation-notes.md`「12.2（#1068）」。
- [ ] 12.3 测试（新文件 `server/test/preview-app.test.ts` 与 `preview-headers.test.ts`）：「令牌放行，cookie 不放行」「相对资源与子目录」「拒绝项」「作用域只有一个工作空间」「空间消失后令牌失效」「范围请求」，以及响应头的五个场景。
  「不认 cookie」的证据：同一请求带与不带有效 `workbuddy_session` 的响应逐字节相同，且该实例上没有注册 cookie 解析与认证钩子。
- [ ] 12.4 变异证据：给 CSP 加上 `allow-same-origin` → 头断言判红；目录请求回退到 `index.html` → 拒绝项判红；失败体回显路径 → 「不含所请求的路径」判红；用令牌之外的条件（cookie）放行 → 第一场景的 404 判红。

Suggested fixture level: expanded - 新的对外监听面，承载不可信内容；隔离性质全部在这一组的头与拒绝项里
Minimal mergeable slice: 12.2 的头函数与其测试先合；监听器实例（12.1，Depends on 6.1、7.2、11.1；不依赖 11.4）随后（入口尚未启动它时无运行期影响）

## 13. http-service-skeleton — 入口接线：两个监听器、缓存目录与周期清理

- [ ] 13.1 `server/src/server.ts`：按 http-service-skeleton「预览监听器的装配与关停」——预览监听器先于主监听器 `listen`、同一 `AbortSignal`、失败走既有 cleanup；监听成功后建 `PREVIEW_CACHE_DIR` 三个目录并清空 `work`；
  启动回收目录清理（8.1 的 `sweep` 半边）的定时器（`unref`）；`OwnedResources` 增加预览实例与该定时器；关停次序（回收目录清理的定时器 → 预览监听器 → 主监听器 → DB；转换器与转换缓存清理在组 15 接入这个序列）；`listener_force_close` 至多一行。`appAssemblyOf` 带上 `preview`。
  清空 `work`：本任务只做本进程自己的递归删除（此时入口还没有转换器，`work` 下不会有属 omp 用户的东西）；同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时先执行的那条 `sudo … find`（owner D-24）由 14.3 提供、在 15.1 连同真实转换器一起接进入口。
  #1286：启动与周期清理的接线不等它（owner D-23，design D22「已知残余」）。`server/src/workspaces/trash.ts:12` 的头注释写着「settle it before anything schedules this sweep」，同一个代码 PR 把这半句改成已裁决的现状（登记为已知残余、issue 保持打开）；注释的其余陈述不动。
- [ ] 13.2 测试（`server/test/server-startup-order.test.ts`、`listener-shutdown.test.ts` 或新文件，用既有 `server-startup-helpers` 起编译入口）：「两个监听器的启动与干净关停」「预览端口被占用」「关停期间的在途请求与转换」中在途请求的部分（转换的部分在 15.2）；
  「预览与文件键的缺省与覆盖」里关于实际绑定端口与四键启动记录的部分；信号落在两次 `listen` 之间时两个端口都可立即复用。
- [ ] 13.3 变异证据：先起主监听器 → 「主监听器受理时预览已可用」的断言判红（在 success record 之前对预览端口的探测）；关停时先关 DB → 在途预览请求的用例出现 5xx 而判红；启动记录多一个键 → 精确四键断言判红。

Suggested fixture level: expanded - 生产入口的启动与关停次序，涉及端口与 DB 的释放
Minimal mergeable slice: atomic - 两个监听器与回收目录定时器在入口的启动与关停必须成对修改，拆开会留下不关的监听器或不停的定时器（Depends on 5.1、8.1 的 `sweep` 半边、11.2、12.1；不依赖 8.1 的 `moveToTrash` 半边与 8.2，因此不等 1.2）

## 14. office-preview — 转换器

- [x] 14.1 新文件 `server/src/preview/office.ts`：`createOfficeConverter`——作业目录、argv 与环境、sudo 前缀（复用 `core/process-path` 的 `setpriv` 检查）、成功判定；终止在途转换（超时、`signal` 中止、`close()`）按 office-preview「转换器调用契约」的两种模式：同 uid 模式以新进程组启动并对进程组发 `SIGKILL`，`OMP_USER` 模式只杀自己启动的 `sudo`（不执行 `kill`/`pkill`/第二次 `sudo`，不新增 sudoers 规则）。
  实施注记见 `implementation-notes.md`「14.1、14.4（#1071）」。
- [ ] 14.2 同文件或 `office-queue.ts`：并发上限、排队上限 8、按缓存键去重、排队中中止出队（office-preview「并发上限与排队」）。
- [ ] 14.3 缓存与周期清理（office-preview「转换缓存」）：键的计算、命中更新修改时间、输出**复制**后改名进 `pdf/`、失败不入缓存、7 天清理函数、启动时清空 `work/`（周期定时器在 15.1 接进 `server.ts`）。
  启动时清空 `work/` 按 office-preview「转换缓存」分两种情况（owner D-24，design D18「作业目录的清理」；**审批 / 提权策略的改动，落在 Critical Path「omp 子进程治理」，PR 标注白盒审查**）：
  - `ompUser` 与 `officeBin` 没有同时提供（同 uid 模式；或有 `ompUser` 而没有 `officeBin`）：只由本进程递归删除，不启动 `sudo`。
  - 两者都提供：先 spawn 恰一次，命令 `sudo`，argv 恰为 `-n -u <ompUser> -- /usr/bin/find <cacheDir 的绝对路径>/work -mindepth 1 -delete`（逐项固定：路径取 `join(cacheDir, "work")`，不拼字符串、不加通配、不经 `setpriv`；`shell:false`、`cwd: "/"`（14.5 的假 `sudo` 记录并断言它）、标准流全部丢弃、环境只有 `PATH` 与存在时的 `LANG`），等它结束，再做本进程自己的递归删除。
  - `PATH` 的安全检查复用 `server/src/core/process-path.ts` 的 `assertSafeSudoPath`（与转换的 spawn 同一个函数，不另写）；`assertSetprivExecutable` 不适用。检查不过按该命令失败处理，不启动。
  - 该命令失败（检查不过、spawn 失败、非 0 退出、被信号终止）：application stderr 恰一行 `{"event":"preview_work_clear_failed"}`（没有其它键），不抛出，本进程自己的删除照常进行。
  - spawn 经可注入的函数（与 14.1 同一个 seam），测试用记录型假 `sudo`（14.5）；变异证据在 14.6。
  - CI：`uid-isolation` job 不设 `OFFICE_BIN`，这条命令在那里不执行，`.github/scripts/ci-uid-isolation.sh` 不需要改。
- [x] 14.4 测试夹具 `server/test/fixtures/fake-soffice.mjs`（可执行；按输入文件名里的标记：正常写出一个最小 PDF、退出码 1、不写输出、写空文件、写符号链接、睡眠、先起一个子进程再睡眠；把收到的 argv 与环境写到作业目录旁的记录文件）。
- [x] 14.7 `office.ts` 的输出复制设界（owner 裁决 2026-10-09；规格条文随本任务的代码 PR 落地，不在此前写）。Depends on：14.1。挡住：14.5、15.1。
  对输出按同一个 fd 的 `fstat` 所得 `size` 复制恰好这么多字节：`size` 大于 200 MiB → 不读，`failed`；读到的字节少于 `size` → `failed`（半截的副本不留在 `pdf/`）。上限是写死的常量，不加配置键。
  同一个 PR 更正 `server/src/preview/office.ts:9` 头注释里的「其后代可能残留」：按 design D18 与 owner D-25 写成实测事实（`OMP_USER` 模式下 `soffice.bin` 每次都留下并把转换跑完，实际并发可以超过上限）。
  各带用例与变异证据（去掉上限 → 超限输出被读入而判红；不比对读到的字节数 → 短读的输出进了 `pdf/` 而判红）。
- [ ] 14.5 测试（新文件 `server/test/office-converter.test.ts`、`office-queue.test.ts`、`office-cache.test.ts`）：三条需求的全部场景，对着 14.4 的假可执行文件真实 spawn；「超时与中止」在同 uid 模式下断言假进程及其子进程都不存在；sudo 前缀与「OMP_USER 模式下终止的是 sudo」用记录型假 `sudo`（记录 pid 后睡眠：断言它被 `SIGKILL`、恰被启动一次、名额已释放）。office-preview「自动化测试不需要 LibreOffice」：转换器经注入的 spawn 函数启动进程，测试记录每次启动的可执行文件路径，断言其 basename 没有一个恰为 `soffice` 或 `libreoffice`（夹具名是 `fake-soffice.mjs`）。
  「OMP_USER 模式下启动时清空 work」（`office-cache.test.ts`，记录型假 `sudo`）：假 `sudo` 恰被启动一次且 argv 逐项相等、环境的键只有 `PATH`（与 `LANG`）、它结束之后本进程才开始删除、结束时 `work` 为空；假 `sudo` 以退出码 1 结束 → stderr 恰多一行 `{"event":"preview_work_clear_failed"}`、不抛出、本进程可删的条目照常被删；`PATH` 含相对项 → 假 `sudo` 没有被启动、同一行日志；不提供 `ompUser` → 没有启动 `sudo`；提供 `ompUser` 而不提供 `officeBin` → 没有启动 `sudo`、stderr 没有新增行，`work` 照常被本进程清空。
- [ ] 14.6 变异证据：把输出改名进缓存而不是复制 → inode / 属主断言判红；同 uid 模式超时只杀直接子进程 → 「子进程也不存在」判红；`OMP_USER` 模式改为再起一个 `sudo … pkill` → 「假 `sudo` 恰被启动一次」判红；去掉去重 → 「恰启动一次」判红；失败结果写缓存 → 「失败不入缓存」判红。
  启动时清空 `work`（14.3）：同 uid 模式也执行 `sudo` → 「没有启动 `sudo`」判红；判定里去掉 `officeBin`（只看 `ompUser`）→ 「有 `ompUser` 而没有 `officeBin` 时没有启动 `sudo`」判红；跳过 `sudo` 时连本进程自己的删除也跳过 → 该例的「`work` 为空」判红；argv 改成带通配或换成别的命令 → argv 逐项相等的断言判红；不等 `sudo` 结束就开始自己的删除 → 次序断言判红；该命令失败时抛出 → 「不抛出」判红；失败时不记日志或日志带路径 → stderr 整行相等的断言判红；去掉 `assertSafeSudoPath` → 「`PATH` 含相对项时不启动」判红。

Suggested fixture level: expanded - 启动外部进程处理不可信输入：身份、超时、并发与缓存完整性
Minimal mergeable slice: 14.1 + 14.4 + 对应测试（单次转换的契约）先合；14.7（输出复制设界与头注释更正，带自己的用例）单独一刀；排队与缓存各自随后（整组以参数收值、对着假可执行文件测试，只依赖 0.1，不依赖组 13，可与组 4–13 并行）

## 15. office-preview — `/o/` 路由

- [ ] 15.1 `server/src/preview/app.ts`：`GET /o/<token>/*`，校验次序、扩展名与文档上限的前置拒绝、转换结果到状态码与固定文案的映射、客户端断开即中止、成功时按 PDF 的头与单段 `Range` 返回缓存文件。`server.ts` 用 `ServerConfig` 构造真实转换器并传入；令牌响应的 `officeAvailable` 接到 `converter.available`。
  同一任务把转换器接进入口的生命周期：`converter.close()` 与转换缓存每 24 小时的清理定时器（`unref`）纳入 `OwnedResources`，关停序列里排在回收目录清理定时器之前、预览监听器之前（http-service-skeleton「预览监听器的装配与关停」：转换器 `close` → 两个定时器 → 预览监听器 → 主监听器 → DB）。
  启动时清空 `work` 改为调用 14.3 的函数（同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时先执行 `sudo … find`，owner D-24；CI 的 `uid-isolation` job 不设 `OFFICE_BIN`，其 sudoers 脚本不需要改），取代 13.1 自己的那次删除；它必须在转换器受理第一次转换之前完成——预览监听器此时已在监听，`/o/` 在清空完成之前不得启动转换（次序由本任务保证并在 15.2 以一条用例证明）。Critical Path「omp 子进程治理」，PR 标注白盒审查。
- [ ] 15.2 测试（`server/test/preview-office-route.test.ts`，注入转换器替身）：office-preview「办公文档预览路由」四个场景；http-service-skeleton「关停期间的在途请求与转换」中转换的部分（编译入口 + 假 `soffice`：SIGTERM 后假进程不存在、请求以失败结束、DB 最后关）。
- [ ] 15.3 变异证据：超限检查放到转换之后 → 「`convert` 未被调用」判红；失败文案带上文件名 → 「正文不含文件名」判红；PDF 响应加 CSP `sandbox` → 头断言判红；关停时不调 `converter.close()` → 「SIGTERM 后假进程不存在」判红。

Suggested fixture level: expanded - 对外路由把外部进程的结果变成响应，失败面多
Minimal mergeable slice: atomic - 一条路由、它的映射表与转换器在入口的启停接线必须同刀（路由先合而不接关停会留下不被回收的转换进程），替身测试同刀（Depends on 5.1、11.2、12.1、13.1、14.1–14.3、14.7）

## 16. files-web — API 客户端：`api-files.ts`

- [ ] 16.1 新文件 `web/src/lib/api-files.ts`：两个地址函数 `fileUrl`、`downloadUrl` 与 `listArchive`；传输由 `api.ts` 注入、对 `api.ts` 只有类型导入；响应严格解析。`api.ts` 只加接线与类型再导出（不超过 800 行；必要时把既有工作空间方法一并挪进 `api-files.ts`）。
- [ ] 16.2 `api-files.ts`：`moveEntry`、`deleteEntry`、`issuePreviewToken`（同样的注入与严格解析）。
- [ ] 16.3 `fetchPreview` 的图片类型集合扩到六种，`audio/*`、`video/*`、`image/svg+xml`、`text/html` 仍按失败处理。
- [ ] 16.4 测试（`web/test/api-files.test.ts` 扩充）：files-web「API 客户端扩展」五个场景，随 16.1–16.3 各自的方法分批加入，对应如下——
  地址函数一刀（`fileUrl`、`downloadUrl`）：「地址函数与严格解析」里两个地址的编码与「没有发出请求」；「模块划分可持续验证」（`api-files.ts` 对 `./api.js` 只有 `import type`，size-guard 与 knip 通过——这一刀建文件时就成立，之后每一刀都重跑）。
  `listArchive` 一刀：「方法与错误码」里它的一行（`GET …/archive?path=`、返回形状、四种错误信封）；「地址函数与严格解析」里 `entries` 含 `type` 为 `link` 的残缺响应。
  `issuePreviewToken` 一刀：「方法与错误码」里它的一行（无 body 的 `POST …/preview-token`）；「地址函数与严格解析」里缺 `base` 的残缺响应。
  `moveEntry` 一刀：「方法与错误码」里它的一行（`POST …/move` + JSON `{from,to}`）；「地址函数与严格解析」里响应为 `{}` 的残缺响应。`deleteEntry` 一刀：「方法与错误码」里它的一行（`DELETE …/entries?path=`、无 body、204）。
  16.3 一刀：「预览元数据与资源」里 `image/gif`、`image/webp` 两种类型；「失败不变成预览」里 `text/html`、`image/svg+xml`、`video/mp4` 三种 Content-Type（该场景其余既有断言不动）。
  「方法与错误码」里「十个发请求的方法」这个总数，随四个新方法中最后合入的那一刀成立；先合的各刀只断言自己那一行与既有六个方法不回归。
  `web/test/chat-module-layout.test.ts` 同款的导入方向断言加上 `api-files.ts`（对 `./api.js` 只有 `import type`）。
- [ ] 16.5 变异证据：`downloadUrl` 不编码 `&` → 地址函数用例判红；接受缺 `base` 的令牌响应 → 严格解析用例判红；把 `video/mp4` 当图片 → 「失败不变成预览」判红。

Suggested fixture level: compact - 客户端方法的机械扩充，契约由 mock fetch 测试钉住
Minimal mergeable slice: 16.1 按方法分两刀——地址函数 `fileUrl`、`downloadUrl`（Depends on 9.3）带用例先合，`listArchive`（Depends on 10.3）带用例随后，组 17 只依赖前一刀；16.3（Depends on 6.1）带自己的用例随后；16.2 按方法分刀——`issuePreviewToken`（Depends on 11.2）、`moveEntry`（Depends on 9.1）、`deleteEntry`（Depends on 8.2）各带自己的用例，后两个间接等 1.2，前一个不等。每个方法都有测试引用（`web/test/**/*.test.ts(x)` 是 knip 的入口），不需要为过 knip 另造调用点，也不改 `knip.json`

## 17. file-previewers — 框架：类别判定、按需加载、预览头与下载

- [ ] 17.1 新目录 `web/src/features/files/previewers/`：`index.ts`（唯一含动态 `import()` 的文件，按类别返回带缓存的加载函数）与 `kind.ts`（`previewKind`、`textView`、图标映射）。把组 2 的 Markdown、表格、源码、图片四个既有预览各搬成一个模块，经 `index.ts` 加载；2.1 定的 `data-slot`（`preview-code`、`preview-table`、`preview-markdown` 等）随模块原样带走。这一刀里 `preview.tsx` 即经 `kind.ts` 的 `previewKind` / `textView` 在这四类之间分流（两个导出在本刀就有生产调用方，knip 不报未引用）；其余类别的分流随 17.2。
  这一刀的边界（定死，下面的测试处置以它为前提）：
  - 留在 `preview.tsx`、同步渲染的：预览头（图标、路径、元数据）、截断提示行、不支持态、错误态——它们不经任何预览器模块。
  - 进模块、首次经动态 `import()` 才出现的：表格（`CsvTable`）、源码（`CodeView`，含 `json` 的格式化）、图片（`img`）、Markdown（`MarkdownPreview` 整个搬走，**`查看源码` / `渲染视图` 切换按钮留在 Markdown 模块里**，不上提到预览头；Markdown 模块在 `previewers/` 内部静态导入源码模块的 `CodeView`，所以同一次挂载里切换视图仍是同步的）。
  - 加载期间显示什么：`preview.tsx` 在模块加载完成之前于预览区正文处显示 `正在加载预览…`（`role="status"`），加载被拒绝时显示 `预览组件加载失败` 与 `重试` 按钮（点击重新发起加载，没有未处理的拒绝）——加载、失败、就绪这三态是同一段逻辑，随动态加载在这一刀一起落地，不留「此刀先空白」的中间态
    （规格依据：file-previewers「按需加载」正文「加载期间预览区 SHALL 显示 `正在加载预览…`（`role="status"`）」与失败一句；失败态里的下载按钮来自预览头的 `下载 <文件名>` 链接，随 17.2 对所有文件出现）。
    写作时文件页的既有测试没有按 `status` 角色取元素的断言（`grep -nE '(get|query|find)(All)?ByRole\("status"' web/test/files-*.tsx web/test/preview.test.tsx` 零命中），新增这个角色不与既有断言冲突；页面级的 `正在读取文件`（`tree.tsx`，取文件内容期间）不变，它先于本占位出现。
  - 这一刀自带的新用例（新文件 `web/test/previewers-loading.test.tsx`，以 `vi.mock` 替换 `previewers/index.ts` 的加载函数，在 `PreviewPane` 一级断言；17.5 在同一文件里补页面级场景）：加载函数挂起时可见 `正在加载预览…` 且它带 `role="status"`、放行后占位消失并显示源码；同一类别换一个文件再渲染时加载函数不再被调用；
    加载第一次被拒绝时显示 `预览组件加载失败` 与 `重试`，点 `重试` 后显示源码，全程没有未处理的拒绝。
  **既有用例由同步改异步**（N-5）。动态 `import()` 至少隔一个微任务，而 RTL 的 `render` 是同步的：凡是 `render(<PreviewPane … status:"success" />)` 之后在同一 tick 里取模块内元素的断言，这一刀合入即红。
  唯一写法：受影响的 `it` 改为 `async`，**每次 `render` 之后、以及每次改变 `path`（`PreviewBody` 以 `key={path}` 重挂）的 `rerender` 之后，第一条取预览正文的查询改为 `await screen.findBy…`**；同一次挂载之内其后的断言保持同步原样；断言的内容一条不改、不删。
  不用预热（`beforeAll` 里先调一次加载函数）的理由：预热之后首帧是否同步，取决于实现在缓存命中时是不是同步渲染（`React.lazy` 与「状态 + effect」两种合法实现的答案不同），规格只要求「不再发起块请求」，测试不应替实现选型；
  预热还让这些用例永远不经过「占位 → 内容」这条用户实际走的路径，并把测试绑到 `index.ts` 的内部导出上。`findBy` 与缓存状态无关，且与 `files-page.test.tsx` 既有的写法一致。也不用手工 `await Promise.resolve()` 或定时等待：加载在 `act` 之外落定会让 React 向 `console.error` 报「not wrapped in act」，下面点名的 `:228` 用例正断言 `console.error` 为空串——`findBy` 在 RTL 的异步包装内等待，不产生这条警告。
  `web/test/preview.test.tsx` 共 23 个 `it`，受影响 12 个，逐个点名（行号为写作时的；每条都记入 PR 的偏离记录，注明「等待方式由同步改为 `findBy`，断言内容不变」）：
  - 帮手 `renderMarkdownProjections`（`:41-55`）：`render` 之后同步 `container.querySelector("[data-markdown-body]")`（`:45`）取不到就抛错——帮手改为 `async`，在 `:45` 之前加 `await screen.findByRole("button", { name: "查看源码" })`（Markdown 模块自己的按钮，出现即模块已挂载），其后原样；三个调用方（下面的 `:280`、`:354`、`:398`）改为 `await`。
  - `describe("PreviewPane CSV routing")` › `routes a successful CSV preview through CsvTable`（`:166-174`）：`:169` 的 `getAllByRole("columnheader")` → `await screen.findAllByRole("columnheader")`，`:173` 原样。
  - `describe("PreviewPane Markdown")` 的全部 9 个 `it`：
    `defaults to rendered Markdown and resets after changing file identity`（`:178-193`）——`:181` 的标题 `第一份` 与换文件（`:189` 的 `rerender` 改了 `path`）之后 `:191` 的标题 `第二份` 改 `findByRole`，其余原样；
    `styles the 查看源码/渲染视图 toggle as a secondary ui-btn in both modes`（`:195-204`，2.1 已改写其断言，届时标题可能已改，按 `查看源码` 的 `className` 断言认）——`:198` 的 `getByRole("button", { name: "查看源码" })` 改 `findByRole`；
    `replaces same-path document content without resetting the chosen mode`（`:206-226`）——只改 `:210` 的标题 `初始`（其后的 `rerender` 都是同一 `path`，不重挂，原样）；
    `renders deep reconstructed Markdown with every literal text pair and link`（`:228-261`）——`:233` 的 `querySelector("[data-markdown-body]")` 之前加 `await screen.findByRole("button", { name: "查看源码" })`，`:253` 换 `path` 之后 `:254` 的标题 `另一份` 改 `findByRole`；`:257` 的「`console.error` 为空串」原样保留，它同时是「加载不在 `act` 之外落定」的证明；
    `renders bold and a later href# link after malformed link syntax`（`:263-278`）——`:267` 的 `querySelector` 之前加同一行 `findByRole`；
    `matches demo bold and formatted-label structure in both HTML and React projections`（`:280-352`）、`matches demo link punctuation around inline code in both HTML and React projections`（`:354-378`）、`matches mdRender HTML structure including href# anchors`（`:398-437`）——经帮手，只把调用改为 `await renderMarkdownProjections(…)`；
    `leaves the URL unchanged for mouse and keyboard activation of href# Markdown links`（`:379-396`）——`:382` 的 `querySelector` 之前加同一行 `findByRole`。
  - `describe("PreviewPane image ownership")` › `renders the supplied image URL without allocating or revoking Blob URLs`（`:441-480`）：`:458` 的 `getByRole("img", { name: "logo.png" })` 改 `findByRole`；`:461` 的 `rerender` 是同一 `path`，`:473` 原样。
    同一用例 `:444` 的 `vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })` 把全局 `URL` 整个换成一个不可构造的普通对象，而图片模块在它之后才第一次被动态导入——模块加载路径上若有 `new URL(…)` 就会抛错（写作时未执行验证，属推断）。同刀把这一行改为 `vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))`：
    `URL` 仍可构造，两个 spy 与 `:478-479` 的「未被调用」断言不变；记入偏离记录。
  - `describe("PreviewPane JSON")` › `pretty-prints valid JSON and keeps invalid JSON as original source`（`:547-563`）：两次 `render` 之后、`:550` 与 `:560` 的 `container.querySelector("table")` 之前各加 `await screen.findAllByRole("row")`（第二次在 `unmount` 之后重新 `render`，同样要等，不假定缓存命中时同步）。
  不受影响、保持同步原样的 11 个（逐个核对过；不要顺手改成异步）：`describe("CsvTable")` 三条（`:84`、`:96`、`:103`）与 `describe("CodeView")` 三条（`:114`、`:129`、`:143`）——测试文件静态导入这两个组件并直接渲染，不经加载函数；
  `describe("PreviewPane metadata")` 一条（`:154`，只断言预览头）；`describe("PreviewPane unsupported error and truncation")` 四条（`:484`、`:502` 不支持态，`:521` 错误态，`:536` 截断提示行与元数据——验证报告里「待核」的那条，截断提示行在 `preview.tsx`，不在模块里）。`:154` 与 `:536` 渲染的是文本文件，正文的加载多半在用例结束、`cleanup` 卸载之后才落定；即便先落定，也没有断言依赖它（至多一条 `act` 警告，这两条用例不看 `console.error`）。
  `web/test/files-page.test.tsx`（写作时 `grep -nE 'findBy|waitFor|getBy(Role|Text)' web/test/files-*.tsx` 里落在预览正文上的断言逐条核对）：
  - 受影响一处——`describe("workspace page route integration")` › `browses cached directories, previews supported files, and creates a directory`（`:81` 起）的 `:138-143`：`:136` 已 `await` 到 `查看源码`（按上面的边界，按钮在 Markdown 模块里，出现即模块已加载），其后同步取预览区里的标题 `第一份`。按同一写法把 `:139` 的 `within(…).getByRole("heading", …)` 改为 `await within(…).findByRole("heading", …)`，使它不依赖「按钮与标题同一次提交」；记入偏离记录。
  - 核对过、不用改的：同一用例 `:145`、`:147`（同一次挂载里切换视图与同 `path` 重取，不重挂）、`:157-158`（先 `findByRole("columnheader")`，注记与表头同一模块同一次提交）、`:161`、`:163`（`findBy`）；`releases a displayed image when replaced and when the page unmounts`（`:441`，`:460`、`:462` 都是 `findByRole("img")`）；
    `shows per-extension icons and trailing sizes…`（`:470`，`:505` 以 `waitFor` 取预览头）；`discards late tree, preview, and directory results…`（`:360`，不断言预览正文）。
    其它文件：`files-concurrency.test.tsx:177`（`findByRole("img")`；`:186-188` 在同一次挂载之内）、`files-errors.test.tsx:81`（错误态，`findByText`）、`files-empty-layout.test.tsx:71`（不支持态，`findByText`）、`files-logical-path.test.tsx` 与 `files-overlays.test.tsx`（不选文件）；
    3.3 在 `files-empty-layout.test.tsx` 的 E5 里新写的「三个滚动容器带 `overflow-auto`」断言按 3.3 的写法本来就是异步取容器，不用改；走查 `web/e2e/ui-walk.spec.ts:228-261` 全部是 Playwright 的自动等待断言（`:233-239` 的 `evaluate` 排在 `:229-231` 的标题 `toBeVisible` 之后），不用改。
  搬家波及的既有导入与读源码断言（写作时 `grep -rnE 'features/files/' web/test` 的命中逐个核对；同刀处置并记入偏离记录）：
  - `web/test/preview.test.tsx:4` 从 `features/files/preview.js` 导入 `CodeView`、`CsvTable`、`PreviewPane`——`CodeView`、`CsvTable` 随模块搬走后，这条导入改指 `previewers/` 下的新模块（测试文件可以直接导入预览器模块；17.3 的「`previewers/` 之外不静态导入其内部模块」只管 `web/src`）；`PreviewPane` 留在 `preview.tsx`。直接渲染这两个组件的六条用例不变，经 `PreviewPane` 渲染的用例见上面的逐条点名。
  - `web/test/chat-messages.test.tsx:185-187` 断言 `preview.tsx` 含 `MarkdownView`、不含 `function renderBlock`——读的文件改为 Markdown 预览器模块（「文件页的 Markdown 仍经 `lib/markdown-view`、不自带渲染器」的意思不变）。
  - 不搬的：`csv.ts`（`web/test/csv.test.ts:2` 导入 `parseCsv`；表格模块导入它）、`file-meta.ts` 的 `fileIcon` / `formatSize` / `formatMtime` / `logicalPath`（`file-meta.test.ts:2`、`files-page.test.tsx:3`、`preview.test.tsx:3`、`files-logical-path.test.tsx:3` 导入；`kind.ts` 的图标映射调用或扩充 `fileIcon`，不另立导出）、
    预览头（`files-page.test.tsx:537-541` 断言 `preview.tsx` 含 `fileIcon(`、`formatSize(`）。`files-empty-layout.test.tsx:190-194` 读的 `preview.tsx`、`types.ts` 仍在原处。
- [ ] 17.2 `preview.tsx`：按 `previewKind` 选预览器（加载中的 `正在加载预览…` 与加载失败的 `预览组件加载失败` + `重试` 已在 17.1 落地，这里只是让新类别也走同一段逻辑）；预览头的 `下载 <文件名>` 链接（`downloadUrl` + `download` 属性）对所有文件渲染；不支持 / 超限 / 截断 / 其它错误的文案表（file-previewers「预览头、下载与不可预览的呈现」）。
  `tree.tsx` / `page.tsx` 去掉扩展名白名单的预判：非按扩展名分流的文件一律发一次 `file` 请求（files-web「目录树与预览」；网页的渲染视图这一例外在组 19 引入，此前 html 仍是源码视图、发一次 `file` 请求）。
  过渡规则：预览器模块尚未合入的类别（pdf、办公文档、音视频、Notebook、压缩包——组 19、20 才有）在此之前按「未知」处理——发一次 `file` 请求，由服务端裁决并沿用既有呈现：pdf、办公文档、压缩包得到 415（workspaces「文件预览」）→ `该类型不支持预览`；Notebook 得到 `text/plain` → 源码视图；音视频得到 `audio/*` / `video/*` → `fetchPreview` 按「失败不变成预览」走 request_failed 的安全文案。每种情况预览头都有下载链接。各自的预览器合入时在那一刀改成该类别的呈现，并改掉受影响的既有断言。
  随条文改写的既有断言（白名单一去、文案一改就红；与 17.2 同 PR，记入偏离记录）：
  - `web/test/preview.test.tsx:497`、`:516`：不支持态副行由 `<文件名> · <大小>　二进制或未识别格式` 改为 `<文件名> · <大小>`（file-previewers「预览头、下载与不可预览的呈现」的文案表）；`:539-542`：截断提示由 `预览已截断（原始大小 N B）` 改为 `文件超过预览上限，仅显示开头部分 · 共 <大小>`（同表；「截断提示」场景）。
  - `web/test/files-empty-layout.test.tsx:51-75`（E2）：`归档.zip` 的副行同上；`:74` 的「零次 `file` 请求」改为「恰一次 `file` 请求、415 后显示不支持」，夹具补该路由的 415 信封，用例标题里的 `without a file request` 同改。
  - `web/test/files-page.test.tsx:162-169`：`archive.zip` 的 `file` 请求数由 0 改为 1（夹具补 415），`该类型不支持预览` 的断言不变。
  写作时既有测试里受白名单影响的只有 zip 这一种扩展名（`grep -rnE '\.zip|\.bin|不支持预览' web/test web/e2e`）；走查不选不支持的文件，不受影响。
- [ ] 17.3 守卫（新文件 `web/test/previewers-code-split.test.ts`）：ui-foundation「预览器按需加载是唯一的代码分割」两个场景的静态部分（动态 `import()` 只在 `previewers/index.ts`、`previewers/` 之外不静态导入其内部模块、`vite.config.ts` 无 `manualChunks`、注入样本自证）；
  「构建产物确有按需块」的唯一落点是 `make ui-walk`：在 `web/e2e/ui-walk-files.ts`（组 3 建的 helper）里，`/files` 步骤选中 `readme.md` 之前记录已成功加载的 `.js`，选中时断言新增了至少一个来自同源 `assets/` 的 200 `.js` 响应。
  走查本来就对 `npm run build --workspace web` 的产物运行（CI 的 ui-walk job 先 build 再起服务），所以不新增构建步骤、不改 `.github/workflows/ci.yml` 的步骤序列，也不动 `scripts/test-ci-harness.sh` 的期望；`make check` 与 `make test-guardrails` 不执行构建，不放这条断言。
- [ ] 17.4 契约测试（`web/test/preview-kind-contract.test.ts`）：读取服务端 `preview.ts` 导出的四个扩展名集合与 `kind.ts` 的对应集合，断言两两相等（file-previewers「与服务端的扩展名表一致」）。
- [ ] 17.5 测试（`web/test/preview.test.tsx` 扩充、`web/test/previewers-loading.test.tsx` 扩充——该文件与它的三条 `PreviewPane` 级用例已随 17.1 建立，这里补页面级场景，其中「加载失败可重试」的 `下载 main.py` 断言依赖 17.2 的预览头；凡取预览正文的断言一律 `await screen.findBy…` / `waitFor`，不在 `render` 或点击之后同步取）：「判定表」「未知文件由服务端裁决」「第一次才加载」「加载失败可重试」「每个文件都能下载」「截断提示」「请求归属与资源释放」。
- [ ] 17.6 FL 行：每个文件都有下载按钮、未知类型文件的两种结果（看得了 / 不支持加下载）；结论 `待签`。
- [ ] 17.7 变异证据：在 `page.tsx` 里静态导入 `previewers/code` → 守卫判红；把 `previewers/index.ts` 的动态 `import()` 全改成静态导入 → 走查的「选中时新增 `.js` 响应」断言判红；不支持态去掉下载链接 → 「每个文件都能下载」判红；恢复扩展名白名单 → `schema.proto` 用例判红；去掉加载期间的 `正在加载预览…` 占位，或让 `重试` 不重新发起加载 → `previewers-loading.test.tsx` 对应用例判红（这两条随 17.1 的 PR）。

Suggested fixture level: compact - 前端展示层的结构调整；全站唯一的代码分割点由静态守卫钉住
Minimal mergeable slice: 17.1 + 17.3（搬家、加载占位与失败重试、静态守卫与走查里的按需块断言，除首次加载的异步之外行为不变；17.1 点名的两处导入 / 读源码断言同刀改指新模块，`preview.test.tsx` 的 12 个用例与 `files-page.test.tsx` 的一处同刀改为 `findBy`，`previewers-loading.test.tsx` 的三条新用例同刀）先合，单独合入时 `make check` 全绿；17.2 的预览头、文案与白名单去除随后，它点名的三个既有测试文件的断言同刀改写

## 18. file-previewers — 源码高亮、tsv、更多图片与 SVG

- [ ] 18.1 `previewers/code.tsx`：引入 `lowlight`、`highlight.js`、`hast-util-to-jsx-runtime`（登记 `ATTRIBUTION.md`）；`highlightLanguage(name)` 映射；只注册映射用到的语言；语法树 → React 元素（不用 `dangerouslySetInnerHTML`）；按行切分后保持行号表；先显示未着色内容；颜色用主题变量（`web/src/styles/theme.css` 增加语法色变量，引用 `--wb-*` token，不写颜色字面量）。
  对既有用例的两个前提与一处改写（着色是正文出现之后才提交的又一次更新；同刀处置并记入偏离记录）：
  - `CodeView` 新增的文件名参数是可选的，不传即不着色、仍带行号——`web/test/preview.test.tsx` 的 `describe("CodeView")` 三条（`:114`、`:129`、`:143`）直接 `render(<CodeView text=… />)`，原样通过。
  - 着色只在内容单元格里加包裹元素，不改行数、不改单元格的 `textContent`，空行仍是一个不换行空格——既有的源码断言比的都是这两样，原样通过：`preview.test.tsx:119-126`、`:135-140`、`:186`、`:221`、`:550-562`（17.1 之后的行号以当时为准），走查 `web/e2e/ui-walk.spec.ts:241-243`（`toHaveText` 比文本）。
  - 改写一处——`describe("PreviewPane Markdown")` › `renders deep reconstructed Markdown with every literal text pair and link`（`:228-261`）：它把 `console.error` 换成 spy 并在 `:257` 断言输出为空串；`:241` 切到源码视图后 `deep.md` 按 `md` 着色，高亮模块的加载在 `act` 之外落定时 React 报「not wrapped in act」，`:257` 即红。
    在 `:241` 的点击之后与 `:242` 的 `rerender` 之后各加一行 `await act(async () => { await loadHighlighter(); })`——`loadHighlighter` 指 `previewers/index.ts` 导出的那个带缓存的高亮加载函数（高亮库的动态 `import()` 只能写在该文件，`code.tsx` 与测试都从它取；名字以实现为准）（等的是同一个带缓存的 promise，着色的提交因此落在 `act` 之内；高亮模块已被同文件前面的用例加载过时这两行是空操作），`:257` 原样保留。
    这里等加载函数而不用 `findBy`，是因为该用例要证明的是「没有 `act` 之外的更新」而不是某段内容出现，且这段输入着色后有没有可供等待的着色元素取决于语法定义。同文件另两处 `console.error` 的 spy（`:104`、`:144`）只匹配 `same key`，不受影响。
- [ ] 18.2 `previewers/table.tsx` 支持 `tsv`（制表符分列）。
- [ ] 18.3 `previewers/svg.tsx`：`data:` 地址的 `img`、图片 / 源码切换、截断时只显示源码、`img` 的 `error` → `无法显示该图片`（仍可看源码）。
- [ ] 18.4 图片预览接受六种类型；`img` 的 `error` → `无法显示该图片`、移除破图、释放 Blob 地址、保留下载链接。
  18.2–18.4 不改动任何既有用例：写作时 `grep -nE '\.(tsv|svg|gif|webp|bmp|ico)' web/test/files-*.tsx web/test/preview.test.tsx web/e2e/*.ts` 零命中（`svg` 今天不在白名单里，没有用例选它）；既有图片用例（`preview.test.tsx:441`、`files-page.test.tsx:441`、`files-concurrency.test.tsx:155`）不触发 `error` 事件，17.1 之后已是 `findBy`。
- [ ] 18.5 测试（新文件 `web/test/previewers-code.test.tsx`、`previewers-table-svg.test.tsx`；两个文件静态导入各自的预览器模块直接渲染，行号、文本、`img` 的 `src` 这类模块同步渲染的内容同步断言，着色元素一律 `await waitFor(…)` 取，「先内容后颜色」以 `vi.mock` 把 `previewers/index.ts` 的高亮加载函数换成可手动放行的 promise；经 `PreviewPane` 走的用例按文首纪律 `findBy`）：file-previewers「源码视图与语法高亮」三个场景、「Markdown、表格、图片与 SVG」四个场景（含「损坏的图片」）；静态断言 `previewers/` 下没有 `dangerouslySetInnerHTML`。
- [ ] 18.6 FL 行：代码文件按语言着色且带行号（亮暗各看一次）、tsv 表格、gif / webp / svg 图片与 svg 的源码切换、损坏的图片文件的提示与下载；结论 `待签`。
- [ ] 18.7 变异证据：把 SVG 文本插进 DOM → 「没有内联 `svg` / `script`」判红；高亮完成前不渲染内容 → 「先内容后颜色」判红；着色后行数变化 → 行数断言判红；图片 `error` 时不处理 → 「损坏的图片」判红。

Suggested fixture level: compact - 独立的预览器模块；安全点（不把文件内容当 HTML）有专门的断言
Minimal mergeable slice: 18.2（tsv）、18.3（svg）、18.4（图片）三刀互不依赖、都没有新依赖，各带自己的用例可分别先合；18.1 的高亮带依赖登记随后

## 19. file-previewers — 隔离来源：网页渲染、PDF 与办公文档

- [ ] 19.1 `web/src/features/files/use-preview-token.ts`：按工作空间共用一次签发、有需要它的预览挂载时每 5 分钟续期、无挂载时不续期、卸载与换空间时中止；令牌不进地址栏与存储。
- [ ] 19.2 `previewers/frame.tsx`：网页渲染视图（`sandbox="allow-scripts allow-forms allow-modals"`、`referrerpolicy="no-referrer"`、无 `srcdoc`、渲染 / 源码切换；选中 html 时不发 `file` 请求，切到源码才发）、PDF 与办公文档（无 `sandbox`、`正在转换文档…` 遮层、三种不建 iframe 的情况）；路径按段编码。
  PDF 与办公文档的部分 Depends on 1.1：其结论与设计相符才开工（不符时这一部分停下，网页渲染视图照常交付）。
- [ ] 19.3 测试（新文件 `web/test/previewers-frame.test.tsx`、`use-preview-token.test.tsx`）：file-previewers「隔离来源的嵌入与令牌」四个场景与「PDF 与办公文档」三个场景（假定时器驱动续期；`navigator.pdfViewerEnabled` 打桩）。
  写法：两个文件静态导入 `previewers/frame` 与 hook 直接渲染（不经加载函数）；`iframe` 在令牌签发的 promise 落定之后才出现，真实定时器下一律 `await screen.findBy…` / `waitFor` 取它再断言属性，「此时没有发出 `file` 请求」这类计数断言排在取到 `iframe` 之后；
  「共用与续期」在 `render` 之前装假定时器，签发与续期都用 `await act(() => vi.advanceTimersByTimeAsync(n))` 推进后同步断言，不混用 `findBy`。
  对既有用例：写作时 `grep -nE '\.(html?|pdf|docx|xlsx|pptx)"' web/test/files-*.tsx web/test/preview.test.tsx` 零命中——文件页的既有测试不选这些类型，19.2 不改动任何既有用例（产物卡与走查里的 html 归组 25）。
- [ ] 19.4 FL 行：html 的渲染 / 源码切换且同目录的样式表与图片在预览里生效、pdf 可翻页、docx / xlsx / pptx 转换后可看、服务器没装转换组件时的说明、超过上限的文档只给下载；结论 `待签`。
- [ ] 19.5 变异证据：给网页 iframe 加 `allow-same-origin` → 属性断言判红；每次预览都重新签发 → 「合计恰一次签发」判红；整条路径一次 `encodeURIComponent`（把 `/` 也编码）→ 路径编码用例判红。

Suggested fixture level: expanded - 不可信内容的嵌入方式与凭据的前端生命周期；属性错一个就是来源隔离被削弱
Minimal mergeable slice: 19.1 的 hook 与测试先合；`frame.tsx` 的网页渲染视图随后；PDF 与办公文档（等 1.1）再随后

## 20. file-previewers — 音视频、Notebook、压缩包

- [ ] 20.1 `previewers/media.tsx`：`audio` / `video`（`controls`、`preload="metadata"`、`src` 为 `fileUrl`、`error` → `无法播放该文件`）。
- [ ] 20.2 `previewers/notebook.tsx`：nbformat 4 的只读渲染（design D6 与 file-previewers「Notebook」）；Markdown 单元经 `mdRender`（只调用，不改 `md-render.ts`）；代码单元复用 18.1 的着色；输出按类型；解析失败退回源码。
- [ ] 20.3 `previewers/archive.tsx`：`listArchive` 的表格、`共 N 项` / `仅显示前 N 项`、空包、415。
  压缩包至此不再走 17.2 的过渡规则，17.2 改过的两处 zip 断言同刀再改（记入偏离记录）：`web/test/files-page.test.tsx:162-169` 与 `files-empty-layout.test.tsx` 的 E2 里，选中 zip 由「一次 `file` 请求、415、`该类型不支持预览`」改为「一次 `archive` 请求、零次 `file` 请求、显示成员列表」
  （files-web「目录树与预览」的场景「一次浏览」；夹具补 `archive` 路由的响应）。两处都把原来 `await screen.findByText("该类型不支持预览", …)` 那一行换成 `await screen.findByText(<夹具里的一个成员路径>)`，请求次数的断言排在它之后（成员列表要等压缩包模块加载与 `listArchive` 两步，不能同步取）。E2 的另一半（空目录文案）不动。组 19、20 的其余类别（pdf、办公文档、音视频、Notebook）在写作时的既有测试里没有用例，各自合入时以开工的 grep 为准。
- [ ] 20.4 测试（新文件 `web/test/previewers-media.test.tsx`、`previewers-notebook.test.tsx`、`previewers-archive.test.tsx`）：三条需求的全部场景。写法：三个文件静态导入各自的预览器模块直接渲染；`audio` / `video` 的属性、Notebook 的单元格结构与输出同步断言，Notebook 代码单元的着色元素 `await waitFor(…)`，压缩包的表格与文案在 `listArchive` 落定后才有，一律 `await screen.findBy…`；
  「没有经 `fetchPreview` 发出的请求」「点击它们没有任何请求」这类计数断言排在取到正文之后。20.1、20.2 不改动任何既有用例（音视频与 `ipynb` 在既有测试里没有用例，见 20.3 末句）。
- [ ] 20.5 FL 行：mp3 / mp4 可播放并可拖动进度、ipynb 的单元格与输出、zip / tar.gz 的文件列表与上限说明；结论 `待签`。
- [ ] 20.6 变异证据：Notebook 的 `text/html` 输出直接插入页面 → 「主文档没有新增 `script` / `table`」判红；压缩包成员名当 HTML 渲染 → 「恶意成员名只是文字」判红；媒体改用 `fetchPreview` → 「没有经 `fetchPreview` 的请求」判红。

Suggested fixture level: compact - 三个互不相干的预览器模块；不可信输出的处理各有反例断言
Minimal mergeable slice: 三个预览器各自可单独合入（20.1、20.2、20.3 各带自己的测试；20.3 另带它点名的两处 zip 既有断言的改写）

## 21. files-web — `WorkspaceBrowser` 与地址定位到文件

- [ ] 21.1 把目录树 + 预览 + 请求归属从 `page.tsx` 抽成 `web/src/features/files/workspace-browser.tsx`，经 `index.ts` 导出（files-web「工作空间浏览器组件」）：受控的 `path` / `onPathChange`、`layout`、`reveal`、`refresh`、`markedPaths`、`onlyPaths`。文件页改为它的一层包装。
  既有测试里按文件路径读源码的断言随抽取核对：`web/test/files-page.test.tsx:536-544`（`tree.tsx` 含 `fileIcon(`、`formatSize(`、`size={14}`，不含手写图标路径）、`files-empty-layout.test.tsx:183-189`（`tree.tsx`、`page.tsx` 不含 `此文件夹为空` 等三个字面量）、`topbar.test.tsx:263`（`page.tsx` 不含 `<h1`）——
  树条目的渲染留在 `tree.tsx` 则都原样通过；若把它一并搬进新文件，这些断言读的路径同刀改指新文件（断言内容不变，记入偏离记录）。`data-slot` 与 3.1 列的 DOM 结构随组件原样带走。
- [ ] 21.2 `page.tsx`：`path` 查询参数（files-web「地址定位到文件」）——深链逐级展开、选中以 `replace` 写入、切换空间与 `ws` 被纠正时移除、指向目录 / 不存在 / 越界的三种呈现。
- [ ] 21.3 测试（新文件 `web/test/files-deep-link.test.tsx`、`workspace-browser.test.tsx`）：「地址定位到文件」前三个场景与「工作空间浏览器组件」三个场景；静态断言 `features/files` 不从 `features/chat` 导入。
- [ ] 21.4 FL 行：带文件的地址可直接打开并定位、刷新后仍在同一文件、指向不存在文件的地址的表现；结论 `待签`。
- [ ] 21.5 变异证据：选中时用 `push` → 「没有新增历史记录」判红；`ws` 被纠正时保留 `path` → 非法 `ws` 用例判红；`onlyPaths` 下仍请求 `tree` → 「没有新的 `tree` 请求」判红。

Suggested fixture level: compact - 前端结构抽取加一个查询参数；路径只作为数据交给服务端裁决
Minimal mergeable slice: 21.1（抽组件，行为不变，既有文件页测试保绿）先合；21.2 的地址参数随后。会话页卡片的 `查看详情` 在组 25 之前保持现有的 `?ws=` 导航，本组不动它

## 22. files-web — 文件操作界面

- [ ] 22.1 行菜单 `更多操作 <名>`（`dropdown-menu`）与 `重命名` 对话框（`dialog`）：校验、409 文案、同名不发请求、忙碌态与取消中止。
- [ ] 22.2 `移动到…` 对话框（目标只列已加载目录，去掉自身、后代与当前父目录；没有可选目标时的文案与禁用）。
- [ ] 22.3 原生拖放（可接受目标的判定、经过时高亮、树区上方 `role="alert"` 的失败文案）。
- [ ] 22.4 `删除` 确认框（`alert-dialog`，两种说明文案、初始焦点在 `取消`、框内显示失败）。
- [ ] 22.5 操作后的状态跟随：受影响层的刷新；当前文件 / 祖先被改名、移动、删除时选中项与 `path` 的变化；被移动目录的展开状态与已加载子层跟到新路径。
- [ ] 22.6 测试（新文件 `web/test/files-ops-rename.test.tsx`、`files-ops-move.test.tsx`、`files-ops-delete.test.tsx`）：files-web「文件操作界面」六个场景、「地址定位到文件」的「随操作更新」、「创建浮层的焦点时序与模态清理」里新增的三个对话框、「树的键盘操作」「没有范围外的入口」。拖放用 `DataTransfer` 打桩的 `dragstart`/`dragover`/`drop` 事件驱动。
- [ ] 22.7 FL 行：重命名（含同名冲突的提示）、拖拽移动与「移动到」（含目标同名时拒绝）、删除的确认与结果、回合进行中照常可操作、键盘走通一遍行菜单；结论 `待签`。
- [ ] 22.8 变异证据：拖到自身后代也接受 → 「不接受放下、没有请求」判红；删除确认框初始焦点放在 `删除` → 焦点用例判红；重命名后不更新 `path` → 「当前文件随操作变化」判红；失败用 Toast → 「页面无 Toast」判红（且分层守卫会拒 `useToast`）。

Suggested fixture level: compact - 前端交互；破坏性操作的确认与焦点、冲突文案各有用例，服务端边界已在组 8、9 钉住
Minimal mergeable slice: 22.1（重命名）、22.4（删除）、22.2（移动到）、22.3（拖放）四刀各自可单独合入，各带 22.6 里自己的测试文件与用例；22.5 的跟随逻辑随第一个需要它的操作（重命名）一起合。四刀都经 16.2 的 `moveEntry` / `deleteEntry` 依赖 9.1 或 8.2，因此整组间接等 1.2

## 23. workspace-sidebar — 外壳：顶栏按钮、并排布局、窄屏覆盖；移除产物面板

- [x] 23.1 拷入 shadcn `resizable` 到 `web/src/components/ui/resizable.tsx`（`react-resizable-panels` 加入依赖并登记 `ATTRIBUTION.md`；只做六类修改；确认没有引入新的 `@radix-ui/*` 包）。
  实施注记见 `implementation-notes.md`「23.1（#1104）」。
- [ ] 23.2 新文件 `web/src/features/chat/workspace-sidebar.tsx` 与 `use-workspace-sidebar.ts`（登记 `MIGRATED_AREAS`）：开合意图、宽屏的 `complementary` + 分隔线、宽度读写 `localStorage` 键 `workbuddy-workspace-sidebar`（读失败与非法值回缺省）、窄屏的全屏 `sheet`（焦点进 `关闭`、Escape、焦点归还且 `preventScroll`）、
  切换会话保持、未绑定会话与欢迎态不渲染但保留意图。主体先挂 `WorkspaceBrowser`（`stacked` 布局，无标记、无过滤）与头部的 `刷新`、`关闭`、`在文件页打开`。
- [ ] 23.3 `topbar-actions.ts`：第四项改为 `{key:"workspace", label:"工作空间侧边栏", icon:"folder"}`，带 `expanded`，只在 `workspaceId` 非 null 时填入；`page.tsx` 的主区改为对话区 + 侧边栏两栏。
  删除 `artifacts-panel.tsx` 及其四个测试文件（`chat-page-artifacts-panel*.test.tsx` 与 support），从 `MIGRATED_AREAS` 与清单断言两处（`web/test/ui-layering.test.ts:21`、`:333`）去掉它的条目；`page.tsx:4`、`:33` 对 `useArtifactsPanel` 的使用随之去掉；
  `artifact-card.tsx` 里只被面板用的 `ArtifactRowAction`（写作时唯一调用方是 `artifacts-panel.tsx:61`）一并删除。
  **support 文件不能直接删**：`web/test/chat-page-artifacts-panel-support.tsx` 还被两个不删的测试文件导入——`chat-page-search.test.tsx:12`（`artifactsPanelFixture`、`openProbedSession`）与 `chat-page-artifact-card-feedback.test.tsx:36-40`（`artifactsPanelFixture`、`renameBehindDialog`、`renameRoute`）。
  先把这四个导出（连同它们依赖的夹具常量）搬进一个不带 panel 字样的新 support 文件 `web/test/chat-page-shell-support.tsx`（`artifactsPanelFixture` 顺手改名为不提面板的名字），两个导入方改导入路径，再删原 support 文件；面板专用的其余导出（`openPanel`、`panelRows`、`drawer` 等）随文件删除。
- [ ] 23.4 测试（新文件 `web/test/chat-workspace-sidebar-layout.test.tsx`、`chat-workspace-sidebar-narrow.test.tsx`）：workspace-sidebar「顶栏入口与可用性」两个场景、「布局与开合」五个场景（其中「宽屏并排与拖动」的后半断言刷新后侧边栏初始为关闭、再次打开时宽度等于刷新前，owner D-20）；`web/test/topbar-actions.test.tsx` 与 chat-web「顶栏入口」、session-sidebar 的按钮次序断言随条文改写。
  断言了 `产物面板` 的既有文件逐个处理（写作时 `grep -rln 产物面板 web/test web/e2e` 的结果；开工时重跑一次，C 与 S1g 新增或改名的文件一并处理，结果记入 PR 的偏离记录）：
  删除——`web/test/chat-page-artifacts-panel.test.tsx`、`chat-page-artifacts-panel-focus.test.tsx`、`chat-page-artifacts-panel-sheet.test.tsx`、`chat-page-artifacts-panel-support.tsx`（23.3）；
  改按钮名与次序断言——`web/test/chat-page-session-pin.test.tsx`、`chat-page-session-rename-pin.test.tsx`、`chat-page-project-config.test.tsx`、`chat-page-search.test.tsx`、`chat-page-search-support.tsx`；
  只改导入路径（不含 `产物面板` 字样，上面的 grep 找不到它们，另用 `grep -rn 'artifacts-panel' web/test web/e2e web/src` 找）——`chat-page-artifact-card-feedback.test.tsx`、`chat-page-search.test.tsx`（23.3 的 support 搬家）；
  走查——`web/e2e/ui-walk-steps.ts`（`:136-178` 的 `walkArtifactsPanel` 删除，其调用在 `ui-walk-sessions.spec.ts:35`、`:131`）、`web/e2e/ui-walk-project-config.ts`（23.5）。
- [ ] 23.5 走查（`web/e2e/` 新 helper `ui-walk-workspace-sidebar.ts`，在 `ui-walk-sessions.spec.ts` 里只换调用、不增行）：顶栏按钮断言改为 `工作空间侧边栏`；原「`产物面板` 打开面板并列出该文件」换成「打开侧边栏，树里有 `workbuddy-report.html`」；
  `desktop-light` 断并排且无横向溢出，`mobile-dark` 断对话框形态与 Escape 后的焦点。原 `打开网页预览` 对话框的断言此时仍保留（组 25 才改）。
- [ ] 23.6 清单：SH-05、CH-37 里的「产物面板」改为「工作空间侧边栏」；CH-34、CH-35、CH-36 与 CH-54 的前半改写为侧边栏的对应行（打开 / 关闭的四种方式按新形态重写、空态、窄屏覆盖、切换会话保持打开）；新增行：分隔线拖动与宽度记忆、未绑定工作空间的会话没有该按钮。结论一律 `待签`（被改写的已有行同样回到 `待签`）。
- [ ] 23.7 变异证据：切换会话时关闭侧边栏 → 「切换会话保持打开」判红；未绑定会话也上报按钮 → 可用性用例判红；窄屏关闭后不还焦点 → 窄屏用例判红；`localStorage` 抛错未兜住 → 「存储值不合法」判红。

Suggested fixture level: expanded - 改共享入口（会话页 `page.tsx` 的主区布局与 `CHAT_TOPBAR_ACTIONS` 的顶栏槽位）、新增持久化的 `localStorage` 键、删除一个既有面板及其测试（BREAKING）；评审要看顶栏槽位的其它消费方与回合、连接、草稿不受影响（「不打断回合」用例）
Minimal mergeable slice: 23.1（拷入组件与依赖登记；knip 的拷入层豁免只压住该文件自身的未使用文件与未使用导出，压不住 web/package.json 上的「未使用依赖」，故同刀新增 web/test/components-ui-resizable.test.tsx 作为唯一导入方，不改 knip.json）先合；23.2–23.6 同刀——顶栏槽位只有一个，面板的移除与侧边栏的引入、走查与清单必须一起换；同刀之内先搬 support 的四个导出、改两个导入方，再删面板的四个测试文件

## 24. workspace-sidebar — 本会话改动标记与过滤、随助手改动刷新

- [ ] 24.1 改动集合：复用 `stream-artifacts.ts` 的 `summarizeChanges` 对全视图聚合（原面板的 `sessionChanges` 逻辑搬到侧边栏的 hook 里）；传给 `WorkspaceBrowser` 的 `markedPaths`（标记文本 `本会话已改动`，父目录同标）。
- [ ] 24.2 `只看本会话改动` 开关（`aria-pressed`）→ `onlyPaths`；空集合文案 `本会话暂无文件改动`；切换会话重置；关闭开关后恢复原展开与选中。树区的 `折叠文件树` / `展开文件树`。
- [ ] 24.3 刷新（workspace-sidebar「随助手改动刷新」）：新的已结束步骤 `changes` → 300 毫秒合并后 `refresh(这些路径)` 并在命中当前文件时重取预览；生成中 → 不在生成中 → `refresh()`；关闭期间不请求、重开时刷新一次；刷新失败保留旧树。
- [ ] 24.4 测试（新文件 `web/test/chat-workspace-sidebar-changes.test.tsx`、`chat-workspace-sidebar-refresh.test.tsx`）：两条需求的全部场景（假定时器驱动合并；用既有的事件注入支持文件推 `files.changed` / `step.end` / 回合结束）；workspace-sidebar「内容与文件操作」三个场景。
- [ ] 24.5 CH 行：树上的改动标记与「只看本会话改动」、助手写文件后树自己更新（写文件工具与命令各一例）、回合进行中在侧边栏里删除 / 重命名文件的表现；结论 `待签`。
- [ ] 24.6 变异证据：running 步骤的 `changes` 也计入 → 标记用例判红；过滤时仍去列目录 → 「没有发出 `tree` 请求」判红；去掉回合结束的兜底 → `bash` 用例判红；关闭期间照常刷新 → 「关闭期间不请求」判红；去掉合并 → 「恰一轮刷新」判红。

Suggested fixture level: compact - 由既有会话视图派生的展示与请求节流；不新增服务端契约
Minimal mergeable slice: 24.1–24.2（标记与过滤，纯派生）先合；24.3 的刷新随后；24.4 里「内容与文件操作」的场景「同一套组件与操作」与 24.5 的第三行（回合进行中删除 / 重命名）在 22.1、22.3、22.4 合入后补（间接等 1.2），其余用例与清单行不等

## 25. turn-artifacts — 卡片动作定位到侧边栏；移除网页预览对话框

- [ ] 25.1 `file-changes-card.tsx`：`查看详情` 改为调用侧边栏的 `reveal(path)`（经 `page.tsx` 下发的回调，不从卡片里导入页面状态）；渲染条件改为会话 `workspaceId` 非 null——空间不在列表里、列表读取失败与临时空间会话都照常渲染，名字用相对路径（turn-artifacts「文件变更卡」的场景「空间不可解析」「临时空间会话的文件变更卡」）；去掉原来到 `/files?ws=` 的导航。
- [ ] 25.2 `artifact-card.tsx`：html 的 `打开网页预览` 改为 `reveal(path, {view:"rendered"})`；删除 `PreviewDialog` 与它的 `fetchPreview` 调用、截断提示分支；图片 `下载` 改为 `<a href={downloadUrl(workspaceId, path)} download>`（与预览头同一实现，owner D-19），删除图片的 `fetchPreview` 调用、Blob 地址的创建与撤销及其就地失败分支；代码 `复制代码` 不动。产物卡是否渲染沿用 C 的「空间可解析」判定，不改。
- [ ] 25.3 定位的竞态与焦点（workspace-sidebar「从卡片定位到文件」）：最后一次为准；宽屏焦点留在按钮；窄屏进 `关闭`、关闭后回到按钮且线程不滚动。
- [ ] 25.4 测试：`web/test/chat-page-file-changes.test.tsx`、`chat-page-artifact-card.test.tsx`、`chat-page-artifact-card-feedback.test.tsx`、`chat-page-artifact-card-state.test.tsx` 与两个 support（`chat-page-artifact-card-support.tsx`、`chat-page-file-changes-support.tsx`）随条文改写（turn-artifacts「产物卡」的「html 预览隔离」「图片下载与代码复制」「拉取中与卸载」「临时空间会话照常渲染产物卡」的新形态；删除对话框、`srcdoc` 与图片 Blob 下载的用例，图片 413 的就地文案用例随之删除并记入偏离记录）；新文件 `web/test/chat-workspace-sidebar-reveal.test.tsx` 覆盖「从卡片定位到文件」五个场景。
  写作时 `grep -rnE 'PreviewDialog|打开网页预览|srcdoc|网页预览|查看详情|files\?ws=' web/test web/e2e` 的命中按刀归位（面板的四个文件已在 23.3 删除；开工时重跑，结果记入偏离记录）：
  - 随 25.1（文件变更卡）：`chat-page-file-changes.test.tsx:468-525`（C9/G5 断言 `查看详情` 导航到 `/files?ws=<id>`）改为「URL 不变、侧边栏打开并选中该文件」；`:590-624`（C11/G4 与 C11 断言空间不可解析、列表读取失败时**没有** `查看详情`）按改写后的 turn-artifacts「文件变更卡」场景「空间不可解析」改为：`workspaceId` 非 null 的情形每行仍有 `查看详情 <相对路径>`，只有 `workspaceId` 为 null 的情形没有（用例标题里的 `without 查看详情` 同改）；
    `chat-page-file-changes-support.tsx:47` 的 `DETAILS` 匹配（`/^查看详情/`）按钮名不变，原样保留。
  - 随 25.2（产物卡）：`chat-page-artifact-card-state.test.tsx` 的 H3（`:83` 起，「再次打开预览会重新拉取」）与两条 H5（`:163`、`:188` 起，「打开中 / 拉取中的预览跟着自己的卡片」）断言对话框里 iframe 的 `srcdoc`（`:94`、`:105`、`:181`、`:212`），测的是预览对话框——随对话框**删除**，「最后一次为准」的意思由 `chat-workspace-sidebar-reveal.test.tsx` 的竞态用例接住；
    同文件 `:115-120` 起的 H4（拉取中禁用动作，按 image / code 两行参数化）去掉 image 一行（图片下载不再经 `fetchPreview`，没有拉取中的状态），code 一行保留；H2、H6 不动；
    `chat-page-artifact-card-support.tsx` 的 `OPEN_INDEX`（`:37`，按钮名不变，保留）、`truncatedPreview` 与 `:63`、`:88-91` 统计 `…/file?path=` 请求的帮手（html 与图片不再发这个请求：只被删除用例使用的帮手一并删除，其余保留——knip 不留未引用导出）；
    `chat-page-artifact-card.test.tsx:228`、`:295`（html 与图片各发一次 `GET …/file`）改为「`GET …/file` 次数不增加」，`:318`（代码 `复制代码` 仍发一次）不动，`:393-400`（A8：html 预览 415 的就地文案）随对话框删除；
    `chat-page-artifact-card-feedback.test.tsx`（逐个 `it`）：`describe("失败就地显示")` 里的 `F3 a failed download shows the envelope message in its card and a later successful one removes it`（`:141-164`，图片 `下载` 经 `fetchPreview` 得 413 后就地显示信封文案、成功后经 `spyDownloads` 看到 Blob 链接被点击）——**删除**：下载改成普通链接后卡片不再为图片发请求，没有就地失败分支（即 25.4 首段说的「图片 413 的就地文案用例」；新形态由 `chat-page-artifact-card.test.tsx:295` 改写后的断言与 turn-artifacts「图片下载与代码复制」的用例证明）；
    同一 `describe` 的 `F3 a failed html preview shows its message between the head and the foot and an opened preview removes it`（`:166-192`，`:188` 断言对话框里 iframe 的 `srcdoc`）——**删除**：卡片不再为 html 发 `file` 请求，失败不再显示在卡片里，改由侧边栏预览区显示（workspace-sidebar「从卡片定位到文件」的场景「文件已不存在」，在 `chat-workspace-sidebar-reveal.test.tsx`）；
    `describe("html 预览对话框（拷入层 dialog）")` 整个（`:194-260`）——**删除**：`it.each` 的两条 `F4 closing the preview with %s focuses the button that opened it without scrolling`（`:200-232`，`关闭` 与 Escape 各一）的「关闭后焦点回到打开它的按钮且不滚动」由 `chat-workspace-sidebar-reveal.test.tsx` 的「窄屏的焦点往返」接住（25.3）；
    `F5 Escape closes the preview while a later toast holds the top of the layer stack`（`:237-259`）测的是预览对话框与 Toast 的叠层，对话框不存在后没有对应条文，随之删除。
    该文件留下不动的：`F1`（`:56`）、`F2`（`:91`，代码卡的复制失败与截断；其中 `previewCalls` 只数代码卡的请求）、`F6`（`:263`，`查看详情` 的按钮名不变）。删除之后该文件不再用到的导入（`CHART`、`DOWNLOAD_CHART`、`INDEX`、`OPEN_INDEX`、`HTML_TEXT`、`frameOf`、`previewDialog`、`spyDownloads`、`renameBehindDialog`、`renameRoute`、`changedTurn`、`envelope`、`imagePreviewResponse`、`jsonResponse` 中届时确已无引用的）同刀去掉；
    support 里因此零引用的导出按 knip 删除——`chat-page-artifact-card-support.tsx` 的 `previewDialog`（`:146`）、`frameOf`（`:150`）、`spyDownloads`（`:207`），以及 23.3 搬进 `chat-page-shell-support.tsx` 的 `renameBehindDialog` / `renameRoute`（写作时除面板测试外只有 F5 用它们）；以开工时 `grep -rnE 'previewDialog|frameOf|spyDownloads|renameBehindDialog|renameRoute' web/test` 为准。
- [ ] 25.5 走查（落点：`web/e2e/ui-walk-sessions.spec.ts:386-393` 断言 `查看详情` 之后的首次导航是 `/files?ws=<id>`——随 25.1 改；`web/e2e/ui-walk-steps.ts:86-100` 的预览对话框帮手与其 `iframe[title=…]` 断言——随 25.2 改；`ui-walk-sessions.spec.ts` 776 行，只换调用、不增行）：chat-harness「UI 走查会话元数据」第 5 步按改写后的条文（`查看详情` 打开侧边栏并选中、URL 不变；隔离来源的 iframe 与其 `sandbox`、文档标题 `WorkBuddy`；`打开网页预览` 到达同一状态；`只看本会话改动` 恰一个文件）；
  chat-harness「UI 走查临时空间、撤回与归档」第 1 步按本 change 的 MODIFIED 改写（C 的 helper `web/e2e/ui-walk-session-list.ts`：临时空间会话的文件变更卡有 `查看详情`；`打开网页预览` 打开头部为 `工作空间` 的侧边栏并以隔离来源的渲染视图选中该文件，随后关闭侧边栏再继续撤回步骤）；
  `web/e2e/ui-walk-oracle.ts` 的「零非 `baseURL` 源请求」加入预览来源的例外（以页面自己那次 `preview-token` 响应的 `base` 为准，verification-harness）。
- [ ] 25.6 清单：CH-27（`查看详情` 的期望）、CH-28、CH-29（原预览对话框的两行改写为侧边栏里的渲染预览与关闭后的焦点 / 不滚动）、CH-53（超大网页一句改为侧边栏的渲染视图不受 1 MiB 截断）；CH-33（图片卡的下载）改写为：点下载由浏览器直接保存原文件、不受图片预览大小上限约束、审计里有一条 `file.download`；逐行核对 CH-30–CH-32（复制不变，只确认措辞里没有残留的对话框）。结论 `待签`。
- [ ] 25.7 变异证据：`查看详情` 仍然导航 → 「URL 不变」判红；保留 `srcdoc` 对话框 → 「没有 `srcdoc` iframe」判红；卡片为 html 调 `fetchPreview` → 「`GET …/file` 次数不增加」判红；图片下载仍走 `fetchPreview` + Blob → 「没有 `GET …/file`、没有 Blob 地址」判红；临时空间会话不渲染 `查看详情` → 走查临时空间第 1 步与「临时空间会话的文件变更卡」判红；窄屏关闭后滚动线程 → 焦点往返用例判红。

Suggested fixture level: expanded - 放宽全站走查 oracle（`ui-walk-oracle.ts` 的「零非 `baseURL` 源请求」加例外）、删除既有的预览对话框与图片 Blob 下载（legacy 行为移除）；评审要看 oracle 例外有没有写宽、两张卡的其它消费方
Minimal mergeable slice: 25.1（文件变更卡）与 25.2（产物卡）可各自成 PR，各带自己的测试、走查与清单行；25.5 的 oracle 例外随第一个让走查加载隔离来源 iframe 的 PR

## 26. files-harness — 夹具与 `files.hurl`

- [x] 26.1 夹具：`smoke/fixtures/sandbox/u1/smoke-fixture/` 新增 `site/index.html`、`site/style.css`、`sample.py`、`clip.wav`（按 files-harness「沙箱夹具与 files.hurl」的内容约定；`clip.wav` 由一段不入库的脚本生成，生成方式记入 `smoke/fixtures/README.md`）。
  实施注记见 `implementation-notes.md`「26.1（#1111）」。
- [ ] 26.2 `smoke/files.hurl`：追加范围请求、下载、`hurl-a` → `hurl-b` 的重命名与删除（宽容状态码保证可重复）、同名移动 409、越界删除 403、`preview-token` 与隔离来源的 html / css / 伪造令牌 404、主站对同一 html 的 `text/plain`、他账号的三个 404。
- [ ] 26.3 验证：对同一服务连续两次 `make smoke` 全绿；在 `POST move` 之后人为中断一次再跑仍全绿；跑完后空间里没有 `hurl-a` / `hurl-b`、夹具文件未变（`git status` 干净）。
- [ ] 26.4 变异证据（对临时改坏的服务各跑一次，结果写进 PR）：预览监听器对 html 返回 `text/plain` → hurl 判红；主站对 html 返回 `text/html` → hurl 判红；删除后条目仍在 → 第二次删除的 404 断言判红。

Suggested fixture level: compact - 冒烟用例与被跟踪夹具的扩充，不改产品代码
Minimal mergeable slice: 26.1 的夹具与 README 可先合（既有 hurl 只断言「包含」三个文件，不受新增文件影响）；26.2 按步骤分两刀——范围请求、下载、`preview-token` 与隔离来源、主站 `text/plain`、他账号 404 的步骤先合（Depends on 7.3、9.3、13.1）；重命名 / 删除 / 同名移动 409 / 越界删除 403 的步骤随后（Depends on 8.2、9.1，间接等 1.2），26.3、26.4 里针对它们的验证随这一刀

## 27. files-harness — `/files` 走查的新步骤

- [ ] 27.1 `web/e2e/ui-walk-files.ts`（组 3 建的 helper）：files-harness「走查 /files 步骤」新增的 (a)–(f)——高亮的源码与地址里的 `path`、隔离来源的 html 预览及其相对样式表（标题颜色 `rgb(0, 128, 0)`）、源码切换、音频播放器、下载链接、重载后仍选中、
  把 `walk-out-<project>` 重命名为 `walk-renamed-<project>` 后经确认框删除并以 `tree` 接口复核。两个 project 都跑。
- [ ] 27.2 验证「相对资源没加载不可假绿」：在隔离的调用方夹具里删掉 `site/style.css` 跑一次，确认在标题颜色断言处失败；恢复后全绿。结果写进 PR。
- [ ] 27.3 FL 行核对：把组 3、17–22 各自加的 FL 行通读一遍，补上遗漏的窄屏与深色情形，去重；确认全部为 `待签`、守卫通过。

Suggested fixture level: compact - 真实浏览器走查的扩充；隔离来源 iframe 的行为只有这一层能证明
Minimal mergeable slice: (a)(c)(d)(e) 四步不依赖隔离来源，可先合；(b)（Depends on 19.2 的网页渲染视图）与 (f)（Depends on 22.1、22.4，间接等 1.2）各自随后

## 28. 文档与真实环境验证

- [ ] 28.1 新增 `docs/adr/0014-isolated-preview-origin.md`：隔离预览来源的决定（独立端口、路径令牌、不认 cookie、CSP `sandbox` 与 PDF 的例外、外部资源放行及其后果）、办公文档经 LibreOffice 转换、回收目录；
  运维一节：`PREVIEW_PORT` / `PREVIEW_ORIGIN` 的设置与反向代理、放行端口、安装 LibreOffice 与 `OFFICE_BIN`、十二个环境变量一览、按审计 `trashId` 从 `<SANDBOX_ROOT>/.trash` 恢复的步骤、`PREVIEW_CACHE_DIR` 没有总量上限、`OMP_USER` 模式下被终止的转换每次都留下 `soffice.bin` 并把转换跑完（owner D-25：怎样按作业目录查到这些进程、以哪个身份结束它们；实际并发可以超过 `OFFICE_CONVERT_CONCURRENCY`；同 28.2）、同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时 `work` 在一次运行期间增长而重启时归零及其所需的那一行 sudoers（owner D-24：没配 `OFFICE_BIN` 的部署不执行这条命令、不需要这一行；规则里的路径必须与服务端解析出的 `PREVIEW_CACHE_DIR` 绝对路径逐字相同；漏配时启动日志里的 `preview_work_clear_failed`）、#1286 的已知残余与它的界限（owner D-23，design D22「已知残余」）、助手改掉组写位的条目删除 / 移动会失败（1.2 的结论）、临时空间删除后其回收批次保留到期满、上传中的 `.part` 文件在目录树里可见。
- [ ] 28.2 `docs/adr/0010-dedicated-omp-uid.md` 增补：转换进程以 omp 用户运行、新增的两行 sudoers（转换的 spawn 前缀一行；启动时清空 `work` 的固定参数、无通配的 `/usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete` 一行，owner D-24——写明它是提权面的扩大、作用范围、只在同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时于启动时执行一次、失败不阻止启动、单次转换后的删除不提权；没有第三行，不存在 `kill` / `pkill` 规则）、`PREVIEW_CACHE_DIR` 三个目录的 mode；终止转换的做法（owner D-21：`OMP_USER` 模式杀 `sudo`、直接子进程靠 pdeathsig）与**已知残余**（owner D-25，按 1.3 的实测写事实：`soffice.bin` 每次都留下、把整份转换跑完才退出、最长在终止之后 128 秒、不占转换名额所以实际并发可以超过上限；如何查与杀）；1.3 的其余实测结论；CI `uid-isolation` job 不设 `OFFICE_BIN`，两行在那里都用不到，其 sudoers 不变。
- [ ] 28.3 `docs/adr/0013-assistant-ui-frontend-rebuild.md` 增补：预览器按需加载是唯一放开的代码分割；本 change 完成后 `web/dist` 入口 JS 与各按需块的字节数（原始与 gzip），仍不设上限；新拷入的 `resizable`。
- [ ] 28.4 `CONTEXT.md` 术语表：新增「工作空间侧边栏」「隔离预览来源」「回收目录」，去掉或改写「产物面板」的提法；`AGENTS.md` 的 Directory Map（`server/` 加预览监听器与文档转换）与命令面里提到的环境变量、`smoke/` 的夹具描述，连同 source-derived oracle 的文案同 PR 同步。
- [ ] 28.5 `IMPLEMENTATION_PLAN.md`：S1f 的 D 一节标注已交付的范围与本 change 留下的后续（旧样式层整体移除的清理 issue、包体上限）；在「S4b 单机部署包」一节加一行：部署镜像要安装 LibreOffice 并设 `OFFICE_BIN`、发布 `PREVIEW_PORT`（压测第 5 条；本 change 不配 `OFFICE_BIN` 即功能关闭）。
- [ ] 28.6 真实转换的人工验证（office-preview「真实转换的人工验证」，测试 VPS，uid 分离部署、已装 LibreOffice）：docx、xlsx、pptx 各一份经 `/o/` 在浏览器内置查看器里可翻页；转换进程 `Uid` 为 omp 用户、缓存文件属应用用户；
  超时终止一次之后残留进程是否出现（进程名；只记录，不改变做法）；从另一台机器经固定的 `PREVIEW_PORT` 打开 html 预览且相对资源可用。结果与 LibreOffice 版本写进 ADR-0014（残留一项同时写进 ADR-0010 增补）。Depends on 1.1、1.3。
- [ ] 28.7 收尾核对：0.2 的对底已做；两个 CLI 的 `openspec validate s1f-files-page --strict --no-interactive` 都通过；`docs/acceptance/functional-checklist.md` 里本 change 新增与改写的行全部为 `待签`；`ATTRIBUTION.md` 含 `lowlight`、`highlight.js`、`hast-util-to-jsx-runtime`、`react-resizable-panels`、`yauzl`；
  为「旧样式层整体移除」开一个后续 issue（design「Not yet specified」）并在 Epic 里链接。

Suggested fixture level: none - 文档、术语与人工验证记录，不改运行时代码
Minimal mergeable slice: 28.1–28.5 的文档可一个 PR 合入；28.6 的实测记录作为对 ADR-0014 的第二个小 PR

## 启动失败记录的阶段取值（#1203 对齐）

- [ ] 本 change 新增的启动步骤进入 `server_start_failed` 的 `reason` 枚举：建预览缓存目录 → `preview_cache`，预览监听器 listen → `preview_listen`；`server/src/server.ts` 在这两步开始之前推进阶段变量。测试：http-service-skeleton「启动失败记录带失败阶段」的写法（真实编译入口、整行精确相等）各加一例；既有「预览端口失败 → 恰一行 generic failure record」的断言改为带 `reason` 的整行。归档次序：本 change 的「服务启动与装配」MODIFIED 副本须保留 `s1f-session-list-temp-space` 引入的该场景（已同步进本副本）。

