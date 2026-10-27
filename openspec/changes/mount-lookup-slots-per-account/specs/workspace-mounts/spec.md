## MODIFIED Requirements

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

全部通过时，第一个解析结果（IP 字面）SHALL 写进该次尝试的 `rclone.conf` 的 `host`（「挂载凭证文件」），rclone 不再自行解析主机；argv SHALL NOT 带 `--sftp-host`、`--smb-host` 或任何其它后端覆盖参数。该地址 SHALL 记在内存里，供「在线状态与重挂」的连通检查。`local` 挂载不经主机规则。第 4 步的系统解析 SHALL 限流：全进程同时在途的解析至多 2 个（`dns.lookup` 占 libuv 线程池的线程，没有超时也不能取消），并且每个账号同时至多占其中 1 个——建出与重挂按挂载所属账号计入同一账号名额，一个账号多出的解析在它自己的队列里先到先得地等待、不占全局名额（#1810，owner 2026-10-27）；IP 字面量不经解析、不排队。建出时被拒 SHALL 为 403 `mount_host_rejected`；重挂时被拒 SHALL 使该挂载保持 `offline`。

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

#### Scenario: 解析名额按账号分配
- **WHEN** 测试解析器对每次调用都挂起；zhangsan 在两个空间各建出一个主机名 `sftp` 挂载，lisi 建出一个，另一个账号再建出一个
- **THEN** 解析器恰收到两次调用：zhangsan 的第一个与 lisi 的；zhangsan 的第二个与第三个账号的在等待；让 zhangsan 的第一次调用以失败返回后，解析器收到的下一次调用来自第三个账号（它先在全局队列里等）；zhangsan 的第二个此后在全局名额再空出时才进入；任一时刻在途调用不超过 2 个、同一账号不超过 1 个；同时以 IP 字面量建出的挂载不等待
- **WHEN** zhangsan 一个离线挂载到期重挂时其解析挂起，zhangsan 在另一个空间再建出一个主机名挂载
- **THEN** 新建出的解析在 zhangsan 的队列里等待，lisi 的建出照常进入解析器
