# Proposal: s1f-files-page

## Why

文件页是最后一个还在旧样式层里的页面（`web/src/features/files/` 不在已迁移清单里），S1f 的 D 部分要把它搬到 ADR-0013 的新组件底座上。
owner 在 2026-10-06 验收时又提出三点（#913）：HTML 只能看源码、可预览的格式太少、会话页的预览是弹窗而不是侧边栏。
压测后的结论是把 #913 并进 D 一次做完，避免在即将重写的旧文件页上做两遍；D 因此不再是纯前端。

## What Changes

- **文件页重写**：`/files` 整页改用 `components/ui` + Tailwind，退出旧样式层（`files.css` 删除，`web/src/features/files` 整目录登记为已迁移）。
  地址在 `?ws=<id>` 之外带 `&path=<空间内相对路径>`，可定位到具体文件。首刀只做「现有功能换底座」，可单独合入。
- **预览格式一次做完**：HTML（渲染 / 源码切换）、更多代码与文本（按语言高亮、带行号）、tsv、更多图片（gif、webp、svg、bmp、ico）、
  PDF（浏览器自带查看器）、办公文档（docx、xlsx、pptx，服务端经 LibreOffice 转 PDF）、音视频（mp3、wav、mp4、webm，范围请求）、
  Notebook（ipynb 只读渲染）、压缩包文件列表（zip、tar、gz）。无扩展名或未知扩展名的文件由服务端嗅探是否为文本。
- **大小上限按类别、可配置**：文本与代码 1 MiB 截断（不变）；图片 20 MiB；PDF 与办公文档 100 MiB；音视频不设上限；Notebook 10 MiB；
  压缩包只列前 1000 项。超限显示说明与下载按钮。
- **所有文件可下载**：预览头部统一一个下载按钮，不支持预览的格式也能下载；下载不设上限，记审计。会话页产物卡上图片的 `下载` 改走同一个下载端点（owner D-19）。
- **预览器按需加载**：各类预览器在第一次打开该类文件时才加载。这是全站唯一放开的代码分割（ADR-0013 增补）。
- **隔离预览来源**：服务端再开一个监听端口，只提供工作空间文件，凭主站签发的短时效令牌访问（令牌在路径里，相对资源自动带上），
  不认主站的登录凭据。HTML 的渲染预览、PDF 与办公文档转出的 PDF 都从这个来源加载；HTML 预览允许加载外部资源。
- **文件管理操作**：删除（先确认，移到服务端回收目录保留一段时间，界面不提供回收站）、重命名、同一工作空间内拖拽移动（目标同名时拒绝）。全部记审计。
- **会话页工作空间侧边栏**：右侧一个侧边栏（文件树 + 预览），与对话区并排、分隔线可拖动、窄屏覆盖全屏、切换会话时保持打开并换成新会话的空间；
  本会话改过的文件在树上带标记并可一键只看这些文件；侧边栏里同样能删除、重命名、移动。
  它取代 **产物面板** 与 **网页预览弹窗**（**BREAKING**：顶栏 `产物面板` 按钮、`产物面板` 对话框与 `srcdoc` 预览对话框移除）。
  文件变更卡的 `查看详情` 与产物卡的 `打开网页预览` 改为打开侧边栏并定位到该文件。
- **不做**（owner 划出范围）：文件页上传、工作空间删除与改名、跨空间移动、会话消息里的代码块高亮、在线编辑、挂载的远程存储上的差异、回收站界面。

## Capabilities

### New Capabilities

- `preview-origin`：隔离预览来源——第二个监听端口、预览令牌的签发与校验、该端口提供与拒绝的内容、两个来源各自的响应头。
- `office-preview`：办公文档转 PDF——LibreOffice 的调用方式、超时与并发上限、缓存、运行身份、失败呈现与测试替身。
- `file-operations`：工作空间内文件与目录的删除（回收目录、保留期与清理）、重命名与移动、下载，以及它们的审计。
- `file-previewers`：浏览器侧的各类预览器、类别判定、按需加载、超限与不支持时的呈现、统一的下载按钮。
- `workspace-sidebar`：会话页右侧的工作空间侧边栏——布局、开合、与会话的绑定、本会话改动标记与过滤、随助手改动刷新、从卡片定位到文件。

### Modified Capabilities

- `files-web`：全部既有条文按新底座改写（API 客户端扩展、文件预览纯组件、工作空间页、目录树与预览、文件界面与键盘可用性、创建浮层的焦点时序与模态清理）；
  新增地址定位到文件、文件操作的界面。
- `files-harness`：`files.hurl` 增加重命名 / 删除 / 下载 / 范围请求 / 预览令牌的步骤；`/files` 走查步骤按新页面改写并覆盖新预览与文件操作。
- `workspaces`：「预览分类元数据与有界字节流」「文件预览」扩展类别、内容类型、上限与范围请求；新增压缩包列表端点；
  「工作空间 HTTP 集成边界」的依赖对象与新增路由沿用的边界规则。
- `sandbox-core`：「resolve 契约与逃逸向量」的 `op` 在 S1g 之后的集合上增加 `delete` 与 `move`（facade 条文未枚举 `op`，文字不变，只是类型联合随之扩大）。
- `turn-artifacts`：「文件变更卡」「产物卡」的动作改为打开侧边栏，图片卡的下载改走下载端点；`查看详情` 对临时空间会话同样可用；「产物面板」移除。三条都以 C 的文本为底。
- `chat-web`：「会话页」的顶栏按钮与页面布局。
- `session-sidebar`：「会话条目菜单与重命名」里列出的顶栏按钮次序。
- `spa-shell`：「路由 IA 与侧栏」里 `/files` 的地址参数与顶栏按钮归属。
- `http-service-skeleton`：「服务启动与装配」的配置键、启动与关停次序；「统一错误信封」的归属路由集合；「Shared agent module assembly」里的配置键计数与工作空间路由的依赖对象；新增预览监听器的装配条文。
- `ui-primitives`：「按钮单一实现与旧类退役」的场景「迁移后行为不回归」——文件页的按钮迁移到拷入层后不再带 `ui-btn` 类（`新建会话` 已随 C 迁移），正文同步写明会话页与文件页都是已迁移区域。底本是主规格（C 与 S1g 不改它）。
- `ui-foundation`：「Tailwind 入口与层叠顺序」去掉以旧文件页为对象的场景；「组件分层」的已迁移清单；新增「预览器按需加载」。
- `chat-harness`：「UI 走查会话元数据」第 5 步与顶栏按钮断言；C 新增的「UI 走查临时空间、撤回与归档」第 1 步（`查看详情` 与网页预览改走侧边栏）。
- `verification-harness`：「UI 走查（Playwright）」的 `/files` 布局断言与「零非 `baseURL` 源请求」的例外。

`functional-acceptance` 的条文不变（行格式与签收规则照旧）；清单的行是文档任务，见 tasks。

## Impact

- **服务端代码**：`server/src/workspaces/`（预览分类、文件路由、压缩包列表、文件操作、回收目录）、`server/src/core/sandbox/`（两个新 `op`）、
  新模块 `server/src/preview/`（令牌登记、预览监听器、办公文档转换）、`server/src/server.ts` 与 `agent-config.ts`（配置键、第二个监听器的启动与关停）、
  `server/src/http/errors.ts`（归属路由集合）。
- **前端代码**：`web/src/features/files/` 全部重写并新增 `previewers/`；`web/src/features/chat/` 新增侧边栏，删除 `artifacts-panel.tsx` 与产物卡里的预览对话框；
  `web/src/lib/` 新增 `api-files.ts`；`web/src/components/ui/` 拷入 `resizable`。
- **API**：新增 `DELETE /api/workspaces/:id/entries`、`POST /api/workspaces/:id/move`、`GET /api/workspaces/:id/download`、
  `GET /api/workspaces/:id/archive`、`POST /api/workspaces/:id/preview-token`；`GET /api/workspaces/:id/file` 扩展类别并支持 `Range`；
  预览监听器上的 `GET /w/<token>/<path>` 与 `GET /o/<token>/<path>`。新增审计种类 `file.delete`、`file.move`、`file.download`。
- **数据库迁移**：无。预留给本 change 的 043–045 未使用（令牌在内存、回收目录在文件系统、宽度在浏览器本地、上限来自环境变量）。
- **依赖**：前端 `lowlight`（MIT）+ `highlight.js`（BSD-3-Clause）、`hast-util-to-jsx-runtime`（MIT，已是间接依赖，转为直接依赖）、
  `react-resizable-panels`（MIT，随 `resizable` 拷入）；服务端 `yauzl`（MIT）。全部登记 `ATTRIBUTION.md`。Notebook 渲染与 tar 列表不引库。
- **部署**：多发布一个端口（`PREVIEW_PORT`）；反向代理后需要设 `PREVIEW_ORIGIN`；要预览办公文档需安装 LibreOffice 并设 `OFFICE_BIN`，
  uid 分离部署下 sudoers 多一行（只有这一行；终止转换不新增提权规则，owner D-21）；新增十二个环境变量（全部有缺省值）。记入新的 ADR-0014 与 ADR-0010 增补。
- **跨 change 依赖**：`Depends on change s1f-session-list-temp-space`（临时空间的定义与 `temporaryWorkspace` 视图键、临时空间会话的产物卡、会话列表文件迁移后的已迁移清单）。
  归档次序依赖 C 与 S1g（`s1g-composer-capabilities`）：三个 change 共改同一批条文（design D25 的重叠表，十三条），本 change 的同名 MODIFIED 以「主规格 → C → S1g」叠加后的文本为底，必须在两者之后归档；
  对 S1g 没有功能依赖——不使用它的 `write`、上传端点与附件。实现与归档次序 C → S1g → D。
- **不动**：拷入层既有文件、`web/src/ui/**` 冻结区、会话列表、输入框与能力栏、omp 进程的启动参数与托管布局、模型代理。
