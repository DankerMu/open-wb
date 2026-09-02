# Spec: dev-stub-auth

## ADDED Requirements

### Requirement: provider 接缝
auth 模块 SHALL 以 `authenticate(req) → Principal | null` 为对外唯一认证判定出口（ADR-0007 接缝）；Principal SHALL 恰为 `{id:string,account:string,role:string}`。dev-stub 凭证适配器 SHALL 落在 `server/src/auth/providers/dev-stub.ts`；cookie/session 读取 SHALL 是 provider 无关的共享实现，且不得 import dev-stub provider——S3a 增加 OIDC 适配器时接缝、session storage 与调用方不变。

`authenticate()` SHALL 从 cookie `workbuddy_session` 读取会话 ID，只接受 own property 的 64 位 lowercase hex；仅当该 ID 对应会话的 `expires_at` 严格晚于当前 Unix epoch milliseconds、关联账号存在且未停用时返回 exact Principal，否则返回 null。它 SHALL 在 SQLite 内先判定 matched row 的 expiry，避免把任意 64-bit epoch 投影成不安全 JavaScript number；若 exact matched row 的 `expires_at <= now`，即使关联账号已停用或成为 orphan，也 SHALL 以 `WHERE id=? AND expires_at<=?` 定点惰性删除并在 commit 后返回 null。Missing/畸形/unknown cookie、invalid clock 或 future disabled/orphan row SHALL 不删除任何会话；不得创建、替换、全表扫描/清理或改写 sibling row。

#### Scenario: 接缝可直接断言
- WHEN 不经 HTTP 路由，对携带有效 future-enabled 会话 cookie 的 request-shaped 输入调用 `authenticate()`
- THEN 返回 exact Principal `{id,account,role}`，所有 session/account rows 保持不变
- WHEN 输入为 missing/own-property-missing/prototype-inherited、畸形/uppercase、unknown cookie，invalid clock，或 future disabled/orphan row
- THEN 返回 null 且完整 session/account snapshots 不变

#### Scenario: 过期 exact row 惰性清理
- WHEN exact cookie 匹配 `expires_at < now` 或 `expires_at == now` 的 row（含 disabled/orphan row），同时数据库中存在 unrelated future/expired siblings
- THEN `authenticate()` 只删除该 matched expired row并返回 null；siblings 与 accounts 逐值不变，重复调用不产生额外写入

### Requirement: 账号与认证会话数据基座
首批业务迁移 SHALL 以单一原子 migration 建立 `accounts` 与 `auth_sessions`。`accounts` 的持久契约 SHALL 恰为 `id`、`account`、`role`、`disabled`、`password_hash`：`id` 为非空 TEXT；`account` 唯一且仅允许非空 lowercase ASCII `[a-z0-9._-]+`（登录输入仍先 trim+小写化后查询），`role` 仅允许 `成员 | 管理员`，`disabled` 仅允许整数 `0 | 1`。`auth_sessions` 的持久契约 SHALL 恰为 `id`（256 bit lowercase hex）、`user_id`（引用 `accounts.id`，删账号级联删会话）与 `expires_at`（非负 Unix epoch milliseconds）；`openDb()` 返回的连接 SHALL 实际启用 SQLite foreign-key enforcement。

该 migration SHALL 同时 seed 四账号（镜像 demo:1400-1407 + 停用扩展）：`u1/zhangsan/成员`、`u2/zhaoliu/成员`、`u3/lisi/管理员`，密码均为 `demo`（demo:1734，dev-stub 测试值，非生产凭证）；另 seed `u4/wangwu/成员` 且 `disabled=1`——demo 无停用 seed，为验证 403 分支引入。每行 SHALL 使用不同的 16-byte salt，以 `scrypt$16384$8$1$<32 lowercase hex salt>$<64 lowercase hex digest>` 存入 `password_hash`；迁移源码与数据库均不得存储密码明文。`auth_sessions` 初始为空。

#### Scenario: fresh seed 与 schema 形态正确
- WHEN 通过 `openDb(":memory:")` 完成全部 tracked migrations
- THEN migration receipts 按字典序包含既有 `0010`、`002` 后的单一 `010` 业务 migration；`accounts` 恰好存在上述四行、角色/停用值 exact，四个不同 salted scrypt hash 均非明文、以密码 `demo` 可校验而错误密码不可校验；`auth_sessions` 为空且其外键、级联与 epoch-millisecond/hex 约束实际生效

#### Scenario: 既有 migration 基座原子升级并稳定重开
- WHEN 临时文件库已是合法的 `0010` + `002` receipt/schema prefix，随后首次及再次调用 `openDb(path)`
- THEN 首次只原子追加 `010` 的 schema、四个 seed 与 receipt，第二次 schema/seed/receipt 均不变化；若 `010` 发生 catalog conflict，则本次 schema、seed 与 receipt 全部回滚并保留既有 prefix

### Requirement: 登录端点与语义
`POST /api/auth/login` SHALL 只接受 `application/json` 且 body 为 exact plain object `{account:string,password:string}`；缺失/额外字段、null/array、非 string 值、malformed JSON 或非 JSON content type SHALL 以稳定 400 `bad_request` 拒绝，且不得查询凭证、设置 cookie 或写会话。登录路由 SHALL 对 Fastify 已解析但未经 route-schema 变换的原始 JSON 值执行手写 exact-shape 校验；不得用会触发 Fastify/AJV 默认 type coercion 或 additional-property stripping 的 route schema，否则 `password:5` 或额外字段会在校验前被改写为合法 shape。全局 AJV 行为不得因本端点而改变。账号 SHALL 先使用 JavaScript `trim()` 再 `toLowerCase()` 后匹配（demo:1644）；空白归一化后为空 SHALL 等同未知账号。dev-stub provider SHALL 以存储 encoding 内的参数/salt/digest 使用 `node:crypto` scrypt，并以 constant-time digest compare 校验密码；未知账号 SHALL 使用请求提交的 password 对固定有效 dummy encoding 执行同参数 KDF并忽略 compare 结果，然后返回与错误密码同形状的 401，避免用响应类别或是否执行密码 KDF 枚举账号。production SHALL 只持有 dummy encoding，不得为该路径新增固定明文 dummy password。失败语义镜像 demo，错误响应使用统一错误信封。

成功 SHALL 使用唯一共享 CSPRNG seam 的默认实现 `crypto.randomBytes(32).toString("hex")` 生成 session ID，并在一个 SQLite transaction 内插入恰一行；碰撞/constraint/transaction 失败 SHALL 返回 programmer 5xx，不得覆盖既有 session、泄漏 ID 或设置 cookie。新会话的绝对 `expires_at` SHALL 等于 `now + sessionTtlMs` Unix epoch milliseconds；`sessionTtlMs` 省略/`undefined` 时默认恰为 `604800000`，custom 正安全整数配置按 lifecycle requirement 生效。响应 cookie 名 SHALL 为 `workbuddy_session`，值 SHALL 是 session ID，并恰包含 `HttpOnly`、`SameSite=Lax`、`Path=/`；`Secure` SHALL 只由 `createApp({ secureCookies })` 的显式 boolean 决定，默认 false。正常 cookie SHALL 不设置 `Domain`、`Expires` 或 `Max-Age`（browser cookie 生命周期与 server-side absolute expiry 分离）。

#### Scenario: 登录成功
- WHEN 以正确凭证登录
- THEN 返回 200 与直接 Principal JSON 对象 `{id,account,role}`（三个字段均为 string，且恰为这三个字段，不含密码/散列字段），响应带上述 exact session cookie；会话表新增恰一行，其 ID 为 64 lowercase hex，`user_id` exact，`expires_at` 等于注入时钟加 configured `sessionTtlMs`（省略/`undefined` 使用 604800000）

#### Scenario: 凭证错误
- WHEN 账号不存在、规范化后为空或密码错误
- THEN 返回 401，信封 code=invalid_credentials，message 为"账号或密码不正确"（不区分三种情况，demo:1645）；无 Set-Cookie 且会话表不变，未知/空账号仍执行一次 dummy scrypt

#### Scenario: 停用账号拒绝
- WHEN 停用账号 wangwu 以正确密码登录
- THEN 在密码校验后返回 403，code=account_disabled，message 为"该账号已停用，请联系管理员"（demo:1647），无 Set-Cookie 且不建立会话（审计事件属 S1a Non-goal，不产生）
- WHEN wangwu 使用错误密码登录
- THEN 返回与其他错误凭证完全相同的 401 `invalid_credentials`，不得泄漏账号停用状态

#### Scenario: 账号规范化
- WHEN 以 "  ZhangSan " 形式提交
- THEN 按 JavaScript trim+小写化匹配 zhangsan 成功，响应 Principal 与 session row 均使用持久 canonical identity

#### Scenario: 请求形状严格拒绝
- WHEN body 缺失/额外字段、值非 string、body 非 plain object、JSON malformed 或 content type 非 JSON
- THEN 返回稳定 4xx，且不执行 scrypt、不设置 cookie、不写会话；body 中的密码不得出现在响应、日志或错误对象中

### Requirement: 会话安全与生命周期
会话记录 SHALL 落 SQLite（id、user_id、expires_at）；session id SHALL 由密码学安全随机源生成（`crypto.randomBytes` ≥128 bit，本实现 256 bit hex），不得由行号、时间或用户可推导量派生。TTL SHALL 是 `createApp({sessionTtlMs})` 的正安全整数 epoch-millisecond 配置，默认恰为 7 天 `604800000`；只影响新会话且绝对 `now+ttl` 也 SHALL 为安全整数，不回写既有会话。`GET /api/auth/me` SHALL 返回当前 exact Principal 或 401，并对 exact expired row 惰性清理。`POST /api/auth/logout` SHALL 以 cookie bearer identity 删除任何 existing exact session row（不要求未过期/账号启用），并清 cookie；missing/畸形/unknown cookie SHALL 401 且不改 DB。两 route 都 SHALL `Cache-Control: no-store`。

正常 session cookie SHALL 为 HttpOnly、SameSite=Lax、Path=/、无 Domain，`Secure` 随 `secureCookies`；不得设置 Expires/Max-Age。清 cookie SHALL 复用相同 scope/security 属性并设置空值、`Max-Age=0`、Unix epoch `Expires`，Domain 仍 absent。Clear-cookie 只可在 me/logout 的 terminal 401 或 logout DELETE commit 后的 204 上发布；storage/programmer 5xx 不得发布。

#### Scenario: session id 不可预测
- WHEN 连续建立多个会话
- THEN 各 session id 长度与字符集符合 256 bit hex，互不相邻且不可由前一个推导（断言生成源为 CSPRNG 封装函数）

#### Scenario: TTL 默认值、配置与边界
- WHEN 省略 `sessionTtlMs` 或分别配置合法最小值 1 / 自定义正安全整数，并以 fixed `now` 登录
- THEN 新会话 `expires_at` 分别 exact 等于 `now+604800000` / `now+ttl`，既有 rows 不变，正常 cookie 仍无 Expires/Max-Age
- WHEN TTL 为 0、负数、小数、NaN/Infinity、非 number 或不安全整数，或合法 TTL 与 now 相加溢出 safe integer
- THEN app 配置或登录在 DB write/Set-Cookie 前 generic fail；不得钳制/取整/回退默认值

#### Scenario: 会话有效期内访问
- WHEN 携带有效 future-enabled cookie 请求 `GET /api/auth/me`
- THEN 返回 200、`Cache-Control: no-store` 与当前直接 Principal JSON `{id,account,role}`，形状与登录成功完全一致；无 Set-Cookie，完整数据库快照不变

#### Scenario: me 未认证与过期清理
- WHEN me 输入为 missing/畸形/unknown cookie、invalid clock 或 future disabled/orphan row
- THEN 返回 exact 401 `unauthorized`、no-store 与 scoped clear-cookie，数据库逐值不变
- WHEN me 的 exact row 已过期（`expires_at <= now`，含 disabled/orphan）
- THEN 先 durably 只删除该 matched row，再返回相同 401/no-store/clear-cookie；若 conditional DELETE 因 race 已变为 0 rows，仍返回该 null/401 终态而非 5xx；任何真实 DELETE/COMMIT/rollback/query failure返回 generic 5xx且不发 clear-cookie
- WHEN future `expires_at` 超过 JavaScript safe integer（含 SQLite maximum signed 64-bit integer）
- THEN expiry 在 SQLite 内分类为 future，不因 JS number projection 发生 round/throw；enabled account仍返回 exact Principal，future disabled/orphan仍 null且不删行

#### Scenario: 登出后失效
- WHEN 携带 own exact cookie 对应任意 existing row（future/expired/disabled-account/future-or-expired orphan）请求 bodyless `POST /api/auth/logout`，包括 injected `authNow` 非法的 app
- THEN logout 不消费 Principal/clock eligibility；在 owned transaction commit 删除 exact bearer row 后返回 204、empty body、no-store 与 scoped clear-cookie；之后携带原 cookie 请求 me 返回 401，unrelated rows不变
- WHEN logout cookie missing/畸形/unknown
- THEN 返回 exact 401 `unauthorized`、no-store 与 scoped clear-cookie，数据库不变；该 401 与 204 都是现有 web logout 的 terminal unauthenticated 结果

#### Scenario: logout body 与失败边界
- WHEN logout 携带任何 parsed body，或触发 malformed/empty JSON、unsupported media、超过最小 route body limit 的 native parser error
- THEN 在 cookie lookup/DELETE/clear-cookie 前返回 exact 400 `bad_request`；route 不使用 schema且不信任 validation/status/code duck typing
- WHEN BEGIN/DELETE/COMMIT 失败
- THEN rollback 后返回 generic 5xx、无 clear-cookie且 snapshot 不变；rollback 也失败时保留 original+rollback AggregateError 和 caller recovery state；caller 已有 transaction 时不得提交/回滚其 effects

### Requirement: 认证守卫
原始request pathname属于exact `/api`或`/api/*`时，除exact matched method+route为GET/implicit HEAD `/api/healthz`、GET/implicit HEAD `/api/info`、POST `/api/auth/login`或bearer-revocation POST `/api/auth/logout`外，系统SHALL在body parsing与handler前调用唯一`authenticate(request)` exact一次。Auth注册面SHALL作为FastifyRequest Principal类型/runtime同一owner，唯一安装request-local `principal:null`默认值；standalone `registerAuth`同样不得出现undefined，禁止共享object默认值或guard重复decorate。Null SHALL返回exact401 `unauthorized`；guard是Principal唯一写者，值只绑定当前request供matched handler消费。判定SHALL使用rewrite前`request.originalUrl`的共享bounded pathname classifier与Fastify matched route identity；bounded decode产生`?`时SHALL按该decoded query delimiter前的实际routed pathname判定API identity（1–4轮encoded exact `/api?query`仍protected），同时保留完整canonical pathname/decode/unsafe输出；不得以string prefix、rewritten internal route或可任意扩张metadata豁免。静态/fallback/unsafe non-API 404不受guard影响。Storage/cleanup failure SHALL保持generic5xx，不得降级401。Guard不得全局发布me/logout专属no-store或clear-cookie。

Logout SHALL绕过Principal eligibility guard，使future disabled/orphan或invalid auth clock的existing exact row仍进入#10 handler并durable删除；login/logout parser与handler合同保持不变。Me SHALL把no-store前移到route-local onRequest并消费guard已绑定Principal，避免二次authenticate；null/expired路径仍保有#10 exact cleanup、no-store与clear-cookie。

#### Scenario: 默认拒绝与request-local Principal
- WHEN 无cookie、畸形、伪造/未知、future disabled/orphan或invalid-clock cookie请求受保护API（含exact `/api`、unknown catch-all、method/path/trailing-slash near-miss）
- THEN在parser/handler前返回逐字相同401 unauthorized；除exact expired cleanup外不写任何session/account row，不返回5xx、不跨request共享Principal、不新增Set-Cookie
- WHEN standalone auth或createApp装配后请求在guard写入前读取Principal，或valid future-enabled cookie请求受保护route/并发以不同cookie请求Principal consumer
- THEN前者运行时exact为null且类型不含undefined、无重复decorator；guard各调用authenticate exact一次，handler消费对应exact request-local Principal；原route响应/404语义保持，数据库不变且Principal不得cross-bind
- WHEN exact expired enabled/disabled/orphan row请求受保护route
- THEN authenticate conditional cleanup只提交删除该row后返回401；siblings不变；query/cleanup/transaction failure为generic5xx而非401

#### Scenario: 精确豁免、原始pathname与parser顺序
- WHEN GET/HEAD healthz/info携任意cookie或invalid clock，或POST login/logout走其既有valid/error输入
- THEN guard执行zero session lookup/cleanup；health/info保持exact success且不产生session，login保持自身KDF/INSERT/parser400，logout保持bearer DELETE/204|401/parser400；其他method、trailing slash或lookalike不继承豁免
- WHEN unauth protected route携malformed/media/oversize body，或valid-auth携同一body
- THEN unauth在body parser前401；valid-auth继续matched route原有parser/404/5xx语义；public login/logout仍先豁免guard再保留既有route-owned400
- WHEN slash/backslash、1–4轮encoded API、post-decode `?`形成的routed exact `/api` identity，或ordinary/unsafe/multi-encoded non-API GET/POST/HEAD pathname（含被rewrite到internal API miss者）进入app
- THEN API identity按original URL的共享bounded classifier受保护；`/files%3Ftab=1`等non-API routed pathname保持fallback，超界/unsafe/non-API无论是否携cookie都绕过guard、零session query并保持既有typed404/static隔离，不因rewritten route误报401
