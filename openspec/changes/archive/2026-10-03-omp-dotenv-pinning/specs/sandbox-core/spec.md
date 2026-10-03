## ADDED Requirements

### Requirement: 托管文件权限位
`core/sandbox/dirs.ts` SHALL 导出同步的 `ensureOwnedFile(absPath, mode)`：以 `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` 与 `mode` 创建空文件（`EEXIST` 不是错误，父目录缺失是错误），随后 `lstat` 它并要求它是普通文件（符号链接与其它类型一律拒绝）且 `uid` 等于本进程 effective uid；`mode & 0o7777` 不等于 `mode` 时 `chmod` 到该值并复查。它 SHALL NOT 读取、截断或改写既有内容，SHALL NOT chown、不改进程 umask、不跟随符号链接。失败时抛出的 `Error` message 含路径与期望的八进制 mode。

#### Scenario: 新建、校正、不动内容
- **WHEN** 对不存在的 `<tmp>/f` 以 `0o640` 调用；再写入内容并 `chmod 0o666` 后以同参数调用
- **THEN** 第一次之后它是 `0640` 的空文件；第二次之后内容字节不变、mode 为 `0640`；umask `000` 下新建的文件 mode 不宽于 `0640`

#### Scenario: 拒绝符号链接、目录与他人持有的文件
- **WHEN** `absPath` 是指向普通文件的符号链接、是目录、或是 root 持有的既有文件（如 `/etc/hosts`，以其当前 mode 调用；进程为 root 时跳过）
- **THEN** 抛错，message 含该路径；链接目标与既有文件的内容和 mode 不变
