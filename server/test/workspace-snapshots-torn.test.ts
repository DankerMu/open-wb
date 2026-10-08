/**
 * Issue #1206 (task 10.4c) workspace-snapshots「快照内容规则」(复制期间文件内容有变动), scenario
 *「复制期间被改写的文件使快照不可还原」.
 *
 * Every rewrite happens for real, at a moment a hook of the helpers names: after the walk took
 * the `fstat` of the opened file and before it read any of its content, or once the walk is done
 * with the file. What the workspace and the snapshot must hold is written out from what the test
 * put there. The scenario's last WHEN (a root that is not there) is in
 * workspace-snapshots-take.test.ts.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TakeResult } from "../src/workspaces/snapshots.js";
import {
  describeTree,
  expectTorn,
  type Fixture,
  fileEntry,
  fixture,
  ioError,
  MESSAGE_ID,
  manifestOf,
  put,
  run,
  setPast,
  W,
  waitForClock,
  watchOpens,
  writeAfterFstat,
} from "./workspace-snapshots-helpers.js";

// Two reads long (the walk reads 64 KiB at a time); `NEW` is as long as `OLD`.
const OLD = "old line\n".repeat(10_000);
const NEW = "new line\n".repeat(10_000);

/** The workspace of the scenario; returns the path of `big.log`. */
function populate(f: Fixture): string {
  put(f.workspace, "a.txt", "alpha\n");
  put(f.workspace, "big.log", OLD);
  return join(f.workspace, "big.log");
}

/**
 * `big.log` is rewritten by `rewrite` while it is copied. The result is `failed` for that file,
 * nothing of the snapshot is left, and the workspace is as the rewrite left it.
 */
async function expectRefused(f: Fixture, rewrite: () => void): Promise<void> {
  const rewritten: unknown[] = [];
  writeAfterFstat(f, "big.log", () => {
    rewrite();
    rewritten.push(describeTree(f.workspace));
  });

  const result = await run(f);

  expect(rewritten).toHaveLength(1);
  expectTorn(result, "big.log");
  expect(existsSync(f.snapshot)).toBe(false);
  expect(readdirSync(join(f.snapshots, W))).toEqual([]);
  expect(describeTree(f.workspace)).toEqual(rewritten[0]);
  expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("alpha\n");
}

describe("复制期间被改写的文件使快照不可还原", () => {
  it("追加: big.log grows after its fstat and before its content is read", async () => {
    const f = fixture();
    const big = populate(f);

    await expectRefused(f, () => appendFileSync(big, "appended while copying\n"));

    expect(readFileSync(big, "utf8")).toBe(`${OLD}appended while copying\n`);
  });

  it("截断: big.log is cut short after its fstat and before its content is read", async () => {
    const f = fixture();
    const big = populate(f);

    await expectRefused(f, () => truncateSync(big, 4));

    expect(readFileSync(big, "utf8")).toBe("old ");
  });

  it("等长覆盖写: the same length, other bytes — only the times moved", async () => {
    const f = fixture();
    const big = populate(f);
    // The rewrite moves the mtime off this value and, once the clock has advanced, the ctime.
    setPast(big);

    await expectRefused(f, () => {
      waitForClock(f, big);
      writeFileSync(big, NEW);
    });

    expect(readFileSync(big, "utf8")).toBe(NEW);
    expect(lstatSync(big).size).toBe(OLD.length);
  });

  it("只改权限: a chmod while the file is copied moves its ctime and nothing else", async () => {
    const f = fixture();
    const big = populate(f);

    await expectRefused(f, () => {
      waitForClock(f, big);
      chmodSync(big, 0o600);
    });

    expect(readFileSync(big, "utf8")).toBe(OLD);
    expect(lstatSync(big).mode & 0o7777).toBe(0o600);
  });

  it("删除: a file unlinked while it is copied — the handle's ctime moved, the path is gone", async () => {
    const f = fixture();
    const big = populate(f);

    await expectRefused(f, () => {
      waitForClock(f, big);
      rmSync(big);
    });

    expect(existsSync(big)).toBe(false);
  });

  it("a copy that ends early is refused even when size and times stayed", async () => {
    // The second read of big.log answers end-of-file though the file is as long as it was.
    const f = fixture();
    populate(f);
    const before = describeTree(f.workspace);
    let reads = 0;
    watchOpens(
      f,
      () => undefined,
      (path, handle) => {
        if (path !== "big.log") {
          return;
        }
        const read = handle.read.bind(handle);
        handle.read = ((...args: Parameters<typeof read>) => {
          reads += 1;
          return reads === 1 ? read(...args) : Promise.resolve({ bytesRead: 0, buffer: args[0] });
        }) as typeof handle.read;
      },
    );

    const result = await run(f);

    expect(reads).toBe(2);
    expectTorn(result, "big.log");
    expect(existsSync(f.snapshot)).toBe(false);
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("复制完成之后才改写: ok, the snapshot has the bytes from before the rewrite", async () => {
    const f = fixture();
    const big = populate(f);
    const entries = [fileEntry(f, "a.txt"), fileEntry(f, "big.log")];
    const copied: string[] = [];
    // The walk closes the handle of a file when it is done with it.
    watchOpens(
      f,
      () => undefined,
      (path, handle) => {
        if (path !== "big.log") {
          return;
        }
        const close = handle.close.bind(handle);
        handle.close = () => {
          copied.push(readFileSync(join(f.snapshot, "tree", "big.log"), "utf8"));
          writeFileSync(big, "rewritten after the copy\n");
          return close();
        };
      },
    );

    const result = await run(f);

    expect(copied).toEqual([OLD]);
    expect(result).toEqual({ outcome: "ok", skipped: [] });
    expect(readFileSync(big, "utf8")).toBe("rewritten after the copy\n");
    expect(readFileSync(join(f.snapshot, "tree", "big.log"), "utf8")).toBe(OLD);
    expect(manifestOf(f).entries).toEqual(entries);
    expect(entries[1]).toMatchObject({ path: "big.log", size: 90_000 });
  });

  it("无改写: ok, and manifest.json is byte for byte what the workspace's own lstat gives", async () => {
    const f = fixture();
    populate(f);
    // Key order of a file entry: path, type, size, mtimeMs, ctimeMs, ino, mode.
    const body = JSON.stringify({
      entries: [fileEntry(f, "a.txt"), fileEntry(f, "big.log")],
      skipped: [],
    });

    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });

    expect(readFileSync(join(f.snapshot, "manifest.json"), "utf8")).toBe(body);
    expect(readFileSync(join(f.snapshot, "tree", "big.log"), "utf8")).toBe(OLD);
  });

  it("经硬链接复用: big.log unchanged since the previous snapshot is linked, not read", async () => {
    const f = fixture();
    const big = populate(f);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    const second: Fixture = { ...f, snapshot: join(f.snapshots, W, "43") };
    const stats: string[] = [];
    const opened = watchOpens(
      second,
      () => undefined,
      (path, handle) => {
        const stat = handle.stat.bind(handle);
        handle.stat = ((...args: Parameters<typeof stat>) => {
          stats.push(path);
          return stat(...args);
        }) as typeof handle.stat;
        handle.read = () => Promise.reject(ioError("EIO"));
      },
    );

    const result: TakeResult = await run(f, { userMessageId: 43, previousMessageId: MESSAGE_ID });

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    // Both sources were opened; nothing was created under tree/ by a copy, nothing was read.
    expect(opened).toEqual(["a.txt", "big.log"]);
    // One fstat each: a linked file is not looked at a second time.
    expect(stats).toEqual(["a.txt", "big.log"]);
    const copy = join(second.snapshot, "tree", "big.log");
    expect(lstatSync(copy).ino).toBe(lstatSync(join(f.snapshot, "tree", "big.log")).ino);
    expect(readFileSync(copy, "utf8")).toBe(OLD);
    expect(readFileSync(big, "utf8")).toBe(OLD);
  });
});
