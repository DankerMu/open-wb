/* The pure state of the composer's slash candidates (issue 556): when the panel is wanted, which
   commands it lists, the text a pick leaves in the draft, and the highlight and dismissal of one
   draft, the highlight also of one catalogue; the skills of a catalogue and the catalogue without
   the disabled ones (s1d-experts-skills D9). No React: `slash-menu.tsx` owns the catalogues and
   the keys. */
import type { Command } from "../../lib/api-commands.js";

/**
 * The highlight (`index` among the listed commands) and the dismissal, both of `draft` only; the
 * highlight is also of one catalogue only (the `catalogue` action).
 */
export type SlashMenuState = { draft: string; index: number; dismissed: boolean };

type SlashMenuAction =
  | { type: "draft"; draft: string }
  | { type: "move"; delta: 1 | -1; count: number }
  | { type: "dismiss" }
  | { type: "catalogue" };

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

/** The prefix of a skill's command name: `skill:<name>`, `<name>` being what a session disables. */
const SKILL_PREFIX = "skill:";

/** The skill a command runs (`deploy` for `skill:deploy`), null for every other command. */
export function skillName({ name }: Command): string | null {
  return name.startsWith(SKILL_PREFIX) ? name.slice(SKILL_PREFIX.length) : null;
}

/** The skills of a catalogue, in catalogue order: what the capability popover lists. */
export function skillEntries(commands: readonly Command[]): Command[] {
  return commands.filter((command) => skillName(command) !== null);
}

/**
 * The catalogue without the skills named in `disabled` (skill-switches「停用技能对 omp 生效」): what the
 * 「+」 menu and the panel list. `null` filters nothing (the set is not known).
 */
export function withoutDisabled(
  commands: readonly Command[],
  disabled: readonly string[] | null,
): readonly Command[] {
  if (disabled === null || disabled.length === 0) return commands;
  return commands.filter((command) => !disabled.includes(skillName(command) ?? ""));
}

/** The draft a pick leaves: the trailing space ends the command, so the panel closes. */
export function pickText(name: string): string {
  return `/${name} `;
}

/**
 * `draft` follows the composer: the same text keeps the state (the same object), any other text
 * starts over on the first option and undoes a dismissal. `move` steps the highlight cyclically
 * over `count` options and `dismiss` closes the panel until the draft changes. `catalogue` tells
 * that the workspace id of the listed catalogue changed: the highlight returns to the first option,
 * the dismissal stays.
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
    case "catalogue":
      return state.index === 0 ? state : { ...state, index: 0 };
  }
}
