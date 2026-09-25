/**
 * Issue #351 test seam for the fixed sudo-mode launcher precondition.
 * Replaces fs.accessSync only for /usr/bin/setpriv (live named-import binding via
 * syncBuiltinESMExports); every other path keeps the native call. No production knob.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach } from "vitest";

const SETPRIV = "/usr/bin/setpriv";

type Access = typeof fs.accessSync;
export type SetprivOutcome = "present" | "ENOENT" | "EACCES";

export interface SetprivStub {
  calls: Array<{ path: unknown; mode: unknown }>;
  restore(): void;
}

export function stubSetpriv(outcome: SetprivOutcome): SetprivStub {
  const target = fs as unknown as { accessSync: Access };
  const native = target.accessSync;
  const calls: SetprivStub["calls"] = [];
  target.accessSync = (path, mode) => {
    if (path !== SETPRIV) {
      native(path, mode);
      return;
    }
    calls.push({ path, mode });
    if (outcome !== "present") {
      throw Object.assign(new Error(`${outcome}: ${SETPRIV}`), { code: outcome });
    }
  };
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      target.accessSync = native;
      syncBuiltinESMExports();
    },
  };
}

/** Present launcher for every test in the calling file (macOS has no /usr/bin/setpriv). */
export function useSetprivStub(): void {
  let stub: SetprivStub | undefined;
  beforeEach(() => {
    stub = stubSetpriv("present");
  });
  afterEach(() => {
    stub?.restore();
    stub = undefined;
  });
}
