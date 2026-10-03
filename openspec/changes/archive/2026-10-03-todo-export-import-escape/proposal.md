# Proposal: todo-export-import-escape（#704）

## Why
白名单按命令名放行 `/todo`，参数原样透传。omp v18.0.10 的 `/todo export|import <path>` 用 `resolveToCwd` 解析路径：绝对路径、`~`、`..` 原样生效；`export` 直接写文件、`import` 读文件并把解析错误（含文件原文行）作为回复输出。这条通道不经模型、不产生工具帧、步骤行与 `files.changed`，而自 #554 起命令输出就是助手正文。父设计 D15 写的「相对会话 cwd 读写」只对不含 `..` 的相对路径成立。不是审批绕过（读写范围不超过同 uid 下模型的 `read`/`write` 工具），但它是一条无步骤、无 `files.changed` 的文件副作用通道，且设计事实有误。

## What Changes
- `server/src/sessions/slash-commands.ts` `classifyPrompt`：`/todo` 的子命令为 `import` 或 `export` 时判为 `text`（取词规则与 omp 相同），`toWireText` 因此给它前置一个空格，当普通文本送模型。宿主不解析路径。
- 测试：`server/test/slash-commands.test.ts`、`server/test/session-rest-slash.test.ts`、regenerate/fork 对位用例（`server/test/turn-control-slash.test.ts`）。
- 规格：chat-sessions MODIFIED「Slash 命令白名单与命令目录」——分类规则一句与一个 Scenario。
- 父 change `s1c-session-metadata-presentation/design.md` D15「事实」段更正为如实描述，并写明宿主处置（编排方改）。

## Non-goals
- 不做「宿主校验路径落在 cwd 内」的备选方案（须与 omp 的路径归一化逐项同步，任一不一致即可逃逸）。
- `/todo` 的其它子命令（`append`、`start`、`done`、`drop`、`rm`、`copy`）不变。
- 命令目录 `GET /api/commands` 不变（hint 仍是 `可选：append <任务>`）。
