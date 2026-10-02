# Proposal: files-changed-ownership（#522，父 tasks 3.4）

## Why
归约器（3.2）已经从 omp `edit`/`write` 的结束帧推导出文件变更候选，但路径是 `details` 里的原始值（多为宿主机绝对路径），所以 3.1 让 supervisor 把这类事件整条丢弃。web 的文件变更卡、产物卡与产物面板（7.5a/7.5b/7.6）都已合入，却没有任何数据来源。这一刀补上中间那段：在绑定的工作空间根内做 realpath 归属判定，把幸存项写进 `chat_steps.changes`，提交成功后才发布 `files.changed`。

## What Changes
- 新建 `server/src/sessions/file-changes-ownership.ts`：`ownedChanges(root, files)`——归属判定、相对化、合并、上限（有文件系统访问），以及纯判断 `ownedPath(realRoot, real)`。
- 新建 `server/src/sessions/store-changes.ts`：`setStepChanges(db, stepId, json)`；`store.ts` 把它挂到 `SessionStore`。
- `server/src/sessions/turn-control.ts`：`persistEvent` 的 `files.changed` 分支（现在恒返回 `undefined`）改为判定 → 落库 → 返回待发布事件；多收一个必填参数 `workspaceRoot`。
- `server/src/sessions/pool.ts`：`Slot` 增 `workspaceRoot: string | null`；`server/src/sessions/supervisor.ts`：创建 slot 时填入、调用 `persistEvent` 时传入（接线两行）。
- 新建 `server/test/file-changes-ownership.test.ts`（O1–O13）、`server/test/session-file-changes.test.ts`（F1–F5）、`server/test/persist-files-changed.test.ts`（P1–P6）。
- MODIFIED `turn-artifacts`「文件变更推导与归属」（supervisor 侧 1–7 步、持久化与发布次序、快照形状与各 Scenario）；MODIFIED `chat-stream`「纯协议事件归约」（一句现状句）与「思考与文件变更事件发布」（`files.changed` 成为已发布事件）。

## Non-goals
- 候选提取与 diff 计数（3.2）、thinking 合并（3.3）、快照投影（5.1）、空间绑定与 cwd（2.2）、fake-omp 场景（6.1）、web（7.x）：本刀只消费。
- bash/heredoc/脚本等非 edit/write 途径的写入（规格明确不覆盖）。
- `events.ts` 归约规则、`stream/`、`rest.ts`、`finishStep` 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **`persistEvent` 不在 `supervisor.ts`**：issue 写「`supervisor.ts` `persistEvent` 的 `files.changed` 分支（`:641-692`）」。change A 已把 `persistEvent` 搬到 `turn-control.ts:218-276`；分支体落在那里，`supervisor.ts` 只有接线。
2. **归属判定落新模块 `file-changes-ownership.ts`，不进 `file-changes.ts`**：`file-changes.ts` 由纯归约器 `events.ts` 导入，其文件头写明「路径保持原样，解析与归属属于 supervisor」；把 `node:fs` 引进去会让归约器的依赖图带上 IO。父 tasks 通用纪律也要求新代码落新模块。
3. **一个既有测试文件有改动**：issue 写「既有测试文件零改动」。`server/test/session-persist-new-events.test.ts:55` 直接调用 `persistEvent`，新参数是必填的，所以该调用补一个实参 `null`（未绑定），并更新文件头注释里「3.4 合入前不发布」的说法。其断言不变（该用例的 toolCallId 本就未登记，所以它钉住的是「未登记的调用不落库不发布」；Scenario「未绑定会话」由新用例 P2 与 F4 钉住）。参数不做成可选：缺省值会让漏传的调用方静默丢掉全部文件变更。
4. **「路径不存在」的判据是 `lstat` 无此条目**：父文只写「路径不存在时取父目录 realpath + 文件名」。只按 realpath 失败回落会放过一种逃逸：空间内指向空间外的悬空符号链接（例如 edit 删掉了链接指向的空间外文件），父目录 realpath 在空间内，链接名被当成空间内文件留下。所以 realpath 失败后先 `lstat`：条目存在（悬空链接、链接环、无权限）就丢弃，只有确实不存在才回落到父目录。
5. **`setStepChanges` 只写仍为 `running` 的步骤行，且要求恰好写到一行**：父文写「单条 `UPDATE chat_steps SET changes = ?`」。加 `AND status = 'running'` 与一行回执使「未收到工具结束帧即被结算的步骤 `changes` 为 NULL」成为写入端的保证；写不到一行按落库失败处理（抛错，走 owned error-sink）。
6. **子 delta 另加父文未写的可观察行为**：未绑定时不做任何文件系统访问；`stepId` 不是本回合已登记的调用时丢弃；与根同前缀的兄弟目录、NUL 字节与过长路径的处理；保存值是 realpath 相对根 realpath 的路径（经空间内符号链接到达的空间内文件保存其真实位置）；合并时 `kind` 取首次出现、`write` 项的计数保持 `null`；元素键次序；`files` 与列解析后等值；新增 Scenario「不存在的文件按父目录判定」「进程工作目录在空间根外」。
7. **`supervisor.ts` 落在恰好 800 行**：现为 799 行（父 tasks 记录的预算基线是 770）。接线 +2 行；`#commit` 里那段 3 行注释本就要补一句 `files.changed`，改写成 2 行，净 +1。再往后任何一刀触及该文件都必须先拆。
8. **父 D6 的「提交路径上的 IO 有界（每步最多 50 个路径 × 2 次 realpath）」不成立**：上限在合并之后才截断，候选本身不设上限，每个候选都要解析。候选数只受单帧大小约束。见 design「已知残留」1；本刀按规格实现、不另设候选数上限。
9. **候选先做词法规范化（`path.resolve`）**：父文只写「绝对原样、相对拼接」。不规范化时，悬空符号链接加结尾斜杠（`dangling/`）会绕过偏差 4 的 `lstat` 判据。`..` 因此按词法折叠（design「已知残留」7）。
10. **空间根必须是规范路径**：父文只写「以根 realpath + 分隔符为前缀」。根若被移走并换成指向别处的符号链接，按根的 realpath 判定会把根外文件当成空间内。生产里的根来自 `rootOf`，本身就是 realpath；realpath 不等于自身时整条丢弃。子 delta 加 Scenario「空间根不是规范路径」。
11. **三个新测试文件**（issue 写两个）：多出 `persist-files-changed.test.ts`，放 `persistEvent` 分支与 `setStepChanges` 的单元层用例，避免集成测试文件超过 800 行。1024 字节的边界值在不碰文件系统的 `ownedPath` 上取证（macOS 的 `PATH_MAX` 是 1024，issue 设想的「父目录真实存在的 1025 字节路径」在本机建不出来）。
12. 只并入父 delta 的 supervisor 归属判定、持久化与发布部分；`turn-artifacts` 的 web 侧 Requirement 不动。

## Impact
- server：两个新产品文件、四个既有产品文件改动（其中 `pool.ts`、`supervisor.ts`、`store.ts` 只有接线）、三个新测试文件、一个既有测试文件的一处调用。web 无改动。
- 运行时：绑定工作空间的会话里，成功的 `edit`/`write` 步骤开始产生 `files.changed` 事件与快照 `changes`，web 的文件变更卡、产物卡与产物面板从此有数据。未绑定会话行为不变。
- 安全：这是 AGENTS.md Critical Path「沙箱与文件边界」上的改动——卡片只能指向空间内真实路径，宿主机绝对路径不得出现在 SSE 与数据库列里。PR 请求白盒审查。
- 依赖：#510、#515、#517、#518、#519、#521 已合并。
