/**
 * Issue #909 upstream-failure「上游失败日志」: one record per published `error` whose reason is not
 * `agent_failed`, through the sessions `log` port. Exactly four keys, in this order (the production
 * entry writes the record as one JSON line): no detail, upstream text, path or credential.
 */
import type { ChatEvent } from "./events.js";
import { consumeThenable, type SpawnLog } from "./omp/spawn-gate.js";
import type { FailureReason } from "./upstream-classify.js";

export interface UpstreamFailedRecord {
  event: "upstream_failed";
  sessionId: string;
  reason: Exclude<FailureReason, "agent_failed">;
  status: number | null;
}

/**
 * Called with every event the supervisor committed (mapper output); only an `error` whose reason
 * is not `agent_failed` is recorded. A throwing log or a returned thenable never alters the turn.
 */
export function reportUpstreamFailure(
  log: SpawnLog,
  sessionId: string,
  event: ChatEvent<string>,
): void {
  if (event.type !== "error" || event.data.reason === "agent_failed") {
    return;
  }
  const { reason, status } = event.data;
  try {
    consumeThenable(log({ event: "upstream_failed", sessionId, reason, status }));
  } catch {
    // The log port is observation only: its failure never changes the turn.
  }
}
