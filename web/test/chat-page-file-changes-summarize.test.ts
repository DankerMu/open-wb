/**
 * Issue #535 `summarizeChanges` (C6 of openspec/changes/archive/2026-10-02-file-changes-card/design.md),
 * moved verbatim out of chat-page-file-changes.test.tsx (size-guard, #1968).
 * Seam: `summarizeChanges` on frozen step views; expected values are literals from the spec deltas.
 */
import { describe, expect, it } from "vitest";
import type { ChatState } from "../src/features/chat/stream.js";
import { summarizeChanges } from "../src/features/chat/stream-artifacts.js";
import { deepFrozen, edit, write } from "./chat-page-file-changes-support.js";

type StepView = ChatState["messages"][number]["steps"][number];

describe("summarizeChanges", () => {
  const stepView = (
    id: number,
    status: StepView["status"],
    changes: StepView["changes"],
  ): StepView => ({
    id,
    name: "edit",
    detail: "",
    output: "",
    changes,
    status,
    bodyOffset: null,
    kbHits: null,
  });

  it("C6 skips running steps and counts done, failed and stopped ones", () => {
    const steps = deepFrozen([
      stepView(1, "running", [edit("running.md", 9, 9)]),
      stepView(2, "done", [edit("done.md", 1, 0)]),
      stepView(3, "failed", [write("failed.html")]),
      stepView(4, "stopped", [edit("stopped.md", 0, 2)]),
    ]);
    const before = structuredClone(steps);

    expect(summarizeChanges(steps)).toStrictEqual([
      { path: "done.md", added: 1, removed: 0, kind: "edit" },
      { path: "failed.html", added: null, removed: null, kind: "write" },
      { path: "stopped.md", added: 0, removed: 2, kind: "edit" },
    ]);
    expect(steps).toEqual(before);
  });

  it("C6 keeps the first position of a path and the value of its last step", () => {
    const steps = deepFrozen([
      stepView(1, "done", [edit("a", 1, 0)]),
      stepView(2, "done", [write("b")]),
      stepView(3, "done", [edit("a", 4, 2)]),
    ]);

    expect(summarizeChanges(steps)).toStrictEqual([
      { path: "a", added: 4, removed: 2, kind: "edit" },
      { path: "b", added: null, removed: null, kind: "write" },
    ]);
  });

  it("C6 returns an empty list when no step carries changes", () => {
    expect(
      summarizeChanges(deepFrozen([stepView(1, "done", null), stepView(2, "failed", null)])),
    ).toStrictEqual([]);
    expect(summarizeChanges([])).toStrictEqual([]);
  });
});
