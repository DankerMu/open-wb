## MODIFIED Requirements

### Requirement: 办公文档预览路由
预览监听器的 `GET /o/<token>/<path>` SHALL 以与 preview-origin「预览监听器」`/w/` 相同的次序校验令牌、空间根与路径（`resolve(op=read)`，越界 403 + 审计，不存在或非普通文件 404），随后：扩展名（小写）不是 `docx`、`xlsx`、`pptx` → 415；文件大小超过 `PREVIEW_DOCUMENT_MAX_BYTES` → 413（不启动转换）；转换器 `available` 为 `false` → 503；否则调用 `convert`，以请求连接的关闭作为其 `signal`。成功时 SHALL 对 `convert` 交回的缓存文件先 `lstat`，再以 workspaces「预览分类元数据与有界字节流」的 `openRegularFile` 打开并从该描述符发送（change sandbox-boundary-closure，owner B1/B5）：`lstat` 不是普通文件，或打开失败（文件在转换落定之后被周期清理删掉、被换成符号链接、命名管道或目录）→ 502 `文档转换失败，请下载后查看`，描述符已关闭、零字节读出；否则以 `Content-Type: application/pdf`、preview-origin「预览响应头与内容类型」对 PDF 规定的头返回缓存文件的完整字节，`Content-Length` 与 `Range` 区间以打开那一刻 `fstat` 的大小为准，并支持单段 `Range`（416 时描述符已关闭）。`PREVIEW_DOCUMENT_MAX_BYTES` 在服务端只由本路由执行：`/w/<token>/<path>` 对任何文件（含 `pdf`）都没有大小上限——它还要提供 HTML 页面引用的任意相对资源，持有令牌本就可以经它读到该空间的任何文件，按扩展名单独拦 `pdf` 不减少暴露面；PDF 的预览上限因此只是浏览器侧的呈现门槛，由页面按令牌响应的 `documentMaxBytes` 判定是否建 iframe（file-previewers「PDF 与办公文档」）。

失败 SHALL 为 `text/plain; charset=utf-8` 的固定文案，带 `nosniff`、`no-store`、`Referrer-Policy: no-referrer`：

| 情况 | 状态 | 正文 |
|---|---|---|
| 扩展名不是三种之一 | 415 | `该类型不支持转换` |
| 超过文档上限 | 413 | `文件超过预览上限，请下载后查看` |
| 转换器不可用（`unavailable`） | 503 | `服务器未启用文档转换，请下载后查看` |
| 排队已满（`busy`） | 503 | `文档转换繁忙，请稍后重试` |
| 转换失败（`failed`） | 502 | `文档转换失败，请下载后查看` |
| 超时（`timeout`） | 504 | `文档转换超时，请下载后查看` |

客户端在转换完成前断开时 SHALL 中止该次调用（`aborted`），不写任何响应。本路由 SHALL NOT 写审计（越界拒绝除外），SHALL NOT 在响应里出现输入路径、作业目录或子进程输出。主站的错误信封与 http-service-skeleton「统一错误信封」的 definition map 不因办公文档预览增加任何成员。

#### Scenario: 成功与缓存
- **WHEN** 注入一个记录调用的转换器替身，对 `/o/<T>/报告.docx` 请求两次，再带 `Range: bytes=0-9` 请求一次
- **THEN** 三次都得到 PDF：前两次 200、`Content-Type: application/pdf`、CSP 恰为 `frame-ancestors <E>`（不含 `sandbox`）、带 `nosniff`、`no-store`；第三次 206 且正文为前 10 字节；传给替身的输入是该文件在工作空间内的绝对路径

#### Scenario: 拒绝在转换之前
- **WHEN** 请求 `/o/<T>/readme.md`、`/o/<T>/doc.pdf`、超过文档上限的 `/o/<T>/huge.xlsx`、不存在的 `/o/<T>/gone.docx`、`/o/<T>/%2e%2e/x.docx`、未知令牌的 `/o/<x>/a.docx`；另以 `available:false` 的替身请求 `/o/<T>/a.docx`
- **THEN** 依次为 415、415、413、404、403（写一条 `sandbox.reject`）、404、503（`服务器未启用文档转换，请下载后查看`）；替身的 `convert` 一次都没有被调用

#### Scenario: 转换结果到状态码
- **WHEN** 替身的 `convert` 分别以 `failed`、`timeout`、`busy` 失败
- **THEN** 响应依次为 502 `文档转换失败，请下载后查看`、504 `文档转换超时，请下载后查看`、503 `文档转换繁忙，请稍后重试`，都是 `text/plain; charset=utf-8`，正文不含文件名与路径

#### Scenario: 转出的 PDF 在发送之前被换入
- **WHEN** 注入的转换器替身交回一个缓存 PDF 的路径，在路由的 `lstat` 之后、打开之前（测试钩子包裹 `fs.openSync`），该文件分别被换成一个没有写端的命名管道、一个指向另一文件的符号链接、一个目录
- **THEN** 三次都是 502 `文档转换失败，请下载后查看`、`text/plain; charset=utf-8`，正文不含路径与被链接文件的内容；命名管道与目录各被打开一次又关闭，符号链接没有打开成功；没有读出任何字节；命名管道一例在 1500ms 内返回；没有审计行

#### Scenario: 客户端断开即中止
- **WHEN** 替身的 `convert` 挂起期间客户端关闭连接
- **THEN** 传给 `convert` 的 `signal` 被中止；服务端没有为该请求写出任何响应字节，也没有未处理的拒绝
