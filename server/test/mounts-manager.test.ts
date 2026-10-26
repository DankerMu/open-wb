/**
 * s1b-workspace-mounts group 5 (manager part, #1686): mounting through the mount-manager (design D3 manager
 * side, D5, D7, D8, D9; workspace-mounts「挂载凭证文件」「挂载进程与挂载点」「挂载取值与主机规则」manager
 * scenarios). The seam is `createMountManager` with the real-spawned fake rclone and fake `fusermount3`
 * (`mounts-manager-helpers.ts`); the readiness criterion reads the fake mountinfo the fakes write. Expected
 * argv, file shapes and modes are literals from the spec; credentials are sentinels asserted absent from
 * every argv, environment and error-channel record. Unmounting is in `mounts-manager-unmount.test.ts`.
 * Not covered: a mount point owned by another uid (needs root to build), and the remount side of the
 * host / mount-point re-checks (group 6, #1687).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import { parseMountinfo, sectionMounts } from "../src/workspaces/mounts/mountinfo.js";
import {
  alive,
  childEnv,
  createWorld,
  disposeWorlds,
  entriesOf,
  FAKE_RCLONE,
  ID1,
  ID2,
  KEY_SENTINEL,
  local,
  OWNER,
  obscured,
  PARENT_ENV_SENTINEL,
  PASS_SENTINEL,
  registerSource,
  sftp,
  sftpKey,
  smb,
  USER_SENTINEL,
  W1,
  type World,
} from "./mounts-manager-helpers.js";

const CASE_MS = 20_000;
const SENTINELS = [
  USER_SENTINEL,
  PASS_SENTINEL,
  KEY_SENTINEL,
  PARENT_ENV_SENTINEL,
  obscured(PASS_SENTINEL),
];

let world: World;
let savedKey: string | undefined;

beforeEach(() => {
  world = createWorld();
  savedKey = process.env.MODEL_UPSTREAM_API_KEY;
  process.env.MODEL_UPSTREAM_API_KEY = PARENT_ENV_SENTINEL;
});

afterEach(async () => {
  if (savedKey === undefined) {
    delete process.env.MODEL_UPSTREAM_API_KEY;
  } else {
    process.env.MODEL_UPSTREAM_API_KEY = savedKey;
  }
  await disposeWorlds();
});

/** The HttpError code an attach rejects with. */
async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).code;
  }
  throw new Error("expected the attach to be refused");
}

const attach = (body = sftp(), overrides = {}) =>
  world.manager(overrides).attach({ workspaceId: W1, ownerId: OWNER, body });

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** Polls the first fake `mount` process every 10 ms and notes when it is gone. */
function watchDeath(): { diedAt(): number | undefined; stop(): void } {
  let pid: number | undefined;
  let diedAt: number | undefined;
  const timer = setInterval(() => {
    pid ??= world.mountCalls()[0]?.pid;
    if (pid !== undefined && diedAt === undefined && !alive(pid)) {
      diedAt = Date.now();
    }
  }, 10);
  return { diedAt: () => diedAt, stop: () => clearInterval(timer) };
}

/** No row, no private directory, no mount point, nothing left in the fake mountinfo. */
function expectNoTrace(name: string): void {
  expect(world.store.list(W1)).toEqual([]);
  expect(entriesOf(world.mountsDir)).toEqual([]);
  expect(existsSync(world.mountPoint(name))).toBe(false);
  expect(readFileSync(world.mountinfo, "utf8")).toBe("");
}

describe("mountinfo parsing", () => {
  const SECTION = `m${ID1}`;
  const text = Buffer.from(
    [
      "22 1 0:21 / /proc rw,nosuid shared:5 - proc proc rw",
      `40 22 0:50 / /srv/ws\\040root/远端 rw,nosuid - fuse.rclone ${SECTION}:/srv/my\\040data rw,user_id=0`,
      `41 22 0:51 / /tmp/race.alt rw shared:7 master:3 - fuse.rclone ${SECTION}{abcde}:share rw`,
      `42 22 0:52 / /tmp/back\\134slash rw - fuse.rclone ${SECTION}x:other rw`,
      `43 22 0:53 / /tmp/not-rclone rw - fuse ${SECTION}:/x rw`,
      "garbage line without separator",
      "",
    ].join("\n"),
    "utf8",
  );

  it("decodes the mount point and source octal escapes past any number of optional fields", () => {
    expect(parseMountinfo(text)).toEqual([
      { mountPoint: "/proc", fstype: "proc", source: "proc" },
      { mountPoint: "/srv/ws root/远端", fstype: "fuse.rclone", source: `${SECTION}:/srv/my data` },
      { mountPoint: "/tmp/race.alt", fstype: "fuse.rclone", source: `${SECTION}{abcde}:share` },
      { mountPoint: "/tmp/back\\slash", fstype: "fuse.rclone", source: `${SECTION}x:other` },
      { mountPoint: "/tmp/not-rclone", fstype: "fuse", source: `${SECTION}:/x` },
    ]);
  });

  it("a section's mounts are fuse.rclone lines whose source starts `<section>:` or `<section>{`", () => {
    expect(sectionMounts(parseMountinfo(text), SECTION).map((entry) => entry.mountPoint)).toEqual([
      "/srv/ws root/远端",
      "/tmp/race.alt",
    ]);
  });
});

describe("挂载凭证文件「文件形状与权限」", () => {
  it("a password sftp mount: <id>/ 0700, rclone.conf 0600 with the obscured pass, cache/ 0700, rclone.log 0600", {
    timeout: CASE_MS,
  }, async () => {
    const record = await attach(sftp("/srv/data", { port: 2222 }));

    expect(record).toMatchObject({ id: ID1, workspaceId: W1, name: "remote", host: "files.intra" });
    const dir = world.privateDir(ID1);
    expect(modeOf(world.mountsDir)).toBe(0o700);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).uid).toBe(process.geteuid?.());
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "rclone.conf"))).toBe(0o600);
    expect(modeOf(join(dir, "cache"))).toBe(0o700);
    expect(modeOf(join(dir, "rclone.log"))).toBe(0o600);
    expect(readFileSync(join(dir, "rclone.conf"), "utf8")).toBe(
      [
        `[m${ID1}]`,
        "type = sftp",
        "host = 10.0.0.7",
        "port = 2222",
        `user = \`${USER_SENTINEL}\``,
        `pass = ${obscured(PASS_SENTINEL)}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(dir, "rclone.conf"), "utf8")).not.toContain(PASS_SENTINEL);
    expect(world.mountCalls()).toHaveLength(1);
    expect(world.mountCalls()[0]?.logMode).toBe(0o600);
  });

  it("a private-key sftp mount: key_pem is the key on one line, no obscure call", {
    timeout: CASE_MS,
  }, async () => {
    await attach(sftpKey());

    const conf = readFileSync(join(world.privateDir(ID1), "rclone.conf"), "utf8");
    expect(conf).toContain(
      `key_pem = -----BEGIN TEST FIXTURE-----\\n${KEY_SENTINEL}-a\\n${KEY_SENTINEL}-b\\n-----END TEST FIXTURE-----\\n\n`,
    );
    expect(conf.split("\n").filter((line) => line.includes(KEY_SENTINEL))).toHaveLength(1);
    expect(world.calls().map((call) => call.argv[1])).toEqual(["mount"]);
  });

  it("an existing <id>/ at 0755 and rclone.log at 0644 are corrected before the spawn", {
    timeout: CASE_MS,
  }, async () => {
    const dir = world.privateDir(ID1);
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "rclone.log"), "old line\n", { mode: 0o644 });
    chmodSync(join(dir, "rclone.log"), 0o644);

    await attach();

    expect(modeOf(dir)).toBe(0o700);
    expect(world.mountCalls()[0]?.logMode).toBe(0o600);
    expect(readFileSync(join(dir, "rclone.log"), "utf8")).toBe("old line\n");
  });

  it("<id> standing as a symlink is refused before any credential is written or anything spawned", {
    timeout: CASE_MS,
  }, async () => {
    const elsewhere = join(world.base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, world.privateDir(ID1));

    expect(await codeOf(attach())).toBe("mount_failed");

    expect(world.calls()).toEqual([]);
    expect(entriesOf(elsewhere)).toEqual([]);
    expect(readlinkSync(world.privateDir(ID1))).toBe(elsewhere);
  });
});

describe("挂载凭证文件「凭证不外泄」", () => {
  it("the password reaches only obscure's stdin; no sentinel in any argv, environment or error record", {
    timeout: CASE_MS,
  }, async () => {
    await attach();
    await world.manager().attach({ workspaceId: W1, ownerId: OWNER, body: sftpKey() });

    const calls = world.calls();
    expect(calls.map((call) => call.argv[1])).toEqual(["obscure", "mount", "mount"]);
    expect(calls[0]?.stdin).toBe(PASS_SENTINEL);
    for (const call of calls) {
      const exposed = JSON.stringify([call.argv, call.env]);
      for (const sentinel of SENTINELS) {
        expect(exposed).not.toContain(sentinel);
      }
    }
    for (const call of world.mountCalls()) {
      expect(call.stdin).toBe("");
      const conf = join(String(call.env.HOME), "rclone.conf");
      expect(call.argv.filter((arg) => arg.includes("rclone.conf"))).toEqual([conf]);
      expect(call.argv[call.argv.indexOf("--config") + 1]).toBe(conf);
    }
    expect(world.errors).toEqual([]);
  });
});

describe("挂载进程与挂载点「argv 与环境」", () => {
  const OMP_UID = 10002;

  it("OMP_USER: a read-only smb and a writable local mount get exactly the spec's argv, env {PATH, HOME}", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager({ ompUid: OMP_UID });
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: smb("/share/product", true) });
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: local("本机", false) });

    const gid = String(statSync(world.root).gid);
    const tail = (id: string) => {
      const dir = world.privateDir(id);
      return [
        "--config",
        join(dir, "rclone.conf"),
        "--cache-dir",
        join(dir, "cache"),
        "--log-file",
        join(dir, "rclone.log"),
        "--log-level",
        "NOTICE",
        "--allow-non-empty",
      ];
    };
    const ompFlags = [
      "--allow-other",
      "--default-permissions",
      "--uid",
      "10002",
      "--gid",
      gid,
      "--umask",
      "007",
    ];
    const [smbCall, localCall] = world.mountCalls();
    expect(smbCall?.argv).toEqual([
      FAKE_RCLONE,
      "mount",
      `m${ID1}:share/product`,
      world.mountPoint("共享盘"),
      ...tail(ID1),
      "--read-only",
      ...ompFlags,
    ]);
    expect(localCall?.argv).toEqual([
      FAKE_RCLONE,
      "mount",
      `m${ID2}:${world.source}`,
      world.mountPoint("本机"),
      ...tail(ID2),
      "--vfs-cache-mode",
      "writes",
      "--vfs-write-back",
      "0s",
      ...ompFlags,
    ]);
    expect(smbCall && childEnv(smbCall)).toEqual({ PATH: world.bin, HOME: world.privateDir(ID1) });
    expect(localCall && childEnv(localCall)).toEqual({
      PATH: world.bin,
      HOME: world.privateDir(ID2),
    });
    const smbConf = readFileSync(join(world.privateDir(ID1), "rclone.conf"), "utf8");
    expect(smbConf.split("\n").slice(0, 3)).toEqual([`[m${ID1}]`, "type = smb", "host = 10.0.0.7"]);
    expect(readFileSync(join(world.privateDir(ID2), "rclone.conf"), "utf8")).toBe(
      `[m${ID2}]\ntype = local\n`,
    );
  });

  it("without OMP_USER the five sharing flags are absent; no backend override flag ever appears", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager();
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: smb("/share/product", true) });
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: local("本机", false) });
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: sftp() });

    const calls = world.mountCalls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      for (const flag of ["--allow-other", "--default-permissions", "--uid", "--gid", "--umask"]) {
        expect(call.argv).not.toContain(flag);
      }
      expect(call.argv.filter((arg) => /^--[a-z]+-host$/u.test(arg))).toEqual([]);
    }
    expect(calls[2]?.argv.slice(-4)).toEqual([
      "--vfs-cache-mode",
      "writes",
      "--vfs-write-back",
      "0s",
    ]);
  });
});

describe("挂载进程与挂载点「就绪失败不留痕」", () => {
  it("rclone exiting non-zero before any mountinfo line: mount_failed, no trace", {
    timeout: CASE_MS,
  }, async () => {
    expect(await codeOf(attach(sftp("/srv/data@exit1")))).toBe("mount_failed");

    expectNoTrace("remote");
    expect(world.fusermountCalls()).toEqual([]);
  });

  it("rclone neither mounting nor exiting (window 1 s): mount_failed, the process is gone, no trace", {
    timeout: CASE_MS,
  }, async () => {
    const started = Date.now();
    expect(await codeOf(attach(sftp("/srv/data@hang"), { readyTimeoutMs: 1000 }))).toBe(
      "mount_failed",
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    const [call] = world.mountCalls();
    expect(alive(Number(call?.pid))).toBe(false);
    expectNoTrace("remote");
  });

  for (const [marker, source] of [
    ["elsewhere", `m${ID1}:`],
    ["elsewhere-suffix", `m${ID1}{abcde}:`],
  ] as const) {
    it(`the mount landing elsewhere with source ${source}…: fails within 1 s, one -uz on that path`, {
      timeout: CASE_MS,
    }, async () => {
      const death = watchDeath();
      expect(await codeOf(attach(sftp(`/srv/data@${marker}`)))).toBe("mount_failed");
      death.stop();

      // The window is still 20 s: from the fake's start to its death (the manager's decision and
      // SIGKILL), not counting the cleanup's own fake fusermount3 process start.
      const [call] = world.mountCalls();
      expect(Number(death.diedAt()) - Number(call?.at)).toBeLessThan(1000);
      expect(alive(Number(call?.pid))).toBe(false);
      expect(world.fusermountCalls()).toEqual([
        { argv: ["-uz", `${world.mountPoint("remote")}.alt`], removed: 1 },
      ]);
      expectNoTrace("remote");
    });
  }

  it("the readiness readdir failing: one -uz on the mount point, the process is gone, no trace", {
    timeout: CASE_MS,
  }, async () => {
    const probes: unknown[][] = [];
    const probeExec = async (...args: unknown[]) => {
      probes.push(args);
      return false;
    };

    expect(await codeOf(attach(sftp(), { probeExec }))).toBe("mount_failed");

    expect(probes).toHaveLength(1);
    expect(probes[0]?.slice(0, 2)).toEqual(["readdir", world.mountPoint("remote")]);
    expect(Number(probes[0]?.[2])).toBeLessThanOrEqual(20_000);
    expect(Number(probes[0]?.[2])).toBeGreaterThan(15_000);
    const [call] = world.mountCalls();
    expect(alive(Number(call?.pid))).toBe(false);
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expectNoTrace("remote");
  });

  it("the row insert failing after readiness: unmounted and removed, the insert's error rethrown", {
    timeout: CASE_MS,
  }, async () => {
    const failure = new Error("insert failed");
    const attempt = world
      .manager()
      .attach({ workspaceId: W1, ownerId: OWNER, body: sftp() }, () => {
        throw failure;
      });

    await expect(attempt).rejects.toBe(failure);
    const [call] = world.mountCalls();
    expect(alive(Number(call?.pid))).toBe(false);
    expect(world.fusermountCalls()).toHaveLength(1);
    expectNoTrace("remote");
  });
});

describe("挂载进程与挂载点「挂载点被换掉即拒绝」(attach side)", () => {
  it("a missing mount point is built by ensureSharedDir, then checked", {
    timeout: CASE_MS,
  }, async () => {
    await attach();

    expect(world.sharedDirCalls).toEqual([world.mountPoint("remote")]);
    expect(lstatSync(world.mountPoint("remote")).isDirectory()).toBe(true);
  });

  it("a mount point that is a symlink to a directory elsewhere: lstat refuses it, no ensureSharedDir, no spawn", {
    timeout: CASE_MS,
  }, async () => {
    const outside = join(world.base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, world.mountPoint("remote"));

    expect(await codeOf(attach())).toBe("mount_failed");

    expect(world.sharedDirCalls).toEqual([]);
    expect(world.mountCalls()).toEqual([]);
    expect(entriesOf(outside)).toEqual([]);
    expect(readlinkSync(world.mountPoint("remote"))).toBe(outside);
    expect(entriesOf(world.mountsDir)).toEqual([]);
    expect(world.store.list(W1)).toEqual([]);
  });

  it("a mount point that is a regular file: refused, the file kept, no spawn", {
    timeout: CASE_MS,
  }, async () => {
    writeFileSync(world.mountPoint("remote"), "kept\n");

    expect(await codeOf(attach())).toBe("mount_failed");

    expect(world.mountCalls()).toEqual([]);
    expect(readFileSync(world.mountPoint("remote"), "utf8")).toBe("kept\n");
    expect(entriesOf(world.mountsDir)).toEqual([]);
  });
});

describe("挂载取值与主机规则 (manager layer)", () => {
  const LOOPBACK = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "LOCALHOST.",
    "a.localhost",
    "a.localhost.",
    "127.0.0.1",
    "127.9.9.9",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
    "2130706433",
    "loop.intra",
  ];

  it("环回一律拒绝: every loopback host is mount_host_rejected with nothing created or spawned", {
    timeout: CASE_MS,
  }, async () => {
    for (const host of LOOPBACK) {
      expect(await codeOf(attach(sftp("/srv/data", { host })))).toBe("mount_host_rejected");
    }

    expect(world.calls()).toEqual([]);
    expectNoTrace("remote");
  });

  it("解析失败不启动子进程: an unresolvable host is mount_failed with nothing created or spawned", async () => {
    expect(await codeOf(attach(sftp("/srv/data", { host: "nowhere.intra" })))).toBe("mount_failed");

    expect(world.calls()).toEqual([]);
    expectNoTrace("remote");
  });

  it("许可名单: FILES.INTRA and files.intra. pass files.intra; other.intra is rejected", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ mountHostAllow: ["files.intra"] });
    const body = (name: string, host: string) => sftp("/srv/data", { name, host });

    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: body("upper", "FILES.INTRA") });
    await manager.attach({ workspaceId: W1, ownerId: OWNER, body: body("dotted", "files.intra.") });
    expect(
      await codeOf(
        manager.attach({ workspaceId: W1, ownerId: OWNER, body: body("other", "other.intra") }),
      ),
    ).toBe("mount_host_rejected");

    expect(world.store.list(W1).map((mount) => mount.name)).toEqual(["upper", "dotted"]);
    expect(world.mountCalls()).toHaveLength(2);
  });

  it("at most two host judgements are in flight; the third waits for a slot", {
    timeout: CASE_MS,
  }, async () => {
    const pending: { host: string; fail: (error: Error) => void }[] = [];
    const resolveHost: HostResolver = (host) =>
      new Promise((_, fail) => {
        pending.push({ host, fail });
      });
    const manager = world.manager({ resolveHost });
    const attempts = ["a", "b", "c"].map((name) =>
      manager.attach({
        workspaceId: W1,
        ownerId: OWNER,
        body: sftp("/srv/data", { name, host: `${name}.intra` }),
      }),
    );
    const settled = attempts.map((attempt) => codeOf(attempt));

    await new Promise((settle) => setTimeout(settle, 50));
    expect(pending.map((call) => call.host)).toEqual(["a.intra", "b.intra"]);
    pending[0]?.fail(new Error("ENOTFOUND"));
    await new Promise((settle) => setTimeout(settle, 50));
    expect(pending.map((call) => call.host)).toEqual(["a.intra", "b.intra", "c.intra"]);
    pending[1]?.fail(new Error("ENOTFOUND"));
    pending[2]?.fail(new Error("ENOTFOUND"));

    expect(await Promise.all(settled)).toEqual(["mount_failed", "mount_failed", "mount_failed"]);
    expect(world.calls()).toEqual([]);
  });
});

describe("local 挂载源复核", () => {
  it("a source replaced by a symlink to the sandbox root: mount_failed, no spawn, no trace", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    rmSync(world.source, { recursive: true });
    symlinkSync(world.sandbox, world.source);

    expect(await codeOf(attach(local()))).toBe("mount_failed");

    expect(world.calls()).toEqual([]);
    expectNoTrace("本机");
  });

  it("a source gone, or registered inside a protected root: mount_failed, no spawn", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world, join(world.state, "inside"));
    mkdirSync(join(world.state, "inside"));
    expect(await codeOf(attach(local()))).toBe("mount_failed");
    rmSync(join(world.state, "inside"), { recursive: true });
    expect(await codeOf(attach(local()))).toBe("mount_failed");

    expect(world.calls()).toEqual([]);
    expectNoTrace("本机");
  });

  it("an unregistered source is not_found", async () => {
    expect(await codeOf(attach(local()))).toBe("not_found");
    expect(world.calls()).toEqual([]);
  });
});
