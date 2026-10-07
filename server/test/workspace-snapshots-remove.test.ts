/**
 * Issue #941 (task 9.3): `removeSnapshot` and `removeWorkspaceSnapshots`, on real temporary
 * directories. Spec workspace-snapshots「未变文件的去重」(deleting the earlier snapshot) and the
 * function layer of「快照清理」: only paths joined from trusted components under the snapshot
 * root, a missing directory is success. What is left on disk is read by the tests' own lstat /
 * readFile.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeSnapshot, removeWorkspaceSnapshots } from "../src/workspaces/snapshots.js";
import {
  describeTree,
  type Fixture,
  fixture,
  lock,
  MESSAGE_ID,
  put,
  snapshot,
  W,
} from "./workspace-snapshots-helpers.js";

const SECOND_ID = 43;
const OTHER_W = "fedcba9876543210fedcba9876543210";
/** Removing an entry needs write permission on its parent, which root has regardless of mode. */
const unprivileged = process.getuid?.() === 0 ? it.skip : it;

const BAD_WORKSPACE_IDS: [string, unknown][] = [
  ["..", ".."],
  ["with a separator", `${W.slice(0, 15)}/${W.slice(0, 16)}`],
  ["a path that climbs out", `../${W}`],
  ["uppercase hex", W.toUpperCase()],
  ["31 characters", W.slice(1)],
  ["33 characters", `${W}0`],
  ["empty", ""],
  ["a number", 42],
  ["undefined", undefined],
];

const BAD_MESSAGE_IDS: [string, unknown][] = [
  ["0", 0],
  ["negative", -1],
  ["1.5", 1.5],
  ["NaN", Number.NaN],
  ["above the safe integers", Number.MAX_SAFE_INTEGER + 1],
  ["a numeric string", String(MESSAGE_ID)],
  ["..", ".."],
];

/** `toThrow(new TypeError(..))` compares the message only; this also holds the class. */
function isTypeError(message: string): (error: unknown) => boolean {
  return (error) => error instanceof TypeError && error.message === message;
}

/** One snapshot of a one-file workspace: `<snapshots>/<W>/42/{manifest.json,tree/a.txt}`. */
async function taken(): Promise<Fixture> {
  const f = fixture();
  put(f.workspace, "a.txt", "alpha\n");
  await snapshot(f);
  return f;
}

/** A directory outside the snapshot root holding `<MESSAGE_ID>/file`, linked as `<root>/<W>`. */
function linkedOutside(f: Fixture): string {
  const outside = join(dirname(f.workspace), "elsewhere");
  mkdirSync(join(outside, String(MESSAGE_ID)), { recursive: true });
  writeFileSync(join(outside, String(MESSAGE_ID), "file"), "outside\n");
  symlinkSync(outside, join(f.snapshots, W));
  return outside;
}

describe("非法分量被拒", () => {
  it.each(BAD_WORKSPACE_IDS)("removeSnapshot: workspace id %s", async (_name, workspaceId) => {
    const f = await taken();
    const before = describeTree(dirname(f.workspace));

    await expect(
      removeSnapshot({
        snapshotsRoot: f.snapshots,
        workspaceId: workspaceId as string,
        messageId: MESSAGE_ID,
      }),
    ).rejects.toSatisfy(isTypeError("snapshot workspace id must be 32 lowercase hex characters"));

    expect(describeTree(dirname(f.workspace))).toEqual(before);
  });

  it.each(BAD_WORKSPACE_IDS)(
    "removeWorkspaceSnapshots: workspace id %s",
    async (_name, workspaceId) => {
      const f = await taken();
      const before = describeTree(dirname(f.workspace));

      await expect(
        removeWorkspaceSnapshots({
          snapshotsRoot: f.snapshots,
          workspaceId: workspaceId as string,
        }),
      ).rejects.toSatisfy(isTypeError("snapshot workspace id must be 32 lowercase hex characters"));

      expect(describeTree(dirname(f.workspace))).toEqual(before);
    },
  );

  it.each(BAD_MESSAGE_IDS)("removeSnapshot: message id %s", async (_name, messageId) => {
    const f = await taken();
    const before = describeTree(dirname(f.workspace));

    await expect(
      removeSnapshot({
        snapshotsRoot: f.snapshots,
        workspaceId: W,
        messageId: messageId as number,
      }),
    ).rejects.toSatisfy(isTypeError("snapshot message id must be a positive integer"));

    expect(describeTree(dirname(f.workspace))).toEqual(before);
  });
});

describe("不存在视为成功", () => {
  it("removeSnapshot: no such message directory", async () => {
    const f = await taken();
    const before = describeTree(f.snapshots);

    await expect(
      removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: W, messageId: SECOND_ID }),
    ).resolves.toBeUndefined();

    expect(describeTree(f.snapshots)).toEqual(before);
  });

  it("removeSnapshot: no such workspace directory", async () => {
    const f = await taken();
    const before = describeTree(f.snapshots);

    await expect(
      removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: OTHER_W, messageId: MESSAGE_ID }),
    ).resolves.toBeUndefined();

    expect(describeTree(f.snapshots)).toEqual(before);
  });

  it("removeWorkspaceSnapshots: no such workspace directory", async () => {
    const f = await taken();
    const before = describeTree(f.snapshots);

    await expect(
      removeWorkspaceSnapshots({ snapshotsRoot: f.snapshots, workspaceId: OTHER_W }),
    ).resolves.toBeUndefined();

    expect(describeTree(f.snapshots)).toEqual(before);
  });

  it("both: no snapshot root at all, and none is created", async () => {
    const f = fixture();
    const missing = join(f.snapshots, "never-made");

    await removeSnapshot({ snapshotsRoot: missing, workspaceId: W, messageId: MESSAGE_ID });
    await removeWorkspaceSnapshots({ snapshotsRoot: missing, workspaceId: W });

    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(f.snapshots)).toEqual([]);
  });
});

describe("未变文件的去重：删除较早的一份", () => {
  it("removeSnapshot of the earlier one leaves the later one whole, its shared file at nlink 1", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "src/b.ts", "export const b = 1;\n");
    await snapshot(f);
    await snapshot(f, { userMessageId: SECOND_ID, previousMessageId: MESSAGE_ID });
    const later = join(f.snapshots, W, String(SECOND_ID));
    const shared = join(later, "tree", "a.txt");
    const manifest = readFileSync(join(later, "manifest.json"));
    const before = lstatSync(shared);
    expect(before.nlink).toBe(2);
    expect(before.ino).toBe(lstatSync(join(f.snapshot, "tree", "a.txt")).ino);

    await removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: W, messageId: MESSAGE_ID });

    expect(readdirSync(join(f.snapshots, W))).toEqual([String(SECOND_ID)]);
    expect(readFileSync(join(later, "manifest.json")).equals(manifest)).toBe(true);
    expect(readFileSync(shared, "utf8")).toBe("alpha\n");
    expect(readFileSync(join(later, "tree", "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    const after = lstatSync(shared);
    expect(after.nlink).toBe(1);
    expect(after.ino).toBe(before.ino);
    expect(after.mode).toBe(before.mode);
    expect(after.mode & 0o7777).toBe(0o600);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // The workspace itself is never touched by a removal.
    expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("removeWorkspaceSnapshots", () => {
  it("removes every snapshot of that workspace and nothing of another one", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    await snapshot(f);
    await snapshot(f, { userMessageId: SECOND_ID, previousMessageId: MESSAGE_ID });
    await snapshot(f, { workspaceId: OTHER_W });
    const other = join(f.snapshots, OTHER_W);
    const before = describeTree(other);

    await removeWorkspaceSnapshots({ snapshotsRoot: f.snapshots, workspaceId: W });

    expect(readdirSync(f.snapshots)).toEqual([OTHER_W]);
    expect(describeTree(other)).toEqual(before);
    expect(readFileSync(join(other, String(MESSAGE_ID), "tree", "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("快照根下的 <workspaceId> 是指向根外的符号链接", () => {
  it("removeSnapshot throws and removes nothing", async () => {
    const f = fixture();
    const outside = linkedOutside(f);
    const before = describeTree(outside);

    await expect(
      removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: W, messageId: MESSAGE_ID }),
    ).rejects.toThrow(new Error("snapshot workspace directory is not a real directory"));

    expect(describeTree(outside)).toEqual(before);
    expect(readFileSync(join(outside, String(MESSAGE_ID), "file"), "utf8")).toBe("outside\n");
    expect(lstatSync(join(f.snapshots, W)).isSymbolicLink()).toBe(true);
  });

  it("removeSnapshot throws when it is a regular file, which stays", async () => {
    const f = fixture();
    writeFileSync(join(f.snapshots, W), "not a directory\n");

    await expect(
      removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: W, messageId: MESSAGE_ID }),
    ).rejects.toThrow(new Error("snapshot workspace directory is not a real directory"));

    expect(readFileSync(join(f.snapshots, W), "utf8")).toBe("not a directory\n");
  });

  it("removeWorkspaceSnapshots removes the link only", async () => {
    const f = fixture();
    const outside = linkedOutside(f);
    const before = describeTree(outside);

    await removeWorkspaceSnapshots({ snapshotsRoot: f.snapshots, workspaceId: W });

    expect(readdirSync(f.snapshots)).toEqual([]);
    expect(describeTree(outside)).toEqual(before);
    expect(readFileSync(join(outside, String(MESSAGE_ID), "file"), "utf8")).toBe("outside\n");
  });
});

describe("其它错误原样抛给调用方", () => {
  unprivileged(
    "removeSnapshot: a directory that cannot be emptied rejects with EACCES",
    async () => {
      const f = await taken();
      lock(f.snapshot, 0o500); // made 0700 again by the helpers' afterEach

      await expect(
        removeSnapshot({ snapshotsRoot: f.snapshots, workspaceId: W, messageId: MESSAGE_ID }),
      ).rejects.toMatchObject({ code: "EACCES" });

      expect(readFileSync(join(f.snapshot, "tree", "a.txt"), "utf8")).toBe("alpha\n");
    },
  );

  unprivileged("removeWorkspaceSnapshots: the same", async () => {
    const f = await taken();
    lock(join(f.snapshots, W), 0o500);

    await expect(
      removeWorkspaceSnapshots({ snapshotsRoot: f.snapshots, workspaceId: W }),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(readFileSync(join(f.snapshot, "tree", "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("removeSnapshot: a snapshot root that is a file rejects with ENOTDIR", async () => {
    const f = fixture();

    await expect(
      removeSnapshot({ snapshotsRoot: f.outside, workspaceId: W, messageId: MESSAGE_ID }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
