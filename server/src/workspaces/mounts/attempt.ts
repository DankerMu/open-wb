/**
 * workspaces/mounts/attempt — one mount attempt and the clean-up around it, shared by creation, remount
 * and startup restore (s1b-workspace-mounts design D2 re-check, D3 manager side, D5, D7–D9;
 * workspace-mounts「挂载进程与挂载点」「挂载取值与主机规则」): judging the target again (source realpath
 * or host rule, the lookup limited), the credential file step, `cache/` and `rclone.log`, the mount
 * point check (D8), the spawn and the readiness wait (D9), and on failure discarding what the attempt
 * built. "Lazily unmount this mount" (D9, D10, D11, D12) is here too. No registry, no timer, no chain:
 * those are the manager's.
 *
 * Host lookups are limited to two in flight: `dns.lookup` runs on the libuv pool (four threads by
 * default) with no timeout and no cancellation, so a burst of mounts naming silent hosts would otherwise
 * queue every `fs/promises` call in the process behind them (#1778 hand-off). The limit wraps the
 * resolver, not the judgement: an IP literal host never resolves, so never waits.
 *
 * An attempt carries an abort signal (unmount and shutdown cancel it): rclone is SIGKILLed at once and
 * the attempt fails; a target judgement still pending (a silent DNS server, a hung NFS source) is no
 * longer waited for.
 */
import { lstat, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../../core/errors/index.js";
import { ensureOwnedDir, ensureOwnedFile } from "../../core/sandbox/dirs.js";
import { findExecutable, type MountSettings } from "./config.js";
import { type HostResolver, judgeHost } from "./host-policy.js";
import { readMountinfo, unmountTargets } from "./mountinfo.js";
import {
  awaitReady,
  killChild,
  lazyUnmountOne,
  type MountChild,
  mountArgv,
  type ProbeExec,
  spawnMount,
} from "./rclone-process.js";
import { acceptableSourcePath } from "./source-path.js";
import type { createMountStore, MountRecord } from "./store.js";

export const PRIVATE_DIR_MODE = 0o700;
const LOG_MODE = 0o600;
const READY_WINDOW_MS = 20_000;
const HOST_LOOKUPS_IN_FLIGHT = 2;
const NO_FUSERMOUNT =
  "mount detach: the mount is still in mountinfo and no executable fusermount3 is on PATH";
const KEPT_MOUNT_POINT =
  "mount detach: the mount point is not empty and was kept as a plain directory";

export interface AttemptContext
  extends Pick<MountSettings, "fusermountBin" | "ompUid" | "mountHostAllow"> {
  store: Pick<ReturnType<typeof createMountStore>, "getSource">;
  mountsDir: string;
  protectedRoots: readonly string[];
  mountinfoPath: string;
  path: string;
  resolveHost: HostResolver;
  probeExec: ProbeExec;
  buildMountPoint: (absPath: string) => void;
  readyTimeoutMs?: number | undefined;
  report(error: unknown): void;
}

/** What a mount attempt mounts: the remote argument and, for `sftp` / `smb`, the judged address. */
export interface Target {
  remote: string;
  address?: string;
}

/** One mount attempt's fixed inputs. */
export interface Attempt extends Target {
  id: string;
  /** `<mounts>/<id>`: the private directory, also rclone's `HOME`. */
  dir: string;
  section: string;
  root: string;
  mountPoint: string;
  readOnly: boolean;
  /** Aborted by detach / shutdown: rclone SIGKILLed, the attempt fails. */
  signal: AbortSignal;
}

/** The connection fields shared by a body and a row. */
export type Remote = Pick<MountRecord, "backend" | "host" | "remotePath" | "sourceId">;

/** The attempt failed on its own terms (not ready, refused, cancelled): no report. */
export class AttemptFailed extends Error {}

export function createAttempts(context: AttemptContext) {
  const { store, mountsDir, mountinfoPath, path, probeExec, report, buildMountPoint } = context;
  const lookupLimit = limitConcurrency(HOST_LOOKUPS_IN_FLIGHT);
  const limitedResolve: HostResolver = (host) => lookupLimit(() => context.resolveHost(host));
  /** A refused lazy unmount has already been reported. */
  const reportUnlessRefused = (error: unknown): void => {
    if (!(error instanceof HttpError)) {
      report(error);
    }
  };
  /** `-uz` on the mount point (when mounted) and on every mount of the section (design D9). */
  const lazyUnmount = async (mountPoint: string | undefined, section: string): Promise<void> => {
    const targets = unmountTargets(readMountinfo(mountinfoPath), mountPoint, section);
    if (targets.length === 0) {
      return;
    }
    const fusermount = context.fusermountBin ?? findExecutable(path, "fusermount3");
    if (fusermount === undefined) {
      report(new Error(NO_FUSERMOUNT));
      throw new HttpError("mount_disabled");
    }
    for (const target of targets) {
      if (!(await lazyUnmountOne(fusermount, target, path))) {
        report(new Error(`mount unmount: fusermount3 -uz failed for ${target}`));
      }
    }
  };

  /** A non-empty mount point stays; `reportKept` reports that once (a detach, not every remount). */
  const removeMountPoint = async (mountPoint: string, reportKept: boolean): Promise<void> => {
    try {
      await rmdir(mountPoint);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        if (reportKept) {
          report(new Error(KEPT_MOUNT_POINT, { cause: error }));
        }
      } else if (code !== "ENOENT") {
        report(error);
      }
    }
  };

  const removePrivateDir = (dir: string): Promise<void> =>
    rm(dir, { recursive: true, force: true }).catch(report);

  /**
   * A failed attempt: stop rclone, unmount wherever it landed, remove the mount point it checked (when
   * empty) and, for a creation (`dir` given), the private directory.
   */
  const discard = async (
    child: MountChild | undefined,
    mountPoint: string | undefined,
    section: string,
    dir: string | undefined,
  ): Promise<void> => {
    if (child !== undefined) {
      await killChild(child);
    }
    await lazyUnmount(mountPoint, section).catch(reportUnlessRefused);
    if (mountPoint !== undefined) {
      await removeMountPoint(mountPoint, dir !== undefined);
    }
    if (dir !== undefined) {
      await removePrivateDir(dir);
    }
  };

  /** Design D8: `lstat` first; only a missing entry is built, then `lstat` again. */
  const mountPointUsable = async (mountPoint: string): Promise<boolean> => {
    let stats = await lstat(mountPoint).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (stats === undefined) {
      buildMountPoint(mountPoint);
      stats = await lstat(mountPoint);
    }
    return stats.isDirectory() && stats.uid === process.geteuid?.();
  };

  /** D2: the source is still registered and its realpath still the registered, acceptable one. */
  const sourceTarget = async (sourceId: string | null): Promise<Target> => {
    const source = sourceId === null ? undefined : store.getSource(sourceId);
    if (source === undefined) {
      throw new HttpError("not_found");
    }
    if ((await acceptableSourcePath(source.path, context.protectedRoots)) !== source.path) {
      throw new HttpError("mount_failed");
    }
    return { remote: source.path };
  };

  /** Re-checked on every attempt (D2 source rule, D3 host rule); refusals throw `HttpError`. */
  const target = async (remote: Remote): Promise<Target> => {
    if (remote.backend === "local") {
      return sourceTarget(remote.sourceId);
    }
    const verdict = await judgeHost(remote.host ?? "", context.mountHostAllow, limitedResolve);
    if (verdict.verdict === "rejected") {
      throw new HttpError("mount_host_rejected");
    }
    if (verdict.verdict === "unresolved") {
      throw new HttpError("mount_failed");
    }
    const remotePath = remote.remotePath ?? "";
    return {
      remote: remote.backend === "smb" ? remotePath.slice(1) : remotePath,
      address: verdict.address,
    };
  };

  /** Spawns rclone for a checked mount point and waits for readiness; `onSpawn` gets the child at once. */
  const spawnReady = async (
    rcloneBin: string,
    attempt: Attempt,
    onSpawn: (child: MountChild) => void,
  ): Promise<boolean> => {
    const { mountPoint, section, signal } = attempt;
    const share =
      context.ompUid === undefined
        ? undefined
        : { uid: context.ompUid, gid: (await stat(attempt.root)).gid };
    if (signal.aborted) {
      return false;
    }
    const child = spawnMount(rcloneBin, mountArgv({ ...attempt, share }), {
      PATH: path,
      HOME: attempt.dir,
    });
    onSpawn(child);
    const deadline = Date.now() + (context.readyTimeoutMs ?? READY_WINDOW_MS);
    const wait = { child, mountinfoPath, mountPoint, section, deadline, probeExec, signal };
    return (await awaitReady(wait)) && !signal.aborted;
  };

  /**
   * One mount attempt in the attempt's existing private directory: credential file (`writeConf`),
   * `cache/`, `rclone.log`, the mount point check, the spawn and the readiness wait. Any failure, the
   * signal included, discards what the attempt built (`fresh`: the private directory too) and throws
   * `AttemptFailed`; only unexpected errors are reported.
   */
  const mountOnce = async (
    rcloneBin: string,
    attempt: Attempt,
    writeConf: () => Promise<void>,
    fresh: boolean,
  ): Promise<MountChild> => {
    const { dir, section, mountPoint, signal } = attempt;
    let child: MountChild | undefined;
    let built: string | undefined;
    const kill = () => child?.signal("SIGKILL");
    signal.addEventListener("abort", kill);
    try {
      await writeConf();
      ensureOwnedDir(join(dir, "cache"), PRIVATE_DIR_MODE);
      ensureOwnedFile(join(dir, "rclone.log"), LOG_MODE);
      if (!(await mountPointUsable(mountPoint))) {
        throw new AttemptFailed();
      }
      built = mountPoint;
      const ready = await spawnReady(rcloneBin, attempt, (spawned) => {
        child = spawned;
      });
      if (!ready || child === undefined) {
        throw new AttemptFailed();
      }
      return child;
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        report(error);
      }
      await discard(child, built, section, fresh ? dir : undefined);
      throw new AttemptFailed();
    } finally {
      signal.removeEventListener("abort", kill);
    }
  };

  const attemptOf = (
    id: string,
    root: string,
    name: string,
    readOnly: boolean,
    found: Target,
    signal: AbortSignal,
  ): Attempt => ({
    id,
    dir: join(mountsDir, id),
    section: `m${id}`,
    root,
    mountPoint: join(root, name),
    readOnly,
    signal,
    ...found,
  });

  return {
    lazyUnmount,
    removeMountPoint,
    removePrivateDir,
    discard,
    target,
    mountOnce,
    attemptOf,
    reportUnlessRefused,
  };
}

/** `work`'s outcome, or `AttemptFailed` as soon as `signal` aborts (`work` itself runs on). */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((settle, fail) => {
    const onAbort = () => fail(new AttemptFailed());
    if (signal.aborted) {
      onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(settle, fail).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** At most `max` tasks run at once; a finished task hands its slot straight to the next waiter. */
function limitConcurrency(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active += 1;
    } else {
      await new Promise<void>((admit) => waiting.push(admit));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) {
        active -= 1;
      } else {
        next();
      }
    }
  };
}
