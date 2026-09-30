# Design: file-change-candidates（#515）

父设计：D6「决定（候选提取，纯归约）」、Context「omp 事实」。行号为 origin/master（本分支基于合并 #695 后的 master）。

- **Change surface**：新建 `server/src/sessions/file-changes.ts`；`server/src/sessions/events.ts`（`FileChange` 类型 :7-13、`applyToolEnd` :201-226）；新建 `server/test/file-changes.test.ts`、`server/test/session-events-files.test.ts`。
- **omp 事实（vendored v18.0.10，`resource/oh-my-pi/packages/coding-agent/src/`）**：`edit/renderer.ts:58-97` `EditToolDetails`（`diff`、`path`、可选 `perFileResults[{path, diff, …}]`）；`edit/diff.ts:54-56` 编号 diff 行 `+N|text`/`-N|text`/` N|text`；`tools/write.ts:314-324` `WriteToolDetails.resolvedPath`；`tools/ast-edit.ts:153-175` `AstEditToolDetails` 无 `diff`/`path`/`perFileResults`。实现前核对这些行号与形状，若不符在 PR 记录。
- **Must preserve**：
  - `step.end{messageId, stepId, status, output}` 逐字不变；`status` 仍只看帧级 `isError`；`normalizeOutput`（:358-379）仍丢弃 `details`。
  - 未知调用、重复结束、未 started 状态、缺 toolCallId 的结束帧：仍无任何事件（:202-211 的早退不变，`files.changed` 只在已知 running 调用分支产生）。
  - 归约器纯度：无 IO、无时钟；返回事件不别名 state；state 不新增字段（候选不进 state）。
  - supervisor `persistEvent`（`turn-control.ts:268-274`）对 `files.changed` 返回 `undefined`——不落库、不发布、不占 ring 序号；`session-persist-new-events.test.ts` 全绿。
  - `session-events.test.ts`、`session-events-output.test.ts` 与全部 chat-stream/supervisor 测试零改动全绿。
- **Must add/change**：
  - `file-changes.ts` 导出：
    - `countDiffLines(diff: string): {added: number; removed: number}`——`diff.split("\n")`，逐行 `/^\+\d+\|/`、`/^-\d+\|/` 计数（CRLF 的 `\r` 留在行尾，不影响行首匹配）。
    - `fileChangeCandidates(toolName: string, result: unknown): FileChange[]`——`result` 须为普通对象（非 null、非数组）且自有属性 `isError !== true`；`details` 为 `result` 的自有属性且为普通对象；`edit`：自有 `perFileResults` 为非空数组 → 逐项（元素须为普通对象，自有 `path` 非空字符串、自有 `diff` 字符串）；否则自有 `path`+`diff`；`write`：自有 `resolvedPath` 非空字符串；其它工具名 → `[]`。所有键（含 `perFileResults` 元素的 `path`/`diff`）经 `Object.hasOwn` 读取，不经原型链——注意 `normalizeOutput` 只对 `content` 用了 `hasOwn`（`events.ts:366`），其对块的 `type`/`text` 读取（:371-372）是普通属性访问，不是本模块的先例。
  - `events.ts` `applyToolEnd`：工具名取 `findRunning` 返回的 `ToolEntry.name`（不取结束帧 `toolName`）；仅当帧 `isError !== true` 时调用 `fileChangeCandidates(entry.name, frame.result)`；非空 → 返回 `events: [files.changed, step.end]`，否则 `[step.end]`。`files` 数组为新建值，不别名 `result.details` 中的对象。
  - `FileChange` 类型：从 `events.ts` 导出或移入 `file-changes.ts` 再由 `events.ts` 引用（knip 零新增，不留未用导出）。
- **Sibling surfaces**：supervisor 消费 `applyFrame` 的事件数组逐个 `persistEvent`（`turn-control.ts`），`files.changed` 被丢弃后紧随的 `step.end` 照常落库发布；3.4 将替换该分支；web 7.5a 消费 3.4 发布的事件。
- **残余**：
  - 3.4 前 `files.changed` 在 supervisor 处被丢弃，端到端不可见——这是 #514 声明的过渡态。
  - 覆盖边界（父 spec 规则的直接后果，本刀不改）：omp 多文件 edit 中途失败时整体结果带 `isError:true`（`edit/index.ts:252-257`、`edit/hashline/execute.ts:248-292`），已落盘的前序文件不会出现在变更卡上；rename（`move`/`sourcePath`）只报新路径。
- **Required evidence**（RED：证据 1–3、证据 4 中「以 `edit` 登记、结束帧 `toolName:"bash"` → 有 `files.changed`」一例、证据 5 的不别名一半在实现前红（模块不存在 / 无 `files.changed`）；证据 4 其余负例、证据 5 的同输入等值与证据 6 为 characterization；以实际运行记录）：
  1. `file-changes.test.ts` diff 计数：`"+3|a\n+4|b\n-3|x\n 2|ctx"` → 2/1；上下文行 ` N|` 不计；无编号 `+x`/`-x`、`++1|`、`+|x` 不计；CRLF `"+1|a\r\n-2|b\r\n"` → 1/1；空串 → 0/0。
  2. `file-changes.test.ts` 候选提取：`edit` 顶层 `path`+`diff` 一项；`perFileResults` 非空时优先（顶层被忽略），其中空 `path`、非字符串 `diff`、非对象元素跳过，按出现次序；`perFileResults` 为空数组 → 回落顶层；`write` `resolvedPath` → `{kind:"write",added:null,removed:null}`；`write` 缺 `resolvedPath` 或为空串 → `[]`；`result.isError===true` → `[]`；`details` 为数组 / 字符串 / null / 缺失 → `[]`；`path`/`diff`/`perFileResults`/`resolvedPath`/`details`/`isError` 只在原型上（`Object.create({...})`）→ 不读（原型上的 `isError:true` 不阻止、原型上的 `details` 不产出）；`perFileResults` 元素为 `Object.create({path:"p.md",diff:"+1|x"})` → 该项跳过；`perFileResults` 只在 `details` 原型上、顶层自有 `path`+`diff` → 恰一个顶层候选；`ast_edit`（带 `details.path`+`diff`）、`read`（带 `resolvedPath`）、`bash`、`memory_edit` → `[]`。
  3. `session-events-files.test.ts` 次序与形状（「Edit and write details yield raw candidates」「归约器候选提取」）：经 `createEventState` + `applyFrame`（agent_start → tool start → tool end）：`edit` 结束的返回 `events` 恰为 `[files.changed{messageId, stepId:<toolCallId>, files:[{path:"/ws/src/app.ts",added:2,removed:1,kind:"edit"}]}, step.end{…}]`；`write` 同理；`perFileResults` 三项/跳过项的场景按 Scenario；每个 `step.end` output 不含 details 中任何字符串。
  4. `session-events-files.test.ts` 无事件（「失败、非 edit/write 与原型键（归约器侧）」）：帧 `isError:true` 的 edit、`result.isError:true` 的 edit、`bash`、`read`、以 `ast_edit` 登记的调用、`details` 为数组 → 返回 `events` 恰为 `[step.end]`；以 `bash` 登记但结束帧 `toolName:"edit"` 且带 edit details → 无 `files.changed`（登记名为准）；以 `edit` 登记、结束帧 `toolName:"bash"` → 有 `files.changed`；未知 toolCallId 与重复结束 → `events` 为 `[]`。
  5. 纯度：两次 `applyFrame` 同输入产出等值事件；修改返回的 `files` 数组/元素不影响后续输出，且不改变传入的 `details` 对象（反之亦然）。
  6. 既有：`session-events.test.ts`、`session-events-output.test.ts`、`session-persist-new-events.test.ts` 全绿零改动。
  7. 门禁：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；PR 记录 `events.ts` 前后行数。
