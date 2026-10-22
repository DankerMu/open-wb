# file-operations Spec Delta

> s1b-workspace-mounts：以主规格为底。「删除到回收目录」与「重命名与移动」的检查次序在沙箱判定之后、存在性检查之前插入挂载判定（挂载内删除与跨挂载移动 409 `mount_boundary`，同一挂载内移动遇离线 409 `mount_offline`、遇只读 403 `mount_read_only`），各加一个场景（design D16）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 删除到回收目录
`DELETE /api/workspaces/:id/entries?path=<rel>` SHALL 把工作空间内的一个普通文件或目录移到服务端回收目录并返回 204（空体、`no-store`）；请求体被忽略（不属于归属 content-parser 集）。检查次序：属他人或不存在的 `:id`、或空间根不存在 → 404（先于路径检查，无审计）；`path` 缺失或重复 → 400；`sandbox.resolve(principal, id, path, "delete")`——越界、符号链接、空串（空间根本身）与不合法的末段 → 403 `sandbox_denied` + `sandbox.reject` 审计；目标在该空间的已登记挂载内（`path` 去掉空段与 `.` 段之后的第一段等于某个挂载名，含挂载根本身；判定见 workspace-mounts「挂载目录内的文件端点」，只读挂载登记、不访问文件系统）→ 409 `mount_boundary`，不建批次目录、不改名、不写审计（change s1b-workspace-mounts）；目标不存在 → 404；目标既不是普通文件也不是目录 → 404。

通过检查后 SHALL：建立批次目录 `<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<batch>`，其中 `<batch>` 为 `<当前毫秒时间戳的十进制>-<16 位小写十六进制随机数>`，`.trash`、`<ownerId>`、`<workspaceId>` 与批次目录四级 SHALL 逐级以 `ensureOwnedDir(path, 0o700)` 的语义建立并在每次删除时重新校验（core/sandbox「托管目录权限位」：非递归创建、必须是目录而不是符号链接、属本进程的 effective uid、mode 精确为 `0700`）——`SANDBOX_ROOT` 对 omp uid 组可写，它可以抢先放一个名为 `.trash` 的符号链接或自己的目录，任何一级校验不通过 SHALL 为 generic 500：目标留在原处、不改名、不写 `file.delete` 审计；以一次 `rename` 把目标改名为 `<批次目录>/<目标的末段名>`（目录连同全部内容一起，不逐个复制）；随后 `emit` 审计 `{kind:"file.delete", actorId, workspaceId, title:"删除 <path>", detail:{path, type:"file"|"dir", trashId:"<batch>"}}`，审计写入成功之后才返回 204。`rename` 失败（含跨文件系统的 `EXDEV`、权限不足；挂载内的目标已在上一步被 409 拒绝，不会走到这里）SHALL 为 generic 500：目标留在原处、刚建的空批次目录被删除、不写 `file.delete` 审计。`rename` 成功而审计写入失败 SHALL 为 500，条目已在回收目录里（不回滚，与 workspaces「新建目录」的既有取舍一致）。回收目录 SHALL NOT 出现在任何工作空间的 `tree` 结果里，也没有任何端点能列出、读取或恢复其中的内容。

#### Scenario: 删除文件与目录
- **WHEN** zhangsan 对自己的工作空间 `DELETE …/entries?path=notes.md`，再 `DELETE …/entries?path=out`（`out` 是含 `a.md` 与子目录的目录）
- **THEN** 两次都是 204；工作空间里不再有 `notes.md` 与 `out`；`<SANDBOX_ROOT>/.trash/u1/<该空间 id>/` 下新增两个批次目录，名字匹配 `/^\d+-[0-9a-f]{16}$/`，分别含 `notes.md`（内容不变）与完整的 `out` 目录树；`.trash` 各级目录 mode 为 `0700`；审计新增两行 `file.delete`，`detail` 分别为 `{path:"notes.md",type:"file",trashId:<批次名>}` 与 `{path:"out",type:"dir",trashId:<批次名>}`

#### Scenario: 同名先后删除互不覆盖
- **WHEN** 删除 `a.txt`，重新创建同名文件后再删除一次
- **THEN** 两次都是 204，回收目录里有两个不同的批次，各含一个 `a.txt`，内容分别是两次删除时的内容

#### Scenario: 拒绝项
- **WHEN** 分别请求 `path=`（空串）、`path=../x`、`path=a/..`、`path=link`（符号链接）、`path=missing.md`、缺少 `path`、重复 `path`，以及 lisi 对 zhangsan 的工作空间请求 `path=notes.md`、未登录的请求
- **THEN** 依次为 403、403、403、403（四者各写一条 `sandbox.reject`，`detail.op` 为 `delete`）、404、400、400、404（无审计）、401；所有情况下工作空间内容不变，`.trash` 下没有新增批次

#### Scenario: 改名失败不丢文件
- **WHEN** 把 `rename` 替换为抛出 `EXDEV` 的实现后删除 `notes.md`
- **THEN** 响应为 500（不含内部错误细节）、`no-store`；`notes.md` 仍在原处且内容不变；`.trash` 下没有残留的空批次目录；没有 `file.delete` 审计行

#### Scenario: 回收目录被预先占位
- **WHEN** `<SANDBOX_ROOT>/.trash` 预先是一个指向别处目录的符号链接；另一例它是普通文件；另一例 `.trash/u1` 是 mode `0777` 的目录（进程为 root 时归属一例跳过）
- **THEN** 前两例删除 `notes.md` 都返回 500，`notes.md` 仍在原处，符号链接指向的目录里没有新增条目，没有 `file.delete` 审计行；第三例该目录被校正为 `0700` 后删除成功

#### Scenario: 回收目录不可见
- **WHEN** 删除若干条目后请求该空间与其它空间的 `tree`（根与各级），并以 `path=.trash`、`path=../.trash` 请求 `tree` 与 `file`
- **THEN** 没有任何 `tree` 结果含 `.trash` 或其中的条目；后两类请求为 404 或 403，读不到回收目录里的内容

#### Scenario: 挂载内不能删除
- **WHEN** 空间有在线可写挂载 `远端`（其中有 `a.md`）与离线挂载 `备份`；依次 `DELETE …/entries?path=远端/a.md`、`DELETE …/entries?path=远端`、`DELETE …/entries?path=./远端/a.md`、`DELETE …/entries?path=备份/x.md`；另有根下的普通目录 `远端旧`（名字以挂载名开头）上 `DELETE …/entries?path=远端旧`
- **THEN** 前四个都是 409 `mount_boundary`（离线不改变结果），`远端/a.md` 仍在、`.trash` 下没有新批次、没有 `file.delete` 审计；最后一个 204 并按既有规则进入回收目录

### Requirement: 重命名与移动
`POST /api/workspaces/:id/move` SHALL 只接受 `application/json` body `{from:string, to:string}`（恰这两个键，≤16 KiB，归属 content-parser 集），把同一工作空间内的一个普通文件或目录从 `from` 改到 `to`，成功返回 200 `{path:<to>}`、`no-store`。重命名即父目录不变的移动。检查次序：属他人或不存在的 `:id` → 404；body 形状不符 → 400 `bad_request`；`sandbox.resolve(…, from, "move")` 与 `sandbox.resolve(…, to, "move")`（先 `from` 后 `to`，任一被拒 → 403 `sandbox_denied` + 审计，另一个不再检查）；`to` 解析后的绝对路径位于 `from` 解析后的绝对路径之内（即以 `<from 的绝对路径>/` 为前缀——把条目移进它自己的子树；这是对两个已解析路径的纯词法比较，不访问文件系统，因此排在一切存在性检查之前）→ 400 `bad_request`；挂载判定（workspace-mounts「挂载目录内的文件端点」，按去掉空段与 `.` 段之后的第一段，只读挂载登记与内存状态、不访问文件系统）：`from` 与 `to` 恰一方在已登记挂载内、两方在不同挂载内、或 `from` 恰为挂载根 → 409 `mount_boundary`，两方在同一挂载内而该挂载离线 → 409 `mount_offline`、只读 → 403 `mount_read_only`，均不改名、不写审计（change s1b-workspace-mounts）；`from` 不存在、或既不是普通文件也不是目录 → 404；`to` 的直接父目录不存在或不是普通目录 → 404（不自动创建）；`to` 已存在（任何类型的条目，含 `to` 与 `from` 是同一路径）→ 409 `conflict`，不覆盖、不合并。

通过检查后 SHALL 以一次 `rename` 完成，随后 `emit` 审计 `{kind:"file.move", actorId, workspaceId, title, detail:{from, to, type:"file"|"dir"}}`，`title` 在父目录不变时为 `重命名 <from> → <to 的末段名>`，否则为 `移动 <from> → <to>`；审计写入成功之后才返回 200。`rename` 失败 SHALL 为 generic 500 且源留在原处、不写 `file.move` 审计。同一挂载内的改名与移动与普通目录相同，是一次 `rename`（在线挂载内经 workspace-mounts「宿主不同步进入挂载」的异步适配器）。路由只有一个 `:id`：`from` 与 `to` 都在这一个工作空间的根内解析，跨工作空间的移动在接口上不可表达。本路由不加锁：检查与 `rename` 之间由别的进程造成的变化以文件系统的结果为准。

#### Scenario: 重命名与移动
- **WHEN** 工作空间里有 `a.md`、目录 `docs`（含 `x.md`）与空目录 `out`；依次 `POST move {from:"a.md",to:"b.md"}`、`{from:"b.md",to:"out/b.md"}`、`{from:"docs",to:"out/docs"}`
- **THEN** 三次都是 200，body 依次为 `{path:"b.md"}`、`{path:"out/b.md"}`、`{path:"out/docs"}`；磁盘上最终为 `out/b.md`（内容不变）与 `out/docs/x.md`；审计新增三行 `file.move`，`title` 依次为 `重命名 a.md → b.md`、`移动 b.md → out/b.md`、`移动 docs → out/docs`，`detail.type` 依次为 `file`、`file`、`dir`

#### Scenario: 同名拒绝
- **WHEN** 存在 `a.md` 与 `b.md`、目录 `d1` 与 `d2`；请求 `{from:"a.md",to:"b.md"}`、`{from:"d1",to:"d2"}`、`{from:"a.md",to:"d2"}`、`{from:"a.md",to:"a.md"}`
- **THEN** 四次都是 409 `conflict`；全部条目的位置与内容不变；没有 `file.move` 审计行

#### Scenario: 其它拒绝
- **WHEN** 分别请求 `{from:"missing",to:"x"}`、`{from:"a.md",to:"nodir/a.md"}`、`{from:"d1",to:"d1/sub/d1"}`（`d1/sub` 不存在）、`{from:"",to:"x"}`、`{from:"a.md",to:""}`、`{from:"a.md",to:"../a.md"}`、`{from:"a.md",to:"x/"}`、`{from:"a.md"}`、`{from:"a.md",to:"b",extra:1}`、`{from:1,to:"b"}`；lisi 对 zhangsan 的工作空间请求一个合法的移动
- **THEN** 依次为 404、404、400、403、403、403、403（四者各一条 `sandbox.reject`，`detail.op` 为 `move`）、400、400、400、404（无审计）；磁盘内容不变

#### Scenario: 子树判断先于存在性
- **WHEN** 工作空间里有目录 `d1`（含已存在的子目录 `d1/sub`）；分别请求 `{from:"d1",to:"d1/sub/d1"}`（父目录存在）、`{from:"d1",to:"d1/nodir/x"}`（父目录不存在）、`{from:"missing",to:"missing/x"}`（源不存在）与 `{from:"d1",to:"d10"}`（只是名字以 `d1` 开头，不在子树内）
- **THEN** 前三个都是 400 `bad_request`（不是 404），第四个是 200 且 `d1` 改名为 `d10`；前三个没有审计行，磁盘内容不变

#### Scenario: 不能经符号链接移出
- **WHEN** 工作空间里有指向空间外目录的符号链接 `link`，请求 `{from:"a.md",to:"link/a.md"}` 与 `{from:"link",to:"renamed"}`
- **THEN** 两次都是 403 `sandbox_denied` 并写审计；`a.md` 仍在原处，空间外的目录没有新增文件，`link` 未被改名

#### Scenario: 改名失败
- **WHEN** 把 `rename` 替换为抛出 `EACCES` 的实现后请求一个合法的移动
- **THEN** 响应为 500、`no-store`；源仍在原处；没有 `file.move` 审计行

#### Scenario: 跨挂载边界
- **WHEN** 空间有在线可写挂载 `远端`（含 `a.md` 与目录 `d`）、在线可写挂载 `共享`、在线只读挂载 `参考`（含 `r.md`）、离线挂载 `备份`（登记中、挂载点为空目录）与根下文件 `local.md`；依次请求 `{from:"local.md",to:"远端/local.md"}`、`{from:"远端/a.md",to:"a.md"}`、`{from:"远端/a.md",to:"共享/a.md"}`、`{from:"远端",to:"远端2"}`、`{from:"./远端/a.md",to:"共享//a.md"}`、`{from:"参考/r.md",to:"参考/s.md"}`、`{from:"备份/x",to:"备份/y"}`、`{from:"远端/a.md",to:"远端/d/a.md"}`
- **THEN** 依次为 409 `mount_boundary`、409 `mount_boundary`、409 `mount_boundary`、409 `mount_boundary`、409 `mount_boundary`、403 `mount_read_only`、409 `mount_offline`、200；前七个没有文件被移动、没有 `file.move` 审计；最后一个 `远端/d/a.md` 存在且审计一行 `file.move`（`title` `移动 远端/a.md → 远端/d/a.md`）
