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

`html`、`htm` 与 `svg` SHALL 永不以 `text/html`、`image/svg+xml` 或任何浏览器会当作文档渲染的类型返回。`pdf`、`docx`、`xlsx`、`pptx`、`zip`、`tar`、`gz`、`tgz` 不由本分类器提供正文（它们分别由 preview-origin、office-preview 与本规格「压缩包列表」提供），与其余未命中的名字一样 SHALL 抛出 canonical `HttpError("preview_unsupported")`；超限的图片与 Notebook SHALL 在读出任何正文字节之前抛出 `preview_too_large`（分类器自身不做 IO；路由为取权威大小已打开的描述符在分类抛出时随即关闭，见「文件预览」）。`headers` SHALL 含 `Content-Type`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store` 与十进制原始大小的 `X-Workbuddy-Size`；只有被截断的文本带 `X-Workbuddy-Truncated: 1`；`rangeable` 的类别另带 `Accept-Ranges: bytes`。

`sniffText(bytes)` SHALL 是纯函数：输入不含 `0x00` 字节，且去掉末尾至多 3 个属于一个未完整多字节序列的字节之后是合法 UTF-8 时返回 `true`；空输入返回 `true`；其余返回 `false`。`parseRange(header, size)` SHALL 是纯函数，只认单段 `bytes=<a>-<b>`、`bytes=<a>-` 与 `bytes=-<n>`（十进制、无空白）：返回闭区间 `{start, end}`（`end` 截到 `size-1`）；`a >= size`、`n` 为 0 或 `size` 为 0 时返回 `unsatisfiable`；多段、其它单位、无法解析或 `a > b` 时返回 `ignore`。两个读流 helper 接受的是**已打开的描述符**，不是路径（change sandbox-boundary-closure，owner B1/B5）：调用方先经 `openRegularFile(absPath)`（`server/src/workspaces/regular-file.ts`，所有读路由共用）以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开目标并对描述符 `fstat`——`ENOENT` / `ENOTDIR`（条目已不在）、`ELOOP`（末段是符号链接）、`ENXIO` 与 `EOPNOTSUPP`（末段是套接字；后者按 errno 数值识别）以及打开成功但 `fstat` 不是普通文件（命名管道、目录、设备——命名管道在 `O_NONBLOCK` 下会立即打开成功，靠这一步拒绝）一律关闭描述符并抛 canonical `HttpError("not_found")`，其它 `open` 错误原样抛；返回 `{fd, size}`，`size` 取自同一次 `fstat`。`openPreviewStream({fd}, limit)` SHALL 至多产出 `limit` 个原始字节——`limit` 为 0 时 SHALL 关闭 `fd` 并返回空输出而不开流，否则以 `createReadStream(null, {fd, start: 0, end: limit - 1, autoClose: true})` 读；`openRangeStream({fd}, start, end)` SHALL 恰产出该闭区间的字节（`createReadStream(null, {fd, start, end, autoClose: true})`）；二者都不整文件缓冲、不解码、不再按路径打开任何东西，读错误原样传播，并在完成、出错或销毁时关闭该描述符。`sendFileRange(request, reply, {fd, size, headers, unsatisfiableHeaders})` 的 `size` SHALL 是那次 `fstat` 的值：416 时 SHALL 关闭 `fd`、空体；`HEAD` 时 SHALL 关闭 `fd`、给空流；其余把 `fd` 交给流。lstat 的大小 SHALL NOT 再出现在任何响应头里。

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
- **WHEN** 分类 `a.pdf`、`b.docx`、`c.xlsx`、`d.pptx`、`e.zip`、`f.tar`、`g.tar.gz`、`h.tgz`，其中任何一个即使带 `sniffedText: true`；以及分类 `i.exe` 而 `sniffedText` 未提供或为 `false`
- **THEN** 都抛 `preview_unsupported`，没有正文被打开

#### Scenario: 嗅探与范围解析
- **WHEN** 对空输入、纯 ASCII、末尾截在一个三字节汉字第二个字节处的 UTF-8、含一个 `0x00` 的输入、GBK 编码的中文、PNG 文件头调用 `sniffText`；对 `size = 1000` 以 `bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=990-2000`、`bytes=1000-`、`bytes=-0`、`bytes=5-2`、`bytes=0-1,5-6`、`items=0-1`、`bytes= 0-1` 调用 `parseRange`
- **THEN** `sniffText` 依次为 `true`、`true`、`true`、`false`、`false`、`false`；`parseRange` 依次为 `{0,99}`、`{900,999}`、`{900,999}`、`{990,999}`、`unsatisfiable`、`unsatisfiable`、`ignore`、`ignore`、`ignore`、`ignore`

#### Scenario: 流关闭和错误
- **WHEN** 一个被允许的流（有界前缀或闭区间）被读完、在读完之前被销毁、或遇到真实的文件系统读 / 打开错误
- **THEN** 完成、关闭与错误遵循原生 `Readable` 的行为，传入的描述符被关闭；`openRangeStream({fd}, 10, 19)` 恰产出第 10–19 字节；`openPreviewStream({fd}, 0)` 不开流、返回空输出且描述符已关闭；不存在把错误静默变成空输出的回退

#### Scenario: 打开只认普通文件
- **WHEN** 对一个普通文件、一个命名管道（没有写端）、一个目录、一个指向普通文件的符号链接、一个已不存在的路径、一个 Unix 套接字各调一次 `openRegularFile`
- **THEN** 第一个返回 `{fd, size}` 且 `size` 等于文件大小；命名管道与目录各打开过一次、随即关闭、抛 `not_found`，命名管道一例在 1500ms 内返回；符号链接、不存在、套接字三例没有描述符留下、抛 `not_found`；没有任何字节被读出

### Requirement: 文件预览
`GET /api/workspaces/:id/file?path=<rel>` SHALL 经 `resolve(op=read)` 后：目标不存在或不是普通文件（`lstat`，不跟随符号链接）→ 404，不打开任何东西。随后 SHALL 以「预览分类元数据与有界字节流」的 `openRegularFile` 打开目标：`lstat` 之后被换成符号链接、命名管道、目录、套接字或已被删除的目标同样 → 404 `not_found`（不是 `sandbox_denied`、不写审计），描述符已关闭、零字节读出；此后分类、文本上限、截断头、`X-Workbuddy-Size`、`Content-Length` 与 `Range` 区间用的大小 SHALL 全部是打开那一刻 `fstat` 的 `size`，正文从该描述符读出——`lstat` 之后被截短或追加的文件按打开的 inode 应答，声明的长度与发出的字节一致。分类抛出（415 / 413）时 SHALL 关闭该描述符，零字节读出；已知扩展名的文件因此每次请求恰被打开一次（为流），未知扩展名的嗅探 SHALL 从同一个描述符读前至多 8192 字节、不再按路径二次打开。随后按「预览分类元数据与有界字节流」判定；仅当文件名不在该条文表格的任何一行、也不在「由别处提供」的集合里时，路由 SHALL 先读取文件的前至多 8192 字节交给 `sniffText`，把结果作为 `sniffedText` 传给分类器——这是本路由在分类之前唯一的正文读取，已知扩展名的文件不发生。分类抛出的 `preview_unsupported` → 415，`preview_too_large` → 413，二者都不发送任何正文。

成功响应 SHALL 带分类器给出的全部头。`text` 与 `notebook` 以 `text/plain; charset=utf-8` 流式返回（`text` 超过文本上限时只返回前 `limit` 字节并带 `X-Workbuddy-Truncated: 1`）；`image` 以其 `image/*` 返回完整字节；空文件（0 字节）SHALL 200 空体且 `X-Workbuddy-Size: 0`。`audio` 与 `video` SHALL 支持单段范围请求：请求带 `Range` 且 `parseRange` 得到区间时，响应为 206，带 `Content-Range: bytes <start>-<end>/<size>`、`Content-Length` 为区间长度、`Accept-Ranges: bytes`，正文恰为该区间；得到 `unsatisfiable` 时为 416，带 `Content-Range: bytes */<size>`、空体（416 不属于 http-service-skeleton「统一错误信封」的 definition map，不带 JSON 信封）；得到 `ignore` 或请求不带 `Range` 时为 200 完整正文并带 `Content-Length`。其余类别 SHALL 忽略 `Range`。各上限来自装配方给出的 `limits`，路由自身不读环境变量。

#### Scenario: 文本、截断与 html
- **WHEN** 请求 `readme.md`（2 KB）、`big.log`（1.5 MiB）、`page.html`、`logo.svg`
- **THEN** `readme.md` 为 200 精确字节 + `text/plain; charset=utf-8` + `nosniff`；`big.log` 为 200 恰 1048576 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 1572864`；`page.html` 与 `logo.svg` 的 `content-type` 都是 `text/plain; charset=utf-8`

#### Scenario: 未知与无扩展名文件的嗅探
- **WHEN** 请求内容为 UTF-8 文本的 `LICENSE`、`.gitignore`、`schema.proto`，内容含 `0x00` 的 `blob.bin` 与无扩展名的 `core`，以及 0 字节的 `empty`
- **THEN** 前三个与 `empty` 为 200 `text/plain; charset=utf-8`（`empty` 为空体、`X-Workbuddy-Size: 0`）；`blob.bin` 与 `core` 为 415 `preview_unsupported`；对已知扩展名的 `readme.md` 请求不发生嗅探读取；被嗅探的文件每次请求只被打开一次，嗅探与流读的是同一个描述符

#### Scenario: 图片与拒绝
- **WHEN** 请求 `logo.png`、`anim.gif`、`pic.webp`、21 MiB 的 `huge.png`、`doc.pdf`、`deck.pptx`、`archive.zip`、`out`（目录）
- **THEN** 依次为 200 `image/png` 精确字节、200 `image/gif`、200 `image/webp`、413 `preview_too_large`、415、415、415 `preview_unsupported`、404 `not_found`；413 与三个 415 各把文件同步打开过一次又关闭、没有读出任何字节；目录一例没有打开任何东西；每个 200 恰一次同步打开（流的），没有按路径的异步打开

#### Scenario: 音视频的范围请求
- **WHEN** 对 1000 字节的 `clip.mp4` 分别不带 `Range`、带 `Range: bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=1000-`、`bytes=0-1,5-6` 请求；对 `readme.md` 带 `Range: bytes=0-9` 请求
- **THEN** 依次为 200（1000 字节、`video/mp4`、`Accept-Ranges: bytes`）、206（`Content-Range: bytes 0-99/1000`、100 字节且等于文件前 100 字节）、206（`bytes 900-999/1000`）、206（`bytes 900-999/1000`）、416（`Content-Range: bytes */1000`、空体）、200（完整正文）；`readme.md` 为 200 完整正文、无 `Content-Range`；所有响应都带 `nosniff` 与 `no-store`

#### Scenario: lstat 之后目标被换入
- **WHEN** 在路由对 `readme.md`（文本流路径）与 `clip.mp4`（带 `Range: bytes=0-99` 的范围路径）的 `lstat` 之后、打开之前（测试钩子包裹 `fs.openSync`），目标分别被换成：一个没有写端的命名管道；一个指向沙箱内另一账号文件的符号链接；一个目录
- **THEN** 六次都是 404 `not_found` 信封、`no-store`，正文不含被链接文件的内容；命名管道与目录各被打开一次又关闭，符号链接一次都没有打开成功；没有以这些描述符开流，没有读出任何字节；命名管道一例在 1500ms 内返回；审计表没有新增行

#### Scenario: 大小以打开的 inode 为准
- **WHEN** 在路由对 1000 字节的 `clip.mp4` 的 `lstat` 之后、打开之前，文件被截短为 600 字节；另一例在 `lstat` 之后被追加到 1400 字节；各不带 `Range` 请求一次，再对截短的那个带 `Range: bytes=900-` 请求一次
- **THEN** 前两次都是 200，`Content-Length` 与 `X-Workbuddy-Size` 分别为 600 与 1400、正文恰为对应字节；第三次为 416、`Content-Range: bytes */600`，文件被打开过一次并已关闭、没有读出字节

#### Scenario: Notebook 与可配置上限
- **WHEN** 请求 3 KB 的 `a.ipynb` 与 11 MiB 的 `big.ipynb`；另以 `limits.text = 16` 装配后请求 20 字节的 `t.txt`
- **THEN** `a.ipynb` 为 200 `text/plain; charset=utf-8` 精确字节、无截断头；`big.ipynb` 为 413 `preview_too_large`；`t.txt` 为 200 恰 16 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 20`
