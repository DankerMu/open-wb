/**
 * Session supervisor fault plumbing: shutdown fault aggregation, the synchronous-sink check and
 * the regenerate/fork/prompt error translation.
 */
import { HttpError } from "../core/errors/index.js";
import { AgentUnavailableError, OmpProtocolError } from "./omp/process.js";
import { SessionBusyError } from "./omp/runtime.js";

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

export function synchronousSinkViolation(returned: unknown): Error | undefined {
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

/**
 * The prompt/regenerate/fork rejection: an HttpError as is, a runtime busy error as `session_busy`,
 * a runtime or protocol failure as `agent_unavailable`, anything else unchanged.
 */
export function translateSupervisorError(error: unknown): unknown {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof SessionBusyError) {
    return new HttpError("session_busy");
  }
  if (error instanceof AgentUnavailableError || error instanceof OmpProtocolError) {
    return new HttpError("agent_unavailable");
  }
  return error;
}
