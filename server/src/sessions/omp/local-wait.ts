/**
 * Local completion wait (#553, moved out of runtime.ts in #1600): owns the waiting turn and its
 * timer on the injected clock; the rule itself is `decideLocalCompletion` (local-command.ts).
 */
import { localSignal, type Turn } from "./commands.js";
import type { OmpFrame } from "./frame.js";
import { decideLocalCompletion, LOCAL_COMMAND_GRACE_MS, type LocalState } from "./local-command.js";
import type { SessionClock } from "./runtime.js";

/** A turn waiting for a late `command_output` after its local-only outcome (design D15). */
interface LocalWait {
  turn: Turn;
  since: number;
  timer: unknown;
}

export class LocalCompletionWait {
  readonly #clock: SessionClock;
  readonly #current: () => Turn | undefined;
  readonly #complete: (turn: Turn) => void;
  #wait: LocalWait | undefined;

  constructor(
    clock: SessionClock,
    current: () => Turn | undefined,
    complete: (turn: Turn) => void,
  ) {
    this.#clock = clock;
    this.#current = current;
    this.#complete = complete;
  }

  /** Local-only completion: a `/` turn without output waits for it or for the grace. */
  onFrame(turn: Turn, frame: OmpFrame): void {
    const decision = decideLocalCompletion(
      this.#localState(turn, 0),
      localSignal(frame, turn.requestId),
    );
    if (frame.type === "command_output") {
      turn.commandOutputSeen = true;
    }
    if (decision === "complete") {
      this.#complete(turn);
    } else if (decision === "await") {
      this.#awaitOutput(turn);
    }
  }

  #awaitOutput(turn: Turn): void {
    const wait: LocalWait = { turn, since: this.#clock.now(), timer: undefined };
    const tick = (): void => {
      if (this.#wait !== wait || this.#current() !== turn) {
        return;
      }
      const elapsedMs = this.#clock.now() - wait.since;
      if (decideLocalCompletion(this.#localState(turn, elapsedMs), "grace-tick") === "complete") {
        this.#complete(turn);
        return;
      }
      // Wall clock behind the timer (rounding, rollback): re-arm and replace the handle.
      wait.timer = this.#clock.setTimeout(tick, Math.max(1, LOCAL_COMMAND_GRACE_MS - elapsedMs));
    };
    this.#wait = wait;
    wait.timer = this.#clock.setTimeout(tick, LOCAL_COMMAND_GRACE_MS);
  }

  #localState(turn: Turn, elapsedMs: number): LocalState {
    const awaiting = this.#wait?.turn === turn;
    return { slashText: turn.slashText, outputSeen: turn.commandOutputSeen, awaiting, elapsedMs };
  }

  clear(): void {
    const wait = this.#wait;
    if (wait !== undefined) {
      this.#wait = undefined;
      this.#clock.clearTimeout(wait.timer);
    }
  }

  /** Retiring a generation drops only a wait that belongs to it. */
  clearFor(genId: number): void {
    if (this.#wait?.turn.genId === genId) {
      this.clear();
    }
  }
}
