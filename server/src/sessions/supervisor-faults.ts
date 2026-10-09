/**
 * Session supervisor fault plumbing: shutdown fault aggregation, the synchronous-sink check and
 * the regenerate/fork/prompt error translation.
 */
import { HttpError } from "../core/errors/index.js";
import type { ChatEvent } from "./events.js";
import { AgentUnavailableError, OmpProtocolError } from "./omp/process.js";
import { SessionBusyError } from "./omp/runtime.js";
import { ReadmissionRequired } from "./pool.js";

export function throwCollected(faults: Error[]): void {
  if (faults.length === 1) {
    throw faults[0];
  }
  if (faults.length > 1) {
    throw new AggregateError(faults, "session supervisor shutdown failed");
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function synchronousSinkViolation(returned: unknown): Error | undefined {
  if ((typeof returned !== "object" && typeof returned !== "function") || returned === null) {
    return undefined;
  }
  let then: unknown;
  try {
    then = "then" in returned ? returned.then : undefined;
  } catch (error) {
    return asError(error);
  }
  if (typeof then !== "function") {
    return undefined;
  }
  try {
    then.call(returned, undefined, () => undefined);
  } catch {
    /* a throwing then is containment, not a second reported violation */
  }
  return new Error("session observation sink must return synchronously");
}

/** Owned fault retention: keep the error, report it, keep what the report sink did wrong too. */
export function retainFault(faults: Error[], onError: (error: Error) => void, error: Error): void {
  faults.push(error);
  try {
    const returned = onError(error);
    const violation = synchronousSinkViolation(returned);
    if (violation !== undefined) {
      faults.push(violation);
    }
  } catch (thrown) {
    faults.push(asError(thrown));
  }
}

/**
 * Calls the optional synchronous `onEvent` observer: what it threw, or its synchronous-sink
 * violation, as the error to fault the slot with; undefined without an observer or on a clean call.
 */
export function observerViolation(
  onEvent: ((sessionId: string, epoch: number, event: ChatEvent<number>) => void) | undefined,
  sessionId: string,
  epoch: number,
  event: ChatEvent<number>,
): Error | undefined {
  if (onEvent === undefined) {
    return undefined;
  }
  try {
    const returned = onEvent(sessionId, epoch, event);
    return synchronousSinkViolation(returned);
  } catch (error) {
    return asError(error);
  }
}

/**
 * The prompt/regenerate/fork rejection: an HttpError as is, a runtime busy error as `session_busy`,
 * a runtime or protocol failure as `agent_unavailable`, anything else unchanged. A re-admission
 * that reaches here was not absorbed by the live slot's one fresh admission: the process of a newly
 * admitted slot died between two runtime calls of the same dispatch (#1010), which is
 * `agent_unavailable` too.
 */
export function translateSupervisorError(error: unknown): unknown {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof SessionBusyError) {
    return new HttpError("session_busy");
  }
  if (
    error instanceof AgentUnavailableError ||
    error instanceof OmpProtocolError ||
    error instanceof ReadmissionRequired
  ) {
    return new HttpError("agent_unavailable");
  }
  return error;
}
