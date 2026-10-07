import type { ChatSession } from "../../lib/session-contract.js";
import { sessionTitle } from "./session-path.js";

// 工作空间 id 是 32 位十六进制，这个键不可能与之相撞。
const UNKNOWN_SPACE_KEY = "unknown";
const UNKNOWN_SPACE_NAME = "未知空间";

function sameLocalDay(left: number, right: number) {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export type SessionGrouping = "workspace" | "time";

/** 分组键：`pinned`、`temporary`、`unknown`、`today`、`week`、`earlier` 或工作空间 id。 */
export type SessionGroup = { key: string; name: string; sessions: ChatSession[] };

/** 按 `archivedAt` 是否为 null 二分，各自保持输入顺序。 */
export function splitArchived(sessions: readonly ChatSession[]): {
  active: ChatSession[];
  archived: ChatSession[];
} {
  return {
    active: sessions.filter((session) => session.archivedAt === null),
    archived: sessions.filter((session) => session.archivedAt !== null),
  };
}

/**
 * 显示标题（`sessionTitle`，无标题时为 `新会话`）的子串匹配：查询去首尾空白，两侧各自 `toLowerCase()`。去空白后为空串时不过滤。
 * 保持输入顺序、不看 `archivedAt`——默认视图与归档视图由调用方先用 `splitArchived` 划分。
 */
export function searchSessions(sessions: readonly ChatSession[], query: string): ChatSession[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...sessions];
  return sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle));
}

/**
 * `今天`：与 `now` 同一本地日历日，或更晚；`近 7 天`：今天之前的 1 至 6 个日历日；其余 `更早`。
 * 下界用本地时间构造器按日序号回退，不用 24 小时的倍数——夏令时切换日的天长不是 24 小时。
 */
function timeGroupKey(updatedAt: number, now: number): "today" | "week" | "earlier" {
  if (updatedAt > now || sameLocalDay(updatedAt, now)) return "today";
  const today = new Date(now);
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  return updatedAt >= weekStart.getTime() ? "week" : "earlier";
}

/**
 * 默认视图的有序分组：只含未归档的会话，每个会话恰落一组，组内保持输入（服务端）顺序，
 * 空组不产出。`置顶任务` 始终在最前，其余按 `mode`：
 * - `workspace`：`workspaces` 里的空间按其顺序、以 id 为键；`temporaryWorkspace` 为 true 或
 *   `workspaceId` 为 null 的归 `临时空间`；其余归末位 `未知空间`。`workspaces` 为 null 表示没有
 *   已读取的空间列表，此时绑定正式空间的会话全部归 `未知空间`。
 * - `time`：按 `updatedAt` 相对 `now`（调用方注入的毫秒，这里不读时钟）归 `今天` / `近 7 天` / `更早`。
 */
export function groupSessionList(
  sessions: readonly ChatSession[],
  workspaces: readonly { id: string; name: string }[] | null,
  mode: SessionGrouping,
  now: number,
): SessionGroup[] {
  const pinned: SessionGroup = { key: "pinned", name: "置顶任务", sessions: [] };
  const temporary: SessionGroup = { key: "temporary", name: "临时空间", sessions: [] };
  const unknown: SessionGroup = { key: UNKNOWN_SPACE_KEY, name: UNKNOWN_SPACE_NAME, sessions: [] };
  const known = new Map<string, SessionGroup>(
    (workspaces ?? []).map(({ id, name }) => [id, { key: id, name, sessions: [] }]),
  );
  const times: Record<ReturnType<typeof timeGroupKey>, SessionGroup> = {
    today: { key: "today", name: "今天", sessions: [] },
    week: { key: "week", name: "近 7 天", sessions: [] },
    earlier: { key: "earlier", name: "更早", sessions: [] },
  };
  for (const session of sessions) {
    if (session.archivedAt !== null) continue;
    if (session.pinnedAt !== null) {
      pinned.sessions.push(session);
    } else if (mode === "time") {
      times[timeGroupKey(session.updatedAt, now)].sessions.push(session);
    } else if (session.temporaryWorkspace || session.workspaceId === null) {
      temporary.sessions.push(session);
    } else {
      (known.get(session.workspaceId) ?? unknown).sessions.push(session);
    }
  }
  return [
    pinned,
    ...known.values(),
    temporary,
    unknown,
    times.today,
    times.week,
    times.earlier,
  ].filter((group) => group.sessions.length > 0);
}
