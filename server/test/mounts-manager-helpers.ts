/**
 * The world of `mounts-manager*.test.ts` (s1b-workspace-mounts tasks 5.2): a real manager wired to the
 * real-spawned fake rclone (`fixtures/fake-rclone.mjs`) and fake `fusermount3`
 * (`fixtures/fake-fusermount3.mjs`), a fake mountinfo at `<state>/fake-mountinfo`, a `:memory:` database
 * through the real migrations, and real audit rows. The manager's PATH is a bin directory of this world
 * only: a `node` link (the fakes' shebang) and, unless left out, the fake `fusermount3` — never the host's
 * own FUSE tools. Every recorded fake rclone pid still alive at the end is SIGKILLed.
 *
 * Group 6 (#1687): every world's manager runs on a fake clock (`world.clock`, advanced only by the test)
 * and an answering fake TCP connect that records its calls; the world has three workspaces of zhangsan
 * (`OWNER`) and one each of lisi and wangwu (#1810), each root found only for its own owner; every
 * manager built through the world is `closeAll`ed before its database closes.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import { createMountManager, type MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import type { MountClock, TcpConnect } from "../src/workspaces/mounts/probe.js";
import { createMountStore } from "../src/workspaces/mounts/store.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";

export const FAKE_RCLONE = fileURLToPath(new URL("./fixtures/fake-rclone.mjs", import.meta.url));
const FAKE_FUSERMOUNT = fileURLToPath(new URL("./fixtures/fake-fusermount3.mjs", import.meta.url));

export const W1 = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
export const W2 = "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
export const W3 = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a";
/** lisi's and wangwu's one formal workspace each (#1810: lookups are limited per account). */
export const W_LISI = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
export const W_WANGWU = "6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a";
export const OWNER = "u1";
export const LISI = "u3";
export const WANGWU = "u4";
export const ID1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const ID2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export const ID3 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
export const SOURCE_ID = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

export const USER_SENTINEL = "user-sentinel-1686";
export const PASS_SENTINEL = "pass-sentinel-1686";
export const KEY_SENTINEL = "key-sentinel-1686";
export const PARENT_ENV_SENTINEL = "parent-env-sentinel-1686";
const PRIVATE_KEY = `-----BEGIN TEST FIXTURE-----\n${KEY_SENTINEL}-a\n${KEY_SENTINEL}-b\n-----END TEST FIXTURE-----\n`;

/** The fake's documented obscure output, computed independently of it. */
export function obscured(password: string): string {
  return Buffer.from(`obscured:${password}`).toString("base64url");
}

/** Test resolver: `files.intra` and friends to fixed addresses; anything unlisted fails to resolve. */
const ADDRESSES: Readonly<Record<string, readonly string[]>> = {
  "files.intra": ["10.0.0.7", "10.0.0.9"],
  "other.intra": ["10.0.0.8"],
  "loop.intra": ["10.0.0.5", "127.0.0.1"],
  "2130706433": ["127.0.0.1"],
};

const testResolver: HostResolver = async (host) => {
  const found = ADDRESSES[host];
  if (found === undefined) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  }
  return found.map((address) => ({ address }));
};

export function sftp(remotePath = "/srv/data", extra: Partial<MountBody> = {}): MountBody {
  return {
    name: "remote",
    backend: "sftp",
    host: "files.intra",
    remotePath,
    readOnly: false,
    username: USER_SENTINEL,
    password: PASS_SENTINEL,
    ...extra,
  } as MountBody;
}

export function sftpKey(): MountBody {
  return {
    name: "keyed",
    backend: "sftp",
    host: "files.intra",
    remotePath: "/srv/keyed",
    readOnly: true,
    username: USER_SENTINEL,
    privateKey: PRIVATE_KEY,
  };
}

export function smb(remotePath = "/share/product", readOnly = true): MountBody {
  return {
    name: "共享盘",
    backend: "smb",
    host: "files.intra",
    remotePath,
    readOnly,
    username: USER_SENTINEL,
    password: PASS_SENTINEL,
  };
}

export function local(name = "本机", readOnly = false): MountBody {
  return { name, backend: "local", sourceId: SOURCE_ID, readOnly };
}

/** macOS injects `__CF_USER_TEXT_ENCODING` into every new process; it is not passed by the caller. */
export function childEnv({
  env: { __CF_USER_TEXT_ENCODING: _injected, ...env },
}: Call): Record<string, string> {
  return env;
}

export interface Call {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  pid: number;
  /** `Date.now()` when the fake started acting. */
  at: number;
  logMode?: number | null;
  /** `mount` only: the `host` value in `--config` at spawn time. */
  confHost?: string | null;
  /** `mount` only: whether the fake mountinfo already had a line at this mount point at spawn time. */
  preMounted?: boolean;
}

/**
 * The injected clock: timers fire only from `advance` / `fireNext`, in due order. `pending()` is each
 * pending timer's delay from now, ascending.
 */
interface FakeClock extends MountClock {
  now(): number;
  pending(): number[];
  advance(ms: number): void;
  /** Advances to the earliest pending timer and fires it; returns how far the clock moved. */
  fireNext(): number;
}

function createFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; fire: () => void }>();
  const earliest = () => [...timers.entries()].sort(([a, x], [b, y]) => x.due - y.due || a - b)[0];
  const clock: FakeClock = {
    setTimeout(fire, ms) {
      seq += 1;
      timers.set(seq, { due: now + ms, fire });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    now: () => now,
    pending: () => [...timers.values()].map((timer) => timer.due - now).sort((a, b) => a - b),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = earliest();
        if (next === undefined || next[1].due > target) {
          break;
        }
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fire();
      }
      now = target;
    },
    fireNext() {
      const [first] = clock.pending();
      if (first === undefined) {
        throw new Error("no pending timer");
      }
      clock.advance(first);
      return first;
    },
  };
  return clock;
}

interface ConnectCall {
  host: string;
  port: number;
}

interface WorldOptions {
  /** A space in the base directory: every path below it goes through `\040`. */
  spaced?: boolean;
  /** Leave the fake `fusermount3` out of the bin directory (feature-off unmount). */
  noFusermount?: boolean;
}

export interface World {
  base: string;
  state: string;
  mountsDir: string;
  sandbox: string;
  root: string;
  bin: string;
  clock: FakeClock;
  connects: ConnectCall[];
  source: string;
  mountinfo: string;
  db: DatabaseSync;
  store: ReturnType<typeof createMountStore>;
  errors: Error[];
  sharedDirCalls: string[];
  options(overrides?: Partial<MountManagerOptions>): MountManagerOptions;
  manager(overrides?: Partial<MountManagerOptions>): ReturnType<typeof createMountManager>;
  /** Builds a manager from complete options; it is closed with the world. */
  build(options: MountManagerOptions): ReturnType<typeof createMountManager>;
  rootOf(workspaceId: string): string;
  privateDir(id: string): string;
  mountPoint(name: string): string;
  calls(): Call[];
  mountCalls(): Call[];
  fusermountCalls(): { argv: string[]; removed: number }[];
  installFusermount(): void;
  audits(): { kind: string; title: string; detail: unknown; workspace_id: string | null }[];
}

const worlds: { world: World; managers: ReturnType<typeof createMountManager>[] }[] = [];

export function createWorld(worldOptions: WorldOptions = {}): World {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), worldOptions.spaced ? "mounts manager " : "mounts-manager-")),
  );
  const state = join(base, "state");
  const mountsDir = join(state, "mounts");
  mkdirSync(mountsDir, { recursive: true, mode: 0o700 });
  const sandbox = join(base, "sandbox");
  const root = join(sandbox, OWNER, "w1");
  const workspaces = [
    [W1, OWNER, "w1"],
    [W2, OWNER, "w2"],
    [W3, OWNER, "w3"],
    [W_LISI, LISI, "w5"],
    [W_WANGWU, WANGWU, "w6"],
  ] as const;
  const roots = new Map<string, string>();
  for (const [id, owner, dir] of workspaces) {
    roots.set(id, join(sandbox, owner, dir));
    mkdirSync(join(sandbox, owner, dir), { recursive: true });
  }
  const ownerOf = new Map<string, string>(workspaces.map(([id, owner]) => [id, owner]));
  const source = join(base, "sources", "src dir");
  mkdirSync(source, { recursive: true });
  const bin = join(base, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const mountinfo = join(state, "fake-mountinfo");
  writeFileSync(mountinfo, "");
  writeFileSync(join(bin, "mountinfo.path"), mountinfo);
  const installFusermount = () => {
    copyFileSync(FAKE_FUSERMOUNT, join(bin, "fusermount3"));
    chmodSync(join(bin, "fusermount3"), 0o755);
  };
  if (!worldOptions.noFusermount) {
    installFusermount();
  }

  const db = openDb(":memory:");
  for (const [id, owner, dir] of workspaces) {
    db.prepare(
      "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, 1)",
    ).run(id, owner, dir, dir);
  }
  const ids = [ID1, ID2, ID3];
  const store = createMountStore(db, { generateId: () => ids.shift() ?? SOURCE_ID });
  const errors: Error[] = [];
  const sharedDirCalls: string[] = [];
  const clock = createFakeClock();
  const connects: ConnectCall[] = [];
  const answering: TcpConnect = async (host, port) => {
    connects.push({ host, port });
    return true;
  };
  const managers: ReturnType<typeof createMountManager>[] = [];
  const build = (options: MountManagerOptions) => {
    const manager = createMountManager(options);
    managers.push(manager);
    return manager;
  };

  const readJsonl = <T>(file: string): T[] =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as T)
      : [];
  const calls = () => readJsonl<Call>(join(state, "fake-rclone-calls.jsonl"));

  const options = (overrides: Partial<MountManagerOptions> = {}): MountManagerOptions => ({
    store,
    audit: { emit: (event) => emit(db, event) },
    mountsDir,
    workspaceRootOf: (ownerId, workspaceId) =>
      ownerOf.get(workspaceId) === ownerId ? (roots.get(workspaceId) ?? null) : null,
    protectedRoots: [sandbox, state],
    onError: (error) => errors.push(error),
    rcloneBin: FAKE_RCLONE,
    fusermountBin: join(bin, "fusermount3"),
    mountinfoPath: mountinfo,
    path: bin,
    resolveHost: testResolver,
    clock,
    connect: answering,
    ensureSharedDir: (absPath) => {
      sharedDirCalls.push(absPath);
      ensureSharedDir(absPath);
    },
    ...overrides,
  });

  const world: World = {
    base,
    state,
    mountsDir,
    sandbox,
    root,
    bin,
    clock,
    connects,
    source,
    mountinfo,
    db,
    store,
    errors,
    sharedDirCalls,
    options,
    manager: (overrides) => build(options(overrides)),
    build,
    rootOf: (workspaceId) => {
      const found = roots.get(workspaceId);
      if (found === undefined) {
        throw new Error(`no workspace ${workspaceId}`);
      }
      return found;
    },
    privateDir: (id) => join(mountsDir, id),
    mountPoint: (name) => join(root, name),
    calls,
    mountCalls: () => calls().filter((call) => call.argv[1] === "mount"),
    fusermountCalls: () => readJsonl(join(bin, "fusermount3-calls.jsonl")),
    installFusermount,
    audits: () =>
      db
        .prepare("SELECT kind, title, detail, workspace_id FROM audit_events ORDER BY id")
        .all()
        .map((row) => ({
          kind: String(row.kind),
          title: Buffer.from(row.title as Uint8Array).toString("utf8"),
          detail: JSON.parse(String(row.detail)),
          workspace_id: row.workspace_id === null ? null : String(row.workspace_id),
        })),
  };
  worlds.push({ world, managers });
  return world;
}

/** Registers the source row for `local(…)` mounts: the world's `source` directory (a realpath). */
export function registerSource(world: World, path = world.source): void {
  world.db
    .prepare(
      "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, 'NAS', ?, 0, 1)",
    )
    .run(SOURCE_ID, path);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills every fake rclone still alive, closes the databases, removes the trees (`fs/promises`). */
export async function disposeWorlds(): Promise<void> {
  for (const { world, managers } of worlds.splice(0)) {
    await Promise.all(managers.map((manager) => manager.closeAll()));
    for (const call of world.calls()) {
      if (alive(call.pid)) {
        process.kill(call.pid, "SIGKILL");
      }
    }
    world.db.close();
    await rm(world.base, { recursive: true, force: true });
  }
}

/** The sorted entries of a directory, or `missing`. */
export function entriesOf(dir: string): string[] | "missing" {
  return existsSync(dir) ? readdirSync(dir).sort() : "missing";
}

/**
 * A row, private directory and `rclone.conf` as an earlier run left them (`sftp` / `smb` with `host =
 * 10.0.0.1`), `created_at` as given. Returns the conf text.
 */
export function seedMount(
  world: World,
  seed: { id: string; body: MountBody; createdAt: number; workspaceId?: string },
): string {
  const workspaceId = seed.workspaceId ?? W1;
  world.store.create({ id: seed.id, workspaceId, ownerId: OWNER, body: seed.body });
  world.db
    .prepare("UPDATE workspace_mounts SET created_at = ? WHERE id = ?")
    .run(seed.createdAt, seed.id);
  const dir = world.privateDir(seed.id);
  mkdirSync(dir, { mode: 0o700 });
  const conf =
    seed.body.backend === "local"
      ? `[m${seed.id}]\ntype = local\n`
      : `[m${seed.id}]\ntype = ${seed.body.backend}\nhost = 10.0.0.1\nuser = \`${USER_SENTINEL}\`\npass = ${obscured(PASS_SENTINEL)}\n`;
  writeFileSync(join(dir, "rclone.conf"), conf, { mode: 0o600 });
  return conf;
}

/** The behaviour markers of the next fake `mount` calls, one per call (`fake-rclone-next`). */
export function nextMounts(world: World, markers: readonly string[]): void {
  writeFileSync(join(world.state, "fake-rclone-next"), markers.map((m) => `${m}\n`).join(""));
}

/**
 * The next fake `fusermount3` call stops before it acts until `releaseFusermount` (at most 10 s): it pins
 * an offline transition at its unmount step.
 */
export function holdFusermount(world: World): void {
  writeFileSync(join(world.bin, "fusermount3-hold"), "");
}

/** A held fake `fusermount3` call is waiting. */
export function fusermountHeld(world: World): boolean {
  return existsSync(join(world.bin, "fusermount3-holding"));
}

export function releaseFusermount(world: World): void {
  rmSync(join(world.bin, "fusermount3-holding"));
}

/** Polls `condition` every 20 ms (real time) until it holds; fails after `ms`. */
export async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached");
    }
    await delay(20);
  }
}

/**
 * A real-time window for work that must NOT happen (a spawn, a timer): absence checks only, never a
 * timing assertion — a correct manager passes however slow the machine is.
 */
export function quiet(ms = 300): Promise<void> {
  return delay(ms);
}

/** The pids of every recorded fake `mount` still alive. */
export function aliveMounts(world: World): number[] {
  return world
    .mountCalls()
    .map((call) => call.pid)
    .filter(alive);
}
