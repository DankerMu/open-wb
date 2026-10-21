## MODIFIED Requirements

### Requirement: sidecar 转换契约
`createOfficeConverter({spoolDir?, cacheDir, timeoutMs, pollMs?, log?})` SHALL 返回 `{available, convert(absInput, signal?) → Promise<absPdf>, close()}`。`spoolDir` 未提供时 `available` 为 `false`，`convert` SHALL 以 `unavailable` 失败且不碰文件系统。`convert` 在建作业目录之前的检查次序 SHALL 为：`spoolDir` 未提供 → `unavailable`；已 `close()` 或 `signal` 已中止 → `aborted`；`absInput` 不是绝对路径 → `failed`；`<spoolDir>/heartbeat` 不新鲜（见「转换 sidecar 的健康与 fail-closed」）→ `unavailable`。`convert` SHALL NOT 启动任何子进程：转换由 sidecar 完成，app 只与 spool 目录交互。

每次真实转换 SHALL：(1) 以 `openRegularFile(absInput)`（workspaces/regular-file：末段 `O_NOFOLLOW`、`fstat` 判普通文件、取 `size`）打开输入——打开失败、不是普通文件（含 `lstat` 之后被换成符号链接）→ `failed`；(2) 新建作业目录 `<spoolDir>/jobs/<id>/`（`id` 为 32 个小写十六进制随机字符，目录 `0700`）与 `in/`；(3) 把输入恰 `size` 字节复制为 `in/<basename(absInput)>`（`wx`、`0600`；读到的少于 `size` → `failed`，不留半截）；(4) 先写 `request.json.part` 再 `rename` 为 `request.json`，内容为 `{"version":1,"input":"<basename>","timeoutMs":<timeoutMs>}`——恰这三个键，SHALL NOT 含任何路径、用户名或时间戳；(5) 每 `pollMs`（缺省 100）看 `done` / `failed`：`done` 出现 → 以与旧契约相同的纪律取 `out/<去掉最后一个扩展名>.pdf`（stem 只去最后一个扩展名：`report.v2@named.tar.docx` → `out/report.v2@named.tar.pdf`；以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开——命名管道因此不阻塞、与符号链接、目录一样被拒；`out/` 或该文件缺席 → `failed`；`fstat` 为大小 > 0 的普通文件、`size` ≤ 209715200 字节否则 `failed` 且不读、恰复制 `size` 字节进 `<cacheDir>/pdf/<随机名>.pdf`（`wx`、`0600`）、短读 → `failed` 且不留副本）；`failed` 出现 → `failed`（SHALL NOT 按原因码区分）；`timeoutMs` 到期 → 写 `cancel` 并以 `timeout` 失败；`signal` 中止 → 写 `cancel` 并以 `aborted` 失败；(6) 无论成败落定前递归删除作业目录（尽力而为，删除失败不改变结果）。递归删除不是原子的（逐项 `unlinkat` 再 `rmdir`）：删除途中作业目录可能只剩一部分（如 `done` 与 `in/` 已删、`request.json` 还在），sidecar 对它已落定过的作业不再领取、不再写入（「转换 sidecar 实现与镜像」，#1601）。残余（接受）：app 写 `cancel` 后立刻删除，此时 sidecar 对该作业的**首次**落定（在途作业被杀后的 `cancelled`，或领取时即判 `cancelled`）仍可能把 `failed` 写进正在被删的目录，使最后的 `rmdir` 失败、目录留到下次启动由「转换缓存与作业目录清理」的启动清理删掉；结果不受影响（app 已不等这个作业）。写进 spool 的每一个字节 SHALL NOT 含 app 一侧的绝对路径（输入路径、`SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`、`OMP_STATE_DIR`）。

失败的错误对象 SHALL 只带 kind（`unavailable` / `failed` / `timeout` / `aborted` / `busy`），不带路径、原因码或底层错误。`close()` SHALL 对全部在途作业写 `cancel`、使它们以 `aborted` 落定并等收尾完成；此后的 `convert` 以 `aborted` 失败。构造时 `cacheDir` 或给出的 `spoolDir` 不是绝对路径 → `createOfficeConverter` SHALL 直接抛出 message 恰为 `cacheDir and spoolDir must be absolute paths` 的普通错误。`OMP_USER` SHALL NOT 影响本契约的任何一步：两种 uid 模式下 app 对 spool 做完全相同的事。

#### Scenario: 作业目录里只有字节与三键
- **WHEN** 对着进程内的假 sidecar，转换 `<SANDBOX_ROOT 含哨兵段>/<owner>/<ws>/dir/报告 v2.docx`（1 MiB 随机内容），环境里 `PREVIEW_CACHE_DIR`、`OMP_STATE_DIR` 的路径都含哨兵段
- **THEN** 假 sidecar 看到 `jobs/<id>/in/报告 v2.docx` 的字节逐字节等于输入，`request.json` 的键恰为 `version`、`input`、`timeoutMs`，`input` 为 `报告 v2.docx`，`timeoutMs` 等于构造值；递归读 spool 树的每个文件，没有一个含任一哨兵段或输入的绝对路径；`convert` 落定为 `pdf/` 下一个 `0600` 的新文件，内容等于假 sidecar 写的 PDF；作业目录已不存在；没有子进程被启动

#### Scenario: 输入在 lstat 之后被换成符号链接
- **WHEN** 以钩子在 `openRegularFile` 之前把输入末段换成指向工作空间外文件的符号链接；另一例输入本就是符号链接
- **THEN** 两例都以 `failed` 失败，spool 里没有为它们建 `in/`，错误对象的 message 不含任何路径

#### Scenario: 标记到 kind
- **WHEN** 假 sidecar 分别：写 `done` 且输出完好；对输入 `report.v2@named.tar.docx` 写 `done` 且输出为 `out/report.v2@named.tar.pdf`；写 `failed`（原因码 `exit`）；写 `failed`（原因码 `bad-request`）；写出 0 字节的 PDF 后 `done`；把输出写成符号链接后 `done`；把输出写成没有写端的命名管道后 `done`；不建 `out/` 直接写 `done`
- **THEN** 前两例成功；其余六例都以 `failed` 失败，`pdf/` 下没有新增文件，作业目录被删除；命名管道一例在 1500 ms 内落定、没有读出任何字节

#### Scenario: 超时、中止与关停都写 cancel
- **WHEN** `timeoutMs` 为 200，假 sidecar 对一个作业不写任何标记；另一例在等待中中止调用方的 `signal`；另一例在等待中调用 `close()`
- **THEN** 三例分别以 `timeout`、`aborted`、`aborted` 失败；假 sidecar 在每个作业目录里都记录到 `cancel` 出现；作业目录随后被删除；`close()` 之后的 `convert` 立即以 `aborted` 失败

#### Scenario: 输出复制的字节上界
- **WHEN** 假 sidecar 写出的输出分别是：一份完好的 PDF，取得大小之后、复制结束之前又被追加了字节；一个 `size` 为 200 MiB + 1 字节的稀疏文件；一份 PDF，取得大小之后、读取之前被截短；一个恰 200 MiB 的稀疏文件
- **THEN** 第一例成功、结果字节数等于取得大小时的 `size`；第二例以 `failed` 失败且没有读取输出内容、`pdf/` 无新增；第三例以 `failed` 失败、`pdf/` 无新增；第四例成功、结果恰 200 MiB

#### Scenario: 检查次序与构造参数
- **WHEN** 不提供 `spoolDir` 调用 `convert`；已 `close()` 后调用；以 `ws/a.docx`（相对路径）调用；分别以 `cacheDir: "var/preview-cache"`、`spoolDir: "spool"` 构造
- **THEN** 前三例依次以 `unavailable`、`aborted`、`failed` 失败且 spool 里没有新建目录、没有子进程；后两例 `createOfficeConverter` 抛出 message 恰为 `cacheDir and spoolDir must be absolute paths` 的普通错误

### Requirement: 转换 sidecar 实现与镜像
仓库 SHALL 提供 `converter/`：`sidecar.mjs`（ESM，Node 24，零依赖）、`healthcheck.mjs`、`Dockerfile`、`compose.yml`。

`sidecar.mjs` SHALL：以 `CONVERTER_SPOOL_DIR`（缺省 `/spool`）为 spool 根，启动即以 `wx` 建或 touch `heartbeat`，之后每 `CONVERTER_HEARTBEAT_MS`（缺省 2000）touch 一次；每 `CONVERTER_POLL_MS`（缺省 200）列 `jobs/`（只看目录条目；普通文件——如测试夹具落在 `jobs/<id>.record.json` 的记录——SHALL 被跳过、不记日志），领取「有 `request.json`、没有 `done` / `failed`、不在在途表里、本进程未曾落定」的目录（按 `request.json` 的 mtime 升序）。本进程落定一个作业（写出或试图写出 `done` / `failed`，含领取时即落定的 `cancelled` / `bad-request`）时 SHALL 把它的 id 记入内存中的已落定集合，此后 SHALL NOT 再领取它、SHALL NOT 再写入它的目录：app 收到 `done` 后递归删除作业目录，删除途中 `done` 可能先于 `request.json` 消失，只认标记会把这个作业当成新作业重领、在缺了 `in/` 的目录里落成 `bad-request` 并写出 `failed`，使 app 的删除失败（#1601）。每轮列 `jobs/` 之后，SHALL 把本轮列表里已不出现的 id 移出该集合，集合大小不超过 `jobs/` 的目录数；集合只在内存，重启后为空（与 `SIGTERM` 不写标记、重启后重领一致），同时在途不超过 `CONVERTER_CONCURRENCY`（缺省 2，正整数）。每个作业：解析 `request.json`——键集恰为 `version`（= 1）、`input`（单一路径段：不含 `/` 与 NUL、不是 `.` / `..`、扩展名小写后为 `docx` / `xlsx` / `pptx`）、`timeoutMs`（正整数 ≤ 2147483647）——任一不成立或 `in/<input>` 不是普通文件 → `failed` 内容 `bad-request`，SHALL NOT 启动进程；否则以 `detached: true`、`cwd` 为作业目录、环境恰为 `{PATH, HOME: <作业目录>, LANG?}`、`stdio` 丢弃 spawn `CONVERTER_SOFFICE_BIN`（缺省 `/usr/bin/soffice`）与「转换隔离边界」第 5 条的参数集（`in/<input>` 经 `--outdir` 之后作为最后一项、以 `<作业目录>/` 开头的绝对路径传入，所以不需要对 `-` 开头的名字另设规则）；`timeoutMs` 到期 → 对进程组 `SIGKILL`、`failed` 内容 `timeout`；每轮对每个在途作业核对「`cancel` 出现**或**作业目录 / `request.json` 已不在」，任一成立 → 同样杀组、`failed` 内容 `cancelled`（目录已不在时该写入的 `ENOENT` 吞掉，容器日志行仍记 `cancelled`）；退出码 0 且 `out/<去扩展名>.pdf` 是大小 > 0 的普通文件（`lstat`）→ `done`；非 0 退出 → `failed` 内容 `exit`；被信号结束 → `failed` 内容 `signal`；退出 0 但无合格输出 → `failed` 内容 `no-output`。标记 SHALL 先写 `.part` 再 `rename`；作业目录在中途被 app 删除导致的 `ENOENT` SHALL 被吞掉、不影响其它作业。`jobs/` 由 app 建立；它尚不存在时 sidecar SHALL 视为空列表、不建目录、不限次数地继续轮询。sidecar SHALL NOT 删除作业目录、SHALL NOT 写 spool 根下 `heartbeat` 与 `jobs/` 之外的任何东西、SHALL NOT 在日志里写输入名或任何路径（每作业一行 `{"event":"convert","id":"<id>","result":"done|failed","reason":"<码或空>","ms":<n>}` 到容器 stderr）。收到 `SIGTERM` 时对全部在途作业杀组并以 0 退出。

`healthcheck.mjs` SHALL 以 `CONVERTER_SPOOL_DIR` 下 `heartbeat` 的年龄 < 10 s 退出 0，否则（含缺席）退出 1。

`Dockerfile` SHALL：`FROM node:24-bookworm-slim`；安装 `libreoffice-writer-nogui`、`libreoffice-calc-nogui`、`libreoffice-impress-nogui`、`fonts-dejavu-core`、`fonts-noto-cjk`（`--no-install-recommends`，清理 apt 列表）；复制两个脚本到 `/app/`；`ENTRYPOINT ["node","/app/sidecar.mjs"]`；`USER node` 作为非 root 的地板（运行时 `user:` 覆盖它）。`compose.yml` SHALL 只定义服务 `converter`：`build`、`network_mode: none`、`read_only: true`、`tmpfs: [/tmp]`、`init: true`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`、`user: "${WORKBUDDY_UID:?}:${WORKBUDDY_GID:?}"`（两个变量缺席时 compose SHALL 拒绝启动）、`volumes: ["${OFFICE_SPOOL_DIR:?}:/spool"]`、`healthcheck`（`node /app/healthcheck.mjs`：`heartbeat` 年龄 < 10 s 为健康）、`restart: unless-stopped`、`environment: [CONVERTER_CONCURRENCY=${OFFICE_CONVERT_CONCURRENCY:-2}]`。裸机与容器部署 SHALL 都以这个服务提供转换；Docker 是办公文档预览的部署前提。镜像由部署方按 `converter/Dockerfile` 自建（owner B9）：本 change SHALL NOT 引入镜像发布流水线或镜像仓库引用，CI 只在 job 里现场构建一次做实测。`converter/` 不是 npm workspace，但 SHALL 纳入 Biome 检查（`Makefile` 与根 `package.json` 的 `lint` / `fmt`）、`scripts/size-guard.sh`（`.mjs` 同样 ≤ 800 行）、jscpd 与 knip（根 workspace 的 `entry`，不用 `ignore`）。

#### Scenario: healthcheck 的两个方向（单元，子进程）
- **WHEN** 以 `CONVERTER_SPOOL_DIR` 指向临时目录运行 `node converter/healthcheck.mjs`：`heartbeat` 刚 touch 过；`heartbeat` 的 mtime 以 `utimes` 设为 30 s 前；`heartbeat` 缺席
- **THEN** 退出码依次为 0、1、1

#### Scenario: sidecar 脚本对着假 soffice（单元，子进程）
- **WHEN** 以 `CONVERTER_SPOOL_DIR` 指向临时目录、`CONVERTER_SOFFICE_BIN` 指向 `server/test/fixtures/fake-soffice.mjs`、`CONVERTER_POLL_MS=20`、`CONVERTER_HEARTBEAT_MS=50`、`CONVERTER_CONCURRENCY=1` 启动 `node converter/sidecar.mjs`，测试充当 app 写入作业：正常的 `报告.docx`；`in/@exit1.docx`；`in/@empty.docx`；`@sleep` 标记且 `timeoutMs: 200`；`@sleep` 标记且随后写 `cancel`；`@sleep` 标记且随后把整个作业目录删掉；六种不合法的 `request.json`（缺键、多键、`input` 含 `/`、`input` 为 `..`、扩展名 `html`、`timeoutMs` 为 `0` 或字符串）；`jobs/` 下另放一个普通文件 `x.record.json`
- **THEN** 正常例出现 `done`，`out/报告.pdf` 的字节等于假 `soffice` 的 PDF 字面量，假 `soffice` 记录的 argv 恰为参数集（`--outdir <作业目录>/out`、最后一项 `<作业目录>/in/报告.docx`）、环境键恰为 `PATH`、`HOME`、`LANG`、`HOME` 等于作业目录；`@exit1` → `failed` 内容恰为 `exit`；`@empty` → `no-output`；超时例 → `timeout` 且假 `soffice` 及其派生的子进程在有界时间内不存在；`cancel` 例 → `cancelled`、同上；目录被删例 → 假 `soffice` 及其派生的子进程在有界时间内不存在、sidecar 不退出、随后的作业照常、容器日志行记 `cancelled`；六种不合法 → `failed` 内容恰为 `bad-request`、假 `soffice` 零记录；普通文件被跳过、没有为它产生日志行；`heartbeat` 在 50 ms 周期内被持续更新；两个同时写入的作业按 `request.json` 的 mtime 次序、第二个在第一个落定后才启动；`jobs/` 在 sidecar 启动 300 ms 后才建出时此前不崩、建出后的作业照常；紧循环读作业目录直到标记出现，`failed` / `done` 一出现内容即完整且之后不变（同目录的 `.part` 名可能被短暂观察到）；`SIGTERM` 后在途作业的进程组不存在、sidecar 以 0 退出；容器日志行不含 `报告`；本文件 spawn 过的可执行文件的 basename 没有 `soffice`、`libreoffice`、`docker`

#### Scenario: 镜像与 compose 的标志（CI e2e）
- **WHEN** CI job `office-sidecar` 在 `ubuntu-24.04` runner 上 `docker build converter/`，以与 `compose.yml` 逐项相同的标志（`--network none --read-only --tmpfs /tmp --init --cap-drop ALL --security-opt no-new-privileges --user <runner uid>:<gid> -v <spool>:/spool`）运行它
- **THEN** `heartbeat` 在 30 s 内出现；以产品代码的 `createOfficeConverter` 转换一份 runner 上由 `python3 zipfile` 生成、含 `TargetMode="External"` http 图片链接的 docx 成功（见「转换隔离边界」第一个场景）；runner 的 uid 不在镜像 `/etc/passwd` 里而转换仍成功；`docker stop` 后容器以 0 退出
- **WHEN** 把 `--network none` 换成 `--network host`（变异，做后撤销；换成缺省 bridge 判不红——容器里的 `127.0.0.1` 是它自己的回环，打不到 runner 的监听器）
- **THEN** 监听器收到请求、PDF 含图——「0 次请求」断言判红

#### Scenario: 删除途中的作业不被重领
- **WHEN** 真 sidecar 把一个作业落定为 `done`（第一行 convert 日志），测试随即按「先删 `done` 与 `in/`、保留 `request.json`」的次序拆这个作业目录，并停留至少三个 `CONVERTER_POLL_MS`
- **THEN** sidecar 对该 id 没有第二行 convert 日志、目录里没有出现 `failed` 或 `failed.part`；测试随后删除整个目录成功
- **WHEN** 去掉已落定集合（变异）重跑同一用例
- **THEN** sidecar 写出第二行 convert 日志 `failed` / `bad-request`，目录里出现 `failed`

#### Scenario: 已落定集合有界
- **WHEN** 真 sidecar 落定若干作业，测试删除这些作业目录，之后在 `jobs/` 下以其中一个已删作业的 id 重建一个就绪作业目录
- **THEN** 重建的作业在一个 `CONVERTER_POLL_MS` 内被领取并落定（该 id 在目录消失后的那一轮已移出集合）
