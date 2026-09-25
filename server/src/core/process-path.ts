import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

/** Fixed sudo-mode launcher (util-linux); sudoers rules name this exact path. */
export const SETPRIV_PATH = "/usr/bin/setpriv";

/**
 * Sudo-mode PATH policy shared by configuration and spawn.
 * Direct mode does not call this and keeps its existing fallback.
 */
export function assertSafeSudoPath(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0 || raw.includes("\0")) {
    throw new Error("PATH must be absolute when OMP_USER is configured");
  }
  const entries = raw.split(delimiter);
  if (entries.length === 0 || entries.some((entry) => entry.length === 0 || !isAbsolute(entry))) {
    throw new Error("PATH must be absolute when OMP_USER is configured");
  }
  return raw;
}

/**
 * Sudo-mode launcher precondition shared by configuration and spawn:
 * a missing launcher fails instead of silently losing the pdeathsig guarantee.
 */
export function assertSetprivExecutable(): void {
  try {
    accessSync(SETPRIV_PATH, constants.X_OK);
  } catch {
    throw new Error(`${SETPRIV_PATH} must be executable when OMP_USER is configured`);
  }
}
