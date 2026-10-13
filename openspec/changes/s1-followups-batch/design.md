# Design: s1-followups-batch

## Context

G1–G12 各对应一到两个跟进 issue（其中 G2 与 G11 各拆成两个任务组，共十四个任务组、十四个 PR），动机见 proposal。本文件只记三件事：每组的缺陷在 `origin/master`（`51ffffb3`）上是否仍在（`文件:行` 为 2026-10-12 读代码所得，没有运行任何测试）、
owner 2026-10-12 与 2026-10-13 两次裁决落成什么做法、编排方按保守默认定下而 owner 可以推翻的事（D14），以及仍然没有人能替 owner 决定的事（「待编排方确认」，现在是空的）。
2026-10-13 的裁决先有五条：#1244 的列表与转正两处边角（D3）、#1372 改为「已删除的文件移出列表和预览区」（D11，取代前一天的「显示 `文件不存在`」）、#1269 重取后保留页面内选择（D9）、#1257 上传文件名同步收紧（D8）、G2 与 G11 各拆成两组（D13）。同日稍后对前一稿 Q-2 的答复是第六条：「侧边栏里一律清空」——会话页侧边栏里不论 `只看本会话改动` 开或关，已不存在的文件都不显示文案（D11）。

核对结论：**G1–G12 的缺陷全部仍在，没有一项已在 master 上修好**。部分已做的只有 G1——`browser-paths.ts:208,246,277,308` 四处已用 `Object.hasOwn`，其余取值点没改。
#1316 已作为 #1244 的重复项关闭，并入 G3。

约束：

- 单文件 800 行（block）。`web/src/features/chat/use-chat-session.ts` 790 行、`turn-actions.ts` 725 行、`web/src/features/files/workspace-browser.tsx` 712 行、
  `server/test/server-startup-helpers.ts` 697 行、`server/src/server.ts` 682 行：这几个文件不得净增到越线，新逻辑放进新文件或既有的小文件。
- 同一个守卫也扫 `server/test` 与 `web/test`（`scripts/size-guard.sh` 的 `find`；`Makefile:36,40`、`ci.yml:56`）。几个本来顺手要追加用例的测试文件已经贴线——`workspace-store.test.ts` 798、`session-prompt-attachments.test.ts` 778、`server-config.test.ts` 771、`files-preview-states.test.tsx` 770、`workspace-upload-rest.test.ts` 766、`workspace-browser.test.tsx` 753——所以 G3、G4、G8、G11a、G11b 的新用例各进新文件，文件名在 tasks 里点了名，完整清单在 tasks 的通用纪律里。
- `scripts/test-ci-harness.sh:118` 以精确元组钉住 `fast-checks` 的全部步骤，`AGENTS.md` 的 Verification Matrix 与 Enforcement Index、`constraints.yaml` 的「恰十个 surface」也由同一个 oracle 钉住（G7）。
- 主规格的 MODIFIED 必须带回该 requirement 的全部既有 scenario（CLI 1.13.2 拒绝丢 scenario 的 MODIFIED）。本 change 的 delta 由主规格原文逐字拷出、只换点名的句子。
- 三组共改同一个 requirement 的规格文本时，delta 里是合并后的终态；各组的代码互不重叠（见 D13）。

## Goals / Non-Goals

**Goals:**

- 十四个任务组（G1–G12，G2 与 G11 各拆两组）各自一个 PR，合入后 `make check` 绿（触及走查或冒烟覆盖面的组另跑 `make ui-walk` / `make smoke`），主干可运行。
- 把 owner 已裁决的事（#1244、#1261、#1257、#1269、#1277 第 1 条、#1282、#1337、#1372 与 #1380）写进规格，去掉规格里「已知表现，处置待裁决」的句子。
- 触碰 Critical Path 的四组（G6、G8，以及按邻接面处理的 G3、G10）在任务与 PR 里明确标注。

**Non-Goals:**

- 给目录树或预览区加错误边界（#1340 明确划出）；服务端拒绝 `constructor` 这类目录名（它们是合法文件名）。
- 回放与实时事件的去重语义、`fanout` / `endAll` 的其它行为（#1150 划出）；改 `server/src/sessions/supervisor-subscribers.ts`。
- 让被测入口监听端口 0（`PORT` 的合法范围是 `1..65535`，#1273 的第一个选项因此不取）。
- 回填既有会话行或账号最近选择行的档位（G6，裁决：不迁移）；上界放回时补写审计（#1282 的方向 B）；界面上清掉既有会话里存着的超界档位。
- 封顶之前建出的会话在上界放回后恢复 `全部自动`：这是 D3 保留下来的行为，它们各有一条当时的 `session.permission`。
- 升级 openspec 到 1.14.x；改任何已归档 change 的内容；把 openspec 校验接进本地 `make check`（只进 CI `fast-checks`）。
- 改服务端 `/stop` 的 204 与空 prompt 的 400（规格行为）；建会话期间（`createSession` 未返回）的 `停止`——那时按钮本来就禁用（`composer.tsx:216`），裁决只覆盖上传阶段；上传阶段离开新会话的草稿不恢复（#1277 背景段，既有行为）。
- 过滤视图为取元数据而请求 `tree`（#1372 的方向 c）；选中时另取元数据（方向 b2）；为探知文件是否还在而另发探测请求；文件页的任何行为——包括它对不存在的文件显示 `文件不存在` 的既有呈现（owner 2026-10-13 只让侧边栏清空）；开关关着时把应答 404 的行从普通目录树里移除（行只来自 `tree` 列表）；为补上过滤期间没重列的层而在关掉开关时重放 `tree`（既有表现，`workspace-sidebar.tsx` 头注释已记）。
- 改名、隐藏或拒绝访问磁盘上已有的、名字含 G8 新拒码点的文件（裁决：仍可列举、预览、下载）；前端在上传前预先校验文件名。
- 改 `fake-upstream` 的缺省判定；独立进程启动的上游（`ci-fake-upstream.sh`）支持新开关。
- 预览监听器的关停次序（与绑定次序无关，保持「先关预览监听器」）；`PREVIEW_ORIGIN`。

## Decisions

### D1（G1，#1340）目录缓存按路径取值：一个取值函数，不换 Map

**证据**（缺陷仍在）：`DirectoryCache` 是 `Record<string, DirectoryListing>`（`browser-paths.ts:8`），错误表是 `Record<string, string>`（`tree.tsx:22`、`workspace-browser.tsx:139`）。裸取值点：

| 位置 | 取值 | 后果 |
|---|---|---|
| `browser-paths.ts:175` | `cache[parent]?.entries` | 根下 `constructor` 目录取到 `Object.entries`（函数），`for…of` 抛 `TypeError`，渲染期整页卸载 |
| `browser-paths.ts:181` | `!cache[path]` | 原型成员同名目录被当成已加载，混进位置下拉 |
| `browser-paths.ts:240`、`:255` | `cache[above]?.entries.some`、`cache[last]?.entries.find` | `revealStep` 对同名目录取到函数或原型对象 |
| `tree.tsx:362` | `cache[path]?.entries` | 展开态下对函数调 `.map` |
| `tree.tsx:365` | `errors[path]` | `__proto__` 取到 `Object.prototype`，被当作错误行的子节点渲染 |
| `workspace-browser.tsx:204` | `!current[path]` | 清错误时的真值判断（triage 没列出这一处） |
| `browser-paths.ts:169`、`folder-dialog.ts:22` | `cache[""]` | 键是空串，不是原型成员，**没有缺陷**；triage 把 `folder-dialog.ts:22` 列进来是多列了，但按同一规则一并改 |

写入点没有问题：`{ ...cache, [path]: listing }` 的计算键与 `Object.fromEntries` 都定义自有属性（`workspace-browser.tsx:220`、`browser-paths.ts:117,322`）。

**决定**：一条规则到处用——`browser-paths.ts` 导出一个取自有值的函数（如 `ownValue(record, key)`，名字由实现定），目录缓存与错误表的**每一处读**都经它，既有四处 `Object.hasOwn` 改用同一个函数。
**不换 Map**：缓存是 React 状态，按不可变方式更新（展开一层即拷一份），Map 要改 `DirectoryCache` 类型、五个源文件与 `browser-paths.test.ts` 里全部手写的缓存字面量，而写入端本来就安全，换来的只是读端不可能漏——一个取值函数加一条守卫测试同样做到。
守卫：一个源码测试断言 `web/src/features/files` 下对这两种表没有方括号取值（见 tasks 1.3），回答 issue「下一个取值点还可能漏掉」的顾虑。

### D2（G2a、G2b，#1150、#1273）两个测试加一个带重试的启动辅助函数

**证据**：`supervisor-subscribers.ts:53-79` 的 `subscribe` 先 `add`（`:63`）再 `read()`（`:66`），读失败 `remove` 后重抛（`:68-69`）；`server/test` 下没有任何文件引用 `SubscriberTable`。
`server-startup-helpers.ts:88-103` 的 `reserveWildcardPort()` 绑 `0.0.0.0:0`、取到端口号后关闭，再把端口号交给子进程；`server/test` 下 12 个文件 44 处调用。

**决定**：

- #1150：直接对 `SubscriberTable` 写单元测试，用它已有的 `read` 注入口（issue 的推荐）。不动 `server/src`。
- #1273：空隙在「探针关闭」与「子进程 `listen`」之间，`listen` 在子进程里，`reserveWildcardPort` 自己修不了。做法是一个包住「取端口 → 启动 → 等 `server_started`」的辅助函数：
  子进程在 `server_started` 之前退出且失败记录的 `reason` 是 `listen` 或 `preview_listen` 时，换一个端口重来，至多三次；其它失败原样交还调用方。
  它是**可选**的：有意让端口被占的用例（`server-startup-failure-reason` 的端口占用例、`server-startup-preview` 的预览端口占用例、`listener-shutdown` 里自己占端口的例）继续用原来的两个函数。
  期望「成功启动」或「非监听阶段失败」的用例迁到新函数——后一类正是 #1337 那次假红的形状（期望 `publish`，实得 `listen`）。
- 不取「按 worker 分段取非临时端口」：能避开系统临时端口的碰撞，但要假设 CI 机器上那一段没人用，且与 issue 给的两个选项都不同。

规模如实说：两个测试是 S；辅助函数加迁移涉及 12 个文件 44 处调用，是 M。`server-startup-helpers.ts` 已 697 行，新函数放进新文件。

**拆成两组**（owner 2026-10-13）：G2a = 两个 `SubscriberTable` 测试加辅助函数与它的自测，现在就做；G2b = 44 处调用点的迁移，等 G10 之后。
辅助函数认的两个 `reason`（`listen`、`preview_listen`）今天都已在失败阶段的枚举里，所以它不必等 G10；等 G10 的是迁移——归类「有意让端口被占」的用例要按对调后的次序来，而且迁移与 G10 同改 `server-startup-failure-reason.test.ts`、`server-startup-preview.test.ts`、`listener-shutdown.test.ts`。
G2a 的自测只断言「是监听类失败」，不钉两个取值里的哪一个，G10 前后都绿。

### D3（G3，#1244）store 抛一个可辨认的错误，只在工作空间 HTTP 边界映射成 404

**证据**：`store.ts:305-316` 的 `computeSafeRoot` 在三种情况下抛同一句普通 `Error`：owner 段不安全（`:306`）、`resolveSandboxPath` 不通过（`:308-310`，含任一级是符号链接）、根路径存在但 `lstat` 不是目录（`:312-315`）。
`rootOf`（`:214-221`）原样抛出，`ensureOwnedRoot`（`rest.ts:93-102`）里 `isOrdinaryDirectory` 的 404 分支走不到，于是各端点 500。

triage 写的「只动 `store.ts` 的状态映射」不成立——`rootOf` **抛出**这件事有别的消费者在依赖：

- `sessions/session-cwd.ts:19-24`：抛出 → `agent_unavailable`（session-metadata「绑定不可改与工作目录」明文：`rootOf` 因根被同名文件占据而拒绝解析 → 不 spawn、502）。
- `sessions/rest-commands.ts:64-65`：抛出 → 该空间没有项目级命令（null）。
- `sessions/rest-metadata.ts:98`：抛出 → 通用 5xx（注释写明是有意的）。
- workspaces「工作空间 store 与惰性目录事务」：owner 段不安全、owner / 工作空间目录是符号链接 SHALL 通用失败。

**决定**：`rootOf` 继续抛，会话侧一行不改。只把第三种情况（存在但不是目录，且不是符号链接——符号链接在 `resolveSandboxPath` 就被拒，落在第二种）换成 store 导出的一个专用错误类；
工作空间 HTTP 边界上取根的三处——`ensureOwnedRoot`（`rest.ts:98`）、`requireOwnedBeforeParse`（`rest.ts:251`）、预览监听器（`preview/app.ts:192`）——捕获**这一个类**并答 404。其余两种仍是通用失败。
**不取**「`rootOf` 对非目录返回 null 或返回路径」：前者让会话创建把自己的空间当成别人的（404 而不是既有语义），后者让 `session-cwd.ts` 的 `statSync`（跟随链接）成为唯一防线，动到 Critical Path 上更多的地方。

**两处边角**（owner 2026-10-13 裁决，前一稿的 C-1 与评审指出的 `promote` 缺口）：

- **列表**。`GET /api/workspaces` 经 `store.list` → `toWorkspace` → `computeSafeRoot`（`store.ts:112-118`、`:226-232`）给每一行算 `root`，任一空间的根被占据时整个列表 500——用户连列表都看不到，各端点的 404 也就到不了。
  裁决：列表对被占据的根与对缺失的根**一样照常列出**，不 500。做法：专用错误类带着已解析出的路径，`list` 捕获它、`root` 取那条路径——与根缺失时 `computeSafeRoot` 返回的是同一个字符串，所以应答体逐字相同。这推翻前一稿「只动 HTTP 边界、store 只换错误类」的说法：`store.list` 也要改一处。`create` 与 `promote` 不捕获。
- **转正**。`POST /api/workspaces/:id/promote`（`rest.ts:288`）走 `requireOwnedBeforeParse`，它只判 `rootOf(...) === null`：根**缺失**时不是 404，`store.promote` 照常成功（读代码推出，未实测；temporary-workspaces「转正」没有把根的存在作为前提）。根被**占据**时 `rootOf` 抛出，现在是 500。
  裁决：被占据 → 404 `not_found`，不写 `workspace.promote` 审计，行仍是临时的；缺失仍不阻止转正。所以 `promote` 是唯一一条「占据 ≠ 缺失」的路由，规格句相应从「与根缺失相同」改成「一律 404，其余路由恰与根缺失相同」。
  实现上的坑：抽出的取根函数只负责「专用错误类 → `not_found`」，两个调用方各自原有的判定不能被它统一掉——`ensureOwnedRoot` 是「null 或不是普通目录 → 404」，`requireOwnedBeforeParse` 只在 null 时 404。把后者也改成查「是不是普通目录」就会让根缺失的 `promote` 变 404，违反裁决；tasks 3.6 有专门的变异。
  `promote` 的规则本体在 temporary-workspaces「转正」，本 change 不为这一句另开一个 MODIFIED 块：占据时的应答写在 workspaces「工作空间 HTTP 集成边界」（它管 `/api/workspaces/:id/` 之下全部路由的 404 先后），并点名引用那一条。

**规格**：只有「文件上传」第 1 步写了「根目录不存在或不是普通目录 → 404」；「工作空间 HTTP 集成边界」只说「structurally absent owned roots → 404」，file-operations 与 preview-origin 只说「根不存在」。
没有任何 scenario 覆盖「根是普通文件」，所以在「工作空间 HTTP 集成边界」加三句（各路由、`promote`、列表）并加一个 scenario（逐路由、`promote` 与其根缺失的对照、列表与其根缺失的对照、预览监听器、符号链接）。

**Critical Path**：不改 `core/sandbox`，不改哪些路径被接受；但 `computeSafeRoot` 是工作空间根的唯一取得点，属「沙箱与文件边界」的邻接面，PR 标注并请求白盒审查。

### D4（G4，#1261）`MODEL_ID` 与白名单条目 `id` 同一条规则

**证据**：`model-catalog.ts:40-41`，未设 `MODEL_CATALOG` 时 `MODEL_ID` 原样成为模型 id 与 name，注释「不校验、不 trim」。`MODEL_CATALOG` 路径的条目 id 已校验（`:158`，`isLabel` 加 `MAX_ID_BYTES = 128`）。

**决定**：`MODEL_ID` 给出时用同一对检查——1 到 128 个 UTF-8 字节、不含 U+0000–U+001F 与 U+007F；不 trim（裁决）。长度上限取 128，与白名单条目 `id` 相同，不另立数字。
校验放在 `resolveModelCatalog` 入口，两条路径（有无 `MODEL_CATALOG`）都过；配置了白名单时违反它的取值本来也不等于任何一项的 `id`，结果相同。失败记录是既有的 `{"event":"server_start_failed","reason":"config"}`，错误信息点名 `MODEL_ID`、不回显取值。
既有两条「字节原样」用例（`server-config.test.ts:267` 的 `" custom-model "`、`:293` 的 `"model-bytes"`）保留，语义不变。

规则写在 http-service-skeleton「服务启动与装配」（配置键的校验都在那里）；model-selection「模型白名单配置」对单模型只说「`MODEL_ID` 的生效值」，不需要改。该 requirement 开头的「共三十五项」「前二十三项」两处计数不变（没有新增键）。

### D5（G5，#1277）上传阶段的停止、空 prompt、归属判定

**证据**（三条都未修）：

1. `stopTurn`（`turn-actions.ts:426-443`）只调 `stopSession`；上传阶段没有回合，服务端答 204，什么都不变。`flushAttachments(sessionId)` → `send()`（`:318-327`）照常走完。
2. `send()` 取走标签后不看是否为空（`:250-256`）；标签在上传阶段被移光时 `flush` 以 `undefined` 落定，`:328-330` 当作「传完了」。
3. `staged.then` 在调 `send()` 之前只查 `controller.signal.aborted`（`:324`）；同函数另外两处落定用的是六项判定（`:259-266`、`:276-283`）。

**决定**（第 1 条是裁决，其余按 issue 的推荐）：

- 停止：页面拥有一次尚未受理的首次发送且处于上传阶段时，`停止` 走「取消这次发送」——中止在途上传（附件队列的在途句柄）、撤掉排队、不发 prompt、不调 `stopSession`，草稿与标签回到输入框。
  被中止的那个文件回到 `待上传`（裁决：在途上传取消），已传完的保持已上传、文件留在 `uploads/`。收尾复用「首次发送被拒」的那条路，但不写错误文案；
  `failOwnedPrompt` 对已中止的 controller 会提前返回（`:176`），所以先收尾、后中止，或给取消单独的入口——由实现定，规格只钉结果。
- 空 prompt：`send()` 里文本去空白后为空且没有取到任何标签 → 不发请求，按未受理收尾。
- 归属判定：把 `:259-266` 的六项抽成一个函数，三处共用。

**归属**：欢迎态首次发送的规格在 message-attachments「欢迎态暂存与首次发送」。turn-control「回合控制 web 呈现」说的是「会话 running 时」的停止，上传阶段会话并不 running，两条不冲突，不改 turn-control。

### D6（G6，#1282，裁决 A）新建与 fork 写入时夹取——局部推翻 s1g 的 D3

**证据**：`store-composer.ts:156` `const row = { ...last, ...given }`，请求没给的键原样抄账号最近选择的原始列（`:141-142` 的注释「valid under today's configuration or not」）；
`store-branch.ts:192-193` 的 `FORK_SESSION` 用 `INSERT … SELECT` 把源会话的原始 `approval_mode` 抄进新行。上界只在读取时夹取（`model-catalog.ts:96-100`）。
`docs/adr/0012-omp-project-config-host-overlay.md:79-80` 写「有效档位每次变化……都写一条 `session.permission`」，与规格「配置变化导致的夹取 SHALL NOT 写」不符。

**决定**：

- **本组局部推翻已归档 change `s1g-composer-capabilities` 的 design D3**（「只在读取时夹取，入库不夹取」）。推翻的范围只有两处写入：创建时由最近选择继承的 `approval_mode`、fork 复制的 `approval_mode`。
  读取时夹取照旧，PATCH 与显式给出的创建值照旧（超界即 400）。归档目录不改，修订记在这里与 ADR-0012。
- 写入的是**夹取后的值**，不是 NULL：上界 `write` 时继承来的 `yolo` 存成 `write`。存 NULL 会让会话日后跟随缺省档，而用户选过的「不低于 `write`」这层意思丢了；存上界本身最接近用户的选择。
- 不回填：上界调低之前已写入的会话行不动（裁决）。
- 审计条件不动：它按有效档位判定，夹取前后有效档位相同，「创建时的审计」第二组场景原样成立。
- fork 的夹取需要配置里的上界进到 `store-branch.ts`（现在是一条纯 SQL 的 `INSERT … SELECT`）。

受影响的规格句子有五处，都在 delta 里：session-permission-tier「管理员最高档」、session-composer-settings「创建会话时的设置与继承」、session-metadata「fork 继承会话元数据」、
turn-control「从此处分叉 REST」、chat-sessions「会话 REST」（后三处都写着「原始值复制自源会话」）。

文档：ADR-0012 `:79-80` 两句改成与规格一致，并记下 D3 的这次修订；`docs/architecture/system.md` 9.3 节 `:299` 的「包括封顶期间新建、继承了最近选择的会话……直接生效」与 `:300` 的「封顶期间新建的会话照样继承账号最近选择里的 `yolo`……上界放回后一并变成 `全部自动`」与裁决 A 直接相抵，要**改写**而不是在后面补一句：封顶期间新建与 fork 的会话存的是夹取后的档位，上界放回后不变；只有封顶之前写入的会话行与账号最近选择里的原始值原样恢复。

**Critical Path**：「omp 子进程治理」——档位决定 spawn 的 `--approval-mode`，是审批放宽的入口。owner 白盒审查。

### D7（G7，#1126）devDependency 固定，CI 用 `--all`

**证据**：`git grep openspec -- package.json Makefile AGENTS.md .github` 无命中。本机两个 CLI：`~/.nvm/…/bin/openspec` 是 1.3.1，`~/.local/bin/openspec` 是 1.13.2。
两者对 master 现有的 42 份主规格执行 `validate --all --strict --no-interactive` 都是 `42 passed, 0 failed`（2026-10-12 实测）。

**决定**：

- 承载方式取 issue 写明的那一种：根 `package.json` 的 `devDependencies` 加 `@fission-ai/openspec`，版本写死 `1.13.2`，进 lockfile；一律 `npx openspec` 调用。
  不取「文档里写安装命令」：那正是现状（各人各版本）。包的 `engines` 是 `node >=20.19.0`，仓库 Node 24.13.1，满足。
- CI：`fast-checks` 在 `npm run typecheck --workspaces` 之后加一步 `npx openspec validate --all --strict --no-interactive`。
  用 `--all` 而不是 issue 写的「对每个未归档 change 循环」：一条命令同时校验主规格与全部未归档 change，没有 change 时也有意义，oracle 钉一个字符串即可。这是**有意偏离 #1126 第 2 项的字面**（方向更严），PR 说明里点名（tasks 7.6）。
- 这一步让 G7 比 issue 估的 S 大（见 D13 的规模表）：`scripts/test-ci-harness.sh:118` 以精确元组钉住 `fast-checks` 的步骤，必须同步加这一步，并为它补变异例（删除、去 `--strict`、不经 `npx`、`continue-on-error`）；
  verification-harness「CI 接线与控制面同步」要改；`AGENTS.md` 的说明句必须写在 oracle 不钉的位置（Verification Matrix 与 Enforcement Index 两张表、`constraints.yaml` 的十个 surface 都不加行），否则 oracle 判红。
- **issue 第 4 项做不了**：`.claude/skills` 是指向仓库外的符号链接，`git ls-files .claude .omp` 为空——skill 文档不在本仓库里，PR 改不到。见 D14-6。
- 需要在实现时核对的一点：knip 会不会把只在 `ci.yml` 里经 `npx` 用到的 devDependency 报成未使用（读配置推不出，跑 `make anti-drift` 才知道）；报了就在 `knip.json` 的根 workspace 里登记，并在 PR 说明。

按 AGENTS.md：**CI 文件改动与新增依赖都必须在 PR 里标注**；新依赖的理由是「现有工具里没有 OpenSpec 校验器，且版本之间行为不同（1.3.1 接受的 MODIFIED，1.13.2 拒绝）」。

### D8（G8，#1257）先判根、再解析；字符集写成枚举；上传文件名同一组码点

**证据**（三条都未修）：`prompt-attachments.ts:78` 第 1 条只拒 `endsWith("/")`；`hasControlCharacter`（`:88-96`）只拒 `<= 0x1f` 与 `0x7f`；
`admitAttachments`（`:132`）直接调 `sandbox.resolve`，根目录不在时 `core/sandbox/resolve.ts:20` 判为「cannot resolve sandbox root」→ 403 加一条 `sandbox.reject`。
issue 里「未核对：`computeSafeRoot` 是否先抛」的答案（读代码）：根**缺失**时它不抛（`store.ts:312-315` 只在存在且非目录时抛），所以是 403 加假审计；根**被文件占据**时它抛，是 500。

**决定**：

1. 根不可见 → 404，不解析、不写审计。做法与工作空间端点一致：`admitAttachments` 在解析之前经会话模块已有的 `workspaceRootOf` 取根并确认它是普通目录；被文件占据的那一种靠 D3 的专用错误类辨认，所以 **G8 依赖 G3**。
2. 末段不得恰为 `.`（与「不得以 `/` 结尾」并列）。中间的 `.` 段不管——它们解析得到文件、取得出文件名。
3. 字符集（裁决：收紧）：在既有的 U+0000–U+001F、U+007F 之外拒 U+0085、U+2028、U+2029，以及 Unicode `Bidi_Control` 属性的全部十二个码点——U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069。规格写枚举，不写「双向控制字符」这个要查表的词。
4. 上传文件名同步收紧（owner 2026-10-13 裁决，前一稿的 C-5）：workspaces「文件上传」第 5 步的名字规则拒同一组码点——U+0085、U+2028、U+2029 与那十二个双向控制字符——400 `bad_request`，不写审计。
   不这样做，名字里带这些字符的文件传得上去、标签显示已上传，发送却得到 400。位置不动：仍在第 4 步（沙箱解析）之后、第 6 步（建 `uploads`）之前，所以「在任何东西写下之前」成立，越界的名字也照旧先得到 403 与 `sandbox.reject`。
   只管新上传的名字：磁盘上已有的这类文件（此前上传的、助手写出的）照常可列举、预览、下载，`tree` / `file` / `download` 的路径处理一行不改。
   两处校验现在各有一个逐字相同的 `hasControlCharacter`（`workspaces/rest.ts:131`、`sessions/prompt-attachments.ts:88`）；新字符集做成一个两边共用的判定函数，放进一个新小文件，不各抄一份。前端不加预校验：被拒时标签按既有规则显示 `失败：<信封文案>`。

**Critical Path**：「沙箱与文件边界」——第 1 项改的是「何时写 `sandbox.reject`」，第 2、3 项是路径形状校验，第 4 项是上传入口的文件名校验。owner 白盒审查。

### D9（G9，#1269，裁决 A）保存成功后失效并重取

**证据**：`composer-options.ts:26-44`，`readRef` 记下 client 与状态，同一个 client 且上次没失败就不再取。欢迎态的三个控件回落到 `options.defaults`，而 `defaults` 是服务端按「最近选择」算出的——PATCH 或带键创建成功后它就变了。

**决定**：`useComposerOptions` 多给出一个「失效」入口；带三键之一的 `patchSession` 成功（`session-actions.ts:277`、`:473`）与 input 带三键之一的 `createSession` 成功（`use-chat-session.ts:542`）之后各调一次，立即重取。
重取在途与失败期间继续用上一份数据（控件不闪、不消失），失败后沿用既有的「下一次进入欢迎态或选中会话时重取」。不带三键的保存不触发。

**评论里的「只改强度发送得 400」**：成因是过期的 `defaults` 显示了一个已不是缺省的推理模型。重取之后这条序列在本页不再出现，但重取落地时欢迎态里可能已有用户选过的强度——
前一稿在这里自定了「`defaults` 一变就丢弃全部页面内选择」，会无声丢掉用户刚选的更严档位（`每次都问` 被换回缺省）。owner 2026-10-13 裁决改掉它：
**重取之后页面内选择保留**——欢迎态上选过的档位与模型不动（它们随创建请求显式发出，不靠缺省值）；只有「重取到的缺省模型变了，且页面上没有选过模型」时，已选的强度被丢弃。
这恰好堵住那条 400：强度是相对于模型的，页面上没选模型时它相对的是缺省模型，缺省模型换了，这个强度就没有着落；页面上选过模型时强度相对的是那个模型，缺省怎么变都与它无关。
**残余**：另一个标签页或设备改了最近选择时，本页的 `defaults` 仍会过期，那条 400 序列仍可能出现，直到本页下一次保存或刷新。评论提的另一条路（规格改成「选强度时同时带上所显示的模型」）没有裁决，本 change 不做，见 D14-7。

`use-chat-session.ts` 已 790 行：失效入口的接线不得让它净增到越线，调用放在 `session-actions.ts` 一侧或抽出的小函数里。

### D10（G10，#1337）主监听器先绑定

**证据**：`server.ts:430-434` 先 `owned.preview.listen`，`:441-445` 才 `owned.app.listen`；`preview-config.ts:10` 缺省端口 0；两者同一 `host`。

**决定**（裁决）：对调两次 `listen`。由此带出、必须一并处理的四件事：

1. **`AbortSignal`**。现在两次 `listen` 传同一个 signal，主监听器绑定后才换新的 controller（`server.ts:446`）。对调之后，如果预览监听器的在途绑定仍用主监听器那一个 signal，信号到达时 Node 的原生 close 会直接关掉**已绑定的主监听器**，
   绕过「runtime → listener → DB」的次序——这正是「服务启动与装配」明文禁止的。所以主监听器绑定之后立即换 controller，预览监听器的绑定用新的那一个。规格相应从「两次 `listen` 传同一个 `AbortSignal`」改成「各传一个只对该次在途绑定生效的」。
   光换 controller 不够（评审 P1-2）：`requestShutdown`（`server.ts:566-571`）只在**主实例未绑定**时才 abort。对调之后，预览绑定在途时主实例已经绑定，于是信号来了不 abort，`releaseOwned` 直接对 `listen` 仍在途的预览实例调 `close()`——能不能可靠地不留下后到的绑定，取决于 Fastify 对在途 `listen` 的 `close()` 怎么处理（没有核实）。
   所以 abort 条件要一起改成「当前有在途绑定」：预览监听器尚未 bound 时也 abort 当前 controller（它此时只管预览那一次绑定，原生 close 碰不到主监听器）；已绑定的主监听器仍只经 `releaseOwned` 关闭。两个方向各有一条变异证据（tasks 10.6）：沿用旧 signal 会绕过 runtime，不改 abort 条件会不中止在途绑定。
2. **失败清理与失败阶段**。预览端口被占用时主监听器已经绑定，清理要把它关掉（`releaseOwned` 已会关 `owned.app`）；「预览端口被占用」场景里「主端口从未处于可连接状态」不再成立，改成「主监听器已随清理关闭、端口可立即复用」。
   显式 `PREVIEW_PORT === PORT` 的失败阶段由 `listen` 变成 `preview_listen`（已归档的 `implementation-notes.md:220` 记的偏离随之过时，记录留在这里，不改归档）。失败阶段的封闭枚举不变。
3. **两次绑定之间的窗口**。主监听器已可连接而预览端口还没有：`rest-preview-token.ts:46` 用 `preview.port()` 拼地址，此时是 0，会签出 `http://host:0/w/…`。
   裁决没有覆盖这段窗口里 `preview-token` 该答什么——按 D14-4 定为「与未装配预览相同的 typed 404、不登记令牌」。
4. **关停次序不变**。关停先关预览监听器的理由（omp 只连主监听器、预览监听器上没有 `/api` 与 `/v1`）与谁先绑定无关。

**邻接 Critical Path**：两次绑定之间主监听器已受理请求、可以 spawn omp。信号路径改错的后果就是「runtime 先于 listener 退出」被绕过——这是「omp 子进程治理」的邻接面，G10 的 PR 按邻接面请求白盒审查（与 G3 同样的处理）。

要改的规格句：「服务启动与装配」的成功顺序一句、失败步骤列表一句、`AbortSignal` 一句，以及场景「override、非法配置与部分启动失败」末条里的「pending bind由同一AbortSignal取消」（改为「由该次在途绑定所用的AbortSignal取消」，否则保留下来的场景句与新条文相抵）；「预览监听器的装配与关停」的装配一句与「预览端口被占用」场景，另加一个场景。
文档：`docs/adr/0014-isolated-preview-origin.md:15`（「入口先于主监听器 `listen`」）、`:61`（「#1286、#1350、#1337 截至 2026-10-12 都是打开的 issue」，去掉 #1337）、`:77`（残余表里 #1337 一行，闭合）、`:95`（「固定 `PREVIEW_PORT` 还避开 #1337」一条，改写）。
源码注释：`server.ts` 文件头的次序串与 `:12`（「预览监听器在先，同一个 signal」）、`:326`（「先于主实例 listen」）、`:400`（「主监听器在它之后才 listen」）都描述旧次序，一并改；验证用的 grep 要覆盖这几种写法，不只是 `先于主监听器`。
测试：`server-startup-order.test.ts` 的 trace 断言、`server-startup-preview.test.ts` 与 `server-startup-failure-reason.test.ts` 里依赖旧次序的期望。

### D11（G11a、G11b，#1372、#1380）行都可选中、已不存在的移出；侧边栏拿实际选中

**证据**：`tree.tsx:302,311` 把没有 `size` 的行禁用；`browser-paths.ts:308-312` 的 `subtreeOf` 只在已加载的父目录列表里有同名条目时沿用它，否则合成 `{ name, type }`；
选中链路对 `size` / `mtime` 的硬依赖在 `preview.tsx:42-43`（必填属性）、`:120`（头部拼接）、`preview-area.tsx:74-81`（媒体预览的 `size`）、`:147,153`、`previewers/frame.tsx:137`（文档大小与 `documentMaxBytes` 比较）。
`workspace-sidebar.tsx:90-95` 的 `path` 状态是「被定位的」路径；`workspace-browser.tsx:561-571` 只在 `path` 属性变化时生效一次，定位没落在文件上时不上报。
`workspace-browser.tsx:186` 的 `loadDirectory` 在 `subtreeOnly` 下直接返回，所以开关开着期间已加载的列表不会更新；`use-workspace-sidebar.ts:95-100` 在回合结束时清掉待刷集合、改调无参 `refresh()`，最后 300 毫秒内的那批路径到不了浏览器（评审 R2-1，已在工作树上核对）。
`WorkspaceBrowser` 现有的宿主参数（`onlyPaths`、`onlyPathsEmpty`、`treeCollapsed`、`renderedSeq`、`layout`）里没有一个能区分「侧边栏、开关关着」与文件页：那时两处都不给 `onlyPaths`，而 `layout` 说的是排版。

**决定**（#1372：2026-10-12 的 b1，加 2026-10-13 的「已删除的文件需要移出列表和预览区」；#1380：2026-10-12 的方向）。按 issue 拆成两组（owner 2026-10-13），都改 `workspace-browser.tsx`，顺序进行：

**G11a（#1372）**

- 过滤视图里列出的行不再禁用：父目录未加载的行选中后照常取预览，预览头不显示大小与修改时间。过滤视图仍不请求任何 `tree`（#1106 的变异证据原样保留）。
- 预览头：`size` / `mtime` 变成可缺，缺时那一段不渲染。副行与截断提示里带大小的片段同样省去。文档大小的前置判定在大小未知时跳过。这一条只为「还在、但父目录没加载过」的文件服务。
- **已不存在的文件在侧边栏里一律清空**（2026-10-13 两条裁决：「已删除的文件需要移出列表和预览区」，它**取代**前一天的「显示 `文件不存在`」；以及对前一稿 Q-2 的答复「侧边栏里一律清空」）。一种处置，不看是怎么知道它不在的，也不看开关：
  - 父目录的列表已加载、其中没有它、且那份列表读到之后没有步骤报过它 → 不为它发请求；开关开着时不成行，卡片定位到它时不选中任何文件。
  - 对它的 `file` / `archive` 请求答 404（选中、卡片定位、刷新时重取预览）→ 清除选中；开关开着时该行另移出，不论父目录的列表里是否还有它（列表可能是过期的）。
  - 之后预览区是未选状态（`未选择文件`），没有任何错误文字。开关关着时不动普通目录树的行（它们只来自 `tree` 列表，下一次重列自然更新）。
- **陈旧列表不能判一个刚被报过的路径不存在**（评审 R2-1）。开关开着时不发 `tree`，根的列表停在打开开关之前；助手新写出的 `report.md` 不在其中，照「列表里没有即不存在」会让它不成行、无从选中，比 master 的「可见但禁用」还差。规则：列表读到之后被步骤报过的路径按「父目录未加载」对待——列出、无元数据、选中时由 `file` 的应答判定。
- **记账与作废**（前一稿的 Q-1，现在是决定：编排方按保守默认定，owner 可推翻，D14-8）。浏览器内存里两种记录：「被步骤报过」与「应答过 404」。同一套规则：某目录的 `tree` 列表读到 → 直属于它的路径两种记录都清掉、按新列表重判；新结束的步骤报了某路径 → 清它的 404 记录、记为被报过；切换会话或重新挂载 → 全清。树栏 `刷新` 与回合结束的全量刷新本身不清记录（否则开关开着时每点一次刷新，已删除的文件都重新冒出来，要再点一次才消失）。
  代价：经 `bash` 等不产生 `files.changed` 的途径重新建出的文件，在开关开着期间不会自己回到过滤视图，要关一次开关（展开或刷新那一层）或等下一个报它的步骤。
- **「被步骤报过」怎么到浏览器**：句柄加一个只记账、不发请求的 `reported(paths)`，`useAssistantRefresh` 在发现新结束步骤的那个 effect 里立即调用（首屏播种那一次不调），不进 300 毫秒的合并窗口——回合在窗口内结束、待刷集合被清掉时路径也已经交出去了。
  不取「回合结束时先 `refresh(待刷路径)` 再 `refresh()`」：开关关着时那是每个已加载目录两次 `tree`、当前文件两次 `file`，既有场景「回合结束兜底」断言各一次。`refresh(paths)` 的语义不变。
- **侧边栏与文件页怎么区分**：`WorkspaceBrowser` 加一个布尔属性 `clearMissing`，只有侧边栏给（恒为真）。它管两件事：由 `path` 发起的定位没有落在文件上时不放文案（`endWithoutFile` 的文案一律当作空态）；当前文件的 `file` / `archive` 答 404 时清除选中并 `onPathChange(null)`，不进入失败态。行的移出仍只看 `onlyPaths`。文件页两样都不给，一行不变。
  定位没落在文件上的其它原因（指向目录、含 `..` 段、某一级以 404 之外的错误失败）在侧边栏里同样不放文案——见 D14-9。
- 裁决要求交代的三件事：
  - **数量**：过滤视图没有数量显示（读 `workspace-sidebar.tsx` 与 `columns.tsx` 的 `emptyNote`），本 change 不新增。可见的变化只有两处：目录之下不剩文件时目录行一并消失；一个都不剩时显示既有的 `本会话暂无文件改动`。
  - **`在文件页打开`**：选中被清除后地址不带 `path`。G11a 里这由既有的 `onPathChange(null)` 做到（当前文件被删除时浏览器本来就这样上报）；「定位没有落在文件上」时地址仍带被定位的路径，那是 #1380，归 G11b。
  - **三种情形**：侧边栏打开之前就删了（开关开着：根的列表里没有它 → 一开始就不成行；父目录没加载 → 成行，一选中就移出）；选中期间被删、下一次刷新（重取预览得到 404 → 清除选中，开关开着时另移出）；卡片 `查看详情` 指向已删除的文件（侧边栏照常打开，没有选中任何文件，预览区是未选状态；开关开着时不请求 `tree`）。
- 状态归谁：`WorkspaceBrowser` 的（它有目录缓存，也是它收到 404 与 `tree` 应答），记在组件内存里，随卸载清空。宿主只多给一个属性、多调一个句柄方法，不需要新的回调，`features/files` 仍不从 `features/chat` 导入。
- **开关关着的改动落在 G11a**，不在 G11b：它与开关开着时的 404 清除是同一个分支、同一条 `onPathChange(null)`，分到两组要先按 `onlyPaths` 写一遍再改成按 `clearMissing`。两组各自保绿：G11a 原地改写被本组行为打破的既有断言并逐条记进偏离记录——开关关着的 `文件不存在` 断言（`chat-workspace-sidebar-reveal.test.tsx`、`chat-workspace-sidebar-reveal-html.test.tsx`），以及开关开着的三处（`chat-workspace-sidebar-changes.test.tsx` 的 C4、`workspace-browser.test.tsx` 里行禁用与 `reveal` 未加载层的两处；清单见 tasks 11a.3），文件页的用例不动；G11b 的用例从一开始就按空态写，只管 `在文件页打开` 的地址与再次点击。
- 做不到的一处：不经 `file` 取数据的类别（网页的渲染视图、PDF、办公文档、音视频）在父目录未加载时页面拿不到 404，无从知道文件已删除，除非另发一次探测请求——不发，沿用各类别既有的失败呈现（D14-5）。开关关着时这几类被删除后同样如此：刷新重列之后行消失、选中保留、框内是预览来源的应答。

**G11b（#1380）**

- 侧边栏拿到的是实际选中：`WorkspaceBrowser` 向宿主上报实际选中的文件，侧边栏以它生成 `在文件页打开`。再点同一张卡片要重新定位——侧边栏已有按 `seq` 区分每一次定位的状态（`located.seq`，`renderedSeq` 是先例），把它交给浏览器作为「重新套用 `path`」的触发即可。
  **文件页不能用同一个回调改写地址**：files-web「地址定位到文件」要求深链到不存在的文件时地址保持原样（刷新回到同一处）。所以上报实际选中是文件页不消费的一条通道，规格里写明。
- 定位到不存在的文件时预览区已由 G11a 改为空态；G11b 变的只是 `在文件页打开` 不再带那个路径、再点一次会重新定位。

`workspace-browser.tsx` 712 行，G1、G11a、G11b 都改它：三组顺序进行，G1 → G11a → G11b。G11a 的记账逻辑放进 `browser-paths.ts` 或新的小文件。

### D12（G12，#1140）`start()` 的一个选项

**证据**：`fake-upstream.mjs:155` `if (!hasToolRole(parsed.messages))`，`:414` 的 `hasToolRole` 对整段历史判定。PR #1139 已合入：`omp-official.ts:56` 的 `freshToolRounds` 与 `:150` 起的 `startTurnForwarder` 在 master 上，
`omp-official-approval-modes.test.ts:161` 在用——所以「删除转发器」这一项是现成的工作，不是有前提的。

**决定**：`start(options)` 加 `toolRoundScope`，`"history"`（缺省，现行规则）或 `"turn"`（最后一条 `user` 之后没有 `tool` 消息即工作轮）。名字在规格 delta 里定下。
不取「用标记按请求切换」：标记会进入 omp 保存的消息文本，而 hurl 与走查对正文做逐字断言。`openOfficialWorld` 把选项透传给 `start()`，`freshToolRounds` 与转发器删除，净减约八十行。

### D13 组间次序、规模与 Critical Path

| 组 | issue | 规模 | Critical Path | 改规格 | 依赖 | fixture |
|---|---|---|---|---|---|---|
| G1 | #1340 | S | 否 | files-web | 无；先于 G11a（同改 `web/src/features/files` 三个文件） | compact |
| G2a | #1150、#1273（辅助函数） | S | 否 | 否 | 无 | compact |
| G2b | #1273（迁移 44 处调用） | **M** | 否 | 否 | ← G10（按新次序归类，且同改三个启动类测试文件） | compact |
| G3 | #1244（#1316） | S–M | 邻接「沙箱与文件边界」，请求白盒 | workspaces | 无 | expanded |
| G4 | #1261 | S | 否 | http-service-skeleton | 无（与 G10 只共用一段规格文本；入口用例放新文件） | expanded |
| G5 | #1277 | S–M | 否 | message-attachments | 与 G9 顺序进行（都可能碰 `use-chat-session.ts`，790 行） | expanded |
| G6 | #1282 | S–M | **是：omp 子进程治理** | 五个 capability 各一句 | 无 | expanded |
| G7 | #1126 | **M**（issue 估 S） | 否；CI 文件与新依赖须标注 | verification-harness | 无 | expanded |
| G8 | #1257 | S–M | **是：沙箱与文件边界** | message-attachments、workspaces「文件上传」 | ← G3（专用错误类） | expanded |
| G9 | #1269 | S–M | 否 | chat-web | 与 G5 顺序进行 | compact |
| G10 | #1337 | **M** | 邻接「omp 子进程治理」（启动窗口内的关停次序），请求白盒 | http-service-skeleton | 先于 G2b | expanded |
| G11a | #1372 | **M** | 否 | workspace-sidebar、file-previewers、files-web | ← G1 | expanded |
| G11b | #1380 | S–M | 否 | workspace-sidebar、files-web | ← G11a | expanded |
| G12 | #1140 | S | 否 | omp-test-harness | 无 | compact |

拆分（owner 2026-10-13）：G2 → G2a / G2b，G11 → G11a / G11b；G7 与 G10 各保持一个 PR（G7 的 oracle 强制 `ci.yml` 与步骤元组同提交；G10 的几个后果是同一刀）。十四组、十四个 PR。

`server-startup-failure-reason.test.ts` 的三方耦合（评审 P2-7）：前一稿里 G4（4.3）、G10（10.2）、G2（2.5）都改它，却写着 G4 与 G10 可并行。现在 G4 的入口用例放进新文件 `server-startup-model-id.test.ts`，不碰那个文件；剩下 G10 与 G2b，已有 G2b ← G10 这条边。

web/chat 几组是否冲突：**G11a、G11b 与 G5、G9 不冲突**（G11a 在 `web/src/features/chat` 里只改 `workspace-sidebar.tsx` 的一个属性与 `use-workspace-sidebar.ts` 的 `useAssistantRefresh`，G11b 只改 `workspace-sidebar.tsx`；G5、G9 的任务不碰这两个文件）。**G5 与 G9 不改同一段逻辑，但都贴着 `use-chat-session.ts` 的 800 行线**，并行会在合并时互相顶破，所以顺序进行，先后不限。

共改一个 requirement 的规格文本：http-service-skeleton「服务启动与装配」（G4 的 `MODEL_ID` 一句与两个场景片段、G10 的三句与一个场景句）、workspaces（G3 改「工作空间 HTTP 集成边界」、G8 改「文件上传」，不同 requirement）、
message-attachments（G5 改「欢迎态暂存与首次发送」、G8 改「prompt 携带附件」，不同 requirement）、files-web「工作空间浏览器组件」（G11a 的 `onlyPaths`、`clearMissing`、`reported` 三句，G11b 的上报与重复定位）、
workspace-sidebar「内容与文件操作」「从卡片定位到文件」（G11a 与 G11b 各有句子；G11a 合入而 G11b 未合入的那段时间，`在文件页打开` 在「定位没有落在文件上」时仍带被定位的路径，这是 #1380 的现状，不是回归）。
delta 是终态；各组实现各自的句子，归档在全部十四组合入之后一次进行。

### D14 编排方按保守默认定，owner 可推翻

下面九项裁决没有覆盖。编排方（2026-10-13）接受起草时的保守默认，delta 与 tasks 按它们写，不再等答复；owner 之后推翻哪一项，就改对应的规格句与任务。tasks 行内以 D14-n 引用。

1. **（G3）符号链接的根保持 500。** 根路径是符号链接时落在 `resolveSandboxPath` 的拒绝里；store 条文明文要求这类状态通用失败，而「文件上传」第 1 步的「不是普通目录 → 404」字面上也包含它。取前者：各路由 sanitized 500，`GET /api/workspaces` 同样因它失败。delta 的场景把它钉住。
2. **（G4）纯空白的 `MODEL_ID` 不拒。** 裁决列的是空串、控制字符、超长，并写明首尾空格保留；issue 的期望里还有「只有空白」。按裁决字面，单个空格是合法的模型名。
3. **（G6）账号最近选择行不动。** 裁决说的是会话行。最近选择行里的原始 `yolo` 留着，上界放回之后**新建**的会话会继承它——那次创建有 `session.permission` 审计、界面是警示色，不算「无声」。
4. **（G10）两次绑定之间的 `preview-token` 答 typed 404。** 见 D10 第 3 点：与未装配预览相同的 typed 404，不登记令牌。备选是 503。这段窗口在 success record 之前，正常客户端不会在此时请求。
5. **（G11a）不经 `file` 取数据的类别沿用既有失败呈现。** 网页的渲染视图、PDF、办公文档、音视频在没有列表条目时无从知道文件已删除，除非另发一次探测请求；不发。行照常列出，选中后框内是预览来源自己的应答、音视频是 `无法播放该文件`。「移出列表与预览区」对这几类只在父目录的列表已加载时成立。
6. **（G7）skill 文档不在本 change 里。** issue 第 4 项要求把 `.claude/skills` 下的 `openspec validate` 改成 `npx openspec validate`。那些文件不在本仓库（符号链接到仓库外，零个被跟踪文件）；要改得到 pack 的源头去改。
7. **（G9）「只改强度得 400」的跨标签页残余不处理。** 同页的那条序列由重取消除；另一个标签页或设备改了最近选择时仍可能出现。不把规格改成「欢迎态选强度时同时带上所显示的模型」。

8. **（G11a）两种记录的作废规则。** 「被步骤报过」与「应答过 404」何时作废，裁决没有说。规则见 D11「记账与作废」与 workspace-sidebar「本会话改动标记与过滤」：读到所在目录的列表、被新结束的步骤再报、切换会话或重新挂载时作废；树栏 `刷新` 不作废。备选：树栏 `刷新` 也清 404 记录。
9. **（G11a）侧边栏的预览区不放定位文案。** 「一律清空」说的是已不存在的文件。定位没落在文件上的另外三种原因——路径指向目录（本来就是空态）、含 `..` 段、某一级父目录以 403 / 500 / 网络错误失败——在侧边栏里同样是空态。不放的只是预览区的文案：失败的那一级在树上有行时，不论状态码（404 在内）树区照常就地显示它的失败文案。理由：按状态码把 404 与其它失败分成两种呈现要多一条分支，而看得见的差别只在「树上没有行的那一级以非 404 失败」这一种少见情形。备选：非 404 的失败仍在预览区显示信封 message。

前一稿另有三条已由 owner 2026-10-13 裁决、不再是默认：C-1（列表，见 D3）、C-5（上传文件名，见 D8）、C-7(a)（已删除文件的文案，见 D11）；C-10（规模与拆分）见 D13。

## 待编排方确认

无。前一稿的两条都已了结：Q-1（记录何时作废）由编排方按保守默认定下，移入 D14-8，并扩成同时覆盖「被步骤报过」与「应答过 404」两种记录；Q-2（开关关着时的 `文件不存在`）由 owner 2026-10-13 答复「侧边栏里一律清空」，写进 D11 与 workspace-sidebar 的三条 requirement。

## Risks / Trade-offs

- [G3 的专用错误类漏掉一个取根点] → HTTP 边界的取根点只有三处（`rest.ts:98`、`:251`、`preview/app.ts:192`），加 `store.list` 一处；tasks 3.2 的表驱动测试对每条路由各打一次，列表与 `promote` 各有带对照的一例；会话侧四个消费者有回归用例证明行为没变。
- [G3 抽取根函数时顺手把 `promote` 的判定统一成「不是普通目录 → 404」] → 根缺失的 `promote` 会由 200 变 404，违反裁决；tasks 3.2 的对照例与 3.6 的变异专门钉这一点。
- [G6 之后 fork 出的会话与源会话的原始列不再逐值相同] → 只在源会话原始档位高于上界时不同，有效值相同；session-metadata 与 turn-control 的既有场景（上界 `yolo`）原样成立。
- [G6 夹取后，用户在上界放回后发现封顶期间建的会话不是 `全部自动`] → 这正是裁决要的结果；界面上改一次档位即可，那一次有确认框与审计。
- [G7 的新依赖把 inquirer、ora 等十个传递依赖带进 lockfile] → 只是 devDependency，不进服务端与前端产物；`npm ci` 的耗时变化在 PR 里量一次（`fast-checks` 预算 10 分钟，历史高尾 300 秒）。
- [G7 之后任何让主规格或未归档 change 校验失败的 PR 都会红] → 这是目的；合入 G7 之前先在本地以 1.13.2 对全仓跑一遍（现状 42 份主规格全过）。
- [G8 收紧字符集后，名字里带这些字符的既有文件无法作为附件] → 这类名字只可能来自此前的上传、手工构造或助手写盘；它们仍可列举、预览、下载（裁决），只是不能作为附件发出，也不能再以这样的名字上传。
- [G8 的上传文件名校验被挪到沙箱解析之前] → 越界的名字会由 403 加审计变成 400 无审计；位置不动，tasks 8.6 有对应的变异（既有用例「越界名字被拒绝并入审计」判红）。
- [G10 的窗口期里主监听器已受理请求而托管布局、`models.yml` 还没写] → 对 `models.yml` 这不是新情况（旧次序里它同样在主监听器受理请求之后才写，窗口只是多了一次预览绑定的时长）。对托管布局是新情况：旧次序里主监听器绑定到 `ensureOmpStateLayout` 之间是同步代码，对调后中间隔着预览监听器的一次 `listen`，实现时钩子辅助复现到窗口里的 prompt 建快照目录 `ENOENT`、留一行 `session_fault`。owner 2026-10-13 裁决：托管布局提到两次绑定之间，紧跟主监听器绑定成功、其间不让出。代价是预览绑定失败时状态目录已经建立——主监听器已占住 `PORT`，说明没有另一个实例在用这份状态。
- [G10 对调后 `AbortSignal` 没有随之换新] → 会让信号绕过 runtime 直接关主监听器；delta 的场景「SIGTERM 落在预览绑定在途」与 tasks 10.6 的变异证据专门钉这一点。
- [G10 换了 controller 却没改 `requestShutdown` 的 abort 条件] → 信号落在预览绑定在途时不中止它，可能留下后到的绑定；同一个场景的「没有后到的预览绑定、两个端口可立即复用」与 tasks 10.6 的另一条变异钉这一点。
- [G11a 父目录未加载的 PDF / 办公文档跳过了大小前置判定] → 超限由预览来源自己拒绝，框内是它的应答；只影响过滤视图里没有元数据的行。
- [G11a 把一次瞬时的 404 当成「已不存在」，文件其实还在] → `file` 的 404 只在路径解析不到文件时出现，不是瞬时错误的形状（网络失败、5xx 仍走既有的失败文案，不移出）；误判后的恢复路径见 D14-8。
- [G11a 的清空逻辑漏进文件页] → 清空只在给了 `clearMissing` 时生效、移出只在给了 `onlyPaths` 时生效，文件页两样都不给；tasks 11a.1 有「两样都不给时同一个 404 仍是既有文案、定位落空仍是 `文件不存在`」的对照，11a.4 的验证点名文件页的既有用例不改，11a.6 有对应的变异。
- [G11a 开关关着时应答 404 的行还留在树里，点它什么都不显示] → 行只来自 `tree` 列表，这是列表过期的既有表现；步骤结束的局部刷新、回合结束与树栏 `刷新` 都会重列。不为此另发 `tree`。
- [G11a 开关开着期间被报过的路径一直按未加载对待，文件其实已被同一步骤删除] → 行列出，一选中就得到 404 并移出；它是当前文件时刷新的重取同样移出。
- [G2a 的重试掩盖真实的监听失败] → 只在失败阶段是 `listen` / `preview_listen` 且端口是辅助函数自己取的时候重试，至多三次；有意验证监听失败的用例不用它。
- [G5 取消与 `failOwnedPrompt` 的提前返回次序写反] → 草稿不恢复；tasks 5.1 的用例断言草稿与三个标签的状态。

## Migration Plan

无数据迁移。十四个 PR 各自可回滚（revert 即可）；G6 回滚后新建与 fork 恢复原样抄写，期间已夹取写入的行保持夹取后的值（它们本来就不高于写入当时的上界，回滚不造成放宽）。
G10 合入后，部署文档里「`PORT` 在临时端口段内时须显式设 `PREVIEW_PORT`」的提醒不再必要（ADR-0014 相应改写）；已经固定了 `PREVIEW_PORT` 的部署不受影响。
G7 合入后，贡献者本机改用 `npx openspec`；全局装的 1.3.1 不再是有效的校验依据。

归档：十四组全部合入后一次归档。归档前以 1.13.2 再校验一次，并对照主规格确认这期间没有别的 change 改过本 change MODIFIED 的二十二个 requirement（改过则先把对方的文本并进 delta）。

## Open Questions

无可以推迟到实现之后再答的问题。「待编排方确认」是空的；D14 的九项已由编排方定下。

## Not yet specified

- **过滤开着时定位到不在改动集合里的文件。** 卡片上的路径来自步骤的 `changes`，正常都在集合里；仍在运行的步骤的卡片是否可点、点了之后子树里没有那一行时该怎样，现在说不清问题的全貌（它取决于 turn-artifacts 的卡片在 running 步骤上是否出现）。本 change 的 delta 只规定在子树里有行的情形。
- **G2a 的重试是否该推广到 `server/test` 之外。** `web/e2e` 与 `.github/scripts` 也各自取端口；它们有没有同样的空隙、值不值得处理，要先看到一次那一侧的假红才问得清。
- **目录树的错误边界**（#1340「另议」）：单个渲染异常不卸掉整页。问题清楚，但范围与呈现（边界放在哪一层、出错后显示什么）没人提过要求。

## Sketch seams under test

- **整页渲染（既有 `render-app-router` + 假 fetch）**：G1（文件页，根下原型成员同名目录）、G5（首次发送的上传阶段：停止、移空标签、归属）、G9（保存后重取）、G11a（侧边栏过滤视图的选中、已删除文件的移出、定位，开关关着时的清空）、G11b（`在文件页打开` 与再次点击）。这几组的行为都是「用户做了什么、发出了哪些请求、页面显示什么」，这一层以角色、文本与请求记录断言，不必进组件内部。
- **`WorkspaceBrowser` 组件渲染（既有 `workspace-browser` 测试的假 client，用例进新文件）**：G11a 的 `onlyPaths` 行为（哪些路径成行、404 之后的移出与 `onPathChange(null)`、`reported` 与作废）与 `clearMissing`（给与不给的对照）、G11b 的「实际选中的上报与重复定位」。它们是组件对宿主的契约，整页测试只能间接看到。
- **`browser-paths` 纯函数**：G1 的 `loadedDirectoryPaths` / `revealStep` 对原型成员同名键。崩溃点就在这两个函数里，既有 `browser-paths.test.ts` 已在这一层。
- **主站 HTTP（`createApp` + `app.inject`）**：G3（各工作空间路由对被占据的根）、G6（创建、fork、审计与会话视图；以不同 `approvalMaxMode` 两次装配同一个库来模拟上界调低与放回）、G8（带附件的 prompt：字符、末段、根丢失；上传文件名的字符与已在磁盘上的文件的列举、预览、下载）。既有 seam，这三组的全部可观察结果（状态码、审计行、库里的列值）都在这一层。
- **预览监听器 HTTP（`createPreviewApp` + `inject`）**：G3 的预览监听器一例。
- **纯配置 seam（`resolveServerConfig`）加编译入口子进程（既有 `server-startup-helpers`）**：G4（`MODEL_ID` 的规则在纯函数上逐值断言，启动失败记录在入口上各取一例）、G10（绑定次序的 order trace、失败阶段、窗口期的 `preview-token`、信号）。只有真实入口能证明绑定次序与失败清理。
- **`SubscriberTable` 类本身**：G2a 的两个测试。它的 `read` 注入口就是为此留的；经 `SessionSupervisor` 驱动要对 store 做侵入式打桩。
- **`fake-upstream` 的 HTTP（`start()` 后直接请求）**：G12。既有 `fake-upstream*.test.ts` 都在这一层；官方二进制用例 (d) 在 CI `uid-isolation` 上证明真实 omp 一侧。
- **CI contract oracle（`make test-guardrails` → `scripts/test-ci-harness.sh`）**：G7。它本身就是「CI 步骤不可漂移」的测试面，新步骤的存在与变异都在这里断言。
- **`make smoke` / `make ui-walk`**：不新增步骤。G3、G6、G8、G10、G12 合入前各跑一次 `make smoke`，G1、G5、G9、G10、G11a、G11b、G12 各跑一次 `make ui-walk`，作为既有旅程不回归的证据。

## Traceability

| issue | 组 | 规格 delta | 文档 |
|---|---|---|---|
| #1340 | G1 | files-web「目录树与预览」 | — |
| #1150、#1273 | G2a、G2b | 无 | — |
| #1244、#1316 | G3 | workspaces「工作空间 HTTP 集成边界」（含列表与 `promote`） | — |
| #1261 | G4 | http-service-skeleton「服务启动与装配」 | — |
| #1277 | G5 | message-attachments「欢迎态暂存与首次发送」 | — |
| #1282 | G6 | session-permission-tier、session-composer-settings、session-metadata、turn-control、chat-sessions | ADR-0012、system.md 9.3 |
| #1126 | G7 | verification-harness「CI 接线与控制面同步」 | AGENTS.md |
| #1257 | G8 | message-attachments「prompt 携带附件」、workspaces「文件上传」 | — |
| #1269 | G9 | chat-web「输入框与能力栏」 | 验收清单 CH-68、CH-69 |
| #1337 | G10 | http-service-skeleton 两条 | ADR-0014、`server.ts` 注释 |
| #1372 | G11a | workspace-sidebar「本会话改动标记与过滤」「随助手改动刷新」「从卡片定位到文件」「内容与文件操作」（与文件页呈现不同的一句）、file-previewers 两条、files-web「工作空间浏览器组件」 | 验收清单 CH-101 |
| #1380 | G11b | workspace-sidebar「内容与文件操作」「从卡片定位到文件」、files-web「工作空间浏览器组件」 | — |
| #1140 | G12 | omp-test-harness「受控上游思考与写入标记」 | — |
