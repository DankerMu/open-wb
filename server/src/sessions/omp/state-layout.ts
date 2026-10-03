/**
 * OMP_STATE_DIR managed layout (issue #706, ADR-0010): the single source of every path under the
 * state dir and of their permission bits. Managed configuration (`home/.omp/agent`: `models.yml`,
 * `host-overlay.yml`, operator-installed `skills/`) is owned by the app uid and read-only for the
 * omp uid; omp's own runtime state goes to `xdg/{data,state,cache}/omp`, which omp v18.0.10 uses
 * only when its agent dir is the default one (`$HOME/.omp/agent`; `PI_CODING_AGENT_DIR` is set to
 * that very string) and the directory already exists
 * (`resource/oh-my-pi/packages/utils/src/dirs.ts`), so the host creates all three. `home/.env`,
 * which omp loads at startup, is pre-created and owned by the app uid (issue #802).
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnedDir, ensureOwnedFile } from "../../core/sandbox/dirs.js";

export type OmpXdgCategory = "data" | "state" | "cache";

/** omp's `HOME`: writable by the omp uid, sticky so it cannot rename or remove the app's `.omp`. */
export function ompHome(stateDir: string): string {
  return join(stateDir, "home");
}

/** omp's default agent dir `$HOME/.omp/agent`: managed `models.yml` and `skills/`. */
export function ompAgentDir(stateDir: string): string {
  return join(ompHome(stateDir), ".omp", "agent");
}

/** The `--config` overlay of every spawn (`host-overlay.ts`), in the agent dir omp cannot write. */
export function ompHostOverlayPath(stateDir: string): string {
  return join(ompAgentDir(stateDir), "host-overlay.yml");
}

/** The value of `XDG_<CATEGORY>_HOME`; omp's runtime state lives in its `omp` subdirectory. */
export function ompXdgHome(stateDir: string, category: OmpXdgCategory): string {
  return join(stateDir, "xdg", category);
}

/** The owner's omp session directory (`--session-dir`). */
export function ompSessionDir(stateDir: string, ownerId: string): string {
  return join(stateDir, "sessions", ownerId);
}

/**
 * App-private: session deletion moves an artifact directory here before removing it recursively
 * (`session-delete.ts`), so the omp uid cannot reach the tree being removed by path.
 */
export function ompTrashDir(stateDir: string): string {
  return join(stateDir, "trash");
}

const MANAGED = 0o2750;
const OMP_WRITABLE = 0o2770;
const OMP_HOME = 0o3770;
/** A `home` being cold-built: no group or other bits yet; setgid stays so `.omp` inherits the group. */
const OMP_HOME_UNOPENED = 0o2700;
const APP_PRIVATE = 0o700;
/** `home/.env`: omp reads it; the sticky `home` keeps the omp uid from replacing it. */
const HOME_DOTENV = 0o640;

/**
 * Parents before children; paths relative to the resolved state root. The root and `home` come
 * first and are handled by `ensureOmpStateLayout` itself.
 */
const LAYOUT: readonly (readonly [path: string, mode: number])[] = [
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
  ["trash", APP_PRIVATE],
];

/**
 * Creates the layout and re-asserts every mode, so a directory widened from outside is corrected
 * and one that is a symlink, not a directory or not ours fails instead of being followed. Only the
 * state dir itself may be a symlink (an operator-placed one): the layout is applied under its
 * kernel realpath, which is returned. Missing parents of the state dir are created untouched.
 * A missing `home` is opened to the omp group only after `.omp` and `agent` stand in it: a
 * leftover omp-uid process could otherwise create `home/.omp` first and fail the layout on its
 * owner check. An existing `home` is never narrowed first: running omp processes are using it.
 * `home/.env` is created (empty; its content is the operator's) before a cold `home` opens, for
 * the same reason. A state dir containing `:` is refused: `PI_CONFIG_FILES` is `:`-separated.
 */
export function ensureOmpStateLayout(stateDir: string): string {
  if (stateDir.includes(":")) {
    throw new Error("OMP_STATE_DIR must not contain ':'");
  }
  mkdirSync(stateDir, { recursive: true });
  const root = realpathSync.native(stateDir);
  ensureOwnedDir(root, MANAGED);
  const home = ompHome(root);
  // A dangling symlink counts as missing here and is then refused by `ensureOwnedDir`.
  const cold = !existsSync(home);
  ensureOwnedDir(home, cold ? OMP_HOME_UNOPENED : OMP_HOME);
  ensureOwnedFile(join(home, ".env"), HOME_DOTENV);
  for (const [path, mode] of LAYOUT) {
    ensureOwnedDir(join(root, path), mode);
  }
  if (cold) {
    ensureOwnedDir(home, OMP_HOME);
  }
  return root;
}

/** `sessions/<ownerId>` under an already ensured layout root: the one per-owner directory. */
export function ensureOmpSessionDir(root: string, ownerId: string): void {
  ensureOwnedDir(ompSessionDir(root, ownerId), OMP_WRITABLE);
}
