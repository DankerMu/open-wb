## Why

挂载源路径的拒绝清单只有五个根，见 s1b design D2 和 workspace-mounts「挂载源端点」。管理员可以登记下面这些目录，一旦作为可写的 `local` 挂载交给 omp，omp 就能以 app uid 写入它们（#1786，来源是 PR #1785 的安全评审）：

- 部署仓库里的 `server/dist`、`node_modules`：服务代码，下次重启时以 app uid 执行；
- 配置在默认位置之外的 `PREVIEW_CACHE_DIR`、`OFFICE_SPOOL_DIR`：可以污染其他用户的预览；
- `dirname(BROWSER_BIN)`、`dirname(RCLONE_BIN)`：可以替换其中的可执行文件。

默认部署下 `STATIC_ROOT=<repo>/web/dist` 已经挡住了 repo 根和它的所有上级目录，但 `<repo>/server` 这类兄弟目录仍然可以登记。

## What Changes

- 保护根在原来五项之外加五项：仓库根、`PREVIEW_CACHE_DIR`、`OFFICE_SPOOL_DIR`（已配置时）、`dirname(BROWSER_BIN)`（已配置时）、`dirname(RCLONE_BIN)`（已配置时）。判定规则不变：realpath 相等、位于其内、包含它，一律拒绝。登记时检查一次，每次挂载尝试前再复核一次，两处用的是同一份列表。
- Owner 裁定（2026-10-26，#1786 评论）：选项 A。
- `docs/architecture/system.md` 的「挂载源端点」把拒绝清单从五项改为十项，并补一段升级说明：已登记、但落在新保护根内的挂载源，下一次挂载尝试会失败，挂载停在离线，由管理员删除这个挂载源。
- MODIFIED workspace-mounts「挂载源端点」。

## Triage

```text
Issue type: bugfix (security hardening)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 挂载源登记与 local 挂载的每次尝试。少拒则 omp 获得 app uid 的写入面；多拒则合法挂载源登记不了，或已有挂载离线
Selected risk packs: File IO / path safety / overwrite; Auth / permissions / secrets; Config / project setup; Legacy compatibility / examples; Documentation / migration notes
Evidence floor: 装配层用例证明 createApp 拼出的列表含十项且两处共用；REST 用例覆盖六个新根的 400；复核用例覆盖已登记源落入新根后尝试失败；make check
```

## Impact

- `server/src/app.ts`（`protectedRootsOf` 和 `AssemblyDependencies`）、`server/src/startup-registry.ts`（`workspaceAssemblyOf` 传入预览缓存和 spool 两项；`server.ts` 已有 799 行，size guard 的上限是 800，所以不改它）、`server/test/mounts-manager-assembly.test.ts` 和 `server/test/mounts-rest-helpers.ts`（`workspaceAssemblyOf` 的两处测试调用补传 `previewCacheDir`）、`server/src/workspaces/mounts/source-path.ts`（只改头注释）、server 测试、`docs/architecture/system.md`。
