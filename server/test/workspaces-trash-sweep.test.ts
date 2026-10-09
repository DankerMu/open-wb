import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { createTrash } from "../src/workspaces/trash.js";
import { removeTempDirs, tempDir, withOpenDb } from "./core-db-helpers.js";

// Literals on purpose: the day length and the batch-name shape come from the spec
// (file-operations「回收目录的保留与清理」), not from the module under test.
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const SUFFIX = "0123456789abcdef";
const WS = "a".repeat(32);
const OTHER_WS = "b".repeat(32);
const EXPIRED = `${NOW - 31 * DAY}-${SUFFIX}`;
const FRESH = `${NOW - 29 * DAY}-${SUFFIX}`;
const PRIVATE_MODE = 0o700;
/** The same hash string the seed and `workspace-store.test.ts` carry; no new secret-looking text. */
const ACCOUNT_HASH =
  "scrypt$16384$8$1$b597609e46e3097e0b96fa7204254a63$4cccb4d61b561586fbc223f086dfe899ef43771b43864b0632e8a7e66a5046b8";

/** Directories a case made unreadable or unwritable; reopened before the temp dirs are removed. */
const locked: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of locked.splice(0)) {
    chmodSync(dir, PRIVATE_MODE);
  }
  removeTempDirs();
});

describe("trash sweep: 到期的批次被清除", () => {
  it("removes only the expired batch directory and follows no symlink at any level", async () => {
    const { sandboxRoot, trash } = openTrash();
    const ws = privateDirs(trash, "u1", WS);
    const expired = batch(ws, EXPIRED);
    const fresh = batch(ws, FRESH);
    mkdirSync(join(ws, "keep-me"), PRIVATE_MODE);
    writeFileSync(join(ws, "keep-me", "note.txt"), "kept");
    // Near misses of the batch name, all carrying an expired timestamp.
    const nearMisses = [
      `${NOW - 31 * DAY}-zz`,
      `${NOW - 31 * DAY}-0123456789abcde`,
      `${NOW - 31 * DAY}-0123456789abcdef0`,
      // Its own timestamp: on a case-insensitive file system it would collide with EXPIRED.
      `${NOW - 34 * DAY}-0123456789ABCDEF`,
      `x${EXPIRED}`,
      `${EXPIRED}x`,
      `-${SUFFIX}`,
    ];
    for (const name of nearMisses) {
      batch(ws, name);
    }
    // A well-formed, expired name that is a regular file, and one that is a symlink.
    const fileBatch = `${NOW - 32 * DAY}-${SUFFIX}`;
    writeFileSync(join(ws, fileBatch), "a file, not a batch");
    const outside = realpathSync(tempDir());
    const linkedPlain = fill(join(outside, "plain"));
    const linkedBatch = fill(join(outside, "batch"));
    const linkedWs = privateDirs(outside, "ws");
    batch(linkedWs, EXPIRED);
    const linkedOwner = privateDirs(outside, "owner");
    batch(privateDirs(linkedOwner, WS), EXPIRED);
    const linkBatch = `${NOW - 33 * DAY}-${SUFFIX}`;
    symlinkSync(linkedPlain, join(ws, "outside-link"));
    symlinkSync(linkedBatch, join(ws, linkBatch));
    symlinkSync(linkedWs, join(trash, "u1", "linked-ws"));
    symlinkSync(linkedOwner, join(trash, "linked-owner"));
    // A link inside the expired batch goes with it; what it points at does not.
    symlinkSync(linkedPlain, join(expired, "inner-link"));
    // A second owner and a second workspace: every sibling is visited.
    const otherExpired = batch(privateDirs(trash, "u2", OTHER_WS), EXPIRED);
    const siblingExpired = batch(privateDirs(trash, "u1", OTHER_WS), EXPIRED);
    // The sweep reads the name, not the mtime: both are set the wrong way round.
    setMtime(expired, NOW);
    setMtime(fresh, NOW - 40 * DAY);
    const outsideBefore = snapshot(outside);
    const freshBefore = snapshot(fresh);

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    // 链接目标内容不变: every target tree is byte-identical, and every link is still a link.
    expect(snapshot(outside)).toEqual(outsideBefore);
    expect(readlinkSync(join(ws, "outside-link"))).toBe(linkedPlain);
    expect(readlinkSync(join(ws, linkBatch))).toBe(linkedBatch);
    expect(readlinkSync(join(trash, "u1", "linked-ws"))).toBe(linkedWs);
    expect(readlinkSync(join(trash, "linked-owner"))).toBe(linkedOwner);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(otherExpired)).toBe(false);
    expect(existsSync(siblingExpired)).toBe(false);
    expect(snapshot(fresh)).toEqual(freshBefore);
    expect(readdirSync(ws).sort()).toEqual(
      [FRESH, "keep-me", ...nearMisses, fileBatch, "outside-link", linkBatch].sort(),
    );
    expect(readFileSync(join(ws, "keep-me", "note.txt"), "utf8")).toBe("kept");
    expect(readFileSync(join(ws, fileBatch), "utf8")).toBe("a file, not a batch");
    for (const name of nearMisses) {
      expect(readdirSync(join(ws, name)).sort()).toEqual(["gone.txt", "sub"]);
    }
    expect(readdirSync(sandboxRoot)).toEqual([".trash"]);
  });

  it("keeps a batch stamped exactly at the limit and removes the one a millisecond older", async () => {
    const { sandboxRoot, trash } = openTrash();
    const ws = privateDirs(trash, "u1", WS);
    const atLimit = batch(ws, `${NOW - 30 * DAY}-${SUFFIX}`);
    const justPast = batch(ws, `${NOW - 30 * DAY - 1}-${SUFFIX}`);
    // More digits than a millisecond stamp can have: read as not yet expired.
    const oversized = batch(ws, `${"9".repeat(400)}-${SUFFIX}`.slice(-250));
    const before = snapshot(atLimit);

    await sweep(sandboxRoot, 30, NOW);

    expect(snapshot(atLimit)).toEqual(before);
    expect(existsSync(justPast)).toBe(false);
    expect(existsSync(oversized)).toBe(true);
  });

  it("leaves the emptied workspace and owner directories in place", async () => {
    const { sandboxRoot, trash } = openTrash();
    const ws = privateDirs(trash, "u1", WS);
    batch(ws, EXPIRED);

    await sweep(sandboxRoot, 30, NOW);

    expect(readdirSync(ws)).toEqual([]);
    expect(lstatSync(ws).mode & 0o7777).toBe(PRIVATE_MODE);
    expect(readdirSync(join(trash, "u1"))).toEqual([WS]);
  });
});

describe("trash sweep: `.trash` 被占位", () => {
  it("does nothing when `.trash` is a symlink to a tree holding expired batches", async () => {
    const sandboxRoot = realpathSync(tempDir());
    const outside = realpathSync(tempDir());
    const planted = batch(privateDirs(outside, "u1", WS), EXPIRED);
    symlinkSync(outside, join(sandboxRoot, ".trash"));
    const before = snapshot(outside);

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    expect(existsSync(planted)).toBe(true);
    expect(snapshot(outside)).toEqual(before);
    expect(readlinkSync(join(sandboxRoot, ".trash"))).toBe(outside);
  });

  it("does nothing when `.trash` is a regular file", async () => {
    const sandboxRoot = realpathSync(tempDir());
    writeFileSync(join(sandboxRoot, ".trash"), "not a directory");

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    expect(readFileSync(join(sandboxRoot, ".trash"), "utf8")).toBe("not a directory");
    expect(readdirSync(sandboxRoot)).toEqual([".trash"]);
  });

  it("does nothing when `.trash` belongs to another uid", async () => {
    const { sandboxRoot, trash } = openTrash();
    const expired = batch(privateDirs(trash, "u1", WS), EXPIRED);
    const before = snapshot(trash);
    // No unprivileged way to chown: the process is reported as someone else instead.
    vi.spyOn(process, "geteuid").mockReturnValue(lstatSync(trash).uid + 1);

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    expect(existsSync(expired)).toBe(true);
    expect(snapshot(trash)).toEqual(before);
  });

  it("still sweeps a `.trash` whose mode is not 0700, without correcting the mode", async () => {
    const { sandboxRoot, trash } = openTrash();
    const expired = batch(privateDirs(trash, "u1", WS), EXPIRED);
    chmodSync(trash, 0o755);

    await sweep(sandboxRoot, 30, NOW);

    expect(existsSync(expired)).toBe(false);
    expect(lstatSync(trash).mode & 0o7777).toBe(0o755);
  });
});

describe("trash sweep: 临时空间删除后批次保留到期满", () => {
  // Fixture equivalent of the scenario: no DB, no workspace row and no `tmp-<T>` directory, only
  // the batch a delete would have left. The sweep takes no db, so it cannot ask about the row.
  it("keeps the batch of a workspace that no longer exists until the retention runs out", async () => {
    const { sandboxRoot, trash } = openTrash();
    const deletedAt = NOW - 100 * DAY;
    const ws = privateDirs(trash, "u1", WS);
    const kept = batch(ws, `${deletedAt}-${SUFFIX}`);
    const before = snapshot(trash);
    expect(readdirSync(sandboxRoot)).toEqual([".trash"]);

    await sweep(sandboxRoot, 30, deletedAt + 29 * DAY);

    expect(snapshot(trash)).toEqual(before);
    expect(readFileSync(join(kept, "gone.txt"), "utf8")).toBe("deleted bytes");

    await sweep(sandboxRoot, 30, deletedAt + 31 * DAY);

    expect(existsSync(kept)).toBe(false);
    expect(readdirSync(ws)).toEqual([]);
    expect(readdirSync(sandboxRoot)).toEqual([".trash"]);
  });
});

describe("trash sweep: 保留期可配置", () => {
  it("removes a two-day-old batch under a one-day retention and keeps it under thirty", async () => {
    const { sandboxRoot, trash } = openTrash();
    const twoDaysOld = batch(privateDirs(trash, "u1", WS), `${NOW - 2 * DAY}-${SUFFIX}`);
    const before = snapshot(trash);

    await sweep(sandboxRoot, 30, NOW);

    expect(snapshot(trash)).toEqual(before);

    await sweep(sandboxRoot, 1, NOW);

    expect(existsSync(twoDaysOld)).toBe(false);
  });
});

describe("trash sweep: 清理出错不外溢", () => {
  it.skipIf(process.geteuid?.() === 0)(
    "swallows a batch it cannot remove and a level it cannot read, and removes the rest",
    async () => {
      const { sandboxRoot, trash } = openTrash();
      const ws = privateDirs(trash, "u1", WS);
      // The undeletable batch sorts between two deletable ones.
      const first = batch(ws, `${NOW - 33 * DAY}-${SUFFIX}`);
      const stuck = batch(ws, `${NOW - 32 * DAY}-${SUFFIX}`);
      const last = batch(ws, EXPIRED);
      lock(join(stuck, "sub"), 0o500);
      // An owner and a workspace directory that cannot be listed, each with a readable sibling.
      const unreadableWs = privateDirs(trash, "u1", OTHER_WS);
      const hiddenByWs = batch(unreadableWs, EXPIRED);
      lock(unreadableWs, 0o000);
      const unreadableOwner = privateDirs(trash, "u0");
      const hiddenByOwner = batch(privateDirs(unreadableOwner, WS), EXPIRED);
      lock(unreadableOwner, 0o000);
      const reachable = batch(privateDirs(trash, "u2", WS), EXPIRED);

      await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

      expect(existsSync(first)).toBe(false);
      expect(existsSync(last)).toBe(false);
      expect(existsSync(reachable)).toBe(false);
      expect(readFileSync(join(stuck, "sub", "inner.txt"), "utf8")).toBe("inner bytes");
      chmodSync(unreadableWs, PRIVATE_MODE);
      chmodSync(unreadableOwner, PRIVATE_MODE);
      expect(readFileSync(join(hiddenByWs, "gone.txt"), "utf8")).toBe("deleted bytes");
      expect(readFileSync(join(hiddenByOwner, "gone.txt"), "utf8")).toBe("deleted bytes");
    },
  );

  it.skipIf(process.geteuid?.() === 0)("swallows an unreadable `.trash`", async () => {
    const { sandboxRoot, trash } = openTrash();
    const expired = batch(privateDirs(trash, "u1", WS), EXPIRED);
    lock(trash, 0o000);

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    chmodSync(trash, PRIVATE_MODE);
    expect(existsSync(expired)).toBe(true);
  });

  it("is a no-op that does not create `.trash` when it is missing", async () => {
    const sandboxRoot = realpathSync(tempDir());

    await expect(sweep(sandboxRoot, 30, NOW)).resolves.toBeUndefined();

    expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
    expect(readdirSync(sandboxRoot)).toEqual([]);
  });

  it("touches no file system when it is constructed", () => {
    const sandboxRoot = join(realpathSync(tempDir()), "absent");

    createTrash({ sandboxRoot, retentionDays: 30 });

    expect(existsSync(sandboxRoot)).toBe(false);
  });
});

// design D22: `<SANDBOX_ROOT>/.trash` can never be an account root.
describe("trash sweep: 账号 id 不以点开头", () => {
  it("seeds exactly four accounts, none with an id starting with a dot", () => {
    withOpenDb(":memory:", (db) => {
      expect(count(db, "SELECT COUNT(*) AS count FROM accounts WHERE id LIKE '.%'")).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS count FROM accounts")).toBe(4);
    });
  });

  it("refuses an account whose id is `.trash` as a workspace owner, creating nothing", () => {
    const sandboxRoot = realpathSync(tempDir());
    withOpenDb(":memory:", (db) => {
      db.prepare(
        "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
      ).run(".trash", "dotowner", "成员", 0, ACCOUNT_HASH);
      const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });

      expectGenericRejection(() => store.create({ id: ".trash" }, { name: "alpha" }));
      expectGenericRejection(() => store.createTemporary({ id: ".trash" }));

      expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
      expect(readdirSync(sandboxRoot)).toEqual([]);
      expect(count(db, "SELECT COUNT(*) AS count FROM workspaces")).toBe(0);
      expect(count(db, "SELECT COUNT(*) AS count FROM audit_events")).toBe(0);

      // A row that got there some other way is not resolved to a path under `.trash` either.
      db.prepare(
        "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(WS, ".trash", "alpha", "alpha", 1);
      expectGenericRejection(() => store.list(".trash"));
      expectGenericRejection(() => store.rootOf({ id: ".trash" }, WS));
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });
});

function sweep(sandboxRoot: string, retentionDays: number, now: number): Promise<void> {
  return createTrash({ sandboxRoot, retentionDays }).sweep(now);
}

function openTrash(): { sandboxRoot: string; trash: string } {
  const sandboxRoot = realpathSync(tempDir());
  return { sandboxRoot, trash: privateDirs(sandboxRoot, ".trash") };
}

/** Makes `base/a/b/…` one level at a time, each 0700 as the trash levels are; returns the last. */
function privateDirs(base: string, ...segments: string[]): string {
  let dir = base;
  for (const segment of segments) {
    dir = join(dir, segment);
    if (!existsSync(dir)) {
      mkdirSync(dir, PRIVATE_MODE);
    }
  }
  return dir;
}

/** A batch-shaped directory: one deleted file and one deleted directory with a file in it. */
function batch(parent: string, name: string): string {
  return fill(join(parent, name));
}

function fill(dir: string): string {
  mkdirSync(dir, PRIVATE_MODE);
  writeFileSync(join(dir, "gone.txt"), "deleted bytes");
  mkdirSync(join(dir, "sub"), PRIVATE_MODE);
  writeFileSync(join(dir, "sub", "inner.txt"), "inner bytes");
  return dir;
}

function setMtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

function lock(dir: string, mode: number): void {
  chmodSync(dir, mode);
  locked.push(dir);
}

/** Every entry under `dir` by relative path: file bytes, link target, or a directory marker. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = `${prefix}${name}`;
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      entries[rel] = `link:${readlinkSync(path)}`;
    } else if (status.isDirectory()) {
      entries[rel] = "dir";
      Object.assign(entries, snapshot(path, `${rel}/`));
    } else {
      entries[rel] = `file:${readFileSync(path, "hex")}`;
    }
  }
  return entries;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function expectGenericRejection(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(HttpError);
}
