/**
 * Issue #1074 (s1f-files-page tasks 15.1–15.3): `GET /o/<token>/<path>` of the preview listener,
 * office-preview 「办公文档预览路由」 — its four scenarios. The real `createPreviewApp` beside a real
 * main app that issues the tokens (`preview-app-helpers.ts`); the converter is a recording stand-in
 * at the constructor's seam (`preview-office-helpers.ts`), so no office binary is involved. The
 * disconnect cases go over a real socket (`inject` has no connection to close). Oracles: the spec's
 * status codes and its six texts, copied as literals, and the bytes written here. The path and
 * token boundary of the route is in `preview-office-route-boundary.test.ts`.
 */
import { Agent, get as httpGet } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeConvertError } from "../src/preview/office.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";
import {
  expectFixedFailure,
  expectNoSuccessHeaders,
  FAILURE_HEADERS,
  MAIN_ORIGIN,
  rawAnswer,
  rejectRows,
  WORKSPACE_A,
  withPreviewWorld,
} from "./preview-app-helpers.js";
import {
  bytesOf,
  expectOfficeFailure,
  failing,
  get,
  PDF_BYTES,
  rejectOf,
  type StandIn,
  seed,
  standIn,
  TEXT,
  tokenForA,
  UNKNOWN_TOKEN,
  until,
} from "./preview-office-helpers.js";
import { auditCount } from "./workspaces-http-helpers.js";

const SMALL_LIMIT = 1000;

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

describe("office preview route: 成功与缓存", () => {
  it("answers the PDF twice and then its first ten bytes, with the PDF headers and no sandbox, handing the converter the file's absolute path", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "报告.docx");
        const target = `/o/${token}/${encodeURIComponent("报告.docx")}`;

        const first = await get(world, target);
        const second = await get(world, target);
        const ranged = await get(world, target, { range: "bytes=0-9" });

        for (const whole of [first, second]) {
          expect(whole.status).toBe(200);
          expect(whole.headers.get("content-type")).toBe("application/pdf");
          // The whole value: `sandbox` anywhere in it would stop the built-in viewer.
          expect(whole.headers.get("content-security-policy")).toBe(
            `frame-ancestors ${MAIN_ORIGIN}`,
          );
          expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
          expect(whole.headers.get("cache-control")).toBe("no-store");
          expect(whole.headers.get("referrer-policy")).toBe("no-referrer");
          expect(whole.headers.get("access-control-allow-origin")).toBe("*");
          expect(whole.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
          expect(whole.headers.get("accept-ranges")).toBe("bytes");
          expect(whole.headers.get("content-length")).toBe(String(PDF_BYTES.length));
          expect(whole.headers.get("content-range")).toBeNull();
          expect(whole.headers.get("content-disposition")).toBeNull();
          expect(whole.headers.get("set-cookie")).toBeNull();
          expect((await bytesOf(whole)).equals(PDF_BYTES)).toBe(true);
        }
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("content-type")).toBe("application/pdf");
        expect(ranged.headers.get("content-security-policy")).toBe(
          `frame-ancestors ${MAIN_ORIGIN}`,
        );
        expect(ranged.headers.get("content-range")).toBe(`bytes 0-9/${PDF_BYTES.length}`);
        expect(ranged.headers.get("content-length")).toBe("10");
        expect((await bytesOf(ranged)).equals(PDF_BYTES.subarray(0, 10))).toBe(true);

        // The route has no cache of its own (that is the converter's): one call per request.
        const call = [join(world.root, "报告.docx"), expect.any(AbortSignal)];
        expect(converter.convert.mock.calls).toStrictEqual([call, call, call]);
        expect(auditCount(world.db)).toEqual({ count: 0 });
      },
      { converter },
    );
  });

  it("answers 416 with the failure headers for a range past the end of the PDF", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        const answer = await rawAnswer(world.origin, `/o/${token}/a.docx`, {
          headers: { Range: `bytes=${PDF_BYTES.length}-` },
        });

        expect(answer.status).toBe(416);
        expect(answer.body).toBe("");
        expect(answer.headers["content-range"]).toBe(`bytes */${PDF_BYTES.length}`);
        expect(answer.headers).toMatchObject(FAILURE_HEADERS);
        expect(answer.headers["content-security-policy"]).toBeUndefined();
      },
      { converter },
    );
  });

  it("answers HEAD with the headers of the GET and no body, converting like a GET", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        const head = await rawAnswer(world.origin, `/o/${token}/a.docx`, { method: "HEAD" });

        expect(head.status).toBe(200);
        expect(head.headers["content-type"]).toBe("application/pdf");
        expect(head.headers["content-length"]).toBe(String(PDF_BYTES.length));
        expect(head.body).toBe("");
        expect(converter.convert).toHaveBeenCalledTimes(1);
      },
      { converter },
    );
  });

  it("types the response as a PDF with a frame-ancestors of 'none' when the token was issued without an embedding origin", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const { token } = await world.issueToken(world.zhangsan, WORKSPACE_A, null);
        // A name whose own type would be HTML if the route typed by it.
        seed(world, "page.html.docx");

        const response = await get(world, `/o/${token}/page.html.docx`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/pdf");
        expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
        expect((await bytesOf(response)).equals(PDF_BYTES)).toBe(true);
      },
      { converter },
    );
  });

  it("accepts the three extensions in any letter case and hands over the name as it is on disk", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        // `.docx` alone: the text after its last dot is `docx` (the spec states no other rule).
        const names = ["A.DOCX", "b.Xlsx", "c.pptx", "d.tar.docx", ".docx"];
        for (const name of names) {
          seed(world, name);
          const response = await get(world, `/o/${token}/${name}`);

          expect(response.status, name).toBe(200);
          expect((await bytesOf(response)).equals(PDF_BYTES), name).toBe(true);
        }
        expect(converter.convert.mock.calls.map(([absInput]) => absInput)).toEqual(
          names.map((name) => join(world.root, name)),
        );
      },
      { converter },
    );
  });

  it("admits a document of exactly the limit", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "exact.xlsx", SMALL_LIMIT);

        const response = await get(world, `/o/${token}/exact.xlsx`);

        expect(response.status).toBe(200);
        expect((await bytesOf(response)).equals(PDF_BYTES)).toBe(true);
        expect(converter.convert).toHaveBeenCalledTimes(1);
      },
      { converter, documentMaxBytes: SMALL_LIMIT },
    );
  });
});

describe("office preview route: 拒绝在转换之前", () => {
  it("answers 415, 415, 413, 404, 403 with one audit row, and 404 — and never calls convert", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "doc.pdf", "%PDF-1.4\n");
        seed(world, "huge.xlsx", SMALL_LIMIT + 1);
        const requests: Array<[target: string, status: number, text: string | null]> = [
          [`/o/${token}/readme.md`, 415, TEXT.unsupported],
          [`/o/${token}/doc.pdf`, 415, TEXT.unsupported],
          [`/o/${token}/huge.xlsx`, 413, TEXT.tooLarge],
          [`/o/${token}/gone.docx`, 404, null],
          [`/o/${token}/%2e%2e/x.docx`, 403, null],
          [`/o/${UNKNOWN_TOKEN}/a.docx`, 404, null],
        ];
        for (const [target, status, text] of requests) {
          const answer = await rawAnswer(world.origin, target);
          if (text === null) {
            expectFixedFailure(answer, status as 403 | 404);
          } else {
            expectOfficeFailure(answer, status, text, target);
          }
        }

        expect(rejectRows(world.db)).toEqual([rejectOf("../x.docx")]);
        expect(auditCount(world.db)).toEqual({ count: 1 });
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter, documentMaxBytes: SMALL_LIMIT },
    );
  });

  it("answers 503 with the not-enabled text when the converter is unavailable, without calling convert", async () => {
    const converter = standIn(undefined, false);
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");
        seed(world, "huge.xlsx", SMALL_LIMIT + 1);

        const answer = await rawAnswer(world.origin, `/o/${token}/a.docx`);
        // The earlier checks still come first: availability is asked last of the four.
        const earlier: Array<[target: string, status: number, text: string]> = [
          [`/o/${token}/readme.md`, 415, TEXT.unsupported],
          [`/o/${token}/huge.xlsx`, 413, TEXT.tooLarge],
        ];

        expectOfficeFailure(answer, 503, TEXT.unavailable);
        for (const [target, status, text] of earlier) {
          expectOfficeFailure(await rawAnswer(world.origin, target), status, text, target);
        }
        expectFixedFailure(await rawAnswer(world.origin, `/o/${token}/gone.docx`), 404);
        expect(converter.convert).not.toHaveBeenCalled();
        expect(auditCount(world.db)).toEqual({ count: 0 });
      },
      { converter, documentMaxBytes: SMALL_LIMIT },
    );
  });

  it("checks the extension before the size: an oversized file of another type is 415", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "huge.md", SMALL_LIMIT + 1);

        const answer = await rawAnswer(world.origin, `/o/${token}/huge.md`);

        expectOfficeFailure(answer, 415, TEXT.unsupported);
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter, documentMaxBytes: SMALL_LIMIT },
    );
  });

  it("answers 415 for every name whose text after the last dot is not exactly one of the three", async () => {
    const converter = standIn();
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        const names = [
          "a.docx ",
          "a.docx.bak",
          "docx",
          "a.doc",
          "a.docxx",
          "a.xdocx",
          "docx.",
          "a.docx.",
          "a.pdf",
        ];
        for (const name of names) {
          seed(world, name);
          const answer = await rawAnswer(world.origin, `/o/${token}/${encodeURIComponent(name)}`);

          expectOfficeFailure(answer, 415, TEXT.unsupported, JSON.stringify(name));
        }
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter },
    );
  });

  it("answers 503 busy without calling convert until the entry reports the work directory cleared", async () => {
    const converter = standIn();
    let ready = false;
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        const before = await rawAnswer(world.origin, `/o/${token}/a.docx`);
        // Still after the extension check: what cannot be converted is not "busy".
        const wrongType = await rawAnswer(world.origin, `/o/${token}/readme.md`);
        expect(converter.convert).not.toHaveBeenCalled();
        ready = true;
        const after = await get(world, `/o/${token}/a.docx`);

        expectOfficeFailure(before, 503, TEXT.busy);
        expectOfficeFailure(wrongType, 415, TEXT.unsupported);
        expect(after.status).toBe(200);
        expect((await bytesOf(after)).equals(PDF_BYTES)).toBe(true);
        expect(converter.convert).toHaveBeenCalledTimes(1);
      },
      { converter, officeReady: () => ready },
    );
  });

  it("says not-enabled rather than busy when the converter is unavailable and the entry is not ready either", async () => {
    const converter = standIn(undefined, false);
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        expectOfficeFailure(
          await rawAnswer(world.origin, `/o/${token}/a.docx`),
          503,
          TEXT.unavailable,
        );
        expect(converter.convert).not.toHaveBeenCalled();
      },
      { converter, officeReady: () => false },
    );
  });
});

describe("office preview route: 转换结果到状态码", () => {
  it.each([
    ["failed", 502, TEXT.failed],
    ["timeout", 504, TEXT.timeout],
    ["busy", 503, TEXT.busy],
    ["unavailable", 503, TEXT.unavailable],
  ] as const)(
    "answers a convert that fails with %s by %i and its fixed text, naming neither file nor path",
    async (kind, status, text) => {
      const converter = failing(kind);
      await withPreviewWorld(
        async (world) => {
          const token = await tokenForA(world);
          seed(world, "zq-unique-marker.docx");
          const target = `/o/${token}/zq-unique-marker.docx`;

          const overSocket = await rawAnswer(world.origin, target);
          const head = await rawAnswer(world.origin, target, { method: "HEAD" });

          // `toBe` on the whole body: no file name, no path, no token, nothing appended.
          expectOfficeFailure(overSocket, status, text);
          expect(overSocket.headers["content-type"]).toBe("text/plain; charset=utf-8");
          expect(head.status).toBe(status);
          expect(head.body).toBe("");
          expect(converter.convert).toHaveBeenCalledTimes(2);
          expect(auditCount(world.db)).toEqual({ count: 0 });
        },
        { converter },
      );
    },
  );

  it("answers 502 with the failed text when the converted file is gone by the time it is sent", async () => {
    const gone = join(tempDir(), "swept.pdf");
    const converter = standIn(() => Promise.resolve(gone));
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        expectOfficeFailure(await rawAnswer(world.origin, `/o/${token}/a.docx`), 502, TEXT.failed);
        expect(converter.convert).toHaveBeenCalledTimes(1);
      },
      { converter },
    );
  });

  it("answers the empty 500 with the failure headers when convert fails with anything else, echoing nothing of the error", async () => {
    const converter = standIn(() =>
      Promise.reject(new Error("ENOENT: /srv/cache/work/zq-unique-marker")),
    );
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        seed(world, "a.docx");

        const answer = await rawAnswer(world.origin, `/o/${token}/a.docx`);

        expect(answer.status).toBe(500);
        expect(answer.body).toBe("");
        expect(answer.headers).toMatchObject(FAILURE_HEADERS);
        expectNoSuccessHeaders(answer);
      },
      { converter },
    );
  });
});

describe("office preview route: 客户端断开即中止", () => {
  interface Wired {
    /** Every connection the listener accepted, in order. */
    sockets: Socket[];
    rejections: unknown[];
    release(): void;
  }

  /** Watches the listener's own sockets and the process for unhandled rejections. */
  function wire(): Wired & { beforeListen(preview: { server: NodeJS.EventEmitter }): void } {
    const sockets: Socket[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    return {
      sockets,
      rejections,
      release: () => process.off("unhandledRejection", onRejection),
      beforeListen: (preview) => {
        preview.server.on("connection", (socket: Socket) => sockets.push(socket));
      },
    };
  }

  /** Pends until its signal aborts, then fails as the real converter does. */
  function pending(): StandIn {
    return standIn(
      (_absInput, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new OfficeConvertError("aborted")), {
            once: true,
          });
        }),
    );
  }

  it("aborts the signal handed to convert when the client closes the connection, writing no response byte and leaving no unhandled rejection", async () => {
    const converter = pending();
    const wired = wire();
    try {
      await withPreviewWorld(
        async (world) => {
          const token = await tokenForA(world);
          seed(world, "a.docx");
          const { port } = new URL(world.origin);
          const client = connectTcp({ host: "127.0.0.1", port: Number(port) });
          client.on("error", () => undefined);
          let received = 0;
          client.on("data", (chunk: Buffer) => {
            received += chunk.length;
          });
          client.write(`GET /o/${token}/a.docx HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
          await until(() => converter.convert.mock.calls.length === 1, "convert to be called");
          const signal = converter.convert.mock.calls[0]?.[1];
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal?.aborted).toBe(false);
          expect(wired.sockets).toHaveLength(1);

          client.destroy();
          await until(() => signal?.aborted === true, "the signal to abort");
          // Long enough for a response to be written, were one coming.
          await delay(100);

          expect(converter.convert).toHaveBeenCalledTimes(1);
          expect(signal?.aborted).toBe(true);
          expect(wired.sockets[0]?.bytesWritten).toBe(0);
          expect(received).toBe(0);
          expect(wired.rejections).toEqual([]);
        },
        { converter, beforeListen: wired.beforeListen },
      );
    } finally {
      wired.release();
    }
  });

  it("ends a request whose conversion was aborted from the converter's side by closing the connection, again without a byte", async () => {
    // What the entry's shutdown does: `close()` fails the calls in flight with `aborted`.
    let abortAll: () => void = () => undefined;
    const converter = standIn(
      () =>
        new Promise((_resolve, reject) => {
          abortAll = () => reject(new OfficeConvertError("aborted"));
        }),
    );
    const wired = wire();
    try {
      await withPreviewWorld(
        async (world) => {
          const token = await tokenForA(world);
          seed(world, "a.docx");

          const answering = rawAnswer(world.origin, `/o/${token}/a.docx`).then(
            (answer) => ({ answer }),
            (error: unknown) => ({ error }),
          );
          await until(() => converter.convert.mock.calls.length === 1, "convert to be called");
          abortAll();
          const outcome = await answering;

          // The connection was closed on the client: no status line, no header, no body.
          if ("answer" in outcome) {
            expect(outcome.answer.body).toBe("");
            expect(Number.isNaN(outcome.answer.status)).toBe(true);
          }
          expect(wired.sockets[0]?.bytesWritten).toBe(0);
          await delay(50);
          expect(wired.rejections).toEqual([]);
        },
        { converter, beforeListen: wired.beforeListen },
      );
    } finally {
      wired.release();
    }
  });

  it("leaves the signal unaborted and no listener behind on a connection that is reused after the conversion settled", async () => {
    const converter = standIn();
    const wired = wire();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const fetchOver = (url: string): Promise<number> =>
      new Promise((resolve, reject) => {
        httpGet(url, { agent }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        }).once("error", reject);
      });
    try {
      await withPreviewWorld(
        async (world) => {
          const token = await tokenForA(world);
          seed(world, "a.docx");

          expect(await fetchOver(`${world.origin}/w/${token}/readme.md`)).toBe(200);
          const socket = wired.sockets[0];
          const baseline = socket?.listenerCount("close");
          for (let round = 0; round < 12; round += 1) {
            expect(await fetchOver(`${world.origin}/o/${token}/a.docx`)).toBe(200);
          }

          // One connection carried all thirteen requests.
          expect(wired.sockets).toHaveLength(1);
          expect(socket?.listenerCount("close")).toBe(baseline);
          agent.destroy();
          await until(() => socket?.destroyed === true, "the connection to close");
          await delay(20);
          expect(converter.convert.mock.calls.map(([, signal]) => signal?.aborted)).toEqual(
            Array.from({ length: 12 }, () => false),
          );
          expect(wired.rejections).toEqual([]);
        },
        { converter, beforeListen: wired.beforeListen },
      );
    } finally {
      agent.destroy();
      wired.release();
    }
  });
});
