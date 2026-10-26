/**
 * s1b-workspace-mounts group 5 (rclone-conf part, #1685): the per-mount credential file (design D5 file
 * part, D6; workspace-mounts「挂载凭证文件」file shape, obscure path, and the conf part of「重挂改写主机」).
 * `obscure -` runs the real-spawned fake rclone (`fixtures/fake-rclone.mjs`), whose output formula is
 * recomputed here, not read back. Every credential is a sentinel asserted absent from the file (except
 * where it belongs), argv, environment and error messages. The private `<id>/` directory is the
 * manager's (D5) and is pre-created here at 0700; this module only writes inside it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewriteHost, writeRcloneConf } from "../src/workspaces/mounts/rclone-conf.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";

const FAKE_RCLONE = fileURLToPath(new URL("./fixtures/fake-rclone.mjs", import.meta.url));
const MOUNT_ID = "0123456789abcdef0123456789abcdef";
const SECTION = `[m${MOUNT_ID}]`;
const PASS_SENTINEL = "pass-sentinel-1685";
const USER = "user-sentinel-1685";
const KEY =
  "-----BEGIN TEST FIXTURE-----\nkey-sentinel-1685-a\nkey-sentinel-1685-b\n-----END TEST FIXTURE-----\n";
const PARENT_ONLY = "parent-env-sentinel-1685";
const SENTINELS = [PASS_SENTINEL, USER, "key-sentinel-1685", PARENT_ONLY];

let state: string;
let dir: string;
let savedKey: string | undefined;

/** The fake's documented output, computed independently of it. */
function obscured(password: string): string {
  return Buffer.from(`obscured:${password}`).toString("base64url");
}

function confPath(): string {
  return join(dir, "rclone.conf");
}

function conf(): string {
  return readFileSync(confPath(), "utf8");
}

interface Call {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  pid: number;
}

function calls(): Call[] {
  const file = join(state, "fake-rclone-calls.jsonl");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
}

function target(overrides: { rcloneBin?: string; obscureTimeoutMs?: number } = {}) {
  return { rcloneBin: FAKE_RCLONE, dir, mountId: MOUNT_ID, ...overrides };
}

const remote = { name: "remote", remotePath: "/srv/data", readOnly: false } as const;

function sftpPassword(extra: Partial<{ port: number; password: string }> = {}): MountBody {
  return {
    ...remote,
    backend: "sftp",
    host: "files.intra",
    username: USER,
    password: PASS_SENTINEL,
    ...extra,
  };
}

function sftpKey(username = USER): MountBody {
  return { ...remote, backend: "sftp", host: "files.intra", username, privateKey: KEY };
}

/** The file exists alone in `<id>/`, as a regular file at exactly 0600. */
function expectSoleConfAt0600(): void {
  expect(readdirSync(dir)).toEqual(["rclone.conf"]);
  const stats = lstatSync(confPath());
  expect(stats.isFile()).toBe(true);
  expect(stats.mode & 0o7777).toBe(0o600);
}

/** The rejection's message and cause as one string; a write that succeeded is a test failure. */
async function refusalOf(write: Promise<void>): Promise<string> {
  try {
    await write;
  } catch (error) {
    return `${(error as Error).message} ${String((error as Error).cause)}`;
  }
  throw new Error("expected the write to be refused");
}

function expectNoSentinel(text: string): void {
  for (const sentinel of SENTINELS) {
    expect(text).not.toContain(sentinel);
  }
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "mounts-rclone-conf-"));
  mkdirSync(join(state, "mounts"), { mode: 0o700 });
  dir = join(state, "mounts", MOUNT_ID);
  mkdirSync(dir, { mode: 0o700 });
  savedKey = process.env.MODEL_UPSTREAM_API_KEY;
  process.env.MODEL_UPSTREAM_API_KEY = PARENT_ONLY;
});

afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.MODEL_UPSTREAM_API_KEY;
  } else {
    process.env.MODEL_UPSTREAM_API_KEY = savedKey;
  }
  rmSync(state, { recursive: true, force: true });
});

describe("file shape per backend", () => {
  it("sftp with a password: section m<id>, judged host, port, wrapped user, obscured pass", async () => {
    await writeRcloneConf(target(), sftpPassword({ port: 2222 }), "10.0.0.7");
    expect(conf()).toBe(
      [
        SECTION,
        "type = sftp",
        "host = 10.0.0.7",
        "port = 2222",
        `user = \`${USER}\``,
        `pass = ${obscured(PASS_SENTINEL)}`,
        "",
      ].join("\n"),
    );
    expect(conf()).not.toContain(PASS_SENTINEL);
    expect(conf()).not.toContain("files.intra");
    expectSoleConfAt0600();
  });

  it("sftp without a port writes no port line", async () => {
    await writeRcloneConf(target(), sftpPassword(), "10.0.0.7");
    expect(conf()).toBe(
      [
        SECTION,
        "type = sftp",
        "host = 10.0.0.7",
        `user = \`${USER}\``,
        `pass = ${obscured(PASS_SENTINEL)}`,
        "",
      ].join("\n"),
    );
  });

  it("sftp with a private key: key_pem on one line with literal \\n, no obscure call", async () => {
    await writeRcloneConf(target(), sftpKey(), "10.0.0.7");
    expect(conf()).toBe(
      [
        SECTION,
        "type = sftp",
        "host = 10.0.0.7",
        `user = \`${USER}\``,
        "key_pem = -----BEGIN TEST FIXTURE-----\\nkey-sentinel-1685-a\\nkey-sentinel-1685-b\\n-----END TEST FIXTURE-----\\n",
        "",
      ].join("\n"),
    );
    expect(conf().split("\n")).toHaveLength(6);
    expect(calls()).toEqual([]);
    expectSoleConfAt0600();
  });

  it("smb with port and domain", async () => {
    const mount: MountBody = {
      ...remote,
      remotePath: "/share/product",
      backend: "smb",
      host: "files.intra",
      port: 4450,
      username: USER,
      password: PASS_SENTINEL,
      domain: "CORP.intra-1_x",
    };
    await writeRcloneConf(target(), mount, "10.0.0.8");
    expect(conf()).toBe(
      [
        SECTION,
        "type = smb",
        "host = 10.0.0.8",
        "port = 4450",
        `user = \`${USER}\``,
        `pass = ${obscured(PASS_SENTINEL)}`,
        "domain = CORP.intra-1_x",
        "",
      ].join("\n"),
    );
    expectSoleConfAt0600();
  });

  it("smb without port and domain", async () => {
    const mount: MountBody = {
      ...remote,
      remotePath: "/share",
      backend: "smb",
      host: "files.intra",
      username: USER,
      password: PASS_SENTINEL,
    };
    await writeRcloneConf(target(), mount, "fd00::8");
    expect(conf()).toBe(
      [
        SECTION,
        "type = smb",
        "host = [fd00::8]",
        `user = \`${USER}\``,
        `pass = ${obscured(PASS_SENTINEL)}`,
        "",
      ].join("\n"),
    );
  });

  it("local has only the type, and no obscure call", async () => {
    const mount: MountBody = {
      name: "nfs",
      backend: "local",
      sourceId: "f".repeat(32),
      readOnly: true,
    };
    await writeRcloneConf(target(), mount);
    expect(conf()).toBe(`${SECTION}\ntype = local\n`);
    expect(calls()).toEqual([]);
    expectSoleConfAt0600();
  });
});

describe("user quoting (rclone v1.60.1 `config dump`, #1685 comment 2026-10-25)", () => {
  const tricky = [
    "alice",
    "`tick`",
    "a`b",
    "`",
    "ab`",
    "`ab",
    "``",
    "a```b",
    '"""tri',
    "a\u0085",
    "\u0085a",
    '"quoted"',
    "'single'",
    "a # b",
    ";x",
    "a  b",
    "张三",
  ];

  it.each(tricky)("%j is written backtick-wrapped, verbatim", async (username) => {
    await writeRcloneConf(target(), sftpKey(username), "10.0.0.7");
    const lines = conf().split("\n");
    expect(lines[3]).toBe(`user = \`${username}\``);
    expect(lines.filter((line) => line.startsWith("user = "))).toHaveLength(1);
  });
});

describe("obscure via standard input", () => {
  it("the password reaches the fake only on stdin; argv and env carry no credential", async () => {
    await writeRcloneConf(target(), sftpPassword(), "10.0.0.7");
    const recorded = calls();
    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call?.stdin).toBe(PASS_SENTINEL);
    expect(call?.argv).toEqual([FAKE_RCLONE, "obscure", "-"]);
    // macOS injects `__CF_USER_TEXT_ENCODING` into every new process; it is not passed by the caller.
    const keys = Object.keys(call?.env ?? {}).filter((key) => key !== "__CF_USER_TEXT_ENCODING");
    expect(keys.sort()).toEqual(["HOME", "PATH"]);
    expect(call?.env.HOME).toBe(dir);
    expect(call?.env.PATH).toBe(process.env.PATH);
    const exposed = JSON.stringify({ argv: call?.argv, env: call?.env });
    expectNoSentinel(exposed);
    expect(exposed).not.toContain(obscured(PASS_SENTINEL));
  });

  const failures: [string, string][] = [
    ["a non-zero exit", "@exit3"],
    ["an exit 0 with no output", "@empty"],
    ["output outside the obscure alphabet", "@garbage"],
  ];

  it.each(failures)(
    "%s fails the write, leaves nothing, names no credential",
    async (_, marker) => {
      const password = `${PASS_SENTINEL}${marker}`;
      const failure = writeRcloneConf(target(), sftpPassword({ password }), "10.0.0.7");
      await expect(failure).rejects.toThrow(/rclone obscure/u);
      const message = await refusalOf(failure);
      expectNoSentinel(message);
      expect(readdirSync(dir)).toEqual([]);
      expect(calls().map((call) => call.stdin)).toEqual([password]);
    },
  );

  it("a hanging obscure is killed at the deadline and fails the write", async () => {
    const started = Date.now();
    const failure = writeRcloneConf(
      target({ obscureTimeoutMs: 1_500 }),
      sftpPassword({ password: `${PASS_SENTINEL}@hang` }),
      "10.0.0.7",
    );
    await expect(failure).rejects.toThrow(/rclone obscure timed out/u);
    expect(Date.now() - started).toBeLessThan(5_000);
    const message = await refusalOf(failure);
    expectNoSentinel(message);
    expect(readdirSync(dir)).toEqual([]);
    const [call] = calls();
    expect(call).toBeDefined();
    expect(() => process.kill(call?.pid ?? 0, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("a missing rclone binary fails the write without a credential in the message", async () => {
    const failure = writeRcloneConf(
      target({ rcloneBin: join(state, "no-such-rclone") }),
      sftpPassword(),
      "10.0.0.7",
    );
    await expect(failure).rejects.toThrow(/rclone obscure/u);
    const message = await refusalOf(failure);
    expectNoSentinel(message);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("temp name and rename", () => {
  it("an existing wider file is replaced by a new inode at 0600", async () => {
    writeFileSync(confPath(), "stale\n", { mode: 0o644 });
    const before = statSync(confPath()).ino;
    await writeRcloneConf(target(), sftpKey(), "10.0.0.7");
    expect(statSync(confPath()).ino).not.toBe(before);
    expect(conf().startsWith(`${SECTION}\n`)).toBe(true);
    expectSoleConfAt0600();
  });

  it("a symlink at the name is replaced, never written through", async () => {
    const elsewhere = join(state, "elsewhere");
    writeFileSync(elsewhere, "untouched\n", { mode: 0o644 });
    symlinkSync(elsewhere, confPath());
    await writeRcloneConf(target(), sftpKey(), "10.0.0.7");
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
    expectSoleConfAt0600();
  });
});

describe("IPv6 hosts are bracketed (rclone v1.60.1 dials host:port unbracketed)", () => {
  const cases: [string, string][] = [
    ["10.0.0.7", "host = 10.0.0.7"],
    ["fd00::1", "host = [fd00::1]"],
    ["fe80::1:2:3:4", "host = [fe80::1:2:3:4]"],
    ["::ffff:10.0.0.7", "host = [::ffff:10.0.0.7]"],
  ];

  it.each(cases)("writeRcloneConf writes %s as %j", async (address, line) => {
    await writeRcloneConf(target(), sftpKey(), address);
    expect(conf().split("\n")[2]).toBe(line);
    expectSoleConfAt0600();
  });

  it.each(cases)("rewriteHost writes %s as %j, other bytes unchanged", async (address, line) => {
    await writeRcloneConf(target(), sftpPassword({ port: 2222 }), "fd00::7");
    const before = conf();
    expect(before).toContain("\nhost = [fd00::7]\n");
    await rewriteHost(dir, address);
    expect(conf()).toBe(before.replace("\nhost = [fd00::7]\n", `\n${line}\n`));
    expectSoleConfAt0600();
  });

  it("an already bracketed address is not an IP literal and is refused", async () => {
    await expect(writeRcloneConf(target(), sftpKey(), "[fd00::1]")).rejects.toThrow(/IP literal/u);
    await writeRcloneConf(target(), sftpKey(), "10.0.0.7");
    const before = conf();
    await expect(rewriteHost(dir, "[fd00::1]")).rejects.toThrow(/IP literal/u);
    expect(conf()).toBe(before);
  });
});

describe("rewriteHost", () => {
  it("replaces only the host value, by a new inode at 0600, without obscure", async () => {
    await writeRcloneConf(target(), sftpPassword({ port: 2222 }), "10.0.0.7");
    const before = conf();
    const inode = statSync(confPath()).ino;
    await rewriteHost(dir, "10.0.0.8");
    expect(conf()).toBe(before.replace("\nhost = 10.0.0.7\n", "\nhost = 10.0.0.8\n"));
    expect(conf()).not.toBe(before);
    expect(statSync(confPath()).ino).not.toBe(inode);
    expectSoleConfAt0600();
    expect(calls()).toHaveLength(1);
  });

  it("keeps every other byte, including a user line that mentions host", async () => {
    await writeRcloneConf(target(), sftpKey("host = 10.0.0.7"), "10.0.0.7");
    const before = conf();
    await rewriteHost(dir, "fd00::9");
    const expected = before.replace("\nhost = 10.0.0.7\n", "\nhost = [fd00::9]\n");
    expect(conf()).toBe(expected);
    expect(conf()).toContain("user = `host = 10.0.0.7`");
  });

  it("rewrites an smb file the same way", async () => {
    const mount: MountBody = {
      ...remote,
      remotePath: "/share",
      backend: "smb",
      host: "files.intra",
      username: USER,
      password: PASS_SENTINEL,
      domain: "CORP",
    };
    await writeRcloneConf(target(), mount, "10.0.0.7");
    const before = conf();
    await rewriteHost(dir, "10.0.0.9");
    expect(conf()).toBe(before.replace("\nhost = 10.0.0.7\n", "\nhost = 10.0.0.9\n"));
    expectSoleConfAt0600();
  });

  it("a local file has no host: refused, bytes unchanged, no residue", async () => {
    await writeRcloneConf(
      target(),
      { name: "nfs", backend: "local", sourceId: "f".repeat(32), readOnly: false },
      undefined,
    );
    const before = conf();
    await expect(rewriteHost(dir, "10.0.0.8")).rejects.toThrow(/host line/u);
    expect(conf()).toBe(before);
    expectSoleConfAt0600();
  });

  it("a host that is not an IP literal is refused before touching the file", async () => {
    await writeRcloneConf(target(), sftpKey(), "10.0.0.7");
    const before = conf();
    const inode = statSync(confPath()).ino;
    await expect(rewriteHost(dir, "files.intra")).rejects.toThrow(/IP literal/u);
    expect(conf()).toBe(before);
    expect(statSync(confPath()).ino).toBe(inode);
  });

  it("a missing file is refused", async () => {
    await expect(rewriteHost(dir, "10.0.0.8")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("refused inputs", () => {
  it("a mount id that is not 32 lowercase hex never becomes a section", async () => {
    for (const mountId of ["0123456789ABCDEF0123456789ABCDEF", "x]\n[y", ""]) {
      await expect(
        writeRcloneConf({ ...target(), mountId }, sftpKey(), "10.0.0.7"),
      ).rejects.toThrow(/mount id/u);
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(calls()).toEqual([]);
  });

  it("sftp and smb need a judged IP literal; local takes none", async () => {
    const attempts = [
      () => writeRcloneConf(target(), sftpPassword(), undefined),
      () => writeRcloneConf(target(), sftpPassword(), "files.intra"),
      () =>
        writeRcloneConf(
          target(),
          { name: "nfs", backend: "local", sourceId: "f".repeat(32), readOnly: false },
          "10.0.0.7",
        ),
    ];
    for (const attempt of attempts) {
      const failure = attempt();
      await expect(failure).rejects.toThrow(/host/u);
      expectNoSentinel(await refusalOf(failure));
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(calls()).toEqual([]);
  });

  it("a username with a line break is refused without echoing it", async () => {
    const failure = writeRcloneConf(target(), sftpKey(`${USER}\nhost = 127.0.0.1`), "10.0.0.7");
    await expect(failure).rejects.toThrow(/user/u);
    expectNoSentinel(await refusalOf(failure));
    expect(readdirSync(dir)).toEqual([]);
  });
});
