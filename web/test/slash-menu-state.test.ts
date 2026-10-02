/**
 * Issue 556 (parent tasks 10.5) the pure state of the slash candidates: M1–M11 of
 * openspec/changes/slash-command-menu/design.md. Seam: the functions of
 * web/src/features/chat/slash-menu-state.ts called directly. Expected values are literals from the
 * issue's ten cases and the spec delta (`^\/[^\s]*$`, case-sensitive prefix of name or label,
 * `/<name> ` with one trailing space, cyclic highlight).
 */
import { describe, expect, it } from "vitest";
import {
  filter,
  initialState,
  isOpen,
  pickText,
  reduce,
  type SlashMenuState,
} from "../src/features/chat/slash-menu-state.js";
import { CATALOGUE, COMPACT, skill, TODO, WEEKLY } from "./chat-page-slash-support.js";

const WRITER = skill("writer", "写作");
/** Two builtins, then two skills. */
const WITH_SKILLS = [...CATALOGUE, WRITER];

const names = (draft: string, commands = CATALOGUE) =>
  filter(commands, draft).map((command) => command.name);

/** `count` steps of `delta` from `start` over `total` options; the index after each step. */
function walk(start: number, delta: 1 | -1, total: number, count: number) {
  const visited: number[] = [];
  let state: SlashMenuState = { draft: "/", index: start, dismissed: false };
  for (let step = 0; step < count; step += 1) {
    state = reduce(state, { type: "move", delta, count: total });
    visited.push(state.index);
  }
  return visited;
}

describe("打开条件与过滤 (M1–M5, M11)", () => {
  it("M1 a lone slash lists the whole catalogue in its order", () => {
    expect(isOpen("/")).toBe(true);
    expect(filter(CATALOGUE, "/")).toEqual([COMPACT, TODO, WEEKLY]);
    expect(names("/", [WEEKLY, TODO, COMPACT])).toEqual(["skill:weekly-report", "todo", "compact"]);
  });

  it("M2 /t keeps todo alone, by the prefix of its name", () => {
    expect(isOpen("/t")).toBe(true);
    expect(filter(CATALOGUE, "/t")).toEqual([TODO]);
    expect(names("/todo")).toEqual(["todo"]);
    expect(names("/todos")).toEqual([]);
  });

  it("M3 /整 keeps 整理上下文, by the prefix of its label", () => {
    expect(filter(CATALOGUE, "/整")).toEqual([COMPACT]);
    expect(names("/任")).toEqual(["todo"]);
    // A prefix, not a substring: 理 is inside the label, 务 inside 任务清单.
    expect(names("/理")).toEqual([]);
    expect(names("/odo")).toEqual([]);
  });

  it("M4 /T matches nothing: the prefix is case-sensitive", () => {
    expect(isOpen("/T")).toBe(true);
    expect(names("/T")).toEqual([]);
    expect(names("/Todo")).toEqual([]);
    expect(names("/W")).toEqual([]);
  });

  it.each([
    ["a space after the command", "/todo x"],
    ["a trailing space", "/todo "],
    ["a leading space", " /todo"],
    ["the empty draft", ""],
    ["no slash", "todo"],
    ["a line break", "/todo\n"],
    ["a tab", "/to\tdo"],
    ["a slash later in the text", "a/todo"],
  ])("M5 %s closes the panel and filters to nothing", (_label, draft) => {
    expect(isOpen(draft)).toBe(false);
    expect(filter(CATALOGUE, draft)).toEqual([]);
  });

  it("M11 /w matches the skill by label, /skill:w by name, and /skill every skill but no builtin", () => {
    expect(filter(WITH_SKILLS, "/w")).toEqual([WEEKLY, WRITER]);
    expect(names("/we", WITH_SKILLS)).toEqual(["skill:weekly-report"]);
    expect(names("/skill:we", WITH_SKILLS)).toEqual(["skill:weekly-report"]);
    expect(names("/skill:w", WITH_SKILLS)).toEqual(["skill:weekly-report", "skill:writer"]);
    expect(names("/skill", WITH_SKILLS)).toEqual(["skill:weekly-report", "skill:writer"]);
    expect(names("/skill:", WITH_SKILLS)).toEqual(["skill:weekly-report", "skill:writer"]);
  });
});

describe("选中文本 (M8)", () => {
  it("M8 the picked text is the name behind a slash with one trailing space", () => {
    expect(pickText("todo")).toBe("/todo ");
    expect(pickText("skill:weekly-report")).toBe("/skill:weekly-report ");
    expect(isOpen(pickText("todo"))).toBe(false);
  });
});

describe("高亮与关闭的归约 (M6, M7, M9, M10)", () => {
  it("starts on the first option, open", () => {
    expect(initialState("/t")).toEqual({ draft: "/t", index: 0, dismissed: false });
  });

  it("M6 ↓ walks to the last option and wraps to the first", () => {
    expect(walk(0, 1, 3, 4)).toEqual([1, 2, 0, 1]);
    expect(walk(0, 1, 1, 2)).toEqual([0, 0]);
  });

  it("M7 ↑ wraps from the first option to the last, and a move over no option changes nothing", () => {
    expect(walk(0, -1, 3, 4)).toEqual([2, 1, 0, 2]);

    const state: SlashMenuState = { draft: "/x", index: 0, dismissed: false };
    expect(reduce(state, { type: "move", delta: 1, count: 0 })).toBe(state);
    expect(reduce(state, { type: "move", delta: -1, count: 0 })).toBe(state);
  });

  it("a move keeps the draft and leaves a dismissed panel dismissed", () => {
    expect(
      reduce({ draft: "/", index: 1, dismissed: true }, { type: "move", delta: 1, count: 3 }),
    ).toEqual({ draft: "/", index: 2, dismissed: true });
  });

  it("M9 a dismissed panel stays closed while the draft is the same", () => {
    const dismissed = reduce({ draft: "/", index: 2, dismissed: false }, { type: "dismiss" });
    expect(dismissed).toEqual({ draft: "/", index: 2, dismissed: true });

    expect(reduce(dismissed, { type: "draft", draft: "/" })).toBe(dismissed);
  });

  it("M10 any change of the draft resets the highlight and reopens, also back on the same text", () => {
    const dismissed: SlashMenuState = { draft: "/", index: 2, dismissed: true };

    const changed = reduce(dismissed, { type: "draft", draft: "/t" });
    expect(changed).toEqual({ draft: "/t", index: 0, dismissed: false });
    expect(reduce(changed, { type: "draft", draft: "/" })).toEqual({
      draft: "/",
      index: 0,
      dismissed: false,
    });

    const moved = { draft: "/", index: 2, dismissed: false };
    expect(reduce(moved, { type: "draft", draft: "/s" })).toEqual({
      draft: "/s",
      index: 0,
      dismissed: false,
    });
  });
});
