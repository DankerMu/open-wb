## 1. 配置

- [x] 1.1 `mounts/config.ts`：`MountSettings` 增加 `mountMaxPerAccount`、`mountMaxAttachingPerAccount`；导出 `DEFAULT_MOUNT_MAX_PER_ACCOUNT = 32`、`DEFAULT_MOUNT_MAX_ATTACHING_PER_ACCOUNT = 2`；两键经 `resolvePositiveInteger` 解析；头注释里的「三个配置键」改为五个。
- [x] 1.2 `startup-registry.ts` 的 `workspaceAssemblyOf` 把两者带进 `mountSettings`，注释里的「五项」改为七项。以 #1806 合入后的形状为准：那段注释已被改写过。`server.ts:129` 的注释改为「四十二项……挂载五项」，只改这一行的文字，不增行，因为该文件已有 799/800 行。

## 2. 判定

- [x] 2.1 `mounts/store.ts`：增加 `countByOwner(ownerId)`。
- [x] 2.2 `app.ts` 与 `mounts/rest.ts` 的依赖：把两个上限传给挂载路由，缺席时取缺省值，写法同 `mountMaxOf`。
- [x] 2.3 `mounts/rest-mounts.ts` 的 POST：按 design 实现同步判定加计数、`finally` 减一；头注释里的判定次序同步更新。
- [x] 2.4 `core/errors/index.ts`：`mount_limit` 的文案改为 `挂载数已达上限`，并同步所有钉住旧文案的测试与 helper（`mounts-rest-helpers.ts`、`http-typed-errors*.test.ts`、`auth-lifecycle.test.ts`）。

## 3. 测试与文档

- [x] 3.1 `mounts-config.test.ts`：覆盖缺省值、覆盖值和非法值（design「Required evidence」配置部分）。design「Must add/change」列出的精确字面量和计数措辞一并更新。
- [x] 3.2 编译入口启动用例（`server-startup-mounts.test.ts`）：两个新键各取一个非法值，都以 `reason: "config"` 失败。
- [x] 3.3 REST 用例，可新建文件 `mounts-rest-account-limits.test.ts`，覆盖 design「Required evidence」：
  - 在途上限的释放路径：502、`before` 409、201，以及关停后为 503 而不是 409；
  - 跨账号互不影响；
  - 总数：跨空间计数、卸载后释放、并发时恰一个 201。
  
  `mounts-manager-helpers.ts` 只给 zhangsan 种了 W1–W3，所以要另建一个属于 lisi 的正式空间（建行和根目录）。用例先在改前的代码上跑一次，确认为红，报告里贴出输出。
- [x] 3.4 `docs/architecture/system.md`：「三个配置键」一段改为五个，给出缺省值，并说明按账号计数的理由；「挂载端点」的判定次序同步更新；加一段残余说明：主机解析的 2 个全局名额仍可被两个账号用满，进程上界为 账号数 × (32 + 2)。

验证：
- `npm run test:focus --workspace server -- mounts- http-typed-errors auth-lifecycle server-startup-mounts` → 退出码 0。
- `make check` → 退出码 0。

## Risk packs

- Resource limits — selected：本次的目的就在这里。由 3.3 覆盖。
- Concurrency / shared state / ordering — selected：同步段内判定加计数，`finally` 里减一，跨空间并发。由 3.3 的并发用例和四条释放路径覆盖。
- Config / project setup — selected：两个新键。由 3.1、3.2 覆盖。
- Error handling / rollback / partial outputs — selected：所有落定路径都要释放计数。由 3.3 覆盖：502、`before` 409、成功、关停。请求中止不会取消建出，见 design。
- Public API — selected：判定次序有变化，`mount_limit` 的文案也改了。由 2.4 和 3.3 覆盖。
- Documentation / migration notes — selected：3.4。
- Schema、Auth、File IO、Release — not selected：没有迁移（`owner_id` 列已经存在），也不涉及权限、路径或发布。
