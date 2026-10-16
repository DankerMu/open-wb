## MODIFIED Requirements

### Requirement: 预览监听器
`createPreviewApp({store, sandbox, tokens, converter, limits})` SHALL 返回一个独立的 Fastify 实例，只响应 `GET`（及其 `HEAD`）`/w/<token>/<path>` 与 `/o/<token>/<path>`（后者见 office-preview）。它 SHALL NOT 注册认证插件、SHALL NOT 读取 `Cookie` 头或任何会话表、SHALL NOT 托管静态文件或 SPA、SHALL NOT 提供任何 `/api` 路由：是否放行只取决于路径里的令牌。`<path>` 为令牌之后的全部路径，按 URL 解码一次后原样作为工作空间内的相对路径。

对 `/w/<token>/<path>`，每次请求 SHALL 依次：`tokens.lookup(token)` 为 `null` → 404；`store.rootOf({id: ownerId}, workspaceId)` 为 `null` 或不是已存在的目录 → 404；`sandbox.resolve({id: ownerId}, workspaceId, path, "read")`——被拒时沙箱照常写一条 `sandbox.reject` 审计（actor 为令牌的账号），响应 403；目标不存在、是目录或不是普通文件（`lstat`）→ 404（不列目录、不回退到 `index.html`）；随后 SHALL 以 workspaces「预览分类元数据与有界字节流」的 `openRegularFile` 打开目标（change sandbox-boundary-closure，owner B1/B5）——`lstat` 之后被换成符号链接、命名管道、目录、套接字或已被删除的目标同样 → 404（同一固定文案，不写审计），描述符已关闭、零字节读出；否则以「预览响应头与内容类型」规定的头从该描述符流式返回文件的完整字节（没有大小上限），`Content-Length` 与 `Range` 区间以打开那一刻 `fstat` 的大小为准，支持与 workspaces「文件预览」相同语义的单段 `Range`（206 / 416；416 时描述符已关闭）。空 `<path>`、其它方法、其它路径一律 404。对监听器的请求 SHALL NOT 推后令牌的到期时间。

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
- **THEN** 依次为 206（`Content-Range: bytes 0-99/1000`、100 字节）、416（`Content-Range: bytes */1000`、空体，文件被打开过一次且描述符已关闭）、200（1000 字节、`Accept-Ranges: bytes`）

#### Scenario: lstat 之后目标被换入
- **WHEN** 以有效令牌 `T` 请求 `/w/<T>/site/index.html`，在路由的 `lstat` 之后、打开之前（测试钩子包裹 `fs.openSync`），目标分别被换成一个没有写端的命名管道、一个指向另一账号文件的符号链接、一个目录
- **THEN** 三次都是 404 纯文本 `预览不存在或已过期`，响应体不含 `<T>`、路径或被链接文件的内容；没有 `sandbox.reject` 审计行；命名管道与目录各被打开一次又关闭，符号链接没有打开成功；没有读出任何字节；命名管道一例在 1500ms 内返回
