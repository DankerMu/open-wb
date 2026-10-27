## MODIFIED Requirements

### Requirement: 挂载配置与启动预检
五个配置键 SHALL 经 http-service-skeleton「服务启动与装配」的同一 pure config seam 解析，非法值的配置错误命名该键而不含输入值：

- `RCLONE_BIN`：缺省未配置，即挂载关闭；给出时 SHALL 为绝对路径（显式 empty、相对路径为配置错误）。
- `MOUNT_HOST_ALLOW`：缺省未配置，即不限主机；给出时 SHALL 为逗号分隔的主机名单，每项 1..253 字节、只含 ASCII 字母数字、`.`、`:`、`-`；显式 empty、任一空项、任一项含其它字符为配置错误。
- `MOUNT_MAX_PER_WORKSPACE`：缺省 `8`；与 `OMP_IDLE_MS` 同一解析纪律（canonical ASCII decimal 正整数 1..2147483647，empty / `0` / 非 canonical / 超限为配置错误）。
- `MOUNT_MAX_PER_ACCOUNT`：一个账号全部空间的挂载数上限，缺省 `32`；同一解析纪律（#1789，owner 2026-10-26）。
- `MOUNT_MAX_ATTACHING_PER_ACCOUNT`：一个账号同时在途的建出数上限，缺省 `2`；同一解析纪律（#1789）。

配置了 `RCLONE_BIN` 时，配置阶段 SHALL 另做启动预检，任一不过即配置错误（点名 `RCLONE_BIN`，启动以 `reason: "config"` 失败，不新增启动阶段）：`RCLONE_BIN` 是本进程可执行（`X_OK`）的普通文件；进程 `PATH` 的某一项下有可执行的 `fusermount3`（取第一个，记下其绝对路径，此后的卸载只用该路径）；进程 `PATH` 的某一项下有可执行的 `fusermount`（rclone 1.60.1 挂载时按 PATH 查找的是这个名字，#1665 P10；Ubuntu 的 fuse3 包把它装成指向 `fusermount3` 的符号链接）；`/dev/fuse` 存在（且为字符设备）；`OMP_USER` 已配置时 `/etc/fuse.conf` 存在且有一行去掉首尾空白后恰为 `user_allow_other`，并且以固定绝对路径 `/usr/bin/id -u -- <OMP_USER>` 得到一个十进制数值 uid（退出码非 0 或输出不是十进制整数即不过）；`OMP_USER` 已配置时，进程 `PATH` 各项下的每一个 `fusermount3` 与 `fusermount` SHALL 没有 other 执行位，且其属组不是 `/usr/bin/id -G -- <OMP_USER>` 输出的任何一个组（message 另写明 fusermount3 只能对 app 所在、omp 不在的组可执行）。未配置 `RCLONE_BIN` 时 SHALL NOT 检查任何 FUSE 前提，也 SHALL NOT 恢复或建立任何挂载；已登记的挂载照样载入内存登记，在 API 上一律 `offline`，新建为 503 `mount_disabled`，挂载内路径的文件端点为 409 `mount_offline`（「挂载目录内的文件端点」），卸载照常可用（需要惰性卸载时见「挂载进程与挂载点」），挂载源的三个端点照常可用。

#### Scenario: 缺省与覆盖
- **WHEN** 五键都未设置解析配置；另一例以 `MOUNT_HOST_ALLOW=files.intra,10.0.0.5`、`MOUNT_MAX_PER_WORKSPACE=3`、`MOUNT_MAX_PER_ACCOUNT=5`、`MOUNT_MAX_ATTACHING_PER_ACCOUNT=1` 解析
- **THEN** 前者挂载关闭、主机不限、上限依次为 8、32、2，且没有读取 `/dev/fuse` 与 `/etc/fuse.conf`；后者名单恰为这两项、上限依次为 3、5、1

#### Scenario: 非法值
- **WHEN** `RCLONE_BIN` 为 empty 或 `bin/rclone`；`MOUNT_HOST_ALLOW` 为 empty、`a,,b`、`a b`、`a/b`；`MOUNT_MAX_PER_WORKSPACE`、`MOUNT_MAX_PER_ACCOUNT`、`MOUNT_MAX_ATTACHING_PER_ACCOUNT` 各为 empty、`0`、`08`、`2147483648`
- **THEN** 每一例都在任何 filesystem / database / listen 副作用之前以 nonzero 退出，stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`；`resolveServerConfig` 抛出的 message 含该键名而不含输入值

#### Scenario: 预检
- **WHEN** 配置了 `RCLONE_BIN`，分别遇到：它不可执行；它是目录；PATH 上没有 `fusermount3`；PATH 上有 `fusermount3` 而没有 `fusermount`；`/dev/fuse` 不存在（经注入的路径）；`OMP_USER` 模式下 `fuse.conf` 没有 `user_allow_other`（含被注释的 `#user_allow_other`）；`OMP_USER` 模式下 `id` 以非 0 退出；`OMP_USER` 模式下 `fusermount3` 的模式为 `4755`；`OMP_USER` 模式下它为 `4750` 而属组是 omp 用户的一个组（经注入的 `id -G` 输出）；`OMP_USER` 模式下 PATH 上另有一个 `4755` 的 `fusermount`
- **THEN** 每一例都是配置错误、message 含 `RCLONE_BIN`；前提齐全时（`OMP_USER` 模式下 `fusermount3` 为 `4750` 且属组不在 omp 的组里）配置解析成功，记下的 `fusermount3` 是 PATH 上第一个可执行的那一个的绝对路径，`OMP_USER` 模式下记下 `id` 输出的数值 uid；`OMP_USER` 未配置时 `4755` 的 `fusermount3` 不是错误

### Requirement: 挂载端点
`GET /api/workspaces/:id/mounts` SHALL 返回 200 `{enabled, mounts}`：`enabled` 为是否配置了 `RCLONE_BIN`；`mounts` 为该空间的挂载按 `created_at, id` 升序，每项恰为 `{id, name, backend, host, port, remotePath, sourceId, sourceName, readOnly, status, createdAt}`（`sftp` / `smb` 的 `sourceId` 与 `sourceName` 为 null；`local` 的 `host`、`port`、`remotePath` 为 null，`sourceName` 为挂载源的名称；`status` 为 `online` 或 `offline`），不含任何凭证。

`POST /api/workspaces/:id/mounts` SHALL 建出并首次挂载（这一次挂载即连通测试），成功返回 201 与该挂载的视图（`status: "online"`）。判定次序：未认证 401 → 空间不属本人或不存在 404 → 未配置 `RCLONE_BIN` 503 `mount_disabled`（这三者在 body 解析之前）→ content-parser 错误 400 → 「挂载取值与主机规则」的键集与取值 400 → 临时空间 400 `bad_request` → 该账号在途的建出已有 `MOUNT_MAX_ATTACHING_PER_ACCOUNT` 个 409 `mount_limit` → 该账号的挂载行数加上它在途的建出数已达 `MOUNT_MAX_PER_ACCOUNT` 409 `mount_limit`（这两项与在途计数的加一在同一个同步段内完成，中间没有 `await`；在途从这一步起算，到该次建出以成功、失败或取消落定为止，落定即减一）→ 该空间已有 `MOUNT_MAX_PER_WORKSPACE` 个挂载 409 `mount_limit` → `local` 的 `sourceId` 未登记 404、挂载源只读而 `readOnly` 为 false 400 → 同名挂载已存在或空间根下已有同名条目 409 `conflict` → 主机规则 403 `mount_host_rejected`（主机解析失败 502 `mount_failed`）→ 写凭证文件、建挂载点并检查（挂载点或挂载源复核不过 502 `mount_failed`）、启动子进程并等待就绪（失败 502 `mount_failed`）→ 同一事务内插入挂载行与 `mount.attach` 审计；插行或审计失败 SHALL 先卸载再 generic 500。

`DELETE /api/workspaces/:id/mounts/:mountId` SHALL 卸载、删除挂载行并写 `mount.detach` 审计后返回 204；`mountId` 不属于该空间、空间不属本人或不存在 → 404。未配置 `RCLONE_BIN` 时它同样可用，唯一的例外是需要惰性卸载而进程 `PATH` 上没有 `fusermount3`（503 `mount_disabled`，见「挂载进程与挂载点」）。它不读取 body。

同一空间的建出与卸载 SHALL 按「挂载操作的串行与取消」串行执行。三个端点都 `no-store`。审计：`mount.attach`（`title` `挂载目录 <name>`，`detail` `{mountId, name, backend, host, port, remotePath, sourceId, readOnly}`）、`mount.detach`（`title` `卸载挂载点 <name>`，`detail` `{mountId, name, reason}`，用户卸载时 `reason` 为 `user`）、`mount.reject`（`title` `挂载被拒绝：<name>`，`detail` `{name, backend, host, port, remotePath, sourceId, reason}`，`reason` 为 `host_rejected` 或 `mount_failed`，`workspaceId` 为请求的空间）；`detail` 里没有的键取 null。

#### Scenario: 建出、列举与卸载
- **WHEN** zhangsan 以假 rclone 对自己的正式空间 `POST` 一个可写 `sftp` 挂载 `数据仓库导出`（主机解析为非环回地址），再 `GET …/mounts`，再 `DELETE …/mounts/<id>`
- **THEN** 依次为 201（`status` `online`）、200（`enabled` true，`mounts` 恰一项、与 201 的视图逐键相同、不含 `username` / `password`）、204；审计依次有 `mount.attach`（`title` `挂载目录 数据仓库导出`）与 `mount.detach`（`reason` `user`）；最后 `GET` 的 `mounts` 为空、挂载点目录不存在

#### Scenario: 次序与拒绝
- **WHEN** 匿名请求；lisi 对 zhangsan 的空间请求；未配置 `RCLONE_BIN` 时请求；对临时空间请求；空间已有 8 个挂载时请求；`sourceId` 未登记；挂载源只读而 `readOnly` false；空间根下已有目录 `报表` 时以 `报表` 为名请求
- **THEN** 依次为 401、404、503 `mount_disabled`、400、409 `mount_limit`、404、400、409 `conflict`；都没有子进程被启动、没有挂载行与审计行增加（主机规则之前的拒绝不写 `mount.reject`）

#### Scenario: 插行失败先卸载
- **WHEN** 挂载就绪之后插入挂载行失败（测试把该表换成同名只读视图）
- **THEN** generic 500；假 `fusermount3` 收到一次 `-uz`、假 rclone 进程已退出、私有目录与挂载点都不存在

#### Scenario: 并发建出受上限约束
- **WHEN** `MOUNT_MAX_PER_WORKSPACE=1`，对同一空间同时发出两个合法的建出请求
- **THEN** 恰一个 201、另一个 409 `mount_limit`；恰一个假 rclone 进程在运行

#### Scenario: 功能关闭时的已登记挂载
- **WHEN** 未配置 `RCLONE_BIN`，DB 里同一空间有挂载 `甲` 与 `乙`，`乙` 的挂载点在（假）mountinfo 里；依次 `GET …/mounts`、`POST …/mounts`、`DELETE …/mounts/<甲>`；PATH 上没有 `fusermount3` 时 `DELETE …/mounts/<乙>`；PATH 上放入假 `fusermount3` 后再 `DELETE …/mounts/<乙>`
- **THEN** `GET` 为 200，`enabled` false、两项都是 `offline`；`POST` 503 `mount_disabled`；删 `甲` 204；第一次删 `乙` 503 `mount_disabled`、行与私有目录都还在、服务错误通道恰有一条点名缺少 `fusermount3` 的记录；第二次删 `乙` 204，假 `fusermount3` 恰收到一次 `-uz <乙的挂载点>`；全程没有假 rclone 调用

#### Scenario: 账号在途上限
- **WHEN** `MOUNT_MAX_ATTACHING_PER_ACCOUNT=1`，zhangsan 在空间 A 发出一个建出，假 rclone 被设定为就绪前挂起；此时 zhangsan 在空间 B 再发一个建出，lisi 在自己的空间发一个建出；随后让 A 的建出以就绪失败（502）落定，zhangsan 在 B 再发一次
- **THEN** zhangsan 在 B 的第一次为 409 `mount_limit`，没有子进程被启动、没有 `mount.reject`；lisi 的为 201；A 落定为 502 之后，zhangsan 在 B 的第二次为 201

#### Scenario: 账号总数上限
- **WHEN** `MOUNT_MAX_PER_ACCOUNT=2`，zhangsan 在空间 A、B 各建出一个挂载后在空间 C 再建出；lisi 照常建出；zhangsan 卸载 A 的挂载后在 C 再建出；另一例 `MOUNT_MAX_PER_ACCOUNT=1`、`MOUNT_MAX_ATTACHING_PER_ACCOUNT=2`，zhangsan 对两个不同空间同时发出两个合法的建出
- **THEN** C 的第一次为 409 `mount_limit`，lisi 为 201，卸载之后 C 为 201；同时发出的两个恰一个 201、另一个 409 `mount_limit`，恰一个假 rclone 进程在运行
