## ADDED Requirements

### Requirement: 迁移 039 回合快照登记表
迁移 `039_chat_turn_snapshots.sql` SHALL 在既有 runner 事务内、作为 `038` 之后的第十三个 receipt，创建表 `chat_turn_snapshots`：`message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE`；`workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`；`outcome TEXT NOT NULL CHECK (outcome IN ('ok','too_large','failed','command'))`；`skipped TEXT NULL`；`todo TEXT NULL`；`created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at >= 0)`；并在 `workspace_id` 上建索引（索引名不属于外部契约）。不使用 `IF NOT EXISTS`，不改动任何既有表。`031`–`038` 的迁移文件 SHALL NOT 被编辑。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 建表与约束
- **WHEN** openDb 打开新库与一个 receipts 止于 `038` 的存量库，然后写入 `outcome` 为四个合法值之一与 `'done'`、对不存在的 `message_id` 或 `workspace_id` 写入、对同一 `message_id` 写两行
- **THEN** receipts 含 `039`；合法行写入成功；非法 `outcome`、缺失的外键目标与重复主键被 SQLite 拒绝；存量表的行与 `sqlite_sequence` 不变

#### Scenario: 级联
- **WHEN** 删除一条有快照行的消息、删除其会话、或删除其工作空间行
- **THEN** 对应的快照行随之消失，其它会话与其它工作空间的快照行不变

### Requirement: 快照的存放位置
快照 SHALL 存放在 `<OMP_STATE_DIR>/snapshots/<workspaceId>/<userMessageId>/` 之下：`manifest.json` 与目录 `tree/`（工作空间内容的副本）。`<OMP_STATE_DIR>/snapshots` 属于托管布局，mode `0700`、由 app 用户持有（omp-runtime「OMP_STATE_DIR 托管布局」），其下的每级目录以 `0700`、每个文件以 `0600` 创建；omp 用户不能进入、列举、读取或改写其中任何内容。快照模块 SHALL 从 `createApp` 注入的快照根取路径，不自行拼接 `OMP_STATE_DIR`；路径分量只取自受信任的行（32 位小写十六进制的工作空间 id、十进制的消息 id），SHALL NOT 取自任何请求字符串。快照 SHALL NOT 写入工作空间内或 `SANDBOX_ROOT` 之下的任何位置。

#### Scenario: 位置与权限位
- **WHEN** 对工作空间 W 的用户消息 `42` 成功做一次快照
- **THEN** `<OMP_STATE_DIR>/snapshots/<W>/42/manifest.json` 与 `tree/` 存在；`snapshots`、`<W>`、`42`、`tree` 及其下目录的 `mode & 0o777` 为 `0o700`，文件为 `0o600`；工作空间根下没有新增任何条目

#### Scenario: omp 用户不可达
- **WHEN** 在 `uid-isolation` CI job（omp 以独立系统用户运行）里完成一轮带快照的回合后，以 omp 用户尝试列举 `<OMP_STATE_DIR>/snapshots`
- **THEN** 得到 `EACCES`

### Requirement: 快照内容规则
`take(workspaceRoot, …)` SHALL 自工作空间根向下遍历，用不跟随符号链接的元数据判定每个条目，并写出清单 `manifest.json`：`{entries:[…], skipped:[{path,reason}]}`，`path` 为相对工作空间根的 POSIX 路径。规则：
- 目录：记 `{path,type:"dir",mode}`，在 `tree/` 下建同名目录，继续向下；
- 普通文件：记 `{path,type:"file",size,mtimeMs,ctimeMs,ino,mode}`（`ino` 是该文件在工作空间里的 inode 号，只用来判定「是不是同一个文件」），内容放在 `tree/<path>`；
- 符号链接：记 `{path,type:"symlink",target}`（`target` 为 `readlink` 的原字符串），SHALL NOT 跟随、SHALL NOT 复制目标内容；
- FIFO、socket、设备等其它类型：不进 `entries`，记入 `skipped`，`reason` 为 `special`；
- 名字在排除名单里的**目录**（任何层级，见「快照上限与配置」）：整棵不遍历，记入 `skipped`，`reason` 为 `excluded`；同名的普通文件不受影响；
- 大小超过单文件上限的普通文件：不进 `entries`，记入 `skipped`，`reason` 为 `too_large`；
- 读取元数据、列举或复制时得到 `EACCES` / `EPERM` 的条目：记入 `skipped`，`reason` 为 `unreadable`（目录则整棵）。
- 遍历期间工作空间有变动（#1190，2026-10-08 owner 裁决，取代 #1148 对「消失条目」的处置）：`take` SHALL 在列举每个被遍历的目录（含工作空间根）时记下它的指纹——不跟随符号链接取得的 `dev`、`ino`、`mtime`、`ctime`（纳秒精度）与按字节的条目名集合；全部条目处理完之后、写清单之前，对每个被遍历的目录再取一次指纹并与记下的比较。任一目录的两次指纹不同（条目多了、少了、改了名，目录被换成了另一个，或 `mtime` / `ctime` 变了），或第二次取不到，或遍历中对一个已被列举出的条目读取元数据、读链接目标、打开或列举其子项时得到 `ENOENT` / `ENOTDIR`，这份快照 SHALL 是 `failed`：不写清单，快照目录按 `failed` 的既有规则清掉，不可还原。理由：这些情形分不清条目是被删还是被挪到了别处（跨目录移动时两个目录各自的列举都不含它，没有任何读取出错），还原这样的快照会删掉或覆盖一份快照里没有副本的内容；两次指纹都相同则说明遍历结束那一刻每个目录都与它被列举时一样，清单是那一刻的名字空间（`ctime` 不能由 `utimes` 拨回，所以改动之后把 `mtime` 拨回原值遮不住它）。清单 SHALL NOT 带 `incomplete` 键。被排除的名字与记入 `skipped` 的目录不下行，也不取指纹；
- 复制期间文件内容有变动（#1206，与上一条同一裁定）：对经句柄复制内容的普通文件，`take` SHALL 在复制完成后经同一句柄再取一次元数据；`size`、`mtime`、`ctime` 任一与复制之前取得的不同，或实际复制的字节数不等于复制之前的 `size`，这份快照 SHALL 是 `failed`（副本可能是撕裂的：一部分旧内容、一部分新内容）。经硬链接复用上一份副本的文件不读内容，不做这项复核。复制完成之后才发生的改写不影响结果；
- 名字不是合法 UTF-8 的条目（#1148）：列举 SHALL 按字节取名；名字的字节经 UTF-8 解码再编码得不回原字节的条目不进 `entries`、不读取（目录则整棵不遍历），记入 `skipped`，`reason` 为 `name_encoding`，`path` 为父路径加该名字的有损解码（非法字节以 U+FFFD 代替）。这个 `path` 只供展示，不保证能定位回该条目（同目录下两个这样的名字可以解码成同一个串，各记一项，不去重）；还原对这类条目的保护不依赖它，它也不参与「`skipped` 路径之下」的判定（见「还原」）。

遍历 SHALL NOT 离开工作空间根（符号链接不跟随即保证）。`take` 结束时返回三种结果之一：`ok`（附 `skipped`）、`too_large`（见上限）、`failed`（遍历期间有变动，或上述规则之外的任何错误，含工作空间根不是目录）。结果不是 `ok` 时 SHALL 删除本次已写出的 `<userMessageId>` 目录，不留半份快照。`take` SHALL NOT 修改工作空间内的任何文件、时间戳或权限位。

#### Scenario: 遍历期间有变动的快照不可还原
- **WHEN** 工作空间含 `a.txt`、`gone.txt` 与目录 `d/`（内有 `d/x.txt`），测试让 `gone.txt` 在根目录被列举之后、被读取元数据之前被删除；另一次让 `d/` 在被判为目录之后、被列举之前被整棵删除
- **THEN** 两次的结果都是 `failed`；快照目录不存在（没有清单，没有 `tree/` 残留）
- **WHEN** 工作空间含 `src/foo.ts` 与空目录 `lib/`，测试让 `src/foo.ts` 在 `lib/` 被列举之后、`src/` 被列举之前移到 `lib/foo.ts`（跨目录移动：遍历中没有任何读取出错）
- **THEN** 结果是 `failed`；快照目录不存在；工作空间里 `lib/foo.ts` 还在、字节未变
- **WHEN** 工作空间含 `report.md` 与 `report.md.tmp`，测试让 `report.md` 被捕获之后、`report.md.tmp` 被读取之前执行 `report.md.tmp` → `report.md` 的改名覆盖
- **THEN** 结果是 `failed`；快照目录不存在；工作空间里 `report.md` 是改名之后的内容
- **WHEN** 工作空间含目录 `data/`（内有文件）与文件 `report`，测试让 `data/` 被捕获之后、`report` 被读取之前执行 `data` → `data.bak`、`report` → `data` 两步改名（清单路径上的类型互换）
- **THEN** 结果是 `failed`；快照目录不存在；工作空间里 `data` 是文件、`data.bak/` 整棵还在
- **WHEN** 遍历期间工作空间根里新增了一个文件；另一次在一个已被遍历的子目录里新增一个文件（名字集合变了）
- **THEN** 两次的结果都是 `failed`
- **WHEN** 遍历期间一个已被遍历的目录里，一个条目被删除后以同名重建为另一种类型（名字集合不变，该目录的时间变了）；另一次是一个条目被改名之后该目录的 `mtime` 被 `utimes` 拨回原值（只有 `ctime` 变了）。测试在 `take` 之前把每个目录的 `mtime` 设为过去的时刻，并在注入改动之前等到文件系统的时钟前进，使结果不取决于时钟粒度
- **THEN** 两次的结果都是 `failed`
- **WHEN** 遍历期间工作空间没有任何变动
- **THEN** 结果是 `ok`；清单恰有 `entries` 与 `skipped` 两个键

#### Scenario: 复制期间被改写的文件使快照不可还原
- **WHEN** 工作空间含 `a.txt` 与 `big.log`，测试让 `big.log` 在被打开并取得元数据之后、复制完成之前被追加内容；另一次是被截断；另一次是被等长的另一份内容覆盖写（长度不变。测试在 `take` 之前把该文件的 `mtime` 设为过去的时刻，并在注入改写之前等到文件系统时钟前进）
- **THEN** 三次的结果都是 `failed`；快照目录不存在；工作空间里 `big.log` 是改写之后的内容、未被 `take` 触碰
- **WHEN** 复制期间没有改写，复制完成之后 `big.log` 才被改写
- **THEN** 结果是 `ok`；`tree/big.log` 是改写之前的内容，清单的 `size` 等于它的长度
- **WHEN** `big.log` 自上一份快照以来未变（经硬链接复用）
- **THEN** 结果是 `ok`；该文件没有被读取
- **WHEN** 工作空间根在 `take` 开始前就不存在
- **THEN** 结果为 `failed`

#### Scenario: 非 UTF-8 文件名被跳过而不使快照失败
- **WHEN** 在 Linux 上工作空间含 `a.txt`、一个名字字节为 `0xD6 0xD0 0xCE 0xC4 0x2E 0x74 0x78 0x74` 的文件，以及一个名字含非法 UTF-8 字节的目录（内有文件），对它做快照
- **THEN** 结果为 `ok`；`entries` 含 `a.txt`，不含这两个条目及该目录之下的任何路径；`skipped` 恰含这两项，`reason` 均为 `name_encoding`，`path` 为含 U+FFFD 的有损解码；`tree/` 下没有它们的内容；清单是合法的 UTF-8 JSON

#### Scenario: 各类条目
- **WHEN** 工作空间含 `a.txt`、`src/b.ts`、空目录 `empty/`、指向 `a.txt` 的符号链接 `link`、指向工作空间外文件的符号链接 `out`、一个 FIFO、目录 `node_modules/`（内有文件）与一个名为 `node_modules` 的普通文件位于 `docs/` 下，对它做快照
- **THEN** 结果为 `ok`；`tree/` 含 `a.txt`、`src/b.ts`、`empty/` 与 `docs/node_modules`，字节与原文件相同；`link` 与 `out` 只在清单里以 `symlink` 与原 `target` 出现，`tree/` 下没有它们的目标内容；`skipped` 恰含 FIFO（`special`）与 `node_modules`（`excluded`）；工作空间各文件的 `mtime` 与内容未变

#### Scenario: 读不了的子目录
- **WHEN** 工作空间含一个 app 用户无权列举的子目录 `locked/`
- **THEN** 结果为 `ok`；`skipped` 含 `{path:"locked",reason:"unreadable"}`；其余条目照常进快照

#### Scenario: 失败不留半份
- **WHEN** 复制中途注入一个非权限类 IO 错误，或工作空间根被换成普通文件
- **THEN** 结果为 `failed`；`<OMP_STATE_DIR>/snapshots/<W>/<messageId>` 不存在

### Requirement: 快照上限与配置
服务配置 SHALL 接受四个可选环境变量，经既有配置解析入口校验（非法值使启动失败，与其它数值配置同一规则）：
- `SNAPSHOT_MAX_FILE_BYTES`：正整数，默认 `20971520`；大于它的单个文件不进快照（`skipped` `too_large`）；
- `SNAPSHOT_MAX_TOTAL_BYTES`：正整数，默认 `524288000`；进入 `entries` 的普通文件 `size` 之和超过它时，本次快照结果为 `too_large`；
- `SNAPSHOT_MAX_ENTRIES`：正整数，默认 `50000`；`entries` 的条目数超过它时，本次快照结果为 `too_large`；
- `SNAPSHOT_EXCLUDE_NAMES`：逗号分隔的目录名列表，默认 `node_modules,.venv,__pycache__`（只排除依赖目录，管理员可配）；每个名字非空、不含 `/` 与 NUL、不是 `.` 或 `..`；空字符串表示不排除任何目录。

`.git` 不在默认排除名单里：版本库目录与其它目录一样进快照（其下每个文件同样受单文件上限约束，条目与字节计入条目上限与总量上限），撤回时连同回合里产生的提交、引用与暂存区一起还原。

`take` SHALL 在累计值越过总量或条目上限的那一刻停止遍历并返回 `too_large`，不继续复制。恰等于上限的值不算超限。

#### Scenario: 单文件上限
- **WHEN** 单文件上限配为 `10`，工作空间有 10 字节的 `ok.bin` 与 11 字节的 `big.bin`
- **THEN** 结果为 `ok`；`tree/` 含 `ok.bin`、不含 `big.bin`；`skipped` 含 `{path:"big.bin",reason:"too_large"}`

#### Scenario: 总量与条目上限
- **WHEN** 总量上限配为 `20` 而三个 10 字节的文件待快照；另一次条目上限配为 `2` 而工作空间有三个文件
- **THEN** 两次结果都是 `too_large`；快照目录不存在；总量恰为 20 字节的两文件空间结果为 `ok`

#### Scenario: 版本库目录进快照
- **WHEN** 以默认配置对一个含 `.git/HEAD`、`.git/refs/heads/main`、`.git/objects/ab/cdef` 与 `node_modules/x.js` 的工作空间做快照
- **THEN** 结果为 `ok`；`tree/.git/` 下三者字节与原文件相同并出现在 `entries` 里；`skipped` 恰含 `node_modules`（`excluded`），不含 `.git`

#### Scenario: 配置非法
- **WHEN** `SNAPSHOT_MAX_FILE_BYTES` 为 `0`、`abc`、`1.5`，或 `SNAPSHOT_EXCLUDE_NAMES` 含 `a/b` 或 `..`
- **THEN** 配置解析失败，服务不启动

### Requirement: 未变文件的去重
`take` SHALL 接受「上一份快照」——同一工作空间最近一条 `outcome='ok'` 的快照行所对应的目录（不限会话；以该行的消息 id 传入，目录位置由 `take` 按「快照的存放位置」拼出，不接受任意路径）；没有则为空。对每个进入 `entries` 的普通文件，若上一份清单里有相同 `path` 的 `file` 条目且 `ino`、`size`、`mtimeMs`、`ctimeMs` 四者都与当前元数据（打开该文件后对句柄取得的）相等，SHALL 从上一份快照的 `tree/<path>` 建硬链接到本次的 `tree/<path>`，不读文件内容；否则 SHALL 经同一个已打开的句柄复制当前文件内容（与没有上一份时相同；不按路径复制，不使用写时复制）。上一份的目录或清单不存在、读不了或不可解析时 SHALL 按没有上一份处理；建硬链接失败（上一份正被删除、链接数上限等）SHALL 退为复制；两者都不使本次快照失败。被链接的文件与被复制的文件一样计入条目上限与总量上限，单文件上限的判定先于比对。硬链接只在快照根内部的两份快照之间建立，SHALL NOT 在快照与工作空间之间建立任何硬链接。删除一份快照 SHALL NOT 影响其它快照的可读性（链接计数保证）。

#### Scenario: 未变文件不重复占用
- **WHEN** 对含 `a.txt`、`b.txt` 的工作空间先后做两次快照，其间只改写 `b.txt`
- **THEN** 两份快照里的 `a.txt` 是同一个 inode（`nlink` ≥ 2），`b.txt` 是不同的 inode 且各自内容对应当时的文件；两份 `tree/a.txt` 与工作空间里的 `a.txt` 不是同一个 inode

#### Scenario: 内容变了而 mtime 被改回
- **WHEN** 第一次快照后改写 `a.txt` 的内容（长度不变），再把它的 `mtime` 设回原值，做第二次快照
- **THEN** 第二份快照的 `a.txt` 是新内容（`ctimeMs` 不同，不走硬链接）

#### Scenario: 上一份消失时退为复制
- **WHEN** 第二次快照进行时上一份快照目录已被删除
- **THEN** 结果仍为 `ok`，`tree/` 内容完整

#### Scenario: 删除较早的一份
- **WHEN** 删除第一份快照目录后读取第二份的 `a.txt`
- **THEN** 内容完整可读

### Requirement: 受理时做快照
prompt 路由 SHALL 把「快照步骤」作为 `supervisor.prompt` 的派发前步骤传入（chat-sessions「Supervisor dispatch and generation binding」的 `beforeDispatch`）：`acceptPrompt` 成功后不经任何 await 即调用 `supervisor.prompt`，supervisor 在该回合进入「派发前」阶段之后、等待旧进程退出 / 进程池准入 / spawn 之前执行该步骤。步骤 SHALL 为被受理的用户消息决定其快照结果并写一行 `chat_turn_snapshots`（`message_id` 为该用户消息 id，`created_at` 为当前毫秒，`todo` 为此刻 `chat_sessions.todo` 的原文或 NULL）：
- 会话 `workspace_id` 为 NULL（存量的未绑定会话）：SHALL NOT 做快照、SHALL NOT 写行；
- 该消息被 `classifyPrompt` 判为白名单命令（`builtin` / `skill`）：不做快照，写 `outcome='command'`；
- 其余：对会话的工作空间根调用 `take`，写其结果 `ok` / `too_large` / `failed`；`ok` 时 `skipped` 列存 `{count:<总数>,paths:[…至多前 200 项 {path,reason}]}` 的 JSON，没有跳过项时存 NULL。

快照的任何结果（含 `failed`）SHALL NOT 使 prompt 失败：派发照常进行，`failed` 时经服务错误通道报告一次。快照行的写入失败同样只报告，按该消息没有快照行处理。派发失败使受理被补偿（`rollbackPrompt`）时，快照行随用户消息行级联删除，宿主 SHALL 在补偿之后删除该消息的快照目录。步骤自身 SHALL NOT 以拒绝结束（内部捕获全部错误）。快照进行期间会话已是 `running` 且该回合处于「派发前」阶段：其间到达的 stop SHALL 按 turn-control「停止生成 REST」的停止意图规则处理（stop 立即 202，不等快照；快照结束后派发照常进行，派发回执兑现后恰写一次 `abort`，回合以 `stopped` 收尾，prompt 仍 202）；其间到达的 DELETE 按既有规则先 stop 再等待回合释放，因此在快照结束、回合被停止之后完成，不等一个完整回合。快照步骤 SHALL NOT 放在 `supervisor.prompt` 调用之前的路由代码里（那里回合尚未进入「派发前」阶段，stop 会被丢弃）。regenerate SHALL NOT 做新的快照，也不改动任何快照行。fork SHALL NOT 拷贝快照行。

快照的受理延迟（`take` 的耗时）计入 prompt 的 202 之前；202 的 body 增加 `undo`（message-undo「可撤回状态」）。

#### Scenario: 每个回合前一份
- **WHEN** 绑定工作空间 W 的会话在 fake omp 下连续发两条 prompt，第一轮里 fake omp 的 `edit-write` 场景改写了一个文件
- **THEN** 两条用户消息各有一行 `outcome='ok'`；第一份快照的 `tree/` 是第一轮开始前的内容，第二份是第一轮结束后的内容；fake omp 收到 `prompt` 帧的时刻晚于对应快照目录出现的时刻

#### Scenario: 快照期间停止与删除
- **WHEN** 测试让 `take` 挂起，其间对该会话调用 stop，随后放行 `take`
- **THEN** stop 在 `take` 放行前已返回 202；prompt 返回 202；fake omp 在 `take` 放行前未被 spawn、未收到任何帧，放行后收到 `prompt` 帧与恰一个 `abort`；回合以恰一个 `turn.end{status:"stopped"}` 收尾；该用户消息的快照行为 `ok`
- **WHEN** 同样让 `take` 挂起，其间对该会话调用 DELETE，随后放行 `take`
- **THEN** DELETE 在回合被停止后返回 204；会话行、消息行与快照行都不存在（快照目录的删除见「快照清理」）；fake omp 没有跑完一个完整回合

#### Scenario: 命令回合与未绑定会话
- **WHEN** 绑定会话发送 `/todo`；一个 `workspace_id` 为 NULL 的存量会话（直接写库构造）发送普通 prompt
- **THEN** 前者的用户消息有一行 `outcome='command'` 且没有快照目录；后者没有快照行，两者都返回 202 且回合照常进行

#### Scenario: 快照失败不挡发送
- **WHEN** 测试令 `take` 抛错，或工作空间超出总量上限
- **THEN** prompt 仍返回 202 且回合完成；快照行的 `outcome` 分别为 `failed`（错误通道报告一次）与 `too_large`；没有残留的快照目录

#### Scenario: 受理被补偿时清理
- **WHEN** 快照成功后 supervisor 以 `agent_unavailable` 拒绝派发
- **THEN** prompt 返回 502；用户消息行与其快照行都不存在；该消息的快照目录已被删除

#### Scenario: 记录当时的任务清单
- **WHEN** 会话的 `chat_sessions.todo` 存有清单 T 时受理一条 prompt
- **THEN** 该消息快照行的 `todo` 与 T 的存储文本逐字相同；`todo` 为 NULL 的会话其快照行 `todo` 为 NULL

### Requirement: 还原
`restore`（入参为工作空间根与快照目录）SHALL 把工作空间还原为清单描述的状态，并返回 `{restored,removed,skipped,failed}`（`restored` 为内容被写回的文件数与被重建的符号链接数之和，`removed` 为被删除的多余条目数——只计清单里没有的条目，被递归删除的目录连同其下内容计一项；清单路径上类型不对而被替换的占位者不计，`skipped` 为清单的 `skipped`，`failed` 为 `[{path}]`）。它 SHALL 先读清单并校验：清单可解析且每个条目形状合法（`path` 是相对的 POSIX 路径，不含空分量、`.`、`..`，不以 `/` 开头，条目类型与字段齐全，路径不重复，每个条目与每个 `skipped` 路径的父级是清单里的目录条目或位于某个 `skipped` 路径之下）、`tree/` 存在、快照目录不在工作空间之内、工作空间根是真实目录（`lstat`，非符号链接）；任一不成立 SHALL 在改动任何工作空间条目之前抛错。随后：
- 现存而不在 `entries` 里、且不位于任何 `skipped` 路径之下（含其自身）的条目 SHALL 被删除（目录递归删除，不跟随符号链接）；
- 清单校验 SHALL 拒绝带 `incomplete` 键的清单（#1190：该标记已退役；带它的是旧版本在有变动的遍历之后写下的快照，不可还原）——与其它清单非法的情形同样处理，工作空间不被触碰；
- `entries` 里的目录 SHALL 存在（缺失则创建，mode `2770`；现存而不是目录的同名条目先删除）；
- `entries` 里的文件按以下次序判定，命中即止：
  1. 当前是普通文件且 `ino`、`size`、`mtimeMs`、`ctimeMs` 都与清单相等 → 不动、不读内容、不计入 `restored`（清单条目没有 `ino` 时本步不成立）；
  2. 当前是普通文件、`size` 与清单相等、且其前 `size` 个字节与 `tree/<path>` 逐字节相同 → 不动（不改内容、时间戳与权限位）、不计入 `restored`；
  3. 其余（不存在、不是普通文件、`size` 不同或内容不同）→ SHALL 从 `tree/<path>` 写回并计入 `restored`：在同一目录以独占方式新建一个名字不可预测的临时文件，写入内容后**在 `rename` 之前经它的句柄**把 `mtime` 设为清单值、把权限位显式置为 `(清单 mode & 0o777) | 0o660`（不受进程 umask 影响；setuid、setgid、sticky 位一律不带），再 `rename` 到位——`rename` 之后 SHALL NOT 再按最终路径改时间或权限位（那条路径此时可被换成符号链接）；写回 SHALL 复制内容，SHALL NOT 在工作空间与快照之间建硬链接；现存而不是普通文件的同名条目先删除；
- `entries` 里的符号链接：当前不是目标相同的符号链接则重建并计入 `restored`；
- `skipped` 路径及其之下的一切 SHALL NOT 被读取、改写或删除。
- 名字不是合法 UTF-8 的条目（#1148）：还原列举工作空间时 SHALL 按字节取名；在工作空间根或 `entries` 里的目录之下，名字的字节不能经 UTF-8 无损往返的条目及其之下的一切 SHALL NOT 被读取、改写或删除，也不计入 `removed` 与 `failed`——这一条与清单的 `skipped` 无关，不靠路径字符串匹配；相应地，清单里 `reason` 为 `name_encoding` 的 `skipped` 项 SHALL NOT 参与上一条「`skipped` 路径及其之下」的判定（它的 `path` 是有损的，可能恰与一个名字合法的条目相同，那个条目照常还原）。不在 `entries` 里的多余目录照旧整棵删除，其下这类名字的条目一并删除（该目录在快照时不存在，其下的一切都是之后才出现的）。

写回的文件 SHALL 对属主与属组都可读写（上式的 `0o660`）：清单里是 `0644` 的文件写回后为 `0664`，`0755` 写回后为 `0775`，`0600` 写回后为 `0660`。理由是写回的文件由 app 用户持有、靠父目录的 setgid 继承共享组，omp 用户只能经组权限继续读写它（ADR-0010）；其它用户位与执行位保持清单值。第 1、2 两种「不动」的文件权限位不被修改。

每次写或删之前 SHALL 对该条目自工作空间根起的各级父目录做 `lstat`：任何一级是符号链接或不是目录时，SHALL 跳过该条目并把它记入 `failed`，SHALL NOT 经由它写入或删除；单个条目的 `EACCES` / `EPERM` 同样记入 `failed` 并继续；其它错误（`ENOENT`、`EIO` 等）SHALL 向外抛出——此时工作空间处于部分还原的状态，重新调用可以继续。读取工作空间里的文件（元数据与内容比较）SHALL 经不跟随符号链接、不阻塞的句柄，确认是普通文件后才读。`restore` SHALL NOT 改动工作空间根之外的任何路径，SHALL NOT 修改快照目录（清单里的 `ctimeMs` 不随写回更新，所以被写回过的文件在下一次还原时走第 2 步的内容比较）。对同一份快照重复调用 SHALL 是幂等的：工作空间状态相同，且在两次调用之间工作空间没有别的改动时，第二次的 `restored` 与 `removed` 都为 0。

#### Scenario: 还原改动、新增与删除
- **WHEN** 快照时工作空间为 `a.txt`（"1"）、`dir/b.txt`（"2"）、`keep.txt`（"3"）；之后 `a.txt` 被改为 "x"、`dir/b.txt` 被删除、新增了 `c.txt` 与 `new/d.txt`，然后还原
- **THEN** 工作空间恰为 `a.txt`（"1"）、`dir/b.txt`（"2"）与 `keep.txt`（"3"）；`c.txt`、`new/` 不存在；返回 `restored=2`、`removed=2`、`failed=[]`；`keep.txt` 的 inode 不变

#### Scenario: 只计内容确有变化的文件
- **WHEN** 快照后 `a.txt` 被原样重写（内容与长度不变，`mtime` 与 `ctime` 变了）、`b.txt` 被改成等长的另一段内容、`c.txt` 只被 `chmod` 过，然后还原
- **THEN** 返回 `restored=1`、`removed=0`；`b.txt` 为快照内容；`a.txt` 与 `c.txt` 的 inode、时间戳与权限位都与还原前相同

#### Scenario: 跳过项不动并列出
- **WHEN** 快照的 `skipped` 含 `big.bin`（`too_large`）与 `node_modules`（`excluded`），其后二者内容都被改动，另新增了 `node_modules/x/y.js`，然后还原
- **THEN** `big.bin` 与 `node_modules` 之下的内容保持改动后的样子（包括新增的文件）；返回的 `skipped` 含这两项

#### Scenario: 非 UTF-8 文件名的条目不被当作多余条目删除
- **WHEN** 在 Linux 上快照时工作空间含 `a.txt`、目录 `d/` 与 `d/` 下一个名字含非法 UTF-8 字节的文件 B（快照把它记入 `skipped`，`name_encoding`）；之后 `a.txt` 被改写、根下新增了一个名字含非法 UTF-8 字节的文件 C、新增了目录 `new/`（内有一个名字含非法 UTF-8 字节的文件），然后还原
- **THEN** `a.txt` 为快照内容；B 与 C 都还在、字节未变；`new/` 整棵不存在；返回的 `removed` 为 1、`failed` 为空、`skipped` 含 B 那一项

#### Scenario: 带 incomplete 标记的旧清单不被还原
- **WHEN** 一份快照的清单带 `incomplete` 键（旧版本写下的；取值为 `true`、`false` 或别的值各一次），工作空间在快照之后改写了 `a.txt`、新增了 `c.txt`，然后还原
- **THEN** 还原按清单非法失败；`a.txt` 与 `c.txt` 都还在、字节未变（没有写回，没有删除）

#### Scenario: 版本库随撤回还原
- **WHEN** 快照时 `.git/refs/heads/main` 的内容为提交 A；之后的回合里新增了对象文件 `.git/objects/cd/ef01`、把 `.git/refs/heads/main` 改为提交 B，并改写了 `src/app.ts`，然后还原
- **THEN** `.git/refs/heads/main` 的内容回到提交 A，`.git/objects/cd/ef01` 不存在，`src/app.ts` 为快照内容；`skipped` 不含 `.git`

#### Scenario: 父目录被换成符号链接
- **WHEN** 快照含目录 `dir` 与 `dir/b.txt`，之后 `dir` 被换成指向工作空间外某目录 O 的符号链接（O 内有一个 `b.txt`），然后还原
- **THEN** 符号链接 `dir` 被删除（只删链接本身）并重建为真实目录，`dir/b.txt` 为快照内容；O 及其 `b.txt` 的内容与时间戳不变
- **WHEN** 直接对还原模块的路径校验给出一条某一级父目录为符号链接（指向 O）的待写回路径
- **THEN** 该条目出现在返回的 `failed` 里，O 内没有任何写入或删除

#### Scenario: 写回文件的权限位
- **WHEN** 快照时 `a.txt` 为 `0644`、`run.sh` 为 `0755`、`secret` 为 `0600`、`s.bin` 为 `04755`；之后四者内容都被改动，然后在 umask 为 `0o077` 的进程里还原
- **THEN** 四者的 `mode & 0o7777` 依次为 `0o664`、`0o775`、`0o660`、`0o775`

#### Scenario: 还原出的文件对 omp 用户可写
- **WHEN** 在 `uid-isolation` CI job 里，一个快照时为 `0644` 的文件被 omp 用户删除，还原后以 omp 用户向它追加一个字节
- **THEN** 追加成功（文件由 app 用户持有、属组为共享组、组可写）

#### Scenario: 结构性失败不动工作空间
- **WHEN** 快照目录的 `manifest.json` 缺失或不是合法 JSON，或工作空间根是符号链接
- **THEN** `restore` 抛错；工作空间内的条目与调用前逐字节相同

#### Scenario: 幂等
- **WHEN** 快照后工作空间被改动（一个文件被改写、一个被删除、另新增一个），对同一份快照连续还原两次，两次之间工作空间没有别的改动
- **THEN** 第一次返回 `restored=2`、`removed=1`；第二次返回 `restored=0`、`removed=0`、`failed=[]`，工作空间逐字节不变，第一次写回的文件没有被再次写回（inode 不变）

### Requirement: 快照清理
快照目录的生命周期 SHALL 跟随其登记行：
- 用户消息行被删除（会话删除的级联、撤回的事务、prompt 受理被补偿）之后，宿主 SHALL 在对应事务提交后删除每条被删消息的 `<OMP_STATE_DIR>/snapshots/<workspaceId>/<messageId>` 目录；被删消息的 id 与工作空间 id SHALL 在删除行之前读出；
- 临时空间行被删除之后，SHALL 删除整个 `<OMP_STATE_DIR>/snapshots/<workspaceId>` 目录；
- `outcome` 不是 `ok` 的行没有目录，不需要清理。

清理 SHALL 只在快照根之下按上述受信任分量拼出的路径上进行，目录不存在视为成功；任何清理失败 SHALL 只经服务错误通道报告，不改变触发它的请求的响应。清理 SHALL NOT 触及仍有登记行的快照目录。本 change 不提供按时间或按容量淘汰快照的机制，也不在启动时扫描快照根：`take` 进行中进程被杀留下的半份 `<messageId>` 目录没有登记行（对应的用户消息在启动对账后读作 `none`），它留在磁盘上直到所属临时空间被删除（整目录清理）或由运维在停服务后手工删除——消息 id 不复用，残留目录不会被之后的快照读到或当作「上一份快照」。

#### Scenario: 随会话删除清理
- **WHEN** 一个有三条用户消息（各有 `ok` 快照）的会话被删除，同一工作空间的另一个会话有一份快照
- **THEN** 204 之后三份快照目录都不存在，另一个会话的快照目录与其文件仍可读

#### Scenario: 清理失败不影响删除
- **WHEN** 测试令快照目录的删除抛错
- **THEN** `DELETE` 仍为 204；错误通道报告一次

#### Scenario: 临时空间删除时整目录清理
- **WHEN** 临时空间 T 的唯一会话被删除
- **THEN** `<OMP_STATE_DIR>/snapshots/<T>` 不存在
