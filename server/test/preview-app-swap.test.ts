/**
 * Issue 1492 (change sandbox-boundary-closure, S2): the preview listener sends what it opened.
 * preview-origin 「预览监听器」 scenarios 「lstat 之后目标被换入」 and 「范围请求」 (the descriptor of a
 * 416), the new semantics that a path unlinked after the open does not reach the response, and
 * office-preview 「办公文档预览路由」 scenario 「转出的 PDF 在发送之前被换入」. Every swap is made by a
 * hook around the open (钩子辅助复现), not by a natural race.
 */
import fs, { closeSync, ftruncateSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./core-db-helpers.js";
import {
  type Answer,
  expectFixedFailure,
  expectNoSuccessHeaders,
  FAILURE_HEADERS,
  fromInject,
  OUTSIDE_SECRET,
  type PreviewWorld,
  rejectRows,
  WORKSPACE_A,
  withPreviewWorld,
} from "./preview-app-helpers.js";
import { expectOfficeFailure, PDF_BYTES, seed, standIn, TEXT } from "./preview-office-helpers.js";
import {
  descriptorsOf,
  expectSwappedUnread,
  type SwapKind,
  spyBodyIo,
  swapIn,
  swapOnFirstOpen,
} from "./workspace-file-helpers.js";
import { auditCount } from "./workspaces-http-helpers.js";

/** 1000 bytes, byte i is i % 251: no two aligned windows of the file are equal. */
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_unused, index) => index % 251));
const SWAP_KINDS: readonly SwapKind[] = ["pipe", "symlink", "directory"];
const UNLINK_HEADER = "x-test-unlink";

async function request(
  world: PreviewWorld,
  url: string,
  headers: Record<string, string> = {},
): Promise<Answer & { raw: Buffer }> {
  const response = await world.preview.inject({ url, headers });
  return { ...fromInject(response), raw: response.rawPayload };
}

async function tokenOf(world: PreviewWorld): Promise<string> {
  return (await world.issueToken(world.zhangsan, WORKSPACE_A)).token;
}

describe("preview listener /w/: the target is swapped between the lstat and the open", () => {
  it.each(SWAP_KINDS)(
    "site/index.html swapped for a %s: the fixed 404, nothing streamed or read, no audit row",
    async (kind) => {
      await withPreviewWorld(async (world) => {
        const token = await tokenOf(world);
        // Another account's file, inside the sandbox root.
        const linkTo = join(world.sandboxRoot, "u3", "own", "only-b.txt");
        const swapped = swapOnFirstOpen(join(world.root, "site", "index.html"), (target) =>
          swapIn(kind, target, linkTo),
        );
        const started = performance.now();
        try {
          const answer = await request(world, `/w/${token}/site/index.html`);
          const elapsedMs = performance.now() - started;

          expectFixedFailure(answer, 404);
          expect(answer.body).not.toContain(token);
          expect(answer.body).not.toContain("lisi");
          expectSwappedUnread(swapped.record(), kind, elapsedMs);
          expect(rejectRows(world.db)).toEqual([]);
        } finally {
          swapped.cleanup();
        }
      });
    },
    15_000,
  );
});

describe("preview listener /w/: ranges against the opened file", () => {
  it("answers 206, then a 416 that opened the file once and closed it unread, then 200", async () => {
    await withPreviewWorld(async (world) => {
      const target = join(world.root, "clip.mp4");
      writeFileSync(target, CLIP);
      const token = await tokenOf(world);
      spyBodyIo();
      const closeSync = vi.spyOn(fs, "closeSync");
      syncBuiltinESMExports();

      const partial = await request(world, `/w/${token}/clip.mp4`, { range: "bytes=0-99" });
      expect(partial.status).toBe(206);
      expect(partial.headers["content-range"]).toBe("bytes 0-99/1000");
      expect(partial.raw.equals(CLIP.subarray(0, 100))).toBe(true);

      const reads = vi.mocked(fs.read).mock.calls.length;
      const unsatisfiable = await request(world, `/w/${token}/clip.mp4`, { range: "bytes=1000-" });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers["content-range"]).toBe("bytes */1000");
      expect(unsatisfiable.body).toBe("");
      const [, opened] = descriptorsOf(target);
      expect(descriptorsOf(target)).toHaveLength(2);
      expect(closeSync.mock.calls.map(([fd]) => fd)).toEqual([opened]);
      expect(vi.mocked(fs.read).mock.calls.length).toBe(reads);
      expect(vi.mocked(fs.createReadStream)).toHaveBeenCalledTimes(1);

      const whole = await request(world, `/w/${token}/clip.mp4`);
      expect(whole.status).toBe(200);
      expect(whole.headers["accept-ranges"]).toBe("bytes");
      expect(whole.raw.equals(CLIP)).toBe(true);
    });
  });

  it("still answers 206 from the opened inode when the path is unlinked after the open", async () => {
    await withPreviewWorld(
      async (world) => {
        writeFileSync(join(world.root, "clip.mp4"), CLIP);
        const token = await tokenOf(world);

        const answer = await request(world, `/w/${token}/clip.mp4`, {
          range: "bytes=0-99",
          [UNLINK_HEADER]: "1",
        });

        expect(answer.status).toBe(206);
        expect(answer.headers["content-range"]).toBe("bytes 0-99/1000");
        expect(answer.headers["content-length"]).toBe("100");
        expect(answer.raw.equals(CLIP.subarray(0, 100))).toBe(true);
        expect(fs.existsSync(join(world.root, "clip.mp4"))).toBe(false);
      },
      {
        // After the handler opened the file and handed its descriptor to the stream.
        beforeListen: (preview, root) => {
          preview.addHook("onSend", (incoming, _reply, _payload, done) => {
            if (incoming.headers[UNLINK_HEADER] !== undefined) {
              unlinkSync(join(root, "clip.mp4"));
            }
            done();
          });
        },
      },
    );
  });
});

describe("preview listener: the size is the opened inode's", () => {
  /** Cuts `target` to `size` bytes the moment the route opens it, through a descriptor opened before. */
  function cutOnOpen(target: string, size: number): () => void {
    const writer = openSync(target, "r+");
    swapOnFirstOpen(target, () => {
      ftruncateSync(writer, size);
      return undefined;
    });
    return () => closeSync(writer);
  }

  it("/w/ answers a file cut short after the lstat with the length and bytes it has when opened", async () => {
    await withPreviewWorld(async (world) => {
      const target = join(world.root, "clip.mp4");
      writeFileSync(target, CLIP);
      const token = await tokenOf(world);
      const release = cutOnOpen(target, 600);
      try {
        const answer = await request(world, `/w/${token}/clip.mp4`);

        expect(answer.status).toBe(200);
        expect(answer.headers["content-length"]).toBe("600");
        expect(answer.raw.equals(CLIP.subarray(0, 600))).toBe(true);
      } finally {
        release();
      }
    });
  });

  it("/o/ answers a cached PDF cut short after the lstat with the length and bytes it has when opened", async () => {
    const pdf = join(tempDir(), "0123abcd.pdf");
    writeFileSync(pdf, PDF_BYTES);
    const converter = standIn(() => Promise.resolve(pdf));
    await withPreviewWorld(
      async (world) => {
        const token = await tokenOf(world);
        seed(world, "报告.docx");
        const release = cutOnOpen(pdf, 10);
        try {
          const answer = await request(world, `/o/${token}/${encodeURIComponent("报告.docx")}`);

          expect(answer.status).toBe(200);
          expect(answer.headers["content-length"]).toBe("10");
          expect(answer.raw.equals(PDF_BYTES.subarray(0, 10))).toBe(true);
        } finally {
          release();
        }
      },
      { converter },
    );
  });
});

describe("preview listener /o/: the converted PDF is swapped before it is sent", () => {
  it.each(SWAP_KINDS)(
    "the cached PDF swapped for a %s after the lstat: 502 with the failed text, nothing read",
    async (kind) => {
      const pdf = join(tempDir(), "0123abcd.pdf");
      writeFileSync(pdf, PDF_BYTES);
      const converter = standIn(() => Promise.resolve(pdf));
      await withPreviewWorld(
        async (world) => {
          const token = await tokenOf(world);
          seed(world, "报告.docx");
          const swapped = swapOnFirstOpen(pdf, (target) =>
            swapIn(kind, target, join(world.sandboxRoot, "secret.txt")),
          );
          const started = performance.now();
          try {
            const answer = await request(world, `/o/${token}/${encodeURIComponent("报告.docx")}`);
            const elapsedMs = performance.now() - started;

            expectOfficeFailure(answer, 502, TEXT.failed);
            expect(answer.body).not.toContain(OUTSIDE_SECRET);
            expect(converter.convert).toHaveBeenCalledTimes(1);
            expectSwappedUnread(swapped.record(), kind, elapsedMs);
            expect(auditCount(world.db)).toEqual({ count: 0 });
          } finally {
            swapped.cleanup();
          }
        },
        { converter },
      );
    },
    15_000,
  );

  it("an open of the cached PDF refused for any other reason is the empty 500, not a 502", async () => {
    const pdf = join(tempDir(), "0123abcd.pdf");
    writeFileSync(pdf, PDF_BYTES);
    const converter = standIn(() => Promise.resolve(pdf));
    await withPreviewWorld(
      async (world) => {
        const token = await tokenOf(world);
        seed(world, "报告.docx");
        swapOnFirstOpen(pdf, (target) => {
          throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
            code: "EACCES",
            errno: -13,
            syscall: "open",
            path: target,
          });
        });

        const answer = await request(world, `/o/${token}/${encodeURIComponent("报告.docx")}`);

        expect(answer.status).toBe(500);
        expect(answer.body).toBe("");
        expect(answer.headers).toMatchObject(FAILURE_HEADERS);
        expectNoSuccessHeaders(answer);
        expect(JSON.stringify(answer)).not.toContain(pdf);
      },
      { converter },
    );
  });
});
