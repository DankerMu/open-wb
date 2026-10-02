# Proposal: harness-slash-whitelist（#557，父 change `s1c-session-metadata-presentation` tasks 10.6）

## Why
Slash 白名单（`GET /api/commands`、`/todo` 经真 omp 的本地命令回复、白名单外 `/…` 文本被转义后送模型）与 composer 的候选面板都已合入，但只有 fake-omp 与 jsdom 的证据。真 omp v18.0.10 下「`/todo` 的回复原文」「`/session …` 没有被 omp 当命令执行」没有端到端证据；`make smoke` 与 `make ui-walk` 都不碰 `/` 开头的输入。

## What Changes
- `smoke/session-meta.hurl`：在 thinking 断言之后、DELETE 之前插入第 6 步（`GET /api/commands` → `/todo` → `/session WORKBUDDY_THINK 冒烟`），原第 6、7 步顺延为 7、8；页头注释同步。
- `web/e2e/ui-walk-sessions.spec.ts`：在第 9 步（搜索）与第 11 步（删除）之间加第 10 步（候选面板 → 键盘选中 `/todo` → 发送 → `/session WORKBUDDY_THINK <uuid2>` → REST 回读）。
- 规格：chat-harness MODIFIED「会话元数据 HTTP 冒烟」「UI 走查会话元数据」。

## Non-goals
- Makefile、`scripts/test-ci-harness.sh`、`AGENTS.md`、`web/playwright.config.ts`、`ui-walk.spec.ts`、其它 hurl 文件、`web/src`、`server`：零 diff。
- skills 的冒烟（两个状态目录都不装 skill）；`/compact` 的真实运行（会真的压缩上下文，回复不确定）；fake-omp。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **`finally` 不改**：issue 与父 tasks 10.6 写「`finally` 触发条件改为第 11 步前失败」并带 409 → stop → 轮询 → DELETE 兜底。主规格现文（#540 / #541 合入）是无条件 `finally`、DELETE 接受 204 或 404、409 判失败（running 删除已合入，服务端先停后删）。本 change 不动清理段。
2. **冒烟第 7、8 步取主规格现文**：父 delta 的对应段落比主规格少 `detail.sessionId` 与 `lisi` 会话数前后对比等断言；子 delta 只改编号。
3. **走查第 10 步加 REST 回读**：经页面请求上下文读 `GET /api/sessions/<id>/messages`，断言 `/todo` 的助手消息 `content` 恰为 omp 原文且 `steps` 为空、`/session …` 的用户消息 `content` 恰为所输入的文本。理由：`toHaveText` 会归一空白，前导空格只有 REST 能看见；「回复来自服务端而非前端文本」只有 REST 回读有判别力。父文没写。
4. **走查第 10 步写明两处次序**：(a) 按 `Enter` 选中之前先断言面板里恰一项 `任务清单`——目录是懒加载的，面板没出来时 `Enter` 会把 `/t` 当普通消息发出去；(b)「`/session …` 没有候选」先对不含空白的 `/session` 断言（此时仍是候选态、目录已加载，零匹配才有判别力），再输入完整文本——含空白的草稿本来就不开面板。
5. **冒烟第 6 步多三条父文没写的断言**：两次 POST 捕获 `userMessageId` 用于按 id 定位用户消息；`/todo` 完成后 `session.title` 仍为 `冒烟会话`；`/session …` 回合 `approvals` 为空（父文只在括号里说「no approval is pending」）。规格句子按父文，不为它们加句子。
6. **`/session …` 回合没有 `write` 步骤，标记换成 `WORKBUDDY_THINK`**：issue 与父文要求提示词 `/session WORKBUDDY_WRITE …` 与「恰一个 done 的 `write` 步骤」。受控上游只在请求历史里没有任何工具结果时才发工具轮；两条 harness 序列里该会话此前都已跑过工具轮（冒烟第 4 步的 bash、走查第 3 步的 write），所以这一回合没有工具轮、`steps` 为空（真实栈按 harness 次序实测；`chat.hurl` 的第二条 prompt 是同款先例）。固定回复与输入无关，单靠它证明不了「转义后的文本到了模型」；受控上游对 `WORKBUDDY_THINK` 的应答不依赖工具历史、只看最新一条用户消息，所以提示词改为 `/session WORKBUDDY_THINK 冒烟`、`/session WORKBUDDY_THINK <uuid2>`，断言该回合的 `thinking` 恰为 `先读需求，再列要点，最后作答。`（实测：不带标记的 `/session …` 与 `/todo WORKBUDDY_THINK …` 的 `thinking` 都是 null）。另断言 `steps` 为空、`approvals` 为空。
7. **未转义的 `/session` 会怎样没有真实栈证据**：平台 API 之下所有白名单外文本都被转义，够不到 omp 的命令分支。对照用「把第二条提示词换成白名单内的 `/todo WORKBUDDY_THINK 冒烟`」（omp 当命令执行，答 `Unknown /todo subcommand. …`，无副作用）证明断言分得清「被当命令执行」与「被模型回答」。
8. **没有 RED 阶段**：产品行为都已在 master；证据是负对照。
9. **顺带修 #541 留下的 mobile 竞态**（本 PR 的 CI 第一次跑就撞上）：`step7Pin` 用 `Escape` 收起行菜单后，`inspectSidebar` 紧接着按第二个 `Escape` 关导航覆盖层。Radix 在菜单卸载后经 `setTimeout(0)` 才把焦点还给触发按钮；按键落在这之前时目标是 `body`，Toast 层在栈顶、覆盖层的兜底又要求目标在覆盖层内，于是没有任何一层关闭。修法：第 7、8、11 步在交还给 `inspectSidebar` 之前断言焦点已在导航覆盖层内（`mobile-dark`）。只动 `web/e2e/ui-walk-sessions.spec.ts`，不改产品、不改 `ui-walk-layout.ts`。

## Impact
- `make smoke` 每次运行多两个回合（本地实测 `/todo` 约 0.1–0.6 s、转义文本约 0.1 s）；`make ui-walk` 每条新旅程多两个回合。两者都不写文件。
- 主规格：chat-harness 两条 Requirement。
