## Why

#1816：挂载内的文件与目录行菜单照常给出「删除」，确认框承诺「管理员可在保留期内从服务器恢复」，而服务端对挂载内删除无条件答 409 `mount_boundary`——用户看到的是一个必然失败、说明与事实相反的流程（FL-44 走查）。

## What Changes

- 挂载内条目（判定同预览的「在挂载内」：`use-mounts.ts` 的 `holds`）的行菜单不再有「删除」；重命名、移动到…、下载不变；挂载外不变。
- `useMounts` 暴露 `holds`，经 `WorkspaceBrowser` 传给目录树行菜单；文件页与会话页侧边栏同一实现。
- `entry-ops.tsx` 过时注释（「删除路由不答 409」）改正。
- 功能验收清单 FL-44 按新行为改写，结论 `待签`。
- 服务端不变。

## Impact

- 规格：files-web「文件操作界面」MODIFIED（菜单项例外 + 场景）；workspace-mounts ADDED「挂载内条目的行菜单」。
- 代码：`web/src/features/files/{use-mounts.ts,workspace-browser.tsx,tree.tsx,entry-ops.tsx}`，测试 `web/test/files-*`。

## Triage

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent
Blast radius: 文件树行菜单（文件页 + 会话侧边栏）；误判会让挂载外条目丢了删除，或挂载内仍给删除
Selected risk packs: Legacy compatibility（挂载外菜单与删除文案不变）；Documentation（FL-44 改写）
Evidence floor: jsdom 用例覆盖挂载内文件/目录、近名普通目录、挂载外文件；make check
```

design.md 省略（compact）。同成因的「移动到…」候选问题不在本 change（另行跟进）。
