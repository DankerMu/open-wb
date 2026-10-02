/* "回到最新" and bottom-follow for the chat transcript (S1e 4.5 / parent design D8), behavior
   adapted from resource/workbuddy-live-demo.html:2488-2520. */
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

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/* Recompute after a layout change (content update, container or content resize). A pinned
   transcript is scrolled to the bottom. An unpinned one keeps its `scrollTop`: if the change
   brought it within the tolerance of the bottom it is pinned and the jump button hidden, as a
   user scroll to the bottom would; otherwise the button may only be raised. It never unpins. */
function settle(
  el: HTMLElement,
  pinned: RefObject<boolean>,
  setShowJump: Dispatch<SetStateAction<boolean>>,
) {
  if (pinned.current) {
    el.scrollTop = el.scrollHeight;
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

function useScrollFollow(ref: RefObject<HTMLDivElement | null>, content: unknown) {
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const contentRoot = useRef<Element | null>(null);

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

  // Size changes without a content change (alerts above the transcript, viewport height,
  // expanding a step card's <details>) fire no scroll event; observe them. Declared before the
  // content effect so the observer exists when that effect binds the content root.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => settle(el, pinned, setShowJump));
    resize.observe(el);
    observer.current = resize;
    return () => {
      resize.disconnect();
      observer.current = null;
      contentRoot.current = null;
    };
  }, [ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a content change is the follow trigger.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = observer.current;
    const root = el.firstElementChild;
    if (resize && root !== contentRoot.current) {
      if (contentRoot.current) resize.unobserve(contentRoot.current);
      if (root) resize.observe(root);
      contentRoot.current = root;
    }
    settle(el, pinned, setShowJump);
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

/** What the transcript offers to the in-conversation search (issue 538). */
export type TranscriptHandle = { scrollToMessage(id: number): void };

export function FollowTranscript({
  children,
  content,
  handleRef,
}: {
  children: ReactNode;
  content: unknown;
  handleRef: Ref<TranscriptHandle>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { jumpToLatest, onScroll, showJump } = useScrollFollow(ref, content);
  /* Scrolls the message `id` of this transcript into the centre and recomputes the follow state
     at once, as a user scroll would. The browser dispatches the scroll event a frame later; a
     delta streamed before that would find the transcript still pinned and pull it back to the
     bottom. Does nothing for a message the transcript does not hold. */
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
