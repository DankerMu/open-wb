# Design: slash-escape-branch-align（#555）

父设计：D15「分类与转义」「与 A 的 regenerate/fork 对齐（分支对位）」。行号为 origin/master（eb1d4a0）。

- **Change surface**：`server/src/sessions/rest.ts:188-204`（prompt 路由；408 行）；`server/src/sessions/branching.ts`（373 行：`Regenerations.#precheck` :66-85、`#lastEntry` :94-113、`Forks.#precheck` :218-249、`#branch` :292-309、`#commit` :312-334、`entryAt` :363-367、`RegeneratePorts`/`ForkPorts`/`ForkPlan`）；`server/src/sessions/supervisor.ts`（795 行：`SessionSupervisorOptions` :77-97、两组端口装配 :164-195）；`server/src/sessions/index.ts:61-69`；新建 `server/test/session-rest-slash.test.ts`、`server/test/turn-control-slash.test.ts`。
- **omp 事实（vendored v18.0.10，主 checkout `resource/oh-my-pi/packages/coding-agent/src/`；实现前核对）**：user 正文保留前导空格（`session/agent-session.ts:5802`）；skill 调用存为 `role:"custom"`（`:5924-5925`）；`getUserMessagesForBranching` 只收 user（`:9276-9282`）——所以白名单命令与 skill 回合在分支列表里没有条目，转义文本的条目带一个前导空格。
- **Governing invariant**：白名单是 `/` 文本的唯一判定；持久化永远是 trim 原文，转义只存在于 wire 侧；regenerate/fork 的选条目只依赖「存储文本 × 条目文本」（wire 候选），不依赖当前 skill 集合；命令锚点在任何 spawn/帧/行变更之前被 400 拒绝。
- **Must preserve**：
  - prompt 路由：`controlHeld` 检查与 `acceptPrompt` 同一同步段、其间无 await（`listSkills` 是同步的，可在该段内或之前求值）；持久化 user 正文、标题规则（18 码点前缀取原文）、`rollbackPrompt` 补偿、202 形状不变；不以 `/` 开头的文本 wire 与原文逐字相同。
  - regenerate/fork：409/400/404/502/503 既有次序与各自的「无行变更 / 无新会话行 / 无 `branch` 帧 / 占用已释放」；CAS 事务、临时进程生命周期、`dispatch` 仍用 `branch` 返回的文本；`branchTo` 对 `text` 为字符串的校验不放松。
  - A 的既有测试文件零 diff 全绿：`session-regenerate*.test.ts`、`session-fork*.test.ts`、`session-fork-metadata.test.ts`、`session-rest.test.ts`（786 行，不增长）及其 helpers（helpers 如需新旋钮，另写在新测试文件内，不改既有 helper 的导出语义）。
  - `supervisor.ts`、`branching.ts`、`rest.ts` ≤ 800 行（`supervisor.ts` 现 795：接线只加选项字段与两处端口行；超限即把端口类型注释留在 `branching.ts`）。
- **Must add/change**：
  - `rest.ts` prompt 路由：`await dependencies.supervisor.prompt(request.params.id, toWireText(text, listSkills(dependencies.agentDir)))`；`acceptPrompt(…, text)` 不变。文本不以 `/` 开头时**不求值** `listSkills`（wire 即原文；该目录对 omp uid 可写（#706），不把同步扫描放进每条普通 prompt 的热路径）。
  - `branching.ts`：
    - wire 候选：`matches(entryText, content)` ≡ `entryText === content || (content.startsWith("/") && entryText === " " + content)`。
    - `Regenerations.#precheck`：在既有 409 之后，把「末条 user 的 `classifyPrompt(content, skills())` 为 `builtin|skill`」并入既有 400 条件。`#lastEntry`：末条条目 `entryId` 为字符串且 `matches(text, question)`，否则 502（不读更早条目）。
    - `Forks.#precheck`：既有次序 404 → 400（非本会话 user）→ 409 之后，新增「所选消息 `classifyPrompt` 为 `builtin|skill`」→ 400，位于 `ompSessionFile === null` 的 502 之前。`ForkPlan` 以存储 user 列表（`{id, content}`，id 序）取代 `ordinal`。
    - `#branch`：`alignBranchEntries(users, entries)` 自前向后首次匹配（`users[i]` 与当前 `entries[j]` `matches` → 记 `userId → entryId`、i++、j++；否则 i++）；条目的 `entryId`/`text` 非字符串或列表非数组 → 不匹配任何消息；所选 `messageId` 无对位 → 502。
    - `#commit`：`draft: plan.text`（所存正文）。
    - 端口：`RegeneratePorts`/`ForkPorts` 各加 `skills(): readonly { name: string }[]`（不缓存；只在被判定的正文以 `/` 开头时调用）。
  - `supervisor.ts`：`SessionSupervisorOptions.skills: () => readonly { name: string }[]`（必填），原样交给两组端口。`index.ts`：`skills: () => listSkills(options.agentDir)`。supervisor 不碰文件系统。
- **Sibling surfaces**：10.5 web 候选面板（fork `draft` 回填 composer，永不带转义空格）；10.6 smoke（真 omp `/session WORKBUDDY_WRITE …` 证明转义）；`chat-harness` 既有 fork 场景 `draft` 等于 `你好`（非 `/` 文本，不受影响）；#543（turn-control 父 delta 重述，以本刀归档后的 main 为基线）；#704（`/todo import|export`）。
- **残余**：regenerate 仍派发 `branch` 返回的文本，所以 B 前原样存入的 `/xxx` 条目会不经转义重发——这类条目多数是当时 omp 没把它当命令消费的普通文本；例外是 B 前经 `/force:<tool> <prompt>` 透传留下的裸 `/builtin …` 条目（omp `slash-commands/builtin-control.ts:18-29`、`modes/rpc/rpc-mode.ts:1041-1051`），若其后一条存储消息恰为同文则 regenerate 会把它再执行一次（仅 B 前历史可达、每会话至多一次；#709 review P3，另立 issue 在派发前补前导空格）；Governing invariant「转义只在 wire 侧」对 B 前历史不追溯；首次匹配下，被跳过的消息若与后一条目文本恰好相同会错配（父 design 已记）；omp 分支列表里出现没有对应存储消息的条目（如 omp 已记录而宿主回滚的 prompt）时，其后的 fork 全部 502、regenerate 只受末对影响；命令锚点 400 用**当前** skill 集合判定——当时未安装（已转义发出、有条目）而后安装的 `/skill:x …` 会被 400 拒绝，当时已安装而后卸载的则走对位得 502；以 `/` 开头的 prompt，以及锚点正文以 `/` 开头的 regenerate/fork 前检，各同步调用一次 `listSkills`（222 个 skill 约 6 ms）；`toWireText` 不是 skill 维度的安全边界（见 proposal）。
- **Required evidence**（RED 集合：证据 1、3、4、5、7、8、9、11、14 在实现前红——四条转义输入收到原文；命令锚点得到 502/201 而非 400；wire 形条目按旧的严格相等得到 502；`/todo` 之后的 `继续` 按旧序号规则错位 502；畸形条目在前时旧规则 201；证据 3 红在正向对照（旧路由从不枚举 skills），其负向部分实现前已绿。证据 2、6、10、12、13 是 characterization（旧代码已是该结果；13 只区分父文的 `toWireText(U, skills)` 公式，不区分旧代码）。以实际运行记录）：
  - `session-rest-slash.test.ts`（经 `createApp`，`weekly-report/SKILL.md` 写进 `<stateDir>/agent/skills`；wire 文本取自送达 supervisor 的参数——对 `app.sessions.supervisor.prompt` 的 spy，或记录型子进程收到的 `prompt` 帧，二者择一并在 PR 说明）：
    1. 七条输入 `/todo`、`/todo append 买菜`、`/skill:weekly-report 写周报`、`  /session delete`、`/TODO`、`/skill:nope`、`/etc/hosts 是什么` 各在 idle 会话上 202；持久化 user 正文恰为 trim 原文（`/session delete` 无前导空格）；送达 supervisor 的文本前三条原样，其余四条恰为 `" " + trim 原文`。
    2. 新会话标题为原文的 18 码点前缀（取一条超过 18 码点的 `/` 文本）。
    3. 不以 `/` 开头的文本（含正文中间的 `/skill:weekly-report`）wire 与原文逐字相同，且该请求不枚举 `<agentDir>/skills`（`vi.spyOn(fs, "readdirSync")` + `syncBuiltinESMExports()`，先例 `workspace-preview.test.ts:25-32`、`session-tokens.test.ts:58,86`；按路径过滤断言）；正向对照：同一用例再发一条 `/` 开头的 prompt，spy 必须看到 `<agentDir>/skills`（否则负断言空转）。
    4. 不缓存：同一 app 先发 `/skill:late x` 得到转义形，装入 `late` 后再发同文得到原样。
  - `turn-control-slash.test.ts`（真实 fake `branch`，`--branch-entry` 经既有 `openForkWorld({entries})` 或同等旋钮；断言方式沿用 A 的 helpers：`rowCounts`/`snapshot`/`held`/spawn 计数/stdin 帧类型）：
    5. regenerate，末条 user `/todo` → 400 `bad_request`；无 spawn、无帧、行快照不变、响应后无占用。另：末条 user `/skill:weekly-report 写周报`，skill 已装 → 400；未装 → 502（末对不匹配）——证明 `Regenerations` 端口读的是注入的 skill 名单（`supervisor.ts` 两组端口各自接线）。
    6. `running` 会话且末条 user 为 `/todo`：regenerate → 409；在该 `/todo` 消息处 fork → 409（忙检查先于命令检查；fork 既有的「非本会话 user」400 在 409 之前，命令 400 必须落在 409 之后）。
    7. regenerate，存储 `/todo`,`/help 这是什么` + `--branch-entry " /help 这是什么"` → 202；`branch` 帧的 `entryId` 是追加条目；随后 `prompt` 帧的 `message` 恰为 ` /help 这是什么`；存储的 user 正文仍为 `/help 这是什么`。
    8. fork，锚点 `/skill:weekly-report 写周报`（skill 已装）→ 400，同 5 的四项「无」且无新会话行；同一消息在 skill 未安装的世界里不是 400（走对位，得 502）——证明判定读的是注入的 skill 名单。
    9. fork，存储 `first question`,`second question`,`/todo`,`继续` + `--branch-entry "继续"`，在 `继续` 处 → 201，`draft` 恰为 `继续`，`branch` 帧 `entryId` 为追加条目；该次 fork 不枚举 `<agentDir>/skills`（同证据 3 的 spy：锚点正文不以 `/` 开头，前检不调用 `skills()`）。
    10. fork，存储 `first question`,`second question`,`/legacy` + `--branch-entry "/legacy"` → 201，`draft` `/legacy`（原文兜底）。
    11. fork，存储 `first question`,`second question`,`/help 这是什么` + `--branch-entry " /help 这是什么"` → 201，`draft` 恰为 `/help 这是什么`（无前导空格）。
    12. fork，存储 `first question`,`second question`,`今天 /skill:weekly-report 帮我`（无追加条目）→ 502，无 `branch` 帧、无新会话行、临时进程已退出。
    13. skill 集合漂移不移动对位：存储 `first question`,`second question`,`/skill:weekly-report 写周报`,`继续`，条目为固定两条 + ` /skill:weekly-report 写周报` + `继续`（当时未安装、已转义发出），此刻 skill 已装，在 `继续` 处 fork → 201（按父文的 `toWireText(U, skills)` 规则此例为 502）。
    14. 畸形条目在前、锚点在后（scripted `messages:[{entryId:"e1",text:5},{entryId:"e2",text:QUESTION}]`，存储 `first question`,`second question`，在 u2 处 fork）→ 502，不抛、无 `branch` 帧（旧序号规则此例 201）。
  - 既有：A 的 regenerate/fork 测试文件与 `session-rest.test.ts` `git diff` 为空且全绿（含 R6(a)(b) 的 502、F1 空列表 502、`draft` 等于 `QUESTION` 的各例）。
  - 门禁：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate slash-escape-branch-align --strict --no-interactive` 通过。
