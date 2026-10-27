## MODIFIED Requirements

### Requirement: 挂载源端点
`GET /api/mount-sources` SHALL 对所有已认证账号返回 200 `{sources}`，按 `name` 的 UTF-8 字节序：管理员（`isAdmin`）每项恰为 `{id, name, path, readOnly, createdAt}`，其他账号每项恰为 `{id, name, readOnly}`。`POST /api/mount-sources` 与 `DELETE /api/mount-sources/:id` 只对管理员开放，其他账号 403 `forbidden`（先于 body 解析与 id 判定）。

`POST` body SHALL 恰为 `{name, path, readOnly}`：`name` 1..64 个字符、不含 U+0000–U+001F 与 U+007F；`path` 为绝对路径，其 realpath 是存在的目录，且与下列保护根各自的 realpath 互不包含（相等、位于其内、包含它都拒绝）：`SANDBOX_ROOT`、`OMP_STATE_DIR`、`dirname(DB_PATH)`（内存库没有这一项）、`STATIC_ROOT`（提供前端时）、`dirname(OMP_BIN)`，以及仓库根（服务代码所在目录，即 `server/dist` 与 `node_modules` 所在的那一级）、`PREVIEW_CACHE_DIR`、`OFFICE_SPOOL_DIR`（已配置时）、`dirname(BROWSER_BIN)`（已配置时）、`dirname(RCLONE_BIN)`（已配置时）（#1786，owner 2026-10-26）；违反 400，已有 32 个挂载源 400，同名或同 realpath 409 `conflict`。存入的 `path` 是 realpath。引用它的 `local` 挂载每次挂载尝试之前 SHALL 重新取该 `path` 的 realpath 并复核：等于存入值、是存在的目录、与上述保护根互不包含，不过即该次尝试失败（「挂载进程与挂载点」）。成功 201 管理员视图与 `mount.source.create` 审计（`detail` `{sourceId, name, path, readOnly}`）。

`DELETE` SHALL 先在内存里把该挂载源标为删除中（此后引用它的建出请求在 `sourceId` 判定处 404），再对此刻引用它的每个挂载做「挂载进程与挂载点」的卸载并删除挂载行，各写一条 `mount.detach`（`reason` 为 `source_deleted`，actor 为该管理员，`workspaceId` 为该挂载的空间），最后在一个事务内删除挂载源行并写 `mount.source.delete`，返回 204；未知 id 404。「删除中」标记 SHALL 在 `finally` 里清除：连带卸载或最后的事务失败时 `DELETE` 以 generic 500 结束（唯一的例外同挂载端点的 `DELETE`：需要惰性卸载而进程 `PATH` 上没有 `fusermount3` 时为 503 `mount_disabled`）、挂载源行保留、标记已清，此后引用它的建出照常可用（已连带卸载的挂载行已删，其余照旧）。引用挂载源的建出 SHALL 在插行的事务里复核该源仍存在且未标删除，不成立即先卸载刚挂上的挂载、不插行，404 `not_found`。全部响应 `no-store`。

#### Scenario: 两种视图
- **WHEN** 管理员登记挂载源 `NFS 共享`（路径为一个符号链接，指向测试目录），普通用户与管理员分别 `GET /api/mount-sources`
- **THEN** 登记为 201，存入的 `path` 是目标目录的 realpath；普通用户的项恰三键、不含 `path`；管理员的项恰五键

#### Scenario: 拒绝的路径
- **WHEN** 管理员以相对路径、不存在的路径、一个普通文件、`SANDBOX_ROOT` 本身、`SANDBOX_ROOT` 之下的目录、`SANDBOX_ROOT` 的父目录、`OMP_STATE_DIR` 之下的目录、`STATIC_ROOT` 的父目录、`dirname(OMP_BIN)` 分别登记；普通用户以合法 body 登记
- **THEN** 前九例 400、没有行与审计；普通用户 403 `forbidden`
- **WHEN** 管理员分别登记仓库根之下的 `server` 目录、仓库根的父目录、配置在仓库外的 `PREVIEW_CACHE_DIR` 之下的目录、`OFFICE_SPOOL_DIR` 本身、`dirname(BROWSER_BIN)`、`dirname(RCLONE_BIN)`
- **THEN** 六例都 400，没有行与审计；与这些目录都互不包含的测试目录照常 201
- **WHEN** 一个挂载源在本次升级之前已登记、其 realpath 位于新的保护根之内（例如仓库外配置的 `PREVIEW_CACHE_DIR` 之下），引用它的 `local` 挂载随后发起挂载尝试
- **THEN** 没有 `mount` 调用，该次尝试失败（建出时 502 `mount_failed`，重挂时保持 `offline`）；挂载源行照旧列出，由管理员删除
- **WHEN** 一个已登记挂载源的路径在登记之后被换成指向 `SANDBOX_ROOT` 的符号链接，引用它的 `local` 挂载到期重挂
- **THEN** 没有 `mount` 调用，该挂载保持 `offline`

#### Scenario: 删除连带卸载
- **WHEN** 两个账号各有一个引用挂载源 S 的 `local` 挂载，管理员 `DELETE /api/mount-sources/<S>`
- **THEN** 204；两个挂载都已卸载、行与私有目录都不存在；审计有两条 `mount.detach`（`reason` `source_deleted`，`workspaceId` 各为其空间）与一条 `mount.source.delete`
