# Proposal: s1-followups-batch

## Why

S1f / S1g 的评审与 CI 留下十五个互不相干的小跟进 issue（#1126、#1140、#1150、#1244、#1257、#1261、#1269、#1273、#1277、#1282、#1337、#1340、#1372、#1380，及已作为 #1244 重复项关闭的 #1316）。
其中一部分等着 owner 定方向，owner 于 2026-10-12 裁决，并于 2026-10-13 就评审提出的五处补了裁决；其余本来就可以动手。每个都太小，不值得各开一个 change，但大半要改主规格里已有的句子，不能绕过 OpenSpec。
本 change 是这一批的共用 fixture：G1–G12，其中 G2 与 G11 各拆成两个任务组（G2a / G2b、G11a / G11b），共十四个任务组，一组一个 PR，各自可独立合入。

## What Changes

owner 2026-10-12 与 2026-10-13 的裁决在下面直接写成结论，不再作为选项。

- **G1（#1340）文件页目录缓存**：按路径取值只认自有键。根下名为 `constructor`、`__proto__`、`toString` 的目录不再使页面崩溃，也不再被当成已加载或已失败。
- **G2（#1150、#1273）服务端测试**：给 `SubscriberTable.subscribe` 的两条不变量各补一个测试；启动类测试取端口的「先占后放」空隙改为遇端口被占即换端口重试（`PORT=0` 不是合法生产配置，不走「监听 0」）。不改 `server/src`。分两组：G2a 是两个测试加重试辅助函数，G2b 是 44 处调用点的迁移（在 G10 之后）。
- **G3（#1244）工作空间根被非目录占据**：`/api/workspaces/:id/` 之下各端点答 404，不再是 500——除转正之外都与根目录不存在时的应答相同；转正（`promote`）在根被占据时同样 404、不写审计、空间仍是临时的（根不存在仍不阻止转正）。`GET /api/workspaces` 照常列出这样的空间，与根不存在时一样，不再因它整个 500。
- **G4（#1261）`MODEL_ID` 校验**：空串、含控制字符、超过 128 个 UTF-8 字节 → 启动失败（通用配置失败记录）；首尾空格原样保留，不 trim。
- **G5（#1277）首次发送带暂存文件**：上传阶段按 `停止` 取消在途上传、不开始回合、草稿与标签回到输入框、已传完的文件留在 `uploads/`；移空标签后的空 prompt 不发；上传落定后补上与别处相同的归属判定。
- **G6（#1282，裁决 A）权限档位**：新建与 fork 写入会话行的档位夹取到当前 `APPROVAL_MAX_MODE`，上界日后放回不会让封顶期间建出的会话变成 `全部自动`；既有数据不回填。这局部推翻已归档 change `s1g-composer-capabilities` 的 design D3。同时改掉 ADR-0012 里与规格不符的审计一句。
- **G7（#1126）openspec CLI**：以 devDependency 精确固定 `@fission-ai/openspec` `1.13.2`，CI `fast-checks` 增加一步校验全部规格与未归档 change。**新增依赖与 CI 文件改动**，PR 必须标注。
- **G8（#1257）prompt 附件校验**：空间根丢失时答 404 且不写假的越界审计；末段为 `.` 的路径拒绝；路径里拒绝 U+0085、U+2028、U+2029 与双向控制字符。上传端点对文件名拒绝同一组码点（400，写盘之前），免得文件传得上去却发不出；已在磁盘上的这类文件仍可列举、预览、下载。
- **G9（#1269）输入框选项缓存**：本页一次设置保存成功后失效并重取，使欢迎页的档位 / 模型 / 强度缺省值与新建会话实际得到的一致。重取不丢弃欢迎页上已选的档位与模型；只有缺省模型变了、且页面上没有选过模型时，已选的强度才被丢弃。
- **G10（#1337）监听次序**：主监听器先绑定、预览监听器后绑定，系统分配的预览端口不可能占掉配置的 `PORT`。显式 `PREVIEW_PORT === PORT` 的失败阶段由 `listen` 变为 `preview_listen`。信号处理随之调整：两次绑定各用自己的 `AbortSignal`，信号落在预览绑定在途时只中止那一次绑定。
- **G11（#1372、#1380）会话页侧边栏**，分两组。G11a（#1372）：`只看本会话改动` 打开时列出的每个改动行都可选中（父目录未加载也一样），预览头容忍缺大小与修改时间；已不存在的改动文件移出列表与预览区——它是当前选中的文件时选中被清除、预览区回到未选状态，不显示错误文字；开关开着时助手新写出的文件照常列出（不因陈旧的列表被判成不存在）。开关关着时侧边栏对已不存在的文件同样清空、不显示 `文件不存在`（owner 2026-10-13「侧边栏里一律清空」），文件页的呈现不变。G11b（#1380）：侧边栏以实际选中的路径生成 `在文件页打开`，再点同一张卡片重新定位。
- **G12（#1140）受控上游**：`fake-upstream` 增加可选的按回合工具轮判定，删除 `omp-official.ts` 里的裁剪转发器。缺省行为逐字节不变。

没有 **BREAKING** 的对外接口变化。G6 改变新建与 fork 会话行里存的档位（只影响上界低于账号最近选择的部署）；G10 改变一个失败阶段的取值（`listen` → `preview_listen`，只在两个端口显式相同时）。

Critical Path：G6 触碰「omp 子进程治理」（审批档位决定 spawn 的 `--approval-mode`）；G8 触碰「沙箱与文件边界」（附件路径与上传文件名的校验、何时写越界审计）；G3 改的是工作空间根的取得与状态映射，不改 `core/sandbox`，按邻接面同样请求白盒审查；G10 改的是启动窗口内的关停次序（主监听器已受理请求、可 spawn omp），是「omp 子进程治理」的邻接面，同样请求白盒审查。四组的 PR 都须标注并由 owner 白盒审查。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `files-web`：「目录树与预览」增加目录名与对象原型成员同名时的规则（G1）；「工作空间浏览器组件」增加 `onlyPaths` 下行可选中与已不存在的路径不列出、侧边栏专用的 `clearMissing` 与句柄的 `reported`（G11a）、实际选中的上报与重复定位（G11b）。
- `workspaces`：「工作空间 HTTP 集成边界」写明根路径被非目录占据时各端点（含 `promote`）为 404、列表照常列出（G3）；「文件上传」的名字规则多拒 U+0085、U+2028、U+2029 与双向控制字符（G8）。
- `http-service-skeleton`：「服务启动与装配」增加 `MODEL_ID` 的取值规则（G4）并改两个监听器的启动次序与失败步骤次序（G10）；「预览监听器的装配与关停」改为主监听器先绑定（G10）。
- `message-attachments`：「欢迎态暂存与首次发送」增加上传阶段的停止、空首次发送不发出、上传落定后的归属判定（G5）；「prompt 携带附件」收紧第 1 条的字符与末段规则，第 4 条先判空间根（G8）。
- `session-permission-tier`：「管理员最高档」规定新建与 fork 的写入值不高于上界（G6）。
- `session-composer-settings`：「创建会话时的设置与继承」里继承档位的例外（G6）。
- `session-metadata`：「fork 继承会话元数据」里档位的例外（G6）。
- `turn-control`：「从此处分叉 REST」里「三列原始值复制自源会话」一句加同一例外（G6）。
- `chat-sessions`：「会话 REST」fork 段里 `copied raw approval_mode` 一句加同一例外（G6）。
- `verification-harness`：「CI 接线与控制面同步」的 `fast-checks` 增加 openspec 校验一步与固定版本（G7）。
- `chat-web`：「输入框与能力栏」里「每个 client 取一次」一句改为保存设置后重取（G9）。
- `workspace-sidebar`：「本会话改动标记与过滤」改为列出的行都可选中、已不存在的文件移出列表与预览区，「随助手改动刷新」「从卡片定位到文件」随之改——不论开关开或关，已不存在的文件在侧边栏里都不显示文案（G11a）；「内容与文件操作」「从卡片定位到文件」的 `在文件页打开` 取实际选中、再点同一张卡片重新定位（G11b）。
- `file-previewers`：「预览头、下载与不可预览的呈现」「PDF 与办公文档」容忍没有大小与修改时间的行（G11a）。
- `omp-test-harness`：「受控上游思考与写入标记」增加 `toolRoundScope`（G12）。

`model-selection`「模型白名单配置」不改：它对单模型只说「`MODEL_ID` 的生效值」，取值规则写在 http-service-skeleton（design D4）。
G2a、G2b 只加测试、改测试辅助函数，没有规格变化。

## Impact

- **服务端代码**：`server/src/workspaces/store.ts` 与 `rest.ts`、`server/src/preview/app.ts`（G3）；`server/src/workspaces/rest.ts` 的上传名字规则与一个两处共用的码点判定小文件（G8）；`server/src/model-catalog.ts`（G4）；`server/src/sessions/store-composer.ts`、`store-branch.ts`（G6）；
  `server/src/sessions/prompt-attachments.ts` 及其调用点（G8）；`server/src/server.ts`、`server/src/workspaces/rest-preview-token.ts`（G10）。
- **服务端测试与夹具**：取端口的十二个测试文件与新的重试辅助函数（G2a、G2b、G10）；`server/test/support/fake-upstream.mjs`、`omp-official.ts`（G12）。
- **前端代码**：`web/src/features/files/`（G1、G11a、G11b）；`web/src/features/chat/` 的 `turn-actions.ts`、`attachments-state.ts`（G5）、`composer-options.ts`、`session-actions.ts`（G9）、`workspace-sidebar.tsx`（G11a、G11b）、`use-workspace-sidebar.ts`（G11a）。
- **CI 与工具**：`.github/workflows/ci.yml`、`scripts/test-ci-harness.sh`、根 `package.json` 与 `package-lock.json`、`AGENTS.md`（G7）。
- **依赖**：新增根 devDependency `@fission-ai/openspec@1.13.2`（MIT，只在开发与 CI 使用，不进产物）。其余组不加依赖。
- **API**：无新增端点。状态码变化：工作空间端点与带附件的 prompt 在空间根被文件占据时 500 → 404；带附件的 prompt 在空间根缺失时 403 → 404；附件路径与上传文件名多拒几类字符（400）；`GET /api/workspaces` 在某个空间的根被文件占据时 500 → 200；`promote` 在根被文件占据时 500 → 404。
- **数据库迁移**：无。G6 不回填既有行。
- **文档**：`docs/adr/0012`（G6）、`docs/adr/0014`（G10）、`docs/architecture/system.md` 9.3 节（G6）、`docs/acceptance/functional-checklist.md` 的 CH-68、CH-69、CH-101（G9、G11a）。
- **跨 change 依赖**：无。组间次序见 tasks 文首的边表。
