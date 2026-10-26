/**
 * workspaces/mounts/source-path — the mount-source path rule (s1b-workspace-mounts design D2;
 * workspace-mounts「挂载源端点」): the realpath of a source must be an existing directory that neither
 * equals, lies inside nor contains the realpath of any protected root (`SANDBOX_ROOT`, `OMP_STATE_DIR`,
 * `dirname(DB_PATH)`, `STATIC_ROOT`, `dirname(OMP_BIN)` — otherwise a mount would hand app-private state,
 * other sandboxes, the static front end or the omp binary to omp). Registration stores the realpath this
 * returns; the manager re-checks it before every attempt of a `local` mount (it must come back unchanged).
 * A protected root that does not resolve is compared as given.
 */
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** The source's realpath when the rule holds; `undefined` when it does not or the path does not resolve. */
export async function acceptableSourcePath(
  path: string,
  protectedRoots: readonly string[],
): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  for (const root of protectedRoots) {
    const guarded = await realpath(root).catch(() => resolve(root));
    if (overlaps(real, guarded)) {
      return undefined;
    }
  }
  return real;
}

function overlaps(a: string, b: string): boolean {
  return a === b || within(a, b) || within(b, a);
}

function within(inner: string, outer: string): boolean {
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}
