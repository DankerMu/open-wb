# Proposal: chat-turn-actions-split（#489）

## Why
父 change `s1c-turn-control-governance` tasks 7.0b（epic #448）。`web/src/features/chat/page.tsx` 现为 734 行（origin/master `56fc402` 实测），size-guard 硬限 800 行，余量放不下 7.2–7.4 的停止、重新生成、分叉与审批作答 handler。父 design「模块拆分（size-guard）」规定首刀做纯搬迁、行为不变，落点固定为 `features/chat/turn-actions.ts`。

## Triage
Issue type: refactor
Fixture level: expanded
Upstream suggested level: expanded（agree，但理由不同：issue 给的理由不适用本刀。本刀无呈现改动，不需要视口矩阵；也不涉 7.1 的跨端解析。采用 expanded 的理由是：草稿镜像实测 biome `useExhaustiveDependencies` 强制改四个依赖数组，搬迁块因此不能逐字；这些非逐字胶水须有 allowed-edit 清单；搬迁的又是 generation/abort 所有权 fence，属共享状态面）
Blast radius: 会话页全部发送路径。所有权 fence（mounted/abort/generation/client/requested session 五重门控）的条件如果漂移，过期响应会改写 UI、丢草稿，或让 composer 永久锁定。hook 调用位置对本刀没有行为影响，因为 `useTurnActions` 只含 `useCallback`；等 7.2+ 在 hook 内加入 state 或 effect 后，位置才会影响行为。
Selected risk packs: Concurrency / shared state / ordering（fence 门控与 hook 调用次序）；Legacy compatibility / examples（`index.ts` 导出面与导入方不变）；Error handling / rollback / partial outputs（受理前失败退回草稿、受理后失败给刷新指引）
Evidence floor: `web/test/**` 零 diff，web 套件 55 文件 / 1080 例全绿，全局覆盖率不降；design 的 D1/D2/D3 输出与期望完全一致；`bash scripts/size-guard.sh` 0 且 `page.tsx` ≤ 623；`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`npm run build --workspace web` 0。

## What Changes
- 新建 `web/src/features/chat/turn-actions.ts`，导出 hook `useTurnActions(deps)`。`page.tsx:314-447` 的四个连续 `useCallback` 原序搬入：`restoreOwnedDraft`、`finishCreateSend`、`failOwnedPrompt`、`dispatchPrompt`。hook 返回 `{ dispatchPrompt, restoreOwnedDraft }`，这是块外仅有的两个被调用者。
- `page.tsx:29` 的 `TERMINAL_REFRESH_GUIDANCE` 移到 `turn-actions.ts` 并导出。`page.tsx` 仍在 `openSource` 中用它（:193、:241），所以要从 `turn-actions.js` 导入。
- `page.tsx` 在原 314 行位置改为一次 `useTurnActions({…})` 调用，注入 refs、state setter 和页面级回调。`ChatPage` 的 hook 调用序列保持不变。
- 不新增、不改动任何测试。

偏离/澄清（相对 issue 正文）：
1. **只搬 prompt 派发簇。** issue 写「先搬既有 prompt handler/fence 辅助」，本刀只搬 314–447。以下几处留在 `page.tsx`：
   - `createAndSelect`（519-627）与 `submitComposer`（628-660）：它们排在两个 `useEffect`（449、500）和 `selectSession`（512）之后。要搬它们，要么改变 hook 次序，要么把选中/历史 effect 一并拖进 turn-actions。
   - `releaseMutationIfOwned`（90-94）：调用点全在搬迁块内（358/368/378/426），但它位于 90 行，搬走会改变 hook 次序，所以改为注入。
   - `closeSource`/`abort*`/`fencePageWork`（64-107）：这些是页面级 fence（列表、历史、事件源），不专属回合。

   搬迁后 `page.tsx` 实测为 620 行，余量 180 行，够 7.2–7.4 在页面侧接线。
2. **非逐字胶水。** 以下几项不是搬迁块，而是必需的胶水：
   - 类型 `TurnActionDeps`、hook 外壳与返回语句。
   - 四个依赖数组补入被注入的 ref 对象与 setter。在 `page.tsx` 内，biome 能识别这些值为稳定值；变成参数后识别不了，不补 lint 就报错。补入的值身份在整个组件生命周期内恒定，所以记忆化失效集合不变，行为惰性。
   - `finishCreateSend` 由 biome 重排为多行。

   具体清单见 design「Must add/change」，D1/D2/D3 机械核对。
3. **导出与「新 handler」的口径。** `useTurnActions` 是既有 handler 的 hook 外壳，不是新 handler。`TERMINAL_REFRESH_GUIDANCE` 是既有常量换了位置，不是新文案。issue 的「不新增对外导出」指不越出 `page.tsx`：`index.ts` 不变，knip 零新增。拆出的模块被 `page.tsx` 引用，必然有导出。
4. **验收命令的写法。** issue 写「`make test`（web 部分）」，按 AGENTS.md 取 `npm test --workspace web`。

## Capabilities
- ADDED `chat-web`「会话页源码模块划分」：记录 size-guard 落点、`turn-actions.ts` 的长期职责（含 7.2–7.4 handler 落点）和依赖方向。父 delta 没有对应的 requirement，依据是父 design「模块拆分（size-guard）」，与 #471「API 客户端源码模块划分」、#487 先例同形。
- 主 spec「会话页」不改。其中「the page keeps all list data, selection, creation and ownership fences」仍然成立：`useTurnActions` 只由 `ChatPage` 在渲染期调用，fence 状态仍由页面持有。

## Impact
- 只涉及 `web/src/features/chat/page.tsx` 与新建的 `web/src/features/chat/turn-actions.ts`。
- 不触碰：`web/test/**`、`index.ts`、`errors.ts`、`types.ts`、`stream.ts`、`web/src/lib/`、server、Makefile、CI、`biome.json`。

## Non-goals
- 任何新 handler、新状态、新事件类型、新 UI 文案（7.2 起）。
- 搬迁 `createAndSelect`/`submitComposer`/页面级 fence（见偏离 1）。
- `stream.ts` 拆分（不拆）；`stream-approvals.ts`（5.3，#476）；`api.ts` 搬迁（7.0a，已完成）。
- 为消除依赖数组胶水而改 biome 配置或加 `biome-ignore`。
