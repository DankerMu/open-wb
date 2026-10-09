/**
 * Issue 1023 (parent task 13.3) `uploadFile()` over a controllable `XMLHttpRequest`: the four
 * cases of the chat-web scenario 「上传传输」 of openspec/changes/s1g-composer-capabilities and the
 * extras of the task's implementation notes. Seam: the real `createApiClient` over a stubbed
 * `XMLHttpRequest` global. Oracles: the request, the progress sequence and the failures spelled
 * out by that scenario, and the upload transport of design D10.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { captureApiError, expectRequestFailure, unauthorizedResponseCases } from "./support.js";
import { FakeXhr, installFakeXhr, lastFakeXhr, resetFakeXhr } from "./upload-support.js";

const WORKSPACE = "0123456789abcdef0123456789abcdef";
const UPLOADS = `/api/workspaces/${WORKSPACE}/uploads?name=%E6%8A%A5%E5%91%8A%201.pdf`;
const UPLOADED = { path: "uploads/报告 1.pdf", name: "报告 1.pdf", size: 10 };

function report() {
  return new File(["0123456789"], "报告 1.pdf", { type: "application/pdf" });
}

/** Starts one upload and hands back the request double it created. */
function start(
  options: {
    onProgress?: (percent: number) => void;
    onUnauthorized?: () => void;
    signal?: AbortSignal;
    workspaceId?: string;
    file?: File;
  } = {},
) {
  installFakeXhr();
  const file = options.file ?? report();
  const client = createApiClient(
    options.onUnauthorized ? { onUnauthorized: options.onUnauthorized } : {},
  );
  const upload = client.uploadFile(options.workspaceId ?? WORKSPACE, file, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return { file, upload, xhr: lastFakeXhr() };
}

/** The failure of an upload answered with `status` and `responseText`. */
function rejection(status: number, responseText: string, onUnauthorized?: () => void) {
  const { upload, xhr } = start(onUnauthorized ? { onUnauthorized } : {});
  xhr.respond(status, responseText);
  return captureApiError(upload);
}

afterEach(() => {
  resetFakeXhr();
  vi.unstubAllGlobals();
});

describe("uploadFile (上传传输)", () => {
  it("POSTs the File itself as an octet stream, reports 50 then 100 and returns the 201 body", async () => {
    const onProgress = vi.fn<(percent: number) => void>();
    const { signal } = new AbortController();
    const { file, upload, xhr } = start({ onProgress, signal });

    expect(xhr.opens).toEqual([["POST", UPLOADS]]);
    expect(xhr.headers).toEqual([["Content-Type", "application/octet-stream"]]);
    expect(xhr.bodies).toHaveLength(1);
    expect(xhr.bodies[0]).toBe(file);
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.responseType).toBe("");
    expect(xhr.timeout).toBe(0);

    xhr.progress(5, 10);
    xhr.progress(10, 10);
    xhr.respond(201, JSON.stringify(UPLOADED));

    await expect(upload).resolves.toEqual(UPLOADED);
    expect(onProgress.mock.calls).toEqual([[50], [100]]);
    expect(xhr.aborts).toBe(0);
  });

  it("rounds a progress step down to a whole percent", () => {
    const onProgress = vi.fn<(percent: number) => void>();
    const { upload, xhr } = start({ onProgress });
    void upload.catch(() => undefined);

    xhr.progress(1, 3);
    xhr.progress(2, 3);

    expect(onProgress.mock.calls).toEqual([[33], [66]]);
  });

  it("reports no progress while the total is unknown or zero, and none on load", async () => {
    const onProgress = vi.fn<(percent: number) => void>();
    const { upload, xhr } = start({ onProgress });

    xhr.progress(5, 10, false);
    xhr.progress(0, 0);
    xhr.respond(201, JSON.stringify(UPLOADED));

    await expect(upload).resolves.toEqual(UPLOADED);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("encodes the workspace id and the file name as one path segment and one query value", () => {
    const { upload, xhr } = start({
      workspaceId: "a b/c",
      file: new File(["x"], "a&b=c d#e.txt"),
    });
    void upload.catch(() => undefined);

    expect(xhr.opens).toEqual([
      ["POST", "/api/workspaces/a%20b%2Fc/uploads?name=a%26b%3Dc%20d%23e.txt"],
    ]);
  });

  it("rejects a 413 envelope with its status, code and message", async () => {
    const onUnauthorized = vi.fn();
    const error = await rejection(
      413,
      JSON.stringify({ error: { code: "upload_too_large", message: "文件超过大小上限" } }),
      onUnauthorized,
    );

    expect(error).toMatchObject({
      status: 413,
      code: "upload_too_large",
      message: "文件超过大小上限",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("aborts the request once when the signal aborts in flight and notifies nobody", async () => {
    const onUnauthorized = vi.fn();
    const controller = new AbortController();
    const { upload, xhr } = start({ onUnauthorized, signal: controller.signal });
    const failure = captureApiError(upload);

    controller.abort();

    expect(xhr.aborts).toBe(1);
    expectRequestFailure(await failure, 0);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("opens no request for a signal that is already aborted", async () => {
    const onUnauthorized = vi.fn();
    const controller = new AbortController();
    controller.abort();
    installFakeXhr();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).uploadFile(WORKSPACE, report(), {
        signal: controller.signal,
      }),
    );

    expectRequestFailure(error, 0);
    expect(FakeXhr.instances.flatMap((xhr) => xhr.opens)).toEqual([]);
    expect(FakeXhr.instances.flatMap((xhr) => xhr.bodies)).toEqual([]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each([
    ["a 201", (xhr: FakeXhr) => xhr.respond(201, JSON.stringify(UPLOADED))],
    ["a 413", (xhr: FakeXhr) => xhr.respond(413, "{}")],
    ["a network failure", (xhr: FakeXhr) => xhr.dispatchEvent(new Event("error"))],
  ])("stops listening to the signal once the upload settled with %s", async (_kind, settle) => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const { upload, xhr } = start({ signal: controller.signal });

    settle(xhr);
    await upload.catch(() => undefined);
    controller.abort();

    expect(xhr.aborts).toBe(0);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]?.[0]).toBe("abort");
  });

  it.each(unauthorizedResponseCases())(
    "notifies unauthorized once for %s 401",
    async (kind, response) => {
      const onUnauthorized = vi.fn();
      const { signal } = new AbortController();
      const { upload, xhr } = start({ onUnauthorized, signal });

      xhr.respond(401, await response.text());
      const error = await captureApiError(upload);

      expect(error.status).toBe(401);
      expect(error.code).toBe(kind === "a legal" ? "unauthorized" : "request_failed");
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledWith(signal);
    },
  );

  it("fails a network error as request_failed with status 0", async () => {
    const onUnauthorized = vi.fn();
    const { upload, xhr } = start({ onUnauthorized });

    xhr.dispatchEvent(new Event("error"));

    expectRequestFailure(await captureApiError(upload), 0);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each([
    ["a fourth key", { ...UPLOADED, mime: "application/pdf" }],
    ["no size", { path: UPLOADED.path, name: UPLOADED.name }],
    ["an empty path", { ...UPLOADED, path: "" }],
    ["an empty name", { ...UPLOADED, name: "" }],
    ["a numeric name", { ...UPLOADED, name: 1 }],
    ["a negative size", { ...UPLOADED, size: -1 }],
    ["a fractional size", { ...UPLOADED, size: 1.5 }],
    ["a string size", { ...UPLOADED, size: "10" }],
    ["an array", [UPLOADED]],
    ["null", null],
  ])("fails a 201 carrying %s as request_failed", async (_kind, body) => {
    expectRequestFailure(await rejection(201, JSON.stringify(body)), 201);
  });

  it("fails a 201 that is not JSON as request_failed", async () => {
    expectRequestFailure(await rejection(201, "created"), 201);
  });

  it.each([200, 202, 204])(
    "fails a %i carrying the upload body as request_failed",
    async (status) => {
      expectRequestFailure(await rejection(status, JSON.stringify(UPLOADED)), status);
    },
  );

  it.each([0, 101, 304])(
    "fails a load with status %i as request_failed without a notification",
    async (status) => {
      const onUnauthorized = vi.fn();

      expectRequestFailure(await rejection(status, "body", onUnauthorized), status);
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it("fails a 500 that is not an envelope as request_failed", async () => {
    expectRequestFailure(await rejection(500, "<html>"), 500);
  });
});
