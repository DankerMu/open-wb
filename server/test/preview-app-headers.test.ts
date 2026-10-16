/**
 * Issue #1069 (s1f-files-page tasks 12.1, 12.3): preview-origin 「预览响应头与内容类型」 as far as it
 * is observable only through the listener. The header table itself is pinned by
 * `preview-headers.test.ts`; here is the wiring — which function answers which response, with the
 * file's own name and the `embedOrigin` registered for the token. Oracles: the spec's literals.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  type Answer,
  DENIED_TEXT,
  expectNoSuccessHeaders,
  FAILURE_HEADERS,
  fromInject,
  MAIN_ORIGIN,
  NOT_FOUND_TEXT,
  type PreviewWorld,
  rawAnswer,
  WORKSPACE_A,
  withPreviewWorld,
} from "./preview-app-helpers.js";
import { failFirstReadOf } from "./workspace-file-helpers.js";

const SANDBOXED = "sandbox allow-scripts allow-forms allow-modals";
const HTML_AS_TEXT = "<!doctype html><script>alert(1)</script>";

afterEach(removeTempDirs);

async function request(
  world: PreviewWorld,
  url: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return fromInject(await world.preview.inject({ url, headers }));
}

/** The headers this module's requirement speaks of: everything but what the transport adds. */
function specHeaders(answer: Answer): Record<string, string> {
  const { date: _date, connection: _connection, ...rest } = answer.headers;
  return rest;
}

describe("preview listener headers: a success", () => {
  it("answers an HTML file with exactly the seven headers of an opaque-origin document", async () => {
    await withPreviewWorld(async (world) => {
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A, MAIN_ORIGIN);
      const answer = await request(world, `/w/${token}/site/index.html`);

      expect(answer.status).toBe(200);
      expect(specHeaders(answer)).toEqual({
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
        "content-security-policy": `${SANDBOXED}; frame-ancestors http://127.0.0.1:3000`,
        // The range sender's two, beside the seven.
        "accept-ranges": "bytes",
        "content-length": "78",
      });
      expect(answer.headers["content-security-policy"]).not.toContain("allow-same-origin");
      expect(answer.headers["content-security-policy"]).not.toContain("default-src");
    });
  });

  it("answers a PDF without sandbox, framed by the issuing origin or by nobody", async () => {
    await withPreviewWorld(async (world) => {
      writeFileSync(join(world.root, "doc.pdf"), "%PDF-1.4\n");
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A, MAIN_ORIGIN);
      const framed = await request(world, `/w/${token}/doc.pdf`);
      // Issued again by a client that sends no Origin: the same token, now embeddable nowhere.
      const reissued = await world.issueToken(world.zhangsan, WORKSPACE_A, null);
      const unframed = await request(world, `/w/${token}/doc.pdf`);

      expect(reissued.token).toBe(token);
      expect([framed.status, unframed.status]).toEqual([200, 200]);
      expect(framed.headers["content-type"]).toBe("application/pdf");
      expect(framed.headers["content-security-policy"]).toBe(
        "frame-ancestors http://127.0.0.1:3000",
      );
      expect(unframed.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    });
  });

  it("types a file by its name alone, whatever it holds", async () => {
    await withPreviewWorld(async (world) => {
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A);
      const expected = [
        ["notes.txt", "text/plain; charset=utf-8"],
        ["README", "application/octet-stream"],
        ["data.bin", "application/octet-stream"],
        ["a.svg", "image/svg+xml"],
        ["app.mjs", "text/javascript; charset=utf-8"],
      ] as const;
      for (const [name, contentType] of expected) {
        // Every one of them holds a page: only the name may decide.
        writeFileSync(join(world.root, name), HTML_AS_TEXT);
        const answer = await request(world, `/w/${token}/${name}`);

        expect(answer.status, name).toBe(200);
        expect(answer.headers["content-type"], name).toBe(contentType);
        expect(answer.body, name).toBe(HTML_AS_TEXT);
        expect(answer.headers["content-security-policy"], name).toBe(
          `${SANDBOXED}; frame-ancestors ${MAIN_ORIGIN}`,
        );
      }
    });
  });

  it("writes the registered embedOrigin only when it is one origin", async () => {
    await withPreviewWorld(async (world) => {
      writeFileSync(join(world.root, "a.html"), HTML_AS_TEXT);
      const injected = "http://a.test; sandbox allow-same-origin";
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A, injected);
      const refused = await request(world, `/w/${token}/a.html`);
      await world.issueToken(world.zhangsan, WORKSPACE_A, "https://preview.example.test");
      const accepted = await request(world, `/w/${token}/a.html`);

      expect(world.issueCalls[0]?.binding.embedOrigin).toBe(injected);
      expect(refused.headers["content-security-policy"]).toBe(
        `${SANDBOXED}; frame-ancestors 'none'`,
      );
      for (const value of Object.values(refused.headers)) {
        expect(value).not.toContain("a.test");
      }
      expect(accepted.headers["content-security-policy"]).toBe(
        `${SANDBOXED}; frame-ancestors https://preview.example.test`,
      );
    });
  });
});

describe("preview listener headers: a failure", () => {
  it("answers 404, 403 and 416 with the four failure headers and none of a success", async () => {
    await withPreviewWorld(async (world) => {
      writeFileSync(join(world.root, "clip.mp4"), Buffer.alloc(1000, 7));
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A);
      const unknown = await request(world, `/w/${"d".repeat(64)}/a.html`);
      const missing = await request(world, `/w/${token}/missing.html`);
      const denied = await rawAnswer(world.origin, `/w/${token}/%2e%2e/x`);
      const unsatisfiable = await request(world, `/w/${token}/clip.mp4`, {
        range: "bytes=1000-",
      });

      for (const answer of [unknown, missing]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toBe(NOT_FOUND_TEXT);
        expect(specHeaders(answer)).toEqual({ ...FAILURE_HEADERS, "content-length": "27" });
      }
      expect(denied.status).toBe(403);
      expect(denied.body).toBe(DENIED_TEXT);
      expect(specHeaders(denied)).toEqual({ ...FAILURE_HEADERS, "content-length": "27" });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.body).toBe("");
      expect(specHeaders(unsatisfiable)).toEqual({
        ...FAILURE_HEADERS,
        "content-range": "bytes */1000",
        "content-length": "0",
      });
    });
  });

  it("answers an empty 500 with the four failure headers when the first read of the opened file fails", async () => {
    await withPreviewWorld(async (world) => {
      writeFileSync(join(world.root, "gone.html"), HTML_AS_TEXT);
      const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A);
      const failedReads = failFirstReadOf(join(world.root, "gone.html"));
      const answer = await rawAnswer(world.origin, `/w/${token}/gone.html`, {
        headers: { range: "bytes=0-9" },
      });

      expect(failedReads()).toBe(1);
      expect(answer.status).toBe(500);
      expect(answer.body).toBe("");
      expect(specHeaders(answer)).toEqual({ ...FAILURE_HEADERS, "content-length": "0" });
      expectNoSuccessHeaders(answer);
      // The framework's own answer would carry the error it got.
      expect(JSON.stringify(answer)).not.toContain(world.sandboxRoot);
    });
  });
});
