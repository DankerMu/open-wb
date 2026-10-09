/**
 * Issue #1017 (s1g-composer-capabilities task 11.4): a record of what happens today when
 * `uploads` is replaced by a symbolic link inside the upload's window — after the route's own
 * `lstat` of the directory, before `storeUpload` creates its temporary file in it. This is the
 * residual registered in design D11 (「竞态」) and Risks (「上传的符号链接竞态」), not a guarantee of
 * the spec: the exclusive create does not follow a link in its last component, but the parent is
 * opened by path, so the file lands in the link's target.
 *
 * If this case goes red, the window has been closed (a directory handle, an `O_NOFOLLOW`-style
 * check of the parent) or the behaviour has changed: update this record and the Risks entry. Do
 * not change the assertions back.
 *
 * Scope: the link's target is another directory of the same workspace. A target outside the
 * sandbox is not recorded here.
 *
 * Before the window, and not cases here:
 * - a link already there when the request arrives: the sandbox's `lstat` of each component
 *   refuses it, 403 `sandbox_denied` with a `sandbox.reject` event (workspace-upload-rest.test.ts,
 *   "refuses an uploads directory that is a symbolic link out of the sandbox");
 * - a link put in after the sandbox's `lstat` and before the route's: the route answers 409. Read
 *   from the code; no test covers it (the 409 case in workspace-upload-rest.test.ts is `uploads`
 *   being a regular file).
 * After the window, also read from the code and not measured: a swap once the temporary file
 * exists and before `link`. Both of `link`'s paths would go through the link and miss the
 * temporary file, so it would fail, and the temporary file would stay in the moved directory.
 *
 * The seam is `node:fs/promises` `open`, patched on the builtin and synced to its named exports
 * (as model-proxy-models-yml.test.ts does for `rename`); it relies on vitest's default forks pool
 * keeping the patch inside this file. Production createApp on a loopback port, real directories,
 * the upload over a real socket (workspace-upload-helpers.ts).
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  auditOf,
  createWorkspace,
  expectWire,
  type UploadWorld,
  upload,
  type Workspace,
  withUploadWorld,
} from "./workspace-upload-helpers.js";

afterEach(removeTempDirs);

const STORED = { path: "uploads/a.txt", name: "a.txt", size: 3 };

interface Arrangement {
  workspace: Workspace;
  /** A real directory when the upload starts. */
  uploads: string;
  /** Another directory of the same workspace, so inside the sandbox. */
  elsewhere: string;
  /** Where the race moves the real `uploads` to. */
  uploadsWas: string;
}

async function arrange(world: UploadWorld): Promise<Arrangement> {
  const workspace = await createWorkspace(world, "竞态");
  const uploads = join(workspace.root, "uploads");
  const elsewhere = join(workspace.root, "elsewhere");
  mkdirSync(uploads);
  mkdirSync(elsewhere);
  return { workspace, uploads, elsewhere, uploadsWas: join(workspace.root, "uploads-was") };
}

/** Every entry under `dir`, relative and sorted, links not followed; `skip` names a top entry. */
function treeOf(dir: string, skip?: string): string[] {
  const names: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (path === skip) {
        continue;
      }
      names.push(path);
      if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk("");
  return names.sort();
}

/** The account's whole audit trail: the workspace's creation, then exactly one upload. */
async function expectOneUploadEvent(world: UploadWorld, workspace: Workspace): Promise<void> {
  const [created, ...uploads] = await auditOf(world);
  expect(created?.kind).toBe("workspace.create");
  expect(
    uploads.map(({ kind, actorId, workspaceId, title, detail }) => ({
      kind,
      actorId,
      workspaceId,
      title,
      detail,
    })),
  ).toEqual([
    {
      kind: "file.upload",
      actorId: "u1",
      workspaceId: workspace.id,
      title: "上传文件 uploads/a.txt",
      // The logical path, not where the bytes went.
      detail: { path: "uploads/a.txt", size: 3 },
    },
  ]);
}

describe("POST /api/workspaces/:id/uploads — symbolic-link race (design D11 / Risks)", () => {
  it("records a registered residual, not a guarantee: uploads swapped for a symlink between the route's lstat and the exclusive create — the file lands in the link target", async () => {
    // Control: the same arrangement and the same upload with nothing swapped. What differs below
    // is then the swap's doing.
    await withUploadWorld(async (world) => {
      const { workspace, uploads, elsewhere } = await arrange(world);

      expectWire(await upload(world, workspace.id, "a.txt", "abc"), 201, STORED);

      expect(lstatSync(uploads).isDirectory()).toBe(true);
      expect(readdirSync(uploads)).toEqual(["a.txt"]);
      expect(readFileSync(join(uploads, "a.txt"), "utf8")).toBe("abc");
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readdirSync(workspace.root).sort()).toEqual(["elsewhere", "uploads"]);
      await expectOneUploadEvent(world, workspace);
    });

    await withUploadWorld(async (world) => {
      const { workspace, uploads, elsewhere, uploadsWas } = await arrange(world);
      const base = dirname(world.sandboxRoot);
      const outsideBefore = treeOf(base, "sandbox");
      const temporaryPrefix = join(uploads, ".upload-");
      const isTemporary = (path: unknown): boolean =>
        typeof path === "string" && path.startsWith(temporaryPrefix);

      // One entry per swap: what `uploads` was just before it, with the temporary file not yet
      // opened.
      const wasDirectoryAtOpen: boolean[] = [];
      const realOpen = fsp.open;
      const open = vi.spyOn(fsp, "open").mockImplementation((...args) => {
        if (isTemporary(args[0]) && wasDirectoryAtOpen.length === 0) {
          // Still the real directory: the route's lstat has already passed.
          wasDirectoryAtOpen.push(lstatSync(uploads).isDirectory());
          renameSync(uploads, uploadsWas);
          symlinkSync(elsewhere, uploads);
        }
        return realOpen(...args);
      });
      syncBuiltinESMExports();
      let temporaryOpens: number;
      let response: Awaited<ReturnType<typeof upload>>;
      try {
        response = await upload(world, workspace.id, "a.txt", "abc");
        temporaryOpens = open.mock.calls.filter(([path]) => isTemporary(path)).length;
      } finally {
        open.mockRestore();
        syncBuiltinESMExports();
      }

      // The swap happened inside the window, once, and the upload opened one temporary file.
      expect(wasDirectoryAtOpen).toEqual([true]);
      expect(temporaryOpens).toBe(1);

      // The caller is told the logical path, as if nothing had happened.
      expectWire(response, 201, STORED);

      // The file is in the link's target, whole and under its name, with no temporary file left;
      // the directory the route checked got nothing.
      expect(lstatSync(uploads).isSymbolicLink()).toBe(true);
      expect(readdirSync(elsewhere)).toEqual(["a.txt"]);
      expect(readFileSync(join(elsewhere, "a.txt"), "utf8")).toBe("abc");
      expect(readdirSync(uploadsWas)).toEqual([]);
      await expectOneUploadEvent(world, workspace);

      // With the target inside the workspace, that is the only place written: this follows from
      // the arrangement, it is not a property of the route.
      expect(readdirSync(workspace.root).sort()).toEqual(["elsewhere", "uploads", "uploads-was"]);
      expect(readdirSync(world.sandboxRoot)).toEqual(["u1"]);
      expect(readdirSync(join(world.sandboxRoot, "u1"))).toEqual([basename(workspace.root)]);
      expect(treeOf(base, "sandbox")).toEqual(outsideBefore);
    });
  });
});
