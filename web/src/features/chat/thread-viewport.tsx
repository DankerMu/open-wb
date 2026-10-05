// 线程滚动层（design D4）：滚动容器是 `ThreadPrimitive.Viewport`，贴底跟随、`回到最新` 与对话内搜索的
// `scrollToMessage` 在应用层。基元自带的跟随整体关掉，转录区只有这里一处写 `scrollTop`——它的规则与
// chat-web「转录区尺寸变化触发贴底重算」对不上：贴底阈值是 1px（规格 4px）；回底控件一离底就可用、
// 贴底时是禁用占位（规格：距底超过一屏才出现，滞回，贴底时不渲染）；`scrollHeight` 变过的上滚不算
// 用户上滚（规格：`scrollTop` 变小即是）；打开会话的回底排在下一帧。
import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import {
  type Dispatch,
  type ReactNode,
  type Ref,
  type RefObject,
  type SetStateAction,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../../ui/index.js";

const PIN_TOLERANCE_PX = 4;

const NATIVE_FOLLOW_OFF = {
  autoScroll: false,
  scrollToBottomOnInitialize: false,
  scrollToBottomOnRunStart: false,
  scrollToBottomOnThreadSwitch: false,
} as const;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/* 写到底部，并记下写完后元素报告的 `scrollTop`（被钳制后的值，不是赋进去的 `scrollHeight`），
   这次写入引发的 scroll 事件才不会被当成用户滚动。 */
function scrollToBottom(el: HTMLElement, lastTop: RefObject<number>) {
  el.scrollTop = el.scrollHeight;
  lastTop.current = el.scrollTop;
}

/* 布局变化（内容更新、容器或内容尺寸变化）后的重算。贴底的转录滚到底；未贴底的不动 `scrollTop`：
   变化把它带进距底容差内就恢复贴底并收起按钮（同用户滚到底），否则只可能把按钮升起。从不解除贴底。 */
function settle(
  el: HTMLElement,
  pinned: RefObject<boolean>,
  lastTop: RefObject<number>,
  setShowJump: Dispatch<SetStateAction<boolean>>,
) {
  if (pinned.current) {
    scrollToBottom(el, lastTop);
    return;
  }
  const distance = distanceFromBottom(el);
  if (distance <= PIN_TOLERANCE_PX) {
    pinned.current = true;
    setShowJump(false);
    return;
  }
  if (distance > el.clientHeight) setShowJump(true);
}

function useScrollFollow(ref: RefObject<HTMLDivElement | null>) {
  const pinned = useRef(true);
  // 上一次 scroll 事件或贴底写入时的 `scrollTop`；挂载时的 `settle()` 给它初值。
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const contentRoot = useRef<Element | null>(null);
  /* 内容更新的触发量取运行时的消息，不取应用的状态：运行时在被动 effect 里才同步适配器数据，
     应用状态变化的那次提交里 DOM 还是上一份；消息变化的这次提交里新消息与各块已在 DOM 里。
     助手正文（拷入层 `markdown-text` 带 `defer`）还要再晚一次延后渲染才落到 DOM，那一次由
     下面对内容根的尺寸观察接住。 */
  const messages = useAuiState((state) => state.thread.messages);

  /* 只有 `scrollTop` 变小才是用户上滚并解除贴底。离底而 `scrollTop` 没变小的 scroll 事件，是贴底
     写入之后容器变矮或内容变高的回声（直接打开会话时，宽屏顶栏在同一帧、写入之后才挂载）：
     按布局变化重算。 */
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const movedUp = el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;
    const distance = distanceFromBottom(el);
    if (distance <= PIN_TOLERANCE_PX) {
      pinned.current = true;
      setShowJump(false);
      return;
    }
    if (!movedUp) {
      settle(el, pinned, lastTop, setShowJump);
      return;
    }
    pinned.current = false;
    if (distance > el.clientHeight) setShowJump(true);
  }, [ref]);

  // 没有内容变化的尺寸变化（转录上方的提示、视口高度、展开步骤卡的 <details>）不触发 scroll 事件，
  // 靠观察。声明在内容 effect 之前：那个 effect 绑定内容根时观察器已经在了。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => settle(el, pinned, lastTop, setShowJump));
    resize.observe(el);
    observer.current = resize;
    return () => {
      resize.disconnect();
      observer.current = null;
      contentRoot.current = null;
    };
  }, [ref]);

  // 内容根随历史到达才渲染：每次渲染后核对一次，换了就改绑。
  useLayoutEffect(() => {
    const resize = observer.current;
    const root = ref.current?.firstElementChild ?? null;
    if (!resize || root === contentRoot.current) return;
    if (contentRoot.current) resize.unobserve(contentRoot.current);
    if (root) resize.observe(root);
    contentRoot.current = root;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息变化就是跟随的触发量。
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) settle(el, pinned, lastTop, setShowJump);
  }, [messages, ref]);

  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setShowJump(false);
    scrollToBottom(el, lastTop);
  }, [ref]);

  return { jumpToLatest, onScroll, showJump };
}

/** 线程滚动层交给对话内搜索的句柄（conversation-search「跳转与消息级高亮」）。 */
export type TranscriptHandle = { scrollToMessage(id: number): void };

/** 选中会话的滚动容器与 `回到最新`；须在运行时 provider 之内。`children` 是线程的内容根（至多一个元素）。 */
export function ThreadViewport({
  children,
  handleRef,
}: {
  children: ReactNode;
  handleRef: Ref<TranscriptHandle>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { jumpToLatest, onScroll, showJump } = useScrollFollow(ref);
  /* 把本线程里的消息 `id` 滚到中间，并立刻按用户滚动的规则重算跟随状态。浏览器晚一帧才派发 scroll
     事件；在那之前到达的增量会看到转录仍贴底，把它拉回底部。线程里没有这条消息时什么都不做。 */
  useImperativeHandle(
    handleRef,
    () => ({
      scrollToMessage(id) {
        const target = ref.current?.querySelector(`[data-message-id="${id}"]`);
        if (!target) return;
        target.scrollIntoView({ block: "center" });
        onScroll();
      },
    }),
    [onScroll],
  );
  const viewport = {
    className: "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto",
    "data-slot": "thread-viewport",
    onScroll,
    ref,
  };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 基元无条件 `new ResizeObserver`；没有它的运行环境退回普通 div，只在内容更新时重算。 */}
      {typeof ResizeObserver === "undefined" ? (
        <div {...viewport}>{children}</div>
      ) : (
        <ThreadPrimitive.Viewport {...NATIVE_FOLLOW_OFF} {...viewport}>
          {children}
        </ThreadPrimitive.Viewport>
      )}
      {showJump ? (
        <button
          className="absolute bottom-4 left-1/2 z-1 inline-flex h-[30px] -translate-x-1/2 cursor-pointer items-center gap-[5px] rounded-full! border border-(--wb-border-default) bg-(--wb-bg-primary) px-3.5 text-[12.5px] whitespace-nowrap text-(--wb-text-secondary) shadow-(--wb-shadow-popover) transition-colors hover:border-(--wb-text-tertiary) hover:text-(--wb-text-primary) motion-reduce:transition-none"
          onClick={jumpToLatest}
          type="button"
        >
          <Icon name="chevron-down" size={12} />
          回到最新
        </button>
      ) : null}
    </div>
  );
}
