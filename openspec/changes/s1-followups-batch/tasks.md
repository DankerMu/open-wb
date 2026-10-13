# Tasks: s1-followups-batch

> 十四个任务组、十四个 PR：proposal / design 里的 G1–G12，其中 G2 与 G11 按 owner 2026-10-13 的裁决各拆成两组（G2a / G2b、G11a / G11b）。**一组一个 PR**，各自可独立合入。
>
> 依赖（边表。「A ← B」读作「A 的前提是 B」；没有列出的组之间不互相等待）：
> - **G8 ← G3**：8.3 靠 3.3 的专用错误类辨认「根被文件占据」。
> - **G11a ← G1**：两组同改 `web/src/features/files` 的 `browser-paths.ts`、`tree.tsx`、`workspace-browser.tsx`；G1 小，先合。
> - **G11b ← G11a**：两组都改 `workspace-browser.tsx`（712 行）与 `workspace-sidebar.tsx`，顺序进行，#1372 在先。侧边栏对已不存在的文件「一律清空」（含开关关着时）整个落在 G11a；G11b 只管 `在文件页打开` 的地址与再次点击。
> - **G2b ← G10**：迁移时要按新的绑定次序归类调用点，且两组同改 `server-startup-failure-reason.test.ts`、`server-startup-preview.test.ts`、`listener-shutdown.test.ts`。G2a 没有前提。
> - **G5 与 G9 顺序进行，先后不限**：都贴着 `web/src/features/chat/use-chat-session.ts` 的 800 行线（现 790 行），不并行。
> - **G4 与 G10 可并行**：只共用 http-service-skeleton「服务启动与装配」的规格文本。G4 的入口用例放新文件（4.3），不碰 G10 与 G2b 要改的 `server-startup-failure-reason.test.ts`。
> - 其余（G2a、G6、G7、G12）没有任何边。
>
> Critical Path（PR 必须标注并由 owner 白盒审查，测试通过不豁免）：
> - **G6**：「omp 子进程治理」——审批档位决定 spawn 的 `--approval-mode`。
> - **G8**：「沙箱与文件边界」——何时写 `sandbox.reject`、附件路径与上传文件名的形状校验。
> - **G3**：不改 `core/sandbox`，但改工作空间根的取得与状态映射，按邻接面同样请求白盒审查。
> - **G10**：「omp 子进程治理」邻接面——启动窗口内（主监听器已受理请求、可 spawn omp）的关停次序，按邻接面同样请求白盒审查。
>
> 裁决与默认：owner 2026-10-12 与 2026-10-13 的裁决已写进 delta 与各组任务。design D14 的九项是「编排方按保守默认定，owner 可推翻」，任务按它们写、行内标 D14-n。design「待编排方确认」是空的：前一稿的 Q-1 成了 D14-8，Q-2 已由 owner 2026-10-13 答复「侧边栏里一律清空」。
>
> 通用纪律：
> - 每组先写会失败的测试，再实现；改变行为的组最后一项是变异证据（把实现改回去，指明哪条用例判红，输出贴进 PR）。
> - 每个 PR 合入前 `make check` 全绿；触及走查或冒烟覆盖面的组另跑组内点名的 `make ui-walk` / `make smoke`，退出码贴进 PR。
> - 单文件 800 行：`use-chat-session.ts`（790）、`turn-actions.ts`（725）、`workspace-browser.tsx`（712）、`server-startup-helpers.ts`（697）、`server/src/server.ts`（682）不得越线；新逻辑进新文件或既有的小文件。knip 不留未引用导出，jscpd ≤3%，覆盖率 ≥80%。
> - `server/test`、`web/test` 同受 800 行守卫（`scripts/size-guard.sh`）：`workspace-store.test.ts`（798）、`session-rest.test.ts`（792）、`server-assembly.test.ts`（778）、`session-prompt-attachments.test.ts`（778）、`server-config.test.ts`（771）、`files-preview-states.test.tsx`（770）、`workspace-upload-rest.test.ts`（766）、`chat-page-file-changes.test.tsx`（765）、`workspace-browser.test.tsx`（753）、`session-metadata-rest.test.ts`（741）、`workspaces-http.test.ts`（736）、`session-composer-align.test.ts`（712）、`chat-workspace-sidebar-reveal.test.tsx`（709）、`preview.test.tsx`（708）、`session-fork-metadata.test.ts`（701）以及 `server/src/sessions/store.ts`（780，G6 传上界时留意）不得追加到越线。下面点名「新文件」的用例一律进新文件；没点名文件的用例落到别处时先 `wc -l`。
> - 既有断言只要还有意义就不删除、不削弱；随规格改写的断言在 PR 的偏离记录里逐条列出。
> - 任务里点名的 `文件:行` 是 2026-10-12 在 `51ffffb3` 上读到的；开工时先按任务里的符号名重新定位。
> - 规格 delta 已在本 change 里（由主规格原文逐字拷出、只换点名的句子）。各组不改 delta；发现 delta 与实现对不上时停下回报，不顺手改规格。
> - 归档在十四组全部合入之后一次进行（design「Migration Plan」）。

## 1. files-web — 目录缓存按路径取值只认自有键（G1，#1340）

- [x] 1.1 测试先行（`web/test/browser-paths.test.ts`）：`loadedDirectoryPaths` 对根列表含 `constructor`、`__proto__`、`toString`、`hasOwnProperty`、`valueOf` 目录的缓存不抛出、返回 `[""]`；其中某一个已加载时只多出它；`revealStep("constructor/a.md", …)` 在 `constructor` 未加载时返回 `unloaded: "constructor"`。验证：新用例在现有实现上判红（`constructor` 一例抛 `TypeError`）。
- [x] 1.2 测试先行（`web/test/files-page.test.tsx`，整页渲染加假 fetch）：files-web「目录树与预览」的场景「与对象原型成员同名的目录」——页面不崩溃、位置下拉展开前只有根、展开 `constructor` 恰一次 `tree` 并列出内容、`__proto__` 列举失败时显示信封 message、其余目录没有错误行。验证：在现有实现上判红。
- [x] 1.3 实现：`web/src/features/files/browser-paths.ts` 导出一个取自有值的函数（design D1），目录缓存与目录错误表的每一处读都经它——`browser-paths.ts` 的 `loadedDirectoryPaths`（两处加入口的 `cache[""]`）与 `revealStep`（两处）、`tree.tsx` 的 `DirectoryNode`（`cache[path]`、`errors[path]`）、`workspace-browser.tsx` 清错误处的 `current[path]`、`folder-dialog.ts` 的 `cacheRef.current[""]`；既有四处 `Object.hasOwn` 改用同一个函数。不换 Map，不改写入点。验证：1.1、1.2 转绿，`npm test --workspace web` 全绿。
- [x] 1.4 守卫测试：一个源码断言——`web/src/features/files` 下的 `.ts` / `.tsx` 里，目录缓存与目录错误表不以方括号读取（按 1.3 改完后各取值点的变量名列出要拦的写法；展开加计算键的写入不算），读取只经 1.3 的函数。验证：临时加回一处 `cache[path]` 时该断言判红。
- [x] 1.5 变异证据：把 `loadedDirectoryPaths` 里的取值改回 `cache[path]` → 1.1 的 `constructor` 用例与 1.2 判红；把 `tree.tsx` 的 `errors[path]` 改回 → 1.2 的「没有错误行」判红。`make ui-walk` 跑一次（`/files` 走查不回归）。

Suggested fixture level: compact - 单个前端特性目录内的取值方式修正，不涉及共享入口、格式或文件写删
Minimal mergeable slice: atomic - 一个取值函数加它的全部调用点；只改一部分调用点就留下同一缺陷，守卫测试也无法成立

## 2a. server/test — SubscriberTable 不变量测试与带重试的启动辅助函数（G2a，#1150、#1273 的前一半）

- [x] 2a.1 新增 `server/test/supervisor-subscribers.test.ts`，用例 (a)：`read` 抛出某个错误实例 → `subscribe` 抛出**同一个**实例，`count(sessionId)` 等于调用前的值；另一例此前已有一个订阅者，失败后 `count` 仍为 1、原订阅者仍能收到 `fanout`。验证：用例通过；`server/src` 无改动（`git diff --stat -- server/src` 为空）。
- [x] 2a.2 同文件用例 (b)：`read` 内部调用 `table.fanout(sessionId, event)` 后返回 `{ mode: "fresh", events: [] }` → `deliver` 恰收到该事件一次。验证：用例通过。变异证据：删掉 `supervisor-subscribers.ts` 里 catch 分支的 `this.remove(...)` → (a) 判红；把 `this.add(...)` 挪到 `read()` 之后 → (b) 判红；两次输出贴进 PR，变异不提交。
- [x] 2a.3 新文件 `server/test/server-startup-retry.ts`：一个包住「取端口 → `startCompiledServer` → 等 `server_started`」的辅助函数（design D2）。子进程在 `server_started` 之前退出且失败记录的 `reason` 为 `listen` 或 `preview_listen` 时，回收它、换端口重来，至多三次；其它失败与成功都原样交还调用方（含实际用的端口）。两个取值今天都在失败阶段的枚举里，不依赖 G10 的次序对调。不改 `reserveWildcardPort` 与 `startCompiledServer` 的签名。验证：2a.4 的用例。
- [x] 2a.4 辅助函数自己的测试（新文件 `server/test/server-startup-retry.test.ts`）：第一次取到的端口在启动前被测试占住 → 第二次尝试成功，返回的端口不是被占的那个；三次都被占 → 把最后一次的监听失败原样交还；`config` 阶段失败不重试（恰启动一次）。断言只认「是监听类失败」，不钉 `listen` 与 `preview_listen` 哪一个（G10 前后都绿）。验证：用例通过。变异证据：去掉重试 → 第一例判红。此时辅助函数只有自测一个调用方，knip 不报（`make anti-drift` 退出码 0）。

Suggested fixture level: compact - 只加测试与测试辅助函数，`server/src` 零改动，不涉及产品行为
Minimal mergeable slice: 2a.1–2a.2（一个新测试文件，单独保绿）；其后 2a.3–2a.4（新辅助函数加自测）

## 2b. server/test — 启动类测试迁到带重试的辅助函数（G2b，#1273 的后一半；← G10）

- [ ] 2b.1 归类：G10 合入之后，把 `server/test` 下全部 `reserveWildcardPort()` 调用点（2026-10-12 为 12 个文件 44 处；以开工时 `git grep -n "reserveWildcardPort(" -- server/test` 的结果为准，含 G4 的 `server-startup-model-id.test.ts` 若它取端口）逐个归为三类——期望成功启动；期望非监听阶段失败；有意让端口被占。归类表贴进 PR。验证：表的行数等于 grep 的命中数。
- [ ] 2b.2 迁移：前两类迁到 2a.3 的函数；第三类（`server-startup-failure-reason` 的端口占用例、`server-startup-preview` 的预览端口占用例、`listener-shutdown` 里自己占端口的例）保持原样并各加一行注释说明为什么不迁。不改任何断言。验证：`npm test --workspace server` 连跑三次全绿；`git diff` 里没有被改动的 `expect`。
- [ ] 2b.3 变异证据：把一个已迁的「期望 `publish` 失败」用例在启动前占住它取到的端口（临时改动，不提交）→ 迁移前同样的占用得到 `listen` 而判红，迁移后重试换端口、用例仍绿；两次输出贴进 PR。

Suggested fixture level: compact - 只改测试对辅助函数的调用，`server/src` 零改动，断言不变
Minimal mergeable slice: 2b.1 的归类表加任意一个文件的迁移即可独立保绿；其余文件可分批，但都在 G10 之后

## 3. workspaces — 根路径被非目录占据（G3，#1244、#1316；Critical Path 邻接，请求白盒审查）

- [x] 3.1 测试先行（新文件 `server/test/workspace-store-root-occupied.test.ts`；`workspace-store.test.ts` 已 798 行，不追加）：自有空间的根路径是普通文件时 `rootOf` 抛出 store 导出的专用错误类；根路径是符号链接、owner 段不安全时抛的**不是**这个类（仍是通用错误）；根缺失时照旧返回路径、不抛。`list`：账号有两个空间、其中一个的根被普通文件占据 → 不抛，返回两项，被占据那一项的五个字段与它的根缺失时逐值相同（`root` 是同一个路径字符串）；根是符号链接的空间仍使 `list` 抛通用错误（D14-1）。`promote`：临时空间的根被占据 → 抛专用错误类，行仍 `temporary = 1`、没有 `workspace.promote` 审计行；根缺失时照常成功。验证：`rootOf` 第一例与 `list`、`promote` 两例在现有实现上判红（现在抛普通 `Error`）。
- [x] 3.2 测试先行（新文件 `server/test/workspaces-root-occupied.test.ts`，`createApp` + `inject`，表驱动）：workspaces「工作空间 HTTP 集成边界」的场景「空间根被非目录占据」。
  - 逐路由表：`/api/workspaces/:id/` 之下 `tree`、新建目录、`file`、`archive`、`download`、`DELETE entries`、`move`、`preview-token`、上传各一行，带路径的用 `../x`：应答与同一请求在根缺失时逐字相同（404、信封、`no-store`），审计行数不变，占位文件字节不变，没有目录被建出；上传一行另断言请求体没有被读取。
  - `promote` 一行（owner 2026-10-13）：临时空间的根被占据 → 404 `not_found`、`no-store`，没有 `workspace.promote` 审计，行仍 `temporary = 1`、名字未变，带非法 body（如 `[]`）时同样是 404 而不是 400；对照例根缺失 → 200。
  - 列表一例（owner 2026-10-13）：正式空间的根被占据时 `GET /api/workspaces` 为 200，应答体与该根缺失时逐字相同，其它空间照常列出。
  - 另一例根是指向目录的符号链接 → 各路由 sanitized 500（D14-1）。
  验证：在现有实现上逐路由表每一行、`promote` 一行与列表一例都是 500，判红。
- [x] 3.3 实现：`server/src/workspaces/store.ts` 的 `computeSafeRoot` 把「存在但不是目录」一支换成导出的专用错误类（带着已解析出的路径），另两支不动；`list` 遇到这个类时照常产出该行、`root` 取那条路径（`create` 与 `promote` 不捕获，照旧抛出）。`server/src/workspaces/rest.ts` 抽一个取根函数：捕获这一个类 → `not_found`。两处调用它但保留各自原有的判定——`ensureOwnedRoot` 仍是「null 或不是普通目录 → 404」，`requireOwnedBeforeParse`（`promote` 用）仍只在 null 时 404，**不得**因此让根缺失的 `promote` 变成 404。不改 `server/src/core/sandbox`，不改 `server/src/sessions`。验证：3.1、3.2 转绿。
- [x] 3.4 预览监听器：`server/src/preview/app.ts` 取根处用同一个取根函数；在 `server/test/preview-app.test.ts`（606 行）加一例——持有未过期令牌、根被普通文件占据 → 与「空间消失」相同的 404，不是 500。验证：该例先红后绿。
- [x] 3.5 回归（证明会话侧没变）：绑定空间的根被普通文件占据时，prompt 仍是 502 `agent_unavailable`、不 spawn（session-metadata「绑定不可改与工作目录」）；`GET /api/commands?workspaceId=` 仍 200 且没有项目级命令。两例若已有等价用例就指出文件与用例名，没有就补进新文件（不追加到上面清单里贴线的文件）。验证：用例通过，且 3.3 之前之后结果相同。
- [x] 3.6 变异证据：去掉取根函数里的捕获 → 3.2 逐路由表与 `promote` 一行判红；把专用错误类也用于符号链接一支 → 3.1 与 3.2 的符号链接例判红；`list` 不捕获 → 3.1 的 `list` 例与 3.2 的列表例判红；让 `requireOwnedBeforeParse` 也查「不是普通目录」→ 3.2 `promote` 的根缺失对照例判红。`make smoke` 跑一次。PR 标注「触碰工作空间根的取得（Critical Path 邻接面），请求白盒审查」，并写明符号链接的根按 D14-1 保持 500。

Suggested fixture level: expanded - 触及文件路径边界与跨路由共享的取根入口，且 `rootOf` 的抛出语义被会话模块依赖
Minimal mergeable slice: atomic - 专用错误类没有捕获方时端点仍是 500，只在一部分取根点捕获则同一情形两种状态码；store、三个取根点、列表与表驱动测试必须同刀

## 4. http-service-skeleton — `MODEL_ID` 的取值规则（G4，#1261）

- [x] 4.1 测试先行（新文件 `server/test/server-config-model-id.test.ts`，纯配置 seam；`server-config.test.ts` 已 771 行，不追加）：`resolveServerConfig` 对 `MODEL_ID` 为空串、`"a\nb"`、含 U+007F、129 个 UTF-8 字节的值各抛配置错误，message 含 `MODEL_ID` 且不含输入值；配置了合法 `MODEL_CATALOG` 时同样四例仍抛配置错误并点名 `MODEL_ID`；恰 128 字节的值与 `" custom-model "` 通过且逐字节保留。`server-config.test.ts` 里既有两条「字节原样」用例不改、不搬。验证：四个拒绝例在现有实现上判红。
- [x] 4.2 实现：`server/src/model-catalog.ts` 的 `resolveModelCatalog` 入口对给出的 `MODEL_ID` 用白名单条目 `id` 的同一对检查（`isLabel` 加 128 字节上限），不 trim；改掉 `:40` 的「不校验、不 trim」注释。验证：4.1 转绿。纯空白的取值不拒（D14-2）。
- [x] 4.3 入口一例（新文件 `server/test/server-startup-model-id.test.ts`；不放进 `server-startup-failure-reason.test.ts`，那个文件由 G10 与 G2b 改）：`MODEL_ID=""` 启动编译入口 → nonzero，stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`，无 success record，DB 文件未被创建。验证：用例通过。
- [x] 4.4 变异证据：去掉长度检查 → 129 字节例判红；加上 `trim()` → `" custom-model "` 的既有用例判红；去掉控制字符检查 → `"a\nb"` 例判红。文档：`docs/architecture/system.md` 的配置表里没有 `MODEL_ID` 独立一行，取值规则补在 `:278` 那句「未设置 `MODEL_CATALOG`：白名单只有 `MODEL_ID` 一项」之后（开工时按这句话重新定位）。

Suggested fixture level: expanded - 生产配置键的校验规则，非法值由「照常启动」变为「启动失败」
Minimal mergeable slice: atomic - 一个纯函数里的一处校验加它的测试与文档行

## 5. message-attachments — 首次发送带暂存文件的三处边角（G5，#1277）

- [x] 5.1 测试先行（整页渲染加假 API，`web/test/chat-attachments-first-send.test.tsx`，现 621 行；三项加起来会越线时把新用例放进新文件 `web/test/chat-attachments-first-send-cancel.test.tsx`）：场景「上传阶段按停止」——三个文件、第二个上传到 40% 时点 `停止`：在途请求的 `signal` 被中止、第三个没有请求、没有 prompt / `stopSession` / 删除请求、输入框解锁、草稿为原文、标签为已上传 / `待上传` / `待上传`、没有错误文字、URL 仍选中新会话；随后再次发送：没有第二次 `createSession`、不重传第一个、恰一次 prompt 带三个 `path`。另一例回合已在运行时点 `停止` 仍恰一次 `stopSession`。验证：第一例在现有实现上判红（现在发出 `stopSession` 且 prompt 照发）。
- [x] 5.2 测试先行：场景「移空标签后不发空 prompt」——建会话期间移除唯一标签、上传到 40% 时移除，两例都没有 prompt、输入框不停在 `生成中`、没有 400 文案；草稿非空的一例恰一次 `{"message":"看看"}`。验证：前两例在现有实现上判红（发出 `{"message":""}` 并显示 400）。
- [x] 5.3 测试先行：场景「上传落定时已离开该会话」——让上传在「渲染已把当前请求的会话指向别处、effect 尚未中止」之间落定：没有 prompt，另一个会话的草稿、标签、错误区不变。时序的造法写在用例注释里。验证：在现有实现上判红；若现有测试设施造不出这个时序，改为对抽出的归属判定函数做单元测试，并在 PR 里写明整页层没有覆盖的原因。
- [x] 5.4 实现（`web/src/features/chat/turn-actions.ts`、`attachments-state.ts`）：把 prompt 落定处的六项判定抽成一个函数，三处共用（design D5）；`send()` 在文本去空白后为空且没有取到标签时不发请求、按未受理收尾；`stopTurn` 在页面拥有一次尚未受理且处于上传阶段的首次发送时走取消——附件队列给出「中止在途并撤掉排队、被中止的回到 `待上传`」的入口，草稿与标签恢复，不写错误文案，不调 `stopSession`。`turn-actions.ts` 不越 800 行，`use-chat-session.ts` 不净增。验证：5.1–5.3 转绿，首次发送与带附件发送的既有用例全绿。
- [x] 5.5 变异证据：`stopTurn` 恢复为无条件 `stopSession` → 5.1 判红；去掉 `send()` 的空判断 → 5.2 判红；`staged.then` 改回只查 `aborted` → 5.3 判红。`make ui-walk` 跑一次。

Suggested fixture level: expanded - 改的是发送链路上的并发与次序（中止、排队、归属判定），不是孤立的显示逻辑
Minimal mergeable slice: 5.3 加 5.4 里的归属判定抽取（纯重构加一处补判，独立保绿）；其后空 prompt（5.2）；最后停止（5.1）——三条共用一段代码，也可以一个 PR 做完

## 6. session-permission-tier — 新建与 fork 的档位夹取到当前上界（G6，#1282 裁决 A；Critical Path「omp 子进程治理」，owner 白盒审查）

- [x] 6.1 测试先行（新文件 `server/test/session-approval-ceiling-clamp.test.ts`，`createApp` + `inject`；同一个库以不同的 `approvalMaxMode` 先后装配来表示上界调低与放回）：session-permission-tier 的场景「封顶期间新建与 fork 的会话不随上界放回而放宽」三组 WHEN/THEN 逐条——断言会话行的 `approval_mode` 列值（直接读库）、视图、`session.permission` 行数与内容、spawn 的 argv、账号最近选择行。验证：S1、S2 的列值断言在现有实现上判红（现在是 `yolo`）。
- [x] 6.2 测试先行（同一个新文件）：session-composer-settings 的场景「继承的档位不高于上界」与 session-metadata 的场景「封顶时 fork 不带走超界档位」。验证：两者在现有实现上判红。
- [x] 6.3 实现：`server/src/sessions/store-composer.ts` 的 `resolveCreateComposer`——继承来的（请求没给的）`approval_mode` 高于 `config.approvalMaxMode` 时写入上界；请求显式给的超界值照旧 400；`creationAuditTo` 不动。`server/src/sessions/store-branch.ts` 的 fork 插入——新行的 `approval_mode` 取源会话原始值与上界中较低的一个（上界经参数进来），另两列与其余各列照旧。不回填任何既有行，不动 `account_composer_prefs`（D14-3）。`server/src/sessions/store.ts`（780 行）传上界时不得越线。验证：6.1、6.2 转绿。
- [x] 6.4 回归：session-permission-tier「调低上界后既有会话被夹取」「创建时的审计」、session-metadata「继承三项设置」、turn-control「分叉继承三项输入框设置」的既有用例一条不改、全部通过（上界 `yolo` 时 fork 仍逐值相同）。验证：`npm test --workspace server` 全绿，PR 里列出这四个场景对应的用例名。
- [x] 6.5 文档：`docs/adr/0012-omp-project-config-host-overlay.md` 的「补充（S1g）」——`:79` 的「新会话继承最近一次选择时……警示色与创建审计仍在」与 `:80` 的「有效档位每次变化……都写一条」两句改成与规格一致（配置变化引起的有效档位变化不写审计；继承的档位不高于当前上界），并加一段记下「s1g design D3 的『入库不夹取』在新建与 fork 两处被本 change 局部推翻」及理由。`docs/architecture/system.md` 9.3 节**改写**与裁决 A 相抵的两句（不是在后面补一句）：`:299` 的「包括封顶期间新建、继承了最近选择的会话……直接生效」与 `:300` 的「封顶期间新建的会话照样继承账号最近选择里的 `yolo`……上界放回后一并变成 `全部自动`」，改成「封顶期间新建与 fork 的会话存的是夹取后的档位，上界放回后不变；只有封顶之前写入的会话行与账号最近选择里的原始值原样恢复」。验证：三处文字与 session-permission-tier「管理员最高档」「档位变更审计」逐句对得上（PR 里并排贴出）；`git grep -n "一并变成" -- docs/architecture/system.md` 无命中。
- [x] 6.6 变异证据：`resolveCreateComposer` 改回 `{ ...last, ...given }` → 6.1 的 S1 列值与 6.2 第一例判红；fork 改回原样抄写 → 6.1 的 S2 与 6.2 第二例判红；把夹取做成写 NULL → 6.1 第三组（上界 `always-ask`、放回后仍 `always-ask`）判红。`make smoke` 跑一次。PR 标注「Critical Path：omp 子进程治理（审批档位），请求白盒审查」。

Suggested fixture level: expanded - 权限与审计：改变持久化的审批档位，决定 omp 的 `--approval-mode`，并局部推翻一项已归档的设计决定
Minimal mergeable slice: atomic - 创建与 fork 是同一条规则的两个写入点，只改一处则另一处仍把超界档位带过封顶期；文档句与规格同刀，避免 ADR 与规格再次相抵

## 7. verification-harness — 固定 openspec CLI 并在 CI 校验（G7，#1126；改 CI 文件、新增依赖，PR 必须标注）

- [ ] 7.1 依赖：根 `package.json` 的 `devDependencies` 加 `"@fission-ai/openspec": "1.13.2"`（不带 `^` / `~`），`npm install` 更新 `package-lock.json`。验证：干净检出后 `npm ci && npx openspec --version` 输出 `1.13.2`；`npx openspec validate --all --strict --no-interactive` 以 0 退出（输出贴进 PR）。`ATTRIBUTION.md` 按既有规则登记（MIT）。
- [ ] 7.2 测试先行（`scripts/test-ci-harness.sh`）：`fast` 步骤元组在 `npm run typecheck --workspaces` 之后加 `run("npx openspec validate --all --strict --no-interactive")`，并加四条变异例——删除该步、去掉 `--strict`、`npx openspec` 换成 `openspec`、给该步加 `continue-on-error`。验证：此时 `make test-guardrails` 判红（workflow 还没有这一步）。
- [ ] 7.3 实现：`.github/workflows/ci.yml` 的 `fast-checks` 末尾加同一条命令的 step。不加 action、不改 timeout、不动其它 job。验证：`make test-guardrails` 转绿（含 7.2 的四条变异例各自被拒）；PR 的 `fast-checks` 实际执行该步并成功，把 job 耗时与改动前的一次对比贴进 PR。
- [ ] 7.4 `AGENTS.md`：写明「openspec 一律经 `npx openspec` 调用，不用全局安装的版本；固定 1.13.2」。位置选在 oracle 不钉的段落（Verification Matrix 与 Enforcement Index 两张表、`constraints.yaml` 的十个 surface 都不加行）。验证：`make test-guardrails` 仍全 PASS。
- [ ] 7.5 `make anti-drift`：确认 knip 没有把该 devDependency 报为未使用；报了就在 `knip.json` 根 workspace 登记并在 PR 说明。验证：`make anti-drift` 退出码 0。
- [ ] 7.6 变异证据（issue 的验收项）：在一份临时副本里把某个未归档 change 的一个 MODIFIED 块删掉一个既有 scenario 标题，`npx openspec validate --all --strict --no-interactive` 以非零退出；输出贴进 PR，副本不提交。PR 说明里另写：新依赖的理由（现有工具没有 OpenSpec 校验器，1.3.1 与 1.13.2 行为不同）；CI 文件改动清单；**CI 用 `validate --all` 是有意偏离 #1126 第 2 项的字面**（issue 写的是「对每个未归档 change 逐个校验」；`--all` 同时校验主规格与全部未归档 change，更严，理由见 design D7）；issue 第 4 项（`.claude/skills` 下的调用）不在本仓库、本 PR 不含（D14-6）。

Suggested fixture level: expanded - 改 CI 工作流与它的契约 oracle，并新增一个开发依赖（发布与依赖兼容面）
Minimal mergeable slice: atomic - `ci.yml` 的新步骤与 oracle 的步骤元组必须同一提交改，否则 `make test-guardrails` 判红；依赖不先进 lockfile 则该步骤无从执行

## 8. message-attachments / workspaces — prompt 附件校验与上传文件名（G8，#1257；Critical Path「沙箱与文件边界」，owner 白盒审查；← G3）

- [ ] 8.1 测试先行（新文件 `server/test/session-prompt-attachments-shape.test.ts`；`session-prompt-attachments.test.ts` 已 778 行，8.1–8.3 都不追加到它）：「附件形状与前提」里新增的取值——末段为 `.` 的 `uploads/a.pdf/.`（文件存在）、分别含 U+0085、U+2028、U+2029 以及十二个双向控制字符（U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069）各一例的路径 → 400 `bad_request`，没有消息行、没有审计、supervisor 未被调用。对照例：中间含 `.` 段的 `uploads/./a.pdf` 与含普通非 ASCII 字符的路径仍 202。验证：新增的拒绝例在现有实现上判红（现在 202）。
- [ ] 8.2 测试先行（同一个新文件）：场景「空间根丢失时带附件的 prompt」第一例（根目录被删除）→ 404、`no-store`、审计无新增、没有消息行、supervisor 未被调用。验证：在现有实现上判红（现在 403 加一条 `sandbox.reject`）。
- [ ] 8.3（← 3.3）测试先行（同一个新文件）：同一场景第二例（根路径被普通文件占据）→ 同样的 404。验证：在现有实现上判红（现在 500）。
- [ ] 8.4 测试先行（新文件 `server/test/workspace-upload-name-chars.test.ts`；`workspace-upload-rest.test.ts` 已 766 行，不追加）：workspaces「文件上传」场景「名字规则与媒体类型」的新增部分（owner 2026-10-13）——名字分别含 U+0085、U+2028、U+2029 与十二个双向控制字符各一例 → 400 `bad_request`、`no-store`，`uploads` 下没有该文件也没有 `.part` 文件，审计无新增（没有 `file.upload`、`upload.reject`、`sandbox.reject`）；`uploads` 尚不存在的一例被拒之后该目录仍不存在。对照：`报告 v2.pdf` 照常 201。已在磁盘上的文件：测试直接写一个名字含 U+202E 的文件 → `tree` 列出且名字逐码点原样，`file` 与 `download` 都是 200、字节相同。验证：拒绝例在现有实现上判红（现在 201）。
- [ ] 8.5 实现：
  - 一个判定「字符串是否含被拒码点」的函数（U+0000–U+001F、U+007F、U+0085、U+2028、U+2029 与十二个双向控制字符），放进一个两边都能导入的新小文件（位置由实现定，不放进 `server/src/core/sandbox`）；`server/src/sessions/prompt-attachments.ts:88` 与 `server/src/workspaces/rest.ts:131` 两个各自为政的 `hasControlCharacter` 都换成它（顺带消掉这段重复）。
  - `prompt-attachments.ts`：第 1 条加末段不得为 `.`；`admitAttachments` 在调用 `sandbox.resolve` 之前经会话模块已有的 `workspaceRootOf` 取根——null、G3 的专用错误类、或不是普通目录（`lstat`，不跟随链接）→ `not_found`，不解析、不写审计。
  - `workspaces/rest.ts`：上传第 5 步的名字规则用同一个函数，位置不动（仍在第 4 步沙箱解析之后、第 6 步建目录之前），所以被拒时什么都没写；`tree`、`file`、`download`、`archive`、`move`、`DELETE entries` 的路径处理一行不改。
  - 不改 `server/src/core/sandbox`，不改 `web/`（上传被拒时标签按既有规则显示 `失败：<信封文案>`）。
  验证：8.1–8.4 转绿；「越界附件被拒绝并入审计」「越界名字被拒绝并入审计」的既有用例不改、仍通过（根可见时越界仍是 403 加一条审计；`name=../../etc/passwd` 仍是 403 而不是 400）。
- [ ] 8.6 变异证据：去掉取根判定 → 8.2、8.3 判红；字符集里去掉 U+2028 → 8.1 与 8.4 对应例判红；去掉末段判定 → `uploads/a.pdf/.` 例判红；上传改回只查 U+0000–U+001F 与 U+007F → 8.4 全部拒绝例判红；把名字规则挪到第 4 步之前 → 「越界名字被拒绝并入审计」的既有用例判红。`make smoke` 跑一次。PR 标注「Critical Path：沙箱与文件边界，请求白盒审查」。

Suggested fixture level: expanded - 路径安全与审计：改变何时写越界审计、收紧可被接受的附件路径与上传文件名
Minimal mergeable slice: 8.1、8.4 加 8.5 里的字符与末段校验（纯入参校验，不依赖 G3，独立保绿；附件与上传必须同刀，否则留下「能传不能发」）；其后取根判定（8.2–8.3，依赖 G3）

## 9. chat-web — 保存设置后重取输入框选项（G9，#1269）

- [ ] 9.1 测试先行（`web/test/chat-composer-options.test.tsx`，现 209 行；整页渲染加假 API）：chat-web「输入框与能力栏」的场景「保存设置后重取缺省值」七组 WHEN/THEN 逐条——带键的 `patchSession` 成功后恰多一次 `getComposerOptions`、挂起期间三个控件仍在、返回后欢迎态显示新缺省；带键的 `createSession` 成功后恰多一次；只带 `title` 的 patch 与失败的 patch 不触发；只选过强度、重取换了缺省模型 → 强度被丢弃、创建请求不带 `reasoningEffort` 也不带 `modelId`；页面上选过档位、模型与强度、重取三项缺省都变 → 三项选择都保留并随创建请求发出；只选过档位与强度、重取只换了缺省档位 → 两项都保留；重取失败时沿用上一份、下一次选中会话再取。验证：第一、二、四组在现有实现上判红。
- [ ] 9.2 实现：`web/src/features/chat/composer-options.ts` 的 `useComposerOptions` 多返回一个失效入口（重取期间保留上一份数据；迟到结果仍靠记录比对丢弃；失败状态沿用既有的重取规则）；带三键之一的 `patchSession` 成功处（`session-actions.ts`）与 input 带三键之一的 `createSession` 成功处各调一次。重取之后欢迎态的页面内选择保留（owner 2026-10-13）：档位与模型的选择不动；只有「缺省模型变了、且页面上没有选过模型」时清掉已选的强度，别的情况不清任何选择。`use-chat-session.ts` 不净增到越线。验证：9.1 转绿；既有的「能力行的次序」（恰一次）与「选项读取失败后重取」（恰两次）两条用例不改、仍通过。
- [ ] 9.3 验收清单：`docs/acceptance/functional-checklist.md` 的 CH-68、CH-69 去掉「先刷新页面」的步骤与括注，改成不刷新即可看到新缺省；结论置 `待签`。验证：`web/test/functional-checklist.test.ts` 通过。
- [ ] 9.4 变异证据：去掉 patch 成功后的失效调用 → 9.1 第一组判红；去掉 create 成功后的 → 第二组判红；缺省模型变了也不清强度 → 第四组判红；`defaults` 一变就清掉全部页面内选择 → 第五、六组判红；重取在途时把数据置空 → 「挂起期间三个控件仍在」判红。`make ui-walk` 跑一次。PR 写明残余（另一个标签页或设备改了最近选择时仍会过期，D14-7）。

Suggested fixture level: compact - 前端一个只读缓存的失效时机，不涉及服务端、存储格式或权限判定
Minimal mergeable slice: atomic - 失效入口没有调用方就是死代码（knip 判红），只接 patch 不接 create 则欢迎态带键创建之后仍过期

## 10. http-service-skeleton — 主监听器先于预览监听器绑定（G10，#1337；omp 子进程治理邻接面（启动窗口内的关停次序），请求白盒审查）

- [ ] 10.1 测试先行（`server/test/server-startup-order.test.ts`，编译入口加 order trace）：场景「缺省预览端口不会占掉主端口」第一组——不设 `PREVIEW_PORT` 时 trace 里主监听器的 `listening:` 行先于预览监听器的，预览端口非 0 且不等于 `PORT`。把该文件里断言旧次序的期望改成新次序，逐条列入 PR 的偏离记录。验证：在现有实现上判红。
- [ ] 10.2 测试先行（`server-startup-preview.test.ts`、`server-startup-failure-reason.test.ts`）：「预览端口被占用」——失败记录整行等于 `{"event":"server_start_failed","reason":"preview_listen"}`，进程退出后 `PORT` 可立即绑定（`expectBindable`），DB 可重新打开；显式 `PREVIEW_PORT === PORT` 一例的 `reason` 由 `listen` 改为 `preview_listen`。验证：第二例在现有实现上判红。
- [ ] 10.3 测试先行：同场景第二、三组——（a）经 `requireHook` 把预览监听器的 `listen` 挂起，其间对自己的工作空间 `POST preview-token` → typed 404、没有令牌被登记；放行后同一请求 200 且 `base` 的端口是实际绑定的端口。（b）SIGTERM 落在主监听器已绑定、预览绑定仍在途：没有 success / failure record，没有后到的预览绑定，trace 里主监听器经 runtime → listener → DB 关闭，退出码 0，两个端口与 DB 可立即复用。验证：两例在现有实现上判红（现在没有这段窗口）。（a）的应答按 D14-4。
- [ ] 10.4 实现（`server/src/server.ts`）：
  - 对调两次 `listen`；主监听器绑定后立即换新的 `AbortController`，预览监听器的在途绑定用新的那一个（design D10 第 1 点）。
  - `requestShutdown`（现 `:566-571`）的 abort 条件由「主监听器未绑定」改为「当前有在途绑定」：预览监听器尚未 bound 时也 abort **当前** controller（此时它只管预览那一次绑定）；已绑定的主监听器仍只经 `releaseOwned` 关闭，不被任何 signal 的原生 close 触及。不这样改，对调之后信号落在预览绑定在途时不会 abort，`releaseOwned` 直接对 `listen` 仍在途的预览实例调 `close()`。
  - 预览绑定失败时的清理把已绑定的主监听器一并关掉；阶段标记顺序改为先 `listen` 后 `preview_listen`。
  - `server/src/workspaces/rest-preview-token.ts`：预览监听器尚未绑定时按未装配处理（typed 404，不登记）。
  - `server.ts` 不越 800 行。
  验证：10.1–10.3 转绿；`server-startup-*`、`listener-shutdown`、`server-assembly` 全部通过。
- [ ] 10.5 文档与注释：
  - `server/src/server.ts` 里描述旧次序的三处注释——文件头 `:2-3` 的次序串与 `:12`「一个 per-entry AbortController 随两次 listen 传递（预览监听器在先，同一个 signal）」、`:326`「先于主实例 listen」、`:400`「主监听器在它之后才 listen」——改成新次序与「各用一个 controller」。
  - `docs/adr/0014-isolated-preview-origin.md`：`:15`「入口先于主监听器 `listen`」改为后于；`:61`「#1286、#1350、#1337 截至 2026-10-12 都是打开的 issue」去掉 #1337 并注明它闭合于本 change；残余表 `:77` 的 #1337 一行标为已闭合；`:95`「固定 `PREVIEW_PORT` 还避开 #1337」一条改写（显式两端口相同仍是启动失败，阶段为 `preview_listen`）。
  - 已归档的 `implementation-notes.md:220` 不改，偏离的过时记在本 change 的 design D10。
  验证：`git grep -n "先于主监听器\|先于主实例 listen\|预览监听器在先\|同一个 signal" -- docs server/src` 不再有描述旧次序的句子（「先于主监听器关停」是关停次序，保留）。
- [ ] 10.6 变异证据：把两次 `listen` 调回去 → 10.1 判红；预览绑定沿用主监听器的 signal、并让 `requestShutdown` abort 它 → 10.3 (b) 判红（主监听器被原生 close，trace 次序不对）；`requestShutdown` 仍只看主监听器是否 bound → 10.3 (b) 判红（出现后到的预览绑定，或端口不可立即复用）；去掉 `preview-token` 的未绑定判定 → 10.3 (a) 判红（签出端口 0 的地址）；失败清理不关主监听器 → 10.2 的 `expectBindable` 判红。`make smoke` 与 `make ui-walk` 各跑一次。PR 标注「omp 子进程治理邻接面（启动窗口内的关停次序），请求白盒审查」。

Suggested fixture level: expanded - 生产入口的启动次序、失败清理与信号处理，改变一个失败阶段的取值
Minimal mergeable slice: atomic - 绑定次序、signal 的更换与 abort 条件、失败清理、窗口期的 `preview-token` 是同一次对调的后果，分开合入会留下「信号绕过 runtime 关主监听器」「信号不中止在途的预览绑定」或「签出端口 0」的中间态

## 11a. workspace-sidebar — 过滤视图的行都可选中，已不存在的文件移出列表与预览区（G11a，#1372；← G1）

- [ ] 11a.1 测试先行（新文件 `web/test/workspace-browser-only-paths.test.tsx`，`WorkspaceBrowser` 组件测试；`workspace-browser.test.tsx` 已 753 行，不追加）：`onlyPaths` 下——父目录未加载的行不带 `disabled`、键盘可选中；父目录已加载而列表里没有的路径不成行、没有对它的请求；选中后 `file` 答 404 的行从树里消失、`onPathChange(null)` 恰一次、预览区是未选状态；目录之下一个文件不剩时目录行也消失，全部不剩时显示 `onlyPathsEmpty` 的文案；`refresh()`（不带参数）与 `refresh([该路径])` 都不使已移出的行重新出现，`reported([该路径])` 使它重新出现。陈旧列表一组（评审 R2-1）：根已加载、列表里没有 `new.md`，`onlyPaths` 含它——`reported(["new.md"])` 之前不成行，之后成行、不带 `disabled`、没有 `tree` 请求，选中后恰一次 `file`、预览头没有大小；随后撤掉 `onlyPaths`、`refresh()` 读到仍没有它的根列表、再给回 `onlyPaths` → 不成行。`clearMissing` 一组（不给 `onlyPaths`）：`path` 指向列表里没有的文件、指向 404 的父目录之下、含 `..` 段、指向以 500 失败的父目录之下——预览区都是空态、没有文案，此前的选中被清除；选中列表里仍有而 `file` 答 404 的行 → 选中被清除、`onPathChange(null)` 恰一次、该行仍在树里。对照：`clearMissing` 与 `onlyPaths` 都不给时，同一个 404 仍是既有的信封文案、行不消失，`path` 落空仍是 `文件不存在`。验证：在现有实现上判红（行被禁用；404 显示文案；没有 `reported`）。
- [ ] 11a.2 测试先行（新文件 `web/test/preview-missing-meta.test.tsx`；`files-preview-states.test.tsx` 770 行、`preview.test.tsx` 708 行，都不追加）：file-previewers 场景「没有元数据的行」「大小未知的文档」——没有大小与修改时间时预览头只有图标、路径与下载链接，页面上没有 `NaN` / `undefined` / `1970`；415 的副行恰为文件名；没有大小的 PDF 行照常建 iframe。验证：在现有实现上判红（类型上必填，运行时拼出 `NaN`）。
- [ ] 11a.3 测试先行（新文件 `web/test/chat-workspace-sidebar-filter-select.test.tsx`，会话页整页渲染）：workspace-sidebar 的六个场景——改写后的「空集合与已删除的文件」、新增的「父目录未加载的改动文件可选中」「过滤开着时助手新写出的文件」（三例都写：步骤结束后列出并可选中；步骤结束与回合结束落在同一个 300 毫秒窗口内；关掉开关刷新后不再列出）「过滤开着时的定位」、「随助手改动刷新」新增的「过滤开着时被删除的当前文件」「过滤关着时被删除的当前文件」。逐条断言：请求记录里没有 `tree`；哪些行在、哪些不在；选中行；预览区是 `未选择文件` 而页面上没有 `文件不存在`、没有服务端的不存在文案、没有 Toast；`在文件页打开` 的 `href`（只断言经 404 移出之后不带 `path` 的那几处——定位落在「列表里本来就没有」的路径上时的 `href` 归 11b）。覆盖裁决点名的三种情形：侧边栏打开之前就已删除（`old.md`、`only.md`）、选中期间被删除后的下一次刷新（`deep/x.md`）、卡片 `查看详情` 指向已删除的文件（`out/gone.md`、`old.md`）。「助手重写后重新列出」一组按 D14-8。另：改写后的场景「文件已不存在」（开关关着，三例：列表里没有它、`out` 也不存在、列表里仍有它而 `file` 答 404 的卡片定位与点行）——既有用例在 `chat-workspace-sidebar-reveal.test.tsx`（709 行）的「文件已不存在」一组与 `chat-workspace-sidebar-reveal-html.test.tsx`，把其中开关关着时对 `文件不存在` / 404 文案的断言**原地改写**成 `未选择文件` 且页面上没有该文案（不追加行；`grep -n "文件不存在"` 逐条过，含 `..` 段的一例按 D14-9 同改），逐条记进 PR 的偏离记录；新增的「列表里仍有它」一例放本任务的新文件。开关开着的既有断言同样原地改写并逐条列入偏离记录，已知三处：`chat-workspace-sidebar-changes.test.tsx` 的 C4（`x.md` 的 `disabled` 为真、404 后出现服务端的不存在文案、`gone.md` 仍是 `aria-current`——改成 `x.md` 可选中，`gone.md` 选中后移出、没有选中行、没有该文案；标题同改）；`workspace-browser.test.tsx` 的「父目录没加载过的行没有大小、也选不了」一处（`y.md` 的 `disabled` 改为假，大小仍没有）；同文件「`onlyPaths` 下 … reveal 未加载的层都不请求 tree」一例（`reveal("x/y.md")` 仍不请求 `tree`，但改为选中 `y.md`、恰一次对它的 `file` 请求、`onPathChange("x/y.md")`——卡片定位走的就是句柄 `reveal`）。扫描不只按文案：`grep -nE "文件不存在|NOT_FOUND|不存在|disabled\)\.toBe\(true\)|选不了" web/test/chat-workspace-sidebar*.test.tsx web/test/workspace-browser*.test.tsx` 逐条过，凡因本组行为而变的都列出。验证：在现有实现上判红。
- [ ] 11a.4 实现（`web/src/features/files/`）：
  - `tree.tsx` 去掉没有 `size` 的行的禁用。
  - `preview.tsx` 的 `size` / `mtime` 改为可缺，缺时头部那一段不渲染，副行与截断提示里带大小的片段省去；`preview-area.tsx` 的媒体预览与 `previewers/frame.tsx` 的文档大小前置判定容忍缺大小。
  - 两种记录（组件内存，随卸载清空）：「被步骤报过」与「应答过 404」。句柄新增 `reported(paths)`：只记账、不发请求——清这些路径的 404 记录并记为被报过。某目录的 `tree` 应答到达时清掉直属于它的路径的两种记录。`refresh()` 与 `refresh(paths)` 都不动记录（D14-8）。
  - `onlyPaths` 下的「已不存在」：`subtreeOf`（`browser-paths.ts`）不为记下 404 的路径生成行，也不为「父目录已加载、列表里没有、且没有被报过」的路径生成行（被报过的照常生成，无元数据），目录之下不剩文件时不生成目录行。`onlyPaths` 下收到 `file` / `archive` 的 404 时记下该路径、清除选中并 `onPathChange(null)`，不进入失败态。
  - 新属性 `clearMissing`（design D11）：给了它时，`path` 定位没有落在文件上一律是空态、不放文案（D14-9），当前文件的 `file` / `archive` 答 404 时清除选中并 `onPathChange(null)`、不进入失败态；普通目录树的行不动。`clearMissing` 与 `onlyPaths` 都不给时（文件页）一行不变。
  - `onlyPaths` 下句柄 `reveal(path)` 与 `path` 属性的定位同一个规则：父目录未加载或路径被报过 → 选中该路径并取 `file`，不请求 `tree`、不等目录（`continueReveal` / `awaitDirectory` 在 `onlyPaths` 下不走逐层加载）；父目录已加载、列表里没有且没被报过 → 清除选中。
  - `onlyPaths` 下仍不请求任何 `tree`。`workspace-browser.tsx` 不越 800 行——记账逻辑放进 `browser-paths.ts` 或新的小文件。
  - `web/src/features/chat/`：`workspace-sidebar.tsx` 给 `WorkspaceBrowser` 传 `clearMissing`；`use-workspace-sidebar.ts` 的 `useAssistantRefresh` 在发现新结束步骤的那个 effect 里（播种之后、`ended` 分支之前）立即 `browser.current?.reported(fresh)`，不进 300 毫秒窗口——回合在窗口内结束、待刷集合被清掉（现 `:98-99`）时路径已经交出。`refresh` 的两处调用不改：回合结束仍恰一次无参 `refresh()`。头注释同步。
  验证：11a.1–11a.3 转绿；#1106 的用例「过滤时不请求 `tree`」与「回合结束兜底」「步骤结束触发局部刷新」的既有用例（请求次数）不改、仍通过；files-web「地址定位到文件」与文件页的全部既有用例不改、仍显示 `文件不存在`；既有用例里被改写的断言以 11a.3 的清单与扫描结果为准，逐条进偏离记录，清单之外不得有改动。
- [ ] 11a.5 验收清单：`docs/acceptance/functional-checklist.md` 的 CH-101（只看本会话改动）按新行为改写——不必先关开关展开目录即可选中；选中一个已被删除的改动文件后它从列表消失、预览区回到 `未选择文件`、没有错误文字；开关开着时助手新写出的文件不必关开关就出现在列表里；结论置 `待签`。清单里写着 `文件不存在` 的另三条（CH-31、CH-62、FL-22）说的是复制失败、撤回与文件页，不动。验证：`web/test/functional-checklist.test.ts` 通过。
- [ ] 11a.6 变异证据：恢复行的禁用 → 11a.3「父目录未加载的改动文件可选中」判红；过滤视图里偷偷列目录 → 「没有 `tree` 请求」判红（#1106 的既有变异仍被杀死）；预览头恢复无条件拼接 → 11a.2 判红；404 改回显示文案（`文件不存在` 或信封 message）→ 11a.3 的「没有错误文字」与「该行消失」判红；`subtreeOf` 不滤掉列表里没有的路径 → 「空集合与已删除的文件」的 `old.md` 与 `only.md` 判红；树栏 `刷新` 也使记下的 404 作废 → 「`y.md` 没有重新出现」判红；`subtreeOf` 不看「被报过」（列表里没有即不成行）→ 「过滤开着时助手新写出的文件」第一例判红；把 `reported` 的调用挪进 300 毫秒的定时器 → 同场景第二例（步骤结束与回合结束同窗）判红；`tree` 应答不清「被报过」→ 同场景第三例判红；侧边栏不传 `clearMissing` → 改写后的「文件已不存在」与「过滤关着时被删除的当前文件」判红；文件页也传 `clearMissing` → files-web「地址定位到文件」的既有用例判红。`make ui-walk` 跑一次。PR 写明 D14-5（不经 `file` 的类别沿用既有失败呈现）、D14-8（作废规则）、D14-9（侧边栏的预览区不放定位文案）是编排方的默认，以及开关关着时应答 404 的行留在树里直到重列。

Suggested fixture level: expanded - 改的是文件页与会话页共用的 `WorkspaceBrowser` 在 `onlyPaths` 下的行为，另加侧边栏专用的 `clearMissing` 与 `reported`，跨 workspace-sidebar、file-previewers、files-web 三个 capability
Minimal mergeable slice: 11a.2 加 11a.4 里预览头与前置判定的容忍（此时没有行会走到缺元数据的路径，纯放宽，独立保绿）；其后行可选中与已不存在的移出（11a.4 其余加 11a.1、11a.3）——这两件连同 `reported` 与 `clearMissing` 必须同刀：只放开选中而不移出会把裁决否掉的 `文件不存在` 文案发布出去；移出而没有 `reported` 会把助手新写出的文件藏掉（评审 R2-1）；开关开与关分两刀会留下同一张卡片两种呈现的中间态

## 11b. workspace-sidebar — 侧边栏拿实际选中，再点同一张卡片重新定位（G11b，#1380；← G11a）

- [ ] 11b.1 测试先行（新文件 `web/test/workspace-browser-actual-selection.test.tsx`，`WorkspaceBrowser` 组件测试）：files-web 场景「实际选中的上报与重复定位」（不给 `clearMissing`，所以预览区是 `文件不存在`；给了它的一例预览区是空态，上报相同）——定位没落在文件上时宿主收到的实际选中为空；`refresh` 之后对同一路径再次发起定位会选中它并上报；两次都没有读写 `location`。验证：在现有实现上判红（同一路径再定位是空操作）。
- [ ] 11b.2 测试先行（新文件 `web/test/chat-workspace-sidebar-relocate.test.tsx`，会话页整页渲染；`chat-workspace-sidebar-reveal.test.tsx` 已 709 行，不追加）：workspace-sidebar 场景「实际选中与再次点击」两组——开关关着：第一次点击之后 `在文件页打开` 的 `href` 不带 `path`、预览区是 `未选择文件`（空态由 G11a 做到，这里只是沿用，页面上没有 `文件不存在`），文件重新生成且所在层刷新后再点同一行会选中它、`href` 带 `path`；开关开着、列表里本来就没有的 `old.md`：点击之后 `href` 不带被定位的路径。验证：在现有实现上判红。
- [ ] 11b.3 实现：`WorkspaceBrowser` 向宿主上报实际选中的文件，并接受「重新套用 `path`」的触发（design D11）；`web/src/features/chat/workspace-sidebar.tsx` 以上报的实际选中生成 `在文件页打开`，把每一次卡片定位的 `seq` 交给浏览器；头注释里「两处代价」一段随实现删除。文件页不消费这项上报、不据此改地址。`workspace-browser.tsx` 不越 800 行。验证：11b.1、11b.2 转绿；files-web「地址定位到文件」的既有用例（深链到不存在的文件时地址保持原样）与 11a 的全部用例不改、仍通过。
- [ ] 11b.4 变异证据：侧边栏改回用被定位的路径 → 11b.2 两组的 `href` 断言判红；去掉重新套用的触发 → 11b.2 第一组的第二次点击与 11b.1 判红；文件页也消费上报并改写地址 → 「地址定位到文件」的既有用例判红。`make ui-walk` 跑一次。

Suggested fixture level: expanded - 改的是文件页与会话页共用的 `WorkspaceBrowser` 对宿主的契约（新增一条上报与一个触发）
Minimal mergeable slice: atomic - 上报没有消费方是死属性，侧边栏只换 `href` 的来源而不接重新定位则同一张卡片仍点不动

## 12. omp-test-harness — 受控上游按回合判定工具轮（G12，#1140）

- [ ] 12.1 测试先行（`server/test/fake-upstream-markers.test.ts`，现 445 行，或同组新文件）：omp-test-harness 场景「按回合判定工具轮」——`toolRoundScope:"turn"` 下历史为 `user → assistant(tool_calls) → tool → assistant → user(WORKBUDDY_TODO)` 的请求得到 `todo` 调用，追加 `tool` 消息后得到文本轮，`WORKBUDDY_WRITE` 与无标记同理；不传选项与传 `"history"` 时同一请求得到固定回复；`"turn"` 下错误标记、应答轮的 `WORKBUDDY_THINK`（有无闸门）、单条 user 消息的两轮与缺省逐字节相同（除生成的 id 与时间戳）；`start({toolRoundScope:"session"})` 被拒且没有端口被绑定。验证：在现有实现上判红（选项被忽略）。
- [ ] 12.2 实现：`server/test/support/fake-upstream.mjs` 的 `start(options)` 校验并保存 `toolRoundScope`，`serveChat` 的工具轮判定按它二选一；缺省分支的代码路径不动。验证：12.1 转绿；`fake-upstream.test.ts`、`fake-upstream-gates.test.ts` 与 `fake-upstream-markers.test.ts` 的既有用例一条不改、全部通过；`fake-upstream.mjs` 仍 ≤800 行。
- [ ] 12.3 删除转发器：`server/test/support/omp-official.ts` 的 `openOfficialWorld` 把选项透传给 `start()`，删掉 `freshToolRounds` 与 `startTurnForwarder`；`server/test/omp-official-approval-modes.test.ts` 的用例 (d) 改用新选项，其「夹具先行」断言的文案相应改写；`omp-official-model-commands.test.ts` 头注释里提到转发器的一句同步改。验证：`git grep -n "freshToolRounds\|startTurnForwarder" -- server` 无命中；用例 (d) 在 CI `uid-isolation` job 上通过（把该 job 的链接贴进 PR）。
- [ ] 12.4 变异证据：把 `"turn"` 的判定写回整段历史 → 12.1 第一组判红。`make smoke` 与 `make ui-walk` 各跑一次，证明缺省路径没有任何改动需要（两者的夹具与断言文件 `git diff` 为空）。

Suggested fixture level: compact - 测试夹具的一个可选开关，缺省行为逐字节不变，不涉及产品代码
Minimal mergeable slice: 12.1–12.2（开关与夹具单测，转发器仍在，独立保绿）；其后 12.3 删除转发器（净减行，依赖前一刀）
