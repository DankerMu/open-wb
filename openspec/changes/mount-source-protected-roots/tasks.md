## 1. 保护根扩充

- [x] 1.1 `app.ts`：
  - `AssemblyDependencies` 加可选字段 `extraProtectedRoots?: readonly string[]`，注释写明它承载 `createApp` 自己推不出的部署目录。
  - `protectedRootsOf` 加四类来源：仓库根（复用 `app.ts:251` 的 `repoRoot`）、`dirname(runtime.browserBin)`（已配置时）、`dirname(mountSettings.rcloneBin)`（已配置时）、`extraProtectedRoots`。
  - 头注释的「五个根」改为列全十项。
- [x] 1.2 `startup-registry.ts` 的 `workspaceAssemblyOf`：`WorkspaceAssemblyConfig` 加 `previewCacheDir`、`officeSpoolDir?`，返回值加 `extraProtectedRoots: [previewCacheDir, ...(spool 已配置 ? [spool] : [])]`。它的两处测试调用 `server/test/mounts-manager-assembly.test.ts:210` 和 `server/test/mounts-rest-helpers.ts:154`（`openBuilt`）补传 `previewCacheDir`，取 world 的挂载源之外的目录（例如 `join(world.base, "preview-cache")`，不能用 `world.base` 本身），否则 `mounts-rest-hosts` 的登记会被新根拒绝。`server.ts` 不改，它已有 799 行，size guard 的上限是 800。
- [x] 1.3 `mounts/source-path.ts`：头注释的根列表与 1.1 一致，算法不改。
- [x] 1.4 测试，按 design「Required evidence」：
  - 装配层登记：六个新根各返回 400，没有行、没有审计；tmp 测试目录返回 201。浏览器和 rclone 的可执行文件复制到仓库外的 tmp base 下，两者目录彼此不包含，也不与其它根包含。
  - 缺席项被省略，三例：没有 `browserBin`、没有 `rcloneBin`、没有 `extraProtectedRoots`。每例里原本会落在该根上的 tmp 目录都返回 201。
  - `workspaceAssemblyOf` 的 `extraProtectedRoots`：有 spool 和没有 spool 两种情况。
  - 升级场景：已登记的源落入新根后，挂载尝试返回 502，且没有 spawn。
  - 用例放在现有的 assembly 或 startup 测试文件旁边，文件行数守卫要过。
  - 新增用例先在改前的代码上跑一次，确认为红，并在报告里贴出输出。
- [x] 1.5 `docs/architecture/system.md`「挂载源端点」：拒绝清单改为十项，每项写一句理由；加一段升级说明：已登记但落入新根的源，下一次挂载尝试失败、挂载保持离线，由管理员删除。

验证：
- `npm run test:focus --workspace server -- mount-sources-rest mounts-manager-assembly server-startup-mounts` → 退出码 0。按实际新增或修改的文件补全文件名。
- `npm run test:focus --workspace server -- mounts-` → 退出码 0，跑 mounts 全族回归。
- `make check` → 退出码 0。

## Risk packs

- File IO / path safety / overwrite — selected：由 1.4 的六个 400 用例和升级场景用例覆盖。
- Auth / permissions / secrets — selected：omp uid 拿到 app uid 写入面是这次要堵的威胁。由 1.4 覆盖，判定规则本身不变。
- Config / project setup — selected：配置缺席的项要省略，不能混进 `undefined` 或 `""`（`resolve("")` 会解析成 cwd）。由 1.4 的缺席用例和 `appAssemblyOf` 用例覆盖。
- Legacy compatibility / examples — selected：已登记的源可能落进新的根。由 1.4 的升级场景用例和 1.5 的升级说明覆盖。
- Documentation / migration notes — selected：1.5。
- Schema、Concurrency、Resource limits、Release — not selected：不改 schema，没有新的并发路径，不涉及资源上限和发布。
