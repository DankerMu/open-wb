/**
 * workspaces/mounts/manager — the mount-manager (s1b-workspace-mounts design D3 manager side, D5, D7–D13
 * manager parts, D15; workspace-mounts「挂载凭证文件」「挂载进程与挂载点」「挂载取值与主机规则」「在线状态与
 * 重挂」「服务启停与挂载」「挂载操作的串行与取消」「临时空间与删除前卸载」).
 *
 * Construction loads every row into the registry, all `offline` (also with the feature off: listing,
 * unmounting and the mount-name skips need it). `restoreAll` mounts them one by one by `created_at, id`;
 * `closeAll` stops everything this run mounted and keeps rows and private directories for the next.
 *
 * Every operation on a mount — attach, remount attempt, startup restore attempt, detach, the
 * workspace / mount-source cascades — runs on its workspace's promise chain. Detach and `closeAll` first,
 * synchronously, cancel the mount's pending timer and in-flight probe and abort its in-flight attempt:
 * the attempt's rclone is SIGKILLed, its result voided (never `online`, never a row) and, if its mount
 * had appeared, lazily unmounted (D9) — so neither waits out the 20 s readiness window.
 *
 * An online mount is probed every 30 s (`probe.ts`, at most one probe in flight); rclone exiting or a
 * failed probe makes it `offline` at once: lazy unmount and rclone killed right away (off the chain:
 * the unmount is what frees calls stuck in the mount), remount 5 s later, the delay doubling per failure
 * up to 300 s and back to 5 s on success. Each remount and restore judges the host rule and the mount
 * point again and rewrites `rclone.conf`'s `host` before the spawn (D3, D6, D8). While a detach is
 * queued or running, crash handling, probes and remounts stand down; a detach refused before its
 * unmount hands the mount back to supervision, one that got past it retires the mount.
 *
 * One attempt's mechanics (target judgement, credential file, mount point check, spawn, readiness,
 * discarding) are in `attempt.ts`; the probe and the clock in `probe.ts`.
 */
import { join } from "node:path";
import type { emit } from "../../core/audit/index.js";
import { HttpError } from "../../core/errors/index.js";
import { ensureOwnedDir, ensureSharedDir } from "../../core/sandbox/dirs.js";
import {
  type Attempt,
  AttemptFailed,
  createAttempts,
  PRIVATE_DIR_MODE,
  type Remote,
  untilAborted,
} from "./attempt.js";
import type { MountSettings } from "./config.js";
import { type HostResolver, systemResolver } from "./host-policy.js";
import { SYSTEM_MOUNTINFO } from "./mountinfo.js";
import {
  DEFAULT_PORTS,
  type MountClock,
  PROBE_TIMEOUT_MS,
  probeOnce,
  systemClock,
  type TcpConnect,
  tcpConnect,
} from "./probe.js";
import { rewriteHost, writeRcloneConf } from "./rclone-conf.js";
import {
  killChild,
  type MountChild,
  type ProbeExec,
  probeInChild,
  stopChild,
} from "./rclone-process.js";
import type { createMountStore, MountRecord } from "./store.js";
import type { MountBody } from "./validate.js";

type MountStore = ReturnType<typeof createMountStore>;

const STOP_GRACE_MS = 5_000;
const PROBE_INTERVAL_MS = 30_000;
const FIRST_REMOUNT_MS = 5_000;
const MAX_REMOUNT_MS = 300_000;

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
  /** The readiness `readdir` and health `stat` children (design D9, D11). */
  probeExec?: ProbeExec;
  /** The health probe's TCP check (design D11); default `node:net`. */
  connect?: TcpConnect;
  /** Probe rounds, probe deadlines and remount backoff; default real (unref'd) timers. */
  clock?: MountClock;
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
  /** The rclone of the current mount; set while online and until an offline transition stops it. */
  child: MountChild | undefined;
  /** Where the current mount is. */
  mountPoint: string | undefined;
  /** The judged IP literal of the current mount (`sftp` / `smb`): the probe dials it. */
  address: string | undefined;
  /** Detaches queued or running: crash handling, probes and remounts stand down meanwhile. */
  detaching: number;
  /** A detach got past its unmount: only another detach touches this mount again. */
  retired: boolean;
  /** The delay of the next remount. */
  backoffMs: number;
  /** The pending probe round (online) or remount (offline). */
  timer: unknown;
  probe: AbortController | undefined;
  /** The in-flight remount or restore attempt. */
  attempt: AbortController | undefined;
}

export function createMountManager(options: MountManagerOptions) {
  const { store, mountsDir } = options;
  const path = options.path ?? process.env.PATH ?? "";
  const connect = options.connect ?? tcpConnect;
  const clock = options.clock ?? systemClock;
  const stopGraceMs = options.stopTimeoutMs ?? STOP_GRACE_MS;
  const mountinfoPath = options.mountinfoPath ?? SYSTEM_MOUNTINFO;
  const probeExec = options.probeExec ?? probeInChild;
  const registry = new Map<string, Entry>();
  const chains = new Map<string, Promise<void>>();
  const attaching = new Set<AbortController>();
  let shutdown = false;
  let restoring = false;
  let closing: Promise<void> | undefined;

  for (const record of store.listAll()) {
    registry.set(record.id, newEntry(record));
  }

  const report = (error: unknown): void => {
    try {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A failing error channel changes nothing.
    }
  };
  const attempts = createAttempts({
    ...options,
    mountinfoPath,
    path,
    resolveHost: options.resolveHost ?? systemResolver,
    probeExec,
    buildMountPoint: options.ensureSharedDir ?? ensureSharedDir,
    report,
  });
  const { lazyUnmount, removeMountPoint, removePrivateDir, discard, target, mountOnce } = attempts;
  const { attemptOf, reportUnlessRefused } = attempts;

  /** Runs `task` after everything queued for the workspace; a failure does not block the next. */
  const onChain = <T>(workspaceId: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(workspaceId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(workspaceId, tail);
    void tail.then(() => {
      if (chains.get(workspaceId) === tail) {
        chains.delete(workspaceId);
      }
    });
    return run;
  };
  const inBackground = (entry: Entry, task: () => Promise<void>): void => {
    void onChain(entry.record.workspaceId, task).catch(report);
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

  // ---- supervision: online / offline, probes, remount backoff ----

  /** The manager still runs this mount: feature on, not shut down, registered, no detach in the way. */
  const supervised = (entry: Entry): boolean =>
    options.rcloneBin !== undefined &&
    !shutdown &&
    registry.get(entry.record.id) === entry &&
    entry.detaching === 0 &&
    !entry.retired;

  /** Synchronous: the pending timer, the in-flight probe and the in-flight attempt. */
  const cancel = (entry: Entry): void => {
    if (entry.timer !== undefined) {
      clock.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const { probe } = entry;
    entry.probe = undefined;
    probe?.abort();
    entry.attempt?.abort();
  };

  const scheduleRemount = (entry: Entry): void => {
    if (!supervised(entry)) {
      return;
    }
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(delay * 2, MAX_REMOUNT_MS);
    entry.timer = clock.setTimeout(() => {
      entry.timer = undefined;
      inBackground(entry, () => remount(entry));
    }, delay);
  };

  const armProbe = (entry: Entry): void => {
    if (!supervised(entry)) {
      return;
    }
    entry.timer = clock.setTimeout(() => {
      entry.timer = undefined;
      void runProbe(entry);
    }, PROBE_INTERVAL_MS);
  };

  const runProbe = async (entry: Entry): Promise<void> => {
    const { child, mountPoint, address } = entry;
    if (!supervised(entry) || entry.status !== "online" || !child || !mountPoint) {
      return;
    }
    const controller = new AbortController();
    entry.probe = controller;
    const deadline = clock.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const { backend, port } = entry.record;
    const dial =
      backend === "local" || address === undefined
        ? undefined
        : { address, port: port ?? DEFAULT_PORTS[backend] };
    let ok = false;
    try {
      ok = await probeOnce(
        { child, mountinfoPath, mountPoint, dial, probeExec, connect },
        controller,
      );
    } catch (error) {
      report(error);
    } finally {
      clock.clearTimeout(deadline);
    }
    if (entry.probe !== controller) {
      return; // cancelled: the result is void
    }
    entry.probe = undefined;
    if (ok) {
      armProbe(entry);
    } else {
      goOffline(entry);
    }
  };

  /**
   * Crash or failed probe: `offline` now, then at once (not behind the chain — the lazy unmount is what
   * frees calls stuck in the mount) unmount and stop rclone; the remount it schedules runs on the chain.
   */
  const goOffline = (entry: Entry): void => {
    if (!supervised(entry) || entry.status !== "online") {
      return;
    }
    entry.status = "offline";
    cancel(entry);
    void settleOffline(entry).catch(report);
  };

  const settleOffline = async (entry: Entry): Promise<void> => {
    if (!supervised(entry)) {
      return; // a detach is in the way; it stops rclone itself
    }
    await lazyUnmount(entry.mountPoint, `m${entry.record.id}`).catch(reportUnlessRefused);
    const { child } = entry;
    entry.child = undefined;
    if (child !== undefined) {
      await killChild(child);
    }
    scheduleRemount(entry);
  };

  const goOnline = (entry: Entry, child: MountChild, attempt: Attempt): void => {
    entry.status = "online";
    entry.child = child;
    entry.mountPoint = attempt.mountPoint;
    entry.address = attempt.address;
    entry.backoffMs = FIRST_REMOUNT_MS;
    void child.exited.then(() => {
      if (entry.child === child) {
        goOffline(entry);
      }
    });
    armProbe(entry);
  };

  /** After a detach: back under supervision unless retired, removed or another detach is queued. */
  const resume = (entry: Entry): void => {
    if (!supervised(entry)) {
      return;
    }
    if (entry.status === "online" && entry.child !== undefined && !entry.child.hasExited()) {
      armProbe(entry);
      return;
    }
    entry.status = "offline";
    void settleOffline(entry).catch(report);
  };

  /** One remount (or startup restore) attempt; on the chain. Failure keeps it offline with backoff. */
  const remount = async (entry: Entry): Promise<void> => {
    const { rcloneBin } = options;
    if (rcloneBin === undefined || !supervised(entry) || entry.status === "online") {
      return;
    }
    const controller = new AbortController();
    entry.attempt = controller;
    try {
      const [child, attempt] = await remountOnce(rcloneBin, entry.record, controller.signal);
      if (controller.signal.aborted) {
        await discard(child, attempt.mountPoint, attempt.section, undefined);
        return;
      }
      goOnline(entry, child, attempt);
    } catch (error) {
      if (!(error instanceof AttemptFailed)) {
        report(error);
      }
      scheduleRemount(entry);
    } finally {
      entry.attempt = undefined;
    }
  };

  const remountOnce = async (
    rcloneBin: string,
    record: MountRecord,
    signal: AbortSignal,
  ): Promise<[MountChild, Attempt]> => {
    const root = options.workspaceRootOf(record.ownerId, record.workspaceId);
    if (root === null) {
      throw new AttemptFailed();
    }
    const section = `m${record.id}`;
    try {
      // A mount an earlier run left behind (killed before it could unmount): out of the way first.
      await lazyUnmount(join(root, record.name), section);
      const found = await untilAborted(target(record), signal);
      const attempt = attemptOf(record.id, root, record.name, record.readOnly, found, signal);
      ensureOwnedDir(attempt.dir, PRIVATE_DIR_MODE);
      const { address } = found;
      const writeConf = async () => {
        if (address !== undefined) {
          await rewriteHost(attempt.dir, address);
        }
      };
      return [await mountOnce(rcloneBin, attempt, writeConf, false), attempt];
    } catch (error) {
      throw error instanceof HttpError ? new AttemptFailed() : error;
    }
  };

  // ---- attach and detach ----

  const attachNow = async (
    rcloneBin: string,
    root: string,
    input: AttachInput,
    within: ((record: MountRecord) => void) | undefined,
    signal: AbortSignal,
  ): Promise<MountRecord> => {
    const { body } = input;
    const remote: Remote =
      body.backend === "local"
        ? { backend: "local", host: null, remotePath: null, sourceId: body.sourceId }
        : { backend: body.backend, host: body.host, remotePath: body.remotePath, sourceId: null };
    const found = await untilAborted(target(remote), signal).catch((error: unknown) => {
      throw error instanceof AttemptFailed ? new HttpError("mount_failed") : error;
    });
    const id = store.newId();
    const attempt = attemptOf(id, root, body.name, body.readOnly, found, signal);
    try {
      ensureOwnedDir(attempt.dir, PRIVATE_DIR_MODE);
    } catch (error) {
      // Not this attempt's directory (a symlink or someone else's): nothing here is removed.
      report(error);
      throw new HttpError("mount_failed");
    }
    const writeConf = () =>
      writeRcloneConf({ rcloneBin, dir: attempt.dir, mountId: id }, body, found.address);
    const child = await mountOnce(rcloneBin, attempt, writeConf, true).catch(() => {
      throw new HttpError("mount_failed");
    });
    let record: MountRecord;
    try {
      if (signal.aborted) {
        throw new HttpError("mount_failed");
      }
      record = store.create({ id, ...input }, within);
    } catch (error) {
      await discard(child, attempt.mountPoint, attempt.section, attempt.dir);
      throw error;
    }
    const entry = newEntry(record);
    registry.set(id, entry);
    goOnline(entry, child, attempt);
    return record;
  };

  /**
   * Lazy unmount, then stop rclone; a refused unmount (`mount_disabled`) leaves the entry as it was.
   * Otherwise the entry is `offline` and retired from the unmount on, so a row delete failing afterwards
   * never leaves it reported online over a stopped rclone, nor remounted from a removed directory.
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
    const { status } = entry;
    entry.status = "offline";
    try {
      await lazyUnmount(mountPoint, `m${mountId}`);
    } catch (error) {
      entry.status = status;
      throw error;
    }
    entry.retired = true;
    const { child } = entry;
    entry.child = undefined;
    if (child !== undefined) {
      await stopChild(child, stopGraceMs);
    }
  };

  const detachNow = async (
    mountId: string,
    cause: DetachCause,
  ): Promise<MountRecord | undefined> => {
    const record = store.get(mountId);
    if (record === undefined) {
      return undefined;
    }
    const mountPoint = mountPointOf(record);
    await unmountAndStop(mountId, mountPoint, registry.get(mountId));
    if (mountPoint !== undefined) {
      await removeMountPoint(mountPoint, true);
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

  /** Undefined for an unknown id. `mount_disabled` (row and directory kept) when unmounting is impossible. */
  const detach = async (mountId: string, cause: DetachCause): Promise<MountRecord | undefined> => {
    const entry = registry.get(mountId);
    const workspaceId = entry?.record.workspaceId ?? store.get(mountId)?.workspaceId;
    if (workspaceId === undefined) {
      return undefined;
    }
    if (entry !== undefined) {
      entry.detaching += 1;
      cancel(entry);
    }
    try {
      return await onChain(workspaceId, () => detachNow(mountId, cause));
    } finally {
      if (entry !== undefined) {
        entry.detaching -= 1;
        resume(entry);
      }
    }
  };

  /** Every detach starts (and cancels) at once; each runs on its chain; the first failure is rethrown. */
  const detachAll = async (records: readonly MountRecord[], cause: DetachCause): Promise<void> => {
    const results = await Promise.allSettled(records.map((record) => detach(record.id, cause)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined) {
      throw failed.reason;
    }
  };

  // ---- service start and stop ----

  const stopOnShutdown = async (entry: Entry): Promise<void> => {
    entry.status = "offline";
    const mountPoint = entry.mountPoint ?? mountPointOf(entry.record);
    await lazyUnmount(mountPoint, `m${entry.record.id}`).catch(reportUnlessRefused);
    const { child } = entry;
    entry.child = undefined;
    if (child !== undefined) {
      await stopChild(child, stopGraceMs);
    }
  };

  const shutDown = async (): Promise<void> => {
    shutdown = true;
    for (const entry of registry.values()) {
      cancel(entry);
    }
    for (const controller of attaching) {
      controller.abort();
    }
    while (chains.size > 0) {
      await Promise.all(chains.values());
    }
    if (options.rcloneBin !== undefined) {
      await Promise.all([...registry.values()].map(stopOnShutdown));
    }
  };

  return {
    async attach(input: AttachInput, within?: (record: MountRecord) => void): Promise<MountRecord> {
      const { rcloneBin } = options;
      if (rcloneBin === undefined || shutdown) {
        throw new HttpError("mount_disabled");
      }
      const root = options.workspaceRootOf(input.ownerId, input.workspaceId);
      if (root === null) {
        throw new HttpError("not_found");
      }
      return onChain(input.workspaceId, async () => {
        if (shutdown) {
          throw new HttpError("mount_disabled");
        }
        const controller = new AbortController();
        attaching.add(controller);
        try {
          return await attachNow(rcloneBin, root, input, within, controller.signal);
        } finally {
          attaching.delete(controller);
        }
      });
    },

    detach,

    /** Design D15: every mount of the workspace, before any path deletes its row (`RESTRICT`). */
    detachWorkspace(workspaceId: string, actorId: string): Promise<void> {
      return detachAll(store.list(workspaceId), { actorId, reason: "workspace_deleted" });
    },

    /** Design D14 step (2): every mount of the source, each on its workspace's chain. */
    detachSource(sourceId: string, actorId: string): Promise<void> {
      return detachAll(store.listBySource(sourceId), { actorId, reason: "source_deleted" });
    },

    /**
     * Design D12 start: each registered mount in turn by `created_at, id`, each attempt on its chain and
     * finished before the next; failures only leave that mount offline with backoff. Never rejects.
     * Nothing with the feature off, on a second call, or after `closeAll`.
     */
    async restoreAll(): Promise<void> {
      if (options.rcloneBin === undefined || restoring) {
        return;
      }
      restoring = true;
      const order = [...registry.values()].sort(
        (a, b) =>
          a.record.createdAt - b.record.createdAt ||
          (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
      );
      for (const entry of order) {
        if (shutdown) {
          return;
        }
        await onChain(entry.record.workspaceId, () => remount(entry)).catch(report);
      }
    },

    /**
     * Design D12 stop: shutdown flag, timers and probes cancelled, in-flight attempts SIGKILLed and
     * voided, the chains drained, then each mount lazily unmounted and its rclone stopped (SIGTERM, then
     * SIGKILL). Rows and private directories stay. Idempotent.
     */
    closeAll(): Promise<void> {
      closing ??= shutDown();
      return closing;
    },

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

function newEntry(record: MountRecord): Entry {
  return {
    record,
    status: "offline",
    child: undefined,
    mountPoint: undefined,
    address: undefined,
    detaching: 0,
    retired: false,
    backoffMs: FIRST_REMOUNT_MS,
    timer: undefined,
    probe: undefined,
    attempt: undefined,
  };
}
