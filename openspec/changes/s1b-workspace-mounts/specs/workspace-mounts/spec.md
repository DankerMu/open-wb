# workspace-mounts Spec Delta

## Purpose
定义把远程目录（SFTP、SMB）与管理员登记的服务器目录以 rclone FUSE 挂载进正式工作空间根下的能力：数据与配置、取值与主机规则、凭证文件、挂载进程与在线状态、服务启停、挂载与挂载源端点、挂载目录内文件端点的拒绝规则，以及文件页与侧边栏的挂载根行与挂载对话框。

## ADDED Requirements

### Requirement: 迁移 049 挂载 schema
迁移 `049_workspace_mounts.sql` SHALL 建立两张表，受信任迁移目录计数断言随之 +1：

- `mount_sources(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, read_only INTEGER NOT NULL, created_at INTEGER NOT NULL)`：`id` 为 32 位小写十六进制；`name` 1..64 个字符且不含 U+0000–U+001F 与 U+007F；`path` 以 `/` 开头；`read_only` 只取 0 或 1。
- `workspace_mounts(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, owner_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, backend TEXT NOT NULL, host TEXT NULL, port INTEGER NULL, remote_path TEXT NULL, source_id TEXT NULL REFERENCES mount_sources(id) ON DELETE RESTRICT, read_only INTEGER NOT NULL, created_at INTEGER NOT NULL)`，`UNIQUE(workspace_id, name)`：`id` 为 32 位小写十六进制；`name` 满足 workspaces「工作空间 schema」对 `dir` 的字符规则（只含 ASCII 字母数字、下划线、连字符与 CJK 统一表意文字，长度 1..64，不为 `.` / `..`）且不是保留名 `uploads` 或 `screenshots`；`backend` 只取 `sftp`、`smb`、`local`；`port` 为 NULL 或 1..65535；`read_only` 只取 0 或 1；并且恰为两种形状之一——`backend = 'local'` 时 `source_id` 非空且 `host`、`port`、`remote_path` 为空，`backend` 为 `sftp` / `smb` 时 `source_id` 为空且 `host`、`remote_path` 非空。

两张表都 SHALL NOT 有任何保存用户名、口令、私钥或域的列，也 SHALL NOT 有在线状态列。

#### Scenario: 形状约束
- **WHEN** 分别插入 `backend='local'` 而 `source_id` 为空、`backend='sftp'` 而 `host` 为空、`backend='sftp'` 而同时带 `source_id`、`backend='nfs'`、`name='uploads'`、`name='screenshots'`、`name='a/b'`、`port=0` 的挂载行，以及同一空间两个同名挂载
- **THEN** 每一条都被约束拒绝；合法的 `sftp` 行与引用一个挂载源的 `local` 行插入成功

#### Scenario: 被引用的行不能先删
- **WHEN** 一个空间有一条挂载行、一个挂载源被一条挂载行引用，直接删除该空间行与该挂载源行
- **THEN** 两次删除都因外键失败，两行都还在

#### Scenario: 表里没有凭证
- **WHEN** 读取迁移后两张表的列名
- **THEN** 列名集合恰为上文所列，不含 `user`、`pass`、`password`、`key`、`domain`、`status` 一类列

### Requirement: 挂载配置与启动预检
三个配置键 SHALL 经 http-service-skeleton「服务启动与装配」的同一 pure config seam 解析，非法值的配置错误命名该键而不含输入值：

- `RCLONE_BIN`：缺省未配置，即挂载关闭；给出时 SHALL 为绝对路径（显式 empty、相对路径为配置错误）。
- `MOUNT_HOST_ALLOW`：缺省未配置，即不限主机；给出时 SHALL 为逗号分隔的主机名单，每项 1..253 字节、只含 ASCII 字母数字、`.`、`:`、`-`；显式 empty、任一空项、任一项含其它字符为配置错误。
- `MOUNT_MAX_PER_WORKSPACE`：缺省 `8`；与 `OMP_IDLE_MS` 同一解析纪律（canonical ASCII decimal 正整数 1..2147483647，empty / `0` / 非 canonical / 超限为配置错误）。

配置了 `RCLONE_BIN` 时，配置阶段 SHALL 另做启动预检，任一不过即配置错误（点名 `RCLONE_BIN`，启动以 `reason: "config"` 失败，不新增启动阶段）：`RCLONE_BIN` 是本进程可执行（`X_OK`）的普通文件；进程 `PATH` 的某一项下有可执行的 `fusermount3`（取第一个，记下其绝对路径，此后的卸载只用该路径）；进程 `PATH` 的某一项下有可执行的 `fusermount`（rclone 1.60.1 挂载时按 PATH 查找的是这个名字，#1665 P10；Ubuntu 的 fuse3 包把它装成指向 `fusermount3` 的符号链接）；`/dev/fuse` 存在（且为字符设备）；`OMP_USER` 已配置时 `/etc/fuse.conf` 存在且有一行去掉首尾空白后恰为 `user_allow_other`，并且以固定绝对路径 `/usr/bin/id -u -- <OMP_USER>` 得到一个十进制数值 uid（退出码非 0 或输出不是十进制整数即不过）；`OMP_USER` 已配置时，进程 `PATH` 各项下的每一个 `fusermount3` 与 `fusermount` SHALL 没有 other 执行位，且其属组不是 `/usr/bin/id -G -- <OMP_USER>` 输出的任何一个组（message 另写明 fusermount3 只能对 app 所在、omp 不在的组可执行）。未配置 `RCLONE_BIN` 时 SHALL NOT 检查任何 FUSE 前提，也 SHALL NOT 恢复或建立任何挂载；已登记的挂载照样载入内存登记，在 API 上一律 `offline`，新建为 503 `mount_disabled`，挂载内路径的文件端点为 409 `mount_offline`（「挂载目录内的文件端点」），卸载照常可用（需要惰性卸载时见「挂载进程与挂载点」），挂载源的三个端点照常可用。

#### Scenario: 缺省与覆盖
- **WHEN** 三键都未设置解析配置；另一例以 `MOUNT_HOST_ALLOW=files.intra,10.0.0.5`、`MOUNT_MAX_PER_WORKSPACE=3` 解析
- **THEN** 前者挂载关闭、主机不限、上限 8，且没有读取 `/dev/fuse` 与 `/etc/fuse.conf`；后者名单恰为这两项、上限 3

#### Scenario: 非法值
- **WHEN** `RCLONE_BIN` 为 empty 或 `bin/rclone`；`MOUNT_HOST_ALLOW` 为 empty、`a,,b`、`a b`、`a/b`；`MOUNT_MAX_PER_WORKSPACE` 为 empty、`0`、`08`、`2147483648`
- **THEN** 每一例都在任何 filesystem / database / listen 副作用之前以 nonzero 退出，stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`；`resolveServerConfig` 抛出的 message 含该键名而不含输入值

#### Scenario: 预检
- **WHEN** 配置了 `RCLONE_BIN`，分别遇到：它不可执行；它是目录；PATH 上没有 `fusermount3`；PATH 上有 `fusermount3` 而没有 `fusermount`；`/dev/fuse` 不存在（经注入的路径）；`OMP_USER` 模式下 `fuse.conf` 没有 `user_allow_other`（含被注释的 `#user_allow_other`）；`OMP_USER` 模式下 `id` 以非 0 退出；`OMP_USER` 模式下 `fusermount3` 的模式为 `4755`；`OMP_USER` 模式下它为 `4750` 而属组是 omp 用户的一个组（经注入的 `id -G` 输出）；`OMP_USER` 模式下 PATH 上另有一个 `4755` 的 `fusermount`
- **THEN** 每一例都是配置错误、message 含 `RCLONE_BIN`；前提齐全时（`OMP_USER` 模式下 `fusermount3` 为 `4750` 且属组不在 omp 的组里）配置解析成功，记下的 `fusermount3` 是 PATH 上第一个可执行的那一个的绝对路径，`OMP_USER` 模式下记下 `id` 输出的数值 uid；`OMP_USER` 未配置时 `4755` 的 `fusermount3` 不是错误

### Requirement: 挂载取值与主机规则
`POST /api/workspaces/:id/mounts` 的 body SHALL 是 JSON 对象，键集按 `backend` 严格（多键、缺键、类型不符均为 400 `bad_request`，message 不含任何取值）：

- `sftp`：`{name, backend, host, port?, remotePath, readOnly, username, password?, privateKey?}`，`password` 与 `privateKey` 恰有一个；
- `smb`：`{name, backend, host, port?, remotePath, readOnly, username, password, domain?}`；
- `local`：`{name, backend, sourceId, readOnly}`。

取值：`name` 同迁移 049 的挂载名规则（含不是保留名 `uploads` 或 `screenshots`）；`readOnly` 为布尔；`host` 1..253 字节、只含 ASCII 字母数字、`.`、`:`、`-` 且不以 `-` 开头；`port` 为整数 1..65535；`remotePath` 以 `/` 开头、≤1024 字节、不含 U+0000–U+001F 与 U+007F，`smb` 另要求开头的 `/` 之后至少有一段（共享名）；`username` 1..256 个字符、`password` 1..1024 个字符、`domain` 1..64 字节且只含 ASCII 字母数字与 `.`、`_`、`-`，三者都不含 U+0000–U+001F 与 U+007F、没有首尾空白；`privateKey` ≤16384 字节、以 `-----BEGIN ` 开头、只含可打印 ASCII 与换行；`sourceId` 为 32 位小写十六进制。

主机规则 SHALL 在 `sftp` 与 `smb` 的每一次挂载尝试（建出时，以及每一次重挂）之前判定，任一命中即拒绝：

1. 规范化：`host` 转小写并去掉末尾的全部 `.`；下面各步与名单比较都用规范化后的串，名单项同样规范化。
2. 字面环回：等于 `localhost` 或以 `.localhost` 结尾；或是 IP 字面（IPv4 点分十进制，或任一 IPv6 写法）而地址值属于 `127.0.0.0/8`、`0.0.0.0`、`::1`、`::`，或是 IPv4 映射地址而其 IPv4 属于前两者。
3. `MOUNT_HOST_ALLOW` 已配置且规范化后的 `host` 不等于名单中的任何一项。名单只按字符串比较，不比较解析结果。
4. 系统解析器对 `host` 的全部解析结果中任一属于第 2 步的地址。解析失败或结果为空 SHALL 使该次尝试失败（建出时 502 `mount_failed` 并写 `mount.reject`，`reason` 为 `mount_failed`；重挂时保持 `offline`），不启动子进程。

全部通过时，第一个解析结果（IP 字面）SHALL 写进该次尝试的 `rclone.conf` 的 `host`（「挂载凭证文件」），rclone 不再自行解析主机；argv SHALL NOT 带 `--sftp-host`、`--smb-host` 或任何其它后端覆盖参数。该地址 SHALL 记在内存里，供「在线状态与重挂」的连通检查。`local` 挂载不经主机规则。建出时被拒 SHALL 为 403 `mount_host_rejected`；重挂时被拒 SHALL 使该挂载保持 `offline`。

#### Scenario: 键集与取值
- **WHEN** 分别提交：`sftp` 同时带 `password` 与 `privateKey`；`sftp` 两者都不带；`smb` 带 `privateKey`；`local` 带 `host`；`name` 为 `uploads`、`screenshots`、`a.b`、65 个字符；`remotePath` 为 `srv/data`；`smb` 的 `remotePath` 为 `/`；`port` 为 `0` 与 `"22"`；`password` 含换行且带一个哨兵子串
- **THEN** 每一例都是 400 `bad_request`；响应与审计里都没有那个哨兵；没有私有目录、挂载点或子进程被建出

#### Scenario: 环回一律拒绝
- **WHEN** 以 `host` 为 `localhost`、`LOCALHOST`、`localhost.`、`LOCALHOST.`、`a.localhost`、`a.localhost.`、`127.0.0.1`、`127.9.9.9`、`::1`、`0:0:0:0:0:0:0:1`、`::ffff:127.0.0.1`、`0.0.0.0`、`2130706433`，以及一个被测试解析器解析为 `127.0.0.1` 的 `files.intra` 分别提交合法的 `sftp` 挂载
- **THEN** 每一例都是 403 `mount_host_rejected`，各写一条 `mount.reject`（`reason` 为 `host_rejected`，`workspaceId` 为该空间）；没有子进程被启动

#### Scenario: 解析失败不启动子进程
- **WHEN** 以一个测试解析器解析失败的 `nowhere.intra` 提交合法的 `sftp` 挂载；另一个在线 `sftp` 挂载重挂时其主机解析失败
- **THEN** 前者 502 `mount_failed` 与一条 `mount.reject`（`reason` 为 `mount_failed`），没有子进程、私有目录与挂载点；后者保持 `offline`、没有 `mount` 调用，按退避再试

#### Scenario: 许可名单
- **WHEN** `MOUNT_HOST_ALLOW=files.intra`，分别以 `FILES.INTRA`、`files.intra.` 与 `other.intra` 提交合法的 `sftp` 挂载（三者都解析到非环回地址）
- **THEN** 前两者进入挂载流程；后者 403 `mount_host_rejected`
- **WHEN** 一个在线的 `sftp` 挂载的主机不在新名单里，服务以该名单重启
- **THEN** 启动恢复时该挂载不被挂上、状态为 `offline`；启动本身成功

### Requirement: 挂载凭证文件
每个挂载 SHALL 有一个 app 私有目录 `<OMP_STATE_DIR 的 realpath>/mounts/<挂载 id>/`（`0700`，以 sandbox-core「托管目录权限位」的 `ensureOwnedDir` 语义建立：属本进程、不是符号链接），其中：

- `rclone.conf`（`0600`）：一个段，段名为 `m` 加挂载 id（下称 `<段名>`）。`sftp` 为 `type = sftp`、`host`（该次尝试经主机规则判定过的 IP 字面；IPv6 SHALL 写成 `[<地址>]`——rclone 1.60.1 拨号时不给 IPv6 加方括号）、`port`（给了才写）、`user`（值 SHALL 用反引号包起来，使 rclone 的 INI 解析原样读回）与 `pass`（口令的 obscure 串）或 `key_pem`（私钥的换行转写为字面 `\n` 的单行）；`smb` 为 `type = smb`、`host`（同上）、`port`（给了才写）、`user`、`pass`（obscure 串）、`domain`（给了才写）；`local` 只有 `type = local`。`sftp` / `smb` 建出时随整份文件写出 `host`；重挂与启动恢复 SHALL 在主机规则判定之后、启动子进程之前改写 `host` 一行：读回现有文件、只替换 `host` 的值、写同目录临时名再改名到位（`0600`），其余字节不变；用户填的主机只在数据库的 `host` 列里，每次尝试都从它重新判定。
- `cache/`（`0700`）：rclone 的 VFS 缓存目录。
- `rclone.log`（`0600`）：rclone 的日志文件；每次挂载尝试之前由本进程以 sandbox-core「托管文件权限位」的语义确保它存在且为 `0600`。

口令 SHALL 经 `<RCLONE_BIN> obscure -` 处理：口令只经该子进程的标准输入写入，obscure 串从其标准输出读回，10 s 内未结束即杀掉并按挂载失败处理。`rclone.conf` SHALL 先写入同目录的临时名再改名到位。凭证（用户名、口令、私钥、域及口令的 obscure 串）SHALL NOT 出现在：数据库任何表、任何 HTTP 响应、审计 `title` 与 `detail`、application stdout / stderr、错误 message、任何子进程的 argv、任何子进程的环境。没有任何端点读回凭证。卸载 SHALL 递归删除该挂载的整个私有目录。

#### Scenario: 文件形状与权限
- **WHEN** 以假 rclone 成功建出一个带口令哨兵的 `sftp` 挂载与一个带私钥哨兵的 `sftp` 挂载
- **THEN** 两个私有目录都是 `0700`、属本进程；`rclone.conf` 为 `0600`，前者的 `pass` 等于假 rclone 对该哨兵的 obscure 结果、整个文件不含哨兵原文，后者的 `key_pem` 为私钥的单行转写；`<OMP_STATE_DIR>/mounts` 为 `0700`

#### Scenario: 凭证不外泄
- **WHEN** 上例之后读取 `GET …/mounts`、`GET /api/audit`、application stdout / stderr，以及假 rclone 记录下的每次调用的 argv 与环境
- **THEN** 都不含用户名哨兵、口令哨兵、私钥哨兵与 obscure 串；假 rclone 记录的 `obscure` 调用从标准输入收到口令哨兵，`mount` 调用的 argv 只经 `--config` 指向 `rclone.conf`

#### Scenario: 重挂改写主机
- **WHEN** 一个 `sftp` 挂载（主机 `files.intra`）建出时测试解析器返回 `10.0.0.7`；它的假 rclone 随后被 SIGKILL，到期重挂时解析器返回 `10.0.0.8`
- **THEN** 建出后 `rclone.conf` 的 `host` 为 `10.0.0.7`；重挂的 `mount` 调用之前它变为 `10.0.0.8`，其余行逐字节不变、文件仍为 `0600`；两次 `mount` 的 argv 都不含 `--sftp-host`；数据库与 `GET …/mounts` 的 `host` 仍为 `files.intra`

#### Scenario: 卸载删除私有目录
- **WHEN** 卸载上例的挂载
- **THEN** 该挂载的私有目录及其中的 `rclone.conf`、`cache/`、`rclone.log` 都不存在；`<OMP_STATE_DIR>/mounts` 仍在

### Requirement: 挂载进程与挂载点
挂载点 SHALL 是 `<空间根>/<挂载名>`，只在空间根下一层；每次挂载尝试之前 SHALL 先不跟随符号链接地 `lstat` 它：不存在时才以 `ensureSharedDir` 建出（新建为 `0o2770`）并再 `lstat` 一次；存在时（或建出之后）它 SHALL 是目录、不是符号链接、属本进程 uid——否则该次尝试 SHALL 失败（建出时 502 `mount_failed` 并写 `mount.reject`，重挂时保持 `offline`），不启动子进程；其中有残留条目不算失败。`local` 挂载在每次尝试之前另按「挂载源端点」复核挂载源的 realpath 与包含关系，不过同样失败。挂载 SHALL 以 app 自己的 uid 前台运行一个子进程，argv 恰为 `<RCLONE_BIN> mount <段名>:<远端> <挂载点> --config <rclone.conf> --cache-dir <cache> --log-file <rclone.log> --log-level NOTICE --allow-non-empty`，再加：可写挂载 `--vfs-cache-mode writes --vfs-write-back 0s`，只读挂载 `--read-only`；`OMP_USER` 已配置时 `--allow-other --default-permissions --uid <omp 数值 uid> --gid <空间根目录的 gid> --umask 007`。`<远端>` 对 `sftp` 为 `remotePath`、对 `smb` 为去掉开头 `/` 的 `remotePath`、对 `local` 为挂载源的 `path`。子进程环境 SHALL 恰为 `PATH`（本进程的值）与 `HOME`（该挂载的私有目录）两个键。

「已挂载」SHALL 以 `/proc/self/mountinfo` 里有一行的挂载点字段（第 5 字段，八进制转义还原后）逐字节等于挂载点的绝对路径为准，不看文件系统类型名，与 temporary-workspaces「临时空间目录的删除」的 mountinfo 判据一致。每次挂载尝试 SHALL 在启动子进程之后的 20 s 就绪窗口内每 100 ms 读一次 mountinfo：出现挂载之后 SHALL 再以一个子进程对挂载点 `readdir` 一次（期限为窗口的剩余时间，超时即以 SIGKILL 结束它），成功才算就绪；mountinfo 里出现一行文件系统类型为 `fuse.rclone`、来源字段以 `<段名>:` 或 `<段名>{` 开头而挂载点字段不是该挂载点的，SHALL 立即判该次尝试失败；子进程先退出、`readdir` 失败或超时、窗口用尽，同样失败。失败时杀掉子进程、惰性卸载该挂载、删除挂载点（为空时）与私有目录（重挂与启动恢复只保持 `offline`，不删私有目录）。「惰性卸载该挂载」SHALL 对挂载点（在 mountinfo 里时）以及 mountinfo 中文件系统类型为 `fuse.rclone`、来源字段（八进制转义还原后）以 `<段名>:` 或 `<段名>{` 开头的每一行的挂载点各执行一次 `<fusermount3> -uz`。

卸载 SHALL 依次：惰性卸载该挂载（挂载内有进程的 cwd 或打开的描述符时同样立即从命名空间脱离）；对子进程发 SIGTERM，5 s 内未退出再发 SIGKILL；`rmdir` 挂载点——非空（离线期间写进挂载点的本地条目）时保留为普通目录、经服务错误通道报告一次；递归删除私有目录。这些文件系统步骤的失败只经错误通道报告，不阻止删除挂载行。卸载期间（含按空间卸载、挂载源删除的连带卸载）子进程的退出 SHALL NOT 触发「在线状态与重挂」的离线判定与重挂。未配置 `RCLONE_BIN` 时，卸载需要惰性卸载（上述扫描找到该挂载）就以进程 `PATH` 上第一个可执行的 `fusermount3` 执行；找不到 SHALL 为 503 `mount_disabled`，挂载行与私有目录保留，并 SHALL 向服务错误通道写一条记录，点名原因（该挂载仍在 mountinfo 里、进程 `PATH` 上没有可执行的 `fusermount3`），不含凭证；扫描没找到时不需要它。

快照与还原对已登记挂载按名字跳过，规则只在 workspace-snapshots「快照内容规则」「还原」（本 change 的 MODIFIED）；未登记的外部挂载仍按那里的 `dev` 规则。

#### Scenario: argv 与环境
- **WHEN** 以假 rclone、`OMP_USER` 已配置（omp uid 经注入为 `10002`）建出一个只读 `smb` 挂载（`remotePath` `/share/product`）与一个可写 `local` 挂载
- **THEN** 前者（主机经测试解析器解析为 `10.0.0.7`）argv 恰为 `mount m<该挂载 id>:share/product <空间根>/<名> --config … --cache-dir … --log-file … --log-level NOTICE --allow-non-empty --read-only --allow-other --default-permissions --uid 10002 --gid <空间根的 gid> --umask 007`，`rclone.conf` 的段名为 `m<该挂载 id>`、`host` 为 `10.0.0.7`；后者以挂载源路径为远端并带 `--vfs-cache-mode writes --vfs-write-back 0s`；两者都不含 `--smb-host`、`--sftp-host`；两次的环境键集恰为 `PATH` 与 `HOME`，`HOME` 是各自的私有目录；本进程环境里的 `MODEL_UPSTREAM_API_KEY` 哨兵不在其中
- **WHEN** 同样的挂载在 `OMP_USER` 未配置时建出
- **THEN** argv 不含 `--allow-other`、`--default-permissions`、`--uid`、`--gid`、`--umask`

#### Scenario: 就绪失败不留痕
- **WHEN** 假 rclone 被设定为不写 mountinfo 就以非 0 退出；另一例为既不写也不退出（超时注入为 1 s）；再两例为在另一个路径上追加一行类型为 `fuse.rclone` 的 mountinfo 后挂起不退出（超时仍为 20 s），来源分别为 `m<该挂载 id>:…` 与 `m<该挂载 id>{abcde}:…`；再一例为照常写出挂载、但就绪 `readdir` 子进程被设定为失败
- **THEN** 五例都是 502 `mount_failed` 与一条 `mount.reject`（`reason` 为 `mount_failed`）；没有挂载行；挂载点与私有目录都不存在；第二至四例的假 rclone 进程已不存在；第三、四例都在 1 s 之内失败（不等满就绪窗口），假 `fusermount3` 对那个另外的路径收到一次 `-uz`；第五例假 `fusermount3` 对该挂载点收到一次 `-uz`

#### Scenario: 挂载点被换掉即拒绝
- **WHEN** 一个离线挂载的挂载点被换成指向空间外目录的符号链接，到期的重挂执行；另一例挂载点被换成一个普通文件
- **THEN** 两例都没有 `mount` 调用、挂载保持 `offline` 并按退避再试；符号链接的目标目录里没有新增条目、未被挂载

#### Scenario: 惰性卸载与残留
- **WHEN** 一个在线挂载被卸载，而离线期间曾有一个文件 `stray.txt` 被直接写进其挂载点目录
- **THEN** 假 `fusermount3` 收到恰一次 `-uz <挂载点>`，假 rclone 进程已退出；挂载点作为含 `stray.txt` 的普通目录保留、错误通道恰报告一次；私有目录不存在；挂载行已删；此后（推进注入时钟超过 300 s）没有任何重挂尝试

### Requirement: 在线状态与重挂
每个已登记挂载的状态 SHALL 只在内存里，取 `online` 或 `offline`。`online` 的挂载每 30 s 探测一次，每个挂载至多一个在途探测：子进程存活、「已挂载」判据成立、在一个子进程里对挂载点做的 `stat` 在 5 s 内成功（超时即以 SIGKILL 结束该子进程）、并且 `sftp` / `smb` 挂载对该次挂载所用的 IP 与端口（给了用给的，否则 `sftp` 为 22、`smb` 为 445）的 TCP 连接在 5 s 内建立（建立即关闭；不碰挂载）——都成立才保持 `online`。连通检查的连接实现 SHALL 可由 manager 的构造选项注入。子进程退出 SHALL 立即判定 `offline`，不等下一轮；「宿主不同步进入挂载」的适配器调用超期同样 SHALL 立即判定 `offline`（与探测相互独立的第二个触发）。判定 `offline` 时 SHALL 惰性卸载该挂载、确保子进程已退出（超期触发时以 SIGKILL 结束它），然后安排重挂：第一次在 5 s 后，此后每次失败间隔翻倍，封顶 300 s；重挂成功即回 `online`、间隔复位为 5 s。每次重挂都经「挂载取值与主机规则」的主机规则与「挂载进程与挂载点」的挂载点重建与检查。卸载对在途探测、待定重挂与在途尝试的处置见「挂载操作的串行与取消」。

#### Scenario: 崩溃即离线并退避重挂
- **WHEN** 一个在线挂载的假 rclone 进程被 SIGKILL，随后假 rclone 被设定为接下来两次挂载失败、第三次成功（注入时钟）
- **THEN** `GET …/mounts` 立即报告 `offline`；假 `fusermount3` 收到一次 `-uz`；重挂尝试发生在 5 s、再 10 s、再 20 s 之后，第三次之后报告 `online`；此后再失败的第一次重挂又在 5 s 后

#### Scenario: 探测超时
- **WHEN** 一个在线挂载的 `stat` 探测被设定为不返回
- **THEN** 5 s 后探测子进程被 SIGKILL，状态为 `offline` 并进入重挂；服务进程的事件循环在此期间照常应答其它请求

#### Scenario: 远端不可达即离线
- **WHEN** 一个在线 `sftp` 挂载（挂载时的 IP `10.0.0.7`、未给端口）的探测轮到时，注入的连接实现对 `10.0.0.7:22` 既不连上也不报错；`stat` 子进程照常成功
- **THEN** 5 s 后状态为 `offline`，假 `fusermount3` 收到一次 `-uz` 并进入重挂；一个在线 `local` 挂载的探测不调用连接实现

#### Scenario: 退避封顶
- **WHEN** 一个挂载持续重挂失败十次
- **THEN** 相邻两次尝试的间隔依次为 5、10、20、40、80、160、300、300、300 s

### Requirement: 服务启停与挂载
mount-manager 在应用装配时构造，构造时 SHALL 同步读出全部挂载行装进内存登记、一律 `offline`（未配置 `RCLONE_BIN` 时同样载入）。服务启动成功记录 `server_started` 写出之后，入口 SHALL 不等待地恢复全部已登记挂载（`RCLONE_BIN` 未配置时不恢复），按 `created_at, id` 逐个依次进行（前一个的尝试结束之后才开始下一个）：对每个挂载，挂载点已在 mountinfo 里（上一次运行异常结束留下的）时先惰性卸载，再按「挂载进程与挂载点」挂载；失败按「在线状态与重挂」进入退避。恢复中的任何失败 SHALL NOT 写 `server_start_failed`、SHALL NOT 改变退出码；恢复完成之前挂载一律报告 `offline`。关停时 SHALL 在关闭 DB 之前停止全部探测与重挂定时器、按「挂载操作的串行与取消」结束在途的挂载尝试，此后 SHALL NOT 再发起任何挂载尝试（含尚未轮到的启动恢复），并对每个挂载执行惰性卸载与「SIGTERM，5 s 后 SIGKILL」；关停 SHALL NOT 删除挂载行与私有目录（下次启动恢复）。

#### Scenario: 启动恢复与残留挂载
- **WHEN** DB 里有两个挂载，其中一个的挂载点已在（假）mountinfo 里，以假 rclone 装配的 manager 执行启动恢复
- **THEN** 恢复完成之前两者都报告 `offline`；假 `fusermount3` 先对那个挂载点收到一次 `-uz`、之后才有它的 `mount` 调用；两个挂载随后都 `online`
- **WHEN** 其中一个挂载的恢复失败
- **THEN** 恢复不抛出、不产生未处理的 rejection；该挂载 `offline` 并在 5 s 后重挂，另一个照常 `online`

#### Scenario: 关停卸载
- **WHEN** 两个挂载在线、其中一个有待定的重挂定时器时执行关停卸载
- **THEN** 两个假 rclone 进程都已退出，假 `fusermount3` 对两个在 mountinfo 里的挂载点各收到一次 `-uz`；此后没有探测或重挂再发生；挂载行与私有目录都还在
- **WHEN** 编译入口在合法挂载配置下启动、success record 写出之后收到 SIGTERM（http-service-skeleton「挂载键与启动预检」）
- **THEN** 挂载的卸载发生在 DB 关闭之前，进程以 0 退出
- **WHEN** DB 里有三个挂载，启动恢复对第一个的 `mount` 调用挂起（假 rclone 不写 mountinfo 也不退出）时执行关停卸载
- **THEN** 那个假 rclone 进程被 SIGKILL、其余两个挂载没有 `mount` 调用；关停完成时没有任何假 rclone 进程存活、假 mountinfo 里没有这三个挂载的行

### Requirement: 挂载端点
`GET /api/workspaces/:id/mounts` SHALL 返回 200 `{enabled, mounts}`：`enabled` 为是否配置了 `RCLONE_BIN`；`mounts` 为该空间的挂载按 `created_at, id` 升序，每项恰为 `{id, name, backend, host, port, remotePath, sourceId, sourceName, readOnly, status, createdAt}`（`sftp` / `smb` 的 `sourceId` 与 `sourceName` 为 null；`local` 的 `host`、`port`、`remotePath` 为 null，`sourceName` 为挂载源的名称；`status` 为 `online` 或 `offline`），不含任何凭证。

`POST /api/workspaces/:id/mounts` SHALL 建出并首次挂载（这一次挂载即连通测试），成功返回 201 与该挂载的视图（`status: "online"`）。判定次序：未认证 401 → 空间不属本人或不存在 404 → 未配置 `RCLONE_BIN` 503 `mount_disabled`（这三者在 body 解析之前）→ content-parser 错误 400 → 「挂载取值与主机规则」的键集与取值 400 → 临时空间 400 `bad_request` → 该空间已有 `MOUNT_MAX_PER_WORKSPACE` 个挂载 409 `mount_limit` → `local` 的 `sourceId` 未登记 404、挂载源只读而 `readOnly` 为 false 400 → 同名挂载已存在或空间根下已有同名条目 409 `conflict` → 主机规则 403 `mount_host_rejected`（主机解析失败 502 `mount_failed`）→ 写凭证文件、建挂载点并检查（挂载点或挂载源复核不过 502 `mount_failed`）、启动子进程并等待就绪（失败 502 `mount_failed`）→ 同一事务内插入挂载行与 `mount.attach` 审计；插行或审计失败 SHALL 先卸载再 generic 500。

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

### Requirement: 挂载操作的串行与取消
一个挂载的每一次操作——建出、重挂尝试、启动恢复尝试、卸载、挂载源删除的连带卸载——SHALL 在该挂载所属空间的同一条串行链上执行。卸载与关停 SHALL 在排入串行链之前同步地取消该挂载待定的重挂定时器与在途探测，并以 SIGKILL 结束它在途的挂载尝试子进程；那次尝试 SHALL 以失败收场、结果作废（不回 `online`，不写行），其挂载若已出现则按「挂载进程与挂载点」惰性卸载。卸载因此不等待就绪窗口，随后在链上照常执行卸载步骤。

#### Scenario: 重挂就绪期间卸载
- **WHEN** 一个离线挂载的重挂已启动假 rclone、正在等待就绪（假 rclone 挂起），用户 `DELETE …/mounts/<id>`
- **THEN** 204 在就绪窗口结束之前返回；那个假 rclone 进程已不存在；挂载行、私有目录与挂载点都不存在；假 mountinfo 里没有该挂载的行；此后（推进注入时钟超过 300 s）没有任何重挂或 `mount` 调用

#### Scenario: 启动恢复期间关停
- **WHEN** 启动恢复正在等待某个挂载的就绪时执行关停卸载
- **THEN** 关停完成时没有任何假 rclone 进程存活、假 mountinfo 里没有本 manager 的任何挂载行；挂载行与私有目录都还在

#### Scenario: 删除挂载源与并发建出
- **WHEN** 用户对挂载源 S 的 `local` 建出请求正在等待就绪（假 rclone 挂起），管理员 `DELETE /api/mount-sources/<S>`，随后假 rclone 被放行写出 mountinfo
- **THEN** `DELETE` 为 204；建出请求为 404 `not_found`；没有引用 S 的挂载行、没有存活的假 rclone 进程，假 mountinfo 里没有该挂载的行；审计有一条 `mount.source.delete`，没有 `mount.attach`

### Requirement: 挂载源端点
`GET /api/mount-sources` SHALL 对所有已认证账号返回 200 `{sources}`，按 `name` 的 UTF-8 字节序：管理员（`isAdmin`）每项恰为 `{id, name, path, readOnly, createdAt}`，其他账号每项恰为 `{id, name, readOnly}`。`POST /api/mount-sources` 与 `DELETE /api/mount-sources/:id` 只对管理员开放，其他账号 403 `forbidden`（先于 body 解析与 id 判定）。

`POST` body SHALL 恰为 `{name, path, readOnly}`：`name` 1..64 个字符、不含 U+0000–U+001F 与 U+007F；`path` 为绝对路径，其 realpath 是存在的目录，且与 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`dirname(DB_PATH)`、`STATIC_ROOT`、`dirname(OMP_BIN)` 各自的 realpath 互不包含（相等、位于其内、包含它都拒绝）；违反 400，已有 32 个挂载源 400，同名或同 realpath 409 `conflict`。存入的 `path` 是 realpath。引用它的 `local` 挂载每次挂载尝试之前 SHALL 重新取该 `path` 的 realpath 并复核：等于存入值、是存在的目录、与上述五者互不包含，不过即该次尝试失败（「挂载进程与挂载点」）。成功 201 管理员视图与 `mount.source.create` 审计（`detail` `{sourceId, name, path, readOnly}`）。

`DELETE` SHALL 先在内存里把该挂载源标为删除中（此后引用它的建出请求在 `sourceId` 判定处 404），再对此刻引用它的每个挂载做「挂载进程与挂载点」的卸载并删除挂载行，各写一条 `mount.detach`（`reason` 为 `source_deleted`，actor 为该管理员，`workspaceId` 为该挂载的空间），最后在一个事务内删除挂载源行并写 `mount.source.delete`，返回 204；未知 id 404。「删除中」标记 SHALL 在 `finally` 里清除：连带卸载或最后的事务失败时 `DELETE` 以 generic 500 结束、挂载源行保留、标记已清，此后引用它的建出照常可用（已连带卸载的挂载行已删，其余照旧）。引用挂载源的建出 SHALL 在插行的事务里复核该源仍存在且未标删除，不成立即先卸载刚挂上的挂载、不插行，404 `not_found`。全部响应 `no-store`。

#### Scenario: 两种视图
- **WHEN** 管理员登记挂载源 `NFS 共享`（路径为一个符号链接，指向测试目录），普通用户与管理员分别 `GET /api/mount-sources`
- **THEN** 登记为 201，存入的 `path` 是目标目录的 realpath；普通用户的项恰三键、不含 `path`；管理员的项恰五键

#### Scenario: 拒绝的路径
- **WHEN** 管理员以相对路径、不存在的路径、一个普通文件、`SANDBOX_ROOT` 本身、`SANDBOX_ROOT` 之下的目录、`SANDBOX_ROOT` 的父目录、`OMP_STATE_DIR` 之下的目录、`STATIC_ROOT` 的父目录、`dirname(OMP_BIN)` 分别登记；普通用户以合法 body 登记
- **THEN** 前九例 400、没有行与审计；普通用户 403 `forbidden`
- **WHEN** 一个已登记挂载源的路径在登记之后被换成指向 `SANDBOX_ROOT` 的符号链接，引用它的 `local` 挂载到期重挂
- **THEN** 没有 `mount` 调用，该挂载保持 `offline`

#### Scenario: 删除连带卸载
- **WHEN** 两个账号各有一个引用挂载源 S 的 `local` 挂载，管理员 `DELETE /api/mount-sources/<S>`
- **THEN** 204；两个挂载都已卸载、行与私有目录都不存在；审计有两条 `mount.detach`（`reason` `source_deleted`，`workspaceId` 各为其空间）与一条 `mount.source.delete`

### Requirement: 临时空间与删除前卸载
临时空间 SHALL NOT 有挂载（建出请求为 400，见「挂载端点」）；转正之后的空间与其它正式空间一样可以挂载。任何删除空间行或空间目录的路径 SHALL 先卸载并删除该空间的全部挂载行；`workspace_mounts.workspace_id` 的 `RESTRICT` 使先删空间行的路径在 DB 层失败。会话删除与 temporary-workspaces「临时空间目录的删除」不因本能力改变：临时空间没有 app 挂载，其中关于外部挂载的 #1237 规则（不检测、不卸载、停在 `EBUSY`）照旧成立。

#### Scenario: 转正之后可以挂载
- **WHEN** 对临时空间 T 请求建出挂载，随后把 T 转正为 `调研资料` 再请求一次
- **THEN** 第一次 400、没有子进程；第二次 201

#### Scenario: 按空间卸载全部
- **WHEN** 一个正式空间有两个在线挂载，调用 manager 的按空间卸载
- **THEN** 两个挂载都已卸载、行与私有目录都不存在，各写一条 `mount.detach`（`reason` `workspace_deleted`）；随后删除该空间行成功

### Requirement: 挂载目录内的文件端点
对 workspaces 与 file-operations 的文件端点，路径（`path`，或 move 的 `from` / `to`，URL 解码后的字符串）的第一段——按 `/` 分割、去掉空段与 `.` 段之后的第一个分量，与 sandbox-core「resolve 契约与逃逸向量」同一个函数——逐字节等于该空间某个已登记挂载的 `name` 时，该路径「在该挂载内」；其后没有分量即挂载根本身。`./远端/a.md`、`远端//a.md` 与 `远端/a.md` 同属 `远端`。判定 SHALL 只读内存里的挂载登记与状态、不访问文件系统，位置在 `sandbox.resolve` 之后（越界仍为 403 `sandbox_denied` 并审计）、一切存在性检查与文件系统读写之前，规则：

- `DELETE …/entries` 的目标在任一挂载内（含挂载根）→ 409 `mount_boundary`。
- `POST …/move`：`from` 与 `to` 恰一方在挂载内、两方在不同挂载内、或 `from` 是挂载根 → 409 `mount_boundary`；两方在同一挂载内时，该挂载 `offline` → 409 `mount_offline`、只读 → 403 `mount_read_only`，否则照常一次 `rename`。
- `GET …/tree`、`GET …/file`、`GET …/download`、`GET …/archive` 的路径在 `offline` 挂载内 → 409 `mount_offline`。
- `POST …/dirs` 的路径在 `offline` 挂载内 → 409 `mount_offline`；在只读挂载内 → 403 `mount_read_only`。

边界判定先于离线与只读判定。这些拒绝都 SHALL NOT 写 `file.delete` / `file.move` / `dir.create` 审计、SHALL NOT 触碰文件系统。通过判定的挂载内操作恰为 `tree`、`file`（含 Range）、`download`、`archive`、`dirs` 与同一挂载内的 `move`，它们在 `online` 挂载上的每一次文件系统调用 SHALL 经「宿主不同步进入挂载」的异步适配器。上传固定写入 `uploads/<名>`，而挂载名不能是 `uploads`，上传因此永不落进挂载。挂载内的 `dirs` 由异步适配器 `mkdir`，SHALL NOT 经 `ensureSharedDir`（它对已存在的分量同步 `stat`、对新建的分量同步 `chmod`）、也不 `chmod`：挂载内新目录的模式由 rclone 的 `--umask` 决定（「挂载进程与挂载点」），workspaces 的 `0o2770` 只对挂载之外成立。其它入口见「宿主不同步进入挂载」。挂载内的 `file`（含 Range）与 `download` 的 `Content-Length` 按打开后对描述符 `fstat` 的大小（区间按它截取）发出；此后经适配器读到 EOF 而已写出的字节少于该长度时，SHALL 销毁连接，不补齐、不以正常结束收尾；已写出的审计行不撤回。

#### Scenario: 挂载内短读即中断
- **WHEN** 在线挂载 `远端` 里的 `a.bin`，适配器的 `fstat` 报 1000 字节，而读在第 400 字节处返回 EOF；分别请求 `download?path=远端/a.bin` 与 `file?path=远端/a.bin`（`Range: bytes=0-999`）
- **THEN** 两者的响应头都已按 1000 字节发出，连接在读到 400 字节之后被销毁、客户端收到的正文恰为 400 字节且以连接中断结束（不是一个完整的 200 / 206）；`download` 的 `file.download` 审计恰一行

#### Scenario: 删除与跨挂载移动
- **WHEN** 空间有在线可写挂载 `远端`（其中有 `a.md`、`c.md`、目录 `d`）与根下文件 `local.md`；依次 `DELETE entries?path=远端/a.md`、`DELETE entries?path=远端`、`DELETE entries?path=./远端`、`DELETE entries?path=./远端/a.md`、`DELETE entries?path=远端//a.md`、`move {from:"local.md",to:"远端/local.md"}`、`move {from:"远端/a.md",to:"a.md"}`、`move {from:"./远端/a.md",to:"a.md"}`、`move {from:"远端",to:"别名"}`、`move {from:"远端/a.md",to:"远端/d/a.md"}`、`move {from:"远端/c.md",to:"./远端/e.md"}`
- **THEN** 前九个都是 409 `mount_boundary`，文件都在原处、没有审计行、回收目录没有新批次；第十个 200 且 `远端/d/a.md` 存在、`file.move` 审计一行（`title` `移动 远端/a.md → 远端/d/a.md`）；第十一个是同一父目录内的改名，200 且 `远端/e.md` 存在、`file.move` 审计一行（`title` `重命名 远端/c.md → e.md`）

#### Scenario: 离线与只读
- **WHEN** 挂载 `远端` 离线（挂载点上放着哨兵文件 `sentinel.txt`），依次请求 `tree?path=远端`、`tree?path=./远端`、`file?path=远端/a.md`、`download?path=远端/a.md`、`archive?path=远端/x.zip`、`dirs {path:"远端/新"}`、`move {from:"远端/a.md",to:"远端/b.md"}`；另一个在线只读挂载 `参考` 上请求 `dirs {path:"参考/新"}` 与 `move {from:"参考/a.md",to:"参考/b.md"}`
- **THEN** 前七个都是 409 `mount_offline`，响应不含 `sentinel.txt`；后两个都是 403 `mount_read_only`；没有任何文件系统改动与 `dir.create` / `file.move` 审计
- **WHEN** 未配置 `RCLONE_BIN`，DB 里有挂载 `远端`，请求 `tree?path=远端`
- **THEN** 409 `mount_offline`，没有文件系统访问
- **WHEN** 同一空间根下的普通目录 `远端备份`（名字以挂载名开头）上做同样的请求
- **THEN** 按既有规则处理，不受挂载判定影响

#### Scenario: 越界先于挂载判定
- **WHEN** 请求 `DELETE entries?path=远端/../x` 与 `DELETE entries?path=./远端/../x`
- **THEN** 两次都是 403 `sandbox_denied` 并各写一条 `sandbox.reject`，不是 409

### Requirement: 宿主不同步进入挂载
服务进程 SHALL NOT 对已登记挂载的挂载点或其下任何路径做同步文件系统调用。挂载点只在空间根下一层，挂载名不含 `.`、也不是保留名 `uploads` 或 `screenshots`（「迁移 049 挂载 schema」）：只经空间根自身、第一段含 `.` 的路径或这两个保留名、且不跟随符号链接的同步调用因此不会进入挂载；会跟随符号链接的调用（`realpath`）对 omp uid 可写的位置改为有期限的异步调用（下文）。成员按「挂载目录内的文件端点」的第一段规则词法判定；沙箱 facade 经端口 `mountNamesOf` 得到该空间的已登记挂载名（sandbox-core「沙箱 facade 与拒绝审计」），`resolve` 对挂载内路径不做文件系统调用。

`online` 挂载内的文件系统调用（`lstat`、`readdir`、`open`、对已打开文件的 `fstat`、`read`、`close`、`mkdir`、`rename`）SHALL 只经一个异步适配器：只用 `fs/promises`；每个挂载一个先进先出的闸门、同一时刻至多一个调用在执行；每次调用自拿到闸门起有 10 s 期限（测试可注入）。超期时该请求 SHALL 以 409 `mount_offline` 结束，该挂载 SHALL 立即判定 `offline`（「在线状态与重挂」：以 SIGKILL 结束其 rclone、惰性卸载），排队中的调用 SHALL 都以 409 `mount_offline` 结束。

其它对工作空间路径做文件系统调用的入口，对挂载内路径 SHALL 词法处置、不碰文件系统：

- 空间根一层的 `tree` 按名字跳过已登记挂载、不对其 `lstat`、不列出它们（挂载根行只来自「挂载端点」的 `GET`）；
- 快照与还原：见 workspace-snapshots「快照内容规则」「还原」的「已登记挂载」一条（manager 交出该空间的挂载名集合）；
- 预览源的 `/w/` 与 `/o/` 对挂载内路径按「不是普通文件」的 404 应答；
- 会话附件的路径在挂载内时 400 `bad_request`（在沙箱判定之后）；撤回时挂载内的附件视为已不在；
- omp 报告的文件变更：见 turn-artifacts「文件变更推导与归属」（词法上在挂载内的候选丢弃；其余候选的 `realpath` / `lstat` 经 `fs/promises` 并带 10 s 期限）；
- 项目技能列表：见 chat-sessions「Slash 命令白名单与命令目录」（`<D>/.omp/skills` 与各条目 `SKILL.md` 的 `realpath` 经 `fs/promises` 并带 10 s 期限）；
- 会话截图目录比对（turn-artifacts「文件变更推导与归属」的浏览器截图）只读 `<空间根>/screenshots`，它是保留名；打开之前先不跟随地 `lstat` 它，是符号链接或不是目录即按不存在处理、不打开。`lstat` 与打开之间的窗口与「挂载进程与挂载点」的挂载点检查同属先查后用，登记为已接受的残余。

回收目录不会遇到挂载（挂载只在空间根下一层，挂载内删除已被拒，根不能删除）。未配置 `RCLONE_BIN` 时上述规则照样按内存登记生效。

#### Scenario: 挂起的挂载不阻塞别处
- **WHEN** 空间 A 有在线挂载 `远端`，测试经 manager 的构造选项把适配器的文件系统 seam 换成永不返回、记录每次调用的实现（假 FUSE），期限注入为 1 s，并把挂载点目录本身的模式置为 `0000`（任何绕过适配器的同步调用都以 `EACCES` 失败、得不到 409；以 root 运行时模式位不拦，该场景不在 root 下执行）；对 `tree?path=远端/sub` 发请求，随即对空间 A 的根与另一个空间 B 的根各发 `tree`
- **THEN** 两个根的 `tree` 都在 `远端` 的请求结束之前返回 200；`远端` 的请求在期限后为 409 `mount_offline`；该挂载随即报告 `offline`，其假 rclone 收到 SIGKILL、假 `fusermount3` 收到一次 `-uz`，随后按退避重挂

#### Scenario: 闸门排队与期限
- **WHEN** 同一挂载上一个调用挂起时又到达两个挂载内请求
- **THEN** 后两个在挂起的调用超期时都以 409 `mount_offline` 结束，期间 seam 上始终至多一个在途调用；另一个挂载上的请求照常应答

#### Scenario: 根一层按名字跳过
- **WHEN** 空间根下有已登记挂载 `远端`（在线挂载的替身：一个模式为 `0000`、内有文件的目录）与普通目录 `out`；请求根的 `tree`
- **THEN** 根的 `tree` 恰含 `out`、不含 `远端`，`远端` 的模式与内容不变（快照与还原的同类场景见 workspace-snapshots「已登记挂载按名字跳过」「已登记挂载不被还原、删除或建出」）

#### Scenario: 其它入口
- **WHEN** 对在线挂载 `远端` 内的 `a.md` 请求预览源 `/w/<令牌>/远端/a.md`；以 `远端/a.md` 作为会话附件发送；撤回一条带附件 `远端/a.md` 的消息
- **THEN** 预览源 404；附件 400 `bad_request`；撤回交还的附件不含它；对 `远端` 及其下没有任何文件系统调用（文件变更的同类场景见 turn-artifacts「挂载内的候选不触达文件系统」）

### Requirement: 挂载根行
`WorkspaceBrowser`（文件页与会话页侧边栏共用，files-web「工作空间浏览器组件」）SHALL 在进入空间时请求一次 `GET /api/workspaces/:id/mounts`，并在 `刷新`、建出与卸载之后重取；不轮询。空间根行之后按 `mounts` 的次序每个挂载渲染一个挂载根行：图标 `cloud`（`sftp` / `smb`）或 `folder`（`local`）、挂载名、只读时一个 `只读` 标签、状态点（可访问文本 `在线` / `离线`）、按钮 `卸载 <名>`；副行为 `<host>:<remotePath>`（`sftp` / `smb`）或挂载源名称（`local`）。空间根一层的条目只来自 `tree`（服务端已不列出挂载点，「宿主不同步进入挂载」），浏览器不按名字过滤。在线的挂载根行可展开（展开时请求 `tree?path=<名>`，规则同普通目录）；离线的不可展开，其下显示 `离线，重新连接后可浏览`。挂载根行没有 `更多操作` 菜单、不可拖动、不是放下目标。`新建文件夹` 的 `位置` 下拉不含只读或离线挂载及其下的目录。

`卸载 <名>` 打开确认框（拷入层 `alert-dialog`，标题 `卸载「<名>」？`，说明 `只断开挂载，远端文件不受影响。`，按钮 `取消` / `卸载`，初始焦点在 `取消`）；确认后恰一次 `DELETE …/mounts/<id>`，成功后该行消失、当前选中的文件位于该挂载内时选中被清除；失败在确认框内显示信封 message。`GET …/mounts` 失败时不渲染挂载根行，树区上方显示 `role="alert"` 的信封 message；空间根照常可用。挂载内文件的预览见 files-web「工作空间页」。

#### Scenario: 在线、只读与离线
- **WHEN** 空间根的 `tree` 恰为目录 `out`（服务端不列出挂载点），`mounts` 为在线只读 `sftp` 挂载 `数据仓库导出`（`dw-node-02.intra:/export/dw`）与离线可写 `smb` 挂载 `产品共享盘`
- **THEN** 空间根之下只有 `out` 一个普通条目；空间根行之后依次是两个挂载根行：前者带 `cloud` 图标、`只读` 标签、`在线`、副行 `dw-node-02.intra:/export/dw`，展开时恰一次 `tree?path=数据仓库导出`；后者 `离线`、不可展开、其下显示 `离线，重新连接后可浏览`、点击不发请求
- **WHEN** 打开 `新建文件夹`
- **THEN** `位置` 下拉不含两个挂载

#### Scenario: 卸载
- **WHEN** 当前选中 `数据仓库导出/a.csv`，点 `卸载 数据仓库导出`、先 `取消`、再确认；另一例 `DELETE` 返回 404
- **THEN** 取消后没有请求；确认后恰一次 `DELETE …/mounts/<id>`，该行消失、选中被清除；404 一例在确认框内显示信封文案、确认框仍开

#### Scenario: 两处同一份实现
- **WHEN** 在会话页侧边栏打开同一空间
- **THEN** 挂载根行、状态、`只读` 标签与 `卸载` 与文件页相同；侧边栏没有 `挂载目录` 入口

### Requirement: 挂载对话框
文件页的 `新建` 菜单 SHALL 在 `GET …/mounts` 的 `enabled` 为 true 时多一项 `挂载目录`（位于 `新建文件夹` 之后），为 false 或尚未取到时没有这一项。它打开对话框（拷入层 `dialog`，`aria-modal="true"`，标题 `挂载目录`，初始焦点在 `挂载名称`）：

- `挂载名称`（placeholder `例如 数据仓库导出`）；
- `协议`（select：`SFTP`、`SMB`、`服务器目录`，缺省 `SFTP`）；
- `SFTP` / `SMB`：`主机`、`端口`（可空，placeholder 分别为 `22` / `445`）、`目录路径`（placeholder `SFTP` 为 `/srv/data`、`SMB` 为 `/共享名/目录`）、`用户名`、`密码`（`type="password"`、`autocomplete="new-password"`）；`SFTP` 另有 `认证方式`（radio：`密码` / `私钥`，选 `私钥` 时 `密码` 换成 `私钥` 多行输入）；`SMB` 另有 `域`（可空）；
- `服务器目录`：`目录` 下拉，选项为 `GET /api/mount-sources` 的各项（只读的带 ` · 只读`；每项按管理员五键或普通用户三键之一严格解析，同一响应内不混用）；没有挂载源时下拉换成文本 `管理员尚未登记服务器目录`，提交按钮禁用；选中只读挂载源时 `只读挂载` 强制打开并禁用；
- `只读挂载` 开关（缺省打开，说明 `禁止写入，防止误改源目录`）；
- 按钮 `取消` / `测试连通并挂载`。

本地校验（不发请求）：名称空 → `请填写挂载名称`；名称含规则外的字符 → `名称只能包含字母、数字、下划线、连字符与汉字`；名称为 `uploads` 或 `screenshots` → `该名称已保留`；主机空 → `请填写主机`；路径不以 `/` 开头 → `请填写绝对路径，如 /srv/data`；用户名空 → `请填写用户名`；密码 / 私钥空 → `请填写密码` / `请填写私钥`；端口非 1..65535 的整数 → `端口应为 1 到 65535 的整数`。提交恰一次 `POST …/mounts`，body 只含所选协议的键；请求进行中提交按钮禁用、显示 `正在连接…`，`取消` 中止等待。成功：对话框关闭、重取 `mounts`、新挂载根行出现并展开、焦点落在该行。失败：对话框保持打开、已填的值保留，对话框内显示 `role="alert"` 的信封 message（如 `该主机不允许挂载`、`挂载失败，请检查主机、路径与凭证`）。凭证 SHALL NOT 写入地址、`localStorage` 或 `sessionStorage`；对话框关闭后清空凭证字段。成功与失败都不使用 Toast。

#### Scenario: 入口随开关
- **WHEN** `enabled` 为 false 时打开 `新建` 菜单；`enabled` 为 true 时再打开
- **THEN** 前者恰为 `新建文件夹` 与 `新建工作空间`；后者依次为 `新建文件夹`、`挂载目录`、`新建工作空间`

#### Scenario: 提交与失败就地显示
- **WHEN** 选 `SFTP`、`私钥`，填名称 `数据`、主机 `files.intra`、路径 `/srv/data`、用户名与私钥后提交，服务端返回 403 `mount_host_rejected`；改主机后再提交，服务端返回 201
- **THEN** 第一次恰一次 `POST`，body 键集恰为 `name`、`backend`、`host`、`remotePath`、`readOnly`、`username`、`privateKey`；对话框内显示 `该主机不允许挂载`、字段值保留；第二次之后对话框关闭、`mounts` 被重取、`数据` 挂载根行出现并展开、焦点在该行；页面没有 Toast，地址与 Web Storage 里没有私钥

#### Scenario: 本地校验与服务器目录
- **WHEN** 名称留空提交；名称 `a.b` 提交；`服务器目录` 下 `GET /api/mount-sources` 为空；有一个只读挂载源时选中它；管理员打开对话框，`GET /api/mount-sources` 的项为管理员五键视图
- **THEN** 前两例分别显示 `请填写挂载名称` 与 `名称只能包含字母、数字、下划线、连字符与汉字`，没有请求；第三例显示 `管理员尚未登记服务器目录`、`测试连通并挂载` 禁用；第四例 `只读挂载` 为打开且禁用，提交的 body 为 `{name, backend:"local", sourceId, readOnly:true}`；第五例下拉照常列出各项、界面不显示 `path`

### Requirement: 真实挂载验证层
`server/test/linux/mounts-fuse.test.ts` SHALL 只在 `process.platform === "linux"` 且 `WORKBUDDY_FUSE_TEST=1` 时执行，否则以 `describe.skipIf` 明示跳过；已 opt-in 而缺少运行前提（`WORKBUDDY_FUSE_RCLONE` 指向可执行的 rclone、PATH 上的 `fusermount3` 与 `fusermount`、`/dev/fuse`）SHALL 失败而非追加 skip。它经真实 mount-manager、真实 rclone 与真实 FUSE 验证 `local` 后端：可写挂载内的建、读、写、改名；只读挂载写入失败；SIGKILL rclone 后状态在一轮探测之内变为 `offline`、挂载点不再在 mountinfo 里、随后重挂回 `online`；卸载后挂载点从 mountinfo 消失、目录被删除；可写挂载内「新建目录、在其中建文件、目录改名、删文件、删目录」之后源目录里没有残留（#1665 P8 的回归，argv 带 `--vfs-write-back 0s`；测试主机的签收运行中该例仍复现时，签收 PR 把它改为 vitest 的 `it.fails` 并在 ADR-0003 与 `system.md` §9.9 记为已知限制，签收以其余各例全绿为准——owner 2026-10-25）。环境另给了 `WORKBUDDY_FUSE_SFTP_HOST`、`_PORT`、`_USER`、`_PASS`、`_PATH`、`_DOWN`、`_UP`（后两者是测试主机上停止与启动该远端的可执行文件的绝对路径）时 SHALL 另跑 `sftp` 的两例：挂载读写；远端停机后在一轮探测之内（30 s + 5 s）报告 `offline`、远端恢复后 360 s 之内（退避封顶 300 s、就绪窗口 20 s 与余量）回到 `online`（这组变量只给了一部分即失败）。测试主机上的签收运行 SHALL 给出这组变量，`sftp` 两例必须通过；本机开发运行可只跑 `local`。「已挂载」以 mountinfo 路径为准。每例结束先卸载、确认 mountinfo 里不再有挂载点，再以 `fs/promises` 的 `rm` 删除测试自有目录。它不进任何 CI job，在测试主机的一次性容器里手工运行，结果记入 PR 与 ADR-0003。

#### Scenario: 非 opt-in 明示跳过
- **WHEN** 平台不是 Linux 或 `WORKBUDDY_FUSE_TEST` 不是 `1`
- **THEN** 套件报告 skipped，测试体不创建目录、不启动子进程

#### Scenario: opt-in 缺前提即失败
- **WHEN** `WORKBUDDY_FUSE_TEST=1` 而 `WORKBUDDY_FUSE_RCLONE` 未设置
- **THEN** 套件失败、退出码非 0，错误点名缺少的前提

#### Scenario: sftp 读写与远端停机
- **WHEN** opt-in、前提齐全且 `WORKBUDDY_FUSE_SFTP_*` 全部给出，建出可写 `sftp` 挂载、写入并读回；执行 `_DOWN`；等待；执行 `_UP`；等待；卸载
- **THEN** 读回与写入一致；`_DOWN` 之后 35 s 之内报告 `offline`；`_UP` 之后 360 s 之内报告 `online` 且读回仍一致；卸载后挂载点不在 mountinfo 里、目录不存在
- **WHEN** 只给出其中一部分变量
- **THEN** 套件失败，错误点名缺少的变量

#### Scenario: 删除不复活
- **WHEN** opt-in 且前提齐全，可写 `local` 挂载内依次 `mkdir d`、建 `d/f`、把 `d` 改名为 `d2`、删 `d2/f`、删 `d2`，随后等待 7 s
- **THEN** 挂载视图与源目录里都没有 `d`、`d2` 与 `f`

#### Scenario: local 后端的生命周期
- **WHEN** opt-in 且前提齐全，对一个测试自有源目录建出可写 `local` 挂载，写入、改名、读回；SIGKILL 其 rclone；等待重挂；卸载
- **THEN** 读写结果与源目录一致；SIGKILL 之后一轮探测之内报告 `offline` 且 mountinfo 里没有该挂载点；随后报告 `online`；卸载后挂载点不在 mountinfo 里、目录不存在、源目录内容不变

### Requirement: 中心「挂载源」tab
`/center?tab=mount-sources`（`label` `挂载源`，只对管理员可见，`CENTER_TABS` 中位于 `models` 之后，见 model-registry「中心页外壳」）SHALL 渲染 `GET /api/mount-sources` 的管理员视图：每行名称、服务器路径与 `只读` 或 `可写`，行操作 `删除`——确认框说明恰为 `删除后，所有引用它的挂载都会被卸载`，确认后恰一次 `DELETE /api/mount-sources/<id>`，成功后列表重取，失败在确认框内显示 `ApiError.message`。页顶 `登记挂载源` 打开对话框，字段为名称、服务器路径与开关 `只读`，提交恰一次 `POST /api/mount-sources`（body `{name, path, readOnly}`），成功后关闭对话框并重取列表，400 / 409 的 `ApiError.message` 在对话框内就地显示；提交前在客户端按「挂载源端点」的名称与路径规则校验并显示原因（路径的存在与包含关系只由服务端判定）。对话框接 `useEscapeFallback`。没有挂载源时显示空态：标题 `尚未登记挂载源`，说明恰为 `在服务器上挂好 NFS 或本机目录后，在此登记；用户即可在工作空间里挂载它。`，页顶 `登记挂载源` 仍在。没有编辑操作。API 客户端 `web/src/lib/api-mounts.ts` SHALL 提供 `listMountSources` / `createMountSource` / `deleteMountSource`，按管理员视图严格解析。

#### Scenario: 登记与删除
- **WHEN** 管理员打开 `/center?tab=mount-sources`（`GET` 返回一个挂载源 `NAS`，路径 `/mnt/nas`，只读），登记 `{name:"共享盘", path:"/srv/share", readOnly:false}`，再删除 `NAS` 并确认
- **THEN** 列表先显示 `NAS`、`/mnt/nas`、`只读`；恰一次 `createMountSource` 后列表重取；删除的确认框显示 `删除后，所有引用它的挂载都会被卸载`，确认后恰一次 `DELETE /api/mount-sources/<NAS 的 id>`，随后列表重取

#### Scenario: 就地失败与空态
- **WHEN** 登记时服务端返回 409 `conflict`；另一例 `GET /api/mount-sources` 返回 `{sources:[]}`
- **THEN** 对话框保持打开并显示该 `ApiError.message`；空态一例显示 `尚未登记挂载源` 与上述说明，页顶仍有 `登记挂载源`
- **WHEN** 普通用户打开 `/center?tab=mount-sources`
- **THEN** 以 replace 导航到第一个可见 tab，tab 条没有 `挂载源`，没有发出 `GET /api/mount-sources`
