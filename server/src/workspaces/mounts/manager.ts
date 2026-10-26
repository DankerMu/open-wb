/**
 * workspaces/mounts/manager — the mount-manager's attach and unmount half (s1b-workspace-mounts design D3
 * manager side, D5, D7–D10, D15; workspace-mounts「挂载凭证文件」「挂载进程与挂载点」「挂载取值与主机规则」
 * and「临时空间与删除前卸载」「按空间卸载全部」). Probing, remount backoff, the per-workspace serial chain,
 * loading the registry at construction, `restoreAll` / `closeAll` and the production wiring are group 6.
 *
 * `attach` runs one mount attempt and, once it is ready, inserts the row (the caller's `within` runs in
 * that transaction — `mount.attach` audit, source re-check); every refusal is an `HttpError`
 * (`mount_disabled`, `not_found`, `mount_host_rejected`, `mount_failed`) and leaves no row, private
 * directory, mount point, process or mountinfo line of this mount behind. `detach` lazily unmounts,
 * stops rclone, removes the mount point (kept when not empty) and the private directory, then deletes the
 * row with its `mount.detach` audit; file-system failures go to `onError` and do not keep the row.
 *
 * Host lookups are limited to two in flight: `dns.lookup` runs on the libuv pool (four threads by
 * default) with no timeout and no cancellation, so a burst of mounts naming silent hosts would otherwise
 * queue every `fs/promises` call in the process behind them (#1778 hand-off). The rest wait their turn.
 * The limit wraps the resolver, not the judgement: an IP literal host never resolves, so never waits.
 */
import { lstat, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { emit } from "../../core/audit/index.js";
import { HttpError } from "../../core/errors/index.js";
import { ensureOwnedDir, ensureOwnedFile, ensureSharedDir } from "../../core/sandbox/dirs.js";
import { findExecutable, type MountSettings } from "./config.js";
import { type HostResolver, judgeHost, systemResolver } from "./host-policy.js";
import { readMountinfo, SYSTEM_MOUNTINFO, unmountTargets } from "./mountinfo.js";
import { writeRcloneConf } from "./rclone-conf.js";
import {
  awaitReady,
  killChild,
  lazyUnmountOne,
  type MountChild,
  mountArgv,
  type ProbeExec,
  probeInChild,
  spawnMount,
  stopChild,
} from "./rclone-process.js";
import { acceptableSourcePath } from "./source-path.js";
import type { createMountStore, MountRecord } from "./store.js";
import type { MountBody } from "./validate.js";

type MountStore = ReturnType<typeof createMountStore>;

const PRIVATE_DIR_MODE = 0o700;
const LOG_MODE = 0o600;
const READY_WINDOW_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const HOST_LOOKUPS_IN_FLIGHT = 2;
const NO_FUSERMOUNT =
  "mount detach: the mount is still in mountinfo and no executable fusermount3 is on PATH";
const KEPT_MOUNT_POINT =
  "mount detach: the mount point is not empty and was kept as a plain directory";

export interface MountManagerOptions
  extends Pick<MountSettings, "rcloneBin" | "fusermountBin" | "ompUid" | "mountHostAllow"> {
  store: MountStore;
  audit: { emit(event: Parameters<typeof emit>[1]): unknown };
  /** `<OMP_STATE_DIR realpath>/mounts` (`ompMountsDir`): existing, app-private. */
  mountsDir: string;
  /**
   * The workspace root's absolute path as the kernel reports it in mountinfo — its realpath, no
   * symlinked component — or null for a workspace that is not the owner's. Any other spelling makes
   * every mount read as landed elsewhere and fail.
   */
  workspaceRootOf(ownerId: string, workspaceId: string): string | null;
  /** The five roots no `local` source may overlap (design D2). */
  protectedRoots: readonly string[];
  /** The service error channel; never given a credential. */
  onError(error: Error): void;
  mountinfoPath?: string;
  /** The PATH of every child and of the feature-off `fusermount3` lookup; default this process's. */
  path?: string;
  resolveHost?: HostResolver;
  probeExec?: ProbeExec;
  /** Builds a missing mount point; tests count the calls. */
  ensureSharedDir?: (absPath: string) => void;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export interface AttachInput {
  workspaceId: string;
  ownerId: string;
  body: MountBody;
}

export interface DetachCause {
  actorId: string;
  reason: "user" | "source_deleted" | "workspace_deleted";
}

export type MountStatus = "online" | "offline";

interface Entry {
  record: MountRecord;
  status: MountStatus;
  child: MountChild;
  /** The judged IP literal of this attempt (`sftp` / `smb`); group 6's connect check dials it. */
  address: string | undefined;
  /** Set before an unmount signals rclone: that exit is not a crash. */
  detaching: boolean;
}

/** One mount attempt's fixed inputs. */
interface Attempt {
  id: string;
  /** `<mounts>/<id>`: the private directory, also rclone's `HOME`. */
  dir: string;
  section: string;
  root: string;
  mountPoint: string;
  remote: string;
  address: string | undefined;
  body: MountBody;
}

/** The attempt failed on its own terms (not ready, mount point refused): no report. */
class AttemptFailed extends Error {}

export function createMountManager(options: MountManagerOptions) {
  const { store, mountsDir } = options;
  const path = options.path ?? process.env.PATH ?? "";
  const mountinfoPath = options.mountinfoPath ?? SYSTEM_MOUNTINFO;
  const probeExec = options.probeExec ?? probeInChild;
  const buildMountPoint = options.ensureSharedDir ?? ensureSharedDir;
  const registry = new Map<string, Entry>();
  const lookupLimit = limitConcurrency(HOST_LOOKUPS_IN_FLIGHT);
  const resolveHost = options.resolveHost ?? systemResolver;
  const limitedResolve: HostResolver = (host) => lookupLimit(() => resolveHost(host));

  const report = (error: unknown): void => {
    try {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A failing error channel changes nothing.
    }
  };

  /** `-uz` on the mount point (when mounted) and on every mount of the section (design D9). */
  const lazyUnmount = async (mountPoint: string | undefined, section: string): Promise<void> => {
    const targets = unmountTargets(await readMountinfo(mountinfoPath), mountPoint, section);
    if (targets.length === 0) {
      return;
    }
    const fusermount = options.fusermountBin ?? findExecutable(path, "fusermount3");
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

  const removeMountPoint = async (mountPoint: string): Promise<void> => {
    try {
      await rmdir(mountPoint);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        report(new Error(KEPT_MOUNT_POINT, { cause: error }));
      } else if (code !== "ENOENT") {
        report(error);
      }
    }
  };

  const removePrivateDir = (dir: string): Promise<void> =>
    rm(dir, { recursive: true, force: true }).catch(report);

  /** A failed attempt: stop rclone, unmount wherever it landed, remove what this attempt built. */
  const discard = async (
    child: MountChild | undefined,
    mountPoint: string | undefined,
    section: string,
    dir: string,
  ): Promise<void> => {
    if (child !== undefined) {
      await killChild(child);
    }
    try {
      await lazyUnmount(mountPoint, section);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        report(error);
      }
    }
    if (mountPoint !== undefined) {
      await removeMountPoint(mountPoint);
    }
    await removePrivateDir(dir);
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

  /** The remote argument and, for `sftp` / `smb`, the judged address; refusals throw. */
  const target = async (body: MountBody): Promise<{ remote: string; address?: string }> => {
    if (body.backend === "local") {
      const source = store.getSource(body.sourceId);
      if (source === undefined) {
        throw new HttpError("not_found");
      }
      if ((await acceptableSourcePath(source.path, options.protectedRoots)) !== source.path) {
        throw new HttpError("mount_failed");
      }
      return { remote: source.path };
    }
    const verdict = await judgeHost(body.host, options.mountHostAllow, limitedResolve);
    if (verdict.verdict === "rejected") {
      throw new HttpError("mount_host_rejected");
    }
    if (verdict.verdict === "unresolved") {
      throw new HttpError("mount_failed");
    }
    const remote = body.backend === "smb" ? body.remotePath.slice(1) : body.remotePath;
    return { remote, address: verdict.address };
  };

  /**
   * One mount attempt in the attempt's existing private directory: credential file, `cache/`,
   * `rclone.log`, the mount point check, the spawn and the readiness wait. Any failure discards what the
   * attempt built and is `mount_failed`; only unexpected errors are reported.
   */
  const mountOnce = async (rcloneBin: string, attempt: Attempt): Promise<MountChild> => {
    const { dir, section, mountPoint, body } = attempt;
    let child: MountChild | undefined;
    let built: string | undefined;
    try {
      await writeRcloneConf({ rcloneBin, dir, mountId: attempt.id }, body, attempt.address);
      ensureOwnedDir(join(dir, "cache"), PRIVATE_DIR_MODE);
      ensureOwnedFile(join(dir, "rclone.log"), LOG_MODE);
      if (!(await mountPointUsable(mountPoint))) {
        throw new AttemptFailed();
      }
      built = mountPoint;
      const share =
        options.ompUid === undefined
          ? undefined
          : { uid: options.ompUid, gid: (await stat(attempt.root)).gid };
      const argv = mountArgv({ ...attempt, readOnly: body.readOnly, share });
      child = spawnMount(rcloneBin, argv, { PATH: path, HOME: dir });
      const deadline = Date.now() + (options.readyTimeoutMs ?? READY_WINDOW_MS);
      if (!(await awaitReady({ child, mountinfoPath, mountPoint, section, deadline, probeExec }))) {
        throw new AttemptFailed();
      }
      return child;
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        report(error);
      }
      await discard(child, built, section, dir);
      throw new HttpError("mount_failed");
    }
  };

  const mountPointOf = (record: MountRecord): string | undefined => {
    try {
      const root = options.workspaceRootOf(record.ownerId, record.workspaceId);
      return root === null ? undefined : join(root, record.name);
    } catch (error) {
      report(error);
      return undefined;
    }
  };

  /**
   * Lazy unmount, then stop rclone; a refused unmount (`mount_disabled`) leaves the entry as it was.
   * Otherwise the entry is `offline` from the unmount on, so a row delete failing afterwards never
   * leaves it reported online over a stopped rclone; `detaching` stays set (no crash handling).
   */
  const unmountAndStop = async (
    mountId: string,
    mountPoint: string | undefined,
    entry: Entry | undefined,
  ): Promise<void> => {
    if (entry === undefined) {
      await lazyUnmount(mountPoint, `m${mountId}`);
      return;
    }
    const { status, detaching } = entry;
    entry.detaching = true;
    entry.status = "offline";
    try {
      await lazyUnmount(mountPoint, `m${mountId}`);
    } catch (error) {
      entry.detaching = detaching;
      entry.status = status;
      throw error;
    }
    await stopChild(entry.child, options.stopTimeoutMs ?? STOP_GRACE_MS);
  };

  /** Undefined for an unknown id. `mount_disabled` (row and directory kept) when unmounting is impossible. */
  const detach = async (mountId: string, cause: DetachCause): Promise<MountRecord | undefined> => {
    const record = store.get(mountId);
    if (record === undefined) {
      return undefined;
    }
    const mountPoint = mountPointOf(record);
    await unmountAndStop(mountId, mountPoint, registry.get(mountId));
    if (mountPoint !== undefined) {
      await removeMountPoint(mountPoint);
    }
    await removePrivateDir(join(mountsDir, mountId));
    const removed = store.remove(mountId, (row) => {
      options.audit.emit({
        kind: "mount.detach",
        actorId: cause.actorId,
        workspaceId: row.workspaceId,
        title: `卸载挂载点 ${row.name}`,
        detail: { mountId: row.id, name: row.name, reason: cause.reason },
      });
    });
    registry.delete(mountId);
    return removed;
  };

  return {
    async attach(input: AttachInput, within?: (record: MountRecord) => void): Promise<MountRecord> {
      const { rcloneBin } = options;
      if (rcloneBin === undefined) {
        throw new HttpError("mount_disabled");
      }
      const root = options.workspaceRootOf(input.ownerId, input.workspaceId);
      if (root === null) {
        throw new HttpError("not_found");
      }
      const { body } = input;
      const { remote, address } = await target(body);
      const id = store.newId();
      const attempt: Attempt = {
        id,
        dir: join(mountsDir, id),
        section: `m${id}`,
        root,
        mountPoint: join(root, body.name),
        remote,
        address,
        body,
      };
      try {
        ensureOwnedDir(attempt.dir, PRIVATE_DIR_MODE);
      } catch (error) {
        // Not this attempt's directory (a symlink or someone else's): nothing here is removed.
        report(error);
        throw new HttpError("mount_failed");
      }
      const child = await mountOnce(rcloneBin, attempt);
      let record: MountRecord;
      try {
        record = store.create({ id, ...input }, within);
      } catch (error) {
        await discard(child, attempt.mountPoint, attempt.section, attempt.dir);
        throw error;
      }
      const entry: Entry = { record, status: "online", child, address, detaching: false };
      registry.set(id, entry);
      void child.exited.then(() => {
        if (registry.get(id) === entry && !entry.detaching) {
          entry.status = "offline";
        }
      });
      return record;
    },

    /** Design D15: every mount of the workspace, before any path deletes its row (`RESTRICT`). */
    async detachWorkspace(workspaceId: string, actorId: string): Promise<void> {
      for (const mount of store.list(workspaceId)) {
        await detach(mount.id, { actorId, reason: "workspace_deleted" });
      }
    },

    detach,

    statusOf(mountId: string): MountStatus {
      return registry.get(mountId)?.status ?? "offline";
    },

    namesOf(workspaceId: string): ReadonlySet<string> {
      const names = new Set<string>();
      for (const { record } of registry.values()) {
        if (record.workspaceId === workspaceId) {
          names.add(record.name);
        }
      }
      return names;
    },
  };
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
