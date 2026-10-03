/**
 * OMP_STATE_DIR managed layout (issue #706, ADR-0010): the single source of every path under the
 * state dir and of their permission bits. Managed configuration (`home/.omp/agent`: `models.yml`,
 * operator-installed `skills/`) is owned by the app uid and read-only for the omp uid; omp's own
 * runtime state goes to `xdg/{data,state,cache}/omp`, which omp v18.0.10 uses only when it runs
 * with its default agent dir (`$HOME/.omp/agent`, no `PI_CODING_AGENT_DIR`) and the directory
 * already exists (`resource/oh-my-pi/packages/utils/src/dirs.ts`), so the host creates all three.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnedDir } from "../../core/sandbox/dirs.js";

export type OmpXdgCategory = "data" | "state" | "cache";

/** omp's `HOME`: writable by the omp uid, sticky so it cannot rename or remove the app's `.omp`. */
export function ompHome(stateDir: string): string {
  return join(stateDir, "home");
}

/** omp's default agent dir `$HOME/.omp/agent`: managed `models.yml` and `skills/`. */
export function ompAgentDir(stateDir: string): string {
  return join(ompHome(stateDir), ".omp", "agent");
}

/** The value of `XDG_<CATEGORY>_HOME`; omp's runtime state lives in its `omp` subdirectory. */
export function ompXdgHome(stateDir: string, category: OmpXdgCategory): string {
  return join(stateDir, "xdg", category);
}

/** The owner's omp session directory (`--session-dir`). */
export function ompSessionDir(stateDir: string, ownerId: string): string {
  return join(stateDir, "sessions", ownerId);
}

const MANAGED = 0o2750;
const OMP_WRITABLE = 0o2770;
const OMP_HOME = 0o3770;

/** Parents before children; paths relative to the resolved state root. */
const LAYOUT: readonly (readonly [path: string, mode: number])[] = [
  ["", MANAGED],
  ["home", OMP_HOME],
  ["home/.omp", MANAGED],
  ["home/.omp/agent", MANAGED],
  ["xdg", MANAGED],
  ["xdg/data", MANAGED],
  ["xdg/data/omp", OMP_WRITABLE],
  ["xdg/state", MANAGED],
  ["xdg/state/omp", OMP_WRITABLE],
  ["xdg/cache", MANAGED],
  ["xdg/cache/omp", OMP_WRITABLE],
  ["sessions", MANAGED],
];

/**
 * Creates the layout and re-asserts every mode, so a directory widened from outside is corrected
 * and one that is a symlink, not a directory or not ours fails instead of being followed. Only the
 * state dir itself may be a symlink (an operator-placed one): the layout is applied under its
 * kernel realpath, which is returned. Missing parents of the state dir are created untouched.
 */
export function ensureOmpStateLayout(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const root = realpathSync.native(stateDir);
  for (const [path, mode] of LAYOUT) {
    ensureOwnedDir(join(root, path), mode);
  }
  return root;
}

/** `sessions/<ownerId>` under an already ensured layout root: the one per-owner directory. */
export function ensureOmpSessionDir(root: string, ownerId: string): void {
  ensureOwnedDir(ompSessionDir(root, ownerId), OMP_WRITABLE);
}
