/**
 * Issue #863 task-list normalisation at normalizeTodo: structure validation, the five statuses,
 * 200-code-point truncation, the 200-task cap, empty-phase removal and the all-empty null.
 * Expected values are literals from the session-todo spec「任务清单来源与归一化」, not production logic.
 */
import { describe, expect, it } from "vitest";
import { normalizeTodo, type SessionTodo } from "../src/sessions/session-todo.js";

const ASTRAL = "😀";

function task(content: string, status = "pending"): { content: string; status: string } {
  return { content, status };
}

/** Tasks `t<from>`..`t<to>`, all pending. */
function numbered(from: number, to: number): Array<{ content: string; status: string }> {
  return Array.from({ length: to - from + 1 }, (_unused, index) => task(`t${from + index}`));
}

describe("normalizeTodo: valid task lists", () => {
  it("keeps exactly phases/name/tasks/content/status in that order and drops every other key", () => {
    const phases = [
      {
        name: "准备",
        tasks: [
          { content: "读取需求", status: "completed" },
          { content: "列出要点", status: "in_progress", note: "x" },
        ],
      },
      { name: "交付", tasks: [{ content: "输出结论", status: "blocked", blocker: "等待评审" }] },
    ];
    const expected: SessionTodo = {
      phases: [
        {
          name: "准备",
          tasks: [
            { content: "读取需求", status: "completed" },
            { content: "列出要点", status: "in_progress" },
          ],
        },
        { name: "交付", tasks: [{ content: "输出结论", status: "blocked" }] },
      ],
    };
    const result = normalizeTodo(phases);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).toBe(
      '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"completed"},{"content":"列出要点","status":"in_progress"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"blocked"}]}]}',
    );
  });

  it("orders output keys by the contract, not by the input's key order", () => {
    const result = normalizeTodo([
      { tasks: [{ status: "pending", blocker: 7, content: "a" }], extra: null, name: "A" },
    ]);
    expect(JSON.stringify(result)).toBe(
      '{"phases":[{"name":"A","tasks":[{"content":"a","status":"pending"}]}]}',
    );
  });

  it.each(["pending", "in_progress", "completed", "abandoned", "blocked"])(
    "passes status %s through unchanged",
    (status) => {
      expect(normalizeTodo([{ name: "A", tasks: [{ content: "a", status }] }])).toEqual({
        phases: [{ name: "A", tasks: [{ content: "a", status }] }],
      });
    },
  );

  it("keeps empty name and content strings", () => {
    expect(normalizeTodo([{ name: "", tasks: [task("")] }])).toEqual({
      phases: [{ name: "", tasks: [{ content: "", status: "pending" }] }],
    });
  });

  it("returns fresh objects and leaves the candidate untouched", () => {
    const candidate = [{ name: "A", tasks: [{ content: "a", status: "pending", blocker: "b" }] }];
    const snapshot = structuredClone(candidate);
    const result = normalizeTodo(candidate);
    expect(candidate).toEqual(snapshot);
    expect(result?.phases[0]).not.toBe(candidate[0]);
    expect(result?.phases[0]?.tasks[0]).not.toBe(candidate[0]?.tasks[0]);
  });
});

describe("normalizeTodo: non-conforming candidates are rejected whole (undefined)", () => {
  const inherited = (own: object, proto: object): unknown =>
    Object.assign(Object.create(proto), own);
  const sparsePhases: unknown[] = [];
  sparsePhases[1] = { name: "A", tasks: [task("a")] };
  const sparseTasks: unknown[] = [];
  sparseTasks[1] = task("a");

  it.each([
    ["unknown status", [{ name: "A", tasks: [{ content: "a", status: "done" }] }]],
    ["candidate is not an array", { name: "A" }],
    ["task without content", [{ name: "A", tasks: [{ status: "pending" }] }]],
    ["name of the wrong type", [{ name: 7, tasks: [] }]],
    ["task that is not an object", [{ name: "A", tasks: [task("a"), null] }]],
    ["undefined candidate", undefined],
    ["null candidate", null],
    ["string candidate", "[]"],
    ["phase that is null", [null]],
    ["phase that is an array", [[]]],
    ["phase that is a string", ["A"]],
    ["phase without name", [{ tasks: [] }]],
    ["phase without tasks", [{ name: "A" }]],
    ["tasks that is an object", [{ name: "A", tasks: { 0: task("a"), length: 1 } }]],
    ["task that is an array", [{ name: "A", tasks: [["a", "pending"]] }]],
    ["content of the wrong type", [{ name: "A", tasks: [{ content: 1, status: "pending" }] }]],
    ["task without status", [{ name: "A", tasks: [{ content: "a" }] }]],
    ["status of the wrong type", [{ name: "A", tasks: [{ content: "a", status: 1 }] }]],
    ["status in another case", [{ name: "A", tasks: [task("a", "Pending")] }]],
    ["status that is an Object.prototype key", [{ name: "A", tasks: [task("a", "toString")] }]],
    ["name only on the prototype", [inherited({ tasks: [] }, { name: "A" })]],
    ["tasks only on the prototype", [inherited({ name: "A" }, { tasks: [] })]],
    [
      "content only on the prototype",
      [{ name: "A", tasks: [inherited({ status: "pending" }, { content: "a" })] }],
    ],
    [
      "status only on the prototype",
      [{ name: "A", tasks: [inherited({ content: "a" }, { status: "pending" })] }],
    ],
    ["hole in the phases array", sparsePhases],
    ["hole in a tasks array", [{ name: "A", tasks: sparseTasks }]],
    ["one bad phase after a good one", [{ name: "A", tasks: [task("a")] }, { name: "B" }]],
    [
      "bad task beyond the 200 cap",
      [{ name: "A", tasks: [...numbered(1, 200), { content: "x", status: "done" }] }],
    ],
    ["bad name on a phase that would be dropped as empty", [{ name: null, tasks: [] }]],
  ])("%s", (_name, candidate) => {
    expect(normalizeTodo(candidate)).toBeUndefined();
  });
});

describe("normalizeTodo: 200 code point truncation", () => {
  it("cuts name at 200 code points without splitting a surrogate pair or adding a mark", () => {
    const name = ASTRAL.repeat(201);
    const exact = "x".repeat(200);
    const result = normalizeTodo([{ name, tasks: [task(exact), task("a".repeat(5000))] }]);
    const kept = result?.phases[0]?.name ?? "";
    expect(kept).toBe(ASTRAL.repeat(200));
    expect(kept.length).toBe(400);
    expect(Array.from(kept)).toHaveLength(200);
    // A lone surrogate does not survive a UTF-8 round trip.
    expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
    expect(result?.phases[0]?.tasks).toEqual([
      { content: exact, status: "pending" },
      { content: "a".repeat(200), status: "pending" },
    ]);
  });

  it("counts code points, not UTF-16 units, when BMP and astral characters mix", () => {
    const content = `${"a".repeat(199)}${ASTRAL}${ASTRAL}`;
    const result = normalizeTodo([{ name: content, tasks: [task(content)] }]);
    const expected = `${"a".repeat(199)}${ASTRAL}`;
    expect(result).toEqual({
      phases: [{ name: expected, tasks: [{ content: expected, status: "pending" }] }],
    });
    expect(expected.length).toBe(201);
  });

  it("counts a combining mark as its own code point", () => {
    const result = normalizeTodo([{ name: "A", tasks: [task("é".repeat(150))] }]);
    expect(result?.phases[0]?.tasks[0]?.content).toBe("é".repeat(100));
  });

  it("keeps values of at most 200 code points verbatim, including 200 astral characters", () => {
    const name = ASTRAL.repeat(200);
    const content = `${"界".repeat(199)}́`;
    expect(normalizeTodo([{ name, tasks: [task(content)] }])).toEqual({
      phases: [{ name, tasks: [{ content, status: "pending" }] }],
    });
  });
});

describe("normalizeTodo: 200 task cap across phases", () => {
  it("keeps the first 200 of 204 tasks in order and drops the emptied phase", () => {
    const result = normalizeTodo([
      { name: "P1", tasks: numbered(1, 150) },
      { name: "P2", tasks: numbered(151, 201) },
      { name: "P3", tasks: numbered(202, 204) },
    ]);
    expect(result).toEqual({
      phases: [
        { name: "P1", tasks: numbered(1, 150) },
        { name: "P2", tasks: numbered(151, 200) },
      ],
    });
    expect(result?.phases.flatMap((phase) => phase.tasks)).toHaveLength(200);
    expect(JSON.stringify(result)).not.toContain('"t201"');
    expect(JSON.stringify(result)).not.toContain("P3");
  });

  it("keeps exactly 200 tasks untouched", () => {
    const phases = [
      { name: "P1", tasks: numbered(1, 120) },
      { name: "P2", tasks: numbered(121, 200) },
    ];
    expect(normalizeTodo(phases)).toEqual({ phases });
  });

  it("drops every phase after the one that reaches the cap", () => {
    expect(
      normalizeTodo([
        { name: "P1", tasks: numbered(1, 200) },
        { name: "P2", tasks: numbered(201, 201) },
        { name: "P3", tasks: [] },
      ]),
    ).toEqual({ phases: [{ name: "P1", tasks: numbered(1, 200) }] });
  });
});

describe("normalizeTodo: empty phases and the all-empty null", () => {
  it.each([
    ["no phases", []],
    ["one empty phase", [{ name: "A", tasks: [] }]],
    [
      "two empty phases",
      [
        { name: "A", tasks: [] },
        { name: "B", tasks: [] },
      ],
    ],
  ])("%s normalises to null", (_name, candidate) => {
    expect(normalizeTodo(candidate)).toBeNull();
  });

  it("omits an empty phase next to a non-empty one", () => {
    expect(
      normalizeTodo([
        { name: "A", tasks: [] },
        { name: "B", tasks: [{ content: "b", status: "pending" }] },
      ]),
    ).toEqual({ phases: [{ name: "B", tasks: [{ content: "b", status: "pending" }] }] });
  });
});
