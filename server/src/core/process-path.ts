import { delimiter, isAbsolute } from "node:path";

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
