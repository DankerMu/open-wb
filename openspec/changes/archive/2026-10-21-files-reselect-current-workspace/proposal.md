# files-reselect-current-workspace — 文件页重选当前空间不导航（#1551）

## Why

`web/src/features/files/page.tsx:200-207` `selectWorkspace` 不判断所选是否当前空间，一律 push `workspaceNavigation(...)`（删掉 `path`）；切换器当前项可点（`workspace-switcher.tsx:104-113`）。`WorkspaceBrowser` 以 `key={currentWorkspace.id}` 挂载（`page.tsx:335`），重选当前空间时 key 不变，同一实例收到 `path` 变化却不经 `pathSeq`、不经回声——这是文件页上唯一一条这样的路径。PR #1550（#1542）的回声记账 `usePathEcho.takePath`（`host-channel.ts:65-79`）只认「回声」或「`pathSeq` / 重挂」，于是重选产生的 `path=null` 若恰等于记账里一条不是末项的旧上报，就被当作陈旧回声跳过：地址与选中对不上，刷新后显示另一个文件（issue 列出的 (a) 回声窗口内重选、(b) 后退到重选前的同空间历史项两条路径，均依赖合批时序）。`files-web`「工作空间页」写「选择即更新 `?ws=`、移除 `path` 并清空展开态与当前文件」，没有区分重选当前项；实际重选时实例不重挂、展开态也不会清空。

## What

- 宿主：`selectWorkspace` 对当前空间短路——在一切副作用之前 `return`：不导航（不 push、不 replace、不碰 `path`）、不调 `closeWorkspaceDialog`（切换器打开时新建空间对话框不在场）、不清 `emptyFolderError`（页面状态不变）；切换器自己的 `onClick` 已先 `setOpen(false)`（`workspace-switcher.tsx:109-112`），所以重选的可见效果只有弹层关闭。这去掉了文件页上唯一的同实例非回声 `path` 变化，也不再产生同空间的 push 历史项。切换器不改（当前项仍可点、仍 `aria-pressed`）。
- 规格：`files-web`「工作空间页」写明「选择当前已选中的空间 SHALL 不导航、不改变地址、展开态与当前文件，只关闭切换器」，补 Scenario「重选当前空间」。
- 页面级回归用例（真实 router 底座）：(a) 删除当前文件 y（文件页上唯一让浏览器上报 `null` 的路径，`follow-entry.ts:102`）→ 点 x → 重选当前空间 → 地址 `path` 与选中一致（都是 x）、历史长度不变；(b) 在 `path=y` 上重选当前空间 → 地址、选中、展开态与历史长度都不变；(c) 对照：选另一空间仍 push、历史 +1。issue 描述的 404 上报 `null` 只在侧边栏宿主（`clearMissing` / `onlyPaths`）出现，文件页不传这两个 prop（`page.tsx:330-346`）；(b) 的「后退到重选前的同空间历史项」路径因不再有同空间 push 而不复存在。
- 不做：`usePathEcho` 判定规则、`pathSeq` 语义、会话侧边栏宿主、`{ replace: true }`（备选 1，不够）、给文件页传 `pathSeq`（备选 2，面更大）。

`design.md` 省略：compact 级，一个回调的短路 + 一句规格 + 页面级用例。

## Triage

```text
Issue type: bug
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; S)
Level rationale: compact despite the Concurrency pack — the fix is a one-callback early return that removes the race source; no shared or persisted state changes and `host-channel.ts` is untouched (precedents: archived `omp-pin-probes`, `omp-stop-early-official`, both compact with Concurrency).
Blast radius: the files page only; a wrong short-circuit either still navigates (new test (a) red: history grows / path dropped) or short-circuits a real switch (existing「空间切换与新建」test red)
Selected risk packs: Concurrency / shared state / ordering (the bug is a batching-order race between the host's URL push and the browser's echo bookkeeping; the fix removes the race source rather than tuning timing); not selected — Public API / CLI (no route or prop change; the switcher's props are unchanged), Error handling, Config, File IO, Schema, Auth / secrets, Resource limits, Release / packaging
Evidence floor: npm test --workspace web (full suite green incl. the new cases; existing files-*, files-deep-link*, workspace-browser* unchanged); new case (a) red before the fix; typecheck; make check; no server/ change
```
