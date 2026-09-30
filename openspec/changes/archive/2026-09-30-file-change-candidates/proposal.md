# Proposal: file-change-candidates（#515）

## Why
父 change `s1c-session-metadata-presentation` tasks 3.2（epic #509，design D6「决定（候选提取，纯归约）」）。3.1（#514）已在 `ChatEvent` 声明 `files.changed` 并让 `persistEvent` 显式丢弃它，但还没有生产者。本刀在纯归约器中从 omp `edit`/`write` 结束帧的 `result.details` 提取原始候选，并在该调用 `step.end` 之前紧邻输出 `files.changed`；归属、相对化、上限与持久化属 3.4。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 纯协议归约器 `applyToolEnd` 的返回事件序列（SSE 公共事件契约的上游）；turn-artifacts 数据的唯一来源（错判会把 bash/失败调用/原型污染的路径带进后续变更卡）。本刀产出的事件在 supervisor 处仍被丢弃，不改变任何已发布事件。
Selected risk packs: Schema / columns / units / field names（候选形状 `{path,added,removed,kind}`、计数规则）；Auth / permissions / secrets（原型键不读、原始绝对路径不上 SSE）；Concurrency / shared state / ordering（`files.changed` 紧邻且先于 `step.end`、未知/重复结束无事件）；Legacy compatibility / examples（`step.end` payload 与 `normalizeOutput` 不变、既有 chat-stream 测试零改动）
Evidence floor: 新建 `server/test/file-changes.test.ts` 与 `server/test/session-events-files.test.ts` 覆盖 design「Required evidence」；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- 新建 `server/src/sessions/file-changes.ts`：纯函数——候选提取（输入：登记的工具名与结束帧 `result`；输出 `FileChange[]`）与 diff 行计数（单独导出可测）。
- `server/src/sessions/events.ts`：`applyToolEnd` 在已知 running 调用、帧 `isError` 不为真时调用提取函数；有候选时在 `step.end` 前紧邻输出 `files.changed{messageId, stepId:<toolCallId>, files}`。`FileChange` 类型供新模块使用（导出或移入新模块）。`normalizeOutput` 与 `step.end` 不变。
- 两个新测试文件。

## Capabilities
- ADDED `turn-artifacts`（新 capability）「文件变更推导与归属」：只含父 delta 该 Requirement 的**归约器候选提取段**与覆盖边界，并如实写明 supervisor 在 3.4 前丢弃该事件；两条归约器侧 Scenario。
- MODIFIED `chat-stream`「纯协议事件归约」：main 原文 + edit/write details 候选句 +「dropped from output」措辞 + Scenario「Edit and write details yield raw candidates」。组 10 的 `command_output` 归约与 Scenario（10.3）不并入。

## 与父 delta 的偏差（父 change 归档前 rebase 适用）
1. 父 turn-artifacts「文件变更推导与归属」是整段（候选提取 + supervisor 归属 7 步 + 持久化次序 + 快照），本子 delta 只 ADD 其候选提取段，并加一句「3.4 前 supervisor 丢弃」的过渡事实（与 main chat-stream 既有句「Until the supervisor slices … land」一致）。3.4 以 MODIFIED 补全并删去过渡句；父 change 该 Requirement 届时应为 MODIFIED（ADDED→MODIFIED 漂移，与 session-metadata 同类）。
2. 父 turn-artifacts 的 Scenario 全是 supervisor 集成层（归属、相对化、`stepId` 为数字、快照 `changes`），由 3.4 证明；本子 delta 改用两条归约器层 Scenario。
3. 工具名判定明确为「`tool_execution_start` 登记的名字」，与 issue Key interfaces 和既有 `wrong-end-name` 用例一致（父 delta 只写 `toolName`）。

## Impact
- server：新 `file-changes.ts`、`events.ts`（`applyToolEnd` + 类型）；两个新测试文件。不触碰 `supervisor.ts`、`turn-control.ts`、`store*.ts`、web；`session-events.test.ts`、`session-events-output.test.ts` 零改动。
- 依赖：#514（3.1）已合并。

## Non-goals
- 路径解析/realpath/空间根归属/相对化/1024 字节与 50 项上限/同路径合并/`chat_steps.changes` 落库与发布（3.4）；thinking（3.3）；web 卡片（7.5a/b）。fake-omp `edit-write` 场景已存在（6.1，`fake-omp.mjs:372`），本刀不用；supervisor 集成证明属 3.4。
