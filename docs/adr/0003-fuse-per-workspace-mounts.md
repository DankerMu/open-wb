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
