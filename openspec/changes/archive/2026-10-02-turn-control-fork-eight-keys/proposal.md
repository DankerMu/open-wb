# Proposal: turn-control-fork-eight-keys（#543，父 change `s1c-session-metadata-presentation` tasks 9.2）

## Why
主规格 turn-control「从此处分叉 REST」仍写 fork 的 201 响应里 `session` 是五键 `{id,title,status,createdAt,updatedAt}`、新会话行不带空间与场景。实现早已是八键并继承 `workspace_id` / `scene`、`pinned_at` 为 NULL（#527，session-metadata「fork 继承会话元数据」与 chat-sessions「会话 REST」已写明并有测试）；同一事实在 turn-control 里还是旧文。

## What Changes
- 规格：turn-control MODIFIED「从此处分叉 REST」——新会话行的继承规则、八键响应、两个逐字取自 session-metadata 的 Scenario。
- 父 change 新建 `specs/turn-control/spec.md`：MODIFIED「重新生成 REST」「从此处分叉 REST」，文本与归档后的主规格逐字一致（父 tasks 9.2 的交付物）。
- 无代码、无测试改动。

## Non-goals
- 「重新生成 REST」的主规格文本不改：分支对位、白名单命令 → 400 已由 #555 的归档写入主规格；fork 的分支对位与 `draft` 为所存正文同理。
- session-metadata、chat-sessions 的文本（本 delta 的对照源）不改。

## 与 issue 的偏差
1. **主规格在本 PR 内更新**：issue 的 PR 边界写「仅新建父 change 的 `specs/turn-control/spec.md` 一个文件，`openspec/specs/**` 零 diff」，即把八键留到父 change 归档时才进主规格。本仓 S1c-B 的做法是每个子 issue 用自己的 change 归档进主规格、父 delta 在父归档前统一 re-sync；照此，本 issue 用子 change 把「从此处分叉 REST」改对并在同一 PR 归档，父 delta 文件按归档后的主规格现文生成（已是同步状态）。纯规格改动，没有先合代码再归档的次序问题，所以实施与归档合成一个 PR。
2. **issue 列的「组 10 追加」已在主规格里**：两条 Requirement 的选条目规则（Branch alignment）、锚点为白名单命令 → 400、fork `draft` 为所存正文，都由 #555（change `slash-escape-branch-align`）归档写入。父 delta 文件原样重述它们，子 delta 不再改。
3. **被拷贝消息的 `thinking` 与步骤的 `changes`** 的拷贝规则仍只写在 session-metadata「fork 继承会话元数据」里；本 delta 只做父 tasks 9.2 点名的两处（八键、继承规则），新增的第一个 Scenario 里带有这一事实。
4. **逐字对照源是主规格 session-metadata，不是父 change 的 session-metadata delta**：issue 指定父 `specs/session-metadata/spec.md` 为对照源，但那份 delta 的「fork 继承会话元数据」是 #527 归档前的旧文（第一个 Scenario 少「（NULL 仍为 null）」，第二个多一句 web 严格解析；正文还写「预先插入的新会话行」，与实现的事务内插入相反）。本 delta 取主规格 session-metadata 的现文；父的那份 delta 在父归档前随整体 re-sync 修正，本 PR 不改。

## Impact
- 主规格：turn-control 一条 Requirement。父 change：新增一个 delta 文件，勾 tasks 9.1（#542，PR #752 已合入）与 9.2。
