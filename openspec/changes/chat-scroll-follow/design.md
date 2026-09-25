# Design: chat-scroll-follow（#290）

Fixture level：expanded（父 tasks 组 4 声明；review priority mechanical）。

Risk packs：
- Public API / CLI / script entry：按钮可访问名与滚动元素类名是测试定位面。
- Concurrency / shared state / ordering：scroll 事件、内容更新、会话切换三者的先后。
- Resource limits / large input：长历史与持续增长的流式内容。
- Legacy compatibility：欢迎态结构与 composer 身份不变。

Governing invariant：`pinned` 只由两处写入——用户 scroll（距底 ≤4 → true，否则 false）与点击 `回到最新`（→ true）；layout effect 只读不写。`showJump` 只在距底 > `clientHeight` 时置 true（来自 scroll 或内容增长），只在 scroll 到距底 ≤4 或点击时置 false。

Sibling surfaces：
- 改变滚动位置的三处：layout effect（内容变化时贴底跟随）、`jumpToLatest`、用户滚动。
- `key={requestedSessionId}` 重挂载：会话切换即重置 `pinned = true`、`showJump = false`。
- 发送后历史对账（`page.tsx` 以权威快照替换 `historyView`）：同一会话 key 不变，`pinned` 保持，不重置；对账产生的新 `historyView` 与 delta 一样走 layout effect。
- 欢迎态 create-send 交接：transcript 槽从 `div.chat-transcript` 换成 `FollowTranscript`，新挂载从底部开始；composer 身份见 Must preserve。
- 欢迎态 `div.chat-transcript`：不经过 hook，不渲染按钮。
- 服务端与存储：无（纯呈现）。

Change surface：
- 新增：`web/src/features/chat/scroll-follow.tsx`、`web/test/chat-scroll-follow.test.tsx`。
- 修改：`web/src/features/chat/conversation-view.tsx`（transcript 槽装配）、`web/src/features/chat/messages.css`（追加规则）。
- 不改：`web/src/ui/**`、`web/src/features/chat/{page.tsx,stream.ts,composer.tsx,welcome.tsx,chat.css}`、`web/src/lib/**`、`web/e2e/**`、服务端。

Must preserve：
- 欢迎态（无 `requestedSessionId`）仍是 `div.chat-main.chat-main--welcome` > `div.chat-transcript` > `WelcomeIntro`：`chat.css:189` 的 `.chat-main--welcome > .chat-transcript` 直接子选择器依赖它。欢迎态不渲染 `.chat-transcript-frame` 与按钮。
- `chat-page.test.tsx` W5：欢迎态到会话的交接中 composer textarea 是同一个节点。`chat-main` 子节点顺序仍为 [三个可空 alert, transcript 槽, Composer, 可空 WelcomePlaybooks]；只有 transcript 槽的元素类型在两态间变化，Composer 所在位置不变。
- 会话态 `.chat-transcript` 仍是滚动元素（`chat.css:163-169` 的 `flex:1; min-height:0; overflow-y:auto` 不改），`section.chat-thread[aria-label=消息]` 仍是它的子元素。
- 既有 jsdom 与 ui-walk 对消息、步骤卡的定位不变（它们不经过 `.chat-transcript`）。
- ui-guardrails：feature css/tsx 无字面颜色或 palette；基元只经 `../../ui/index.js` 引入；无 `style={`；注释不含 `#NNN`；新增或修改的 ts/tsx ≤ 800 行。

Must add/change：
- `scroll-follow.tsx`（头注释：`"回到最新" and bottom-follow for the chat transcript (S1e 4.5 / parent design D8), behavior adapted from resource/workbuddy-live-demo.html:2488-2520.`）：
  ```tsx
  const PIN_TOLERANCE_PX = 4;

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function useScrollFollow(ref: RefObject<HTMLDivElement | null>, content: unknown) {
    const pinned = useRef(true);
    const [showJump, setShowJump] = useState(false);

    const onScroll = useCallback(() => {
      const el = ref.current;
      if (!el) return;
      const distance = distanceFromBottom(el);
      if (distance <= PIN_TOLERANCE_PX) {
        pinned.current = true;
        setShowJump(false);
        return;
      }
      pinned.current = false;
      if (distance > el.clientHeight) setShowJump(true);
    }, [ref]);

    // biome 的 useExhaustiveDependencies 会把 content 标为多余依赖；按仓库惯例加
    // 一行 biome-ignore 注释说明"内容变化即触发"，而不是改写成不依赖它。
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      if (pinned.current) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      if (distanceFromBottom(el) > el.clientHeight) setShowJump(true);
    }, [content, ref]);

    const jumpToLatest = useCallback(() => {
      const el = ref.current;
      if (!el) return;
      pinned.current = true;
      setShowJump(false);
      el.scrollTop = el.scrollHeight;
    }, [ref]);

    return { jumpToLatest, onScroll, showJump };
  }

  export function FollowTranscript({ children, content }: { children: ReactNode; content: unknown }) {
    const ref = useRef<HTMLDivElement>(null);
    const { jumpToLatest, onScroll, showJump } = useScrollFollow(ref, content);
    return (
      <div className="chat-transcript-frame">
        <div className="chat-transcript" onScroll={onScroll} ref={ref}>
          {children}
        </div>
        {showJump ? (
          <button className="chat-jump-latest" onClick={jumpToLatest} type="button">
            <Icon name="chevron-down" size={12} />
            回到最新
          </button>
        ) : null}
      </div>
    );
  }
  ```
  - 只导出 `FollowTranscript`（knip 会报只在本文件使用的导出）。issue 的 Key interfaces 写的是 `useScrollFollow(ref) → {pinned, showJump, jumpToLatest}`；本刀把 `pinned` 收为 ref（不需要渲染），hook 多收一个 `content` 参数用作跟随触发，并多返回 `onScroll`，作为实现偏差留痕。
  - 若 biome 对 `onScroll` 所在 div 报 a11y 规则（滚动容器无交互语义），按报出的具体规则处理并记入偏差；不得改成 `addEventListener` 以绕过 lint 却不说明。
- `conversation-view.tsx`：
  ```tsx
  {requestedSessionId ? (
    <FollowTranscript content={historyView} key={requestedSessionId}>
      {historyView ? <MessageThread historyView={historyView} /> : null}
    </FollowTranscript>
  ) : (
    <div className="chat-transcript">
      <WelcomeIntro disabled={composerDisabled} onPick={onChangeDraft} />
    </div>
  )}
  ```
- `messages.css` 追加（来源注释：`adapted from resource/workbuddy-live-demo.html:399-401 (.back-to-latest)`）：
  - `.chat-transcript-frame { position: relative; display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }`
  - `.chat-jump-latest`：`position: absolute; left: 50%; bottom: 16px; z-index: 1; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 14px; border: 1px solid var(--wb-border-default); background: var(--wb-bg-primary); box-shadow: var(--wb-shadow-popover); color: var(--wb-text-secondary); font-family: var(--wb-font); font-size: 12.5px; white-space: nowrap; cursor: pointer; transition: color 0.15s, border-color 0.15s;`
  - 圆角按 chat.css 惯例在 `.chat-jump-latest, .chat-jump-latest:focus-visible { border-radius: 15px; }` 重申（覆盖全局 `:focus-visible` 圆角）。
  - `.chat-jump-latest:hover { color: var(--wb-text-primary); border-color: var(--wb-text-tertiary); }`
  - `@media (prefers-reduced-motion: reduce) { .chat-jump-latest { transition: none; } }`

## Test plan（`web/test/chat-scroll-follow.test.tsx`）

jsdom 无布局，滚动量用原型级 mock：`beforeEach` 在 `HTMLElement.prototype` 上 `Object.defineProperty` 覆盖 `scrollHeight`、`clientHeight`（getter）与 `scrollTop`（getter/setter）。只对 `classList.contains("chat-transcript")` 的元素返回共享的 `metrics = { scrollHeight, clientHeight, scrollTop }`，其他元素回落到 `Element.prototype` 上的原描述符；`scrollTop` setter 夹到 `[0, scrollHeight - clientHeight]`。三个 `Object.defineProperty` 都带 `configurable: true`；`afterEach` 用 `Reflect.deleteProperty(HTMLElement.prototype, "<name>")` 恢复（先例 `web/test/files-fixture.tsx:152`；不用 `delete`：严格模式下删不可配置属性会抛错，且 `web/tsconfig.json` 也检查 `test/`，`delete` 非可选属性报 TS2790）。原型级 mock 让首次挂载的 layout effect 也能被观测。默认 `metrics = { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 }`，底部即 `scrollTop = 2500`。

助手 running 快照走 `chatSnapshot({ assistantStatus: "running", content: "起始", cursor: { epoch: 1, seq: 3 } })` + `renderChatPage`（参照 `chat-messages.test.tsx` M3）；新 delta 用 `latestSource().emitData("text.delta", "1:<n>", { messageId: 0, delta })`。测试先改 `metrics.scrollHeight` 再发 delta，然后 `await` 到新文本出现。用户滚动 = 设 `metrics.scrollTop` 后对 `.chat-transcript` 调 `fireEvent.scroll`。按钮一律 `screen.queryByRole("button", { name: "回到最新" })`。

| # | 场景 | 断言 |
|---|---|---|
| F1 | 打开长历史 | messages 路由返回前 `metrics.scrollHeight = 500`（内容未到，挂载时的滚动落在 0）；路由解析时把 `scrollHeight` 改为 3000 再返回快照；历史渲染后 `metrics.scrollTop === 2500`（证明是"内容变化触发跟随"而非仅挂载时滚动）；无按钮 |
| F2 | 上滚超过一屏后 delta | `scrollTop = 1000` + scroll → 按钮出现；`scrollHeight = 3200` + delta → `scrollTop` 仍为 1000，按钮仍在 |
| F3 | 点击回底后继续跟随 | 接 F2：点击按钮 → `scrollTop === 2700`，按钮消失（点击本身即隐藏，不依赖后续 scroll 事件）；`scrollHeight = 3400` + delta → `scrollTop === 2900` |
| F4 | 上滚不足一屏 | `scrollTop = 2200`（距底 300）+ scroll → 无按钮；`scrollHeight = 3200` + delta → `scrollTop` 仍为 2200（距底 500，不大于一屏，仍无按钮）；`scrollHeight = 3201` + delta → 按钮出现（内容增长触发显示） |
| F5 | 滞回与贴底边界 | `scrollTop = 1000` + scroll → 按钮出现；`scrollTop = 2200`（距底 300）+ scroll → 按钮仍在；`scrollTop = 2495`（距底 5）+ scroll → 按钮仍在；`scrollTop = 2496`（距底 4）+ scroll → 按钮消失；随后 `scrollHeight = 3100` + delta → `scrollTop === 2600`（贴底跟随） |
| F6 | 切换会话重置 | 上滚使按钮出现后 `router.navigate("/?session=<另一个会话>")`（该会话有自己的 messages 路由）；新历史渲染后 `metrics.scrollTop` 为新的底部、无按钮 |
| F7 | 欢迎态 | 无 `?session=` 打开：`.chat-transcript` 存在且为 `.chat-main` 的直接子元素；`.chat-transcript-frame` 与按钮都不存在 |
| F8 | 静态 | `messages.css` 中 `.chat-jump-latest` 规则含 `position: absolute`、`background: var(--wb-bg-primary)`、`box-shadow: var(--wb-shadow-popover)`；`.chat-transcript-frame` 规则含 `position: relative`；按钮含 `svg.ui-icon`（chevron-down）且 `aria-hidden="true"`；可访问名只有 `回到最新` |

## Required evidence（反向注入，各自单独注入后跑本测试文件必须变红，然后回退）
1. layout effect 忽略 `pinned` 总是滚到底 → F2 红。
2. layout effect 从不滚动 → F1、F3 红。
3. 显示阈值改为 `distance > 0` → F4 红。
4. 去掉滞回（`distance <= clientHeight` 时隐藏按钮）→ F5 红。
5. `jumpToLatest` 不设 `pinned.current = true` → F3 跟随步骤红。注：只在 jsdom 下变红，因为代码赋值 `scrollTop` 时 jsdom 不派发 `scroll`；真实浏览器里随后的 `onScroll` 会重新贴底，所以这一行守的是"点击到下一次 scroll 事件之间"的窗口，而不是浏览器最终状态。
6. 去掉 `key={requestedSessionId}` → F6 红。
7. layout effect 的非贴底分支不重算 `showJump` → F4 末步红。
8. `PIN_TOLERANCE_PX` 改为 0 → F5 边界步红。

## Not yet specified
- 发送新消息后是否强制回底（demo 会；spec 未规定，本刀不做，见 proposal Non-goals）。
- 历史加载后若内容仍短于一屏，按钮不会出现，这是期望行为，不另测。

## Implementation deviations
None.

实现与上文代码草图一致（biome 未对 `onScroll` 所在 div 报 a11y 规则；`useExhaustiveDependencies` 按草图注释以一行 biome-ignore 处理）。测试层面的补充（不改变断言语义）：F6 的另一会话 messages 路由在解析时把 `scrollHeight` 改为 4000，使新底部（3500）与旧会话底部可区分；F7 额外在欢迎态 `.chat-transcript` 上派发一次 scroll，确认仍无按钮；F8 拆成静态 CSS 与渲染按钮两个用例，并附带断言按钮 `type="button"`、父元素为 `.chat-transcript-frame`。
