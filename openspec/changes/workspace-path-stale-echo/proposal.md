# Proposal: workspace-path-stale-echo

## Why

#1542：`WorkspaceBrowser` 的 `path` effect（`workspace-browser.tsx:622-636`）把「`appliedPathRef` 与新 `path` 不同」当作「宿主要求换路径」。但宿主（会话页侧边栏 `workspace-sidebar.tsx:185`、文件页 `page.tsx:211-222,338`）会把组件自己经 `onPathChange` 上报的值原样写回 `path`。这个回声的提交与被动 effect 之间有一个窗口（DefaultLane 提交后被动 effect 是单独的 Scheduler 任务；文件页的写回走 router transition，窗口更长）。窗口里如果用户又点了另一个文件，旧回声的 effect 就会把一次已被取代的上报当作新要求执行：

- 典型时序：选中 `deep/y.md` → `file` 答 404 → `dropMissing` 上报 `null` → 回声 effect 还没跑，用户点了 `deep/x.md`（`file` 第 1 次）→ `path=null` 的 effect 跑了，`clearSelection()` 清掉 x.md 和它在途的预览 → `path="deep/x.md"` 的 effect 看到选中为空，定位后再发一次 `file`（第 2 次）。
- 最终状态正确；用户可见的是预览区闪一下回到未选状态，以及一次多余的 `file` 请求。宿主还会经 `onSelectionChange` 多收到一对 `null` / `deep/x.md`。
- 同类窗口也出现在其它异步上报之后：改名或删除跟随上报（`follow-entry.ts:102,106`）之后紧接着的点击；句柄 `reveal()` 落地 / 落空的上报（`:542`、`:561`）同理，但 web/src 里目前没有生产代码调用 `reveal()`（侧边栏定位走 `pathSeq`），只作为组件契约覆盖。

## What Changes

- 组件按顺序记下自己经 `onPathChange` 上报、还没见到回声的值。`path` effect 见到的新值如果是其中一条（同值多次时取最早那条），而且之后还有更新的上报（它已被取代），就只把它记为已套用：不清选中、不改预览区文案、不发起定位。见到的是最近一次上报，或者不是组件自己上报的值，就照既有规则套用，并清空这份记账。
- `pathSeq` 换新值引起的重新套用、挂载（含 StrictMode 重挂）时的首次套用，一律照既有规则套用，不做上面的判断。
- 不改宿主写回 `path` 的方式，不改 `pathSeq` 的语义，不改 `onPathChange` / `onSelectionChange` 的调用时机。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `files-web`：ADDED「浏览器不执行被取代的自身上报回声」。不复制超长的「工作空间浏览器组件」整条，新增一条，细化它的受控 `path` / `onPathChange` 在回声晚于下一次上报时的行为。

## Impact

- 改动面：`web/src/features/files/workspace-browser.tsx`（`path` effect 与各上报点改用记账的上报）、`web/src/features/files/follow-entry.ts`（它收到的 `onPathChange` 换成记账的那一个，签名不变）、`web/src/features/files/host-channel.ts`（新 hook）、一个新测试文件。
- 不碰宿主（`workspace-sidebar.tsx`、`files/page.tsx`）、测试基建、server。

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (issue: S, implementation-ready, approach A/B left to implementer)
Blast radius: WorkspaceBrowser 受控 path 的套用——会话页侧边栏与文件页（含地址深链）共用
Selected risk packs: Concurrency / shared state / ordering; Legacy compatibility / examples; Error handling / rollback / partial outputs
Evidence floor: 新用例改前红、改后绿（以受控宿主的回声次序确定性复现，不依赖 Scheduler 时机）；workspace-browser-*、files-deep-link*、chat-workspace-sidebar* 不改即绿；make check 绿
```
