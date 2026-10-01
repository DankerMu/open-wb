import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_FILTER,
  filterSessions,
  groupSessions,
} from "../src/features/chat/session-groups.js";
import type { ChatSession } from "../src/lib/session-contract.js";

const W1 = "1".repeat(32);
const W2 = "2".repeat(32);
const W3 = "3".repeat(32);
const UNKNOWN = "未知空间";

/** 时间戳一律用本地时间构造器生成：断言与运行机器的时区无关。 */
function local(year: number, month: number, day: number, ...time: number[]) {
  const [hours = 0, minutes = 0, seconds = 0, ms = 0] = time;
  return new Date(year, month - 1, day, hours, minutes, seconds, ms).getTime();
}

const NOON = local(2026, 5, 20, 12);

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: id,
    status: "done",
    createdAt: NOON,
    updatedAt: NOON,
    scene: null,
    workspaceId: null,
    pinnedAt: null,
    ...overrides,
  };
}

function ids(sessions: readonly ChatSession[]) {
  return sessions.map((item) => item.id);
}

/** 子组的可观察形状：名称 + 条目 id（key 另行断言）。 */
function subgroups(groups: ReturnType<typeof groupSessions>) {
  return groups.spaces.map((space) => [space.name, ids(space.sessions)]);
}

function entryCount(groups: ReturnType<typeof groupSessions>) {
  return (
    groups.pinned.length +
    groups.tasks.length +
    groups.spaces.reduce((total, space) => total + space.sessions.length, 0)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("groupSessions：分区", () => {
  it("G1 三分区互斥归属：置顶 > 空间 > 任务，空间子组按工作空间列表顺序", () => {
    const sessions = [
      session("E"),
      session("D"),
      session("C", { workspaceId: W2 }),
      session("B", { workspaceId: W1 }),
      session("A", { workspaceId: W1, pinnedAt: NOON }),
    ];
    const workspaces = [
      { id: W2, name: "W2" },
      { id: W1, name: "W1" },
    ];

    const groups = groupSessions(sessions, workspaces);

    expect(ids(groups.pinned)).toEqual(["A"]);
    expect(ids(groups.tasks)).toEqual(["E", "D"]);
    expect(subgroups(groups)).toEqual([
      ["W2", ["C"]],
      ["W1", ["B"]],
    ]);
    expect(entryCount(groups)).toBe(5);
    const everywhere = [
      ...ids(groups.pinned),
      ...ids(groups.tasks),
      ...groups.spaces.flatMap((space) => ids(space.sessions)),
    ];
    expect(everywhere.filter((id) => id === "A")).toEqual(["A"]);
  });

  it("G2 未知空间：列表未读取 → 绑定会话全部在唯一的 未知空间 子组", () => {
    const sessions = [
      session("x", { workspaceId: W1 }),
      session("task"),
      session("y", { workspaceId: W2 }),
    ];

    const groups = groupSessions(sessions, null);

    expect(subgroups(groups)).toEqual([[UNKNOWN, ["x", "y"]]]);
    expect(ids(groups.tasks)).toEqual(["task"]);
    expect(entryCount(groups)).toBe(3);
  });

  it("G2 未知空间：不在列表里的 workspaceId 归末位 未知空间，排在已知子组之后", () => {
    const sessions = [
      session("orphan", { workspaceId: W3 }),
      session("known", { workspaceId: W1 }),
      session("orphan-2", { workspaceId: W3 }),
    ];

    const groups = groupSessions(sessions, [
      { id: W2, name: "空着的空间" },
      { id: W1, name: "W1" },
    ]);

    // W2 没有会话：不产生子组。
    expect(subgroups(groups)).toEqual([
      ["W1", ["known"]],
      [UNKNOWN, ["orphan", "orphan-2"]],
    ]);
    const unknownKey = groups.spaces.at(-1)?.key ?? "";
    expect(unknownKey).not.toMatch(/^[0-9a-f]{32}$/);
    expect(unknownKey).not.toBe("");
    expect(groups.spaces[0]?.key).toBe(W1);
  });

  it("G2 同名的两个空间是两个子组（以 id 为键）", () => {
    const sessions = [
      session("first", { workspaceId: W1 }),
      session("second", { workspaceId: W2 }),
    ];

    const groups = groupSessions(sessions, [
      { id: W1, name: "同名" },
      { id: W2, name: "同名" },
    ]);

    expect(subgroups(groups)).toEqual([
      ["同名", ["first"]],
      ["同名", ["second"]],
    ]);
    expect(groups.spaces.map((space) => space.key)).toEqual([W1, W2]);
  });
});

describe("filterSessions：状态 × 时间", () => {
  const TODAY = local(2026, 5, 20, 9);
  const YESTERDAY = local(2026, 5, 19, 18);
  const sessions = [
    session("running", { status: "running", updatedAt: TODAY }),
    session("done", { status: "done", updatedAt: TODAY }),
    session("idle", { status: "idle", updatedAt: TODAY }),
    session("failed", { status: "failed", updatedAt: YESTERDAY }),
    session("stopped", { status: "stopped", updatedAt: YESTERDAY }),
  ];

  it("G3 状态与时间交集：四种选择依次得到 running；done、failed、stopped；done；failed、stopped", () => {
    expect(ids(filterSessions(sessions, { status: "running", time: "all" }, NOON))).toEqual([
      "running",
    ]);
    expect(ids(filterSessions(sessions, { status: "finished", time: "all" }, NOON))).toEqual([
      "done",
      "failed",
      "stopped",
    ]);
    expect(ids(filterSessions(sessions, { status: "finished", time: "today" }, NOON))).toEqual([
      "done",
    ]);
    expect(ids(filterSessions(sessions, { status: "all", time: "earlier" }, NOON))).toEqual([
      "failed",
      "stopped",
    ]);
  });

  it("G3 idle 只在 全部 下出现：全部×全部时间 与 全部×今天 有，进行中 / 已完成 没有", () => {
    expect(DEFAULT_SESSION_FILTER).toEqual({ status: "all", time: "all" });
    expect(ids(filterSessions(sessions, DEFAULT_SESSION_FILTER, NOON))).toEqual([
      "running",
      "done",
      "idle",
      "failed",
      "stopped",
    ]);
    expect(ids(filterSessions(sessions, { status: "all", time: "today" }, NOON))).toEqual([
      "running",
      "done",
      "idle",
    ]);
    for (const time of ["all", "today", "earlier"] as const) {
      expect(ids(filterSessions(sessions, { status: "running", time }, NOON))).not.toContain(
        "idle",
      );
      expect(ids(filterSessions(sessions, { status: "finished", time }, NOON))).not.toContain(
        "idle",
      );
    }
  });

  it("G4 本地午夜边界：00:00:00.000 属今天、前一毫秒属更早；23:59:59.999 时当日零点仍属今天；次日属更早", () => {
    const midnight = local(2026, 5, 20);
    const atMidnight = [
      session("at-midnight", { updatedAt: midnight }),
      session("one-ms-before", { updatedAt: midnight - 1 }),
    ];
    expect(ids(filterSessions(atMidnight, { status: "all", time: "today" }, midnight))).toEqual([
      "at-midnight",
    ]);
    expect(ids(filterSessions(atMidnight, { status: "all", time: "earlier" }, midnight))).toEqual([
      "one-ms-before",
    ]);

    const lastMs = local(2026, 5, 20, 23, 59, 59, 999);
    const atDayEnd = [
      session("day-start", { updatedAt: midnight }),
      session("next-day", { updatedAt: local(2026, 5, 21) }),
    ];
    expect(ids(filterSessions(atDayEnd, { status: "all", time: "today" }, lastMs))).toEqual([
      "day-start",
    ]);
    expect(ids(filterSessions(atDayEnd, { status: "all", time: "earlier" }, lastMs))).toEqual([
      "next-day",
    ]);
  });
});

describe("顺序与纯度", () => {
  it("G5 各分区、子组内保持输入顺序；输入数组与元素不被修改", () => {
    const sessions = deepFreeze([
      session("p2", { pinnedAt: 1 }),
      session("s1", { workspaceId: W1 }),
      session("t1"),
      session("p1", { pinnedAt: 9, workspaceId: W1 }),
      session("s2", { workspaceId: W1, status: "running" }),
      session("t2", { status: "idle" }),
      session("u1", { workspaceId: W3 }),
      session("s3", { workspaceId: W1 }),
    ]);
    const workspaces = deepFreeze([{ id: W1, name: "W1" }]);
    const before = structuredClone(sessions);

    const filtered = filterSessions(sessions, DEFAULT_SESSION_FILTER, NOON);
    const groups = groupSessions(filtered, workspaces);

    expect(ids(filtered)).toEqual(ids(sessions));
    expect(ids(groups.pinned)).toEqual(["p2", "p1"]);
    expect(ids(groups.tasks)).toEqual(["t1", "t2"]);
    expect(subgroups(groups)).toEqual([
      ["W1", ["s1", "s2", "s3"]],
      [UNKNOWN, ["u1"]],
    ]);
    expect(entryCount(groups)).toBe(sessions.length);
    expect(sessions).toEqual(before);
    expect(workspaces).toEqual([{ id: W1, name: "W1" }]);
  });

  it("G5 空输入 → 三处皆空", () => {
    expect(filterSessions([], { status: "finished", time: "today" }, NOON)).toEqual([]);
    expect(groupSessions([], [{ id: W1, name: "W1" }])).toEqual({
      pinned: [],
      tasks: [],
      spaces: [],
    });
    expect(groupSessions([], null)).toEqual({ pinned: [], tasks: [], spaces: [] });
  });

  it("G5 置顶但被筛掉的会话不出现在任何分区", () => {
    const sessions = [
      session("pinned-done", { pinnedAt: 5, status: "done" }),
      session("running", { status: "running" }),
    ];

    const groups = groupSessions(
      filterSessions(sessions, { status: "running", time: "all" }, NOON),
      null,
    );

    expect(groups).toEqual({ pinned: [], tasks: [sessions[1]], spaces: [] });
  });
});
