import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const ENCODED_SESSION_ID = "sess/%#?+ 中";
const ENCODED_SESSION_PATH = "/api/sessions/sess%2F%25%23%3F%2B%20%E4%B8%AD";
const UNSAFE_INTEGER = 2 ** 53;

const session = {
  id: SESSION_ID,
  title: "saved title",
  status: "idle" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  ...NULL_SESSION_META,
};

const SKIP_REASONS = [
  "too_large",
  "excluded",
  "unreadable",
  "special",
  "name_encoding",
  "mount",
] as const;

/** 每个跳过原因各一条；两个 `count` 都大于 `paths.length`（服务端截断了路径清单）。 */
const restoredFiles = {
  mode: "restored" as const,
  restored: 3,
  removed: 1,
  skipped: {
    count: 9,
    paths: SKIP_REASONS.map((reason) => ({ path: `skip/${reason}.bin`, reason })),
  },
  failed: { count: 2, paths: [{ path: "失败/a b.txt" }] },
};

const keptFiles = {
  mode: "kept" as const,
  restored: 0,
  removed: 0,
  skipped: { count: 0, paths: [] },
  failed: { count: 0, paths: [] },
};

const skippedPath = { path: "a.bin", reason: "too_large" };

function undoBody(files: unknown, draft: unknown = "原文") {
  return { session, draft, files };
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Undo API request", () => {
  it.each(["restore", "force", "keep"] as const)(
    "POSTs undo with exactly the JSON messageId and files %s body",
    async (files) => {
      const fetchMock = stubFetch(jsonResponse(undoBody(keptFiles)));
      const controller = new AbortController();

      await createApiClient().undoMessage(ENCODED_SESSION_ID, -3, files, {
        signal: controller.signal,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`${ENCODED_SESSION_PATH}/undo`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: `{"messageId":-3,"files":"${files}"}`,
        signal: controller.signal,
      });
    },
  );
});

describe("Undo API response parsing", () => {
  it.each(["", "  原文\n"])("returns a restored undo with draft %j unchanged", async (draft) => {
    const body = undoBody(restoredFiles, draft);
    stubFetch(jsonResponse(body));

    await expect(createApiClient().undoMessage(SESSION_ID, 1, "restore")).resolves.toEqual({
      ...body,
      attachments: [],
    });
  });

  it("returns a kept undo unchanged", async () => {
    const body = undoBody(keptFiles, "");
    stubFetch(jsonResponse(body));

    await expect(createApiClient().undoMessage(SESSION_ID, 1, "keep")).resolves.toEqual({
      ...body,
      attachments: [],
    });
  });

  it("returns an undo that carries attachments unchanged", async () => {
    const body = { ...undoBody(restoredFiles), attachments: [{ path: "uploads/a.pdf", size: 3 }] };
    stubFetch(jsonResponse(body));

    await expect(createApiClient().undoMessage(SESSION_ID, 1, "restore")).resolves.toEqual(body);
  });

  it.each([
    ["missing files", { session, draft: "" }],
    ["null files", undoBody(null)],
    ["array files", undoBody([])],
    ["an extra top-level key", { ...undoBody(keptFiles), extra: [] }],
    ["a missing draft", { session, files: keptFiles }],
    ["a non-string draft", undoBody(keptFiles, 1)],
    ["a null draft", undoBody(keptFiles, null)],
    ["a missing session", { draft: "", files: keptFiles }],
    ["an unknown session status", { ...undoBody(keptFiles), session: { ...session, status: "x" } }],
    ["an extra session key", { ...undoBody(keptFiles), session: { ...session, parentId: "p" } }],
    [
      "a missing session key",
      { ...undoBody(keptFiles), session: { ...session, scene: undefined } },
    ],
  ] as const)("rejects an undo body with %s", async (_label, body) => {
    stubFetch(jsonResponse(body));

    expectRequestFailure(
      await captureApiError(createApiClient().undoMessage(SESSION_ID, 1, "restore")),
      200,
    );
  });

  it.each([
    ["an illegal mode", { ...keptFiles, mode: "restore" }],
    ["a missing mode", { ...keptFiles, mode: undefined }],
    ["an extra key", { ...keptFiles, conflicts: [] }],
    ["a negative restored", { ...keptFiles, restored: -1 }],
    ["a fractional restored", { ...keptFiles, restored: 1.5 }],
    ["a negative removed", { ...keptFiles, removed: -1 }],
    ["an unsafe removed", { ...keptFiles, removed: UNSAFE_INTEGER }],
    ["a string removed", { ...keptFiles, removed: "1" }],
    ["a missing skipped", { ...keptFiles, skipped: undefined }],
    ["an array skipped", { ...keptFiles, skipped: [] }],
    ["a skipped without count", { ...keptFiles, skipped: { paths: [] } }],
    ["a skipped with an extra key", { ...keptFiles, skipped: { count: 0, paths: [], more: 1 } }],
    ["a skipped with non-array paths", { ...keptFiles, skipped: { count: 0, paths: {} } }],
    ["a negative skipped count", { ...keptFiles, skipped: { count: -1, paths: [] } }],
    ["a fractional skipped count", { ...keptFiles, skipped: { count: 0.5, paths: [] } }],
    ["an unsafe skipped count", { ...keptFiles, skipped: { count: UNSAFE_INTEGER, paths: [] } }],
    [
      "a skipped count below paths.length",
      { ...keptFiles, skipped: { count: 1, paths: [skippedPath, skippedPath] } },
    ],
    [
      "an unknown skipped reason",
      { ...keptFiles, skipped: { count: 1, paths: [{ path: "a.bin", reason: "binary" }] } },
    ],
    [
      "a skipped element without reason",
      { ...keptFiles, skipped: { count: 1, paths: [{ path: "a.bin" }] } },
    ],
    [
      "a skipped element without path",
      { ...keptFiles, skipped: { count: 1, paths: [{ reason: "mount" }] } },
    ],
    [
      "a skipped element with an extra key",
      { ...keptFiles, skipped: { count: 1, paths: [{ ...skippedPath, size: 1 }] } },
    ],
    [
      "a skipped element with a non-string path",
      { ...keptFiles, skipped: { count: 1, paths: [{ path: 1, reason: "mount" }] } },
    ],
    ["a missing failed", { ...keptFiles, failed: undefined }],
    ["a negative failed count", { ...keptFiles, failed: { count: -1, paths: [] } }],
    ["a fractional failed count", { ...keptFiles, failed: { count: 1.5, paths: [] } }],
    [
      "a failed count below paths.length",
      { ...keptFiles, failed: { count: 0, paths: [{ path: "a" }] } },
    ],
    [
      "a failed element with an extra key",
      { ...keptFiles, failed: { count: 1, paths: [skippedPath] } },
    ],
    ["a failed element without path", { ...keptFiles, failed: { count: 1, paths: [{}] } }],
    ["a failed element that is a string", { ...keptFiles, failed: { count: 1, paths: ["a"] } }],
  ] as const)("rejects undo files with %s", async (_label, files) => {
    stubFetch(jsonResponse(undoBody(files)));

    expectRequestFailure(
      await captureApiError(createApiClient().undoMessage(SESSION_ID, 1, "restore")),
      200,
    );
  });

  it("rejects an undo status other than 200", async () => {
    stubFetch(jsonResponse(undoBody(keptFiles), 201));

    expectRequestFailure(
      await captureApiError(createApiClient().undoMessage(SESSION_ID, 1, "keep")),
      201,
    );
  });
});

describe("Undo API error envelopes", () => {
  it.each([
    [409, "undo_conflict"],
    [409, "session_busy"],
    [409, "session_archived"],
    [404, "not_found"],
  ] as const)("keeps the %i %s envelope", async (status, code) => {
    const message = `${code} 文案`;
    stubFetch(jsonResponse({ error: { code, message } }, status));
    const onUnauthorized = vi.fn();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).undoMessage(SESSION_ID, 1, "restore"),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
