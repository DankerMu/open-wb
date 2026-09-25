# Design: chat-copy-action（#291）

Fixture level：expanded（父 tasks 组 4 声明；review priority mechanical）。

Risk packs：
- Public API / CLI / script entry：按钮可访问名 `复制` 与两条 Toast 文本是测试定位面。
- Auth / permissions / secrets：浏览器剪贴板权限被拒时表现为 reject。
- Error handling / rollback / partial outputs：三种失败都收敛为 Toast `复制失败`，不产生未捕获异常。
- Legacy compatibility：助手块既有结构与定位不变。

Governing invariant：`复制` 按钮点击后恰好发生两件事：一次 `writeText(message.content)` 尝试（API 缺失时为零次调用），以及恰好一条 Toast——成功时 `已复制到剪贴板`，其余情况 `复制失败`。点击处理不向外抛出任何异常或 rejection。

Sibling surfaces：
- 助手块三种状态：running 不渲染；done、failed 在原文非空时渲染。
- 用户消息不渲染操作条。
- `ToastProvider`：`web/src/main.tsx` 应用根，测试侧 `web/test/render-app-router.tsx`。本刀不挂 Provider。
- 不挂 ToastProvider 的挂载路径：`web/test/chat-page-lifecycle-support.tsx:83-93` 直接挂 ChatPage，使用方为 `topbar.test.tsx` T7（:243「Provider 外裸挂 ChatPage」）与 `chat-page-lifecycle.test.tsx:115,276`。它们的快照中没有已完成且正文非空的助手消息（T7 用 `chatSnapshot` 默认的空 content，另两处只有用户消息），所以不会渲染 `MessageActions`，`useToast()` 不会在 Provider 外被调用。本刀不改这些 fixture；以后若给它们加上助手正文，须同时挂 ToastProvider。同类的无 Provider 挂载还有 `web/test/routes.test.tsx:236,261,282` 与 `web/test/settings-support.tsx:35`（均直接 `render(<RouterProvider …/>)`）；它们的快照同样没有已完成且正文非空的助手消息，web 全量绿可证。
- `MessageArticle` 是 `memo` 组件：`MessageActions` 只依赖 `message.content`，`useToast()` 的 value 由 `useMemo` 保持稳定，不破坏 memo。
- 服务端与存储：无，纯呈现。

Change surface：
- 新增：`web/src/features/chat/message-actions.tsx`、`web/test/chat-copy.test.tsx`。
- 修改：`web/src/features/chat/conversation-view.tsx`（助手块末尾装配）、`web/src/features/chat/messages.css`（追加规则）。
- 不改：`web/src/ui/**`、`web/src/features/chat/{page.tsx,stream.ts,composer.tsx,welcome.tsx,scroll-follow.tsx,chat.css}`、`web/src/lib/**`、`web/e2e/**`、服务端。

Must preserve：
- 助手块结构：`article[aria-label=助手]` > `span.chat-msg-avatar`（首子）+ `div.chat-msg-main` > `.chat-md`、步骤卡、错误，操作条只追加在末尾。`chat-messages.test.tsx` 中 M4 的三条断言保持绿：`article.firstElementChild` 是头像；`within(article).queryByRole("img")` 为 null（`Icon` 无 label 时带 `aria-hidden`）；`.chat-md` 在步骤卡之前。
- M3：running 时 `.chat-md` 的 `lastElementChild` 是 caret。操作条在 `.chat-md` 之外，且 running 时不渲染。
- ui-walk 在 `web/e2e/ui-walk.spec.ts` 中用 `.chat-md` 与 region `bash` 定位；新按钮名 `复制` 与这些定位不冲突。`web/e2e` 中没有任何 `复制` 定位（已 grep 确认）。
- ui-guardrails：feature css/tsx 无字面颜色与 palette；基元只经 `../../ui/index.js` 引入；无 `style={`；注释不含 `#NNN`；ts/tsx ≤ 800 行。

Must add/change：
- `message-actions.tsx`，头注释写：`Assistant message action row (S1e 4.6 / parent design D8): a single 复制 button, adapted from resource/workbuddy-live-demo.html:2394-2395 and :1188-1191 (copyText), without the execCommand fallback.` 草图：
  ```tsx
  import { Button, Icon, useToast } from "../../ui/index.js";

  export function MessageActions({ text }: { text: string }) {
    const toast = useToast();
    async function copy() {
      try {
        await navigator.clipboard.writeText(text);
        toast.show({ type: "success", message: "已复制到剪贴板" });
      } catch {
        toast.show({ type: "error", message: "复制失败" });
      }
    }
    return (
      <div className="chat-msg-actions">
        <Button
          aria-label="复制"
          className="chat-msg-action"
          onClick={() => void copy()}
          size="icon"
          title="复制"
          variant="ghost"
        >
          <Icon name="copy" size={12} />
        </Button>
      </div>
    );
  }
  ```
  - 不写 `navigator.clipboard?.` 这类可选链守卫：TS DOM lib 把 `clipboard` 声明为非可选，API 缺失时访问 `undefined.writeText` 抛出的 TypeError 在同一个 try 内被捕获，走失败 Toast。只保留一条路径。
- `conversation-view.tsx` 的助手分支，在 `{error}` 之后加：
  ```tsx
  {message.status !== "running" && message.content !== "" ? (
    <MessageActions text={message.content} />
  ) : null}
  ```
- `messages.css` 追加规则，来源注释写 `adapted from resource/workbuddy-live-demo.html:528-530 (.msg-actions)`：
  - `.chat-msg-actions { display: flex; gap: 2px; margin-top: 8px; }`
  - `.chat-msg-action`（覆盖 `ui-btn--icon` 尺寸）：`width: 26px; height: 26px; padding: 0; border-radius: 6px; color: var(--wb-icon-muted);`。`--wb-icon-muted` 在 `web/src/styles/tokens.css:72,228` 两套主题中都有定义。
  - `.chat-msg-action:hover:not(:disabled) { color: var(--wb-text-secondary); }`，背景沿用 ghost 按钮的 hover。特异性为 (0,3,0)，与 `web/src/ui/button.css:57` 的 `.ui-btn--ghost:hover:not(:disabled)` 相同，后引入者生效。
  - 圆角按 `messages.css:334` 的先例重申：`.chat-msg-action, .chat-msg-action:focus-visible { border-radius: 6px; }`，以覆盖 `button.css:101` 的 `.ui-btn:focus-visible { border-radius: 8px }`。
  - 选择器的特异性须能覆盖 `ui-btn--icon` 的尺寸：`.chat-msg-action` 与 `.ui-btn--icon` 都是单类选择器，messages.css 在 ui css 之后引入即可生效。`web/src/styles.css:8,12` 中 `ui/ui.css` 先于 `features/chat/messages.css` 引入，条件满足。

## Test plan（`web/test/chat-copy.test.tsx`）

- 剪贴板 mock：`Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } })`，`afterEach` 中 `Reflect.deleteProperty(window.navigator, "clipboard")`。jsdom 默认没有 `navigator.clipboard`，实现者先断言 `"clipboard" in navigator` 为 false，作为缺失分支的前提。
- 点击一律用 `fireEvent.click`（仓库未装 `@testing-library/user-event`；若将来引入，`userEvent.setup()` 会替换 `navigator.clipboard`）。
- 未捕获 rejection 检测：C2、C3、C3b 统一用 `observeUnhandledRejections()` + `settle()`（`web/test/chat-stream-support.ts:88-107`，先例 `chat-stream-recovery.test.ts:69-72`），在 `finally` 中 `stop()`；断言 `unhandled` 为空数组。
- 挂载：`renderChatPage` + `chatSnapshot`，参照 `chat-messages.test.tsx` 的 `mountSnapshot`/`doneSnapshot`。
- Toast 断言：`within(screen.getByRole("region", { name: "通知" }))`，参照 `ui-toast.test.tsx:44`；文本元素所在的 `.ui-toast` 须带 `ui-toast--success` 或 `ui-toast--error`。
- 原文使用 `RAW = "# 标题\n\n段落 **粗体** 与 \`行内\`"`：它的 Markdown 标记会在渲染后消失，所以能区分复制的是原文还是渲染后的文本。

| # | 场景 | 断言 |
|---|---|---|
| C1 | 成功 | done 回合，content 为 `RAW`，`writeText = vi.fn().mockResolvedValue(undefined)`。点击 `getByRole("button", { name: "复制" })` 后：`writeText` 恰被调用 1 次，参数 `toBe(RAW)`；出现 `已复制到剪贴板`（`ui-toast--success`）；不出现 `复制失败` |
| C2 | API 缺失 | 不定义 `navigator.clipboard`。点击后出现 `复制失败`（`ui-toast--error`）；不出现 `已复制到剪贴板`；`settle()` 后 `unhandled` 为空 |
| C3 | reject | `writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"))`，开启 `observeUnhandledRejections()`。点击后出现 `复制失败`（error），`writeText` 被调用 1 次；`settle()` 后 `unhandled` 为空；`已复制到剪贴板` 不出现（恰一条 Toast）；`finally` 中 `stop()` |
| C3b | 同步抛错 | `writeText = vi.fn(() => { throw new Error("sync"); })`。点击后出现 `复制失败`（error）且 `已复制到剪贴板` 不出现；`settle()` 后 `observeUnhandledRejections().unhandled` 为空（同步抛错发生在 async 函数内，会变成 rejection，检测方式与 C3 相同） |
| C4 | 渲染条件 | running 助手（content 为非空的 `"进行中"`，确保只由 running 条件拦下）：无 `复制` 按钮。done 助手 content `""`：无按钮。failed 助手 content `"部分"`：有按钮，且 `.chat-msg-actions` 是 `.chat-msg-main` 的 `lastElementChild`。用户消息 article 内无按钮。按钮 `title` 为 `复制`，内含 `svg.ui-icon` 且带 `aria-hidden="true"`，按钮可访问名恰为 `复制` |
| C5 | 多条助手消息 | 快照含两轮（两条助手，content 分别为 `一` 与 `二`）。点击第一条助手 article 内的按钮后，`writeText` 最后一次调用参数为 `一`；点击第二条后为 `二` |
| C6 | 静态 | `messages.css` 中 `.chat-msg-actions` 规则含 `display: flex`；`.chat-msg-action` 规则含 `width: 26px`，其 `color` 为 `var(--wb-...)` 形式的 token；存在 `.chat-msg-action:hover:not(:disabled)` 规则且含 `color: var(--wb-text-secondary)`；`messages.css` 无字面颜色（M5 已覆盖，C6 不重复） |

如果 `chatSnapshot` 不支持构造多轮快照，C5 直接构造 `ChatMessageSnapshot.messages`，形状参照 `chat-stream-support.ts` 中的 `historyUser`。

## Required evidence
以下注入各自单独做：注入后跑本测试文件，必须变红，然后回退。
1. 去掉 try/catch，让 `await` 的失败外泄 → C2、C3、C3b 红。
2. 成功时不弹 Toast → C1 红。
3. 复制渲染后的文本（如 `article.querySelector(".chat-md")?.textContent`）而不是原文 → C1 红。
4. 去掉 `status !== "running"` 条件 → C4 红。
5. 去掉 `content !== ""` 条件 → C4 红。
6. 失败 Toast 的 `type` 改为 `"success"` → C2 红（class 断言）。
7. 所有按钮都复制最后一条助手消息的原文 → C5 红。
8. catch 中先弹 `复制失败` 再 `throw`（rethrow）→ C3 只因 `unhandled` 非空而变红，Toast 断言仍绿。这一项证明未捕获 rejection 的检测器能单独抓到逃逸。
9. （fix pass 1 补）成功 Toast 早于 `await`：`const pending = navigator.clipboard.writeText(text); toast.show({ type: "success", … }); await pending;` → C3 红（reject 时出现了 `已复制到剪贴板`）。C2/C3b 因同步抛错走不到成功 Toast，不要求变红。
10. （fix pass 1 补）`<MessageActions>` 挪到 `{steps}` 之前 → C4 failed 用例红（`.chat-msg-main` 的 `lastElementChild` 不再是 `.chat-msg-actions`）。

Seams under test：`MessageActions` 的点击处理（剪贴板 → Toast）；`conversation-view.tsx` 的渲染条件（status 与 content）。

Review focus：失败路径收敛与无逃逸（C2、C3、C3b、注入 8）；渲染条件不空测（C4 running 用例的 content 非空）；CSS 覆盖优先级（hover、focus-visible 圆角）。

## Not yet specified
- 复制成功后按钮不做"已复制"图标切换（demo 也没有）。
- 失败 Toast 不区分"API 缺失"与"权限拒绝"，spec 只要求一个文本。

## Implementation deviations
- `messages.css` 的新规则插在文件末尾 `@media (max-width: 760px)` 块之前，而不是字面上的文件最末：保持移动端媒体查询收尾的既有布局。它们仍然位于所有 ui css 之后，特异性与覆盖顺序跟设计一致；无行为差异。
- 除此之外无偏差。C4 拆成三个 `it`（running、空正文、failed 加用户消息）。C6 在设计列出的断言之外，还断言 `.chat-msg-action:focus-visible` 的圆角为 `6px`，用来覆盖 Review focus 里的 focus-visible 圆角项。
- fix pass 1：C4 failed 用例的快照多带一个 done 状态的 `bash` 步骤（`detail` 为空），并断言 `.chat-msg-main > .chat-step` 存在。设计 C4 行没写步骤；但原 fixture 的 `steps` 为空、`error` 为 null，`{steps}{error}` 不产生任何 DOM，注入 10 把 `<MessageActions>` 挪到它们之前后 `lastElementChild` 不变，用例仍绿（实测 9/9 绿）。加上步骤后，注入 10 让该用例在 `lastElementChild` 断言处变红。`error` 无法经快照注入（`session-contract.ts:110` 只接受六个键），所以选步骤。
