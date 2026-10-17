## REMOVED Requirements

### Requirement: 转换器调用契约
**Reason**: owner B7（2026-10-17）：办公文档转换移出 app 进程，由 `--network none` 的 sidecar 容器承接；app 不再 spawn `soffice`，`sudo → setpriv → soffice` 前缀、两行办公文档 sudoers 规则、两种终止方式与 D-25 残余随之退役。本条九个场景里八个钉的是 spawn argv、`sudo` 形状与 `OMP_USER` 终止，整条替换为「sidecar 转换契约」。
**Migration**: 构造签名由 `{officeBin, cacheDir, timeoutMs, ompUser?}` 变为 `{spoolDir, cacheDir, timeoutMs}`；`{available, convert(absInput, signal?), close()}` 的返回形状、五种失败 kind、检查次序、输出复制纪律与 200 MiB 上界原样进入「sidecar 转换契约」。钉旧行为的测试按 design D9 表删除或改接缝。

### Requirement: 转换缓存
**Reason**: 同上。缓存键、命中、复制、周期清理不变；`<cacheDir>/work`、启动时的 `sudo … find`、终止句柄与 `preview_work_clear_failed` 退役——作业目录移到 spool 的 `jobs/`，属 app 自己的 uid，由本进程清空。本条五个场景里两个钉 `sudo`，整条替换为「转换缓存与作业目录清理」。
**Migration**: `OMP_USER` 部署删除 sudoers 第二行 `… /usr/bin/find <PREVIEW_CACHE_DIR>/work -mindepth 1 -delete`；`work/` 目录留着无害。

## ADDED Requirements

### Requirement: sidecar 转换契约
`createOfficeConverter({spoolDir?, cacheDir, timeoutMs, pollMs?, log?})` SHALL 返回 `{available, convert(absInput, signal?) → Promise<absPdf>, close()}`。`spoolDir` 未提供时 `available` 为 `false`，`convert` SHALL 以 `unavailable` 失败且不碰文件系统。`convert` 在建作业目录之前的检查次序 SHALL 为：`spoolDir` 未提供 → `unavailable`；已 `close()` 或 `signal` 已中止 → `aborted`；`absInput` 不是绝对路径 → `failed`；`<spoolDir>/heartbeat` 不新鲜（见「转换 sidecar 的健康与 fail-closed」）→ `unavailable`。`convert` SHALL NOT 启动任何子进程：转换由 sidecar 完成，app 只与 spool 目录交互。

每次真实转换 SHALL：(1) 以 `openRegularFile(absInput)`（workspaces/regular-file：末段 `O_NOFOLLOW`、`fstat` 判普通文件、取 `size`）打开输入——打开失败、不是普通文件（含 `lstat` 之后被换成符号链接）→ `failed`；(2) 新建作业目录 `<spoolDir>/jobs/<id>/`（`id` 为 32 个小写十六进制随机字符，目录 `0700`）与 `in/`；(3) 把输入恰 `size` 字节复制为 `in/<basename(absInput)>`（`wx`、`0600`；读到的少于 `size` → `failed`，不留半截）；(4) 先写 `request.json.part` 再 `rename` 为 `request.json`，内容为 `{"version":1,"input":"<basename>","timeoutMs":<timeoutMs>}`——恰这三个键，SHALL NOT 含任何路径、用户名或时间戳；(5) 每 `pollMs`（缺省 100）看 `done` / `failed`：`done` 出现 → 以与旧契约相同的纪律取 `out/<去掉最后一个扩展名>.pdf`（`O_NOFOLLOW` 打开、`fstat` 为大小 > 0 的普通文件、`size` ≤ 209715200 字节否则 `failed` 且不读、恰复制 `size` 字节进 `<cacheDir>/pdf/<随机名>.pdf`（`wx`、`0600`）、短读 → `failed` 且不留副本）；`failed` 出现 → `failed`（SHALL NOT 按原因码区分）；`timeoutMs` 到期 → 写 `cancel` 并以 `timeout` 失败；`signal` 中止 → 写 `cancel` 并以 `aborted` 失败；(6) 无论成败落定前递归删除作业目录（尽力而为，删除失败不改变结果）。写进 spool 的每一个字节 SHALL NOT 含 app 一侧的绝对路径（输入路径、`SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`、`OMP_STATE_DIR`）。

失败的错误对象 SHALL 只带 kind（`unavailable` / `failed` / `timeout` / `aborted` / `busy`），不带路径、原因码或底层错误。`close()` SHALL 对全部在途作业写 `cancel`、使它们以 `aborted` 落定并等收尾完成；此后的 `convert` 以 `aborted` 失败。构造时 `cacheDir` 或给出的 `spoolDir` 不是绝对路径 → `createOfficeConverter` SHALL 直接抛出 message 恰为 `cacheDir and spoolDir must be absolute paths` 的普通错误。`OMP_USER` SHALL NOT 影响本契约的任何一步：两种 uid 模式下 app 对 spool 做完全相同的事。

#### Scenario: 作业目录里只有字节与三键
- **WHEN** 对着进程内的假 sidecar，转换 `<SANDBOX_ROOT 含哨兵段>/<owner>/<ws>/dir/报告 v2.docx`（1 MiB 随机内容），环境里 `PREVIEW_CACHE_DIR`、`OMP_STATE_DIR` 的路径都含哨兵段
- **THEN** 假 sidecar 看到 `jobs/<id>/in/报告 v2.docx` 的字节逐字节等于输入，`request.json` 的键恰为 `version`、`input`、`timeoutMs`，`input` 为 `报告 v2.docx`，`timeoutMs` 等于构造值；递归读 spool 树的每个文件，没有一个含任一哨兵段或输入的绝对路径；`convert` 落定为 `pdf/` 下一个 `0600` 的新文件，内容等于假 sidecar 写的 PDF；作业目录已不存在；没有子进程被启动

#### Scenario: 输入在 lstat 之后被换成符号链接
- **WHEN** 以钩子在 `openRegularFile` 之前把输入末段换成指向工作空间外文件的符号链接；另一例输入本就是符号链接
- **THEN** 两例都以 `failed` 失败，spool 里没有为它们建 `in/`，错误对象的 message 不含任何路径

#### Scenario: 标记到 kind
- **WHEN** 假 sidecar 分别：写 `done` 且输出完好；写 `failed`（原因码 `exit`）；写 `failed`（原因码 `bad-request`）；写出 0 字节的 PDF 后 `done`；把输出写成符号链接后 `done`
- **THEN** 第一例成功；其余四例都以 `failed` 失败，`pdf/` 下没有新增文件，作业目录被删除

#### Scenario: 超时、中止与关停都写 cancel
- **WHEN** `timeoutMs` 为 200，假 sidecar 对一个作业不写任何标记；另一例在等待中中止调用方的 `signal`；另一例在等待中调用 `close()`
- **THEN** 三例分别以 `timeout`、`aborted`、`aborted` 失败；假 sidecar 在每个作业目录里都记录到 `cancel` 出现；作业目录随后被删除；`close()` 之后的 `convert` 立即以 `aborted` 失败

#### Scenario: 输出复制的字节上界
- **WHEN** 假 sidecar 写出的输出分别是：一份完好的 PDF，取得大小之后、复制结束之前又被追加了字节；一个 `size` 为 200 MiB + 1 字节的稀疏文件；一份 PDF，取得大小之后、读取之前被截短；一个恰 200 MiB 的稀疏文件
- **THEN** 第一例成功、结果字节数等于取得大小时的 `size`；第二例以 `failed` 失败且没有读取输出内容、`pdf/` 无新增；第三例以 `failed` 失败、`pdf/` 无新增；第四例成功、结果恰 200 MiB

#### Scenario: 检查次序与构造参数
- **WHEN** 不提供 `spoolDir` 调用 `convert`；已 `close()` 后调用；以 `ws/a.docx`（相对路径）调用；分别以 `cacheDir: "var/preview-cache"`、`spoolDir: "spool"` 构造
- **THEN** 前三例依次以 `unavailable`、`aborted`、`failed` 失败且 spool 里没有新建目录、没有子进程；后两例 `createOfficeConverter` 抛出 message 恰为 `cacheDir and spoolDir must be absolute paths` 的普通错误

### Requirement: 转换缓存与作业目录清理
转换结果 SHALL 缓存在 `<cacheDir>/pdf/<key>.pdf`，`key` 为 `sha256(<absInput 的 UTF-8> 0x00 <mtimeMs 的十进制> 0x00 <size 的十进制>)` 的小写十六进制，`mtimeMs` 与 `size` 取自调用时对输入的 `lstat`。命中（该文件存在且为大小大于 0 的普通文件）时 SHALL 把它的修改时间更新为当前时刻并直接返回，不写 spool。未命中时在转换成功后 SHALL 把输出**复制**为一个由本进程创建的新文件（先写 `pdf/` 下的随机名，再改名为 `<key>.pdf`），SHALL NOT 把作业目录里的输出直接改名进缓存——缓存里的每个文件都由应用用户创建并持有。`<cacheDir>` 与 `pdf` 的 mode 分别为 `2750`、`0700`（由 http-service-skeleton「预览监听器的装配与关停」在启动时建立）；`<cacheDir>/work` SHALL NOT 再被建立或使用。失败的转换 SHALL NOT 写缓存。

周期清理 SHALL 在启动时与此后每 24 小时各运行一次：删除 `pdf` 下修改时间早于「当前时刻 − 7 天」的普通文件。清理中的任何错误 SHALL 被吞掉，留待下一轮，不影响请求与退出码。缓存没有总量上限。

启动时对 `<OFFICE_SPOOL_DIR>/jobs` 的清空 SHALL 先于转换器受理第一次转换：由本进程递归删除 `jobs` 下的全部条目（`jobs` 自身不删；一项删不掉不挡其余），SHALL NOT 启动任何子进程、SHALL NOT 提权——sidecar 以与本进程相同的 uid 运行（「转换隔离边界」），作业目录里没有本进程删不掉的东西。未配置 `OFFICE_SPOOL_DIR` 或启动预检未通过时不碰 spool。单次转换之后对作业目录的删除仍是「sidecar 转换契约」的尽力而为。

#### Scenario: 命中、失效与复制
- **WHEN** 转换 `a.docx` 两次；随后改写 `a.docx`（大小或修改时间变化）再转换一次
- **THEN** 假 sidecar 恰收到两个作业（第一次与改写后）；第二次调用返回与第一次相同的路径且该文件的修改时间被更新；第三次返回不同的路径；缓存里的文件属于本进程的 uid、不是作业目录里那个 inode

#### Scenario: 失败不入缓存
- **WHEN** 一次转换以 `failed`、`timeout` 或 `aborted` 结束后，以正常应答的假 sidecar 对同一输入再转换
- **THEN** `pdf` 下在失败之后没有该 `key` 的文件；再次转换写了新作业并成功

#### Scenario: 周期清理与启动清空
- **WHEN** `pdf` 下有修改时间为 8 天前与 6 天前的两个文件，`<spool>/jobs` 下有一个遗留的作业目录，运行一次启动时清理
- **THEN** 8 天前的文件被删除，6 天前的保留，`jobs` 为空且自身仍在；把 `pdf` 目录换成不可读之后再运行一次清理，没有抛出错误；整个过程没有启动子进程

### Requirement: 转换隔离边界
每一次办公文档转换 SHALL 在 app 进程之外的转换容器（sidecar）里运行，边界由 Docker 的构造给出；本条定义边界的可观察行为：

1. **网络**：转换进程及其全部后代不可达任何网络（`network_mode: none`）。可观察：经 `/o/` 转换一份正文含 http 链接图片的文档时，该地址的监听器收到 0 次请求、转出的 PDF 不含该图片；对照——同一镜像以 `--network host` 直接运行 `soffice` 转换同一文档——监听器收到请求且 PDF 含图。
2. **可见文件系统**：转换进程可见的 SHALL 恰为镜像自己的只读根文件系统、tmpfs 的 `/tmp` 与 spool 卷；与本次转换有关的只有 `jobs/<id>/` 下的字节副本、`request.json`、`out/` 与 `profile`。`SANDBOX_ROOT`、工作空间、`OMP_STATE_DIR`、数据库、`PREVIEW_CACHE_DIR` 对它不存在，连路径字符串都不进 spool（「sidecar 转换契约」）。可观察：经 `/o/` 转换一份引用 `file://` 外部图片（放在工作空间里输入文件之外）的文档，PDF 不含该图片。
3. **身份**：转换进程以 sidecar 容器的 uid 运行，与 `OMP_USER` 无关；部署 SHALL 把该 uid/gid 对齐到 app 用户（compose `user:`），使 spool 里的一切属 app 用户、app 自己删得掉。两种 uid 模式下转换链相同：没有 `sudo`、没有 `setpriv`。
4. **终止**：超时、客户端断开与 `close()` 时 app 写 `cancel`；sidecar SHALL 在 ≤ 200 ms 内对该作业的 `soffice` 进程组发 `SIGKILL`；sidecar 自己的作业时限到期同样杀整组。可观察：终止后作业目录相关的进程（含 `soffice.bin`）不存在。
5. **不变的**：`soffice` 的参数集（`--headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file://<job>/profile --convert-to pdf --outdir <job>/out <job>/in/<name>`，sidecar 视角的路径）、环境键集恰为 `PATH`、`HOME`（= 作业目录）与存在时的 `LANG`、`stdio` 丢弃、输出复制纪律与 200 MiB 上界、缓存、排队、超时与失败文案。
6. **收窄而不闭合的残余**：`/o/` 的 `lstat` 之后输入末段被换成符号链接 → `openRegularFile` 以 `O_NOFOLLOW` 拒绝（`failed`）；中间目录被换成符号链接仍跟随（与 `/w/` 相同的书面残余，regular-file 头注释）。

数据类向量（xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、`INCLUDETEXT` / `INCLUDEPICTURE`、odt 链接节、ods 外部引用）登记为「未测、视为跟随」：边界以构造覆盖它们（要读的本地文件不在容器里、要走的网络不存在、ipc 命名空间里没有别的进程——读 Docker 手册推出），不为验证它们造文档（owner 2026-10-13 B1）。

#### Scenario: 链接资源不被取回（CI e2e 与测试主机）
- **WHEN** 以产品代码的 `createOfficeConverter` 对着真实镜像（`--network none`）转换一份正文插入本机监听器地址上 http 图片的 docx；对照：同一镜像 `--network host` 直接运行 `soffice` 转换同一文档
- **THEN** 前者成功、PDF 中 `/Subtype /Image` 为 0、监听器 0 次请求、`jobs/` 为空、PDF 属运行 app 的 uid；对照的监听器 ≥ 1 次请求且 PDF 含图
- **WHEN** 测试主机上经文件页与 `/o/` 转换带 http 图片的 docx、引用 `file://` 外部图片的 docx 与 pptx、含中文正文的 docx / xlsx / pptx 各一份
- **THEN** 全部 200；监听器 0 次请求；`file://` 图片不出现在 PDF 里；三种格式可在浏览器 PDF 查看器中翻页、中文可辨认

#### Scenario: 两种 uid 模式转换链相同（测试主机）
- **WHEN** 同 uid 模式与 `OMP_USER` 模式各起一次 app 并转换同一份 docx
- **THEN** 两种模式转出的 PDF 逐字节相同；spool 里的作业目录与输出都属 app 用户；app 没有启动 `sudo`；`OMP_USER` 模式下 omp 用户的进程列表里没有任何 `soffice`

#### Scenario: 终止结束作业的全部进程（测试主机）
- **WHEN** `OFFICE_CONVERT_TIMEOUT_MS=3000`，经 `/o/` 请求一份转换耗时约 25 s 的文档，504 之后在 1.5 s、5 s、30 s 三个时刻查看 sidecar 容器的进程；重复 5 次
- **THEN** 每次 504 的文案为「文档转换超时，请下载后查看」；三个时刻都没有命令行含该作业目录的进程（含 `soffice.bin`）；`jobs/` 下该作业目录已不存在；实际观察到的次数与结果如实写进 ADR-0010 补充，有存活时按观察改写措辞而不改本条的 SHALL

### Requirement: 转换 sidecar 的健康与 fail-closed
sidecar 的健康 SHALL 由 `<OFFICE_SPOOL_DIR>/heartbeat` 的修改时间表示：sidecar 每 2 s 更新一次，新鲜 = `now − mtime < 10000 ms`。

配置了 `OFFICE_SPOOL_DIR` 时，生产入口 SHALL 在装配应用（`createApp`）之前、构造办公文档转换器之前运行一次预检：(1) `OFFICE_SPOOL_DIR` 是目录、属本进程 uid、不带组与其它用户的写位——否则失败（SHALL NOT 校正 mode、SHALL NOT 建目录）；(2) 等 `heartbeat` 新鲜，至多 5000 ms（每 100 ms 看一次；等待覆盖与 sidecar 同时启动的冷启动）——到期仍不新鲜即失败。预检与心跳判定 SHALL 位于 `server/src/preview/office-sidecar-health.ts`，三个时间参数（等待上限、轮询间隔、新鲜阈值）可注入以便单元测试。预检 SHALL 永不 reject、永不使启动失败——它不是 http-service-skeleton「服务启动与装配」的启动阶段，`StartupStage` 不因它新增取值。未配置 `OFFICE_SPOOL_DIR` 时不预检、不写任何记录。

预检失败时系统 SHALL fail-closed（owner 2026-10-13 B3）：办公文档转换器以「未配置」的形态构造（`available` 为 `false`、`convert` 以 `unavailable` 失败且不碰 spool），preview-origin「预览令牌签发端点」的 `officeAvailable` 为 `false`，`/o/` 按「办公文档预览路由」答 503 固定文案「服务器未启用文档转换，请下载后查看」；SHALL NOT 回退为在 app 进程里启动 LibreOffice。随后 application stderr 经同一受管 writer 恰写一行 LF-terminated exact JSON `{"event":"office_convert_sidecar_unavailable"}`——只有 `event` 一个键，无原因、路径或配置值；写失败 SHALL 吞掉；该行位于 `server_started` 之前。预检通过时不写任何记录。

运行期每次 `convert` 在建作业目录之前 SHALL 看一次 `heartbeat`：不新鲜 → 以 `unavailable` 失败（`/o/` 答同一 503 固定文案）、不写 spool。缓存命中不经转换器（「转换缓存与作业目录清理」），所以 sidecar 宕机期间已缓存的文档照常可预览。日志 SHALL 边沿触发：从新鲜到不新鲜的第一次 `unavailable` 经构造时注入的 `log` 写一行同名记录 `{"event":"office_convert_sidecar_unavailable"}`，再次观察到新鲜时复位——一次 sidecar 宕机无论多少请求至多一行。`available` 是装配时的布尔快照，SHALL NOT 随运行期心跳翻转（与 `OFFICE_SPOOL_DIR` 未配置时的语义一致）。sidecar 在作业进行中死亡时 app 观察到的是自己的超时（`timeout`，504）；下一次 `convert` 的心跳检查才给 `unavailable`。

#### Scenario: 预检的两个方向（单元）
- **WHEN** 以 `pollMs: 20`、`waitMs: 400` 运行预检：spool 根缺席；spool 根是 `0770`；`heartbeat` 的 mtime 以 `utimes` 设为 30 s 前；`heartbeat` 在 100 ms 后才被写出；`heartbeat` 在 600 ms 后才被写出
- **THEN** 前三例与第五例落为 `false`、第四例为 `true`；第五例落定不早于 400 ms、不晚于 800 ms；没有一例 reject、没有一例建目录或 chmod

#### Scenario: 预检失败后的服务（编译入口）
- **WHEN** 编译入口分别以：`OFFICE_SPOOL_DIR` 指向不存在的路径；指向一个组可写（`0770`）的目录；指向一个属本进程、`0700`、但没有 `heartbeat` 的目录；指向一个 `heartbeat` 的 mtime 为 30 s 前的目录——启动
- **THEN** 四例都启动成功，stdout 的 `server_started` 照常；application stderr 在它之前恰有一行、整行等于 `{"event":"office_convert_sidecar_unavailable"}`；签发令牌得到 `officeAvailable` 为 `false`；以令牌请求 `/o/<token>/<docx>` 得到 503 与固定文案；spool 里没有新建作业目录；`PREVIEW_CACHE_DIR/pdf` 的启动清理照常发生
- **WHEN** `heartbeat` 在启动开始后 2 s 才由假 sidecar 写出（编译入口各方向只留这一例真实墙钟）
- **THEN** 启动成功、stderr 没有该记录、`officeAvailable` 为 `true`、转换成功
- **WHEN** 未配置 `OFFICE_SPOOL_DIR` 启动
- **THEN** 没有该记录、`officeAvailable` 为 `false`（既有行为）；`OFFICE_BIN` 仍被设置时进程 nonzero、stderr 恰一行 `{"event":"server_start_failed","reason":"config"}`，`resolveServerConfig` 抛出的 message 含 `OFFICE_BIN` 而不含输入值
- **WHEN** 让预检结果被忽略、不写该行、行多一个键或写两行、把 5 s 改为 0 或 30 s（变异，做后撤销）
- **THEN** 对应的 `officeAvailable`、503、整行精确与两个时间窗断言判红

#### Scenario: 运行期心跳的边沿触发（单元）
- **WHEN** 转换器对着假 sidecar 成功转换一次；随后假 sidecar 停止更新 `heartbeat` 直到它过期，调用 `convert` 三次；假 sidecar 恢复更新后再转换一次；再停止一次并调用 `convert`
- **THEN** 三次都以 `unavailable` 失败、spool 里没有新建作业目录、`log` 恰收到一条 `{"event":"office_convert_sidecar_unavailable"}`；恢复后的转换成功；第二次停止后再调用恰多一条同名记录（总计两条）
- **WHEN** 把 `staleReported` 的复位去掉，或把每次 `unavailable` 都写一行（变异，做后撤销）
- **THEN** 「总计两条」判红

#### Scenario: fail-closed 的两个方向（测试主机）
- **WHEN** 停掉 sidecar 容器后重启 app；app 运行中停掉 sidecar 后请求 `/o/`；再启动 sidecar 后请求；再停掉后请求
- **THEN** 依次：stderr 恰一行 `office_convert_sidecar_unavailable`、令牌 `officeAvailable=false`、`/o/` 503 固定文案；`/o/` 503 且 stderr 恰多一行；`/o/` 恢复 200 且没有新行；`/o/` 503 且恰再多一行

### Requirement: 转换 sidecar 实现与镜像
仓库 SHALL 提供 `converter/`：`sidecar.mjs`（ESM，Node 24，零依赖）、`healthcheck.mjs`、`Dockerfile`、`compose.yml`。

`sidecar.mjs` SHALL：以 `CONVERTER_SPOOL_DIR`（缺省 `/spool`）为 spool 根，启动即以 `wx` 建或 touch `heartbeat`，之后每 `CONVERTER_HEARTBEAT_MS`（缺省 2000）touch 一次；每 `CONVERTER_POLL_MS`（缺省 200）列 `jobs/`，领取「有 `request.json`、没有 `done` / `failed`、不在在途表里」的目录（按 `request.json` 的 mtime 升序），同时在途不超过 `CONVERTER_CONCURRENCY`（缺省 2，正整数）。每个作业：解析 `request.json`——键集恰为 `version`（= 1）、`input`（单一路径段：不含 `/` 与 NUL、不是 `.` / `..`、不以 `-` 开头、扩展名小写后为 `docx` / `xlsx` / `pptx`）、`timeoutMs`（正整数 ≤ 2147483647）——任一不成立或 `in/<input>` 不是普通文件 → `failed` 内容 `bad-request`，SHALL NOT 启动进程；否则以 `detached: true`、`cwd` 为作业目录、环境恰为 `{PATH, HOME: <作业目录>, LANG?}`、`stdio` 丢弃 spawn `CONVERTER_SOFFICE_BIN`（缺省 `/usr/bin/soffice`）与「转换隔离边界」第 5 条的参数集；`timeoutMs` 到期 → 对进程组 `SIGKILL`、`failed` 内容 `timeout`；看到 `cancel` → 同样杀组、`failed` 内容 `cancelled`；退出码 0 且 `out/<去扩展名>.pdf` 是大小 > 0 的普通文件（`lstat`）→ `done`；非 0 退出 → `failed` 内容 `exit`；被信号结束 → `failed` 内容 `signal`；退出 0 但无合格输出 → `failed` 内容 `no-output`。标记 SHALL 先写 `.part` 再 `rename`；作业目录在中途被 app 删除导致的 `ENOENT` SHALL 被吞掉、不影响其它作业。`jobs/` 由 app 建立；它尚不存在时 sidecar SHALL 视为空列表、不建目录、不限次数地继续轮询。sidecar SHALL NOT 删除作业目录、SHALL NOT 写 spool 根下 `heartbeat` 与 `jobs/` 之外的任何东西、SHALL NOT 在日志里写输入名或任何路径（每作业一行 `{"event":"convert","id":"<id>","result":"done|failed","reason":"<码或空>","ms":<n>}` 到容器 stderr）。收到 `SIGTERM` 时对全部在途作业杀组并以 0 退出。

`Dockerfile` SHALL：`FROM node:24-bookworm-slim`；安装 `libreoffice-writer-nogui`、`libreoffice-calc-nogui`、`libreoffice-impress-nogui`、`fonts-dejavu-core`、`fonts-noto-cjk`（`--no-install-recommends`，清理 apt 列表）；复制两个脚本到 `/app/`；`ENTRYPOINT ["node","/app/sidecar.mjs"]`；`USER node` 作为非 root 的地板（运行时 `user:` 覆盖它）。`compose.yml` SHALL 只定义服务 `converter`：`build`、`network_mode: none`、`read_only: true`、`tmpfs: [/tmp]`、`init: true`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`、`user: "${WORKBUDDY_UID:?}:${WORKBUDDY_GID:?}"`（两个变量缺席时 compose SHALL 拒绝启动）、`volumes: ["${OFFICE_SPOOL_DIR:?}:/spool"]`、`healthcheck`（`node /app/healthcheck.mjs`：`heartbeat` 年龄 < 10 s 为健康）、`restart: unless-stopped`、`environment: [CONVERTER_CONCURRENCY=${OFFICE_CONVERT_CONCURRENCY:-2}]`。裸机与容器部署 SHALL 都以这个服务提供转换；Docker 是办公文档预览的部署前提。`converter/` 不是 npm workspace，但 SHALL 纳入 Biome 检查、`scripts/size-guard.sh`（`.mjs` 同样 ≤ 800 行）与 jscpd。

#### Scenario: sidecar 脚本对着假 soffice（单元，子进程）
- **WHEN** 以 `CONVERTER_SPOOL_DIR` 指向临时目录、`CONVERTER_SOFFICE_BIN` 指向 `server/test/fixtures/fake-soffice.mjs`、`CONVERTER_POLL_MS=20`、`CONVERTER_HEARTBEAT_MS=50`、`CONVERTER_CONCURRENCY=1` 启动 `node converter/sidecar.mjs`，测试充当 app 写入作业：正常的 `报告.docx`；`in/@exit1.docx`；`in/@empty.docx`；`@sleep` 标记且 `timeoutMs: 200`；`@sleep` 标记且随后写 `cancel`；六种不合法的 `request.json`（缺键、多键、`input` 含 `/`、`input` 以 `-` 开头、扩展名 `html`、`timeoutMs` 为 `0` 或字符串）
- **THEN** 正常例出现 `done`，`out/报告.pdf` 的字节等于假 `soffice` 的 PDF 字面量，假 `soffice` 记录的 argv 恰为参数集（`--outdir <作业目录>/out`、最后一项 `<作业目录>/in/报告.docx`）、环境键恰为 `PATH`、`HOME`、`LANG`、`HOME` 等于作业目录；`@exit1` → `failed` 内容恰为 `exit`；`@empty` → `no-output`；超时例 → `timeout` 且假 `soffice` 及其派生的子进程在有界时间内不存在；`cancel` 例 → `cancelled`、同上；六种不合法 → `failed` 内容恰为 `bad-request`、假 `soffice` 零记录；`heartbeat` 在 50 ms 周期内被持续更新；两个同时写入的作业按 `request.json` 的 mtime 次序、第二个在第一个落定后才启动；一个作业目录在落定前被删除时 sidecar 不退出、随后的作业照常；`jobs/` 在 sidecar 启动 300 ms 后才建出时此前不崩、建出后的作业照常；紧循环读作业目录直到标记出现，从未观察到 `.part` 名或半截的 `failed` 内容；`SIGTERM` 后在途作业的进程组不存在、sidecar 以 0 退出；容器日志行不含 `报告`

#### Scenario: 镜像与 compose 的标志（CI e2e）
- **WHEN** CI job `office-sidecar` 在 `ubuntu-24.04` runner 上 `docker build converter/`，以与 `compose.yml` 逐项相同的标志（`--network none --read-only --tmpfs /tmp --init --cap-drop ALL --security-opt no-new-privileges --user <runner uid>:<gid> -v <spool>:/spool`）运行它
- **THEN** `heartbeat` 在 30 s 内出现；以产品代码的 `createOfficeConverter` 转换一份 runner 上由 `python3 zipfile` 生成、含 `TargetMode="External"` http 图片链接的 docx 成功（见「转换隔离边界」第一个场景）；runner 的 uid 不在镜像 `/etc/passwd` 里而转换仍成功；`docker stop` 后容器以 0 退出
- **WHEN** 去掉 `--network none`（变异，做后撤销）
- **THEN** 监听器收到请求、PDF 含图——「0 次请求」断言判红

## MODIFIED Requirements

### Requirement: 并发上限与排队
同一时刻运行中的转换数 SHALL 不超过 `concurrency`（`OFFICE_CONVERT_CONCURRENCY`，缺省 2）；这里计的是由转换器写入 spool、其 `convert` 尚未落定的作业。超出的调用 SHALL 排队，按到达次序在有空位时启动；排队中的调用数达到 8 时，新到的调用 SHALL 立即以 `busy` 失败、不入队。同一个缓存键（见「转换缓存与作业目录清理」）的并发调用 SHALL 共用同一次转换与同一个结果，只占一个运行或排队位置。排队中的调用被其 `signal` 中止时 SHALL 出队并以 `aborted` 失败，不写 spool；共用同一次转换的多个调用里只有全部都中止时才对该作业写 `cancel`。sidecar 自己的 `CONVERTER_CONCURRENCY` 是它的保险，部署 SHALL 使它不小于 `OFFICE_CONVERT_CONCURRENCY`；小于时作业只是在 spool 里多等，不出错。

#### Scenario: 不超过上限并按序启动
- **WHEN** `concurrency` 为 2，假 sidecar 在收到放行信号前不写标记，对五个不同的输入同时调用 `convert`
- **THEN** 任一时刻 spool 里未落定的作业至多 2 个；放行一个之后恰有下一个作业出现；五个最终都成功，作业出现次序等于到达次序

#### Scenario: 队满
- **WHEN** `concurrency` 为 1，一个转换在运行、八个在排队时再调用第十个
- **THEN** 第十个立即以 `busy` 失败，没有为它写作业；先前九个不受影响

#### Scenario: 同一输入只转一次
- **WHEN** 对同一个未缓存的输入同时调用 `convert` 三次
- **THEN** spool 里恰出现一个作业，三次调用落定为同一个路径；其中一个调用中止时另外两个照常成功

### Requirement: 真实转换的人工验证
CI 的单元测试与编译入口测试 SHALL NOT 依赖 LibreOffice 与 Docker：app 侧的全部自动化测试以进程内的假 sidecar（临时 spool 目录的应答器）与注入的转换器替身完成，sidecar 脚本的测试以仓库内的假 `soffice` 可执行脚本完成。真实镜像只在 CI job `office-sidecar`（「转换 sidecar 实现与镜像」）与测试主机上运行。真实转换 SHALL 作为一次人工验证在装有 Docker 的 Linux 主机上、按 app 裸机 + sidecar 容器与 app 容器 + sidecar 容器两种部署形态进行，并把结果记入 ADR-0010 补充与 ADR-0014：`docx`、`xlsx`、`pptx` 各一份（含中文正文）经 `/o/` 得到可在浏览器内置查看器里翻页的 PDF；带 http 图片与 `file://` 图片的文档转出的 PDF 不含这些图片、监听器 0 次请求；两种 uid 模式下 spool 与缓存文件都属应用用户、app 未启动 `sudo`；一次被超时终止的转换之后，sidecar 容器里以该作业目录为参数的进程是否残留——如实记录；停掉 / 启动 sidecar 时 fail-closed 的两个方向；冷 / 热 profile 的转换耗时。ADR-0014 的运维一节 SHALL 写明两种部署形态的步骤、`office_convert_sidecar_unavailable` 的排障（`docker compose ps` / `heartbeat` 年龄 / spool 属主与 mode）、以及 `OMP_USER` 部署删除两行办公文档 sudoers 规则。

#### Scenario: 自动化测试不需要 LibreOffice
- **WHEN** 在没有安装 LibreOffice 与 Docker 的环境里运行 `make check`
- **THEN** 办公文档相关的全部测试通过；测试没有尝试执行名为 `soffice`、`libreoffice` 或 `docker` 的系统命令

#### Scenario: 人工验证记录
- **WHEN** 评审本 change 的收尾 PR
- **THEN** ADR-0010 补充里有一节记录两种部署形态下三种格式的真实转换结果、http 与 `file://` 图片的对照、spool 与缓存文件属主、超时后残留进程是否出现（出现时的进程名）、fail-closed 两个方向、所用镜像基底与 LibreOffice 版本；ADR-0014 的运维一节有两种部署形态的步骤与排障；两处都写明两行办公文档 sudoers 规则已退役

#### Scenario: CI 端到端（需 owner 确认）
- **WHEN** PR CI 运行 `office-sidecar`
- **THEN** 「转换 sidecar 实现与镜像」场景「镜像与 compose 的标志」的全部断言通过，`all-checks-passed.needs` 含它
