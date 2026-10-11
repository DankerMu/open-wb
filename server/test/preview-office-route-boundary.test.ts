/**
 * Issue #1074 (s1f-files-page tasks 15.1–15.3): the path and token boundary of
 * `GET /o/<token>/<path>` — the same checks in the same order as `/w/` (preview-origin
 * 「预览监听器」), each ending before the converter is asked. The escape vectors are those of
 * `preview-app.test.ts` for `/w/`, named like documents; one case runs the same bytes through both
 * routes. Everything a URL parser would rewrite goes over a real socket.
 */
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  expectFixedFailure,
  LISI,
  LISI_WORKSPACE,
  OUTSIDE_SECRET,
  rawAnswer,
  rejectRows,
  WORKSPACE_A,
  WORKSPACE_B,
  withPreviewWorld,
  ZHANGSAN,
} from "./preview-app-helpers.js";
import {
  DOCX_BYTES,
  expectOfficeFailure,
  get,
  rejectOf,
  seed,
  standIn,
  TEXT,
  tokenForA,
  UNKNOWN_TOKEN,
} from "./preview-office-helpers.js";
import { auditCount } from "./workspaces-http-helpers.js";

const TTL_MS = 900_000;

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

describe("office preview route: the same boundary as /w/, before any conversion", () => {
  it("answers 404 for an empty path, a directory named like a document, and anything that is not /o/<token>/<path>", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        mkdirSync(join(world.root, "dir.docx"));
        seed(world, "a.docx");
        for (const target of [
          `/o/${token}/`,
          `/o/${token}`,
          `/o/${token}/dir.docx`,
          `/o/${token}/dir.docx/`,
          `/o/${token}/a.docx/x.docx`,
          `/O/${token}/a.docx`,
          "/o//a.docx",
          `/o/${token}/%zz.docx`,
          `/o/${"a".repeat(101)}/a.docx`,
        ]) {
          expectFixedFailure(await rawAnswer(world.origin, target), 404);
        }
        for (const method of ["POST", "PUT", "DELETE", "OPTIONS"] as const) {
          expectFixedFailure(await rawAnswer(world.origin, `/o/${token}/a.docx`, { method }), 404);
        }
        expect(converter.convert).not.toHaveBeenCalled();
        expect(auditCount(world.db)).toEqual({ count: 0 });
        // The route is there: the same token and file, asked for properly.
        expect((await get(world, `/o/${token}/a.docx`)).status).toBe(200);
      },
      { converter },
    );
  });

  it("answers 403 for traversal and for symlinks, each leaving one sandbox.reject row of the token's account with op read", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        // A link named like a document, to a file outside the workspace.
        symlinkSync(join(world.sandboxRoot, "secret.txt"), join(world.root, "evil.docx"));
        const vectors = [
          ["%2e%2e/x.docx", "../x.docx"],
          ["%2e%2e/%2e%2e/etc/passwd.docx", "../../etc/passwd.docx"],
          ["link", "link"],
          ["linkdir/x", "linkdir/x"],
          ["linkdir/x.docx", "linkdir/x.docx"],
          ["evil.docx", "evil.docx"],
          ["../secret.docx", "../secret.docx"],
          ["/etc/passwd.docx", "/etc/passwd.docx"],
          ["a.docx%00.md", null],
        ] as const;
        for (const [path] of vectors) {
          const answer = await rawAnswer(world.origin, `/o/${token}/${path}`);

          expectFixedFailure(answer, 403);
          expect(answer.body).not.toContain(OUTSIDE_SECRET);
        }
        const rows = rejectRows(world.db);
        expect(rows).toHaveLength(vectors.length);
        expect(rows.slice(0, -1)).toEqual(
          vectors.slice(0, -1).map(([, relPath]) => rejectOf(String(relPath))),
        );
        expect(rows.at(-1)).toEqual(
          expect.objectContaining({ actor_id: ZHANGSAN, workspace_id: WORKSPACE_A, op: "read" }),
        );
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter },
    );
  });

  it("checks the token before the path: an unknown or expired token with a traversal is 404 and writes no audit row", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const expired = world.registry.issue(
          { ownerId: ZHANGSAN, workspaceId: WORKSPACE_A, embedOrigin: null },
          Date.now() - TTL_MS,
        ).token;
        seed(world, "a.docx");
        for (const target of [
          `/o/${UNKNOWN_TOKEN}/%2e%2e/%2e%2e/etc/passwd.docx`,
          `/o/${expired}/%2e%2e/x.docx`,
          `/o/${expired}/a.docx`,
        ]) {
          expectFixedFailure(await rawAnswer(world.origin, target), 404);
        }
        expect(auditCount(world.db)).toEqual({ count: 0 });
        expect(converter.convert).not.toHaveBeenCalled();
        // The route is there: a live token reads the same file.
        expect((await get(world, `/o/${await tokenForA(world)}/a.docx`)).status).toBe(200);
      },
      { converter },
    );
  });

  it("converts nothing of the owner's other workspace nor of another account's, whatever the request names", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        const lisiToken = (await world.issueToken(world.lisi, LISI_WORKSPACE)).token;
        const inB = join(world.sandboxRoot, ZHANGSAN, "other", "only-b.docx");
        const inLisi = join(world.sandboxRoot, LISI, "own", "only-b.docx");
        writeFileSync(inB, DOCX_BYTES);
        writeFileSync(inLisi, DOCX_BYTES);

        for (const target of [
          `/o/${token}/only-b.docx`,
          `/o/${token}/only-b.docx?workspaceId=${WORKSPACE_B}`,
          `/o/${token}/only-b.docx?workspaceId=${LISI_WORKSPACE}&ownerId=${LISI}`,
        ]) {
          expectFixedFailure(await rawAnswer(world.origin, target), 404);
        }
        expect(converter.convert).not.toHaveBeenCalled();
        // The same name is there to be converted, by the token of the workspace it is in.
        expect((await get(world, `/o/${lisiToken}/only-b.docx`)).status).toBe(200);
        expect(converter.convert.mock.calls).toStrictEqual([[inLisi, expect.any(AbortSignal)]]);
        expect(rejectRows(world.db)).toEqual([]);
      },
      { converter },
    );
  });

  it("answers 404 without an audit row once the workspace is gone or no longer the account's", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");
        expect((await get(world, `/o/${token}/a.docx`)).status).toBe(200);
        converter.convert.mockClear();
        world.db.prepare("UPDATE workspaces SET owner_id = ? WHERE id = ?").run(LISI, WORKSPACE_A);
        expectFixedFailure(await rawAnswer(world.origin, `/o/${token}/a.docx`), 404);
        world.db
          .prepare("UPDATE workspaces SET owner_id = ? WHERE id = ?")
          .run(ZHANGSAN, WORKSPACE_A);
        renameSync(world.root, `${world.root}-moved`);
        expectFixedFailure(await rawAnswer(world.origin, `/o/${token}/a.docx`), 404);

        expect(auditCount(world.db)).toEqual({ count: 0 });
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter },
    );
  });

  it("treats the path as data, deciding it exactly as /w/ decides the same bytes", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        mkdirSync(join(world.root, "sub"));
        seed(world, " lead.docx");
        seed(world, "trail.docx ");
        seed(world, "报告.docx");
        // U+00E9 on disk; the request spells it both ways.
        const composed = "caf\u00e9.docx";
        const decomposedName = composed.normalize("NFD");
        expect([composed.length, decomposedName.length]).toEqual([9, 10]);
        seed(world, composed);
        // [the wire path, what /w/ answers, what /o/ answers, the reject row's relPath if any]
        const vectors: Array<[string, number, number, string | null]> = [
          ["%20lead.docx", 200, 200, null],
          ["trail.docx%20", 200, 415, null],
          // A `..` segment is refused even when it stays inside the workspace.
          ["sub/%2e%2e/%E6%8A%A5%E5%91%8A.docx", 403, 403, "sub/../报告.docx"],
          ["sub/%2e%2e/%2e%2e/x.docx", 403, 403, "sub/../../x.docx"],
          ["/%E6%8A%A5%E5%91%8A.docx", 403, 403, "/报告.docx"],
          ["caf%C3%A9.docx", 200, 200, null],
        ];
        const handed: string[] = [];
        for (const [path, viaW, viaO] of vectors) {
          const w = await rawAnswer(world.origin, `/w/${token}/${path}`);
          const o = await rawAnswer(world.origin, `/o/${token}/${path}`);

          expect([path, w.status, o.status]).toEqual([path, viaW, viaO]);
          if (viaO === 415) {
            expectOfficeFailure(o, 415, TEXT.unsupported, path);
          }
          if (viaO === 200) {
            handed.push(String(converter.convert.mock.calls.at(-1)?.[0]));
          }
        }
        // The decomposed spelling: whether it names the same file is the file system's business
        // (it does on APFS, it does not on ext4). Either way /o/ follows /w/.
        const decomposed = "cafe%CC%81.docx";
        const w = await rawAnswer(world.origin, `/w/${token}/${decomposed}`);
        const o = await rawAnswer(world.origin, `/o/${token}/${decomposed}`);
        expect([200, 404]).toContain(w.status);
        expect(o.status).toBe(w.status);

        // Each row twice: once from /w/, once from /o/ — the same relPath, the same op.
        expect(rejectRows(world.db)).toEqual(
          vectors.flatMap(([, , , relPath]) =>
            relPath === null ? [] : [rejectOf(relPath), rejectOf(relPath)],
          ),
        );
        // The path is handed over as resolved, never re-spelled: no trimming, no normalization.
        expect(handed).toEqual([join(world.root, " lead.docx"), join(world.root, composed)]);
        if (o.status === 200) {
          expect(converter.convert.mock.calls.at(-1)?.[0]).toBe(join(world.root, decomposedName));
        }
      },
      { converter },
    );
  });
});
