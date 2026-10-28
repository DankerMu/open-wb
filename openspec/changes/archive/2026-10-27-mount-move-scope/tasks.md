## 1. 实现

- [x] 1.1 `use-mounts.ts` 暴露 `scopeOf(path)`：`holds(path) ? firstSegment(path) : ""`，与 `holds` 同一判定（含回退）
- [x] 1.2 `moveTargets` 接受起点（可选参数，缺省 `""`，`web/test/browser-paths.test.ts` 现有调用不变，并在其中加一例带起点的单元用例）：来源的 `scopeOf` 为空时从根起列（现状），否则从该挂载根起列；仍只收展开且已加载的目录，仍经 `canMoveInto` 去掉自身 / 后代 / 父目录
- [x] 1.3 拖放 `accepts` 加 `scopeOf(from) === scopeOf(directory)`；挂载根行仍不是放下目标。`accepts` 现为 `useCallback(…, [])`：`scopeOf` 经 ref 读取或加入依赖，不得拿到旧的 `holds`
- [x] 1.4 409 映射按 `ApiError.code === "conflict"`：拖放失败处理（`entry-ops.tsx`）与 `request-dialog.ts` 的 `conflictText`；其它 409 显示信封 message

## 2. 测试（jsdom，挂载应答用 `files-ops-support.tsx` 的 `sftpMount` 等共享夹具）

- [x] 2.1 挂载内候选：`远端/d/a.md` → 恰 `远端`；`远端/notes.txt` → 恰 `远端/d`；下拉选项文本为 `远端`（`dialogs.tsx` 的 `DirectoryField` 对非根路径原样显示，无需改代码）；选 `远端` 提交 → 恰一次 `POST move {from:"远端/d/a.md",to:"远端/a.md"}`
- [x] 2.2 挂载外候选（`out` 与 `远端备份` 均已展开）：根下 `a.md` → 含 `out`、`远端备份`，不含 `远端` 与其下目录（近名目录按挂载外）
- [x] 2.3 拖放：`a.md`→`远端/d`、`远端/notes.txt`→根行、`远端/notes.txt`→`out` 均不高亮、无请求；`远端/notes.txt`→`远端/d` 高亮且恰一次 `POST move`；另一挂载 `远端2` 内条目拖到 `远端/d` 不接受
- [x] 2.4 409 按 code：移动对话框与拖放各收 `conflict` / `mount_boundary` / `mount_offline`，前者显示同名文案，后两者显示信封 message；重命名的 `conflict` 仍显示 `该目录下已存在同名条目`，重命名收 409 `mount_offline` 显示信封 message、对话框仍开
- [x] 2.5 只读挂载：`只读区/a.txt` 下拉恰 `只读区/sub`，提交收 403 `mount_read_only` → 对话框内显示信封 message、对话框仍开
- [x] 2.6 新建文件夹：409 `mount_offline` → 信封 message、对话框仍开；409 `conflict` → 仍是 `该目录下已存在同名条目`
- [x] 2.7 会话侧边栏一例：挂载内条目 `移动到…` 下拉恰为同挂载目录

## 3. 文档

- [x] 3.1 功能验收清单新增 FL-53（挂载内移动范围：下拉候选、跨边界拖放不接受、同挂载拖放、经下拉移回挂载根、已展开的近名目录 `远端备份` 对照），结论 `待签`

## 风险包

- Legacy compatibility：选中——挂载外的移动候选、拖放与同名文案不变（2.2、2.4 的 conflict 一例；现有 `files-ops-move.test.tsx`、`files-ops-drag.test.tsx`、`files-ops-row-menu.test.tsx`、`files-mount-*` 照旧通过）。
- Error handling / rollback：选中——409 按 code 区分（1.4、2.4）；服务端 403 / 409 仍是唯一权威（2.5）。
- Documentation / migration notes：选中——FL-53（3.1）。
- File IO / path safety：不选——服务端 move 规则不变，界面只收窄入口。
- Public API / Config / Schema / Auth / Concurrency / Resource limits / Release：不选——不涉及。

## 必须保持

- 挂载外条目的「移动到…」候选与拖放判定逐字同现状（`files-ops-move`、`files-ops-drag` 现有用例）。
- 挂载根行：没有菜单、不可拖、不是放下目标（`files-mount-roots.test.tsx` 现有断言）。
- 新建文件夹 / 重命名在 `code: "conflict"` 时的同名文案不变（现有 409 用例的应答若未带 code，需补 `code:"conflict"` 以贴合服务端真实应答——服务端同名冲突恒为 `conflict`，见 `server/src/workspaces/rest-entries.ts`、`mounts/files.ts`）。
- FL-31/32/33/36 的挂载外移动行为不变。

## 验证

- `make check`
- `openspec validate mount-move-scope --strict --no-interactive`
