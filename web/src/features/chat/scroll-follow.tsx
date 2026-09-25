/* "回到最新" and bottom-follow for the chat transcript (S1e 4.5 / parent design D8), behavior
   adapted from resource/workbuddy-live-demo.html:2488-2520. */
import {
  type ReactNode,
  type RefObject,
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: a content change is the follow trigger.
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
