# Delta: turn-artifacts（file-changes-card，#535）

## ADDED Requirements

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `会话页` 的助手块次序。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击以客户端导航前往 `/files?ws=<workspaceId>`（files-web 当前以 `?ws=` 表示空间，无文件预选参数；定位到该文件需 files-web 另行扩展，不在本 change）。会话 `workspaceId` 为 `null`、不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径，不渲染 `查看详情`。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内出现名为 `文件变更（2 个）` 的卡片，第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后 URL 为 `/files?ws=<该空间 id>`；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间，或空间列表读取中或读取失败
- **THEN** 卡片行只显示相对路径，无 `查看详情` 按钮
