/**
 * s1b-workspace-mounts tasks 9.2 (#1696): workspace-mounts「挂载目录内的文件端点」scenarios「删除与跨挂载移动」
 * 「离线与只读」「越界先于挂载判定」, file-operations「挂载内不能删除」「跨挂载边界」and workspaces「离线与只读
 * 挂载」— on the whole mount (`mounts-file-endpoints-helpers.ts`: createApp with a real manager on the fake
 * rclone; online mounts are plain directories attached over HTTP, offline ones registered rows). The
 * adapter runs on its default `fs/promises`. Every `node:fs` / `node:fs/promises` call made through the
 * module objects is recorded by its first argument, so "nothing touched" is a filter on the recorder.
 * The adapter's own paths (online reads, the hung mount, the short read) are in
 * `mounts-file-endpoints-online.test.ts`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  BOUNDARY,
  expectOutcomes,
  type FileWorld,
  fileAudits,
  isUnder,
  move,
  OFFLINE,
  openFileWorld,
  put,
  q,
  READ_ONLY,
  SENTINEL,
  trashBatches,
} from "./mounts-file-endpoints-helpers.js";
import { disposeWorlds } from "./mounts-manager-helpers.js";
import { CASE_MS, closeApps } from "./mounts-rest-helpers.js";

/** Every `node:fs` / `node:fs/promises` call made through the module objects, by first argument. */
const fsCalls = vi.hoisted(() => [] as Array<{ name: string; path: string }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (prefix: string, source: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(source).map(([name, value]) => [
        name,
        typeof value !== "function"
          ? value
          : new Proxy(value, {
              apply(target, self, args) {
                fsCalls.push({ name: `${prefix}${name}`, path: String(args[0]) });
                return Reflect.apply(target, self, args);
              },
            }),
      ]),
    );
  return {
    ...record("", actual),
    promises: record("promises.", actual.promises as Record<string, unknown>),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : new Proxy(value, {
            apply(target, self, args) {
              fsCalls.push({ name: `promises.${name}`, path: String(args[0]) });
              return Reflect.apply(target, self, args);
            },
          }),
    ]),
  );
});

beforeEach(() => {
  fsCalls.length = 0;
});

afterEach(async () => {
  await closeApps();
  await disposeWorlds();
});

/** Recorded calls at the mount point of `name` or below it, any kind. */
const touched = (fw: FileWorld, name: string) =>
  fsCalls.filter((call) => isUnder(call.path, fw.point(name)));
/** Recorded synchronous calls at the mount point of `name` or below it. */
const syncInto = (fw: FileWorld, name: string) =>
  touched(fw, name).filter((call) => !call.name.startsWith("promises."));

describe("挂载目录内的文件端点「删除与跨挂载移动」", () => {
  it("nine 409 mount_boundary (./ and // spellings included) leave everything; the same-mount move and the rename are one adapter rename each", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({ online: [{ name: "远端" }] });
    put(fw.root, "远端/a.md", "a\n");
    put(fw.root, "远端/c.md", "c\n");
    put(fw.root, "远端/d/keep.txt", "d\n");
    put(fw.root, "local.md", "local\n");
    fsCalls.length = 0;

    await expectOutcomes(
      fw,
      [
        ["DELETE", `entries?${q("远端/a.md")}`],
        ["DELETE", `entries?${q("远端")}`],
        ["DELETE", `entries?${q("./远端")}`],
        ["DELETE", `entries?${q("./远端/a.md")}`],
        ["DELETE", `entries?${q("远端//a.md")}`],
        ["POST", "move", move("local.md", "远端/local.md")],
        ["POST", "move", move("远端/a.md", "a.md")],
        ["POST", "move", move("./远端/a.md", "a.md")],
        ["POST", "move", move("远端", "别名")],
      ],
      Array(9).fill(BOUNDARY),
    );
    expect(touched(fw, "远端")).toEqual([]);
    expect(readFileSync(join(fw.root, "远端/a.md"), "utf8")).toBe("a\n");
    expect(readFileSync(join(fw.root, "local.md"), "utf8")).toBe("local\n");
    expect(existsSync(join(fw.root, "a.md")) || existsSync(join(fw.root, "别名"))).toBe(false);
    expect(fileAudits(fw)).toEqual([]);
    expect(await trashBatches(fw)).toEqual([]);
    fsCalls.length = 0;

    await expectOutcomes(
      fw,
      [
        ["POST", "move", move("远端/a.md", "远端/d/a.md")],
        ["POST", "move", move("远端/c.md", "./远端/e.md")],
      ],
      [
        [200, ""],
        [200, ""],
      ],
    );
    const synchronous = syncInto(fw, "远端");
    expect(readFileSync(join(fw.root, "远端/d/a.md"), "utf8")).toBe("a\n");
    expect(readFileSync(join(fw.root, "远端/e.md"), "utf8")).toBe("c\n");
    expect(fileAudits(fw)).toEqual([
      ["file.move", "移动 远端/a.md → 远端/d/a.md"],
      ["file.move", "重命名 远端/c.md → e.md"],
    ]);
    expect(
      touched(fw, "远端")
        .filter((call) => call.name === "promises.rename")
        .map((c) => c.path),
    ).toEqual([join(fw.point("远端"), "a.md"), join(fw.point("远端"), "c.md")]);
    expect(synchronous).toEqual([]);
  });
});

describe("file-operations「挂载内不能删除」", () => {
  it("four 409 mount_boundary whether online or offline; 远端旧 (a name starting with the mount's) goes to the recycle directory", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({ online: [{ name: "远端" }], offline: ["备份"] });
    put(fw.root, "远端/a.md", "a\n");
    put(fw.root, "备份/x.md", "x\n");
    put(fw.root, "远端旧/old.md", "old\n");
    fsCalls.length = 0;

    await expectOutcomes(
      fw,
      [
        ["DELETE", `entries?${q("远端/a.md")}`],
        ["DELETE", `entries?${q("远端")}`],
        ["DELETE", `entries?${q("./远端/a.md")}`],
        ["DELETE", `entries?${q("备份/x.md")}`],
      ],
      Array(4).fill(BOUNDARY),
    );
    expect(touched(fw, "远端")).toEqual([]);
    expect(touched(fw, "备份")).toEqual([]);
    expect(readFileSync(join(fw.root, "远端/a.md"), "utf8")).toBe("a\n");
    expect(await trashBatches(fw)).toEqual([]);
    expect(fileAudits(fw)).toEqual([]);

    await expectOutcomes(fw, [["DELETE", `entries?${q("远端旧")}`]], [[204, ""]]);
    expect(existsSync(join(fw.root, "远端旧"))).toBe(false);
    expect(await trashBatches(fw)).toHaveLength(1);
    expect(fileAudits(fw)).toEqual([["file.delete", "删除 远端旧"]]);
  });
});

describe("file-operations「跨挂载边界」", () => {
  it("five 409 mount_boundary, 403 mount_read_only, 409 mount_offline, then the same-mount move", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({
      online: [{ name: "远端" }, { name: "共享" }, { name: "参考", readOnly: true }],
      offline: ["备份"],
    });
    put(fw.root, "远端/a.md", "a\n");
    put(fw.root, "远端/d/keep.txt", "d\n");
    put(fw.root, "参考/r.md", "r\n");
    put(fw.root, "local.md", "local\n");
    fsCalls.length = 0;

    await expectOutcomes(
      fw,
      [
        ["POST", "move", move("local.md", "远端/local.md")],
        ["POST", "move", move("远端/a.md", "a.md")],
        ["POST", "move", move("远端/a.md", "共享/a.md")],
        ["POST", "move", move("远端", "远端2")],
        ["POST", "move", move("./远端/a.md", "共享//a.md")],
        ["POST", "move", move("参考/r.md", "参考/s.md")],
        ["POST", "move", move("备份/x", "备份/y")],
      ],
      [BOUNDARY, BOUNDARY, BOUNDARY, BOUNDARY, BOUNDARY, READ_ONLY, OFFLINE],
    );
    for (const name of ["远端", "共享", "参考", "备份"]) {
      expect(touched(fw, name), name).toEqual([]);
    }
    expect(readdirSync(fw.point("共享"))).toEqual([]);
    expect(readdirSync(fw.point("参考"))).toEqual(["r.md"]);
    expect(existsSync(join(fw.root, "远端2"))).toBe(false);
    expect(fileAudits(fw)).toEqual([]);

    await expectOutcomes(fw, [["POST", "move", move("远端/a.md", "远端/d/a.md")]], [[200, ""]]);
    expect(readFileSync(join(fw.root, "远端/d/a.md"), "utf8")).toBe("a\n");
    expect(fileAudits(fw)).toEqual([["file.move", "移动 远端/a.md → 远端/d/a.md"]]);
  });
});

describe("挂载目录内的文件端点「离线与只读」", () => {
  it("offline 远端: seven 409 mount_offline, the sentinel never listed or read; online read-only 参考: dirs and move 403; a cross-boundary move stays 409 mount_boundary on either", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({
      online: [{ name: "参考", readOnly: true }],
      offline: ["远端"],
    });
    put(fw.root, "远端/a.md", "behind\n");
    put(fw.root, "参考/a.md", "ref\n");
    fsCalls.length = 0;

    const bodies = await expectOutcomes(
      fw,
      [
        ["GET", `tree?${q("远端")}`],
        ["GET", `tree?${q("./远端")}`],
        ["GET", `file?${q("远端/a.md")}`],
        ["GET", `download?${q("远端/a.md")}`],
        ["GET", `archive?${q("远端/x.zip")}`],
        ["POST", "dirs", { path: "远端/新" }],
        ["POST", "move", move("远端/a.md", "远端/b.md")],
        ["POST", "dirs", { path: "参考/新" }],
        ["POST", "move", move("参考/a.md", "参考/b.md")],
        // The boundary still comes first on an offline or a read-only mount.
        ["POST", "move", move("远端/a.md", "a.md")],
        ["POST", "move", move("参考/a.md", "a.md")],
      ],
      [...Array(7).fill(OFFLINE), READ_ONLY, READ_ONLY, BOUNDARY, BOUNDARY],
    );
    expect(bodies.filter((body) => body.includes(SENTINEL))).toEqual([]);
    expect(touched(fw, "远端")).toEqual([]);
    expect(touched(fw, "参考")).toEqual([]);
    expect(readdirSync(fw.point("远端")).sort()).toEqual(["a.md", SENTINEL]);
    expect(readdirSync(fw.point("参考"))).toEqual(["a.md"]);
    expect(fileAudits(fw)).toEqual([]);
  });

  it("feature off (no RCLONE_BIN), 远端 registered: tree?path=远端 is 409 mount_offline with no file system access", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({ featureOff: true, offline: ["远端"] });
    fsCalls.length = 0;

    await expectOutcomes(fw, [["GET", `tree?${q("远端")}`]], [OFFLINE]);
    expect(touched(fw, "远端")).toEqual([]);
  });

  it("远端备份, a plain directory whose name starts with the mount's, answers by the ordinary rules", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({ offline: ["远端"] });
    put(fw.root, "远端备份/a.md", "plain\n");

    await expectOutcomes(
      fw,
      [
        ["GET", `tree?${q("远端备份")}`],
        ["GET", `tree?${q("./远端备份")}`],
        ["GET", `file?${q("远端备份/a.md")}`],
        ["GET", `download?${q("远端备份/a.md")}`],
        ["GET", `archive?${q("远端备份/x.zip")}`],
        ["POST", "dirs", { path: "远端备份/新" }],
        ["POST", "move", move("远端备份/a.md", "远端备份/b.md")],
      ],
      [
        [200, ""],
        [200, ""],
        [200, ""],
        [200, ""],
        [404, "not_found"],
        [201, ""],
        [200, ""],
      ],
    );
    expect(readdirSync(join(fw.root, "远端备份")).sort()).toEqual(["b.md", "新"]);
    expect(fileAudits(fw).map(([kind]) => kind)).toEqual([
      "file.download",
      "dir.create",
      "file.move",
    ]);
  });
});

describe("workspaces「离线与只读挂载」", () => {
  it("the root lists neither mount; 远端 refused offline; 参考 listed; both refused dirs create nothing and audit nothing", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({
      online: [{ name: "参考", readOnly: true }],
      offline: ["远端"],
    });
    put(fw.root, "参考/a.md", "ref\n");
    put(fw.root, "参考/sub/b.md", "b\n");
    put(fw.root, "out/x.md", "x\n");

    const root = await ask(fw, "GET", "tree");
    expect(root.statusCode).toBe(200);
    expect(
      (root.json() as { entries: Array<{ name: string }> }).entries.map((e) => e.name),
    ).toEqual(["out"]);
    const bodies = await expectOutcomes(
      fw,
      [
        ["GET", `tree?${q("远端")}`],
        ["GET", `tree?${q("远端/sub")}`],
        ["POST", "dirs", { path: "远端/新" }],
        ["GET", `tree?${q("参考")}`],
        ["POST", "dirs", { path: "参考/新" }],
      ],
      [OFFLINE, OFFLINE, OFFLINE, [200, ""], READ_ONLY],
    );
    const listing = JSON.parse(bodies[3] as string) as {
      path: string;
      entries: Array<{ name: string; type: string; size: number }>;
    };
    expect(listing.path).toBe("参考");
    expect(
      listing.entries.map(({ name, type, size }) => [name, type, type === "file" ? size : 0]),
    ).toEqual([
      ["sub", "dir", 0],
      ["a.md", "file", 4],
    ]);
    expect(existsSync(join(fw.root, "远端/新"))).toBe(false);
    expect(existsSync(join(fw.root, "参考/新"))).toBe(false);
    expect(fileAudits(fw)).toEqual([]);
  });
});

describe("挂载目录内的文件端点「越界先于挂载判定」", () => {
  it("远端/../x and ./远端/../x are 403 sandbox_denied with one sandbox.reject each, not 409", {
    timeout: CASE_MS,
  }, async () => {
    const fw = await openFileWorld({ online: [{ name: "远端" }] });
    put(fw.root, "x", "x\n");

    await expectOutcomes(
      fw,
      [
        ["DELETE", `entries?${q("远端/../x")}`],
        ["DELETE", `entries?${q("./远端/../x")}`],
      ],
      [
        [403, "sandbox_denied"],
        [403, "sandbox_denied"],
      ],
    );
    expect(fileAudits(fw)).toEqual([
      ["sandbox.reject", "越界访问被沙箱拦截"],
      ["sandbox.reject", "越界访问被沙箱拦截"],
    ]);
    expect(readFileSync(join(fw.root, "x"), "utf8")).toBe("x\n");
  });
});
