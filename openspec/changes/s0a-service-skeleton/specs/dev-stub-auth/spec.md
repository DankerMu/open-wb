# Spec: dev-stub-auth

## ADDED Requirements

### Requirement: provider 接缝
auth 模块 SHALL 以 `authenticate(req) → Principal | null` 为对外唯一认证出口（ADR-0007 接缝）；dev-stub 登录流程 SHALL 落在 `server/src/auth/providers/dev-stub.ts`，会话读取与守卫为 provider 无关的共享实现——S3a 增加 OIDC 适配器时接缝与调用方不变。

#### Scenario: 接缝可直接断言
- WHEN 对携带有效/无效会话的请求分别调用 `authenticate()`
- THEN 分别返回 Principal（含 user id、账号、角色）与 null，不经 HTTP 层即可测试

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
`POST /api/auth/login` SHALL 接收恰为 `{account:string,password:string}` 的 JSON body；账号先 trim 再小写化后匹配（demo:1644）；成功建立服务端会话并 Set-Cookie；失败语义镜像 demo，错误响应使用统一错误信封。

#### Scenario: 登录成功
- WHEN 以正确凭证登录
- THEN 返回 200 与直接 Principal JSON 对象 `{id,account,role}`（三个字段均为 string，且恰为这三个字段，不含密码/散列字段），响应带 httpOnly session cookie，会话表新增一行

#### Scenario: 凭证错误
- WHEN 账号不存在或密码错误
- THEN 返回 401，信封 code=invalid_credentials，message 为"账号或密码不正确"（不区分两种情况，demo:1645）

#### Scenario: 停用账号拒绝
- WHEN 停用账号 wangwu 以正确密码登录
- THEN 返回 403，code=account_disabled，message 为"该账号已停用，请联系管理员"（demo:1647），不建立会话（审计事件属 S1a Non-goal，不产生）

#### Scenario: 账号规范化
- WHEN 以 "  ZhangSan " 形式提交
- THEN 按 trim+小写化匹配 zhangsan 成功

### Requirement: 会话安全与生命周期
会话记录 SHALL 落 SQLite（id、user_id、expires_at）；session id SHALL 由密码学安全随机源生成（`crypto.randomBytes` ≥128 bit，本实现 256 bit hex），不得由行号、时间或用户可推导量派生；TTL SHALL 为配置项（默认 7 天，绝对过期，惰性清理）；cookie SHALL 为 httpOnly、SameSite=Lax、Path=/，`Secure` 随部署形态配置。`POST /api/auth/logout` SHALL 删除会话并清 cookie；`GET /api/auth/me` SHALL 返回当前用户或 401。

#### Scenario: session id 不可预测
- WHEN 连续建立多个会话
- THEN 各 session id 长度与字符集符合 256 bit hex，互不相邻且不可由前一个推导（断言生成源为 CSPRNG 封装函数）

#### Scenario: 会话有效期内访问
- WHEN 携带有效 cookie 请求 `GET /api/auth/me`
- THEN 返回 200 与当前直接 Principal JSON 对象 `{id,account,role}`，形状与登录成功响应完全一致

#### Scenario: 登出后失效
- WHEN 携带有效会话请求 `POST /api/auth/logout`
- THEN 返回 204 且无 response body，删除会话行并清除 session cookie；之后携带原 cookie 请求 `GET /api/auth/me` 返回 401

#### Scenario: 过期会话
- WHEN 会话已过期（测试将 expires_at 置为过去）
- THEN 请求返回 401，且服务端按惰性清理删除该行

### Requirement: 认证守卫
除 `healthz`/`info`/`auth/login` 外的 `/api/*` 端点 SHALL 默认要求有效会话；未认证返回 401 错误信封（code=unauthorized；静态资源与 fallback 不受守卫影响）。

#### Scenario: 未登录访问受保护端点
- WHEN 无 cookie 请求任一受保护 `/api/*` 端点
- THEN 返回 401 错误信封

#### Scenario: 伪造或未知 session id
- WHEN 携带会话表中不存在的 session id（伪造/篡改/库重建后的旧 cookie）请求受保护端点
- THEN 返回 401 错误信封（与无 cookie 同形状），不返回 5xx，不写入任何会话行
