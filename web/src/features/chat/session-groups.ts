import type { ChatSession } from "../../lib/session-contract.js";

export type SessionFilter = {
  status: "all" | "running" | "finished";
  time: "all" | "today" | "earlier";
};

export const DEFAULT_SESSION_FILTER: SessionFilter = { status: "all", time: "all" };

type SessionSubgroup = { key: string; name: string; sessions: ChatSession[] };

// 工作空间 id 是 32 位十六进制，这个键不可能与之相撞。
const UNKNOWN_SPACE_KEY = "unknown";
const UNKNOWN_SPACE_NAME = "未知空间";

/** `已完成` 只含三种终态：`idle` 既不是进行中也不是已完成，只在 `全部` 下出现。 */
function matchesStatus(session: ChatSession, status: SessionFilter["status"]) {
  if (status === "all") return true;
  if (status === "running") return session.status === "running";
  return session.status === "done" || session.status === "failed" || session.status === "stopped";
}

function sameLocalDay(left: number, right: number) {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 状态 × 时间取交集，保持输入顺序、不改输入。`now` 由调用方注入（毫秒），这里不读时钟；
 * `今天` 为 `updatedAt` 与 `now` 落在同一个本地日历日，`更早` 为其余（含晚于 `now` 的日历日）。
 */
export function filterSessions(
  sessions: readonly ChatSession[],
  filter: SessionFilter,
  now: number,
): ChatSession[] {
  return sessions.filter((session) => {
    if (!matchesStatus(session, filter.status)) return false;
    if (filter.time === "all") return true;
    return sameLocalDay(session.updatedAt, now) === (filter.time === "today");
  });
}

/**
 * 互斥分区：置顶 > 空间 > 任务，每个会话恰落一处，各处保持输入（服务端）顺序。空间子组以
 * 工作空间 id 为键、按 `workspaces` 的顺序排列且只含非空子组；`workspaces` 为 null（尚无已读取
 * 列表）或不含该 id 的会话归末位 `未知空间`。
 */
export function groupSessions(
  sessions: readonly ChatSession[],
  workspaces: readonly { id: string; name: string }[] | null,
): { pinned: ChatSession[]; tasks: ChatSession[]; spaces: SessionSubgroup[] } {
  const pinned: ChatSession[] = [];
  const tasks: ChatSession[] = [];
  const unknown: ChatSession[] = [];
  const known = new Map<string, SessionSubgroup>(
    (workspaces ?? []).map(({ id, name }) => [id, { key: id, name, sessions: [] }]),
  );
  for (const session of sessions) {
    if (session.pinnedAt !== null) {
      pinned.push(session);
    } else if (session.workspaceId === null) {
      tasks.push(session);
    } else {
      (known.get(session.workspaceId)?.sessions ?? unknown).push(session);
    }
  }
  const spaces = [...known.values()].filter((space) => space.sessions.length > 0);
  if (unknown.length > 0) {
    spaces.push({ key: UNKNOWN_SPACE_KEY, name: UNKNOWN_SPACE_NAME, sessions: unknown });
  }
  return { pinned, tasks, spaces };
}
