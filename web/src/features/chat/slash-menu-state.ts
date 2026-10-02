/* The pure state of the composer's slash candidates (issue 556): when the panel is wanted, which
   commands it lists, the text a pick leaves in the draft, and the highlight and dismissal of one
   draft. No React: `slash-menu.tsx` owns the catalogue and the keys. */
import type { Command } from "../../lib/api-commands.js";

/** The highlight (`index` among the listed commands) and the dismissal, both of `draft` only. */
export type SlashMenuState = { draft: string; index: number; dismissed: boolean };

type SlashMenuAction =
  | { type: "draft"; draft: string }
  | { type: "move"; delta: 1 | -1; count: number }
  | { type: "dismiss" };

/** A slash followed by no whitespace at all: the draft is still the command being typed. */
const COMMAND_PREFIX = /^\/[^\s]*$/;

export function initialState(draft: string): SlashMenuState {
  return { draft, index: 0, dismissed: false };
}

export function isOpen(draft: string): boolean {
  return COMMAND_PREFIX.test(draft);
}

/**
 * The commands whose name or label starts with the text typed after the slash, case-sensitive and
 * in catalogue order; none for a draft that is not open.
 */
export function filter(commands: readonly Command[], draft: string): Command[] {
  if (!isOpen(draft)) return [];
  const prefix = draft.slice(1);
  return commands.filter(({ name, label }) => name.startsWith(prefix) || label.startsWith(prefix));
}

/** The draft a pick leaves: the trailing space ends the command, so the panel closes. */
export function pickText(name: string): string {
  return `/${name} `;
}

/**
 * `draft` follows the composer: the same text keeps the state (the same object), any other text
 * starts over on the first option and undoes a dismissal. `move` steps the highlight cyclically
 * over `count` options and `dismiss` closes the panel until the draft changes.
 */
export function reduce(state: SlashMenuState, action: SlashMenuAction): SlashMenuState {
  switch (action.type) {
    case "draft":
      return action.draft === state.draft ? state : initialState(action.draft);
    case "move":
      if (action.count === 0) return state;
      return { ...state, index: (state.index + action.delta + action.count) % action.count };
    case "dismiss":
      return { ...state, dismissed: true };
  }
}
