# 远程挂载以 FUSE 按工作空间实体化到沙箱内

omp 子进程用 bash/文件工具直接操作文件，挂载内容必须以真实文件系统路径出现；demo（行为基准）
要求用户自助填凭证、在线状态、即时挂载/卸载。决定：SFTP/NFS/SMB 用 rclone mount/sshfs 以 FUSE
按工作空间挂载到该用户沙箱内的挂载点，mount-manager 负责进程生命周期与崩溃重挂。

## Considered Options
- 管理员 OS 级挂载 + 路径登记：最稳，但 demo 的用户自助凭证 UI 降级为管理员专属（裁剪行为基准）。
- 同步到本地缓存：零特权，但引入陈旧性与写回语义两大难题，SMB/NFS 纯 Node 客户端生态差。

## Consequences
部署包带 fuse3 + rclone；挂载点纳入沙箱白名单推导；挂载凭证由 app-server 保管（不落沙箱），
且只经受权限保护的 rclone 配置文件注入（属主 app-server、路径在全部沙箱白名单之外），绝不出现在
命令行参数——沙箱是文件系统边界而非进程隔离，命令行对同 uid 的 omp bash 经 ps 可见。

## 2026-10 补充（#1665）：rclone 三后端跨 uid 挂载的前置实测

S1b 的前置条件（`IMPLEMENTATION_PLAN.md:545-546`）：app uid 挂载、omp uid 读写、凭证对 omp 不可读三者能同时成立。本节逐项记录 #1665 的探针 P1–P8 与补充探针 P1′、P2′、P4′、P9–P15，供 change `s1b-workspace-mounts` 的 Open Questions 引用。结论分三档：「成立」指探针的预期全部被观测到；「不成立」指预期被观测推翻；「偏差」指主要预期成立，但观测到 design 没有写到、会改变实现的行为。全部条目都是实测（2026-10-25）。命令用占位写法，原始输出不入库。

**环境**

| 项 | 值 |
|---|---|
| 容器形态 | 测试主机上的一次性容器 `ubuntu:24.04`：`docker run -d --device /dev/fuse --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt apparmor=unconfined`，容器内 `apt-get install rclone fuse3 openssh-server iptables python3-minimal smbclient …`。用完即删 |
| 版本 | rclone `v1.60.1-DEV`（Ubuntu 24.04 包，与测试主机宿主所装相同）、fuse3 / fusermount3 3.14.0、内核 6.8.0-117-generic、OpenSSH 9.6p1、samba 4.19.5 |
| sftp 目标 | 探针容器内的 sshd，同一个账号既配口令（P1–P11）也配公钥（P12） |
| smb 目标 | 另一个一次性容器（samba 4.19.5，`--security-opt seccomp=unconfined`）。原因：samba 4.19 在 docker 默认 seccomp 配置下打开共享根得 `EPERM`，`smbclient` 同样报 `NT_STATUS_ACCESS_DENIED`，与 rclone 无关 |
| local 目标 | 探针容器内一个属 app uid、`0700` 的 OS 目录（模拟管理员登记的挂载源） |
| 身份 | 同 `.github/scripts/ci-uid-isolation.sh`：app uid 与 omp uid 主组都是 `workbuddy`。app uid 另在组 `fuseapp`（P10 用，omp 不在其中）；另有一个 other uid，不在这两个组里。`/etc/fuse.conf` 加了 `user_allow_other` |
| 布局 | 空间根 `2770` 属 app uid、组 `workbuddy`。私有目录 `<state>/mounts` `0700`，其下 `<id>/` `0700`；`rclone.conf` `0600`，由 app uid 以 umask `077` 写出 |
| 降权 | 以 root 经 `env -i PATH=… HOME=… setpriv --reuid --regid --init-groups --` 启动。exec 链保持同一个 pid，所以 `$!` 就是 rclone 的 pid。双方 umask `007`。真实 omp 与 sudo launcher 不参与 |
| 观测 | omp uid 一侧的每个文件操作由一个 python3 小工具单独发出，打印 errno 名与耗时 |

**结论总表**

| 编号 | 结论 | 一句话 |
|---|---|---|
| P1 | 成立（smb 附带偏差） | 三后端下 omp uid 的建、读、写、改名、删全部成功；smb 往共享根写文件时会在根下建一个 `．`（U+FF0E）目录 |
| P2 | 成立 | omp uid 读 conf 得 `EACCES`；`ps` 与 `cmdline` 里没有口令与 obscure 串；`environ` 得 `EACCES` |
| P3 | 成立 | `--read-only` 下的写类操作一律得 `EROFS` |
| P4 | 成立 | kill -9 之后的调用立即得 `ENOTCONN`，不会卡住；mountinfo 项保留；`-u` 成功之后 `-uz` 报 not found；可以立即重挂 |
| P5 | 成立；D10 / D12 有偏差 | 占用时 `-u` 得 `EBUSY`，`-uz` 成功。SIGTERM 时回写窗口里的数据只留在 cache 目录；sftp / smb 换了 IP 重挂就不再续传 |
| P6 | 成立 | fstype 为 `fuse.rclone`；`rmdir` 得 `EBUSY` 且该项在 mountinfo 里；`st_dev` 与父目录不同 |
| P7 | 偏差 | 远端改写之后，同一 fd 会读到新旧混合的字节或提前 EOF，`fstat` 的大小仍是旧值 |
| P8 | 成立；挂载内改名有偏差 | 三个跨边界方向都得 `EXDEV`。目录改名之后再删掉其中尚未回写的新文件，回写会把该文件复活到远端；目录改名到已存在的目录得 `EEXIST` |
| P1′ | 不成立（落在预定退路内） | 完整 argv 三后端都通过；但 sftp / smb 的 mountinfo 来源字段是 `<段名>{5 位}:…`，不是 design 预期的以 `<段名>:` 开头 |
| P2′ | 成立 | `rclone obscure -` 读标准输入，末尾换行不计入口令；`ps` 只显示 `rclone obscure -` |
| P4′ | 不成立（超出预定退路） | 断网之后，挂载根与已缓存目录的 `stat`、`readdir` 都在 0 ms 内由缓存应答 |
| P9 | 成立 | SIGKILL rclone 再 `-uz` 之后，阻塞中的调用约 10 ms 内返回 `ENOTCONN` / `ECONNABORTED` |
| P10 | 成立 | statoverride 之后 omp 不能执行 fusermount3 / fusermount，也不能自挂；app uid 照常挂载 |
| P11 | 不成立（smb，落在预定退路内）；sftp 有偏差 | 只测了口令错误：smb 照样挂上；sftp 以 rc=1 退出，但默认重试下要约 23 s |
| P12 | 成立 | `key_pem` 的单行 `\n` 写法，RSA PEM 与 OpenSSH ed25519 两种私钥都能挂载 |
| P13 | 成立 | 不带 `--links` 时，源里的符号链接（指向源外的和源内的都算）在挂载里都看不到；在挂载里建符号链接得 `EIO` |
| P14 | 成立 | 预建的 `0600` 日志被追加内容之后仍是 `0600`；rclone 自建时为 `0640` |
| P15 | 静态情形成立；竞态有偏差 | 最后一段是符号链接时 fusermount3 拒绝；目录与符号链接竞态交换时，两轮 300 次中有 35 次挂到了链接目标上 |

**逐项记录**

- **P1 跨 uid 读写**（issue 原 argv：`rclone mount <remote>: <mnt> --config <conf> --allow-other --uid <omp> --gid <workbuddy> --umask 007 --vfs-cache-mode writes`，三后端各一次）：
  - 挂载在 100–300 ms 内出现。挂载根对 omp 显示为 `0770`、属 omp uid、组 `workbuddy`；新文件为 `0660`。
  - omp uid 依次执行 `stat`、`readdir`、读已有文件、`O_CREAT|O_EXCL` 新建、读、`O_APPEND` 追加、`rename`、`mkdir`、在新目录里建文件并删除、`rmdir`、`unlink`，全部 `OK`。app uid 经共享组读到同样的内容。
  - 回写（默认 5 s）之后，远端出现文件、内容一致，`unlink` 之后从远端消失。local 后端落盘的文件属 app uid、为 `0660`。
  - **smb 附带偏差**：往共享**根目录**写文件（经 VFS 缓存回写或直写都一样）时，rclone 在共享根下建出一个名为 `．`（U+FF0E，全角句点）的目录。它出现在挂载视图与其它 SMB 客户端的视图里，删掉之后下次往根目录写文件又会建出来。在根目录下 `mkdir`、往子目录写文件都不会建它（各测一次）。推测是 smb 后端在上传根目录文件之前对父目录做 `Mkdir` 时，`.` 被编码成了全角字符，未读源码证实。
- **P2 凭证隔离**（sftp、smb，挂载期间以 omp uid 观测）：
  - omp uid 对 `<state>/mounts`、`<state>/mounts/<id>` 的 `readdir`，以及对 `rclone.conf` 的 `stat` 与读，全部得 `EACCES`（父目录 `0700` 先挡住）。
  - omp uid 的 `ps -eo args` 与 `/proc/<rclone pid>/cmdline`（`0444`、可读）里只有 argv：配置文件路径、挂载点、uid/gid，以及 P1′ 起的主机 IP。逐字比对后，口令与 conf 里的 obscure 串都没有出现。
  - `/proc/<pid>/environ`（`0400`）、`/proc/<pid>/fd`、`/proc/<pid>/maps` 对 omp uid 都是 `EACCES`。
  - 测量方式的订正：第一轮把后台子 shell 的 pid 当成了 rclone，`ps` 里的命中其实是 grep 自己的 argv。改为 exec 链取 pid、先存快照再比对之后得到上面的结果。
- **P3 只读挂载**（加 `--read-only`，三后端）：mountinfo 的挂载选项为 `ro`；omp uid 读成功；新建、追加、`unlink`、`mkdir`、`rename`、`chmod` 原样得 `EROFS`。
- **P4 断连与崩溃**（kill -9 rclone，三后端）：
  - 之后 `stat` 挂载根、`readdir` 挂载根、`stat` 子文件，omp uid 与 app uid 都在 0 ms 内得 `ENOTCONN`，不会卡住。mountinfo 里该项保留。
  - 挂载点空闲时：`fusermount3 -u` 返回 0、该项消失；接着 `-uz` 得 `entry for <mnt> not found in /etc/mtab`、rc=1。
  - 有 omp 进程的 cwd 在挂载内时：`-u` 得 `Device or resource busy`、rc=1；`-uz` 返回 0、该项消失。之后该进程在 cwd 里的 `readdir` 与新建都得 `ENOTCONN`。
  - 两种情形下，同一挂载点都能立即重挂（100–300 ms 出现），读写正常。
- **P5 占用卸载**（omp uid 一个进程的 cwd 在挂载的子目录里，另一个进程持有挂载内文件的 `O_RDWR` fd，三后端）：
  - `fusermount3 -u` 得 `Device or resource busy`、rc=1；`-uz` 返回 0，mountinfo 项立即消失。
  - 挂载点路径再被 `readdir` 时，看到的是下面的空目录。
  - rclone 仍在运行。两个持有者照常工作：fd 一方的 `pread`、`pwrite`、`fstat` 都成功；cwd 一方的 `readdir` 与新建都成功，远端也出现了新建的文件。
  - fd 持有者退出之后 rclone 仍在（cwd 还是一个引用）。最后一个引用释放之后约 100 ms 内 rclone 以 rc=0 退出；退出之前已把 fd 里写的内容上传，远端为 `before-unmount` 加 `after-unmount-1`。
  - **D10 次序的偏差**：照 D10 的「`-uz` → SIGTERM」执行时：
    - sftp、local：rclone 约 100 ms 内以 rc=143 退出；持有者其后的 `pread`、`pwrite`、`fstat` 都得 `ENOTCONN`。
    - sftp、local：一个在 SIGTERM 之前已关闭、仍在 5 s 回写窗口里的文件**没有上传**；持有中的 fd 写过的内容也没有上传。两者只留在 `--cache-dir`（`vfs/`、`vfsMeta/`）里。
    - 不先 `-uz`、直接 SIGTERM 时同样不上传（local、sftp 各一次）。
    - 以同一个 `--cache-dir` 重挂时：local 的日志写 `vfs cache: queuing for upload in 5s`，随后两个文件都上传成功；sftp 只有在 `--sftp-host` 给**同一个 IP** 时才上传成功。换一个 IP 重挂时，来源字段的后缀由 `{17Yim}` 变成 `{dLUoA}`，而缓存路径带着旧后缀（`cache/vfs/<段名>{17Yim}/…`），等了 8 s 也没有上传，那个文件成了孤儿。smb 没测，它的缓存路径同样带后缀。
    - 由此：D10 的卸载之后会递归删除私有目录，回写窗口里的写入随之丢失，这是 Epic #1679 (m) 与 design Risks 已接受的残余，这里补上实测细节：窗口约 5 s，持有中的 fd 写过的内容也算在内。D12 的关停保留私有目录，Risks 说「重挂时 rclone 续传」：local 成立；sftp / smb 只在 D3 每次解析出的 IP 不变时成立，IP 变了，待上传的数据就留在缓存里不再上传，直到卸载时随私有目录一起删掉。
- **P6 挂载点判据**（三后端）：
  - mountinfo 里 fstype 为 `fuse.rclone`；超级块选项为 `rw,user_id=<app>,group_id=<app 主组>,allow_other`，加了 `--default-permissions` 时多一项 `default_permissions`。
  - app uid 对挂载点 `rmdir` 得 `EBUSY`，同时该项在 mountinfo 第 5 字段里。#1237 的「`EBUSY` 且在 mountinfo 里」判据对 rclone 挂载成立。
  - 挂载点的 `st_dev` 与空间根不同（120 对 63），快照的 `dev` 规则可用。
- **P7 按描述符读**：
  - 读法同 ADR-0010 的 `openRegularFile`：`lstat`，再以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开，对 fd `fstat`，之后只用 `pread` 读这个 fd。由 app uid 执行。文件 40 MiB，三后端在挂载上都能照常走完这一套。
  - 读到第一处之后，在远端改写文件，再经同一个 fd 读：
    - **原地等长改写**（sftp、local，内容由 `A` 改为 `B`）：`@0`、`@30M` 仍是 `A`（rclone 的读缓冲），`@20M`、`@39M` 已是 `B`，即同一次响应会混入新旧两版字节、不报错。`fstat` 仍为 40 MiB。
    - **换成更短的文件**（sftp、local 是 rename 进来一个 20 MiB 的 `C`；smb 是 `put` 覆盖为 20 MiB）：`@0` 是缓冲里的 `A`；`@20M`、`@30M`、`@39M` 返回 0 字节，rclone 日志里是 10 次 `low level retry … EOF` 加一条最终的 `ReadFileHandle.Read error: EOF`。`fstat` 仍报 40 MiB。
    - **改写之后重新打开**：内容已是新的（`B` 或 `C`），但 `fstat` 与 `stat` 仍报 40 MiB（目录缓存，默认 5 分钟）。按 `fstat` 的大小发 `Content-Length` 会少发字节。
  - ADR-0010 的「打开之后路径被替换，不影响本次响应」在挂载内不成立：rclone 的 fd 不固定 inode 与内容。
- **P8 跨文件系统**（三后端）：
  - 下面三个方向的 `rename` 都原样得 `EXDEV`：挂载内 → 空间根下的 `.trash`（omp uid、app uid）；挂载内 → 空间根（omp uid、app uid，local 一次）；空间根 → 挂载内（omp uid 三后端，app uid local 一次）。这佐证了「挂载内删除与跨边界移动一律拒绝」的必要。
  - 挂载内部的文件改名、文件移入子目录、目录改名，都一次 `rename` 成功，回写之后远端结构与挂载视图一致；sftp、smb、local 都一样，步骤之间不停顿和各停 7 s 都测过。把目录改名到一个已存在的目录时，不论它空不空都得 `EEXIST`，日志为 `can't copy directory - destination already exists`。POSIX 的语义是空目录可被替换、非空得 `ENOTEMPTY`，D16 的错误映射要按 rclone 的这个行为写（local 实测）。
  - **偏差**：在 5 s 回写窗口内，先把含有新文件的目录改名，再 `unlink` 该文件并 `rmdir` 该目录。挂载视图里两者都已消失，但回写到期之后远端出现了改名后的目录和那个文件。
    - sftp 复现两次、local 复现一次；首轮 P8 也留下过同类残留。
    - 不经目录改名时不复现：「新建后删除」「新建、改名、删除」「新建、移入目录、删除」三种只在 sftp 上各跑了一次，都没复现；smb 没测。
    - 加 `--vfs-write-back 0s` 时，这个序列在 sftp 上跑了一次没有复现；只此一次，不足以说明能关上。
- **P1′ 完整 argv**：
  - 命令为 `rclone mount <段名>:<远端> <挂载点> --config <conf> --cache-dir <私有>/cache --log-file <私有>/rclone.log --log-level NOTICE [--allow-non-empty] [--sftp-host <IP> | --smb-host <IP>] --vfs-cache-mode writes --allow-other --default-permissions --uid <omp> --gid <空间根 gid> --umask 007`。段名 `m` 加 32 位 hex；环境恰为 `PATH`、`HOME=<私有目录>`。三后端各一次。
  - conf 里的 `host` 写成不可解析的 `unresolvable-host.invalid`，argv 的 `--sftp-host` / `--smb-host` 给 IP 字面量，挂载照常成功：argv 覆盖生效。
  - omp uid 的整套读写成功，其中 `chmod` 成功、mode 无变化。app uid 经组读写成功。other uid 对挂载根的 `stat`、`readdir` 与读文件全部得 `EACCES`（`--default-permissions` 加 `--umask 007` 生效）。rclone 的 `environ`（由 app uid 读）恰为 `PATH`、`HOME`。私有目录里只有 `cache/vfs`、`cache/vfsMeta`、`rclone.conf`、`rclone.log`。
  - `--allow-non-empty` 被 fuse3 接受。不加这个参数时，rclone 1.60.1 也能挂到一个含残留文件的目录上；卸载之后残留文件重新显形。
  - **偏差**：mountinfo 的来源字段（`-` 之后第二个字段）在 sftp、smb 上是 `<段名>{17Yim}:/srv/…` 与 `<段名>{fsZwP}:share`。rclone 的 `-vv` 日志写明 `detected overridden config - adding "{17Yim}" suffix to name`，即 argv 覆盖了配置项时，名字会加一个由覆盖内容决定的 5 字符后缀。local 后端没有覆盖，是 `<段名>:/srv/local-src`。D9「来源字段以 `<段名>:` 开头」的扫描会漏掉 sftp、smb 的挂载，应改为以 `<段名>:` 或 `<段名>{` 开头。design 原先预期的形状被推翻，所以记为「不成立」。Epic #1679 (n) 已为此预授权「P1′ 不成立只改 D7 / D9 与 spec 的 argv 一句」；实际要改的是 D9 与 workspace-mounts 里的来源匹配一句，design Open Questions 也已把「段名在 mountinfo 来源字段里的形状」列为待测项。
  - 第 5 字段（挂载点）逐字节等于 argv 给的路径。
- **P2′ `obscure` 经标准输入**：
  - `printf '%s' <口令> | rclone obscure -` 与 `printf '%s\n' <口令> | rclone obscure -` 的结果，经 `rclone reveal` 还原后都是原口令，末尾换行不计入。口令里的空格与 `#` 原样保留。
  - `obscure` 在等待标准输入期间，omp uid 的 `ps` 只看到 `rclone obscure -`。
  - 用它写出的 conf 在 P1′、P2–P8 里都正常挂载。
- **P4′ 网络黑洞**：
  - 做法：sftp、smb 各测一次。rclone 存活，用 `iptables -j DROP` 双向丢弃到远端端口的报文。挂载根与 `hit/` 事先 `readdir` 过（缓存命中），`miss*/` 从未列过（缓存未命中）。每次调用以 SIGKILL 限在 120 s 内。
  - **缓存命中**：挂载根的 `stat` 与 `readdir`，`hit/` 的 `stat` 与 `readdir`，`hit/f.txt` 的 `stat`，两后端、带不带短超时，全部 `OK`、0 ms。未列过的 `miss/` 的 `stat` 也是 0 ms，因为它的目录项在挂载根的列表里。
  - **缓存未命中，默认超时**（`--contimeout` 60 s、`--timeout` 5 m）：`readdir miss2/` 与读 `hit/f.txt`，两后端都在 120 s 上限处被 SIGKILL 结束、没有返回；rclone 一直存活。
  - **缓存未命中，`--contimeout 5s --timeout 10s`**：sftp 的 `readdir` 52 s、读 60 s 得 `EIO`；smb 的 `readdir` 10 s、读 100 s 得 `EIO`。日志为 `dial tcp …: i/o timeout` 与 `Open failed: connection lost`。
  - 被 SIGKILL 的阻塞调用都退出了：FUSE 等待可以被 SIGKILL 打断，D11 的探测子进程超时之后 SIGKILL 的做法可行。
  - **不成立**：Open Questions 预定的退路是把探测改为子进程里对挂载根 `readdir`，但挂载根的 `readdir` 同样由缓存应答。在目录缓存期（默认 5 分钟）内，对挂载根做 `stat` 或 `readdir` 都判不出远端已断。缓存过期之后会怎样没有测。适配器的 10 s 期限只对缓存未命中的请求起作用。
- **P9 卡住的请求能否释放**（P4′ 黑洞期间，四种配置各一次）：
  - 先让 omp uid 的两个调用阻塞 3 s：`readdir miss3/` 与 `stat miss3/f.txt`。
  - 然后 SIGKILL rclone（3–6 ms 内回收），再以 app uid 执行 `fusermount3 -uz`（rc=0）。两个调用在 SIGKILL 之后 8–13 ms 内返回，errno 一个是 `ENOTCONN`、一个是 `ECONNABORTED`（两者谁得哪个不固定）。mountinfo 项消失。
  - 两步只隔几毫秒，没有分开测「只 SIGKILL」与「只 `-uz`」各自的效果。
- **P10 omp 不能自挂 FUSE**：
  - **基线**（Ubuntu 原装 `fusermount3` 为 `4755 root:root`）：omp uid 在自己可写的空间根下 `rclone mount … --allow-other`，100 ms 挂上（mountinfo `user_id=<omp>`）；app uid 对它 `readdir` 成功，即 app 会进入一个由 omp 控制的 FUSE。
  - 执行 `dpkg-statoverride --update --add root fuseapp 4750 /usr/bin/fusermount3` 之后：`/usr/bin/fusermount3` 为 `-rwsr-x--- root fuseapp`。`/usr/bin/fusermount` 与 `/bin/fusermount3` 是同一个文件（前者是符号链接，后者经 usrmerge），所以三者同时受限。
  - omp uid 跑 `rclone mount` 时，挂载出现之前就以 rc=1 失败（`exec: "fusermount": executable file not found in $PATH`）；omp uid 进程里的 python `execv` 得 `EACCES`。补测：omp uid 进程里的 shell 执行 `fusermount3 -V` 与 `fusermount -V`，都得 `Permission denied`、rc=126；同一身份下 `/proc/self/status` 的 `CapPrm`、`CapEff` 全零，`os.access(X_OK)` 为 False。
  - app uid（在 `fuseapp` 里）照 D7 argv 挂载成功，omp 读写正常。`fuseapp` 不是 `workbuddy`。
  - 测量方式的说明：由 root 经 `setpriv --reuid=<omp>` **直接** exec `fusermount3` 时，打印了版本号、rc=0，原因没有查明；上面的结论只依据 omp uid 进程自己发起的 exec。生产里 omp 经 `sudo -u omp` 启动、由 omp 身份的 setpriv 再 exec，这种形态本节没有测。
  - **附带观测**：rclone 1.60.1 在 PATH 上查找的是 `fusermount`，不是 `fusermount3`。D4 两个名字都查，与此相符；部署时 PATH 上必须有 `fusermount`（Ubuntu 的 fuse3 包把它装成指向 `fusermount3` 的符号链接）。
- **P11 错误凭证**（完整 argv，只测了口令错误；design 的探针表还列了私钥错误与共享名错误，都没测）：
  - **sftp**：挂载点从未出现在 mountinfo 里，rclone 以 rc=1 退出，日志为 `NewFs: couldn't connect SSH: ssh: handshake failed: ssh: unable to authenticate`。默认重试下从 spawn 到退出约 23.2 s，超过 D9 的 20 s 窗口（D9 会先超时、杀掉子进程，结局同样是失败）。加 `--low-level-retries 1 --retries 1 --contimeout 5s` 时 4.7 s 退出。作为对照，端口拒绝连接时 11.2 s 以 rc=1 退出。
  - **smb：不成立**。挂载在 100 ms 内出现，rclone 一直存活。挂载根的 `stat` 0 ms 成功；`readdir` 11.1 s 得 `EIO`；读文件与新建约 20 s 得 `EIO`；日志为 `couldn't connect SMB: … The attempted logon is invalid`。
  - 按 Epic #1679 (n) 预定的退路（就绪判据加一次子进程里对挂载根的 `readdir`），smb 的错误口令在约 11 s 时以 `EIO` 判出，在 20 s 窗口之内；代价是每次 smb 建出都至少多一次往返。这是单次测量：同一轮里随后的读与新建都约 20 s 才返回，rclone 日志里也是约每 20 s 重试一次，所以 `readdir` 落在 11 s 还是 20 s 附近并不稳定；子进程 `readdir` 的期限至少要给到 20 s。issue 正文要求「任一项不成立需 owner 重新拍板」，这一项没有升级，依据是 Epic (n) 的预授权。
- **P12 私钥单行形式**：
  - `ssh-keygen -t rsa -m PEM -b 2048`（`-----BEGIN RSA PRIVATE KEY-----`）与 `ssh-keygen -t ed25519`（`-----BEGIN OPENSSH PRIVATE KEY-----`）生成的私钥，换行转写为字面 `\n`、写成一行 `key_pem = …`，配完整 argv 都能挂载、能 `readdir`，日志无错。
- **P13 local 后端与符号链接**（不带 `--links` / `-L`）：
  - 源目录里有三个符号链接：指向源外目录的 `escape-dir`、指向源外文件的 `escape-file.txt`、指向源内文件的 `inner-link.txt`。三者都不出现在挂载的 `readdir` 里；按名字 `stat`、`lstat`、读、经它进入子路径，全部 `ENOENT`。日志对每个写一行 NOTICE：`Can't follow symlink without -L/--copy-links`。
  - omp uid 在挂载内 `symlink()` 得 `EIO`，源目录里没有出现新条目。
  - 「挂载内没有符号链接」成立；代价是源内的合法符号链接也看不到。
- **P14 日志文件模式**：
  - 由 app uid 以 umask `077` 预建 `0600` 的 `rclone.log` 之后，rclone 往里追加之后（P13 那次挂载写了三行 NOTICE、264 字节），模式仍为 `0600`。
  - 文件不存在时，rclone 在进程 umask `007` 下自建为 `0640`、属 app uid、组 `workbuddy`。因为父目录 `0700`，omp uid 进不去，但 D5「每次尝试前确保 `0600`」仍有必要。
- **P15 挂载点是符号链接**：
  - **静态情形**：挂载点最后一段是 omp uid 建的符号链接，指向空间根下 omp 的目录，或指向 app 私有的 `<state>/mounts/<id>`。rclone 都以 rc=1 退出，日志为 `fusermount: mountpoint <mnt> is not a directory or a regular file`，没有挂上。成立。
  - **竞态**：omp uid 用 `renameat2(RENAME_EXCHANGE)` 不停交换 `<空间根>/race`（目录）与 `<空间根>/race.alt`（指向 `<空间根>/elsewhere` 的符号链接）。app uid 对 `<空间根>/race` 依次挂载 200 次，每次按 mountinfo 判断落点之后卸载。结果：
    - 39 次落在 `race`；
    - **27 次落在 `race.alt`**：fusermount3 检查过的那个目录在挂载前被换了名，挂载点路径不再等于 argv；
    - **22 次落在符号链接的目标 `elsewhere`**：在 `lstat` 与 `chdir` 之间换入了符号链接，fusermount3 跟了进去；
    - 112 次被拒（`not a directory or a regular file`）。
  - 一旦挂上，omp uid 对挂载点的交换一律得 `EBUSY`（这一轮共 62 万次），挂载点不能再被移走。
  - **复测**：用同样的交换再挂 100 次，这次每次读出落点行的来源字段，并照 D9 的写法卸载：凡来源以 `<段名>:` 或 `<段名>{` 开头的 `fuse.rclone` 行，对其挂载点执行 `-uz`。结果：24 次落在 `race`，17 次落在 `race.alt`，13 次落在 `elsewhere`，46 次被拒；挂上的 54 次来源字段全部以段名开头，卸载之后没有一次残留。两轮合计 300 次，有 35 次挂到链接目标上。符号链接目标可以是 app uid 有写权限的任何目录，两轮只测了空间根下 omp 的目录。
  - 测量方式的订正：最早一轮把 mountinfo 的 fstype 字段位置取错（按第 9 字段取；没有可选字段时它在第 8 字段），交换脚本也在第一次 `EBUSY` 时停下，那一轮的统计作废，上面的 200 次与 100 次两轮都是修正之后的结果。

**对 S1b 的影响**

落在 Epic #1679 (n) 预定退路之内、不另需拍板的（由 change `s1b-workspace-mounts` 照退路修订）：

- P1′：D9 与 workspace-mounts 的来源匹配改为以 `<段名>:` 或 `<段名>{` 开头。
- P11 smb：就绪判据在挂载出现之后，再加一次子进程里对挂载根的 `readdir`，期限至少 20 s（见 P11）。另有一项可选、不属于退路：sftp 默认重试约 23 s，超过 20 s 窗口，由 D9 的超时兜底，结局同为失败。若要更快失败，需要改 D7 的 argv；实测过的组合是 `--low-level-retries 1 --retries 1 --contimeout 5s`（4.7 s），去掉 `--contimeout` 的组合没测。

**需 owner 重新拍板**（第 1、2、3、5、6 项影响的组 5A、5B、6A、6B、12，按 Epic 规则等待裁定；第 4 项影响组 9，见该项）：

1. **P4′ 断网判定**：在目录缓存期内，对挂载根做 `stat` 或 `readdir` 都由缓存应答，D11 的探测与它的预定退路都判不出远端已断。需要另定探测手段（例如探测一条必然未命中缓存的路径，或缩短 `--dir-cache-time`），或者接受「断网要等缓存过期或请求超时才判离线」。影响 D11 与组 6A、12。
2. **P5 / D12 续传依赖 IP 不变**：卸载丢掉回写窗口里的写入，是已接受的残余（Epic (m)），这里不重议。新的事实是：sftp / smb 在 argv 覆盖 host 时，缓存路径带着由 IP 决定的后缀，而 D3 每次尝试都重新解析 IP。IP 一变，关停或崩溃时待上传的数据重挂之后不再续传，直到卸载时被删掉——design Risks「重挂时 rclone 续传」对它们只在 IP 不变时成立。需要裁定：接受并写进 Risks，还是改成每次尝试把解析出的 IP 写进 `rclone.conf` 的 `host`、不再经 argv 覆盖。后一种同时会消掉 P1′ 的来源后缀；它对 rclone 的行为没有测过。影响 D3、D6、D7 与组 5A、5B、6A。
3. **P8 已删文件复活**：`--vfs-cache-mode writes` 下，在回写窗口内改名目录、再删除其中的新文件，文件会在远端复活。`--vfs-write-back 0s` 只验证过一次。需要裁定：接受为已知限制，改 argv（`--vfs-write-back 0s` 需更多实测），还是换 rclone 版本。影响 D7 与组 5B、12。
4. **P7 挂载内读不固定内容**：同一 fd 跨远端改写会混入新旧字节或提前 EOF，`fstat` 的大小可能过期。`file` / `download` 若照搬 ADR-0010 的描述符读法，会发出与 `Content-Length` 不符的响应。需要裁定：短读按错误结束响应，还是接受混合内容为已知限制。影响 D16 与组 9。组 9 不在 #1665 的开工闸门里（Epic 把 #1695 列为不受阻），建议在 9A / 9B（#1695、#1696）合入之前裁定这一项。
5. **P15 挂载点竞态**：检查与 `fusermount3` 之间的窗口实测可利用。两轮 300 次里，35 次挂到 omp 换入的符号链接目标上，44 次挂到被换名的目录上。复测证实，这些落点都能由 D9 按来源扫描找到并卸载。design Risks 已把这个窗口登记为残余，但当时不知道它有多大。需要裁定：按这个频率接受（依靠按来源扫描收回），还是要求在 app 私有的位置先挂好、再移入（需另行实测）。影响 D8 与组 5B。
6. **P1 smb 根目录的 `．` 目录**：往共享根写文件时，用户的远端共享里会多出一个全角句点目录。需要裁定：接受并写进说明，还是另找规避办法（未测）。影响组 12 的签收。

**对 S1b grill 裁定的影响**：「rclone 统一三后端」「`--vfs-cache-mode writes`」「凭证经 0600 conf、`obscure`、不上命令行」「惰性卸载」「挂载点判据沿用 #1237」五条的前提都实测成立（P1、P2、P2′、P5、P6）。上面第 3 条是 `writes` 模式的回写语义带来的代价，第 1、4 条是 VFS 缓存带来的代价，第 2 条来自 host 覆盖与缓存路径的耦合。它们都不推翻「只用 rclone」，但接受方式要 owner 决定。
