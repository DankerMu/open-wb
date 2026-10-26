/**
 * The world of `mounts-manager*.test.ts` (s1b-workspace-mounts tasks 5.2): a real manager wired to the
 * real-spawned fake rclone (`fixtures/fake-rclone.mjs`) and fake `fusermount3`
 * (`fixtures/fake-fusermount3.mjs`), a fake mountinfo at `<state>/fake-mountinfo`, a `:memory:` database
 * through the real migrations, and real audit rows. The manager's PATH is a bin directory of this world
 * only: a `node` link (the fakes' shebang) and, unless left out, the fake `fusermount3` — never the host's
 * own FUSE tools. Every recorded fake rclone pid still alive at the end is SIGKILLed.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import { createMountManager, type MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import { createMountStore } from "../src/workspaces/mounts/store.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";

export const FAKE_RCLONE = fileURLToPath(new URL("./fixtures/fake-rclone.mjs", import.meta.url));
const FAKE_FUSERMOUNT = fileURLToPath(new URL("./fixtures/fake-fusermount3.mjs", import.meta.url));

export const W1 = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
export const OWNER = "u1";
export const ID1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const ID2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const ID3 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const SOURCE_ID = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

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
  source: string;
  mountinfo: string;
  db: DatabaseSync;
  store: ReturnType<typeof createMountStore>;
  errors: Error[];
  sharedDirCalls: string[];
  options(overrides?: Partial<MountManagerOptions>): MountManagerOptions;
  manager(overrides?: Partial<MountManagerOptions>): ReturnType<typeof createMountManager>;
  privateDir(id: string): string;
  mountPoint(name: string): string;
  calls(): Call[];
  mountCalls(): Call[];
  fusermountCalls(): { argv: string[]; removed: number }[];
  installFusermount(): void;
  audits(): { kind: string; title: string; detail: unknown; workspace_id: string | null }[];
}

const worlds: World[] = [];

export function createWorld(worldOptions: WorldOptions = {}): World {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), worldOptions.spaced ? "mounts manager " : "mounts-manager-")),
  );
  const state = join(base, "state");
  const mountsDir = join(state, "mounts");
  mkdirSync(mountsDir, { recursive: true, mode: 0o700 });
  const sandbox = join(base, "sandbox");
  const root = join(sandbox, OWNER, "w1");
  mkdirSync(root, { recursive: true });
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
  db.prepare(
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, 'w1', 'w1', 1)",
  ).run(W1, OWNER);
  const ids = [ID1, ID2, ID3];
  const store = createMountStore(db, { generateId: () => ids.shift() ?? SOURCE_ID });
  const errors: Error[] = [];
  const sharedDirCalls: string[] = [];

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
      ownerId === OWNER && workspaceId === W1 ? root : null,
    protectedRoots: [sandbox, state],
    onError: (error) => errors.push(error),
    rcloneBin: FAKE_RCLONE,
    fusermountBin: join(bin, "fusermount3"),
    mountinfoPath: mountinfo,
    path: bin,
    resolveHost: testResolver,
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
    source,
    mountinfo,
    db,
    store,
    errors,
    sharedDirCalls,
    options,
    manager: (overrides) => createMountManager(options(overrides)),
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
  worlds.push(world);
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
  for (const world of worlds.splice(0)) {
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
