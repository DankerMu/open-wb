## MODIFIED Requirements

### Requirement: 账号与认证会话数据基座
首批业务迁移 SHALL 以单一原子 migration 建立 `accounts` 与 `auth_sessions`。`accounts` 的持久契约 SHALL 恰为 `id`、`account`、`role`、`disabled`、`password_hash`：`id` 为非空 TEXT；`account` 唯一且仅允许非空 lowercase ASCII `[a-z0-9._-]+`（登录输入仍先 trim+小写化后查询），`role` 仅允许 `成员 | 管理员`，`disabled` 仅允许整数 `0 | 1`。迁移 053 之后 `accounts` 另有可空列 `department`（account-groups「迁移 053 部门与项目组」）：本迁移的契约与种子不变，`department` 不进 Principal，登录与 `GET /api/auth/me` 的应答形状不变。`auth_sessions` 的持久契约 SHALL 恰为 `id`（256 bit lowercase hex）、`user_id`（引用 `accounts.id`，删账号级联删会话）与 `expires_at`（非负 Unix epoch milliseconds）；`openDb()` 返回的连接 SHALL 实际启用 SQLite foreign-key enforcement。

该 migration SHALL 同时 seed 四账号（镜像 demo:1400-1407 + 停用扩展）：`u1/zhangsan/成员`、`u2/zhaoliu/成员`、`u3/lisi/管理员`，密码均为 `demo`（demo:1734，dev-stub 测试值，非生产凭证）；另 seed `u4/wangwu/成员` 且 `disabled=1`——demo 无停用 seed，为验证 403 分支引入。每行 SHALL 使用不同的 16-byte salt，以 `scrypt$16384$8$1$<32 lowercase hex salt>$<64 lowercase hex digest>` 存入 `password_hash`；迁移源码与数据库均不得存储密码明文。`auth_sessions` 初始为空。

#### Scenario: fresh seed 与 schema 形态正确
- WHEN 通过 `openDb(":memory:")` 完成全部 tracked migrations
- THEN migration receipts 按字典序包含既有 `0010`、`002` 后的单一 `010` 业务 migration；`accounts` 恰好存在上述四行、角色/停用值 exact，四个不同 salted scrypt hash 均非明文、以密码 `demo` 可校验而错误密码不可校验；`auth_sessions` 为空且其外键、级联与 epoch-millisecond/hex 约束实际生效

#### Scenario: 既有 migration 基座原子升级并稳定重开
- WHEN 临时文件库已是合法的 `0010` + `002` receipt/schema prefix，随后首次及再次调用 `openDb(path)`
- THEN 首次只原子追加 `010` 的 schema、四个 seed 与 receipt，第二次 schema/seed/receipt 均不变化；若 `010` 发生 catalog conflict，则本次 schema、seed 与 receipt 全部回滚并保留既有 prefix

#### Scenario: 053 之后 Principal 不变
- **WHEN** 迁移到 053 之后 u1 登录并请求 `GET /api/auth/me`
- **THEN** 两个应答都恰为 `{id:"u1", account:"zhangsan", role:"成员"}`，不含 `department`
