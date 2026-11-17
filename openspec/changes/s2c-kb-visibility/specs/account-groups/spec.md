# Spec Delta

## Purpose

账号的部门与项目组：知识库可见范围「本部门」「项目组」两档的数据来源。本能力只提供只读的数据与读取端点，真实来源（IdP 下发部门、项目组的管理面或同步）在 S3a 接入。

## ADDED Requirements

### Requirement: 迁移 053 部门与项目组
迁移 `053_kb_visibility.sql`（与 knowledge-bases「迁移 053 知识库范围列」同一个文件、同一个事务）SHALL：
- 给 `accounts` 追加 `department TEXT NULL`：为 NULL，或为 1–64 个字符、不含 C0 控制字符与 DEL 的字符串（CHECK）。
- 建 `project_groups(id, name, created_at)`：`id` 为非空 TEXT 主键，`name` 为非空且唯一、1–64 个字符、不含 C0 控制字符与 DEL，`created_at` 为非负整数 epoch 毫秒。
- 建 `project_group_members(group_id, account_id)`：主键为两列；`group_id` 引用 `project_groups(id)` `ON DELETE CASCADE`，`account_id` 引用 `accounts(id)` `ON DELETE CASCADE`；另建 `(account_id)` 索引。
- 种子（与迁移 010 的种子账号同一先例，镜像 demo 的账号与项目组）：u1 部门 `平台研发部`、u2 `数据部`、u3 `产品部`，u4 为 NULL；项目组 `g1` 名为 `内网落地专项`，成员 u1、u2。

应用侧 SHALL NOT 提供写部门、项目组或成员关系的接口（部门由 IdP 下发、应用不可改，ADR-0007；项目组的管理面在 S3a）。迁移不逆转；受信任迁移目录的计数断言在它的权威文件里 +1。

#### Scenario: 种子与约束
- **WHEN** 通过 `openDb(":memory:")` 完成全部迁移
- **THEN** u1–u4 的 `department` 依次为 `平台研发部`、`数据部`、`产品部`、NULL；`project_groups` 恰一行 `g1 / 内网落地专项`；`project_group_members` 恰为 `(g1, u1)`、`(g1, u2)`
- **WHEN** 把某账号的 `department` 写成空串、65 个字符或含 `\u0007` 的串；插入与 `g1` 同名的组；插入成员行引用不存在的账号
- **THEN** 五次写入都失败，表不变

#### Scenario: 级联
- **WHEN** 测试带外删除一个没有任何知识库引用的项目组
- **THEN** 它的成员行一并删除

### Requirement: 账号范围端点
`registerAccounts` SHALL 注册 `GET /api/accounts/me/scope`：已登录即可调用，与知识库是否开启无关，应答带 no-store（含守卫的 401）。成功应答 200 恰为 `{department, groups}`：
- `department`：调用者此刻的部门，字符串或 `null`。
- `groups`：调用者此刻所在的项目组，每项恰为 `{id, name, memberCount}`（`memberCount` 为该组此刻的成员数，正整数；范围对话框按 demo 显示「（N 人）」），按 `name` 升序（码点序）。

端点只读，SHALL NOT 写任何表或审计，SHALL NOT 从查询参数接受身份。`Principal` 与 `GET /api/auth/me` 的应答形状不变（dev-stub-auth）。

服务端判定所有者的部门与成员关系（knowledge-bases「知识库范围端点」第 3 步、建库第 5 步）SHALL 与本端点用同一个读取函数。

web 的 API 客户端 SHALL 提供 `getMyScope()`，按上述键集严格解析（键集或类型不符即 `requestFailed`）。

#### Scenario: 三个账号
- **WHEN** 测试带外先把 u4 的 `disabled` 置 0（种子里 u4 是停用账号，停用账号的请求一律 401）；u1、u3、u4 各请求一次
- **THEN** u1 为 `{department:"平台研发部", groups:[{id:"g1", name:"内网落地专项", memberCount:2}]}`；u3 为 `{department:"产品部", groups:[]}`；u4 为 `{department:null, groups:[]}`；三次都带 no-store

#### Scenario: 未登录
- **WHEN** 不带会话 cookie 请求
- **THEN** 401 `unauthorized`，no-store，没有应答体以外的数据

#### Scenario: 停用账号
- **WHEN** 种子 u4（`disabled=1`）带一个先前签发的会话 cookie 请求
- **THEN** 401 `unauthorized`（dev-stub-auth 的认证守卫），no-store
