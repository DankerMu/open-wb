/* Slash candidates of the composer (issue 556): the catalogues of `GET /api/commands`, one per
   workspace id (issue 814), fetched lazily and kept for the client, the panel above the textarea
   and the keys it takes from the composer. The focus never leaves the textarea: the panel and its
   options are no tab stops and a press on the panel is prevented from taking the focus. The 「+」
   menu of the capability bar lists the same catalogues: its open state is kept here so that it
   asks for them by the very rule of the panel. */
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { Command } from "../../lib/api-commands.js";
import { filter, initialState, isOpen, pickText, reduce } from "./slash-menu-state.js";

type ComposerKeyEvent = KeyboardEvent<HTMLTextAreaElement>;
type KeyAction = "down" | "up" | "pick" | "dismiss";
/** The workspace a catalogue belongs to; null is the account's own root (no workspace). */
type WorkspaceKey = string | null;

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

/** The tag of a project skill, null for every other command. */
export function sourceTag({ source, overrides }: Command): string | null {
  if (source !== "project") return null;
  return overrides ? "项目 · 覆盖平台技能" : "项目";
}

function SlashOption({ command }: { command: Command }) {
  const tag = sourceTag(command);
  return (
    <>
      <span className="font-medium text-foreground" data-slot="slash-label">
        {command.label}
      </span>
      {tag === null ? null : (
        <span
          className="rounded bg-(--wb-brand-primary-subtle) px-1.5 text-xs text-(--wb-brand-primary-deep)"
          data-slot="slash-tag"
        >
          {tag}
        </span>
      )}
      <span className="text-muted-foreground" data-slot="slash-desc">
        {command.description}
      </span>
      {command.hint === null ? null : (
        <span className="ml-auto text-xs text-(--wb-text-tertiary)" data-slot="slash-hint">
          {command.hint}
        </span>
      )}
    </>
  );
}

/**
 * The panel: the first child of the composer card, above the textarea, with a rule between the
 * two. It scrolls inside a bounded height (the key handler keeps the highlighted option in view);
 * an option is one row of label, description and hint that wraps on a narrow card.
 */
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
      className="max-h-55 flex-none overflow-y-auto border-b border-border pb-2"
      data-slot="slash-menu"
      onMouseDown={(event) => event.preventDefault()}
      role="listbox"
      tabIndex={-1}
    >
      {matches.map((command, index) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: 按键由保持焦点的输入框处理（interceptKeyDown）。
        <div
          aria-selected={index === active}
          className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-[13px] leading-5 wrap-anywhere aria-selected:bg-accent"
          id={optionId(id, index)}
          key={command.name}
          onClick={() => onPick(command)}
          role="option"
          tabIndex={-1}
        >
          <SlashOption command={command} />
        </div>
      ))}
    </div>
  );
}

/**
 * Whether the 「+」 menu can be opened and is open: `disabled` while the composer is not `enabled`,
 * and an open menu closes then (reset during render) and stays closed. `locked` (the command items
 * cannot be picked) follows the draft only while the menu is open: true while the draft is not
 * blank. A closed menu keeps the last value, so its items do not change while it fades out.
 */
function usePlusState(enabled: boolean, draft: string) {
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const nonBlank = draft.trim() !== "";
  if (open && !enabled) setOpen(false);
  if (open && enabled && locked !== nonBlank) setLocked(nonBlank);
  return { disabled: !enabled, locked, open: open && enabled, onOpenChange: setOpen };
}

/**
 * The slash candidates of the composer holding `draft`. `menu` is the panel (null while hidden)
 * and `interceptKeyDown` takes the panel's keys before the composer's Enter rule; it returns true
 * for a key it handled and never while the panel is hidden.
 *
 * `workspaceId` names the catalogue: the workspace of the selected session or, in the welcome
 * state, the one chosen in the composer footer; null without a workspace and undefined while it is
 * not known yet (a requested session that is not resolved), which hides the panel and asks nothing.
 *
 * The panel is wanted while the composer is `enabled`, the workspace is known and the draft is a
 * slash without whitespace. The catalogues belong to `client`, one per workspace id: one
 * `listCommands(workspaceId)` call is issued when the panel becomes wanted, or the client or the
 * workspace id changes while it is wanted, unless a call for this client and workspace id is in
 * flight or has succeeded. Only the catalogue of the current workspace id is ever shown; the others
 * stay held. A failed call is silent and retried only at the next such moment, not on further
 * typing. The calls are aborted only on unmount or on a change of the client, not when the panel
 * stops being wanted or the workspace id changes. The highlight and the dismissal follow the draft,
 * and the highlight alone also follows the workspace id: a change of it returns to the first option
 * and leaves a dismissal in place (both reset during render, as in conversation-search.tsx); the
 * highlighted option is scrolled into view from the key handler.
 *
 * `plus` is the 「+」 menu of the capability bar. It can be opened while the composer is `enabled`,
 * whatever the draft; it is `disabled` otherwise, and an open one closes (reset during render) and
 * stays closed. While it is open the catalogue is wanted exactly as for the panel, so the same
 * single call per client and workspace id serves both, and its command items are `locked` (not to
 * be picked) while the draft is not blank (anything but whitespace). `commands` is the catalogue
 * of the current workspace id, undefined while it is not held (in flight, failed, or the workspace
 * id unknown) and the same whether the menu is open or not, so a closing menu keeps its items;
 * `onPick` closes the menu and leaves the draft the panel's pick leaves, and does nothing while
 * the menu is `disabled` or the draft is not blank.
 */
export function useSlashMenu(
  client: ApiClient,
  workspaceId: WorkspaceKey | undefined,
  draft: string,
  enabled: boolean,
  setDraft: (text: string) => void,
): {
  menu: ReactNode;
  interceptKeyDown(event: ComposerKeyEvent): boolean;
  plus: {
    commands: readonly Command[] | undefined;
    disabled: boolean;
    locked: boolean;
    open: boolean;
    onOpenChange(open: boolean): void;
    onPick(command: Command): void;
  };
} {
  const id = useId();
  const [catalogues, setCatalogues] = useState<{
    client: ApiClient;
    byWorkspace: ReadonlyMap<WorkspaceKey, Command[]>;
  } | null>(null);
  const [stored, setState] = useState(() => initialState(draft));
  /** The workspace id the stored highlight belongs to. */
  const [shown, setShown] = useState(workspaceId);
  /**
   * The catalogue calls of the current client by workspace id, each kept once it succeeded and
   * dropped when it failed.
   */
  const calls = useRef<{
    client: ApiClient;
    byWorkspace: Map<WorkspaceKey, AbortController>;
  } | null>(null);
  const plusState = usePlusState(enabled, draft);
  /**
   * The workspace id whose catalogue the panel or the open 「+」 menu wants; undefined while
   * neither is wanted.
   */
  const wanted = enabled && (isOpen(draft) || plusState.open) ? workspaceId : undefined;

  useEffect(() => {
    if (wanted === undefined) return;
    if (calls.current?.client !== client) calls.current = { client, byWorkspace: new Map() };
    const own = calls.current;
    if (own.byWorkspace.has(wanted)) return;
    const controller = new AbortController();
    own.byWorkspace.set(wanted, controller);
    void client.listCommands(wanted, { signal: controller.signal }).then(
      (commands) => {
        if (controller.signal.aborted) return;
        setCatalogues((held) => ({
          client,
          byWorkspace: new Map(held?.client === client ? held.byWorkspace : []).set(
            wanted,
            commands,
          ),
        }));
      },
      () => {
        if (own.byWorkspace.get(wanted) === controller) own.byWorkspace.delete(wanted);
      },
    );
  }, [client, wanted]);
  useEffect(
    () => () => {
      if (calls.current?.client === client) {
        for (const controller of calls.current.byWorkspace.values()) controller.abort();
        calls.current = null;
      }
    },
    [client],
  );

  let state = reduce(stored, { type: "draft", draft });
  if (shown !== workspaceId) {
    setShown(workspaceId);
    state = reduce(state, { type: "catalogue" });
  }
  if (state !== stored) setState(state);

  // Held for the current workspace id whether or not anything wants it: the closing 「+」 menu
  // still lists it while it fades out. The panel alone needs it to be wanted.
  const commands =
    workspaceId !== undefined && catalogues?.client === client
      ? catalogues.byWorkspace.get(workspaceId)
      : undefined;
  const matches =
    wanted !== undefined && commands !== undefined && !state.dismissed
      ? filter(commands, draft)
      : [];
  // The index outlives a catalogue that got shorter under the same draft and workspace id (another
  // client): 0 then.
  const active = state.index < matches.length ? state.index : 0;
  const current = matches[active];
  const pick = (command: Command) => setDraft(pickText(command.name));
  // The items of a closing menu are still there to be picked: nothing lands once it is disabled or
  // the draft is not blank. Closed before the draft is written: the menu commits the pick before it
  // closes itself, and a frame of an open menu over the picked draft would lock its fading items.
  const onPick = (command: Command) => {
    if (!enabled || draft.trim() !== "") return;
    plusState.onOpenChange(false);
    pick(command);
  };
  const plus = { ...plusState, commands, onPick };
  if (current === undefined) return { menu: null, interceptKeyDown: () => false, plus };

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
    plus,
  };
}
