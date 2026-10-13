## MODIFIED Requirements

### Requirement: 预览头、下载与不可预览的呈现
选中任何文件时，预览头 SHALL 显示文件图标、空间内路径、大小与修改时间（`formatMtime`，查看者本地时区 `YYYY-MM-DD HH:mm`；这两项取自树条目，条目没有它们时——workspace-sidebar「本会话改动标记与过滤」里父目录未加载的行——这一段整个不显示，SHALL NOT 以 `0`、`—` 或其它占位值代替，#1372），以及一个下载链接：accessible name `下载 <文件名>`，`href` 为 `/api/workspaces/<id>/download?path=<编码后的路径>`，带 `download` 属性——所有文件都有它，包括不支持预览、超限、预览失败与预览器加载失败的文件。下载由浏览器直接导航完成，页面 SHALL NOT 经 `fetch` 读取下载内容。

不可预览的各种情况 SHALL 在预览区就地显示，并都保留预览头：

| 情况 | 文案 |
|---|---|
| 服务端 415（不是文本的未知类型） | `该类型不支持预览`，副行 `<文件名> · <大小>` |
| 服务端 413（图片、Notebook 超限）或文档大小超过令牌响应的 `documentMaxBytes` | `文件过大，无法预览`，副行 `<文件名> · <大小>` |
| 文本被截断 | 正文照常显示，其上一行 `文件超过预览上限，仅显示开头部分 · 共 <大小>` |
| 其它非 401 的 `ApiError` | 信封 message |
| 网络失败或非法响应 | 既有的 request_failed 安全文案 |

大小未知时，上表副行与截断提示里带大小的那一段（` · <大小>`、` · 共 <大小>`）省去，其余不变。选中的行没有树条目的元数据而 `file` 或 `archive` 应答 404 时，预览区显示 `文件不存在`（workspace-sidebar「本会话改动标记与过滤」）；有元数据的行应答 404 时仍按上表显示信封 message。

401 交由认证守卫，不显示页面内错误。错误与不支持态 SHALL NOT 使用 Toast。切换文件、切换工作空间、卸载时 SHALL 中止在途的预览请求，迟到的响应不提交状态；`fetchPreview` 分配的图片 Blob 地址在被替换、卸载与迟到结果被丢弃时释放。

#### Scenario: 每个文件都能下载
- **WHEN** 依次选中 `readme.md`、`blob.bin`（415）、21 MiB 的 `huge.png`（413）与 `archive.zip`
- **THEN** 每次预览头里都有名为 `下载 <文件名>` 的链接，`href` 恰为该文件的 download 地址且带 `download` 属性；`blob.bin` 显示 `该类型不支持预览`，`huge.png` 显示 `文件过大，无法预览`；页面没有对 download 地址发起 `fetch`

#### Scenario: 截断提示
- **WHEN** 选中 1.5 MiB 的 `big.log`（响应带截断头与 `X-Workbuddy-Size: 1572864`）
- **THEN** 显示源码与一行 `文件超过预览上限，仅显示开头部分 · 共 1.5 MB`

#### Scenario: 请求归属与资源释放
- **WHEN** 选中一张图片后在响应返回前切到另一个文件；或图片显示后切换工作空间；或页面卸载（含 StrictMode 的二次挂载）
- **THEN** 迟到的图片不显示，其 Blob 地址被释放；每个分配过的 Blob 地址在失去归属时都被释放（出错的图片其地址可被释放两次，见「图片」一条）

#### Scenario: 没有元数据的行
- **WHEN** 选中一个没有大小与修改时间的 `deep/x.md` 行，`file` 返回其文本；另一例同样的行 `deep/blob.bin`，`file` 返回 415；再一例同样的行 `deep/y.md`，`file` 返回 404
- **THEN** 三例的预览头都有图标、路径与下载链接，都没有大小与修改时间那一段，页面上没有 `NaN`、`undefined` 或 `1970` 字样；第一例正文照常；第二例显示 `该类型不支持预览`，副行恰为 `blob.bin`；第三例显示 `文件不存在`

### Requirement: PDF 与办公文档
PDF SHALL 以不带 `sandbox` 属性的 `iframe`（`title` 为文件名）从 `base` 加载，交给浏览器自带的查看器。办公文档（`docx`、`xlsx`、`pptx`）SHALL 以同样的 `iframe` 从 `officeBase` 加载（服务端转成 PDF）；在 iframe 的 `load` 事件之前预览区 SHALL 盖一层 `正在转换文档…`（`role="status"`），`load` 之后撤掉——转换失败时 iframe 里是服务端的失败说明页。建 iframe 之前 SHALL 依次判定：树条目的大小超过 `documentMaxBytes` → 显示 `文件过大，无法预览`，不建 iframe（树条目没有大小时跳过这一项，框内显示预览来源自己的应答，#1372）；办公文档且 `officeAvailable` 为 `false` → 显示 `服务器未启用文档转换，请下载后查看`，不建 iframe；`navigator.pdfViewerEnabled === false` → 显示 `此浏览器不支持内嵌 PDF 预览，请下载后查看`，不建 iframe。三种情况都保留预览头的下载链接。

#### Scenario: PDF 的嵌入
- **WHEN** 选中 2 MB 的 `doc.pdf`
- **THEN** 预览区有一个 `iframe`，`src` 为 `<base>doc.pdf`，没有 `sandbox` 属性，`title` 为 `doc.pdf`

#### Scenario: 办公文档的嵌入与转换提示
- **WHEN** 选中 `plan.docx`，`officeAvailable` 为 `true`；随后 iframe 触发 `load`
- **THEN** iframe 的 `src` 为 `<officeBase>plan.docx`、没有 `sandbox` 属性；`load` 之前可见 `正在转换文档…`，之后不可见

#### Scenario: 不建 iframe 的三种情况
- **WHEN** 选中 150 MB 的 `huge.pdf`（`documentMaxBytes` 为 104857600）；`officeAvailable` 为 `false` 时选中 `a.xlsx`；`navigator.pdfViewerEnabled` 为 `false` 时选中 `doc.pdf`
- **THEN** 依次显示 `文件过大，无法预览`、`服务器未启用文档转换，请下载后查看`、`此浏览器不支持内嵌 PDF 预览，请下载后查看`；三者都没有 `iframe`，都有下载链接

#### Scenario: 大小未知的文档
- **WHEN** 选中一个没有大小的 `deep/doc.pdf` 行（`navigator.pdfViewerEnabled` 不为 `false`）
- **THEN** 预览区有一个 `iframe`，`src` 为 `<base>deep/doc.pdf`；没有显示 `文件过大，无法预览`；预览头有下载链接
