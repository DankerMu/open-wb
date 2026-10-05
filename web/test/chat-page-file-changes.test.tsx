/**
 * Issue #535 `files.changed` decoding/reduction and the 文件变更 card (parent tasks 7.5a),
 * C1–C15 of openspec/changes/file-changes-card/design.md plus the review-round gaps G1–G6.
 * Seams: `chatStateFromSnapshot` / `applyChatEvent` / `summarizeChanges` on frozen inputs,
 * `connectSessionEvents` over the fake EventSource, the jsdom chat page, and the static CSS text.
 * Expected values are literals from the spec deltas; cases marked (guard) already hold before the
 * change.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import { summarizeChanges } from "../src/features/chat/stream-artifacts.js";
import {
  assistantMessage,
  cardNamed,
  cards,
  deepFrozen,
  detailButtons,
  edit,
  filesChanged,
  goLive,
  installed,
  listed,
  listedGroup,
  type Message,
  openSession,
  PROJ,
  quiesce,
  ROOT_PREFIX,
  reduce,
  reply,
  replyParts,
  rowCells,
  rowTexts,
  stepBadge,
  tagAndClass,
  toolStep,
  turn,
  UNLISTED_ID,
  viewOf,
  WORKSPACES,
  withNeighbour,
  write,
} from "./chat-page-file-changes-support.js";
import { cleanupChatPage, expandToolGroups } from "./chat-page-support.js";
import { assistantSteps, deferred, historyUser } from "./chat-stream-support.js";
import { calls, currentLocation, jsonResponse } from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

type StepView = ChatState["messages"][number]["steps"][number];

afterEach(() => {
  cleanupChatPage();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

describe("files.changed through the connector", () => {
  it("C1 drops the frame at the snapshot cursor, then delivers thinking.delta and files.changed in arrival order", async () => {
    const wire = await installed();
    const files = [write("a.html")];

    wire.source.emitData("thinking.delta", "1:3", { messageId: 0, delta: "旧" });
    expect(wire.events).toEqual([]);
    wire.source.emitData("thinking.delta", "1:4", { messageId: 0, delta: "想" });
    wire.source.emitData("files.changed", "1:5", { messageId: 0, stepId: 5, files });
    wire.source.emitData("foo.bar", "1:6", { messageId: 0, stepId: 5, files });

    expect(wire.events).toStrictEqual([
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
      {
        type: "files.changed",
        data: {
          messageId: 0,
          stepId: 5,
          files: [{ path: "a.html", added: null, removed: null, kind: "write" }],
        },
      },
    ]);
    expect(assistantSteps(wire.state)?.map((step) => step.changes)).toStrictEqual([
      [{ path: "a.html", added: null, removed: null, kind: "write" }],
    ]);
    expect(wire.loads).toHaveLength(1);
    expect(wire.errors).toEqual([]);
  });

  it("C1 ignores the unknown type foo.bar without a resync (guard)", async () => {
    const wire = await installed();

    wire.source.emitData("thinking.delta", "1:3", { messageId: 0, delta: "旧" });
    wire.source.emitData("thinking.delta", "1:4", { messageId: 0, delta: "想" });
    wire.source.emitData("foo.bar", "1:6", { messageId: 0, delta: "x" });

    expect(wire.events).toStrictEqual([
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
    ]);
    expect(wire.loads).toHaveLength(1);
    expect(wire.errors).toEqual([]);
  });

  const row = { path: "a.md", added: 1, removed: 0, kind: "edit" };
  const payload = (files: unknown, top: Record<string, unknown> = {}) => ({
    messageId: 0,
    stepId: 5,
    files,
    ...top,
  });
  const rejected: Array<[string, unknown]> = [
    ["an empty files array", payload([])],
    ["files that is an object", payload({ 0: row })],
    ["51 files", payload(Array.from({ length: 51 }, (_, at) => ({ ...row, path: `f${at}.md` })))],
    ["an unknown kind", payload([{ ...row, kind: "delete" }])],
    ["an element without kind", payload([{ path: "a.md", added: 1, removed: 0 }])],
    ["an element with an extra key", payload([{ ...row, mode: "0644" }])],
    ["an empty path", payload([{ ...row, path: "" }])],
    ["a numeric path", payload([{ ...row, path: 7 }])],
    ["an edit with null counts", payload([{ ...row, added: null, removed: null }])],
    ["an edit with a negative count", payload([{ ...row, removed: -1 }])],
    ["an edit with a fractional count", payload([{ ...row, added: 1.5 }])],
    ["a write with numeric counts", payload([{ ...row, kind: "write" }])],
    ["a missing files key", { messageId: 0, stepId: 5 }],
    ["an extra top-level key", payload([row], { extra: 1 })],
    ["messageId 1.5", payload([row], { messageId: 1.5 })],
    ["a string messageId", payload([row], { messageId: "0" })],
    ["an unsafe messageId", payload([row], { messageId: 2 ** 53 })],
    ["stepId 1.5", payload([row], { stepId: 1.5 })],
    ["a string stepId", payload([row], { stepId: "5" })],
    ["an unsafe stepId", payload([row], { stepId: 2 ** 53 })],
  ];

  it.each(rejected)(
    "C2 %s triggers a snapshot resync and is not delivered",
    async (_name, body) => {
      const wire = await installed();

      wire.source.emitData("files.changed", "1:4", body);

      expect(wire.loads).toHaveLength(2);
      expect(wire.events).toEqual([]);
      expect(wire.errors).toEqual([]);
    },
  );

  it("C2 delivers exactly 50 files, zero-count edits included", async () => {
    const wire = await installed();
    const files = Array.from({ length: 50 }, (_, at) => ({ ...row, added: 0, path: `f${at}.md` }));

    wire.source.emitData("files.changed", "1:4", payload(files));

    expect(wire.events).toStrictEqual([
      { type: "files.changed", data: { messageId: 0, stepId: 5, files } },
    ]);
    expect(files[49]).toStrictEqual({ path: "f49.md", added: 0, removed: 0, kind: "edit" });
    expect(wire.loads).toHaveLength(1);
    expect(wire.errors).toEqual([]);
  });

  it("G6 drops files.changed at or below the snapshot cursor without a resync and delivers the one just above", async () => {
    const wire = await installed();

    wire.source.emitData("files.changed", "1:2", payload([write("below.html")]));
    wire.source.emitData("files.changed", "1:3", payload([write("at.html")]));

    expect(wire.events).toEqual([]);
    expect(assistantSteps(wire.state)?.map((step) => step.changes)).toStrictEqual([null]);

    wire.source.emitData("files.changed", "1:4", payload([write("above.html")]));

    const above = { path: "above.html", added: null, removed: null, kind: "write" };
    expect(wire.events).toStrictEqual([
      { type: "files.changed", data: { messageId: 0, stepId: 5, files: [above] } },
    ]);
    expect(assistantSteps(wire.state)?.map((step) => step.changes)).toStrictEqual([[above]]);
    expect(wire.loads).toHaveLength(1);
    expect(wire.errors).toEqual([]);
  });
});

describe("files.changed reduction and the step view shape", () => {
  it("C3 replaces a step's changes on every files.changed and keeps them through step.end", () => {
    const state = viewOf(turn("running", { content: "正文" }));
    const before = structuredClone(state);

    const first = reduce(
      state,
      { type: "thinking.delta", data: { messageId: 0, delta: "先" } },
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
      {
        type: "step.start",
        data: { messageId: 0, stepId: 5, name: "write", detail: "write args" },
      },
      filesChanged(0, 5, write("a.html")),
    );
    const second = reduce(first, filesChanged(0, 5, write("b.html")));
    const ended = reduce(second, {
      type: "step.end",
      data: { messageId: 0, stepId: 5, status: "done", output: "written" },
    });

    expect(assistantSteps(first)).toStrictEqual([
      {
        id: 5,
        name: "write",
        detail: "write args",
        output: "",
        changes: [{ path: "a.html", added: null, removed: null, kind: "write" }],
        status: "running",
      },
    ]);
    expect(assistantSteps(second)?.map((step) => step.changes)).toStrictEqual([
      [{ path: "b.html", added: null, removed: null, kind: "write" }],
    ]);
    expect(assistantSteps(ended)).toStrictEqual([
      {
        id: 5,
        name: "write",
        detail: "write args",
        output: "written",
        changes: [{ path: "b.html", added: null, removed: null, kind: "write" }],
        status: "done",
      },
    ]);
    expect(ended.messages[1]?.thinking).toBe("先想");
    expect(ended.messages[1]?.content).toBe("正文");
    expect(ended.messages[1]?.status).toBe("running");
    expect(ended.status).toBe("running");
    expect(ended.messages).toHaveLength(2);
    expect(ended.messages[0]).toBe(state.messages[0]);
    expect(state).toEqual(before);
  });

  it("C3 replaces the changes of a snapshot step and leaves a done session done", () => {
    const steps = [
      toolStep(5, 0, "edit", [edit("a.md", 1, 0)]),
      toolStep(6, 1, "edit", [edit("keep.md", 3, 3)]),
    ];
    const state = viewOf(turn("done", { content: "答", steps }));

    const next = applyChatEvent(state, filesChanged(0, 5, edit("b.md", 4, 2)));

    expect(assistantSteps(next)?.map((step) => step.changes)).toStrictEqual([
      [{ path: "b.md", added: 4, removed: 2, kind: "edit" }],
      [{ path: "keep.md", added: 3, removed: 3, kind: "edit" }],
    ]);
    expect(assistantSteps(next)?.[1]).toBe(assistantSteps(state)?.[1]);
    expect(next.status).toBe("done");
    expect(next.messages[1]?.status).toBe("done");
    expect(next.messages[0]).toBe(state.messages[0]);
  });

  it("G1 step.end keeps the detail and the changes a running snapshot step already carries", () => {
    const steps = [toolStep(7, 0, "edit", [edit("src/app.ts", 2, 1)], "running")];
    const state = viewOf(turn("running", { steps }));

    const ended = reduce(state, {
      type: "step.end",
      data: { messageId: 0, stepId: 7, status: "failed", output: "boom" },
    });

    const changes = [{ path: "src/app.ts", added: 2, removed: 1, kind: "edit" }];
    expect(assistantSteps(ended)).toStrictEqual([
      { id: 7, name: "edit", detail: "edit args", output: "boom", changes, status: "failed" },
    ]);
    expect(assistantSteps(ended)?.[0]?.changes).toBe(assistantSteps(state)?.[0]?.changes);
  });

  const settled = () =>
    viewOf(turn("done", { content: "答", steps: [toolStep(5, 0, "write", [write("a.html")])] }));

  const strays: Array<[string, ChatEvent]> = [
    ["a step the message does not hold (99)", filesChanged(0, 99, write("x.html"))],
    ["a messageId the view does not hold", filesChanged(42, 5, write("x.html"))],
    ["a user message id", filesChanged(historyUser.id, 5, write("x.html"))],
  ];

  it.each(strays)("C4 files.changed for %s returns the same state (guard)", (_name, event) => {
    const state = settled();

    const next = applyChatEvent(state, event);

    expect(next).toBe(state);
    expect(next.messages).toHaveLength(2);
    expect(next.status).toBe("done");
  });

  const moved: Array<[string, ChatEvent]> = [
    [
      "a repeated step.start",
      { type: "step.start", data: { messageId: 0, stepId: 5, name: "write", detail: "again" } },
    ],
    [
      "a step.end for a step the message does not hold",
      { type: "step.end", data: { messageId: 0, stepId: 99, status: "done", output: "x" } },
    ],
    [
      "a step.end for a message the view does not hold",
      { type: "step.end", data: { messageId: 42, stepId: 5, status: "done", output: "x" } },
    ],
  ];

  it.each(moved)("C4 %s returns the same state (move guard)", (_name, event) => {
    const state = settled();

    const next = applyChatEvent(state, event);

    expect(next).toBe(state);
    expect(next.messages).toHaveLength(2);
  });

  it("C5 carries snapshot step changes value for value", () => {
    const snapshot = turn("done", {
      steps: [toolStep(11, 0, "bash", null), toolStep(12, 1, "edit", [edit("src/app.ts", 2, 1)])],
    });

    const state = chatStateFromSnapshot(deepFrozen(structuredClone(snapshot)));

    expect(assistantSteps(state)).toStrictEqual([
      { id: 11, name: "bash", detail: "bash args", output: "ok", changes: null, status: "done" },
      {
        id: 12,
        name: "edit",
        detail: "edit args",
        output: "ok",
        changes: [{ path: "src/app.ts", added: 2, removed: 1, kind: "edit" }],
        status: "done",
      },
    ]);
  });

  it("C5 step.start creates a running step whose changes are null", () => {
    const state = viewOf(turn("running"));

    const next = applyChatEvent(state, {
      type: "step.start",
      data: { messageId: 0, stepId: 21, name: "edit", detail: "edit args" },
    });

    expect(assistantSteps(next)).toStrictEqual([
      { id: 21, name: "edit", detail: "edit args", output: "", changes: null, status: "running" },
    ]);
  });

  it("C5 a repeated turn.start leaves no steps (guard)", () => {
    const steps = [toolStep(5, 0, "write", [write("a.html")])];
    const state = viewOf(turn("running", { steps }));

    const restarted = applyChatEvent(state, { type: "turn.start", data: { messageId: 0 } });

    expect(assistantSteps(restarted)).toStrictEqual([]);
  });
});

describe("summarizeChanges", () => {
  const stepView = (
    id: number,
    status: StepView["status"],
    changes: StepView["changes"],
  ): StepView => ({ id, name: "edit", detail: "", output: "", changes, status });

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

describe("文件变更 card on the chat page", () => {
  it("C7 shows the card only after the step's step.end", async () => {
    await openSession(turn("running"));
    const send = await goLive();

    send("step.start", { stepId: 5, name: "write", detail: '{"path":"out/index.html"}' });
    send("files.changed", { stepId: 5, files: [write("out/index.html")] });

    expect(stepBadge("write 运行中").textContent).toBe("运行中");
    expect(cards()).toEqual([]);
    expect(within(reply()).queryByRole("group", { name: /文件变更/ })).toBeNull();

    send("step.end", { stepId: 5, status: "done", output: "written" });

    expect(stepBadge("write 已完成").textContent).toBe("已完成");
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/out/index.html"]);
    expect(cards()).toHaveLength(1);
  });

  it("G1 a reloaded running step that already carries changes shows them only after its step.end", async () => {
    const steps = [toolStep(7, 0, "write", [write("docs/plan.md")], "running")];
    await openSession(turn("running", { content: "写到一半", steps }));
    expect(cards()).toEqual([]);
    const send = await goLive();
    expect(stepBadge("write 运行中").textContent).toBe("运行中");
    expect(screen.queryByRole("group", { name: /文件变更/ })).toBeNull();

    send("step.end", { stepId: 7, status: "failed", output: "disk full" });

    expect(stepBadge("write 失败").textContent).toBe("失败");
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/docs/plan.md"]);
  });

  it("C7 removes the card when the same message starts a new turn", async () => {
    const steps = [toolStep(11, 0, "write", [write("out/index.html")])];
    await openSession(turn("done", { content: "写好了", steps }));
    const send = await goLive();
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/out/index.html"]);

    send("turn.start", {});

    expect(reply().querySelector('[data-slot="tool-group-root"]')).toBeNull();
    expect(cards()).toEqual([]);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  const turnEnds = [
    ["C8 a step still running at turn.end stopped becomes stopped", "stopped", "已停止"],
    ["G3 a step still running at turn.end failed becomes failed", "failed", "失败"],
  ] as const;

  it.each(turnEnds)("%s and its changes show", async (_name, status, label) => {
    const steps = [toolStep(5, 0, "write", null, "running")];
    await openSession(turn("running", { content: "写到一半", steps }));
    const send = await goLive();

    send("files.changed", { stepId: 5, files: [write("out/index.html")] });
    expect(stepBadge("write 运行中").textContent).toBe("运行中");
    expect(cards()).toEqual([]);

    send("turn.end", { status });

    await waitFor(() => expect(stepBadge(`write ${label}`).textContent).toBe(label));
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["写入zhangsan/proj/out/index.html"]);
  });

  it("C9/G5 lists logical paths in the card only, never the absolute root, and 查看详情 opens the workspace in /files", async () => {
    const steps = [
      toolStep(11, 0, "edit", [edit("src/app.ts", 2, 1)]),
      toolStep(12, 1, "write", [write("out/index.html")]),
    ];
    const tree = `${WORKSPACES}/${PROJ.id}/tree?path=`;
    const page = await openSession(turn("done", { content: "改好了", steps }), listed, {
      [tree]: () => jsonResponse({ path: "", entries: [] }),
    });

    const card = cardNamed("文件变更（2 个）");
    expect(rowCells(card)).toEqual([
      [
        ["file-change-add", "+2"],
        ["file-change-del", "-1"],
        ["file-change-path", "zhangsan/proj/src/app.ts"],
      ],
      [
        ["file-change-kind", "写入"],
        ["file-change-path", "zhangsan/proj/out/index.html"],
      ],
    ]);
    expect(rowTexts(card)).toEqual([
      "+2-1zhangsan/proj/src/app.ts",
      "写入zhangsan/proj/out/index.html",
    ]);
    expect(rowTexts(card)[1]).not.toMatch(/[+-]\d/);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
    expect(within(cardNamed("工具调用")).queryAllByRole("region")).toEqual([]);
    expandToolGroups(reply());
    expect(within(cardNamed("工具调用")).getAllByRole("region")).toHaveLength(2);
    expect(cardNamed("工具调用").querySelectorAll('[class*="file-change"]')).toHaveLength(0);
    const editStep = within(reply()).getByRole("region", { name: "edit" });
    expect(editStep.textContent).not.toContain("+2");
    expect(editStep.textContent).not.toContain("zhangsan/proj/src/app.ts");
    expect(detailButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "查看详情 zhangsan/proj/src/app.ts",
      "查看详情 zhangsan/proj/out/index.html",
    ]);
    const open = within(card).getByRole("button", { name: "查看详情 zhangsan/proj/src/app.ts" });
    expect(open.getAttribute("title")).toBe("查看详情 zhangsan/proj/src/app.ts");
    expect(open.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    expect(open.closest(".file-change-row")?.lastElementChild).toBe(open);
    expect(card.querySelector(".file-change-path")?.getAttribute("title")).toBe(
      "zhangsan/proj/src/app.ts",
    );

    fireEvent.click(open);

    await waitFor(() => expect(currentLocation()).toBe(`/files?ws=${PROJ.id}`));
    await screen.findByRole("navigation", { name: "工作空间目录树" });
    await quiesce();
    const { pathname, search } = page.router.state.location;
    expect(`${pathname}${search}`).toBe(`/files?ws=${PROJ.id}`);
    expect(currentLocation()).toBe(`/files?ws=${PROJ.id}`);
    expect(calls(page.fetchMock, tree)).not.toHaveLength(0);
  });

  it("C10 collapses one path changed by two steps into the later step's counts", async () => {
    const steps = [
      toolStep(11, 0, "edit", [edit("a.md", 1, 0)]),
      toolStep(12, 1, "edit", [edit("a.md", 4, 2)]),
    ];
    await openSession(turn("done", { content: "改好了", steps }));

    const card = cardNamed("文件变更（1 个）");
    expect(rowCells(card)).toEqual([
      [
        ["file-change-add", "+4"],
        ["file-change-del", "-2"],
        ["file-change-path", "zhangsan/proj/a.md"],
      ],
    ]);
    expect(card.textContent).not.toContain("+1");
    expect(cards()).toHaveLength(1);
  });

  it("G2 gives each assistant message its own card with its own counts for a shared path", async () => {
    const earlier = [toolStep(11, 0, "edit", [edit("a.md", 1, 0)])];
    const later = [toolStep(12, 0, "edit", [edit("a.md", 4, 2)])];
    const base = turn("done", { content: "第一轮", steps: earlier });
    const followUp: Message[] = [
      { ...historyUser, id: 1, createdAt: 1 },
      assistantMessage("done", { id: 2, content: "第二轮", createdAt: 2, steps: later }),
    ];
    await openSession({ ...base, messages: [...base.messages, ...followUp] });

    const perMessage = screen
      .getAllByRole("article", { name: "助手" })
      .map((article) => within(article).getAllByRole("group", { name: "文件变更（1 个）" }));
    expect(perMessage.map((own) => own.map((card) => rowTexts(card)))).toEqual([
      [["+1zhangsan/proj/a.md"]],
      [["+4-2zhangsan/proj/a.md"]],
    ]);
    expect(cards()).toEqual(perMessage.flat());
  });

  const changed = (workspaceId: string | null) =>
    turn(
      "done",
      { content: "改好了", steps: [toolStep(11, 0, "edit", [edit("src/app.ts", 2, 1)])] },
      workspaceId,
    );

  function expectRelativeRows() {
    expect(rowTexts(cardNamed("文件变更（1 个）"))).toEqual(["+2-1src/app.ts"]);
    expect(document.querySelector(".file-change-path")?.textContent).toBe("src/app.ts");
    expect(detailButtons()).toEqual([]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
  }

  const unresolved: Array<[string, string | null]> = [
    ["the bound workspace is not listed", UNLISTED_ID],
    ["the session has no workspace", null],
  ];

  it.each(unresolved)(
    "C11/G4 shows the relative path without 查看详情 when %s, with the list installed",
    async (_name, workspaceId) => {
      const snapshot = changed(workspaceId);
      await openSession(snapshot, listed, withNeighbour(snapshot));

      expect(listedGroup()?.textContent).toContain("邻居会话");
      expectRelativeRows();
    },
  );

  it("C11 shows the relative path without 查看详情 when the workspace list fails", async () => {
    await openSession(changed(PROJ.id), () =>
      jsonResponse({ error: { code: "internal", message: "工作空间不可用" } }, 500),
    );

    expectRelativeRows();
  });

  it("C11/G4 shows the relative path while the workspace list loads, then the logical path and still no root", async () => {
    const gate = deferred<void>();
    const snapshot = changed(PROJ.id);
    await openSession(snapshot, () => gate.promise.then(listed), withNeighbour(snapshot));

    expect(listedGroup()).toBeNull();
    expectRelativeRows();

    gate.resolve();
    await quiesce();

    expect(listedGroup()?.textContent).toContain("邻居会话");
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
    const card = cardNamed("文件变更（1 个）");
    expect(rowTexts(card)).toEqual(["+2-1zhangsan/proj/src/app.ts"]);
    expect(detailButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "查看详情 zhangsan/proj/src/app.ts",
    ]);
  });

  it("C12 shows only counts above zero and 写入 for a written file", async () => {
    const files = [
      edit("removed-only.ts", 0, 3),
      edit("untouched.ts", 0, 0),
      edit("added-only.ts", 5, 0),
      write("new.html"),
    ];
    await openSession(turn("done", { content: "改好了", steps: [toolStep(11, 0, "edit", files)] }));

    expect(rowCells(cardNamed("文件变更（4 个）"))).toEqual([
      [
        ["file-change-del", "-3"],
        ["file-change-path", "zhangsan/proj/removed-only.ts"],
      ],
      [["file-change-path", "zhangsan/proj/untouched.ts"]],
      [
        ["file-change-add", "+5"],
        ["file-change-path", "zhangsan/proj/added-only.ts"],
      ],
      [
        ["file-change-kind", "写入"],
        ["file-change-path", "zhangsan/proj/new.html"],
      ],
    ]);
  });

  it("C13 orders fold, body, step, approvals, file changes, stopped badge and actions", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await openSession(
      turn("stopped", {
        content: "部分回答",
        thinking: "先想一想",
        steps: [toolStep(11, 0, "write", [write("out/index.html")])],
        approvals: [
          {
            id: 7,
            tool: "write",
            title: "Allow tool: write",
            requestedAt: 1_750_000_000_000,
            expiresAt: 1_750_000_060_000,
            decision: "allow",
          },
        ],
      }),
    );
    const parts = replyParts();

    expect(parts.map(tagAndClass)).toEqual([
      "reasoning-root",
      "message-body",
      "tool-group-root",
      "approval-records",
      "fieldset.file-changes-card",
      "fieldset.artifact-card",
      "message-stopped",
      "message-actions",
    ]);
    expect(cardNamed("文件变更（1 个）")).toBe(parts[4]);
    expect(cardNamed("工具调用")).toBe(parts[2]);
    expect(within(reply()).getByRole("status", { name: "助手消息 已停止" })).toBe(parts[6]);
    expect(parts[1]?.textContent).toBe("部分回答");

    fireEvent.click(within(reply()).getByRole("button", { name: "复制" }));
    expect((await screen.findByText("已复制")).getAttribute("role")).toBe("status");

    expect(writeText.mock.calls).toEqual([["部分回答"]]);
  });

  it("C13 puts the file changes after the error text of a failed message", async () => {
    const steps = [toolStep(11, 0, "write", [write("out/index.html")])];
    await openSession(turn("running", { content: "写到一半", steps }));
    const send = await goLive();

    send("error", { message: "上游失败" });
    send("turn.end", { status: "failed" });

    await waitFor(() => expect(cards()).toHaveLength(1));
    const parts = replyParts();
    expect(parts.map(tagAndClass)).toEqual([
      "message-body",
      "tool-group-root",
      "message-error",
      "fieldset.file-changes-card",
      "fieldset.artifact-card",
      "message-actions",
    ]);
    expect(parts[2]?.textContent).toBe("上游失败");
    expect(cardNamed("文件变更（1 个）")).toBe(parts[3]);
  });

  it("C14 renders no card for a user message, even one whose view holds changed steps (guard)", async () => {
    const base = turn("done", { content: "答" });
    const asker: Message = {
      ...historyUser,
      steps: [toolStep(31, 0, "edit", [edit("u.md", 1, 1)])],
    };
    await openSession({ ...base, messages: [asker, ...base.messages.slice(1)] });

    const user = screen.getByRole("article", { name: "用户" });
    expect(within(user).getByRole("button", { name: "1 个步骤 · edit 已完成" })).toBeTruthy();
    expect(cards()).toEqual([]);
    expect(screen.queryByRole("group", { name: /文件变更/ })).toBeNull();
  });

  it("C14 renders no card when no step of the message carries changes (guard)", async () => {
    const steps = [toolStep(11, 0, "bash", null), toolStep(12, 1, "read", null, "failed")];
    await openSession(turn("done", { content: "答", steps }));

    expect(within(reply()).getAllByRole("region")).toHaveLength(2);
    expect(cards()).toEqual([]);
    expect(screen.queryByRole("group", { name: /文件变更/ })).toBeNull();
  });

  it("C14 names the group exactly by its head text", async () => {
    const steps = [
      toolStep(11, 0, "edit", [edit("src/app.ts", 2, 1)]),
      toolStep(12, 1, "write", [write("out/index.html")]),
    ];
    await openSession(turn("done", { content: "改好了", steps }));

    const card = cardNamed("文件变更（2 个）");
    expect(card.querySelector(".file-changes-head")?.textContent).toBe("文件变更（2 个）");
    expect(card.firstElementChild?.className).toBe("file-changes-head");
    expect(screen.getAllByRole("group", { name: /文件变更/ })).toEqual([card]);
  });
});

describe("file changes card static styles", () => {
  const css = () => stripComments(readRepoFile("web/src/features/chat/messages.css"));

  it("C15 truncates long paths and colours the counts with the status tokens", () => {
    expect(ruleBody(css(), ".file-change-path")).toContain("text-overflow: ellipsis");
    expect(ruleBody(css(), ".file-change-path")).toContain("min-width: 0");
    expect(ruleBody(css(), ".file-change-add")).toContain("var(--wb-status-success-text)");
    expect(ruleBody(css(), ".file-change-del")).toContain("var(--wb-status-error-text)");
  });

  it("C15 keeps file change styles out of chat.css (guard)", () => {
    expect(readRepoFile("web/src/features/chat/chat.css")).not.toContain("file-change");
  });
});
