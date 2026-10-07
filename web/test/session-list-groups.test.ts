import { describe, expect, it } from "vitest";
import {
  groupSessionList,
  searchSessions,
  splitArchived,
} from "../src/features/chat/session-groups.js";
import type { ChatSession } from "../src/lib/session-contract.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";

const W1 = "1".repeat(32);
const W2 = "2".repeat(32);
const GONE = "9".repeat(32);
const WORKSPACES = [
  { id: W2, name: "W2" },
  { id: W1, name: "W1" },
];

/** 时间戳一律用本地时间构造器生成：断言与运行机器的时区无关；日序号可越界（0、负数）。 */
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
    ...NULL_SESSION_META,
    ...overrides,
  };
}

function ids(sessions: readonly ChatSession[]) {
  return sessions.map((item) => item.id);
}

/** 分组的可观察形状：键、名称与条目 id，按产出顺序。 */
function shape(groups: ReturnType<typeof groupSessionList>) {
  return groups.map((group) => [group.key, group.name, ids(group.sessions)]);
}

/** 单个会话在按时间分组下落进的组键。 */
function timeKey(updatedAt: number, now: number) {
  const groups = groupSessionList([session("x", { updatedAt })], null, "time", now);
  expect(groups).toHaveLength(1);
  return groups[0]?.key;
}

describe("groupSessionList：按工作空间", () => {
  it("按工作空间分组：置顶在前且不重复，空间按列表顺序，临时空间在后，归档不出现", () => {
    const sessions = [
      session("F", { workspaceId: W1, archivedAt: NOON }),
      session("E"),
      session("D", { workspaceId: GONE, temporaryWorkspace: true }),
      session("C", { workspaceId: W2 }),
      session("B", { workspaceId: W1 }),
      session("A", { workspaceId: W1, pinnedAt: NOON }),
    ];
    expect(shape(groupSessionList(sessions, WORKSPACES, "workspace", NOON))).toEqual([
      ["pinned", "置顶任务", ["A"]],
      [W2, "W2", ["C"]],
      [W1, "W1", ["B"]],
      ["temporary", "临时空间", ["E", "D"]],
    ]);
  });

  it("空间不在列表里的归末位未知空间；组内保持输入顺序；空组不产出", () => {
    const sessions = [
      session("u1", { workspaceId: GONE }),
      session("t1"),
      session("b2", { workspaceId: W1 }),
      session("u2", { workspaceId: GONE }),
      session("b1", { workspaceId: W1 }),
    ];
    expect(shape(groupSessionList(sessions, WORKSPACES, "workspace", NOON))).toEqual([
      [W1, "W1", ["b2", "b1"]],
      ["temporary", "临时空间", ["t1"]],
      ["unknown", "未知空间", ["u1", "u2"]],
    ]);
  });

  it("未知空间与读取失败：没有已读取列表时绑定正式空间的会话归未知空间，临时与未绑定的仍归临时空间", () => {
    const sessions = [
      session("bound", { workspaceId: W1 }),
      session("temp", { workspaceId: W2, temporaryWorkspace: true }),
      session("legacy"),
      session("pin", { workspaceId: W1, pinnedAt: NOON }),
    ];
    expect(shape(groupSessionList(sessions, null, "workspace", NOON))).toEqual([
      ["pinned", "置顶任务", ["pin"]],
      ["temporary", "临时空间", ["temp", "legacy"]],
      ["unknown", "未知空间", ["bound"]],
    ]);
    // 沿用上一次成功读取的列表时仍在以空间名为名的分组内。
    expect(
      shape(groupSessionList([sessions[0] as ChatSession], WORKSPACES, "workspace", NOON)),
    ).toEqual([[W1, "W1", ["bound"]]]);
  });

  it("临时空间标记优先于空间列表：即使 id 出现在列表里也归临时空间", () => {
    const sessions = [session("t", { workspaceId: W1, temporaryWorkspace: true })];
    expect(shape(groupSessionList(sessions, WORKSPACES, "workspace", NOON))).toEqual([
      ["temporary", "临时空间", ["t"]],
    ]);
  });

  it("没有会话或全部已归档时不产出任何分组；不改输入", () => {
    expect(groupSessionList([], WORKSPACES, "workspace", NOON)).toEqual([]);
    const sessions = [
      session("a", { archivedAt: 1, pinnedAt: 1 }),
      session("b", { archivedAt: 2 }),
    ];
    const before = structuredClone(sessions);
    expect(groupSessionList(sessions, WORKSPACES, "workspace", NOON)).toEqual([]);
    expect(groupSessionList(sessions, WORKSPACES, "time", NOON)).toEqual([]);
    expect(sessions).toEqual(before);
  });
});

describe("groupSessionList：按时间", () => {
  it("切换为按时间：置顶、今天、近 7 天、更早，依此次序，各组保持输入顺序", () => {
    const sessions = [
      session("today", { workspaceId: W1 }),
      session("pin", { updatedAt: local(2026, 4, 20), pinnedAt: NOON }),
      session("three", { updatedAt: local(2026, 5, 17, 9) }),
      session("three-b", { updatedAt: local(2026, 5, 17, 8), workspaceId: GONE }),
      session("month", { updatedAt: local(2026, 4, 20, 12), temporaryWorkspace: true }),
      session("gone", { updatedAt: local(2026, 5, 17), archivedAt: NOON }),
    ];
    expect(shape(groupSessionList(sessions, WORKSPACES, "time", NOON))).toEqual([
      ["pinned", "置顶任务", ["pin"]],
      ["today", "今天", ["today"]],
      ["week", "近 7 天", ["three", "three-b"]],
      ["earlier", "更早", ["month"]],
    ]);
  });

  it("空的时间组不产出，次序不因输入顺序改变", () => {
    const sessions = [session("old", { updatedAt: local(2025, 1, 1) }), session("now")];
    expect(shape(groupSessionList(sessions, null, "time", NOON))).toEqual([
      ["today", "今天", ["now"]],
      ["earlier", "更早", ["old"]],
    ]);
  });

  it("日历日边界：今天 0 点归今天，早 1 毫秒归近 7 天", () => {
    expect(timeKey(local(2026, 5, 20), NOON)).toBe("today");
    expect(timeKey(local(2026, 5, 19, 23, 59, 59, 999), NOON)).toBe("week");
    // 当前时间在 0 点后 1 毫秒：不足 24 小时的昨天仍不是今天。
    expect(timeKey(local(2026, 5, 19, 23, 59, 59, 999), local(2026, 5, 20, 0, 0, 0, 1))).toBe(
      "week",
    );
  });

  it("日历日边界：6 天前整日归近 7 天，7 天前归更早", () => {
    expect(timeKey(local(2026, 5, 14), NOON)).toBe("week");
    expect(timeKey(local(2026, 5, 14, 23, 59, 59, 999), NOON)).toBe("week");
    expect(timeKey(local(2026, 5, 13, 23, 59, 59, 999), NOON)).toBe("earlier");
    expect(timeKey(local(2026, 5, 13, 12), NOON)).toBe("earlier");
    // 当前时间在一天的末尾：6 天前的 0 点距今超过 6 × 24 小时，仍归近 7 天。
    const late = local(2026, 5, 20, 23, 59, 59, 999);
    expect(timeKey(local(2026, 5, 14), late)).toBe("week");
    expect(timeKey(local(2026, 5, 13, 23, 59, 59, 999), late)).toBe("earlier");
  });

  it("晚于当前时间的归今天：同日稍晚、明天、明年", () => {
    expect(timeKey(local(2026, 5, 20, 23, 59, 59, 999), NOON)).toBe("today");
    expect(timeKey(local(2026, 5, 21), NOON)).toBe("today");
    expect(timeKey(local(2027, 1, 1), NOON)).toBe("today");
  });

  it("跨月、跨年与夏令时切换日按日历日计，不按 24 小时的倍数", () => {
    // 跨月、跨年：日序号借位由本地时间构造器完成。
    expect(timeKey(local(2026, 2, 24), local(2026, 3, 2, 8))).toBe("week");
    expect(timeKey(local(2026, 2, 23, 23, 59, 59, 999), local(2026, 3, 2, 8))).toBe("earlier");
    expect(timeKey(local(2025, 12, 27), local(2026, 1, 2, 8))).toBe("week");
    expect(timeKey(local(2025, 12, 26, 23, 59, 59, 999), local(2026, 1, 2, 8))).toBe("earlier");
    // 每个可能的夏令时切换窗口（欧美的 3 月、10–11 月，南半球的 4 月、9–10 月）各走一遍：
    // 机器所在时区若有切换，其中一段的天长不是 24 小时，边界仍须落在 0 点。
    for (const [year, month] of [
      [2026, 3],
      [2026, 4],
      [2026, 9],
      [2026, 10],
      [2026, 11],
    ] as const) {
      for (let day = 1; day <= 31; day += 1) {
        const now = local(year, month, day, 12);
        expect(timeKey(local(year, month, day), now)).toBe("today");
        expect(timeKey(local(year, month, day, 0, 0, 0, -1), now)).toBe("week");
        expect(timeKey(local(year, month, day - 6), now)).toBe("week");
        expect(timeKey(local(year, month, day - 6, 0, 0, 0, -1), now)).toBe("earlier");
      }
    }
  });
});

describe("splitArchived", () => {
  it("按 archivedAt 是否为 null 二分，各自保持输入顺序，置顶不影响归属", () => {
    const sessions = [
      session("a"),
      session("b", { archivedAt: NOON, pinnedAt: NOON }),
      session("c", { pinnedAt: NOON }),
      session("d", { archivedAt: 0 }),
    ];
    const { active, archived } = splitArchived(sessions);
    expect(ids(active)).toEqual(["a", "c"]);
    expect(ids(archived)).toEqual(["b", "d"]);
    expect(splitArchived([])).toEqual({ active: [], archived: [] });
  });
});

describe("searchSessions", () => {
  const sessions = [
    session("s1", { title: "周报整理" }),
    session("s2", { title: "Weekly Sync" }),
    session("s3", { title: null }),
    session("s4", { title: "本周 Week 计划" }),
  ];

  it("过滤与恢复：中文子串、去首尾空白且大小写不敏感、title 为 null 按 新会话、无匹配为空", () => {
    expect(ids(searchSessions(sessions, "周报"))).toEqual(["s1"]);
    expect(ids(searchSessions(sessions, " WEEK "))).toEqual(["s2", "s4"]);
    expect(ids(searchSessions(sessions, "新会"))).toEqual(["s3"]);
    expect(searchSessions(sessions, "不存在")).toEqual([]);
    expect(ids(searchSessions(sessions, ""))).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("查询大小写与标题大小写互不敏感", () => {
    expect(ids(searchSessions(sessions, "weekly sync"))).toEqual(["s2"]);
    expect(ids(searchSessions(sessions, "WEEKLY"))).toEqual(["s2"]);
    expect(ids(searchSessions([session("lower", { title: "weekly" })], "WeEk"))).toEqual(["lower"]);
  });

  it("只去首尾空白：查询内部的空白按字面匹配", () => {
    expect(ids(searchSessions(sessions, "\t周 Week\n"))).toEqual(["s4"]);
    expect(searchSessions(sessions, "Weekly  Sync")).toEqual([]);
  });

  it("查询在标题中间、开头、结尾都算匹配", () => {
    expect(ids(searchSessions(sessions, "报整"))).toEqual(["s1"]);
    expect(ids(searchSessions(sessions, "ekly S"))).toEqual(["s2"]);
    expect(ids(searchSessions(sessions, "整理"))).toEqual(["s1"]);
    expect(ids(searchSessions(sessions, "本周"))).toEqual(["s4"]);
  });

  it("只有空白的查询等于不过滤，保持顺序与归档会话", () => {
    const withArchived = [...sessions, session("s5", { title: "周报存档", archivedAt: NOON })];
    expect(ids(searchSessions(withArchived, "   "))).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(ids(searchSessions(withArchived, "\n\t"))).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    // 归档与否由调用方先划分：搜索本身不看 archivedAt。
    expect(ids(searchSessions(withArchived, "周报"))).toEqual(["s1", "s5"]);
    expect(ids(searchSessions(splitArchived(withArchived).active, "周报"))).toEqual(["s1"]);
    expect(ids(searchSessions(splitArchived(withArchived).archived, "周报"))).toEqual(["s5"]);
  });

  it("不按 id、状态等其它字段匹配", () => {
    expect(searchSessions(sessions, "s1")).toEqual([]);
    expect(searchSessions(sessions, "done")).toEqual([]);
  });
});
