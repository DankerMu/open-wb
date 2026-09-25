# Proposal: files-logical-path（#292）

## Why
父 change `s1e-frontend-parity` tasks 5.1（组 5 最后一刀，依赖 1.6b / #302 已合并）。文件页把服务器返回的沙箱绝对路径直接渲染到界面，树根叫字面 `root`：

- `web/src/features/files/page.tsx:98` 切换器卡副行 `currentWorkspace?.root`；`:128` 切换器列表项副行 `workspace.root`；
- `web/src/features/files/tree.tsx:225` 树根 `DirectoryNode label="root"`（可访问名 `展开|折叠 root`、`title="root"`，图标 `folder`）；
- `web/src/features/files/dialogs.tsx:203` 位置下拉根项 `根目录　root`；
- 切换器搜索只按空间名过滤（`page.tsx:72-81`），无匹配文案 `没有匹配的工作空间`。

父 spec files-web「工作空间页」要求：界面只显示逻辑路径 `<account>/<dir>`（Principal `account` + workspace `dir`），绝对 `root` 不出现在任何文本、title、aria 属性；树根行 `Icon shield` + 空间名 + 副行逻辑路径；切换器卡 `Icon layout-grid` + 空间名 + 逻辑路径；搜索按空间名/逻辑路径子串过滤，无匹配 `无匹配的工作空间`；位置下拉根项 `根目录　<空间名>`（demo:3587-3607 切换器列表、3844-3848 切换器卡、3861-3878 根行）。

`Icon layout-grid` 归属：issue #292 In Scope 与父 tasks 5.1 未点名切换器卡图标，但父 spec「工作空间页」同句要求它；组 5 的 5.2（树条目 `fileIcon`）与 5.3（文案/布局）已关闭且都未覆盖卡图标，5.1 为组 5 最后一刀、改的正是切换器卡，故由本刀认领，否则父 5.1 勾选时该句无人交付。

## What Changes
- `web/src/features/files/file-meta.ts` 增纯函数 `logicalPath(account, dir)` → `` `${account}/${dir}` ``。
- `page.tsx`：`FilesPage` 从 `useAuth().principal` 取 `account`（principal 为 null 时不渲染工作空间界面，同 `auth/footer.tsx:30` 口径；认证路由下不可达）；切换器卡 `Icon layout-grid` + 空间名 + 逻辑路径（无空间时仍 `未选择工作空间` / `—`）；列表项副行逻辑路径；过滤谓词为空间名或逻辑路径的大小写无关子串；无匹配文案 `无匹配的工作空间`。
- `tree.tsx`：树根行 `Icon shield` + 空间名（可访问名 `展开|折叠 <空间名>`、`title` 空间名）+ 按钮下方副行逻辑路径；`DirectoryDialog` 根项 `根目录　<空间名>`（`dialogs.tsx`）。
- `files.css`：根行副行样式（token 取色，单行省略）。
- 测试：新 `web/test/files-logical-path.test.tsx`；既有 files 测试中 `折叠|展开 root`、`根目录　root`、按 `root` 找文本的断言改为新呈现。
- ui-walk：`selectOption({ label: "根目录　root" })` → `根目录　smoke-fixture`。

## Non-goals
- API/DTO：`Workspace.root` 字段保留（server 契约不变），仅不再渲染。
- 在线点、只读标签、卸载、挂载入口（S1b）；切换器视觉细节以外的文案/布局。
- 新建工作空间对话框提示里展示沙箱路径（demo 有，本仓不展示绝对路径，保持现文案）。

## Capabilities
- MODIFIED `files-web`：「工作空间页」左栏与切换器段改为逻辑路径/根行/过滤约束，Scenario「空间切换与新建」改为逻辑路径断言，新增 Scenario「绝对路径不出界面且可按逻辑路径过滤」。

## Impact
- Error handling / rollback / partial outputs：无新增错误路径；列表/树加载失败与空态文案不变。
