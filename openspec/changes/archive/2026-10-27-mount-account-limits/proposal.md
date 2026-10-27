## Why

挂载数量目前只有 `MOUNT_MAX_PER_WORKSPACE`（缺省 8）这一个上限，按工作空间计。正式空间的数量没有上限，主机解析之外也没有任何全局约束，所以 rclone 子进程的总数是无界的。一个普通账号可以：
- 建 N 个空间并把每个都挂满，让约 8N 个 rclone 常驻；
- 把主机填成黑洞 IP，每个空间就多一个在 20 s 就绪窗口里挂着的 rclone。

这样单个账号就能耗尽主机的进程数和内存，波及所有用户（#1789，来源是 PR #1787 的 security 评审）。

## What Changes

- 新增配置键 `MOUNT_MAX_PER_ACCOUNT`（缺省 `32`）：一个账号在全部空间里的挂载总数上限。
- 新增配置键 `MOUNT_MAX_ATTACHING_PER_ACCOUNT`（缺省 `2`）：一个账号同时在途的建出数上限。
- 两个键与 `MOUNT_MAX_PER_WORKSPACE` 采用同一套解析规则；超限时 `POST /api/workspaces/:id/mounts` 返回 409 `mount_limit`。
- Owner 裁定（2026-10-26，#1789 两条评论）：选 A，按账号设上限。原先拟的「全局在途 4」改为「按账号在途 2」：全局名额会被一个账号用黑洞主机一直占满，把别的账号挡在外面。不加全局在途上限。
- `mount_limit` 的文案从 `该工作空间的挂载数已达上限` 改为 `挂载数已达上限`。同一个码现在同时表示空间上限和账号上限，原文案对账号上限不成立。owner 裁定沿用 `mount_limit`，不新增码。
- MODIFIED：
  - workspace-mounts「挂载配置与启动预检」「挂载端点」；
  - http-service-skeleton「服务启动与装配」，挂载键由三个变为五个，应用配置由四十项变为四十二项；
  - http-service-skeleton「统一错误信封」，`mount_limit` 文案。

## Triage

```text
Issue type: feature (security hardening)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 挂载建出入口。少限则单账号耗尽进程；多限或计数泄漏则合法建出被永久 409（在途计数漏减即永久锁死该账号）
Selected risk packs: Resource limits / large input / discovery; Concurrency / shared state / ordering; Config / project setup; Error handling / rollback / partial outputs; Public API / CLI / script entry; Documentation / migration notes
Evidence floor: 配置解析与非法值；在途上限（挂起的就绪、跨账号不受影响、落定后释放：成功、502、取消、before 拒绝）；账号总数（跨空间、卸载释放、并发恰一个）；make check
```

## Impact

- 先 rebase 到 #1806 合入之后的 master。#1806 改写了 `startup-registry.ts` 的 `workspaceAssemblyOf`（解构、返回值、「五项」那段注释）和 `app.ts` 的 `protectedRootsOf`（紧挨着 `mountMaxOf`）。本 change 的 1.2、2.2 都以合入后的形状为准。

- `server/src/workspaces/mounts/config.ts`、`server/src/startup-registry.ts`（`workspaceAssemblyOf`）、`server/src/app.ts`（挂载路由的依赖）、`server/src/workspaces/mounts/{rest.ts,rest-mounts.ts,store.ts}`、`server/src/core/errors/index.ts`。
- `server/src/server.ts:129` 只改注释里的计数，不增行。
- server 测试、`docs/architecture/system.md`。
