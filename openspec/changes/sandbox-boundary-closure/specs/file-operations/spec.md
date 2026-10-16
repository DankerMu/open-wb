## MODIFIED Requirements

### Requirement: 下载
`GET /api/workspaces/:id/download?path=<rel>` SHALL 经 `resolve(op=read)` 后把一个普通文件的完整字节作为附件流式返回：`Content-Type: application/octet-stream`、`Content-Disposition: attachment; filename="<ASCII 回退名>"; filename*=UTF-8''<百分号编码的原文件名>`、`Content-Length: <大小>`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`。ASCII 回退名为把原文件名中 `0x20–0x7E` 之外的字符以及 `"`、`\` 各替换为 `_` 的结果；`filename*` 按 RFC 5987 对 UTF-8 字节做百分号编码。任何类型、任何大小的文件都可下载，不受预览上限约束；本端点 SHALL NOT 支持 `Range`（带 `Range` 的请求得到 200 完整正文）。目标不存在、是目录或不是普通文件 → 404；越界 → 403 + 审计；属他人或不存在的 `:id` → 404。

`lstat` 判为普通文件之后、写审计之前，路由 SHALL 先以 workspaces「预览分类元数据与有界字节流」的 `openRegularFile` 打开目标并 `fstat`（change sandbox-boundary-closure，owner B1/B5）：`lstat` 之后被换成符号链接、命名管道、目录、套接字或已被删除的目标 → 404 `not_found`，描述符已关闭、零字节读出、**没有** `file.download` 审计行。发送首字节之前 SHALL `emit` 审计 `{kind:"file.download", actorId, workspaceId, title:"下载 <path>", detail:{path, size}}`，其中 `size` 与响应的 `Content-Length` 都 SHALL 是打开那一刻 `fstat` 的大小（不是 `lstat` 的）；审计写入失败 SHALL 关闭描述符、为 500 且不发送任何文件字节。正文从该描述符读出；打开之后路径被删除或替换，不影响本次响应——审计行已写出的文件照常以已打开的 inode 完整发送，`Content-Length` 与 `detail.size` 仍是那次 `fstat` 的值（change sandbox-boundary-closure：此前这种删除会得到 500）；读流在发出头之后失败时连接被终止，不追加 JSON 信封（与 workspaces 预览流的既有语义一致）。

#### Scenario: 任意文件作为附件
- **WHEN** zhangsan 下载 `readme.md`、`archive.zip`、`page.html`、一个 30 MiB 的 `big.bin` 与名为 `季度 报告"v2".pdf` 的文件
- **THEN** 五次都是 200，字节与文件完全一致，`Content-Type` 都是 `application/octet-stream`，都带 `Content-Disposition: attachment`、`nosniff`、`no-store` 与精确的 `Content-Length`；最后一个的 `filename` 参数只含 ASCII 且没有未转义的引号，`filename*` 解码后等于原文件名；审计新增五行 `file.download`，`detail.path` 与 `detail.size` 与各文件相符

#### Scenario: 拒绝项
- **WHEN** 下载 `out`（目录）、`missing.md`、`../x`、缺少 `path`；lisi 下载 zhangsan 空间里的 `readme.md`；未登录的请求
- **THEN** 依次为 404、404、403（一条 `sandbox.reject`）、400、404、401；六种情况都没有 `file.download` 审计行

#### Scenario: 审计失败不发文件
- **WHEN** 审计写入被替换为抛错后下载 `readme.md`
- **THEN** 响应为 500、`no-store`，正文不含文件内容；文件被打开过一次且描述符已关闭，没有读出任何字节

#### Scenario: lstat 之后被换入的目标不下载也不审计
- **WHEN** 在路由对 `readme.md` 的 `lstat` 之后、打开之前（测试钩子包裹 `fs.openSync`），目标分别被换成一个没有写端的命名管道、一个指向另一账号文件的符号链接、一个目录
- **THEN** 三次都是 404 `not_found`、`no-store`，正文不含被链接文件的内容；没有 `file.download` 审计行；命名管道与目录各被打开一次又关闭，符号链接没有打开成功；没有读出任何字节；命名管道一例在 1500ms 内返回

#### Scenario: 大小以打开的 inode 为准
- **WHEN** 在路由对 1000 字节的 `big.bin` 的 `lstat` 之后、打开之前，文件被截短为 600 字节
- **THEN** 200，`Content-Length: 600`，正文恰 600 字节，`file.download` 审计行的 `detail.size` 为 600

#### Scenario: 不支持范围
- **WHEN** 带 `Range: bytes=0-9` 下载 100 字节的文件
- **THEN** 响应为 200、正文 100 字节、没有 `Content-Range`
