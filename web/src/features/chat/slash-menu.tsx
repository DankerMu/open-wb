/* Slash candidates of the composer (issue 556): the catalogue of `GET /api/commands`, fetched
   lazily and kept for the page mount, the panel above the textarea and the keys it takes from the
   composer. The focus never leaves the textarea: the panel and its options are no tab stops and a
   press on the panel is prevented from taking the focus. */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { Command } from "../../lib/api-commands.js";
import { filter, initialState, isOpen, pickText, reduce } from "./slash-menu-state.js";

type ComposerKeyEvent = KeyboardEvent<HTMLTextAreaElement>;
type KeyAction = "down" | "up" | "pick" | "dismiss";

const HIDDEN = { menu: null, interceptKeyDown: () => false };

function optionId(id: string, index: number) {
  return `${id}-${index}`;
}

/**
 * What a key does to the shown panel; null leaves the key to the composer. Keys of an input method
 * composition (the composer's own rule) and keys with Ctrl, Alt or Meta are never taken, and
 * neither is Shift with an arrow, Enter or Tab.
 */
function keyAction(event: ComposerKeyEvent): KeyAction | null {
  const { isComposing, keyCode } = event.nativeEvent;
  if (isComposing || keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === "Escape") return "dismiss";
  if (event.shiftKey) return null;
  switch (event.key) {
    case "ArrowDown":
      return "down";
    case "ArrowUp":
      return "up";
    case "Enter":
    case "Tab":
      return "pick";
    default:
      return null;
  }
}

function SlashMenu({
  active,
  id,
  matches,
  onPick,
}: {
  active: number;
  id: string;
  matches: readonly Command[];
  onPick(command: Command): void;
}) {
  return (
    <div
      aria-activedescendant={optionId(id, active)}
      aria-label="命令候选"
      className="chat-slash"
      onMouseDown={(event) => event.preventDefault()}
      role="listbox"
      tabIndex={-1}
    >
      {matches.map((command, index) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: 按键由保持焦点的输入框处理（interceptKeyDown）。
        <div
          aria-selected={index === active}
          className={
            index === active ? "chat-slash-option chat-slash-option--active" : "chat-slash-option"
          }
          id={optionId(id, index)}
          key={command.name}
          onClick={() => onPick(command)}
          role="option"
          tabIndex={-1}
        >
          <span className="chat-slash-label">{command.label}</span>
          <span className="chat-slash-desc">{command.description}</span>
          {command.hint === null ? null : <span className="chat-slash-hint">{command.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * The slash candidates of the composer holding `draft`. `menu` is the panel (null while hidden)
 * and `interceptKeyDown` takes the panel's keys before the composer's Enter rule; it returns true
 * for a key it handled and never while the panel is hidden.
 *
 * The panel is wanted while the composer is `enabled` and the draft is a slash without whitespace.
 * The catalogue belongs to `client`: one `listCommands()` call is issued when the panel becomes
 * wanted, or the client changes while it is wanted, unless a call for this client is in flight or
 * has succeeded. A failed call is silent and retried only at the next such moment, not on further
 * typing. The call is aborted only on unmount or on a change of the client, not when the panel
 * stops being wanted. The highlight and the dismissal follow the draft (reset during render, as
 * in conversation-search.tsx); the highlighted option is scrolled into view from the key handler.
 */
export function useSlashMenu(
  client: ApiClient,
  draft: string,
  enabled: boolean,
  setDraft: (text: string) => void,
): { menu: ReactNode; interceptKeyDown(event: ComposerKeyEvent): boolean } {
  const id = useId();
  const [catalogue, setCatalogue] = useState<{ client: ApiClient; commands: Command[] } | null>(
    null,
  );
  const [stored, setState] = useState(() => initialState(draft));
  /** The catalogue call of the current client, kept once it succeeded and dropped when it failed. */
  const call = useRef<{ client: ApiClient; controller: AbortController } | null>(null);
  const wanted = enabled && isOpen(draft);

  useEffect(() => {
    if (!wanted || call.current?.client === client) return;
    const own = { client, controller: new AbortController() };
    call.current = own;
    void client.listCommands({ signal: own.controller.signal }).then(
      (commands) => {
        if (!own.controller.signal.aborted) setCatalogue({ client, commands });
      },
      () => {
        if (call.current === own) call.current = null;
      },
    );
  }, [client, wanted]);
  useEffect(
    () => () => {
      if (call.current?.client === client) {
        call.current.controller.abort();
        call.current = null;
      }
    },
    [client],
  );

  const state = reduce(stored, { type: "draft", draft });
  if (state !== stored) setState(state);

  const commands = catalogue?.client === client ? catalogue.commands : null;
  const matches = wanted && commands !== null && !state.dismissed ? filter(commands, draft) : [];
  // The index outlives a catalogue that got shorter under the same draft (another client): 0 then.
  const active = state.index < matches.length ? state.index : 0;
  const current = matches[active];
  if (current === undefined) return HIDDEN;

  const pick = (command: Command) => setDraft(pickText(command.name));
  const interceptKeyDown = (event: ComposerKeyEvent) => {
    const action = keyAction(event);
    if (action === null) return false;
    event.preventDefault();
    if (action === "dismiss") {
      setState(reduce(state, { type: "dismiss" }));
    } else if (action === "pick") {
      pick(current);
    } else {
      const delta = action === "down" ? 1 : -1;
      const next = reduce(
        { ...state, index: active },
        { type: "move", delta, count: matches.length },
      );
      setState(next);
      document.getElementById(optionId(id, next.index))?.scrollIntoView({ block: "nearest" });
    }
    return true;
  };
  return {
    menu: <SlashMenu active={active} id={id} matches={matches} onPick={pick} />,
    interceptKeyDown,
  };
}
