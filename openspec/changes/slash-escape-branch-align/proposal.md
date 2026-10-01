# Proposal: slash-escape-branch-align（#555）

## Why
父 change `s1c-session-metadata-presentation` tasks 10.4b（epic #509，design D15「分类与转义」「与 A 的 regenerate/fork 对齐（分支对位）」）。10.4a（#551）落了白名单模块但 prompt 路由仍把 trim 原文原样交给 omp：白名单外的 omp 内建（`/session`、`/dirs`、`/dump`…）仍可被调用，且自 10.3（#554）起其输出是可见的助手正文。本刀把转义接到 prompt 路由，同时把 regenerate/fork 的选条目规则改为能容纳「转义条目带前导空格」「白名单命令回合没有条目」的对位——两者是同一不变量的两端，分开合并会让每条 `/xxx` 普通文本 regenerate 502、fork 错位。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: prompt 公共路径（以 `/` 开头的 prompt 多一次同步 `listSkills`）；change A 的 regenerate/fork 状态机（选条目规则、两处前检、fork `draft` 来源）；`SessionSupervisor` 构造选项；主规格 chat-sessions 三条 + turn-control 两条 Requirement。
Selected risk packs: Public API / CLI / script entry（prompt/regenerate/fork 的状态码与 `draft`）；Auth / permissions / secrets（白名单外命令不得原样到达 omp；转义只在 wire 侧）；Concurrency / shared state / ordering（400 在 409 之后、无占用残留、admission 同步段不引入 await）；Error handling / rollback / partial outputs（400/502 无行变更、无新会话行、无 `branch` 帧）；Legacy compatibility / examples（A 的既有 regenerate/fork 用例零 diff、B 前未转义历史按原文对位）；Resource limits / large input / discovery（`listSkills` 进入 prompt 热路径：非 `/` 文本不求值）
Evidence floor: 新建 `server/test/session-rest-slash.test.ts`、`server/test/turn-control-slash.test.ts` 覆盖 design「Required evidence」；A 的既有 regenerate/fork 测试文件零 diff 全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/rest.ts` prompt 路由：`acceptPrompt` 仍收 trim 原文；`supervisor.prompt(id, toWireText(text, listSkills(agentDir)))`。
- `server/src/sessions/branching.ts`（issue 写的 `turn-control.ts` 是旧位置；`Regenerations`/`Forks` 与 `entryAt` 现居此文件）：
  - 两处 `#precheck` 加命令锚点 400（409 之后）。
  - regenerate：末条条目的 `text` 须是末条 user 正文的 wire 候选。
  - fork：自前向后首次匹配对位取代「序号 + 相等」；`draft` 取所存正文。
- `server/src/sessions/supervisor.ts`：构造选项 `skills`（当前平台 skill 名单的读取函数），透传给两组端口；`server/src/sessions/index.ts` 以 `() => listSkills(options.agentDir)` 注入。
- 新建两个测试文件。

## Capabilities
- MODIFIED `chat-sessions`「Slash 命令白名单与命令目录」：main 原文 + Branch alignment 段 + Scenario「Command-anchored regenerate and fork」。
- MODIFIED `chat-sessions`「REST prompt 受理与补偿」：父 delta 原文（与 main 只差本刀的 wire 文本句、32768 场景的限定与 Scenario「Slash text reaches storage as typed and omp as decided」）。
- MODIFIED `chat-sessions`「会话 REST」：main 原文，去掉「尚未应用」过渡语，regenerate/fork 段换成 400 条件、对位与 `draft`。fork 保持 main 的「事务前不存在新会话行」（父 delta 的「预建行」落后于 master）。
- MODIFIED `turn-control`「重新生成 REST」「从此处分叉 REST」：main 原文，只换选条目规则、命令锚点 400、`draft` 来源与对应场景措辞。五键 → 八键等其余漂移不动（#543）。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **regenerate 不做整表对位，只比「末条条目 × 末条 user」这一对。** 父文要求「对位并要求末条 user 对位到最后条目」，但按父文的自前向后首次匹配，A 的既有 regenerate 用例（`seedDone` 只存一条 `second question`，fake 列表为 `first question`,`second question`）与父自己的场景（存储 `/todo`,`/help 这是什么` 对列表 `first question`,`second question`,` /help 这是什么`）都会 502：首条条目没有对应的存储消息，对位永远停在它上面。只比末对与 A 的原规则同形（只多一个 wire 候选），A 用例零 diff。
2. **匹配候选不经 `toWireText(U, skills)`，而是只看文本的 wire 候选：`c` 与（`c` 以 `/` 开头时）` ` + `c`。** 父文一面写「对位只看两份列表、不按当前 skill 集合给历史分类」，一面用 `toWireText(Ui.content, skills)`——后者依赖当前 skill 集合：当时未安装而被转义发出的 `/skill:x …`（条目带前导空格），在 `x` 装上之后 `toWireText` 变成恒等，两种比较都不中，其后全部消息 502。候选集是父规则的超集，且只在父规则因 skill 集合漂移而失效时不同。
3. **fork 对位用例的存储历史须先含 fake 固定列表的两条**（`first question`,`second question`,`/todo`,`继续`），父场景写的「存储 `/todo`,`继续` 对列表 固定两条+`继续`」在首次匹配下是 502（A 的 R6(a) 正是用追加条目钉住「不得跳过条目」）。场景文字已按此改写，并补了转义形 fork 与 502 两例。
4. **代码位置**：`turn-control.ts` → `branching.ts`；`skills` 经 supervisor 构造选项注入（`supervisor.ts` 795 → 约 799 行，上限 800）。
5. **turn-control 主规格在本刀同步**（issue 把它留给 #543）：否则主规格的选条目规则在本刀合并后即失实。#543 届时以更新后的 main 为基线重述，只剩五键 → 八键与继承规则。
7. **非 `/` 文本不求值 `listSkills`**（prompt 路由与两处前检）：design 层的加固（该目录对 omp uid 可写，#706）；spec 的 `toWireText(text, listSkills(agentDir))` 是取值等式，不规定求值次数。
6. issue「400 在占用登记之前」：fork 的 `#precheck` 一直在 `controls.during` 回调内执行（A 的既有形状，未知 `messageId` 的 400 同此）；可观察契约是响应后无占用残留，spec 按此措辞。

## 已知范围外（只报不修）
- `toWireText` 不是 skill 维度的安全边界：omp 的 skill 分发先 `trimStart()`，宿主未列而 omp 认识的 skill（项目级 `.omp/skills`、`enabled: False` 等）转义后仍执行（#551 design 残余）。
- 白名单内 `/todo import|export <path>`：#704。共享 omp agent 目录可写：#706。项目级 `.omp/` 配置可关审批并在 spawn 时执行：#708。

## Impact
- server：`rest.ts` 一行、`branching.ts` 对位与前检、`supervisor.ts`/`index.ts` 接线；两个新测试文件。web 无改动。
- 依赖：#551、#552、#553、#554、#466–#469 均已合并。

## Non-goals
- web 候选面板（10.5）；harness 冒烟（10.6）；omp 侧 skill 发现；被跳过消息与后一条目文本恰好相同的错配（首次匹配的已记录残余）；regenerate 派发文本改用 `toWireText`（仍派发 `branch` 返回的文本）。
