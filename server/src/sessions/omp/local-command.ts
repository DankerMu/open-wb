/**
 * Local-only completion rule (design D15): whether a matching `agentInvoked:false` outcome ends
 * the turn now, or the turn waits for a late `command_output` (omp `/compact` answers before its
 * output). Pure: keys only on the leading `/` of the dispatched text, knows no command names.
 */

/** Longest wait for a late `command_output` after a local-only outcome, on the injected clock. */
export const LOCAL_COMMAND_GRACE_MS = 120_000;

/** `other` covers `agentInvoked:true` outcomes, agent_end, failures and every other frame. */
export type LocalSignal = "local-outcome" | "command-output" | "grace-tick" | "other";

export interface LocalState {
  /** Dispatched wire text starts with `/`. */
  slashText: boolean;
  /** A `command_output` was seen after dispatch and before this signal. */
  outputSeen: boolean;
  /** The turn is already waiting for output. */
  awaiting: boolean;
  /** Injected-clock milliseconds since the outcome that started the wait. */
  elapsedMs: number;
}

export function decideLocalCompletion(
  state: LocalState,
  signal: LocalSignal,
): "complete" | "await" | "none" {
  switch (signal) {
    case "local-outcome":
      if (state.awaiting) {
        return "none";
      }
      return !state.slashText || state.outputSeen ? "complete" : "await";
    case "command-output":
      return state.awaiting ? "complete" : "none";
    case "grace-tick":
      return state.awaiting && state.elapsedMs >= LOCAL_COMMAND_GRACE_MS ? "complete" : "none";
    default:
      return "none";
  }
}
