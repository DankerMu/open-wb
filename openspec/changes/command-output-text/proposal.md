# Proposal: command-output-text（#554）

## Why
父 change `s1c-session-metadata-presentation` tasks 10.3（epic #509，design D15「命令回复归约」）。omp 内建 slash 命令（`/todo`、`/compact`）的回复经无 `id` 的 `command_output{text}` 帧给出，没有 `agent_start`/`agent_end`。master 上 `applyFrame`（`events.ts:95-117`）对该帧走 default 过滤，命令回合只有 pump 末尾的 `turn.end done`，助手正文为空。10.1（#552 fake `slash`）与 10.2（#553 runtime 本地完成等待）已落；本刀把 `command_output` 归约为 `turn.start`（首次）+ `text.delta`，使命令回复成为助手正文。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 纯协议归约器的公共事件序列（SSE 契约上游）：新增「无 `agent_start` 的 `turn.start`」来源；助手正文落库（既有 `appendDelta`）；本地完成回合的 `turn.end` 次序。supervisor 不改。
Selected risk packs: Public API / CLI / script entry（事件序列与助手正文）；Concurrency / shared state / ordering（`turn.start` 补发一次、后到 `agent_start` 不重置、输出晚于回执仍先于 `turn.end`、等待期 stop）；Error handling / rollback / partial outputs（畸形帧过滤、终态后无事件、静默压缩正文为空不伪造）；Legacy compatibility / examples（既有 chat-stream Scenario 与 `session-events.test.ts` 零 diff）
Evidence floor: 新建 `server/test/session-events-command.test.ts` 与 `server/test/supervisor-command-output.test.ts` 覆盖 design「Required evidence」；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/events.ts`：`applyFrame` 增 `case "command_output"`；`EventState`/`createEventState`/`evolve` 增布尔 `commandOutputSeen`（不存正文）。
- 两个新测试文件。`supervisor.ts`、runtime、store 不改。

## Capabilities
- MODIFIED `chat-stream`「纯协议事件归约」：main 原文 + `command_output` 归约句（及「Only text_delta … — and `command_output` frames …」措辞）+ Scenario「Command output becomes assistant text」。父 delta 中该 Requirement 的其它漂移（thinking/files 过渡句位置、edit/write 句位置）不并入，以 main 为准。
- MODIFIED `chat-sessions`「Supervisor ordered persistence and publication」：main 原文 + 本地完成句（输出经普通路径先于 `turn.end` 落库发布、无输出正文为空、runtime 独自决定完成、等待期 stop 走 stop 例外）+ Scenario「Local command output becomes the assistant body」。与父 delta 该 Requirement 逐字一致（reqdiff 仅此两处差异）。

## 与 issue 的出入
- issue 行号基于旧 master（`events.ts:63-85`、`supervisor.ts:380-395`）；现为 `events.ts:95-117`（`applyFrame`）、`:65-73`（`EventState`）、`supervisor.ts` pump 末尾 `turn.end done`（`:611-622`）。
- 10.4b（#555，`toWireText` 转义）未落：REST prompt 在 `trim()` 后原样把 `/todo`、`/compact` 交给 runtime，fake `slash` 精确匹配这两条，集成用例可直接经 `POST …/prompt` 驱动。

## Impact
- server：`events.ts` + 两个新测试文件；`session-events.test.ts` 零 diff。
- web：无改动。`turn.start` → `text.delta` → `turn.end` 的事件形状与普通回合相同；web 归约不区分 `turn.start` 的来源。
- 依赖：#552、#553、#514、A #455/#453/#487/#490 均已合并。

## Non-goals
- runtime 等待规则（10.2）；白名单与转义（10.4a/10.4b）；stop 路径本身（A #490）；web 候选面板（10.5）；smoke/ui-walk（10.6）。
