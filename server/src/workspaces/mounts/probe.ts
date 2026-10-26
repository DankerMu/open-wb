/**
 * workspaces/mounts/probe — the health probe of one online mount (s1b-workspace-mounts design D11;
 * workspace-mounts「在线状态与重挂」): the rclone child alive ∧ the D9 "mounted" criterion ∧ a `stat` of
 * the mount point in a child process ∧, for `sftp` / `smb`, a TCP connect to the address this mount
 * attempt judged (port as given, else 22 / 445). The `stat` and the connect share one abort: the
 * caller's 5 s deadline, its cancellation, or the first check that fails. Nothing here touches the
 * mount from this event loop (#1665 P4′: a cached root answers `stat` even with the remote gone, so the
 * connect is the reachability check; it only dials, never reads).
 *
 * The clock (timers of the probe rounds, deadlines and remount backoff) and the connect are the
 * manager's injectable boundaries.
 */
import { connect as netConnect } from "node:net";
import { readMountinfo } from "./mountinfo.js";
import type { MountChild, ProbeExec } from "./rclone-process.js";

/** Each check of one probe has this long (design D11). */
export const PROBE_TIMEOUT_MS = 5000;

export interface MountClock {
  setTimeout(fire: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Real timers, unref'd: a pending remount or probe round never keeps the process alive by itself. */
export const systemClock: MountClock = {
  setTimeout: (fire, ms) => setTimeout(fire, ms).unref(),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

/** Resolves whether a TCP connection to `host:port` was established (and closed at once) before `signal`. */
export type TcpConnect = (host: string, port: number, signal: AbortSignal) => Promise<boolean>;

export const tcpConnect: TcpConnect = (host, port, signal) =>
  new Promise((settle) => {
    if (signal.aborted) {
      settle(false);
      return;
    }
    const socket = netConnect({ host, port });
    const finish = (ok: boolean) => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      settle(ok);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

export const DEFAULT_PORTS = { sftp: 22, smb: 445 } as const;

export interface ProbeTarget {
  child: MountChild;
  mountinfoPath: string;
  mountPoint: string;
  /** `sftp` / `smb`: the judged IP literal and the port to dial; absent for `local` (no connect). */
  dial?: { address: string; port: number } | undefined;
  probeExec: ProbeExec;
  connect: TcpConnect;
}

/** One probe; `controller` is aborted by the caller's deadline or cancellation, and by a failed check. */
export async function probeOnce(
  target: ProbeTarget,
  controller: AbortController,
): Promise<boolean> {
  if (target.child.hasExited()) {
    return false;
  }
  const entries = readMountinfo(target.mountinfoPath);
  if (
    !entries.some((entry) => entry.mountPoint === target.mountPoint) ||
    controller.signal.aborted
  ) {
    return false;
  }
  const { signal } = controller;
  const check = (running: Promise<boolean>) =>
    running.then(
      (ok) => {
        if (!ok) {
          controller.abort();
        }
        return ok;
      },
      () => {
        controller.abort();
        return false;
      },
    );
  const checks = [check(target.probeExec("stat", target.mountPoint, PROBE_TIMEOUT_MS, signal))];
  if (target.dial !== undefined) {
    checks.push(check(target.connect(target.dial.address, target.dial.port, signal)));
  }
  return (await Promise.all(checks)).every(Boolean);
}
