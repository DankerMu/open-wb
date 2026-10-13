## ADDED Requirements

### Requirement: 预览令牌登记表
`server/src/preview/` SHALL 提供进程内的预览令牌登记表：`issue({ownerId, workspaceId, embedOrigin}, now)` 返回 `{token, expiresAt}`，`lookup(token, now)` 返回 `{ownerId, workspaceId, embedOrigin}` 或 `null`。令牌 SHALL 为 32 字节密码学随机数的小写十六进制（64 个字符），只存在于内存，不写数据库、不写日志、不进审计。每个 `(ownerId, workspaceId)` 至多一个未过期令牌：未过期时再次 `issue` SHALL 返回同一个令牌、把 `expiresAt` 推后到 `now + 900000`（15 分钟）并把 `embedOrigin` 更新为本次的值；已过期或不存在时生成新令牌。`lookup` SHALL 只做精确字符串匹配，`now >= expiresAt` 的令牌视为不存在并被清除；`lookup` SHALL NOT 推后到期时间。登记表 SHALL NOT 做任何归属判断或文件系统访问（那是调用方的事），进程重启后为空。

#### Scenario: 签发、复用与续期
- **WHEN** 在时刻 `t` 为 `(u1, w1)` 签发；在 `t + 5 分钟` 再次为 `(u1, w1)` 签发；同一时刻为 `(u1, w2)` 与 `(u2, w1)` 各签发一次
- **THEN** 第一次的令牌匹配 `/^[0-9a-f]{64}$/`、`expiresAt = t + 900000`；第二次返回同一个令牌、`expiresAt = t + 5 分钟 + 900000`；另外两次得到互不相同、也不同于前者的令牌

#### Scenario: 到期与查找不续期
- **WHEN** 在时刻 `t` 签发后，在 `t + 899999` 与 `t + 900000` 各 `lookup` 一次；到期之后再为同一 `(ownerId, workspaceId)` 签发
- **THEN** 前一次返回该令牌的记录，后一次返回 `null`；连续的 `lookup` 不改变 `expiresAt`；到期后的签发得到一个新的令牌，旧令牌 `lookup` 仍为 `null`

#### Scenario: 未知令牌
- **WHEN** 以空串、63 个字符的前缀、大写形式的有效令牌、任意其它字符串 `lookup`
- **THEN** 都返回 `null`

### Requirement: 预览令牌签发端点
`POST /api/workspaces/:id/preview-token` SHALL 是主站上受 cookie 鉴权的无请求体端点（归属 content-parser 集，见 http-service-skeleton「统一错误信封」），仅在装配了预览依赖时注册。属他人或不存在的 `:id`、或该空间的根目录不存在 → 与其它工作空间端点相同的 404 `not_found`，不签发。成功 SHALL 以 `ownerId` = 当前账号、`workspaceId` = `:id`、`embedOrigin` = 本次请求的 `Origin` 头（没有该头时为 `null`）调用登记表，并返回 200、`Cache-Control: no-store`：

`{token, base, officeBase, expiresAt, documentMaxBytes, officeAvailable}`

其中 `base` 为 `<预览来源>/w/<token>/`、`officeBase` 为 `<预览来源>/o/<token>/`；`<预览来源>` 在配置了 `PREVIEW_ORIGIN` 时恰为该值，否则为 `<本次请求的协议>://<本次请求 Host 头里的主机名>:<预览监听器实际绑定的端口>`（主机名不含端口；IPv6 字面量保留方括号）；`expiresAt` 为毫秒时间戳；`documentMaxBytes` 为 `PREVIEW_DOCUMENT_MAX_BYTES` 的取值；`officeAvailable` 当且仅当配置了 `OFFICE_BIN` 时为 `true`。本端点 SHALL NOT 写审计，SHALL NOT 访问请求路径之外的文件系统内容。响应体之外，令牌 SHALL NOT 出现在任何响应头、日志或错误信息里。

#### Scenario: 签发与复用
- **WHEN** zhangsan 对自己的工作空间连续两次 `POST …/preview-token`（请求头带 `Origin: http://127.0.0.1:3000`、`Host: 127.0.0.1:3000`），预览监听器绑定在端口 `P`，未配置 `PREVIEW_ORIGIN` 与 `OFFICE_BIN`
- **THEN** 两次都是 200 且 `token` 相同，`base` 恰为 `http://127.0.0.1:<P>/w/<token>/`，`officeBase` 恰为 `http://127.0.0.1:<P>/o/<token>/`，第二次的 `expiresAt` 不小于第一次，`documentMaxBytes` 为 `104857600`，`officeAvailable` 为 `false`；响应带 `no-store`；审计表没有新增行

#### Scenario: 对外来源与转换可用
- **WHEN** 配置 `PREVIEW_ORIGIN=https://preview.example.test` 与 `OFFICE_BIN` 后签发
- **THEN** `base` 恰为 `https://preview.example.test/w/<token>/`，`officeAvailable` 为 `true`

#### Scenario: 归属与请求体
- **WHEN** lisi 对 zhangsan 的工作空间、任一账号对不存在的 id、未登录的请求、以及带 `{}` 请求体的请求分别调用
- **THEN** 依次为 404、404、401、400 `bad_request`；四种情况都没有令牌被签发（随后以任何字符串访问预览监听器都得不到文件）

### Requirement: 预览监听器
`createPreviewApp({store, sandbox, tokens, converter, limits})` SHALL 返回一个独立的 Fastify 实例，只响应 `GET`（及其 `HEAD`）`/w/<token>/<path>` 与 `/o/<token>/<path>`（后者见 office-preview）。它 SHALL NOT 注册认证插件、SHALL NOT 读取 `Cookie` 头或任何会话表、SHALL NOT 托管静态文件或 SPA、SHALL NOT 提供任何 `/api` 路由：是否放行只取决于路径里的令牌。`<path>` 为令牌之后的全部路径，按 URL 解码一次后原样作为工作空间内的相对路径。

对 `/w/<token>/<path>`，每次请求 SHALL 依次：`tokens.lookup(token)` 为 `null` → 404；`store.rootOf({id: ownerId}, workspaceId)` 为 `null` 或不是已存在的目录 → 404；`sandbox.resolve({id: ownerId}, workspaceId, path, "read")`——被拒时沙箱照常写一条 `sandbox.reject` 审计（actor 为令牌的账号），响应 403；目标不存在、是目录或不是普通文件 → 404（不列目录、不回退到 `index.html`）；否则以「预览响应头与内容类型」规定的头流式返回文件的完整字节（没有大小上限），支持与 workspaces「文件预览」相同语义的单段 `Range`（206 / 416）。空 `<path>`、其它方法、其它路径一律 404。对监听器的请求 SHALL NOT 推后令牌的到期时间。

失败响应 SHALL 为 `text/plain; charset=utf-8` 的固定短文案（404 `预览不存在或已过期`、403 `路径不在工作空间内`、416 空体），带与成功响应相同的 `nosniff`、`no-store`、`Referrer-Policy`；它不是 JSON 错误信封，SHALL NOT 回显令牌、路径或任何请求内容。

#### Scenario: 令牌放行，cookie 不放行
- **WHEN** zhangsan 登录并为自己的工作空间签发令牌 `T`；随后对预览监听器分别请求：`/w/<T>/readme.md` 不带任何 cookie；`/w/<随机 64 位十六进制>/readme.md` 带 zhangsan 的有效 `workbuddy_session` cookie；`/readme.md` 带同一 cookie；`/api/workspaces` 带同一 cookie
- **THEN** 第一个为 200 且字节等于文件内容；后三个都是 404 纯文本，响应里没有 `Set-Cookie`，会话表没有被查询

#### Scenario: 相对资源与子目录
- **WHEN** 工作空间里有 `site/index.html`（引用 `./style.css` 与 `img/a.png`）、`site/style.css`、`site/img/a.png`，请求 `/w/<T>/site/index.html`、`/w/<T>/site/style.css`、`/w/<T>/site/img/a.png`
- **THEN** 三者都是 200，`Content-Type` 依次为 `text/html; charset=utf-8`、`text/css; charset=utf-8`、`image/png`，字节等于文件内容

#### Scenario: 拒绝项
- **WHEN** 以有效令牌请求 `/w/<T>/`、`/w/<T>/site`（目录）、`/w/<T>/site/`、`/w/<T>/missing.html`、`/w/<T>/%2e%2e/%2e%2e/etc/passwd`、`/w/<T>/link`（空间内指向空间外的符号链接）；以 `POST` 请求 `/w/<T>/readme.md`；令牌过期之后请求 `/w/<T>/readme.md`
- **THEN** 前四个为 404；越界与符号链接两例为 403，各在审计表留下一条 `sandbox.reject`（`actor_id` 为 zhangsan，`detail.op` 为 `read`）；`POST` 为 404；过期后为 404；所有响应体都不含 `<T>` 与所请求的路径

#### Scenario: 作用域只有一个工作空间
- **WHEN** zhangsan 有工作空间 A 与 B，令牌 `T` 为 A 签发；请求 `/w/<T>/<只存在于 B 的文件>`；lisi 的工作空间里有同名文件
- **THEN** 响应为 404；`T` 读不到 B 与 lisi 的任何文件

#### Scenario: 空间消失后令牌失效
- **WHEN** 令牌 `T` 未过期，而其工作空间的根目录被移走（或该空间已不属于该账号）
- **THEN** `/w/<T>/readme.md` 为 404，没有审计行

#### Scenario: 范围请求
- **WHEN** 对 1000 字节的 `/w/<T>/clip.mp4` 带 `Range: bytes=0-99`、`bytes=1000-` 与不带 `Range` 各请求一次
- **THEN** 依次为 206（`Content-Range: bytes 0-99/1000`、100 字节）、416（`Content-Range: bytes */1000`、空体）、200（1000 字节、`Accept-Ranges: bytes`）

### Requirement: 预览响应头与内容类型
预览监听器的**每一个**响应（成功与失败）SHALL 带 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`。`/w/` 与 `/o/` 的成功响应 SHALL 另带 `Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin` 与 `Content-Security-Policy`：`Content-Type` 为 `application/pdf` 的响应为 `frame-ancestors <E>`；其余一律为 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors <E>`。`<E>` 由写响应头的这一步从该令牌登记的 `embedOrigin` 得出：当且仅当它不是 `null`、能被解析为 URL、解析结果的 `origin` 与它逐字相等（即它恰是一个序列化的来源 `scheme://host[:port]`），并且不含 `*`、`;`、`,`、`'` 四个字符中的任何一个时，`<E>` SHALL 逐字为该值；其余一切情况（含 `null`）`<E>` SHALL 为 `'none'`。这项校验只在写头处做：「预览令牌登记表」原样保存 `embedOrigin`，不做校验。CSP SHALL NOT 含 `allow-same-origin`、`allow-top-navigation`、`allow-popups`，SHALL NOT 含任何限制取源的指令（`default-src`、`script-src`、`connect-src` 等）——HTML 预览加载外部资源是被允许的。

`/w/` 的 `Content-Type` SHALL 按文件名最后一个 `.` 之后的小写扩展名取自固定表：`html`/`htm` → `text/html; charset=utf-8`；`css` → `text/css; charset=utf-8`；`js`/`mjs` → `text/javascript; charset=utf-8`；`json`/`map` → `application/json; charset=utf-8`；`svg` → `image/svg+xml`；`png`、`jpg`/`jpeg`、`gif`、`webp`、`bmp`、`ico` → 与 workspaces 分类器相同的 `image/*`；`woff`、`woff2`、`ttf`、`otf` → `font/<同名>`；`pdf` → `application/pdf`；`mp3`、`wav`、`mp4`、`webm` → 与 workspaces 分类器相同的类型；`txt`、`md`、`csv`、`tsv`、`xml` → `text/plain; charset=utf-8`；表外（含无扩展名）一律 `application/octet-stream`。类型只由文件名决定，SHALL NOT 嗅探内容。

主站来源 SHALL NOT 以 `text/html`、`image/svg+xml`、`application/xhtml+xml`、`application/pdf` 或任何 XML 类型返回工作空间文件的内容：`/api/workspaces/:id/file` 对这些文件只返回 `text/plain` 或 415（workspaces「文件预览」），`/api/workspaces/:id/download` 只返回 `application/octet-stream` 附件（file-operations）。

#### Scenario: HTML 响应是不透明来源
- **WHEN** 以 `Origin: http://127.0.0.1:3000` 签发令牌后请求 `/w/<T>/site/index.html`
- **THEN** 「预览响应头与内容类型」规定的头恰为七个：`Content-Type: text/html; charset=utf-8`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`、`Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals; frame-ancestors http://127.0.0.1:3000`；CSP 中没有 `allow-same-origin` 与 `default-src`

#### Scenario: embedOrigin 不是一个来源时按没有处理
- **WHEN** 令牌登记的 `embedOrigin` 分别为：`*`、`null`（四个字符的字符串）、空串、`'none'`、`http://a.test/`、`http://a.test/path`、`http://a.test; sandbox allow-same-origin`、`http://a.test http://evil.test`、`http://a.test, http://evil.test`、`javascript:alert(1)`、`data:text/html,x`、`http:`；以及能解析且 `origin` 原样往返、但含上述四个字符之一的 `http://*`、`http://*.a.test`、`http://a.test;sandbox`、`http://a.test,x`、`http://a'none'`；另以 `https://preview.example.test` 为对照。各请求 `/w/<T>/a.html` 与 `/w/<T>/doc.pdf`
- **THEN** 对照之外的每一例，`a.html` 的 CSP 恰为 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'none'`，`doc.pdf` 的 CSP 恰为 `frame-ancestors 'none'`，登记的值不出现在任何响应头里；对照一例两者的 `frame-ancestors` 之后恰为 `https://preview.example.test`

#### Scenario: PDF 响应不带 sandbox
- **WHEN** 请求 `/w/<T>/doc.pdf`；另一个令牌在没有 `Origin` 头的请求里签发后请求同一文件
- **THEN** 前者 `Content-Type: application/pdf`，CSP 恰为 `frame-ancestors http://127.0.0.1:3000`、不含 `sandbox`；后者 CSP 恰为 `frame-ancestors 'none'`

#### Scenario: 类型只看文件名
- **WHEN** 请求内容是 HTML 文本的 `notes.txt`、无扩展名的 `README`、`data.bin`、`a.svg`、`app.mjs`
- **THEN** `Content-Type` 依次为 `text/plain; charset=utf-8`、`application/octet-stream`、`application/octet-stream`、`image/svg+xml`、`text/javascript; charset=utf-8`；`a.svg` 的响应带含 `sandbox` 的 CSP

#### Scenario: 失败响应的头
- **WHEN** 以未知令牌请求 `/w/<x>/a.html`
- **THEN** 404，`Content-Type: text/plain; charset=utf-8`，带 `nosniff`、`no-store`、`Referrer-Policy: no-referrer`，正文为 `预览不存在或已过期`

#### Scenario: 主站不把工作空间文件当文档返回
- **WHEN** 经主站对同一工作空间的 `page.html`、`logo.svg`、`doc.pdf`、`feed.xml` 分别请求 `file` 与 `download`
- **THEN** `file` 的响应是 `text/plain; charset=utf-8`（`page.html`、`logo.svg`、`feed.xml`）或 415（`doc.pdf`）；`download` 的响应都是 `application/octet-stream` 且带 `Content-Disposition: attachment`；没有一个响应的 `Content-Type` 是 `text/html`、`image/svg+xml`、`application/pdf` 或 XML 类型
