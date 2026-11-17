# 本地账号是唯一身份来源，不对接 OIDC（取代 ADR-0007）

ADR-0007 的前提是：内网有统一身份系统，我们对接 OIDC；身份字段（含部门）由 IdP 下发，应用侧不能改；项目组默认自建，IdP 带组声明时改为同步。
owner 在 2026-11-17 确认**部署环境没有统一身份系统**，这个前提不成立。决定：**账号、密码、部门、角色与项目组都由本系统管理，OIDC 从路线图上去掉。**

- 管理员建账号、重置密码、启用与停用，维护部门、角色、配额与项目组；用户可以改自己的密码。
- 现有 dev-stub 的本地凭证路线（`accounts.password_hash` 存 scrypt 哈希，登录建会话 cookie）就是生产路线，不再是开发期的替身。
- 「IdP 是否带组声明」这个开放问题随之关闭：项目组自建，由管理员维护。

## Considered Options

- **本地账号为主，保留 OIDC 接缝等以后再接**：不选。没有任何可对接的 IdP，保留它只是为一个假设的部署方，属于 YAGNI。真出现带 IdP 的部署方时再立新 ADR。
- **本地账号与 OIDC 都做，部署时二选一**：不选，理由同上，而且 S3a 的范围会翻倍。

## Consequences

- S3a 由「OIDC 与账号治理」改为「本地账号与治理」（`IMPLEMENTATION_PLAN.md`）。下列事项留给 S3a 的 grill 决定：
  - `authenticate(req) → Principal` 这条 provider 接缝是否保留；
  - `dev-stub` 这个名字是否改；
  - 种子账号与它们的已知密码 `demo` 在生产部署里怎么处置；
  - 首个管理员怎么产生。
- 部门不再是「IdP 下发、不可改」的身份字段，S3a 起由管理员维护。change `s2c-kb-visibility` 建的 `accounts.department` 列与项目组两张表不变，只是它们的写入方从「IdP 与同步器」变成「管理员」。
- demo 账号页写着「部门由内网统一身份下发，本页不可改」（`resource/workbuddy-live-demo.html:3306`），登录页副标题写着「内网统一身份」（验收清单 LG-01）。这两处与本决定不符。偏离 demo 需要 owner 在 S3a 的 grill 里确认，在此之前界面文案不动。
- 本地账号意味着密码的安全面（哈希参数、改密与重置流程、登录失败节流）归本系统负责。S3a 按认证安全面处理，这是 IMPLEMENTATION_PLAN 记录的灰盒例外候选。
