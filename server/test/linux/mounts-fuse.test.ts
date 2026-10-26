/**
 * Issue 1700 (s1b-workspace-mounts tasks 12.2): workspace-mounts「真实挂载验证层」— 「非 opt-in 明示跳过」
 * 「opt-in 缺前提即失败」「local 后端的生命周期」「删除不复活」「sftp 读写与远端停机」, plus 「凭证文件往返」
 * (the #1685 test-host measurements as a regression). The real mount-manager (`createMountManager`) with
 * its real children: rclone from WORKBUDDY_FUSE_RCLONE, `fusermount3` from PATH, `/proc/self/mountinfo`,
 * the system resolver, real timers and the real TCP connect — nothing injected but the database
 * (`:memory:` through the real migrations) and the test-owned directories.
 * Opt-in only: Linux and WORKBUDDY_FUSE_TEST=1, run by hand in a disposable container on the test host;
 * skipped everywhere else, CI included, before any directory or child process exists. Opted in, a
 * missing prerequisite (WORKBUDDY_FUSE_RCLONE an executable file, `fusermount3` and `fusermount` on
 * PATH — rclone 1.60.1 looks up `fusermount` —, `/dev/fuse`) fails the suite instead of skipping it.
 * The `sftp` cases run when all of WORKBUDDY_FUSE_SFTP_HOST, _PORT, _USER, _PASS, _PATH, _DOWN, _UP are
 * given (`_DOWN` / `_UP`: absolute paths of the test host's executables that cut and restore the
 * network path to the remote while rclone stays alive); giving only some fails the suite naming the
 * rest. The remote's address and credentials only ever come from these variables.
 * "Mounted" is the mount point's path in /proc/self/mountinfo. The test never touches a mount
 * synchronously while its remote is cut. Each case ends by closing its manager, SIGKILLing any rclone of
 * its mounts, `fusermount3 -uz` on whatever is still mounted below its directories, failing if a mount
 * is left; only then is the tree removed, with fs/promises `rm`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emit } from "../../src/core/audit/index.js";
import { openDb } from "../../src/core/db/index.js";
import { findExecutable } from "../../src/workspaces/mounts/config.js";
import { createMountManager, type MountManager } from "../../src/workspaces/mounts/manager.js";
import { writeRcloneConf } from "../../src/workspaces/mounts/rclone-conf.js";
import { createMountStore } from "../../src/workspaces/mounts/store.js";
import type { MountBody } from "../../src/workspaces/mounts/validate.js";

const OPT_IN = "WORKBUDDY_FUSE_TEST";
const RCLONE = "WORKBUDDY_FUSE_RCLONE";
const SFTP_KEYS = ["HOST", "PORT", "USER", "PASS", "PATH", "DOWN", "UP"].map(
  (key) => `WORKBUDDY_FUSE_SFTP_${key}`,
);
const SFTP_GIVEN = SFTP_KEYS.filter((key) => (process.env[key] ?? "") !== "");
const OPTED_IN = process.platform === "linux" && process.env[OPT_IN] === "1";

const OWNER = "u1";
const WORKSPACE = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const SOURCE_ID = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const ACTOR = { actorId: OWNER, reason: "user" } as const;
/** design D11: a probe round every 30 s, each check 5 s. */
const PROBE_ROUND_MS = 35_000;
/** design D11 / tasks 12.2: backoff capped at 300 s, the 20 s readiness window, and margin. */
const BACK_ONLINE_MS = 360_000;
/** The first remount is 5 s after going offline; the readiness window is 20 s. */
const REMOUNT_MS = 60_000;
/** P8's write-back window was 5 s; the sequence is judged 7 s later (spec「删除不复活」). */
const WRITE_BACK_SETTLE_MS = 7_000;
/** The sequence races rclone's upload; one run of it reproduces only sometimes (#1700 sign-off). */
const RESURRECTION_ROUNDS = 50;
/** With `--vfs-write-back 0s` a closed file is uploaded at once; this bounds the wait for it. */
const UPLOAD_MS = 15_000;
/** While the remote is cut: one remount at 5 s and its whole 20 s readiness window, and margin. */
const HELD_DOWN_MS = 30_000;
/** How long after the sftp mount came online (and was read back) the remote is cut. */
const CUT_INTO_ROUND_MS = 3_000;
const LOCAL_CASE_MS = 120_000;
const SFTP_CASE_MS = 600_000;
const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["notes.md", "# kept\n"],
  [join("nested", "deep.txt"), "deep\n"],
];

interface Prerequisites {
  rclone: string;
  fusermount3: string;
}

interface Sftp {
  host: string;
  port: number;
  username: string;
  password: string;
  remotePath: string;
  down: string;
  up: string;
}

interface World {
  base: string;
  root: string;
  source: string;
  db: DatabaseSync;
  manager: MountManager;
  errors: Error[];
}

/** This case's roots, managers and databases; `afterEach` tears them down in that order. */
const owned: { roots: string[]; worlds: World[]; restoreRemote: (() => void) | undefined } = {
  roots: [],
  worlds: [],
  restoreRemote: undefined,
};

describe.skipIf(!OPTED_IN)(
  `real mounts through the mount-manager (Linux only; opt in with ${OPT_IN}=1)`,
  () => {
    let bins: Prerequisites;
    let sftp: Sftp | undefined;

    beforeAll(() => {
      [bins, sftp] = requirePrerequisites();
    });

    afterEach(async () => {
      await tearDownOwned(bins);
    });

    it("凭证文件往返：rclone config dump 逐字读回 user 与 IPv6 host", {
      timeout: LOCAL_CASE_MS,
    }, async () => {
      const dir = ownedTempDir();
      // #1685 issuecomment-6407526286 / -6407542835: unwrapped, a backtick pair is unquoted, `"""` opens
      // a multi-line value that fails the whole file, U+0085 at either end is trimmed.
      const usernames = [
        '`"""a\\b\u0085',
        '\u0085`tick`"""\\',
        '"""tri',
        "`tick`",
        "`",
        "a```b",
        "a\u0085",
        "\u0085a",
        "\\",
        "a\\`b",
        '"quoted"',
        "a # b",
        "张三",
      ];
      for (const [index, username] of usernames.entries()) {
        const mountId = index.toString(16).padStart(32, "0");
        const body: MountBody = {
          name: "远端",
          backend: "sftp",
          host: "files.intra",
          remotePath: "/srv/data",
          readOnly: false,
          username,
          password: "pw-1700",
        };
        await writeRcloneConf({ rcloneBin: bins.rclone, dir, mountId }, body, "fd00::1");
        const dumped = spawnSync(
          bins.rclone,
          ["config", "dump", "--config", join(dir, "rclone.conf")],
          { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir } },
        );
        expect(dumped.status, `rclone config dump: ${dumped.stderr}`).toBe(0);
        const section = (JSON.parse(dumped.stdout) as Record<string, Record<string, string>>)[
          `m${mountId}`
        ];
        expect(section?.type).toBe("sftp");
        expect(section?.host).toBe("[fd00::1]");
        expect(section?.user, `username #${index}`).toBe(username);
      }
    });

    it("local 后端的生命周期：建、读、写、改名与源目录一致；SIGKILL rclone 即离线并重挂；卸载后不留挂载点", {
      timeout: LOCAL_CASE_MS,
    }, async () => {
      const world = createWorld(bins);
      const record = await world.manager.attach(localBody("本机", false));
      const mountPoint = join(world.root, "本机");
      expect(world.manager.statusOf(record.id)).toBe("online");
      expect(mountPoints()).toContain(mountPoint);
      expect(await treeOf(mountPoint)).toEqual(await treeOf(world.source));

      await mkdir(join(mountPoint, "新目录"));
      await writeFile(join(mountPoint, "新目录", "written.txt"), "written through the mount\n");
      await rename(join(mountPoint, "notes.md"), join(mountPoint, "renamed.md"));
      expect(await readFile(join(mountPoint, "renamed.md"), "utf8")).toBe("# kept\n");
      const expected = {
        "d nested": "",
        "f nested/deep.txt": "deep\n",
        "f renamed.md": "# kept\n",
        "d 新目录": "",
        "f 新目录/written.txt": "written through the mount\n",
      };
      await waitFor(async () => same(await treeOf(world.source), expected), UPLOAD_MS);
      expect(await treeOf(world.source)).toEqual(expected);
      expect(await treeOf(mountPoint)).toEqual(expected);

      const [pid] = rclonePids(record.id);
      expect(pid, "the mount's rclone process").toBeDefined();
      const killedAt = Date.now();
      process.kill(Number(pid), "SIGKILL");
      await waitFor(
        async () =>
          world.manager.statusOf(record.id) === "offline" && !mountPoints().includes(mountPoint),
        PROBE_ROUND_MS,
      );
      expect(Date.now() - killedAt).toBeLessThanOrEqual(PROBE_ROUND_MS);
      await waitFor(async () => world.manager.statusOf(record.id) === "online", REMOUNT_MS);
      expect(mountPoints()).toContain(mountPoint);
      expect(rclonePids(record.id)).not.toContain(pid);
      expect(await treeOf(mountPoint)).toEqual(expected);

      await world.manager.detach(record.id, ACTOR);
      expect(mountPoints()).not.toContain(mountPoint);
      expect(existsSync(mountPoint)).toBe(false);
      expect(existsSync(join(world.base, "state", "mounts", record.id))).toBe(false);
      expect(rclonePids(record.id)).toEqual([]);
      expect(await treeOf(world.source)).toEqual(expected);
      expect(world.errors).toEqual([]);
    });

    it("只读挂载写入失败（EROFS），源目录不变", { timeout: LOCAL_CASE_MS }, async () => {
      const world = createWorld(bins);
      const before = await treeOf(world.source);
      const record = await world.manager.attach(localBody("只读", true));
      const mountPoint = join(world.root, "只读");
      expect(world.manager.statusOf(record.id)).toBe("online");
      expect(await readFile(join(mountPoint, "notes.md"), "utf8")).toBe("# kept\n");

      await expect(writeFile(join(mountPoint, "new.txt"), "x")).rejects.toMatchObject({
        code: "EROFS",
      });
      await expect(writeFile(join(mountPoint, "notes.md"), "x")).rejects.toMatchObject({
        code: "EROFS",
      });
      await expect(mkdir(join(mountPoint, "d"))).rejects.toMatchObject({ code: "EROFS" });
      await expect(
        rename(join(mountPoint, "notes.md"), join(mountPoint, "moved.md")),
      ).rejects.toMatchObject({ code: "EROFS" });

      await world.manager.detach(record.id, ACTOR);
      expect(mountPoints()).not.toContain(mountPoint);
      expect(existsSync(mountPoint)).toBe(false);
      expect(await treeOf(world.source)).toEqual(before);
      expect(world.errors).toEqual([]);
    });

    // Known limitation (ADR-0003「2026-10 补充」, system.md §9.12): with `--vfs-write-back 0s` the
    // sequence still leaves the directory's original name behind in the source in about one sequence
    // of eight, so the case repeats it and is `it.fails` until rclone stops doing so (owner 2026-10-25).
    it.fails("删除不复活：目录改名后删掉其中的新文件与目录，7 s 后挂载视图与源目录都无残留", {
      timeout: LOCAL_CASE_MS,
    }, async () => {
      const world = createWorld(bins);
      const before = await treeOf(world.source);
      const record = await world.manager.attach(localBody("本机", false));
      const mountPoint = join(world.root, "本机");

      for (let round = 0; round < RESURRECTION_ROUNDS; round += 1) {
        await mkdir(join(mountPoint, `d${round}`));
        await writeFile(join(mountPoint, `d${round}`, "f"), "resurrection probe\n");
        await rename(join(mountPoint, `d${round}`), join(mountPoint, `d2-${round}`));
        await unlink(join(mountPoint, `d2-${round}`, "f"));
        await rmdir(join(mountPoint, `d2-${round}`));
      }
      await delay(WRITE_BACK_SETTLE_MS);
      const view = await treeOf(mountPoint);
      const source = await treeOf(world.source);
      await world.manager.detach(record.id, ACTOR);
      expect(mountPoints()).not.toContain(mountPoint);
      console.info(
        `删除不复活 residue in the source: ${residueOf(source, before).join(" ") || "none"}`,
      );

      expect(view).toEqual(before);
      expect(source).toEqual(before);
    });

    describe.skipIf(SFTP_GIVEN.length !== SFTP_KEYS.length)("sftp", () => {
      it("sftp 读写：写入经远端读回一致，卸载后不留挂载点", { timeout: SFTP_CASE_MS }, async () => {
        const remote = sftp as Sftp;
        const world = createWorld(bins);
        const file = `wb-fuse-${randomBytes(8).toString("hex")}.txt`;
        const bytes = `written over sftp ${randomBytes(16).toString("hex")}\n`;
        const first = await world.manager.attach(sftpBody(remote, "远端"));
        const mountPoint = join(world.root, "远端");
        expect(world.manager.statusOf(first.id)).toBe("online");
        expect(mountPoints()).toContain(mountPoint);
        await writeFile(join(mountPoint, file), bytes);
        expect(await readFile(join(mountPoint, file), "utf8")).toBe(bytes);
        await world.manager.detach(first.id, ACTOR);
        expect(mountPoints()).not.toContain(mountPoint);
        expect(existsSync(mountPoint)).toBe(false);

        // A second mount has a fresh private directory, so no VFS cache: the bytes come from the remote.
        const second = await world.manager.attach(sftpBody(remote, "远端"));
        expect(await readFile(join(mountPoint, file), "utf8")).toBe(bytes);
        await unlink(join(mountPoint, file));
        await world.manager.detach(second.id, ACTOR);
        expect(mountPoints()).not.toContain(mountPoint);
        expect(existsSync(mountPoint)).toBe(false);
        expect(world.errors).toEqual([]);
      });

      it("sftp 远端停机：_DOWN 之后 35 s 内离线，_UP 之后 360 s 内回到在线且读回一致", {
        timeout: SFTP_CASE_MS,
      }, async () => {
        const remote = sftp as Sftp;
        const world = createWorld(bins);
        const file = `wb-fuse-${randomBytes(8).toString("hex")}.txt`;
        const bytes = `survives the outage ${randomBytes(16).toString("hex")}\n`;
        const record = await world.manager.attach(sftpBody(remote, "远端"));
        const mountPoint = join(world.root, "远端");
        await writeFile(join(mountPoint, file), bytes);
        expect(await readFile(join(mountPoint, file), "utf8")).toBe(bytes);

        // Into the probe round armed when the mount came online: cut right at its start, detection is
        // 30 s + the probe's own child time + 5 s — tens of ms past 35 s (#1700 sign-off, run 1).
        await delay(CUT_INTO_ROUND_MS);
        owned.restoreRemote = () => runRemoteSwitch(remote.up);
        runRemoteSwitch(remote.down);
        const downAt = Date.now();
        await waitFor(async () => world.manager.statusOf(record.id) === "offline", PROBE_ROUND_MS);
        const offlineAfter = Date.now() - downAt;
        expect(offlineAfter).toBeLessThanOrEqual(PROBE_ROUND_MS);
        await waitFor(async () => !mountPoints().includes(mountPoint), PROBE_ROUND_MS);
        const heldUntil = Date.now() + HELD_DOWN_MS;
        while (Date.now() < heldUntil) {
          expect(world.manager.statusOf(record.id), "no remount while the remote is cut").toBe(
            "offline",
          );
          await delay(500);
        }

        runRemoteSwitch(remote.up);
        owned.restoreRemote = undefined;
        const upAt = Date.now();
        await waitFor(async () => world.manager.statusOf(record.id) === "online", BACK_ONLINE_MS);
        const onlineAfter = Date.now() - upAt;
        expect(onlineAfter).toBeLessThanOrEqual(BACK_ONLINE_MS);
        expect(mountPoints()).toContain(mountPoint);
        expect(await readFile(join(mountPoint, file), "utf8")).toBe(bytes);
        console.info(
          `sftp outage: offline ${offlineAfter} ms after _DOWN, online ${onlineAfter} ms after _UP`,
        );

        await unlink(join(mountPoint, file));
        await world.manager.detach(record.id, ACTOR);
        expect(mountPoints()).not.toContain(mountPoint);
        expect(existsSync(mountPoint)).toBe(false);
        expect(world.errors).toEqual([]);
      });
    });
  },
);

/** The prerequisites of an opted-in run; any missing one throws (the suite fails, no skip). */
function requirePrerequisites(): [Prerequisites, Sftp | undefined] {
  const missing: string[] = [];
  const rclone = process.env[RCLONE] ?? "";
  if (rclone === "") {
    missing.push(`${RCLONE} is not set`);
  } else if (!isAbsolute(rclone) || !isExecutableFile(rclone)) {
    missing.push(`${RCLONE} is not an absolute path to an executable file`);
  }
  const path = process.env.PATH;
  const fusermount3 = findExecutable(path, "fusermount3");
  for (const [tool, found] of [
    ["fusermount3", fusermount3],
    ["fusermount", findExecutable(path, "fusermount")],
  ] as const) {
    if (found === undefined) {
      missing.push(`${tool} is not on PATH`);
    }
  }
  if (!existsSync("/dev/fuse") || !statSync("/dev/fuse").isCharacterDevice()) {
    missing.push("/dev/fuse is not available");
  }
  let sftp: Sftp | undefined;
  if (SFTP_GIVEN.length > 0 && SFTP_GIVEN.length < SFTP_KEYS.length) {
    const absent = SFTP_KEYS.filter((key) => !SFTP_GIVEN.includes(key));
    missing.push(`only part of the sftp variables is set, missing: ${absent.join(", ")}`);
  } else if (SFTP_GIVEN.length === SFTP_KEYS.length) {
    sftp = sftpFromEnv(missing);
  }
  if (missing.length > 0) {
    throw new Error(`${OPT_IN}=1 but the mount prerequisites are missing: ${missing.join("; ")}`);
  }
  return [{ rclone, fusermount3: String(fusermount3) }, sftp];
}

/** The full sftp variable set, shape-checked; problems are appended to `missing`, never the values. */
function sftpFromEnv(missing: string[]): Sftp {
  const env = (key: string) => process.env[`WORKBUDDY_FUSE_SFTP_${key}`] ?? "";
  const port = Number(env("PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    missing.push("WORKBUDDY_FUSE_SFTP_PORT is not a port number");
  }
  for (const key of ["DOWN", "UP"]) {
    if (!isAbsolute(env(key)) || !isExecutableFile(env(key))) {
      missing.push(`WORKBUDDY_FUSE_SFTP_${key} is not an absolute path to an executable file`);
    }
  }
  if (!env("PATH").startsWith("/")) {
    missing.push("WORKBUDDY_FUSE_SFTP_PATH is not an absolute path");
  }
  return {
    host: env("HOST"),
    port,
    username: env("USER"),
    password: env("PASS"),
    remotePath: env("PATH"),
    down: env("DOWN"),
    up: env("UP"),
  };
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A fresh realpath'd directory under the system temp dir, recorded for the cleanup. */
function ownedTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "wb-mounts-fuse-")));
  owned.roots.push(dir);
  return dir;
}

/**
 * `<base>/state/mounts` (0700), the workspace root `<base>/sandbox/u1/w1`, a registered source
 * `<base>/sources/src` with the files above, and a manager on them with production defaults.
 */
function createWorld(bins: Prerequisites): World {
  const base = ownedTempDir();
  const mountsDir = join(base, "state", "mounts");
  mkdirSync(mountsDir, { recursive: true, mode: 0o700 });
  const sandbox = join(base, "sandbox");
  const root = join(sandbox, OWNER, "w1");
  mkdirSync(root, { recursive: true });
  const source = join(base, "sources", "src");
  for (const [relative, text] of SOURCE_FILES) {
    mkdirSync(dirname(join(source, relative)), { recursive: true });
    writeFileSync(join(source, relative), text);
  }
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, 'w1', 'w1', 1)",
  ).run(WORKSPACE, OWNER);
  db.prepare(
    "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, 'NAS', ?, 0, 1)",
  ).run(SOURCE_ID, source);
  const errors: Error[] = [];
  const manager = createMountManager({
    store: createMountStore(db),
    audit: { emit: (event) => emit(db, event) },
    mountsDir,
    workspaceRootOf: (ownerId, workspaceId) =>
      ownerId === OWNER && workspaceId === WORKSPACE ? root : null,
    protectedRoots: [sandbox, join(base, "state")],
    onError: (error) => errors.push(error),
    rcloneBin: bins.rclone,
    fusermountBin: bins.fusermount3,
  });
  const world = { base, root, source, db, manager, errors };
  owned.worlds.push(world);
  return world;
}

function localBody(name: string, readOnly: boolean) {
  return {
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    body: { name, backend: "local", sourceId: SOURCE_ID, readOnly } as MountBody,
  };
}

function sftpBody(remote: Sftp, name: string) {
  return {
    workspaceId: WORKSPACE,
    ownerId: OWNER,
    body: {
      name,
      backend: "sftp",
      host: remote.host,
      port: remote.port,
      remotePath: remote.remotePath,
      readOnly: false,
      username: remote.username,
      password: remote.password,
    } as MountBody,
  };
}

/** Runs `_DOWN` / `_UP`; a failure fails the case (its output may name the remote: not echoed). */
function runRemoteSwitch(executable: string): void {
  const run = spawnSync(executable, [], { stdio: "ignore", timeout: 30_000 });
  if (run.status !== 0) {
    throw new Error(`the remote switch exited with ${String(run.status ?? run.signal)}`);
  }
}

/**
 * Every path below `dir` with its type (`d` / `f`) mapped to the file's text (`""` for directories), by
 * fs/promises only: a mount is never entered synchronously.
 */
async function treeOf(dir: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(join(dir, relative))).sort();
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if ((await lstat(join(dir, path))).isDirectory()) {
        tree[`d ${path}`] = "";
        await walk(path);
      } else {
        tree[`f ${path}`] = await readFile(join(dir, path), "utf8");
      }
    }
  };
  await walk("");
  return tree;
}

/** The entries of `tree` that `before` does not have. */
function residueOf(tree: Record<string, string>, before: Record<string, string>): string[] {
  return Object.keys(tree).filter((key) => !(key in before));
}

function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

/** Polls `condition` every 20 ms until it holds; fails after `ms`. */
async function waitFor(condition: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition().catch(() => false))) {
    if (Date.now() > deadline) {
      throw new Error(`condition not reached within ${ms} ms`);
    }
    await delay(20);
  }
}

/** Mount points (field 5 of /proc/self/mountinfo, octal escapes decoded, read as UTF-8). */
function mountPoints(): string[] {
  return readFileSync("/proc/self/mountinfo", "latin1")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) =>
      Buffer.from(
        String(line.split(" ")[4]).replace(/\\([0-7]{3})/gu, (_, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
        "latin1",
      ).toString("utf8"),
    );
}

/** The pids of every live `rclone mount m<id>:…` process (argv from /proc/<pid>/cmdline). */
function rclonePids(mountId: string): number[] {
  const section = `m${mountId}:`;
  return readdirSync("/proc")
    .filter((entry) => /^[0-9]+$/u.test(entry))
    .filter((pid) => {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return argv[1] === "mount" && String(argv[2]).startsWith(section);
      } catch {
        return false; // exited meanwhile
      }
    })
    .map(Number);
}

/**
 * Restores a cut remote, closes every manager of the case (it unmounts what it mounted), SIGKILLs any
 * rclone of the case's mounts still alive, `fusermount3 -uz` every mount left below the case's roots
 * (deepest first) and fails if one remains; then closes the databases and removes the roots.
 */
async function tearDownOwned(bins: Prerequisites | undefined): Promise<void> {
  const { roots, worlds, restoreRemote } = owned;
  owned.roots = [];
  owned.worlds = [];
  owned.restoreRemote = undefined;
  restoreRemote?.();
  await Promise.all(worlds.map((world) => world.manager.closeAll()));
  for (const world of worlds) {
    const ids = world.db.prepare("SELECT id FROM workspace_mounts").all();
    for (const { id } of ids) {
      for (const pid of rclonePids(String(id))) {
        process.kill(pid, "SIGKILL");
      }
    }
  }
  const below = (point: string) => roots.some((root) => point.startsWith(`${root}/`));
  const failures: string[] = [];
  for (const point of mountPoints()
    .filter(below)
    .sort((a, b) => b.length - a.length)) {
    const result = spawnSync(bins?.fusermount3 ?? "fusermount3", ["-uz", point], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failures.push(`${point}: ${result.stderr || String(result.error)}`);
    }
  }
  const left = mountPoints().filter(below);
  if (failures.length > 0 || left.length > 0) {
    throw new Error(
      `fusermount3 -uz failed: ${failures.join("; ")}; still mounted: ${left.join(", ")}`,
    );
  }
  for (const world of worlds) {
    world.db.close();
  }
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
}
