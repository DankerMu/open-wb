## MODIFIED Requirements

### Requirement: 预览分类元数据与有界字节流
`classifyPreview(absPath, name, size, options)` SHALL 只凭受信的文件名、大小与调用方传入的 `options` 判定，不做任何文件正文 IO；`options` 为 `{limits:{text,image,notebook}, sniffedText?:boolean}`，`limits` 由装配方给出（缺省 `1048576`、`20971520`、`10485760`，对应 `PREVIEW_TEXT_MAX_BYTES`、`PREVIEW_IMAGE_MAX_BYTES`、`PREVIEW_NOTEBOOK_MAX_BYTES`）。扩展名取文件名最后一个 `.` 之后并转小写；文件名没有 `.`，或唯一的 `.` 在开头（`.env`、`.gitignore`）时视为无扩展名。它 SHALL 返回 `{kind, contentType, truncated, limit, rangeable, headers}`，其中 `kind ∈ {text, image, audio, video, notebook}`，判定如下：

| 类别 | 扩展名（或文件名） | `contentType` | 上限 |
|---|---|---|---|
| `text` | `md` `txt` `log` `csv` `tsv` `json` `js` `mjs` `cjs` `jsx` `ts` `tsx` `html` `htm` `css` `scss` `py` `go` `rs` `java` `c` `h` `cpp` `sh` `sql` `yaml` `yml` `toml` `ini` `xml` `svg` `env`；文件名恰为 `Dockerfile` 或 `Makefile`；以及不在本表任何一行、且 `options.sniffedText === true` 的文件 | `text/plain; charset=utf-8` | `limit = min(size, limits.text)`，`size > limits.text` 时 `truncated` |
| `image` | `png`→`image/png`，`jpg`/`jpeg`→`image/jpeg`，`gif`→`image/gif`，`webp`→`image/webp`，`bmp`→`image/bmp`，`ico`→`image/x-icon` | 如左 | `size > limits.image` → `preview_too_large`；否则 `limit = size` |
| `audio` | `mp3`→`audio/mpeg`，`wav`→`audio/wav` | 如左 | 无；`limit = size`，`rangeable` |
| `video` | `mp4`→`video/mp4`，`webm`→`video/webm` | 如左 | 无；`limit = size`，`rangeable` |
| `notebook` | `ipynb` | `text/plain; charset=utf-8` | `size > limits.notebook` → `preview_too_large`（不截断：截断的 JSON 无法解析）；否则 `limit = size` |

`html`、`htm` 与 `svg` SHALL 永不以 `text/html`、`image/svg+xml` 或任何浏览器会当作文档渲染的类型返回。`pdf`、`docx`、`xlsx`、`pptx`、`zip`、`tar`、`gz`、`tgz` 不由本分类器提供正文（它们分别由 preview-origin、office-preview 与本规格「压缩包列表」提供），与其余未命中的名字一样 SHALL 抛出 canonical `HttpError("preview_unsupported")`；超限的图片与 Notebook SHALL 在打开正文之前抛出 `preview_too_large`。`headers` SHALL 含 `Content-Type`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store` 与十进制原始大小的 `X-Workbuddy-Size`；只有被截断的文本带 `X-Workbuddy-Truncated: 1`；`rangeable` 的类别另带 `Accept-Ranges: bytes`。

`sniffText(bytes)` SHALL 是纯函数：输入不含 `0x00` 字节，且去掉末尾至多 3 个属于一个未完整多字节序列的字节之后是合法 UTF-8 时返回 `true`；空输入返回 `true`；其余返回 `false`。`parseRange(header, size)` SHALL 是纯函数，只认单段 `bytes=<a>-<b>`、`bytes=<a>-` 与 `bytes=-<n>`（十进制、无空白）：返回闭区间 `{start, end}`（`end` 截到 `size-1`）；`a >= size`、`n` 为 0 或 `size` 为 0 时返回 `unsatisfiable`；多段、其它单位、无法解析或 `a > b` 时返回 `ignore`。`openPreviewStream(absPath, limit)` SHALL 至多产出 `limit` 个原始字节（0 为空输出），`openRangeStream(absPath, start, end)` SHALL 恰产出该闭区间的字节；二者都不整文件缓冲、不解码，读错误原样传播，并在完成、出错或销毁时释放文件资源。

#### Scenario: 文本精确阈值与安全元数据
- **WHEN** 以缺省上限分类并流式读取 0 字节文本、恰 1 MiB、1 MiB+1 与 1.5 MiB 的 `log`，以及跨截断点含多字节 UTF-8 的 `html`、`htm` 与 `svg`
- **THEN** 字节等于原文件的有界前缀，0 字节为空；只有大于 1 MiB 的带截断头，`X-Workbuddy-Size` 为精确原始大小；`html`、`htm`、`svg` 的 `contentType` 都是 `text/plain; charset=utf-8`；全部元数据来自分类器

#### Scenario: 新增的文本扩展名与文件名
- **WHEN** 分类 `a.py`、`A.YAML`、`b.tsv`、`c.scss`、`x.env`、`Dockerfile`、`Makefile`，以及 `dockerfile`（小写）、`notes.proto`、`LICENSE`、`.gitignore`，后四个分别以 `sniffedText` 为 `true`、未提供、`false` 各分类一次
- **THEN** 前七个都是 `text`；后四个在 `sniffedText === true` 时是 `text`，未提供或为 `false` 时抛 `preview_unsupported`；全程没有对 `absPath` 的任何读取

#### Scenario: 图片大小与无正文拒绝
- **WHEN** 以缺省上限分类恰 20 MiB 与 20 MiB+1 的 `gif`、一个真实的 PNG 与 JPEG、一个 `webp`、一个 `ico`、一个 `zip`、恰 10 MiB 与 10 MiB+1 的 `ipynb`、一个 5 GiB 的 `mp4`、一个 `wav`；另以 `limits.image = 1024` 分类 2 KiB 的 `png`
- **THEN** 恰 20 MiB 的 `gif` 为 `image/gif`、`limit = size`；20 MiB+1 抛 `preview_too_large`；PNG 与 JPEG 的字节经流读出后与原文件完全一致、类型为 `image/png` 与 `image/jpeg` 并带安全头与大小头；`webp`、`ico` 为 `image/webp`、`image/x-icon`；`zip` 抛 `preview_unsupported`；被拒绝的分类都发生在打开或读取正文之前，不产生部分成功的响应；恰 10 MiB 的 `ipynb` 为 `notebook`、不截断，10 MiB+1 抛 `preview_too_large`；`mp4` 为 `video/mp4`、`rangeable`、头含 `Accept-Ranges: bytes`、不抛错；`wav` 为 `audio/wav`；改小上限后的 `png` 抛 `preview_too_large`

#### Scenario: 由别处提供与不支持
- **WHEN** 分类 `a.pdf`、`b.docx`、`c.xlsx`、`d.pptx`、`e.zip`、`f.tar`、`g.tar.gz`、`h.tgz`、`i.exe`，其中任何一个即使带 `sniffedText: true`
- **THEN** 都抛 `preview_unsupported`，没有正文被打开

#### Scenario: 嗅探与范围解析
- **WHEN** 对空输入、纯 ASCII、末尾截在一个三字节汉字第二个字节处的 UTF-8、含一个 `0x00` 的输入、GBK 编码的中文、PNG 文件头调用 `sniffText`；对 `size = 1000` 以 `bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=990-2000`、`bytes=1000-`、`bytes=-0`、`bytes=5-2`、`bytes=0-1,5-6`、`items=0-1`、`bytes= 0-1` 调用 `parseRange`
- **THEN** `sniffText` 依次为 `true`、`true`、`true`、`false`、`false`、`false`；`parseRange` 依次为 `{0,99}`、`{900,999}`、`{900,999}`、`{990,999}`、`unsatisfiable`、`unsatisfiable`、`ignore`、`ignore`、`ignore`、`ignore`

#### Scenario: 流关闭和错误
- **WHEN** 一个被允许的流（有界前缀或闭区间）被读完、在读完之前被销毁、或遇到真实的文件系统读 / 打开错误
- **THEN** 完成、关闭与错误遵循原生 `Readable` 的行为，文件描述符被释放；`openRangeStream(path, 10, 19)` 恰产出第 10–19 字节；不存在把错误静默变成空输出的回退

### Requirement: 文件预览
`GET /api/workspaces/:id/file?path=<rel>` SHALL 经 `resolve(op=read)` 后：目标不存在或不是普通文件 → 404。随后按「预览分类元数据与有界字节流」判定；仅当文件名不在该条文表格的任何一行、也不在「由别处提供」的集合里时，路由 SHALL 先读取文件的前至多 8192 字节交给 `sniffText`，把结果作为 `sniffedText` 传给分类器——这是本路由在分类之前唯一的正文读取，已知扩展名的文件不发生。分类抛出的 `preview_unsupported` → 415，`preview_too_large` → 413，二者都不发送任何正文。

成功响应 SHALL 带分类器给出的全部头。`text` 与 `notebook` 以 `text/plain; charset=utf-8` 流式返回（`text` 超过文本上限时只返回前 `limit` 字节并带 `X-Workbuddy-Truncated: 1`）；`image` 以其 `image/*` 返回完整字节；空文件（0 字节）SHALL 200 空体且 `X-Workbuddy-Size: 0`。`audio` 与 `video` SHALL 支持单段范围请求：请求带 `Range` 且 `parseRange` 得到区间时，响应为 206，带 `Content-Range: bytes <start>-<end>/<size>`、`Content-Length` 为区间长度、`Accept-Ranges: bytes`，正文恰为该区间；得到 `unsatisfiable` 时为 416，带 `Content-Range: bytes */<size>`、空体（416 不属于 http-service-skeleton「统一错误信封」的 definition map，不带 JSON 信封）；得到 `ignore` 或请求不带 `Range` 时为 200 完整正文并带 `Content-Length`。其余类别 SHALL 忽略 `Range`。各上限来自装配方给出的 `limits`，路由自身不读环境变量。

#### Scenario: 文本、截断与 html
- **WHEN** 请求 `readme.md`（2 KB）、`big.log`（1.5 MiB）、`page.html`、`logo.svg`
- **THEN** `readme.md` 为 200 精确字节 + `text/plain; charset=utf-8` + `nosniff`；`big.log` 为 200 恰 1048576 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 1572864`；`page.html` 与 `logo.svg` 的 `content-type` 都是 `text/plain; charset=utf-8`

#### Scenario: 未知与无扩展名文件的嗅探
- **WHEN** 请求内容为 UTF-8 文本的 `LICENSE`、`.gitignore`、`schema.proto`，内容含 `0x00` 的 `blob.bin` 与无扩展名的 `core`，以及 0 字节的 `empty`
- **THEN** 前三个与 `empty` 为 200 `text/plain; charset=utf-8`（`empty` 为空体、`X-Workbuddy-Size: 0`）；`blob.bin` 与 `core` 为 415 `preview_unsupported`；对已知扩展名的 `readme.md` 请求不发生嗅探读取

#### Scenario: 图片与拒绝
- **WHEN** 请求 `logo.png`、`anim.gif`、`pic.webp`、21 MiB 的 `huge.png`、`doc.pdf`、`deck.pptx`、`archive.zip`、`out`（目录）
- **THEN** 依次为 200 `image/png` 精确字节、200 `image/gif`、200 `image/webp`、413 `preview_too_large`、415、415、415 `preview_unsupported`、404 `not_found`

#### Scenario: 音视频的范围请求
- **WHEN** 对 1000 字节的 `clip.mp4` 分别不带 `Range`、带 `Range: bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=1000-`、`bytes=0-1,5-6` 请求；对 `readme.md` 带 `Range: bytes=0-9` 请求
- **THEN** 依次为 200（1000 字节、`video/mp4`、`Accept-Ranges: bytes`）、206（`Content-Range: bytes 0-99/1000`、100 字节且等于文件前 100 字节）、206（`bytes 900-999/1000`）、206（`bytes 900-999/1000`）、416（`Content-Range: bytes */1000`、空体）、200（完整正文）；`readme.md` 为 200 完整正文、无 `Content-Range`；所有响应都带 `nosniff` 与 `no-store`

#### Scenario: Notebook 与可配置上限
- **WHEN** 请求 3 KB 的 `a.ipynb` 与 11 MiB 的 `big.ipynb`；另以 `limits.text = 16` 装配后请求 20 字节的 `t.txt`
- **THEN** `a.ipynb` 为 200 `text/plain; charset=utf-8` 精确字节、无截断头；`big.ipynb` 为 413 `preview_too_large`；`t.txt` 为 200 恰 16 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 20`

### Requirement: 工作空间 HTTP 集成边界
registerWorkspaces(app,{store,sandbox,audit}) SHALL consume one canonical preconstructed store, facade and same-db bound synchronous audit emitter. Since change s1f-files-page the dependency object additionally accepts preconstructed `limits` (the preview limits, defaulting to the spec defaults when omitted), `trash` (file-operations) and optional `preview` (preview-origin); the routes those capabilities and「压缩包列表」add under `/api/workspaces/:id/` SHALL obey every rule of this requirement: guard-bound principal, earliest route-local no-store for all matched outcomes, identical 404 for foreign/missing ids before their paths are inspected and without audit or filesystem changes, a required scalar `path` (or body field) with a repeated `path` → 400. It SHALL use guard-bound principal and earliest route-local no-store for all matched outcomes. It SHALL NOT read configuration, duplicate store/domain validation or wire production bootstrap. POST body shapes SHALL reject wrong types/extra fields, nonJSON and >16KiB as canonical400. Tree default path SHALL be empty; file path SHALL be a required scalar string; repeated path SHALL be400. Typed foreign/missing scoped IDs SHALL be404 before inspecting their paths, without audit or filesystem changes. Structurally absent owned roots/targets/parents SHALL be404, not fake sandbox denials. Directory creation SHALL check existing immediate parent/absent target before calling the canonical helper, then emit dir.create with detail.path and return201 only after emission. Failed creation/emission SHALL be generic500; filesystem rollback is not promised for dir creation failures.

#### Scenario: 完整真实装配与隔离
- WHEN two authenticated accounts use collection GET/POST and the three scoped routes on owned, foreign and missing IDs, including unsafe typed paths
- THEN collection ownership follows the principal, only scoped owned paths can access FS, and foreign/missing scoped responses are identical404 with no audit/FS delta
- WHEN an unauthenticated request or malformed/nonJSON/oversized body reaches one of these routes
- THEN guard/parser/domain precedence returns canonical401/400 and no-store before handler effects

#### Scenario: 原始路径与结构不存在
- WHEN a decoded path contains duplicate slashes/dot components or percent-literal names, or descends below an ordinary file
- THEN the original string reaches resolver once without extra decoding/normalization; safe existing paths return the same path string, while ordinary-file descendants are404 without sandbox.reject
- WHEN an owned workspace root is missing or an immediate mkdir parent is absent/non-directory
- THEN the response is404, no roots/parents are created, and no rejection audit is fabricated

#### Scenario: 审计失败不伪成功
- WHEN genuine SQLite audit insertion fails on a sandbox denial or after successful mkdir
- THEN response is sanitized500/no-store, no false403/201 is returned; rejected access remains denied, while the mkdir directory may remain without an event
- WHEN workspace store ROLLBACK itself fails
- THEN response is sanitized500/no-store, not success; the store's documented active/uncommitted residual state is not silently committed or represented as clean

#### Scenario: 流错误与真实客户端中止
- WHEN a native preview stream fails before sending headers, or a real HTTP client aborts an ongoing preview
- THEN error handling emits sanitized500/no-store before headers where possible, and Fastify destroys the aborted stream and releases its descriptor without a lingering request
- WHEN a stream fails after headers are sent
- THEN the response connection terminates; the server does not send a fabricated second JSON envelope

#### Scenario: 新增路由沿用同一边界
- **WHEN** 两个已认证账号对自己的、他人的与不存在的工作空间 id 请求 `archive`、`download`、`DELETE entries`、`move` 与 `preview-token`，其中对他人与不存在的 id 的请求带越界路径；另有未认证请求与重复的 `path` 查询参数
- **THEN** 他人与不存在的 id 一律是相同的 404，没有审计行与文件系统变化（越界路径没有被检查）；未认证为 401；重复 `path` 为 400；所有这些响应都带 `Cache-Control: no-store`

## ADDED Requirements

### Requirement: 压缩包列表
`GET /api/workspaces/:id/archive?path=<rel>` SHALL 经 `resolve(op=read)` 后只读取压缩包的目录结构并返回 200 `{format, entries:[{path, type:'file'|'dir', size}], truncated}`，`no-store`；它 SHALL NOT 解压任何成员的内容、SHALL NOT 向文件系统写入任何东西。目标不存在或不是普通文件 → 404。按文件名（小写）判定格式：以 `.zip` 结尾 → `zip`；以 `.tar` 结尾 → `tar`；以 `.tar.gz` 或 `.tgz` 结尾 → `tar.gz`；其它以 `.gz` 结尾 → `gz`；都不是 → 415 `preview_unsupported`。

- `zip`：只读中央目录；`size` 为成员的未压缩大小；名字以 `/` 结尾的成员为 `dir`。
- `tar` 与 `tar.gz`（后者经流式 gunzip）：按 512 字节的头逐块读取，SHALL 认 ustar 的 `name` 与 `prefix`、GNU 长文件名记录（类型 `L`）与 pax 扩展头里的 `path` 记录；成员的正文一律跳过不读（未压缩的 `tar` 以定位跳过，`tar.gz` 以丢弃解压出的字节跳过）；类型为目录的成员为 `dir`，其它（含符号链接、设备等）为 `file`；`size` 取头里的大小。
- `gz`：恰一项，`path` 为去掉结尾 `.gz` 的文件名，`type:'file'`，`size:null`。

`entries` 按包内出现的次序，至多 `PREVIEW_ARCHIVE_MAX_ENTRIES`（缺省 1000）项：读到上限即停止读取并置 `truncated:true`；`tar` 与 `tar.gz` 都另有 5 秒的读取时限（时钟可注入），到时返回已读到的项并置 `truncated:true`。为取得成员名而读入内存的内容 SHALL 有硬上限（凡长度由头部字段**声明**的，按声明的长度在读取之前判定，见下）：单个扩展记录（GNU 类型 `L` 的长文件名记录、pax 扩展头）的声明长度至多 65536 字节，单个成员名（`zip` 中央目录里的成员名、ustar `prefix` 与 `name` 的拼接、`L` 记录或 pax `path` 给出的名字）至多 4096 字节；任一超出时，该记录或该成员 SHALL NOT 计入结果，并按「读出若干项之后才损坏」处理——立即停止读取，返回已读到的项并置 `truncated:true`，此前一项都没读出时为 415 `preview_unsupported`。凡长度由头部字段声明的（`L` 记录与 pax 扩展头的 `size` 字段），SHALL 在读入其内容之前按声明长度判定，超出即不读；成员名随所在记录一起读入的（`zip` 中央目录的成员名——中央目录项的各变长字段长度都是 2 字节，读入量以此为界；未超 65536 字节的 pax 记录里的 `path`；ustar `prefix` 与 `name` 的拼接）可在读入后判定，4096 字节的上限同样适用。`tar` 与 `tar.gz` 里为成员名与扩展记录做的单次读取因此都不超过 65536 字节；处理一个压缩包占用的内存有固定上界，与包内 4 字节或更宽的长度字段声明的任何长度无关。成员名 SHALL 原样作为 JSON 字符串返回（不合法的 UTF-8 序列替换为 U+FFFD），不做路径规范化、不与文件系统交互——含 `..` 或以 `/` 开头的成员名只是数据。包损坏到一项都读不出时 → 415 `preview_unsupported`；读出若干项之后才损坏时返回已读到的项并置 `truncated:true`。属他人或不存在的 `:id` → 404；越界路径 → 403 `sandbox_denied` + 审计。

#### Scenario: 三种格式的列表
- **WHEN** 请求一个含 `a.txt`（5 字节）、`dir/`、`dir/b.md`（7 字节）的 `x.zip`，同样内容的 `x.tar`、`x.tar.gz`、`x.tgz`，以及 `notes.txt.gz`
- **THEN** 前四个的 `entries` 都恰为 `[{path:"a.txt",type:"file",size:5},{path:"dir/",type:"dir",size:0},{path:"dir/b.md",type:"file",size:7}]`、`truncated:false`，`format` 依次为 `zip`、`tar`、`tar.gz`、`tar.gz`；`notes.txt.gz` 为 `{format:"gz",entries:[{path:"notes.txt",type:"file",size:null}],truncated:false}`；请求前后工作空间与临时目录里没有新增文件

#### Scenario: 上限与长文件名
- **WHEN** 请求含 1500 个成员的 `big.zip` 与 `big.tar.gz`；另以上限 3 装配后请求含 5 个成员的 `x.tar`；一个 tar 含一个 200 字符路径的成员（GNU 长文件名记录）与一个经 pax `path` 记录给出中文路径的成员
- **THEN** 前两个各恰 1000 项、`truncated:true`；第三个恰 3 项、`truncated:true`；长路径与中文路径完整出现在 `path` 里

#### Scenario: 声明超大的长文件名记录
- **WHEN** 请求 `evil.tar`（整个文件 1 KiB，第一个头是类型 `L` 的记录、其 `size` 字段声明 4 GiB）；`evil2.tar`（两个正常成员之后是一个声明 1 GiB 的 pax 扩展头）；`long.zip`（两个正常成员之后是一个成员名 5000 字节的成员）；`long2.tar`（一个正常成员之后是一个 `L` 记录给出 5000 字节名字的成员）；另以注入的时钟请求一个未压缩的 `slow.tar`，时钟在读出第 3 项之后越过 5 秒
- **THEN** 依次为 415 `preview_unsupported`、200 恰两项 + `truncated:true`、200 恰两项 + `truncated:true`、200 恰一项 + `truncated:true`、200 恰三项 + `truncated:true`；五例都在有界时间内返回；四个 tar 用例里为成员名与扩展记录做的单次读取都不超过 65536 字节（以注入的读取函数记录的最大读取长度为证），`entries` 里没有超过 4096 字节的 `path`

#### Scenario: 恶意成员名只是数据
- **WHEN** 压缩包的成员名为 `../../etc/passwd`、`/abs/x` 与含 `<script>` 的字符串
- **THEN** 它们原样出现在 `entries[].path` 里；服务端没有访问这些路径，工作空间外没有任何读写

#### Scenario: 拒绝与损坏
- **WHEN** 请求 `readme.md`、`out`（目录）、不存在的 `gone.zip`、内容不是 zip 的 `fake.zip`、头部完好但中途被截断的 `cut.tar`、`path=../x.zip`，以及他人工作空间里的 `x.zip`
- **THEN** 依次为 415、404、404、415、200（已读到的项 + `truncated:true`）、403 `sandbox_denied`（写一条 `sandbox.reject` 审计）、404
