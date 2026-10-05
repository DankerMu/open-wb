/* In-conversation search (issue 538), adapted from resource/workbuddy-live-demo.html:1945-1952
   (the box) and :2002-2031 (open/close, Enter / Shift+Enter / Escape, the counter). Unlike the demo
   a jump scrolls the message into view and highlights it instead of toasting, and the input is
   not debounced. The box is built on the copied `Input` and `Button` (s1f-chat-surface 8.1). */
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon, type IconName } from "../../ui/index.js";
import { matchMessages } from "./search-match.js";
import type { ChatState } from "./stream.js";
import type { TranscriptHandle } from "./thread-viewport.js";

/** The open search of one session; `currentId` is the message of the current match. */
type SearchState = { sessionId: string; query: string; currentId: number | null };

const NO_MESSAGES: ChatState["messages"] = [];

/**
 * The match a step lands on, wrapping at both ends; `index` is -1 while there is no current match,
 * from where a step forward takes the first match and a step back the last. Undefined without a
 * match.
 */
function stepTarget(
  matches: readonly number[],
  index: number,
  forward: boolean,
): number | undefined {
  const total = matches.length;
  if (total === 0) return undefined;
  return forward ? matches[(index + 1) % total] : matches[(index <= 0 ? total : index) - 1];
}

/** An icon button of the box: `label` is both its accessible name and its tooltip. */
function BoxButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick(): void;
}) {
  return (
    <Button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      size="icon"
      title={label}
      type="button"
      variant="ghost"
    >
      <Icon name={icon} size={14} />
    </Button>
  );
}

/**
 * The search box, mounted only while the search is open; it focuses its input on mount. `index` is
 * the place of the current match among the `total` matches, -1 for none. Enter, Shift+Enter and
 * Escape are handled on the input only and not while an input method is composing.
 */
function SearchBox({
  index,
  onClose,
  onQuery,
  onStep,
  query,
  total,
}: {
  index: number;
  onClose(): void;
  onQuery(query: string): void;
  onStep(forward: boolean): void;
  query: string;
  total: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(!event.shiftKey);
    } else if (event.key === "Escape") {
      // The native action of a search input on Escape is to clear it.
      event.preventDefault();
      onClose();
    }
  }
  return (
    // A fixed row at the top right corner of the page column, above the alerts and the transcript;
    // it never grows wider than the column and the field alone gives way. The column clips its
    // overflow, so the padding keeps the focus ring inside the box at the top and on both sides.
    // biome-ignore lint/a11y/useSemanticElements: the implicit role of <search> is unreliable in jsdom queries and older browsers.
    <div
      aria-label="对话内搜索"
      className="flex max-w-full flex-none items-center gap-1.5 self-end px-1 pt-1"
      data-slot="conversation-search"
      role="search"
    >
      <div className="relative w-60 min-w-0 shrink">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-(--wb-icon-muted)">
          <Icon name="search" size={14} />
        </span>
        <Input
          aria-label="搜索对话内容"
          className="pl-8"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索对话内容"
          ref={input}
          type="search"
          value={query}
        />
      </div>
      {/* One text node: a non-atomic live region announces only the node that changed. */}
      <span
        aria-live="polite"
        className="flex-none font-mono text-[11px] text-(--wb-text-secondary)"
        data-slot="search-count"
      >{`${index + 1}/${total}`}</span>
      <BoxButton
        disabled={total === 0}
        icon="chevron-up"
        label="上一个"
        onClick={() => onStep(false)}
      />
      <BoxButton
        disabled={total === 0}
        icon="chevron-down"
        label="下一个"
        onClick={() => onStep(true)}
      />
      <BoxButton icon="x" label="关闭" onClick={onClose} />
    </div>
  );
}

/**
 * The in-conversation search of the session page. `sessionId` is the session the top bar shows
 * (undefined in the welcome state and while the title is unknown), `view` the current chat view,
 * `null` while there is none. `slot` is the top-bar slot, `box` the search box (null while closed),
 * `currentId` the message to highlight and `handleRef` the handle the transcript fills.
 *
 * The whole state is one object keyed on the session: another session, or none, closes the search
 * and drops its query. Matches, the place of the current match and the counter are derived on
 * every render. A current match that stopped matching is cleared, not merely hidden, so it does
 * not come back when the message matches again. The transcript is scrolled from the three event
 * handlers only (query change, step forward, step back): a change of the messages never scrolls.
 * Message ids are compared with `=== null` / `=== -1`: `0` and negative ids are valid.
 */
export function useConversationSearch(
  sessionId: string | undefined,
  view: ChatState | null,
): {
  slot: { expanded: boolean; onSelect(trigger: HTMLElement): void };
  currentId: number | null;
  handleRef: RefObject<TranscriptHandle | null>;
  box: ReactNode;
} {
  const [stored, setState] = useState<SearchState | null>(null);
  /** The top-bar button that opened the search; it stays mounted while the search is open. */
  const trigger = useRef<HTMLElement | null>(null);
  const handleRef = useRef<TranscriptHandle | null>(null);
  const state = stored !== null && stored.sessionId === sessionId ? stored : null;
  if (stored !== state) setState(null);

  // A click does not always focus the button (Safari), so closing focuses it explicitly.
  function close() {
    trigger.current?.focus();
    setState(null);
  }
  const slot = {
    expanded: state !== null,
    onSelect(button: HTMLElement) {
      if (state !== null) {
        button.focus();
        setState(null);
      } else if (sessionId !== undefined) {
        trigger.current = button;
        setState({ sessionId, query: "", currentId: null });
      }
    },
  };
  if (state === null) return { slot, currentId: null, handleRef, box: null };

  const messages = view?.messages ?? NO_MESSAGES;
  const matches = matchMessages(messages, state.query);
  const index = state.currentId === null ? -1 : matches.indexOf(state.currentId);
  if (state.currentId !== null && index === -1) setState({ ...state, currentId: null });

  const changeQuery = (query: string) => {
    const first = matchMessages(messages, query)[0] ?? null;
    setState({ ...state, query, currentId: first });
    if (first !== null) handleRef.current?.scrollToMessage(first);
  };
  const step = (forward: boolean) => {
    const target = stepTarget(matches, index, forward);
    if (target === undefined) return;
    setState({ ...state, currentId: target });
    handleRef.current?.scrollToMessage(target);
  };
  return {
    slot,
    currentId: index === -1 ? null : state.currentId,
    handleRef,
    box: (
      <SearchBox
        index={index}
        onClose={close}
        onQuery={changeQuery}
        onStep={step}
        query={state.query}
        total={matches.length}
      />
    ),
  };
}
