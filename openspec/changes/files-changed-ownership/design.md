# Design: files-changed-ownership（#522）

## Context
- `events.ts:14`：`ChatEvent<StepId>` 含 `files.changed{messageId, stepId, files: FileChange[]}`；归约器（`:231`）在成功的 `edit`/`write` 结束帧的 `step.end` 之前、同一返回结果里输出它，`stepId` 是 toolCallId 字符串，`files[].path` 是 `details` 里的原始路径（`file-changes.ts`，99 行，纯函数，文件头写明「路径保持原样，解析、归属、上限与持久化属于 supervisor」）。
- `turn-control.ts:218-276` `persistEvent(store, assistantMessageId, event, toolIds, nextOrdinal, settled)`：一进一出、switch 无 default。`step.start` 调 `store.startStep` 并登记 `toolIds.set(toolCallId, 数字步骤 id)`；`step.end` 查不到登记返回 `undefined`，否则 `store.finishStep` 后返回数字 id 的事件。`:269-274` 的 `thinking.delta`/`files.changed` 分支恒返回 `undefined`（注释写着等 3.4 替换）。唯一的产品调用方是 `supervisor.ts:676`；测试 `server/test/session-persist-new-events.test.ts:55` 直接调用它（六个实参）。
- `supervisor.ts`（**799 行**，上限 800）：
  - `#onNewSlot`（`:430-496`）：`const cwd = this.#cwdOf(resume.ownerId, resume.workspaceId)`（`:437`）；slot 字面量 `:438-449`；`cwd` 传给 `SessionRuntime`（`:478`）。`Resume = { ownerId, ompSessionFile, workspaceId: string | null }`（`branching.ts:27`）。
  - `#pump`（`:571-643`）逐帧 `applyFrame` → `#commit`；`#commit`（`:652-698`）对每个事件：先处理 thinking 缓冲（`:661-672`，其中 `:661-663` 是 3 行注释），再在 `try` 里 `persistEvent(...)`（`:676-683`，每个实参一行）→ 有返回值则 `await this.#publish(...)`；`catch`（`:690-695`）置 `slot.infraFaulted = true`、`this.#retain(asError(error))`、`await this.#retireSlot(slot)`、返回 `false`——这就是 owned error-sink 路径，`#publish` 没被调用，ring 序号不动。
- `session-cwd.ts`：未绑定会话的 cwd 是 `join(sandboxRoot, ownerId)`（所有者根）；绑定会话的 cwd 是 workspace store 的 `rootOf` 给出的空间根（已是目录，否则抛错不 spawn）。**两种会话都有 cwd，所以带到分支的必须是「空间根或 null」，不能是 cwd。**
- `pool.ts:21-32` `interface Slot`；产品里唯一的字面量在 `supervisor.ts:438-449`（测试里两处用 `as unknown as Slot`，不受新字段影响）。
- `chat_sessions.workspace_id` 创建后不会被改写（`store-metadata.ts:6`：元数据 PATCH 从不触碰它），进程的 `--cwd` 在 spawn 时固定，所以空间根在 slot 的生命周期内不变。唯一能改它的是外键的 `ON DELETE SET NULL`（迁移 035），而 workspace store 目前没有删除操作（`server/src/workspaces/store.ts:35-39`）；删空间的功能落地时须退役存活的 slot。
- `store.ts`（**789 行**）：`SessionStore` 接口 `:177-181`（`appendThinking`、`startStep`、`finishStep`）；实现 `:541-604`（`finishStep` 在 `:580-604`）。`finishStep` 的 SQL 是 `UPDATE chat_steps SET status = ?, output = ?, ended_at = ? WHERE id = ? AND message_id = ? AND status = 'running'`，不读写 `changes`。拆出去的写入模块以 `store-thinking.ts`（45 行，`appendThinking(db, messageId, chunk)`，`store.ts:541-544` 里 `assertOpen(closed)` 后转调）为样板；`requireChanges(changes, 1, operation)` 在 `store-branch.ts:102`。
- 快照读取：`store-branch.ts:77` 对 `chat_steps.changes` 直接 `JSON.parse`，不校验——元素合法性是写入端（本刀）的责任（`store.ts:58` 的注释）。web 对它严格解析（`web/src/lib/session-contract.ts:164-188`）：元素键恰为 `path/added/removed/kind`；`path` 非空字符串；`edit` 的 `added`/`removed` 为非负安全整数；`write` 的两者为 `null`；数组 1..50 项。违反任何一条，web 会丢掉整个快照步骤或把事件当作畸形而触发重同步。
- `stream/`、`rest.ts` 里没有按事件类型的登记（`grep files.changed|thinking.delta` 无命中）：ring 与 SSE 端点对事件类型透明，3.3 也没有改它们。
- fake-omp `edit-write` 场景（`server/test/support/fake-omp.mjs:664-675`、`fake-omp-thinking.mjs:76-99`）：思考 → `edit`（`details:{path:<cwd>/notes.md, diff:"+1|a\n+2|b\n-3|c\n 4|d"}`）→ `write`（`details:{resolvedPath:<cwd>/out/report.html}`）→ 正文；两个文件真实写到子进程的 `process.cwd()` 下，路径都是**绝对路径**。
- 测试支撑：`createRealFakeRuntime`（`session-supervisor-helpers.ts:88-123`）的 `spawnImpl(command, args, options)` 把 `options` 原样交给子进程——替换 `options.cwd` 即可让子进程在空间根之外运行；`openRecordingSession`（`:209-228`）收集 `events` 与 `errors`；绑定会话的搭法见 `session-workspace-cwd.test.ts`（`POST /api/workspaces` 建空间、直接 SQL 写 `chat_sessions.workspace_id`、路径一律经 realpath 比较——macOS 的 tmpdir 是 `/var` → `/private/var`）；带游标重连与「上一个 id 之后恰回放一次」的写法见 `session-thinking.test.ts:435-468`（`openEventStream`、`readUntil`、`parseSse`）；SQLite 写失败的注入先例是 `session-supervisor-faults.test.ts:45-48` 的 `CREATE TEMP TRIGGER … RAISE(ABORT, …)`。
- `core/sandbox/resolve.ts`：语义不同（拒绝绝对路径与任何符号链接分量、接受根自身），只作纪律参考，不复用。

## Decisions

### D1 `file-changes-ownership.ts`（新，唯一做文件系统访问的地方）
```ts
export function ownedChanges(root: string, files: readonly FileChange[]): FileChange[]
/** 纯判断：`real` 严格位于 `realRoot` 之内且相对路径不超过 1024 字节时返回相对路径。 */
export function ownedPath(realRoot: string, real: string): string | undefined
```
1. **根必须是规范路径**：`realpathSync(root)` 抛错或结果 `!== root` → 返回 `[]`。生产里的根来自 workspace store 的 `rootOf`，本身就是 realpath（`server/src/workspaces/store.ts:212-224` → `core/sandbox/resolve.ts:18`）；不等只可能是根在 spawn 之后被移走并换成了符号链接（所有者根与空间根对 omp uid 组可写，`core/sandbox/dirs.ts:10`），此时整条丢弃。
2. 逐个候选（保持输入次序）：
   - `target = resolve(root, file.path)`（`node:path`）：绝对路径原样、相对路径拼根，并做词法规范化——折叠 `.`、`..`、重复与结尾的分隔符。**之后的 `realpathSync`、`lstatSync`、`dirname`、`basename` 都只用 `target`。** 不规范化的话，`dangling/`（悬空符号链接加结尾斜杠）会让 `lstat` 跟随链接报「无条目」，回落后把链接名当成空间内文件留下。
   - `real = resolveReal(target)`（见下）；`undefined` → 跳过。
   - `path = ownedPath(root, real)`；`undefined` → 跳过。
   - 合并：`Map<string, FileChange>`（插入序即首次出现的位置）。首次出现 → 新建 `{ path, added, removed, kind }`（**键按此次序**）；再次出现 → 位置与 `kind` 不变，`kind === "edit"` 时 `added`/`removed` 各自相加（把 `null` 当 0），`kind === "write"` 时保持 `null`。同一事件来自同一次工具调用，`kind` 实际不会不同；规则写死是为了任何输入下产出的元素都满足 Context 里 web 的校验。
3. 返回 `[...map.values()].slice(0, 50)`——**先合并后截断**。
4. 不修改入参，返回的对象全是新建的；对任何 `FileChange` 对象数组都不抛错（`path` 取什么值都一样；非对象元素见「已知残留」14）——单个候选的 `resolve → resolveReal → ownedPath` 包在模块私有的 `ownedCandidate` 的 `try/catch` 里（`path.resolve` 对非字符串抛 `TypeError`），根的规范性检查在模块私有的 `isCanonical` 里。

`ownedPath(realRoot, real)`（不碰文件系统，便于在任何平台上取边界值的证据）：
- `prefix = realRoot + sep`；`real.startsWith(prefix)` 不成立 → `undefined`（根自身、根外、兄弟前缀 `…/ws2`、经符号链接逃出的都落在这里）。
- `path = real.slice(prefix.length)`（服务端只跑在 POSIX 上，分隔符即 `/`）。纯函数自身不校验非空（`ownedPath("/ws", "/ws/")` 是 `""`）；经 `ownedChanges` 到不了这里——`realpathSync` 与 `join(realpath(父目录), basename(target))` 的结果除 `/` 外不以分隔符结尾，而 `/` 不以任何 `根 + sep` 为前缀。
- `Buffer.byteLength(path, "utf8") > 1024` → `undefined`；否则返回 `path`。

`resolveReal(target): string | undefined`（模块私有）：
- `try { return realpathSync(target) } catch {}`——**用 JS 版 `realpathSync`，不用 `.native`**。
- 失败后 `lstatSync(target, { throwIfNoEntry: false })`：抛错或返回了条目（悬空符号链接、链接环、无权限、ENOTDIR）→ `undefined`；确实没有条目 → `real = join(realpathSync(dirname(target)), basename(target))`，再对 `real` 做一次 `lstatSync(real, { throwIfNoEntry: false })`：抛错或有条目 → `undefined`，确实没有条目才返回 `real`（整段在 `try/catch` 里，抛错即 `undefined`）。第二次 `lstat` 不能省：`lstat(target)` 走内核语义，JS `realpathSync` 对符号链接**目标**里的 `..` 做词法折叠，两者可以指向不同位置——空间内 `a -> d/../sub`（`d -> deep/dir`）时，内核把 `a/name` 解析到 `deep/sub/name`（无条目），JS 把父目录解析到 `sub`，而 `sub/name` 可以是悬空符号链接或链接环；不复查就会把它当成空间内文件留下（fix pass 1，评审发现）。（Node 24 实测：ENOENT 返回 `undefined`；ENOTDIR、EACCES、ELOOP 抛错；悬空链接返回条目。）
- NUL 字节与过长路径使这些调用抛错（`ERR_INVALID_ARG_VALUE`、`ENAMETOOLONG`），落在「抛错 → 丢弃」里，不需要单独判断。

`..` 的语义是**词法折叠**（`link/../x.md` 即 `x.md`，不管 `link` 是不是符号链接），与 Node 工具链惯用的 `path.resolve(cwd, arg)` 一致；内核语义下它可能指向别处，见「已知残留」7。

不创建、不读取、不写入任何文件；每个候选 1–4 次同步 `node:fs` 调用。这不是系统调用次数：JS `realpathSync` 对路径的每个分量各做一次 `lstat`，每遇到一个符号链接再 `stat` + `readlink` 并重走，候选之间不缓存——代价是 O(分量数 × 链接跳数)，见「已知残留」1。

### D2 `store-changes.ts`（新）与 `store.ts` 接线
```ts
const SET_CHANGES = "UPDATE chat_steps SET changes = ? WHERE id = ? AND status = 'running'";
export function setStepChanges(db: DatabaseSync, stepId: number, json: string): void {
  requireChanges(db.prepare(SET_CHANGES).run(json, stepId).changes, 1, "step changes");
}
```
- `SessionStore` 增 `setStepChanges(stepId: number, json: string): void`，实现 `assertOpen(closed)` 后转调（同 `appendThinking` 的写法）。`finishStep` 不动。`store.ts` 789 → 797。
- 单条语句自成事务。写不到恰一行（步骤已结算、已被删除）→ `requireChanges` 抛错 → D4 的失败路径。

### D3 `turn-control.ts`：`persistEvent` 的分支
签名末尾加**必填**参数 `workspaceRoot: string | null`。
```ts
case "files.changed": {
  const stepId = toolIds.get(event.data.stepId);
  if (stepId === undefined || workspaceRoot === null) return undefined;
  const files = ownedChanges(workspaceRoot, event.data.files);
  if (files.length === 0) return undefined;
  store.setStepChanges(stepId, JSON.stringify(files));
  return { type: "files.changed", data: { messageId: event.data.messageId, stepId, files } };
}
```
- 未绑定（`null`）在任何文件系统访问之前返回。
- 落库的文本与发布的 `files` 是同一个数组：列解析后与事件等值。`JSON.stringify` 对孤立代理项输出转义序列，文本总是合法的。
- `thinking.delta` 分支保持返回 `undefined`；`:269-271` 的注释改成现状（`files.changed` 不再是「等 3.4」）。
- 认知复杂度：分支很小；若 `persistEvent` 触到 Biome 上限 15，把分支体提成同文件的私有函数。

### D4 接线：`pool.ts` 与 `supervisor.ts`（799 → **800**）
- `Slot` 增 `workspaceRoot: string | null`（带一行注释：绑定会话进程所在的空间根，未绑定为 `null`）。
- `#onNewSlot` 的 slot 字面量加一行 `workspaceRoot: resume.workspaceId === null ? null : cwd,`（+1）。
- `#commit` 的 `persistEvent(...)` 调用末尾加实参 `slot.workspaceRoot`（+1）。
- `:661-663` 的 3 行注释改写成下面 2 行（−1；每行 ≤100 列，超了就再缩措辞，不许回到 3 行）。净 +1，落在 800（size-guard 只拦 `> 800`）。不做其它改动、不搬代码。
  ```ts
      // thinking.delta goes to the slot's buffer, never to persistEvent; any other event (also
      // files.changed) flushes it first, so a failed flush leaves no stored terminal off the ring.
  ```
- 失败路径不需要新代码：`setStepChanges` 或 `ownedChanges` 抛出的任何错误都被 `#commit` 既有的 `catch` 接住（Context），`#publish` 没被调用，所以「不发布、ring 序号不推进、走 owned error-sink」由既有结构给出。
- 次序不需要新代码：归约器在同一个返回结果里把 `files.changed` 排在 `step.end` 之前，`#commit` 按序处理，`step.end` 走既有的 `finishStep`。

### D5 既有测试的改动
`server/test/session-persist-new-events.test.ts:55` 的 `persistEvent(...)` 调用补第七个实参 `null`；文件头注释 `:2-5` 改成现状（未绑定时 `files.changed` 不落库不发布）。断言不变。其它既有测试零 diff。

## Governing invariant
1. **宿主机路径不出进程**：发布的 `files.changed` 与 `chat_steps.changes` 里的每个 `path` 都是「候选的 realpath」相对「空间根的 realpath」的非空相对路径；原始路径、空间根、所有者根的绝对路径都不出现。
2. **空间外不留痕**：realpath 不严格位于空间根 realpath 之内的候选不产生任何持久化或发布；未绑定会话不产生任何持久化、发布或文件系统访问。
3. **先落库后发布**：`files.changed` 入 ring 时该步骤行的 `changes` 已提交；落库失败时该事件不入 ring、不占序号。
4. **写入端保证读取端的不变量**：写进列里的总是 1..50 项、键恰为 `path/added/removed/kind`、`edit` 为非负整数、`write` 为 `null` 的 JSON 数组。
5. **`step.end` 不受影响**：有没有 `files.changed`、被不被丢弃，`step.end` 的落库与 payload 都与此前相同。

## Sibling surfaces
- 快照（`store-branch.ts:77`、`rest.ts:325`）：只读该列；本刀不改，F2 用它核对与事件流等值。
- thinking 缓冲（`#commit` 开头）：`files.changed` 与其它非 thinking 事件一样先冲刷缓冲，F1 的次序断言覆盖。
- 审批（`#approvals.publishRequest`、REST 结算）：`files.changed` 与 `step.end` 之间隔着一个 `await this.#publish(...)`；另一路发布（审批结算）理论上可以插到两者之间——见「已知残留」2。
- regenerate / 删会话：步骤行随消息删除（FK），`changes` 一并消失；无新代码。
- fork：`store-branch.ts:193` 的 `FORK_STEPS` 连同 `changes` 一起复制步骤行，`:187` 复制 `workspace_id`，所以相对路径在分叉出的会话里仍然有效；本刀不改。
- web：`stream-artifacts.ts`/`session-contract.ts` 已按本契约解析；本刀不改 web。

## Must-preserve
- `finishStep`、`step.end` payload、`startStep`、thinking 合并与发布、未绑定会话的全部既有行为。
- `events.ts`、`file-changes.ts`、`stream/`、`rest.ts`、`store-branch.ts` 零 diff。
- 所有文件 ≤800 行（`supervisor.ts` 恰为 800）；knip 零新增；jscpd 克隆数不增。

## Required evidence

`server/test/file-changes-ownership.test.ts`（真实临时目录，合成候选；每个用例自建并清理目录）：
- **O1** 空间内绝对路径的 `edit` → `[{path:"notes.md", added:2, removed:1, kind:"edit"}]`；`Object.keys` 恰为 `["path","added","removed","kind"]`；`write` → `added`/`removed` 为 `null`；嵌套目录给出 `/` 分隔的相对路径。
- **O2** 相对路径以根拼接；`./a/../b.md` 落在 `b.md`；`link/../x.md`（`link` 是指向空间外目录的符号链接）按词法折叠落在 `x.md`；带结尾分隔符的合法文件写法（`sub/`、`sub//`，`sub` 是空间内已存在的条目）与不带的结果相同。
- **O3** Scenario「多文件与重复路径」：`a.md`(+1)、`b.md`(−1)、`a.md`(+1) → `[{a.md,2,0},{b.md,0,1}]`，位置取首次；同一文件的两种写法（绝对与相对）合并为一项。
- **O4** 同一路径的两个 `write` 候选合并后仍是 `null`/`null`。
- **O5** 上限：60 个不同的合法候选 → 派生次序前 50；51 个候选、第 51 个与第 1 个同路径 → 50 项且第 1 项的计数已求和（先合并后截断）。
- **O6** 长度（`ownedPath`，不碰文件系统——macOS 的 `PATH_MAX` 是 1024，根加 1024 字节的相对路径在真实目录里建不出来）：相对路径恰 1024 字节 → 返回；1025 字节 → `undefined`；字符数不足 1024 而 UTF-8 超过 1024 字节的中文路径 → `undefined`；根自身、根外、兄弟前缀 → `undefined`。另用真实目录证明一条较长（约 600 字节、多级目录）的合法路径经 `ownedChanges` 保留。
- **O7** Scenario「空间外与符号链接逃逸」：`/etc/passwd`、`../other/x.md`（兄弟目录真实存在）、空间根自身（绝对路径与相对的 `.`）、与根同前缀的兄弟目录 `<root>2/x.md`、空间内指向空间外目录的符号链接下的 `link/x.md`（存在与不存在各一）、空间内指向空间外已存在文件的符号链接、空间内指向空间外的悬空符号链接（`dangling` 以及 `dangling/`、`dangling//`、`dangling/./`，相对与绝对写法各一）、符号链接环（`loop` 与 `loop/x.md`）、把文件当目录用的路径（`notes.md/x.md`，`notes.md` 是空间内的普通文件）——同批合法路径保留，其余全部丢弃；这些非法候选单独出现 → `[]`。
- **O8** Scenario「不存在的文件按父目录判定」：已存在目录下不存在的文件保留；父目录也不存在的丢弃。
- **O9** Scenario「空间根不是规范路径」：根以符号链接别名给出（别名指向一个真实目录，候选在该目录下）→ `[]`；根目录被移走并在原路径放一个指向空间外目录的符号链接 → `[]`。（O 系列其余用例的根一律先取 realpath——macOS 的 tmpdir 是 `/var` → `/private/var`。）
- **O10** 根不存在 → `[]`，不抛错。
- **O11** 含 NUL 字节的路径、超过文件系统路径上限的路径丢弃，不抛错；同批合法路径保留。
- **O12** 空间内指向空间内文件的符号链接 → 保存真实位置的相对路径，并与直接写法合并。
- **O13** 不修改入参（深比较入参前后一致），返回的是新对象。

`server/test/persist-files-changed.test.ts`（`persistEvent` 与 `setStepChanges` 的单元层）：
- **P1** 绑定根 + 已登记的 toolCallId + 合法候选 → store 恰被调用 `setStepChanges(<数字 id>, <JSON 文本>)` 一次，返回 `files.changed{messageId, stepId:<数字 id>, files}`，`JSON.parse(文本)` 与 `files` 深相等，文本里不含根的绝对路径。
- **P2** `workspaceRoot === null` → 返回 `undefined`、store 无任何访问；用一个指向真实空间内文件的候选证明不是「判定后为空」。
- **P3** 未登记的 toolCallId → `undefined`、store 无访问；全部候选在根外 → `undefined`、store 无访问。
- **P4** 次序：`setStepChanges` 抛错时 `persistEvent` 抛出同一个错误、没有返回事件（先落库后返回）。
- **P5** `setStepChanges`（真实数据库）：`running` 步骤 → 列等于传入文本；已结算（`done`）的步骤 → 抛错且列保持 NULL；不存在的步骤 id → 抛错。
- **P6** `thinking.delta` 仍返回 `undefined` 且 store 无访问（护栏，实现前即绿）。

`server/test/session-file-changes.test.ts`（生产装配 + 真实 fake-omp 子进程，`edit-write` 场景）：
- **F1** 绑定会话（子进程 cwd 即空间根）：ring 次序为 `turn.start`、一条合并的 `thinking.delta`、`step.start`/`files.changed`/`step.end`（edit）、`step.start`/`files.changed`/`step.end`（write）、`text.delta`…、`turn.end`，id 连续；两条 `files.changed` 的 payload 为 `{files:[{path:"notes.md",added:2,removed:1,kind:"edit"}]}` 与 `{files:[{path:"out/report.html",added:null,removed:null,kind:"write"}]}`，`stepId` 是与各自 `step.start` 相同的数字；`chat_steps.changes` 两行的文本解析后与 payload 的 `files` 等值、元素键恰为 `path/added/removed/kind`；事件与列的文本里不含空间根的绝对路径。
- **F2** 同一回合以早于 `thinking.delta` 的游标重连 → `thinking.delta`、两条 `files.changed`、两条 `step.end` 各恰回放一次且次序不变；随后 `GET /api/sessions/:id/messages` 的助手 `thinking` 与两步 `changes` 与事件流等值。
- **F3** 绑定会话、子进程 cwd 被替换为空间根之外的目录 → 无 `files.changed`；两步 `changes` 为 NULL；两条 `step.end` 照常（状态与 output 与 F1 相同）；`errors` 为空。
- **F4** 未绑定会话 → 无 `files.changed`、`changes` 为 NULL、`step.end` 照常、`errors` 为空。
- **F5** TEMP TRIGGER `BEFORE UPDATE OF changes ON chat_steps … RAISE(ABORT, …)`：预先打开的 SSE 流收到的 id 序列止于该步骤的 `step.start`（其后没有 `files.changed`、也没有被消耗掉的序号——失败后 slot 被退役、generation 封存，所以判据取自流上实际收到的 id，写法同 `session-thinking.test.ts:353-385`）；`errors` 含该 SQLite 错误；该步骤 `changes` 为 NULL。

既有：`server/test/session-persist-new-events.test.ts` 按 D5 更新后全绿；其它 server 测试零 diff 全绿。Scenario「失败与非 edit/write 工具」的归约器一侧由既有的 `server/test/file-changes.test.ts` 与归约器测试覆盖（这些情形不产生 `files.changed`，本刀的分支无从触发）；`changes` 为 NULL 由 F3/F4 的列断言与列默认值给出。

实现前就成立的护栏（不计入 RED）：P6；F3、F4 里「无 `files.changed`、列为 NULL」的断言（实现前一切都被丢弃）。其余在实现前为红。

交付记录（第一轮 42 个用例：O 31、P 6、F 5；fix pass 1 之后 52 个：O 41，其中 1 个仅在非 darwin 上运行）：
- RED（基线 `738f144` + 仅三个新测试文件，`npx vitest run --coverage.enabled=false` 三个文件）：O 文件收集失败（模块不存在，31 个用例全部未收集）；P1–P5 红（P2、P3 各带一个「同样的候选在绑定且已登记时会落库并返回事件」的正对照，所以实现前为红）；F1、F2、F5 红；P6、F3、F4 绿——8 failed / 3 passed，与上面的预期一致。
- GREEN：`npm test --workspace server` 155 个文件、2396 个用例通过（3 个既有 skip）；两个新产品文件的行/分支/函数覆盖率均为 100%；三个新文件连跑 3 次每次 42/42，结束后无残留临时目录或 fake-omp 进程。
- 证据之外的补充断言：O2 `notes.md/`；O3 首项计数为 `null` 的合并；O7 裸 `link`、`dangling/x.md`、判定前后目录树不变（不创建不删除任何条目）；O8 经空间内符号链接目录的不存在文件；O9 根带结尾斜杠或 `/sub/..`；O10 普通文件当根、空串根、相对根（JS `realpathSync` 先做 `path.resolve`，这些都不等于自身）；O11 非字符串 `path`；F1 在发布 sink 内读列，证明 `files.changed` 发布时 `changes` 已提交且步骤仍为 `running`。
- P 文件对 `node:fs` 做了透传记录（`vi.mock` + Proxy，只记被调用的函数名，行为不变，每次 `persistEvent` 前清零）：P2、P3（未登记）、P6 的「无文件系统访问」是直接观察到的。不这样做，变异 11「`null` 仍判定」杀不掉——`realpathSync(null)` 抛错被吞，结果同样是 `undefined`。
- F 系列把 `runtime.sandboxRoot` 取成规范写法（macOS 的 tmpdir 是 `/var` → `/private/var`）：否则未绑定会话的所有者根不规范，变异 15「恒为 `cwd`」会被根规范性检查挡成 `[]`，F4 杀不掉它。
- F5 的流在 prompt 之前打开并立即消费，等到 `step.start` 的 id 后再取全量（`edit-write` 场景没有挂起旋钮）。
- fix pass 1（评审采纳的 P2：符号链接目标含 `..` 时，回落位置上的悬空符号链接、链接环、「把文件当目录」被保留）：RED（`379c9a7` + 仅新测试）4 红——O7 `a/name`、`a/loop`、`b/x.md`、同批只留合法路径；36 绿、1 跳过。修复后 `npm test --workspace server` 155 个文件、2405 个用例通过。新增护栏（修复前后都绿）：`a/x.md` → `sub/x.md` 与 `a/gone.md` → `sub/gone.md`（第二次 `lstat` 不误伤合法回落）、`a/kname`、`c/x.md`、O2 `link/../y.md`、指向根自身的 `self`（`self/x.md` → `x.md`，裸 `self` 丢弃）、`up -> ..`（`up/<空间目录名>/x.md` → `x.md`、`…/gone.md` → `gone.md`、`up/<空间目录名>` 丢弃）。
- O6 增加一条真实目录树上的 1024/1025 字节用例（四级目录 255/255/255/200 字节 + 55/56 字节的叶子），`it.skipIf(process.platform === "darwin")`：macOS 上建不出来，只在 Linux（CI）上运行；本机没有执行过它。

## 变异自检（实现者在沙箱里做，脚本与日志不入库）
每个变异至少使一个用例变红：
1. 前缀判定去掉 `+ sep`（`startsWith(realRoot)`）→ O7（兄弟前缀）。
2. 去掉「根的 realpath 必须等于自身」的检查（改用 realpath 结果继续判定）→ O9。（「去掉检查但前缀仍用 `root` 原串」对符号链接根是等价的——候选的 realpath 天然不以符号链接根为前缀；但它不是等价变异：根为空串时前缀成了 `/`，所有绝对路径都会被当作空间内，由 O10 的空串根用例杀死。）
2b. 候选用 `join`/原串而不做 `resolve` 规范化 → O2（`link/../y.md`：内核位置 `<空间外>/y.md` 有条目而根内没有，两种写法都应保留为 `y.md`）。fix pass 1 之前由 O7（`dangling/`）杀死；回落位置的第二次 `lstat` 现在也会接住 `dangling/`，所以归属移到了 O2。
3. 去掉父目录回落 → O8。
4. realpath 失败后不做第一次 `lstat`、直接回落 → O7（`a/kname`：悬空符号链接只在内核位置 `deep/sub`；`c/x.md`）；第一次 `lstat` 抛错时当作「无条目」继续回落 → O7（`c/x.md`：内核位置是普通文件，ENOTDIR；JS 位置是目录）。fix pass 1 之前这两个变体由 `dangling`、`notes.md/x.md` 与 NUL 的用例杀死；内核位置与 JS 位置重合时第二次 `lstat` 会接住它们，所以两次 `lstat` 各自的必要性只在两个位置不同的构造（`a -> d/../sub` 一类）下才区分得出来。符号链接环（`loop`、`loop/x.md`）的用例钉的是规格第 3 步的行为。
4b.（fix pass 1）去掉回落位置的第二次 `lstat` → O7（`a/name`、`a/loop`、同批用例、`b/x.md`）；第二次 `lstat` 抛错时当作「无条目」→ O7（`b/x.md`：JS 位置是普通文件，ENOTDIR；内核位置是目录）。
5. 对候选只做词法规范化、不取 realpath → O7（符号链接目录）、O12。
6. 先截断后合并 → O5。
7. `ownedPath`：用 `path.length` 代替 `Buffer.byteLength` → O6（中文路径）。
8. `ownedPath`：上限 `>` 写成 `>=` → O6（恰 1024 字节）。
9. 合并时不求和 / 位置取最后一次 → O3。
10. 相对路径不拼根（当作相对进程 cwd）→ O2。
11. `persistEvent`：`workspaceRoot === null` 时仍判定 → P2；未登记的 toolCallId 仍落库 → P3。
12. `persistEvent`：先构造返回值、吞掉 `setStepChanges` 的异常 → P4、F5。
13. `persistEvent`：发布原始 `event.data.files` 而不是判定结果 → P1、F1。
14. `setStepChanges`：去掉 `AND status = 'running'` → P5；去掉一行回执 → P5。
15. `supervisor.ts`：slot 的 `workspaceRoot` 恒为 `cwd`（未绑定也判定）→ F4；恒为 `null` → F1。

结果：上列 1、2、2b、3–15（含双变体共 22 个）加两个自拟变异（根外的路径以其文件名保留 → O6、O7、F3；去掉 `ownedCandidate` 的 `try/catch` → O11）共 24 个，全部被杀，每个变异的红用例都包含上面点名的 id。fix pass 1 之后在修复后的树上重跑全部脚本并加上 4b 的两个，共 26 个，全部被杀（归属按上面更新后的写法）。

## 已知残留
1. **候选数不设上限，单条事件的同步代价无界**：上限 50 在合并之后才截断，每个候选都要解析，候选之间不缓存（20 万个相同的候选各解析一次）；父 D6 的「IO 有界」不成立（proposal 偏差 8）。候选数只受 omp 单帧重组上限约束（64 MiB，`server/src/sessions/omp/frame.ts:4`；归约器 `file-changes.ts` 没有更早的上限），最小的候选元素约 23 字节，一帧可带约 290 万个候选。每个候选的代价由 agent 可控的目录深度与链接链决定，与候选串长度无关。评审在 macOS / Node 24 上的实测（每候选）：根下已存在文件 12 µs、根下不存在文件 28 µs、50 层目录下不存在文件 0.2 ms、200 层 1.5 ms、400 层 6.5 ms；6 字节的候选经一个指向 400 层目录的符号链接同样是 6.6 ms。量级：行为失常的 omp 发一帧，最浅也是几十秒、对抗构造下是小时级的事件循环同步阻塞（期间所有会话、停止与健康检查都不响应）；诚实的 omp 在用户刻意建出的深目录里一次改 200 个文件约 1 秒。诚实使用下的规模是「一次 edit 调用改了多少文件」（`perFileResults` 每项对应一次真实的文件修改）。本刀不另设候选数上限（那会改变规格里「派生次序前 50」的含义，需要一个数字和一句规格）；「攒够 50 个就停」不可取（破坏先合并后截断）。是否加原始候选数上限或按原始串记忆由 owner 决定，由 #740 跟踪。
2. **`files.changed` 与 `step.end` 之间可能插入别的发布**：两者之间有一个 `await this.#publish(...)`，审批结算等另一路发布理论上可以落在中间。「紧先于」对 pump 自己的事件流成立；这是既有的发布结构，不是本刀引入的。
3. **判定的是路径，不是文件类型或身份**：目录路径会被当作变更保留（工具不会报告目录）；macOS 上大小写或 NFC/NFD 写法不同的同一文件不合并（realpath 不规范化大小写）；硬链接到空间外文件的空间内条目会被保留（固有限制）。
4. **判定与实际写入之间有时间窗**：归属按事件到达时的文件系统状态判定；之后空间内的文件被换成指向空间外的符号链接，已保存的相对路径不会被重新判定。预览接口在解析路径的那一刻逐分量拒绝符号链接（`core/sandbox/resolve`），已保存的相对路径本身不带来新的可达性——预览本来就接受用户给的任意相对路径。预览在「检查」与「按路径打开」之间有自己的时间窗（既有代码，`server/src/workspaces/rest.ts` 与 `preview.ts`，不在本刀范围，由 #739 跟踪）。
5. **只覆盖 POSIX**：路径分隔符按 `/` 处理（服务端不在 Windows 上运行）。
6. **集成测试只走绝对路径分支**：fake 的 `edit-write` 发的是绝对路径；相对路径、`perFileResults`、合并与上限只有单元层证据（O2、O3、O5）。真 omp 的 `edit` `details.path` 是相对、绝对还是原始参数没有核对；真 omp 链路（ui-walk 的 `WORKBUDDY_WRITE`）归 8.2a。
7. **`..` 按词法折叠**：`link/../x.md` 记为 `x.md`。若工具把原串直接交给系统调用（内核先跟随 `link`），实际触及的是别处的文件，卡片却指向空间内的同名路径。不泄露路径或内容（卡片只带空间内相对路径，预览按该相对路径在空间内读取）；与 Node 工具链的 `path.resolve` 惯例一致。符号链接**目标**里的 `..` 同理：JS `realpathSync` 按词法折叠链接目标，空间内 `a -> d/../sub` 下的 `a/x.md` 记为 `sub/x.md`，而内核实际到达的是 `deep/sub/x.md`——标签可能指向空间内的另一个位置，但仍在空间内（返回串的每个分量都经 `lstat` 确认不是链接）。
8. **权限类失败（EACCES）没有用例**：需要可控的目录权限；它走「`lstat` 抛错 → 丢弃」分支，该分支由 ENOTDIR（`notes.md/x.md`）与 NUL 的用例覆盖。
9. **1024 字节边界在 macOS 的真实目录上没有证据**：macOS 的 `PATH_MAX` 限制了可构造的路径长度，边界值由不碰文件系统的 `ownedPath` 取证（O6）；经 `ownedChanges` 的真实目录用例只在 Linux（CI）上运行。
10. **首次出现的元素原样带计数**：首项若是 `kind:"edit"` 且计数为 `null`、之后没有同路径候选，产出就是 `edit` + `null`，过不了 web 的严格解析。归约器（`file-changes.ts`）给 `edit` 的计数恒为非负整数，生产里不会出现；本模块不重复校验上游的元素形状。
11. **根不要求是目录**：普通文件当根时它是自己的 realpath，通过规范性检查；其下的候选由 `lstat` 的 ENOTDIR 丢弃，结果仍是 `[]`（O10）。
12. **存在性预言机（1 bit）**：空间内的符号链接 `p -> <空间外>/<probe>/../../<ws>/x.md`，`<probe>` 存在且 server uid 可穿越时产出 `x.md`，否则 `[]`。这是「跟随符号链接穿越空间外分量再折回空间内」的固有性质（换 `.native` 也一样）；利用它需要行为失常的 omp 加上能看到卡片的用户，得到的只是「某个空间外路径是否存在」。
13. **保存的相对路径可以含反斜杠、控制字符、孤立代理项**：它们是合法的 POSIX 文件名，经 JSON 转义原样保存；不可能含 `..` 分量、前导 `/`、NUL，也不可能为空。预览端自己拒绝 NUL、前导 `/`、`..` 与符号链接分量。
14. **入参按 `FileChange` 对象数组对待**：数组里若有非对象元素（`null`、`undefined`）会在取 `file.path` 时抛错；归约器只产出新建的普通对象，生产里到不了。

## Seams under test
- 真实临时目录 + 真实 `realpathSync`/`lstatSync`：O 系列不 mock 文件系统。
- store 的记录替身（P1–P4，同 `session-persist-new-events.test.ts` 的 Proxy 写法）与真实 SQLite（P5、F 系列）；P 文件另对 `node:fs` 做只记录、不改行为的透传。
- 真实 fake-omp 子进程经 `spawnImpl` 注入点启动；`options.cwd` 替换用来把子进程放到空间根外。fake 不是真 omp：帧形状以 omp-test-harness 规格为准。
- TEMP TRIGGER 注入的是「UPDATE 被数据库拒绝」这一种失败。
