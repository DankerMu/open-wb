/* "回到最新" and bottom-follow for the chat transcript (S1e 4.5 / parent design D8), behavior
   adapted from resource/workbuddy-live-demo.html:2488-2520. */
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../../ui/index.js";

const PIN_TOLERANCE_PX = 4;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/* Read-only recompute after a layout change (content update, container or content resize):
   it reads `pinned` but never writes it, and may only raise the jump button. */
function settle(
  el: HTMLElement,
  pinned: RefObject<boolean>,
  setShowJump: Dispatch<SetStateAction<boolean>>,
) {
  if (pinned.current) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  if (distanceFromBottom(el) > el.clientHeight) setShowJump(true);
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
