/**
 * Issue #1569 (omp-pin-18-12 design D8, turn-artifacts「浏览器截图」): omp writes browser screenshots
 * to `<cwd>/screenshots/` and an `eval` end frame names none, so the pump diffs that directory. On
 * `turn.start` (no tool running yet) the direct entry names of `<root>/screenshots` are the turn's
 * baseline; on each `eval` step.end new names merge into it, and those whose dirent is a regular
 * file (no stat) become write candidates in code-point order, a `files.changed` right before that
 * step.end. Reads (via a dir handle) stop past 4096 entries. Baseline ENOENT/ENOTDIR → empty;
 * other baseline failure or overflow → no comparison this turn; failed or overflowing step-end read
 * → no candidates, baseline unchanged; a merge past 4096 names → no candidates and no comparison
 * for the rest of the turn. A null root never reads. persistEvent owns the files.changed.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { compareMigrationFilenames as compareCodePoints } from "../core/db/migration-assets.js";
import type { PumpSteps } from "./approval-pairing.js";
import type { ChatEvent } from "./events.js";
import type { FileChange } from "./file-changes.js";

/** Read at call time so a test can count or fail it. */
export const screenshotFs = { opendirSync: nodeFs.opendirSync };

const LIMIT = 4096;

/** The directory's entries; "missing" for ENOENT / ENOTDIR; "failed" on any other error or overflow. */
function list(dir: string): nodeFs.Dirent[] | "missing" | "failed" {
  let handle: nodeFs.Dir;
  try {
    handle = screenshotFs.opendirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
  }
  const entries: nodeFs.Dirent[] = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entries.length === LIMIT) return "failed";
      entries.push(entry);
    }
    return entries;
  } catch {
    return "failed";
  } finally {
    handle.closeSync();
  }
}

export class ScreenshotDiff {
  readonly #dir: string | null;
  readonly #steps: Pick<PumpSteps, "toolNames">;
  /** This turn's names; null while comparison is off (no root/turn, failed read, past the cap). */
  #baseline: Set<string> | null = null;

  constructor(workspaceRoot: string | null, steps: Pick<PumpSteps, "toolNames">) {
    this.#dir = workspaceRoot === null ? null : join(workspaceRoot, "screenshots");
    this.#steps = steps;
  }

  turnStart(): void {
    const listing = this.#dir === null ? "failed" : list(this.#dir);
    const names = typeof listing === "string" ? [] : listing.map((e) => e.name);
    this.#baseline = listing === "failed" ? null : new Set(names);
  }

  evalEnd(): FileChange[] {
    const baseline = this.#baseline;
    const listing = this.#dir === null || baseline === null ? "failed" : list(this.#dir);
    if (baseline === null || typeof listing === "string") return [];
    const fresh = listing.filter((entry) => !baseline.has(entry.name));
    for (const entry of fresh) baseline.add(entry.name);
    if (baseline.size > LIMIT) this.#baseline = null; // A rotating writer must not grow memory.
    if (this.#baseline === null) return [];
    return fresh
      .flatMap((entry) => (entry.isFile() ? [entry.name] : []))
      .sort(compareCodePoints)
      .map(
        (name): FileChange => ({
          path: `screenshots/${name}`,
          added: null,
          removed: null,
          kind: "write",
        }),
      );
  }

  /** The pump's mapped events, each eval step.end preceded by its screenshots' files.changed. */
  annotate(events: ChatEvent<string>[]): ChatEvent<string>[] {
    if (this.#dir === null) return events;
    return events.flatMap((event): ChatEvent<string>[] => {
      if (event.type === "turn.start") this.turnStart();
      if (event.type !== "step.end" || this.#steps.toolNames.get(event.data.stepId) !== "eval") {
        return [event];
      }
      const files = this.evalEnd();
      const { messageId, stepId } = event.data;
      return files.length === 0
        ? [event]
        : [{ type: "files.changed", data: { messageId, stepId, files } }, event];
    });
  }
}
