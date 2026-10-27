## 1. 实现

- [ ] 1.1 `use-mounts.ts` 返回值暴露 `holds`（判定语义不变；行菜单与预览共用这一个函数）
- [ ] 1.2 `workspace-browser.tsx` 把 `holds` 传到 `DirectoryTree` 行菜单；`tree.tsx` 行菜单在 `holds(path)` 为真时不渲染「删除」
- [ ] 1.3 `entry-ops.tsx` 中「删除路由不答 409」的注释改为与 409 `mount_boundary` 相符

## 2. 测试（jsdom，挂载应答用现有共享夹具）

- [ ] 2.1 挂载内文件：菜单无「删除」，有重命名/移动到…/下载
- [ ] 2.2 挂载内目录：菜单无「删除」
- [ ] 2.3 近名普通目录 `远端备份/x.md`：菜单有「删除」
- [ ] 2.4 挂载外文件：菜单四项与删除确认框文案不变；全程挂载内条目无 `DELETE …/entries`
- [ ] 2.5 会话页侧边栏（会话侧边栏那组用例文件）：空间挂着 `远端`，在侧边栏对 `远端/notes.txt` 打开 `更多操作` → 菜单没有 `删除`

## 3. 文档

- [ ] 3.1 功能验收清单 FL-44 改写：操作为打开 notes.txt 行尾「更多操作」看菜单；期望为菜单里没有「删除」（仍有重命名、移动到…、下载），远端服务上的文件仍在；结论 `待签`

## 风险包

- Legacy compatibility：选中——挂载外条目菜单与删除文案不变（2.4）。
- Error handling / rollback：不选——`holds` 在挂载列表未取到或取失败时回退到 `unlistedAtRoot`，但此时 `mounts = NO_MOUNTS`、不渲染挂载根行，挂载内的行无从展开（服务端根 `tree` 不列挂载点，`use-mounts.ts:146-178`）；凡有行菜单的行都走不到回退分支，挂载外行回退恒为 false。因此不写回退用例，以「行菜单与预览共用同一个 `holds`」（1.1）钉住语义；服务端 409 仍兜底。
- Documentation / migration notes：选中——FL-44 改写（3.1）。
- File IO / path safety：不选——服务端删除规则不变，界面只是少一个入口。
- Public API / Config / Schema / Auth / Concurrency / Resource limits / Release：不选——不涉及接口、配置、数据格式、权限、并发、资源上限或打包。

## 必须保持（现有用例守护，`make check` 内）

- 拖放：`useRowDrag` 不动，`web/test/files-ops-drag.test.tsx` 照旧通过。
- `onlyPaths` / 子树模式：`actions` 与 `mounts.roots` 均为 undefined，无行菜单、无挂载根行，本改动够不到。
- 挂载外四项菜单：`web/test/files-ops-row-menu.test.tsx` R17、R21 照旧通过；挂载内子行照常有菜单按钮：`web/test/files-mount-roots.test.tsx:279-287` 照旧通过；FL-35/FL-36 用的 uploads/notes.csv 在挂载外，不受影响。

## 验证

- `make check`
- `openspec validate mount-member-no-delete --strict --no-interactive`
