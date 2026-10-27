## 1. 实现

- [x] 1.1 `attempt.ts`：
  - 加入账号级限流（每账号 1 个），嵌套在全局 `lookupLimit` 之外；账号空闲时删除它的键。
  - `target` 增加 `ownerId` 参数。
  - 头注释「Host lookups are limited to two in flight」一段补上按账号的规则。
- [x] 1.2 `manager.ts`：`remountOnce` 传 `record.ownerId`，`attachNow` 传 `input.ownerId`。

## 2. 测试

- [x] 2.1 `server/test/mounts-manager.test.ts`（超过 800 行就新建 `mounts-manager-lookups.test.ts`）：按 design 的「Required evidence」写用例：
  - 同账号串行；
  - 跨账号并行、全局不超过 2；
  - 等待者不占全局名额；
  - 重挂计入所属账号；
  - 失败、成功之后会释放；abort（detach 取消重挂）之后仍占着名额，直到 lookup 返回；
  - IP 字面量不排队。
  多账号的准备工作：
  - `mounts-manager-helpers.ts` 的 `workspaceRootOf` 目前只认 `OWNER`（:311-312），要改成按 owner 查各自的空间根；
  - lisi（u3）和第三个账号（u4 wangwu，由迁移 010 种出）各写一行 `workspaces`，并建好根目录。
  
  到达次序和否定断言按 design「Required evidence」开头的确定性规则写。
- [x] 2.2 两个既有用例（「at most two host lookups…」和「an IP literal host…」）按新语义改写，断言强度不能降低。
- [x] 2.3 新用例先在改前的代码上跑一次，确认为红，报告里贴出输出。

## 3. 文档

- [x] 3.1 `docs/architecture/system.md`：#1789 残余说明里关于主机解析名额的那一句，改为新语义：每账号至多 1 个，全局 2 个；两个账号仍能占满全局名额；挂起解析只拖慢该账号自己。

验证：
- `npm run test:focus --workspace server -- mounts-manager` → 退出码 0。
- `npm run test:focus --workspace server -- mounts-` → 退出码 0（#1804 的已知 flake 单独重跑）。
- `make check` → 退出码 0。

## Risk packs

- Concurrency / shared state / ordering — selected：两级限流。由 2.1 覆盖：串行、并行、等待者（次序固定）、键不提前删除、全局上限。Map 是否泄漏只靠代码评审，manager 层无法观测。
- Resource limits — selected：线程池的上界仍为 2。由 2.1 的全局上限断言覆盖。
- Error handling / rollback / partial outputs — selected：每条落定路径都要释放名额。由 2.1 的释放用例覆盖。
- Documentation / migration notes — selected：3.1。
- Config、Schema、Auth、File IO、Public API — not selected：不加配置键，接口不变，路由行为不变。
