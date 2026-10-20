/**
 * Issue #1257 (s1-followups-batch task 8.4): `POST /api/workspaces/:id/uploads` — spec
 * workspaces「文件上传」step 5, scenario「名字规则与媒体类型」: the name may not hold U+0085, U+2028,
 * U+2029 or one of the twelve bidirectional controls either, the code points a prompt refuses in
 * an attachment path. The rule keeps its place after the sandbox, and it is about names uploaded
 * from now on: a file already on disk under such a name is listed, previewed and downloaded as
 * before.
 *
 * The world and the wire client are those of workspace-upload-rest.test.ts
 * (workspace-upload-helpers.ts). Oracles: the specification's literals, the rows of
 * `audit_events`, `GET /api/audit`, the file system.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BAD_REQUEST_ENVELOPE } from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  auditCount,
  auditOf,
  createWorkspace,
  expectWire,
  REFUSED_CODE_POINTS,
  SANDBOX_DENIED_ENVELOPE,
  upload,
  uploadsOf,
  withUploadWorld,
} from "./workspace-upload-helpers.js";

afterEach(removeTempDirs);

const codePointsOf = (text: string) => Array.from(text, (char) => char.codePointAt(0));

describe("workspaces「文件上传」 — 名字规则：换行类与双向控制字符 (#1257)", () => {
  it.each(REFUSED_CODE_POINTS)(
    "answers 400 for a name holding $label and writes nothing, uploads absent or present",
    async ({ char }) => {
      await withUploadWorld(async (world) => {
        const absent = await createWorkspace(world, "absent");
        const present = await createWorkspace(world, "present");
        mkdirSync(join(present.root, "uploads"));
        const before = auditCount(world);

        for (const w of [absent, present]) {
          for (const name of [`a${char}b.txt`, `${char}.txt`, `a.txt${char}`]) {
            expectWire(await upload(world, w.id, name, "bad"), 400, BAD_REQUEST_ENVELOPE);
          }
        }

        // Neither the file nor a `.upload-….part` beside it, and no directory made for it.
        expect(uploadsOf(absent)).toBeNull();
        expect(readdirSync(absent.root)).toEqual([".git"]);
        expect(uploadsOf(present)).toEqual([]);
        // No `file.upload`, no `upload.reject`, no `sandbox.reject`: no row at all.
        expect(auditCount(world)).toBe(before);
      });
    },
  );

  it.each([
    ["Chinese and a space", "报告 v2.pdf"],
    ["U+00A0", "a\u00a0b.txt"],
    ["U+200D", "a\u200db.txt"],
    ["U+2010", "a\u2010b.txt"],
    ["U+202F", "a\u202fb.txt"],
    ["U+206A", "a\u206ab.txt"],
  ])("still stores a name holding %s", async (_label, name) => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "plain");

      const response = await upload(world, w.id, name, "pdf");

      expectWire(response, 201, { path: `uploads/${name}`, name, size: 3 });
      expect(uploadsOf(w)?.map(codePointsOf)).toEqual([codePointsOf(name)]);
      expect(readFileSync(join(w.root, "uploads", name), "utf8")).toBe("pdf");
    });
  });

  // Step 4 before step 5: the sandbox judges the name first, whatever else is wrong with it.
  it("an escaping name that also holds such a code point is the audited 403, not a 400", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "escape");
      const seen = (await auditOf(world)).length;

      for (const name of ["../../etc/pass\u202ewd", "..\u2028/../x", "a\u2066\\b.txt"]) {
        expectWire(await upload(world, w.id, name, "bad"), 403, SANDBOX_DENIED_ENVELOPE);
      }

      const events = (await auditOf(world)).slice(seen);
      expect(events.map((event) => [event.kind, event.actorId, event.workspaceId])).toEqual([
        ["sandbox.reject", "u1", w.id],
        ["sandbox.reject", "u1", w.id],
        ["sandbox.reject", "u1", w.id],
      ]);
      expect(events.map((event) => event.detail)).toEqual([
        expect.objectContaining({ op: "write", relPath: "uploads/../../etc/pass\u202ewd" }),
        expect.objectContaining({ op: "write", relPath: "uploads/..\u2028/../x" }),
        expect.objectContaining({ op: "write", relPath: "uploads/a\u2066\\b.txt" }),
      ]);
      expect(uploadsOf(w)).toBeNull();
      expect(readdirSync(w.root)).toEqual([".git"]);
    });
  });

  it("a file already on disk under such a name is still listed, previewed and downloaded", async () => {
    await withUploadWorld(async (world) => {
      const w = await createWorkspace(world, "kept");
      const name = "a\u202egpj.txt";
      const path = `uploads/${name}`;
      mkdirSync(join(w.root, "uploads"));
      writeFileSync(join(w.root, path), "kept bytes");
      const get = (route: string, query: string) =>
        world.app.inject({
          method: "GET",
          url: `/api/workspaces/${w.id}/${route}?path=${encodeURIComponent(query)}`,
          headers: { cookie: world.owner },
        });

      const tree = await get("tree", "uploads");
      expect(tree.statusCode).toBe(200);
      const entries = tree.json<{ entries: Array<{ name: string; type: string; size: number }> }>()
        .entries;
      expect(entries).toHaveLength(1);
      expect(codePointsOf(entries[0]?.name ?? "")).toEqual(codePointsOf(name));
      expect(codePointsOf(name)).toContain(0x202e);
      expect(entries[0]).toMatchObject({ type: "file", size: 10 });

      for (const route of ["file", "download"]) {
        const response = await get(route, path);
        expect(response.statusCode, route).toBe(200);
        expect(response.rawPayload.toString("utf8"), route).toBe("kept bytes");
      }
      // And the same name is refused as a new upload, leaving the file as it was.
      expectWire(await upload(world, w.id, name, "new"), 400, BAD_REQUEST_ENVELOPE);
      expect(uploadsOf(w)?.map(codePointsOf)).toEqual([codePointsOf(name)]);
      expect(readFileSync(join(w.root, path), "utf8")).toBe("kept bytes");
    });
  });
});
