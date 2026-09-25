## ADDED Requirements

### Requirement: 绝对 root 不属于对浏览器保密的信息
按 ADR-0011，`GET /api/workspaces` 与 `POST /api/workspaces` 201 响应中工作空间对象的 `root`（`<SANDBOX_ROOT>/<ownerId>/<dir>` 绝对路径）以及 `workspace.create` 审计事件的 `detail.root` SHALL 保持原样返回给已认证的本人（审计对 admin 全量可见），不删除、不改写；它们不属于保密信息。界面呈现 SHALL 仍以逻辑路径 `<account>/<dir>` 为主，files 页、外壳、标题与 aria 属性不渲染 `root`（files-web）。凭证与他人账号的路径和内容不在本条放宽范围内。

#### Scenario: root 原样返回本人
- **WHEN** 已认证用户列出或创建自己的工作空间，并读取本人的审计事件
- **THEN** 响应中的 `root` 与 `workspace.create` 事件的 `detail.root` 为该空间的绝对路径原文，他人的工作空间不出现在列表中
