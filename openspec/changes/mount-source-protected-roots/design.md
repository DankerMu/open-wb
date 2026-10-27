## Design

Change surface:
- `server/src/app.ts` 的 `protectedRootsOf`：来源是 `createApp` 的 db、runtime、staticRoot 和 assembly。
- `AssemblyDependencies` 新增一个可选字段 `extraProtectedRoots?: readonly string[]`，承载 `createApp` 自己推不出的部署目录。
- `server/src/startup-registry.ts` 的 `workspaceAssemblyOf` 填这个字段：`WorkspaceAssemblyConfig` 加上 `previewCacheDir` 和可选的 `officeSpoolDir`，返回 `extraProtectedRoots: [previewCacheDir, ...(officeSpoolDir 已配置 ? [officeSpoolDir] : [])]`。`appAssemblyOf` 通过展开拿到这个字段。`server.ts` 一行不改：它已有 799 行，size guard 的上限是 800。

Must preserve:
- 原来的五项和判定规则（`acceptableSourcePath`，`source-path.ts`）不变。
- 登记路由（`mounts/rest.ts:134`）和挂载尝试前的复核（`mounts/attempt.ts:176`）继续共用 `createApp` 里同一份 `protectedRoots`（`app.ts:278-279,346`）。
- 不经 `workspaceAssemblyOf` 的装配（直接调用 `createApp` 的测试）没有 `extraProtectedRoots`，只是少了这两项，其余照常。
- 与这些目录互不包含的挂载源照常登记。
- `GET /api/mount-sources` 不变，已登记的行不会被自动删掉。

Must add/change：`protectedRootsOf` 返回下列十项（条件不满足的项省略）：
1. `runtime.sandboxRoot`
2. `runtime.stateDir`
3. `dirname(DB 文件)`
4. `staticRoot`
5. `dirname(runtime.bin)`。三个二进制根（omp、浏览器、rclone）都同时取 `dirname(bin)` 和 `dirname(realpath(bin))`。realpath 解析不出来时只省略后者。原因是符号链接形式的二进制，宿主实际执行的是链接目标（PR #1806 round 1 security P2）
6. 仓库根：`app.ts:251` 已有的 `repoRoot`（`new URL("../../", import.meta.url)`），与 `server.ts` 的 `repoRootOf` 推出的是同一个目录。
7. `dirname(runtime.browserBin)`：已配置时。
8. `dirname(assembly.mountSettings.rcloneBin)`：已配置时。
9. 10. `...assembly.extraProtectedRoots`：预览缓存目录，以及已配置的 spool 目录。

Governing invariant：凡是 omp uid 能借一个可写 `local` 挂载、以 app uid 身份写入的服务器目录，都不能是服务自身的代码、私有状态、共享缓存，也不能是宿主据以执行的 omp、浏览器、rclone 二进制所在目录。例外是 `fusermount3`：它从 PATH 解析（`mounts/config.ts`），通常在 root 拥有的 `/usr/bin` 里，app uid 本来就写不进去，所以 owner 的清单没有列它。

Sibling surfaces:
- 登记与复核共用一份列表，不复制第二份。
- `mounts-manager-helpers.ts` 和 `mount-sources-rest.test.ts` 自己拼列表，测的是规则本身，不经过装配。本次的装配层测试要直接测 `createApp` 拼出来的列表。
- 下列几项不在这次范围里：
  - `fusermount3` 的目录：issue 未列。
  - `OMP_USER` 的 home：不在服务器上。
  - kbservice 的目录：属另一个服务，经网络契约访问。

Seams under test:
1. 装配层：经 `createApp` 真实装配后 `POST /api/mount-sources`，并经 `server.ts` 的 `appAssemblyOf(config)` 检查 `extraProtectedRoots`。
2. 复核：已登记的源落进新的保护根后，引用它的 `local` 挂载尝试失败，测到 manager 或 REST 层。

Required evidence:
- `createApp` 带 runtime（含 `browserBin`）、`mountSettings.rcloneBin`、`extraProtectedRoots`。浏览器和 rclone 的可执行文件要复制到测试自己的 tmp base 下，也就是仓库之外，并且两者所在目录彼此不包含、与其它保护根也不包含。现有的 `server/test/fixtures/fake-rclone.mjs` 位于仓库根之下，如果直接用它，对应那条 400 实际是被仓库根挡下的，证明不了 `dirname(rcloneBin)` 这一项生效：
  - 分别以下列路径登记，都返回 400，没有行，没有审计：`<repoRoot>/server`、`dirname(repoRoot)`、预览缓存之下的目录、spool 本身、`dirname(browserBin)`、`dirname(rcloneBin)`；
  - 同一装配下，一个 tmp 测试目录返回 201。
- 缺席时省略，三项各写一例：
  - runtime 没有 `browserBin`；
  - `mountSettings` 没有 `rcloneBin`：功能关闭时挂载源端点照常可用；
  - 不传 `extraProtectedRoots`。
  每例都把原本会落在那个保护根上的 tmp 目录拿去登记，期望 201。这证明列表里没有混进 `undefined`：`resolve(undefined)` 会抛错，所有登记都变成 500。`extraProtectedRoots` 里不含 `""`，由 `appAssemblyOf` 的精确断言证明。两个 `dirname` 根退化成 `dirname("") = "."`（cwd）这种情况，测试测不出来：vitest 的 cwd 在仓库根内，本来就受保护。这一点靠代码里的 `=== undefined` 判断加展开写法保证（PR #1806 round 1 test-evidence P2，按收窄措辞处理）。
- `workspaceAssemblyOf` 或 `appAssemblyOf(config)`：配了 `OFFICE_SPOOL_DIR` 时，`extraProtectedRoots` 恰为 `[previewCacheDir, officeSpoolDir]`；没配时恰为 `[previewCacheDir]`。
- 升级场景：在 DB 里直接插入一行挂载源，路径位于 `extraProtectedRoots` 之内，再建出一个引用它的 `local` 挂载。结果为 502 `mount_failed`，没有 `mount` 调用（假 rclone 没有被 spawn）。
- 先在改前的代码上跑一次，确认新增用例为红：六例返回 201。

Residual：
- 包装脚本再 exec 别处的程序时，不跟到那个程序。
- app uid 自己的 `HOME`（如 `~/.ssh`、shell rc）和 `dirname(process.execPath)`（如 nvm 装的 node）不在清单里，这是 owner 选项 A 的范围。参考镜像里这些目录都属 root 或不可写。
- realpath 认不出 bind-mount 的别名，所有根都有这个限制。

Non-goals：
- 不自动删除已登记、但现在被拒的挂载源。
- 不新增配置键。
- 不改动判定算法。
- 不处理 `fusermount3` 的目录。

Review focus:
- 登记和复核两处是否真的用同一份列表。
- 仓库根取值在 dev（tsx，`server/src`）和 prod（`server/dist`）下是否一致。
- 缺席的配置项是省略而不是 `undefined` 或空串：`resolve("")` 等于 cwd，会把 cwd 误当成保护根。
- 升级说明是否写进了 system.md。
