## Why

#1823：挂载内条目的「移动到…」候选从根起列，只有根与普通目录——全部跨挂载边界、必答 409 `mount_boundary`；服务端允许的同一挂载内移动反而选不到，也无法移回挂载根一层。拖放两个方向都不看挂载边界。所有 move 的 409 只看状态码，`mount_boundary` / `mount_offline` 都被显示成「目标位置已存在同名条目」。

## What Changes

- 「挂载范围」：`useMounts` 暴露 `scopeOf(path)` = `holds(path) ? 第一段 : ""`（复用 #1816 的 `holds`，含回退，不另写规则）。
- `移动到…` 候选：挂载内条目从该挂载根起列（挂载根以挂载名显示，其下仍只列展开且已加载的目录）；挂载外条目不列挂载内目录（现状已如此，保持）。
- 拖放接受：加 `scopeOf(from) === scopeOf(dir)`；跨范围不高亮、不发请求。挂载根行仍不是放下目标（owner 方向：挂载根只进下拉，规格「挂载根行」不改）。
- 只读挂载：候选照常列出，服务端 403 `mount_read_only` 显示信封 message「只读挂载不能写入」（与 FL-41 重命名一致，不加新文案）。
- 409 按 `code`：只有 `conflict` 显示固定同名文案（重命名、移动到…、拖放、新建文件夹共用的 `request-dialog` 与拖放失败处理），其它 409 显示信封 message。
- 功能验收清单新增 FL-53（挂载内移动范围），结论 `待签`。
- 服务端不变。

## Impact

- 规格：files-web「工作空间页」（新建文件夹 409 按 code）与「文件操作界面」MODIFIED；workspace-mounts「挂载内条目的行菜单」MODIFIED。「挂载根行」不改。
- 代码：`web/src/features/files/{use-mounts.ts,browser-paths.ts,entry-ops.tsx,request-dialog.ts,workspace-browser.tsx}`（按需 `tree.tsx`、`move-dialog`），测试 `web/test/files-*`、会话侧边栏组。

## Triage

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent
Blast radius: 文件树的移动入口（下拉、拖放）与重命名 / 移动 / 拖放 / 新建文件夹的 409 提示；误判会让挂载外的移动丢目标，或 409 同名文案消失
Selected risk packs: Legacy compatibility（挂载外移动、拖放与同名文案不变）；Error handling（409 按 code 区分）；Documentation（新增 FL-53）
Evidence floor: jsdom 用例覆盖两份规格的场景（挂载内候选、挂载外候选、跨范围拖放不接受、同挂载拖放、近名目录、409 三种 code、只读挂载 403）与会话侧边栏一例；现有 files-ops-move / files-ops-drag / files-mount-* 守护照旧；make check
```

design.md 省略（compact）。owner 方向：挂载根只进下拉（备选一，不改「挂载根行」:335）；只读挂载照常列出、由服务端 403 提示（issue 推荐）。
