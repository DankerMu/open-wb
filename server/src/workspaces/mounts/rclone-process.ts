/**
 * workspaces/mounts/rclone-process — the child processes of the mount-manager (s1b-workspace-mounts design
 * D7, D9, D10, D11; workspace-mounts「挂载进程与挂载点」): the `rclone mount` argv, its spawn with an
 * environment of exactly `{PATH, HOME}` and no stdio, the readiness wait, stopping it, the subprocess
 * `readdir` (readiness) and `stat` (health) probes and one `fusermount3 -uz`. An abort signal ends a
 * readiness wait and SIGKILLs a probe child at once (unmount and shutdown cancel in-flight attempts). Nothing here touches the database, the registry or a credential: the conf
 * file is only ever named by path (`--config`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readMountinfo, sectionMounts } from "./mountinfo.js";

const POLL_MS = 100;
/** One sync call on the mount point in a child: a FUSE wait blocks that child, never this event loop. */
const PROBE_SCRIPTS = {
  readdir: "require('node:fs').readdirSync(process.argv[1])",
  stat: "require('node:fs').statSync(process.argv[1])",
} as const;

/**
 * Runs one probe of `path` in a child process, killed with SIGKILL after `timeoutMs` or when `signal`
 * aborts (a blocked FUSE call is interruptible by SIGKILL, #1665 P4′); resolves whether it succeeded.
 */
export type ProbeExec = (
  op: keyof typeof PROBE_SCRIPTS,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<boolean>;

export interface MountChild {
  readonly pid: number | undefined;
  /** Settles once the child has exited, or failed to start. */
  readonly exited: Promise<void>;
  hasExited(): boolean;
  signal(signal: NodeJS.Signals): void;
}

export interface MountArgs {
  section: string;
  remote: string;
  mountPoint: string;
  dir: string;
  readOnly: boolean;
  /** `OMP_USER` mode only: the omp uid and the workspace root's group. */
  share?: { uid: number; gid: number } | undefined;
}

/**
 * `mount <section>:<remote> <mount point> --config … --cache-dir … --log-file … --log-level NOTICE
 * --allow-non-empty`, then `--vfs-cache-mode writes --vfs-write-back 0s` or `--read-only`, then the five
 * sharing flags in `OMP_USER` mode. No backend override flag: the host is in `rclone.conf` (D3 step 5).
 */
export function mountArgv(args: MountArgs): string[] {
  const argv = [
    "mount",
    `${args.section}:${args.remote}`,
    args.mountPoint,
    "--config",
    join(args.dir, "rclone.conf"),
    "--cache-dir",
    join(args.dir, "cache"),
    "--log-file",
    join(args.dir, "rclone.log"),
    "--log-level",
    "NOTICE",
    "--allow-non-empty",
    ...(args.readOnly ? ["--read-only"] : ["--vfs-cache-mode", "writes", "--vfs-write-back", "0s"]),
  ];
  if (args.share !== undefined) {
    argv.push("--allow-other", "--default-permissions", "--uid", String(args.share.uid));
    argv.push("--gid", String(args.share.gid), "--umask", "007");
  }
  return argv;
}

export function spawnMount(
  rcloneBin: string,
  argv: readonly string[],
  env: { PATH: string; HOME: string },
): MountChild {
  const child = spawn(rcloneBin, argv, { env, stdio: "ignore" });
  return track(child);
}

function track(child: ChildProcess): MountChild {
  let done = false;
  const exited = new Promise<void>((settle) => {
    const finish = () => {
      done = true;
      settle();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  return {
    pid: child.pid,
    exited,
    hasExited: () => done,
    signal: (signal) => {
      if (!done) {
        child.kill(signal);
      }
    },
  };
}

export interface ReadyWait {
  child: MountChild;
  mountinfoPath: string;
  mountPoint: string;
  section: string;
  /** `Date.now()` value at which the readiness window ends. */
  deadline: number;
  probeExec: ProbeExec;
  /** Aborted: the wait fails at once (the caller has SIGKILLed the child). */
  signal: AbortSignal;
}

/**
 * Every 100 ms until the deadline: a line of this section at another mount point fails at once (#1665
 * P15); the mount point appearing hands the rest of the window to one `readdir` probe, whose success is
 * readiness (#1665 P11); the child exiting first, the window running out, or the signal, fails.
 */
export async function awaitReady(wait: ReadyWait): Promise<boolean> {
  for (;;) {
    if (wait.child.hasExited() || wait.signal.aborted) {
      return false;
    }
    const entries = readMountinfo(wait.mountinfoPath);
    if (
      sectionMounts(entries, wait.section).some((entry) => entry.mountPoint !== wait.mountPoint)
    ) {
      return false;
    }
    const remaining = wait.deadline - Date.now();
    if (entries.some((entry) => entry.mountPoint === wait.mountPoint)) {
      return (
        remaining > 0 &&
        (await wait.probeExec("readdir", wait.mountPoint, remaining, wait.signal)) &&
        !wait.signal.aborted
      );
    }
    if (remaining <= 0) {
      return false;
    }
    await Promise.race([delay(Math.min(POLL_MS, remaining)), wait.child.exited]);
  }
}

export async function killChild(child: MountChild): Promise<void> {
  child.signal("SIGKILL");
  await child.exited;
}

/** SIGTERM; SIGKILL if it has not exited within `graceMs` (D10). */
export async function stopChild(child: MountChild, graceMs: number): Promise<void> {
  child.signal("SIGTERM");
  const controller = new AbortController();
  const timedOut = await Promise.race([
    child.exited.then(() => false),
    delay(graceMs, true, { signal: controller.signal }),
  ]);
  controller.abort();
  if (timedOut) {
    await killChild(child);
  }
}

export const probeInChild: ProbeExec = (op, path, timeoutMs, signal) =>
  new Promise((settle) => {
    if (signal?.aborted) {
      settle(false);
      return;
    }
    const child = spawn(process.execPath, ["-e", PROBE_SCRIPTS[op], path], {
      env: {},
      stdio: "ignore",
    });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      settle(ok);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });

/** `<fusermount3> -uz <target>`; resolves whether it exited 0. */
export function lazyUnmountOne(
  fusermountBin: string,
  target: string,
  path: string,
): Promise<boolean> {
  return new Promise((settle) => {
    const child = spawn(fusermountBin, ["-uz", target], { env: { PATH: path }, stdio: "ignore" });
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}
