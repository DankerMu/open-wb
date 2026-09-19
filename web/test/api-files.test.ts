import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const workspace = {
  id: "workspace-1",
  name: "设计文档",
  dir: "design-docs",
  root: "/sandbox/user-1/design-docs",
  createdAt: 1_726_000_000_000,
};

function stubPreviewResponse(response: Response, createObjectURL = vi.fn()) {
  vi.stubGlobal("URL", { createObjectURL });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return createObjectURL;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Files API client workspace contract", () => {
  it("lists typed workspaces with the no-store session request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workspaces: [workspace] }));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().listWorkspaces({ signal: controller.signal })).resolves.toEqual({
      workspaces: [workspace],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });
});

describe("Files API client workspace creation contract", () => {
  it("creates workspaces with only declared JSON fields", async () => {
    const derivedDirectoryWorkspace = {
      ...workspace,
      id: "workspace-2",
      name: "默认目录",
      dir: "默认目录",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(workspace, 201))
      .mockResolvedValueOnce(jsonResponse(derivedDirectoryWorkspace, 201));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();

    await expect(
      client.createWorkspace(
        { name: "  设计文档 ", dir: "design-docs" },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(workspace);
    await expect(client.createWorkspace({ name: "默认目录" })).resolves.toEqual(
      derivedDirectoryWorkspace,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/workspaces", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"  设计文档 ","dir":"design-docs"}',
      signal: controller.signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/workspaces", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"name":"默认目录"}',
    });
  });
});

describe("Files API client workspace timestamp contract", () => {
  const signedTimestampWorkspace = {
    ...workspace,
    id: "workspace-signed-timestamp",
    createdAt: -1,
  };

  it("preserves signed createdAt for listed workspaces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ workspaces: [signedTimestampWorkspace] })),
    );

    await expect(createApiClient().listWorkspaces()).resolves.toEqual({
      workspaces: [signedTimestampWorkspace],
    });
  });

  it("preserves signed createdAt for created workspaces", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(signedTimestampWorkspace, 201)));

    await expect(
      createApiClient().createWorkspace({ name: signedTimestampWorkspace.name }),
    ).resolves.toEqual(signedTimestampWorkspace);
  });
});

describe("Files API client tree contract", () => {
  it("round trips special-character workspace IDs and paths as encoded data", async () => {
    const workspaceId = "ws/%#?+ 中";
    const path = "../out/新 目录/%file?#";
    const tree = {
      path,
      entries: [
        { name: "新 目录", type: "dir" as const, size: 0, mtime: 1_726_000_000_001 },
        { name: "%file?#", type: "file" as const, size: 42, mtime: 1_726_000_000_002.5 },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tree));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().listTree(workspaceId, path, { signal: controller.signal }),
    ).resolves.toEqual(tree);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/tree?path=..%2Fout%2F%E6%96%B0%20%E7%9B%AE%E5%BD%95%2F%25file%3F%23",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      },
    );
  });
});

describe("Files API client directory creation contract", () => {
  it("creates a directory with the exact path body", async () => {
    const workspaceId = "ws/%#?+ 中";
    const path = "../out/新 目录";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ path }, 201));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().createDir(workspaceId, path, { signal: controller.signal }),
    ).resolves.toEqual({ path });

    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/dirs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"path":"../out/新 目录"}',
      signal: controller.signal,
    });
  });
});

describe("Files API client preview contract", () => {
  it("round trips preview paths with original-size and truncation metadata", async () => {
    const workspaceId = "ws/%#?+ 中";
    const path = "../out/新 目录/%file?#";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("short", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Workbuddy-Size": "91",
          "X-Workbuddy-Truncated": "1",
        },
      }),
    );
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().fetchPreview(workspaceId, path, { signal: controller.signal }),
    ).resolves.toEqual({
      kind: "text",
      text: "short",
      size: 91,
      truncated: true,
    });

    const requestedPath = fetchMock.mock.calls[0]?.[0];
    expect(requestedPath).toBe(
      "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/file?path=..%2Fout%2F%E6%96%B0%20%E7%9B%AE%E5%BD%95%2F%25file%3F%23",
    );
    if (typeof requestedPath !== "string") {
      throw new Error("expected the preview request path");
    }
    expect(new URL(requestedPath, "https://workbuddy.test").searchParams.get("path")).toBe(path);
    expect(fetchMock).toHaveBeenCalledWith(requestedPath, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });
  it("returns a caller-owned image URL with the exact Blob bytes and MIME", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:preview-image-1");
    const revokeObjectURL = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(imageBytes, {
        headers: {
          "Content-Type": "image/png",
          "X-Workbuddy-Size": "4096",
        },
      }),
    );
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await createApiClient().fetchPreview("workspace-1", "logo.png");

    expect(preview).toEqual({
      kind: "image",
      url: "blob:preview-image-1",
      size: 4096,
      truncated: false,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!blob) {
      throw new Error("expected the image Blob");
    }
    expect(blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    if (preview.kind !== "image") {
      throw new Error("expected an image preview");
    }
    URL.revokeObjectURL(preview.url);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-image-1");
  });
  it.each([
    [403, "sandbox_denied", "路径不在沙箱内"],
    [409, "conflict", "目录已存在"],
    [413, "preview_too_large", "文件过大"],
    [415, "preview_unsupported", "不支持预览"],
  ])(
    "preserves the %s preview error envelope without allocating a Blob URL",
    async (status, code, message) => {
      const createObjectURL = stubPreviewResponse(
        jsonResponse({ error: { code, message } }, status),
      );

      const error = await captureApiError(
        createApiClient().fetchPreview("workspace-1", "bad-file"),
      );

      expect(error).toMatchObject({ status, code, message });
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );
  it("notifies once for valid, malformed, and non-JSON preview 401 errors", async () => {
    const onUnauthorized = vi.fn();
    const createObjectURL = vi.fn();
    const validController = new AbortController();
    const malformedController = new AbortController();
    const nonJsonController = new AbortController();
    const fetchMock = vi.fn();
    for (const [, response] of unauthorizedResponseCases()) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("URL", { createObjectURL });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient({ onUnauthorized });

    const validError = await captureApiError(
      client.fetchPreview("workspace-1", "valid", { signal: validController.signal }),
    );
    const malformedError = await captureApiError(
      client.fetchPreview("workspace-1", "malformed", { signal: malformedController.signal }),
    );
    const nonJsonError = await captureApiError(
      client.fetchPreview("workspace-1", "non-json", { signal: nonJsonController.signal }),
    );

    expect(validError).toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "登录已失效",
    });
    expectRequestFailure(malformedError, 401);
    expectRequestFailure(nonJsonError, 401);
    expect(onUnauthorized.mock.calls).toEqual([
      [validController.signal],
      [malformedController.signal],
      [nonJsonController.signal],
    ]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it("contains failing preview unauthorized callbacks", async () => {
    const syncThrow = vi.fn(() => {
      throw new Error("private sync callback failure");
    });
    const asyncReject = vi.fn(async () => {
      throw new Error("private async callback failure");
    });
    const [[, syncResponse]] = unauthorizedResponseCases();
    const [[, asyncResponse]] = unauthorizedResponseCases();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(syncResponse).mockResolvedValueOnce(asyncResponse),
    );

    const syncError = await captureApiError(
      createApiClient({ onUnauthorized: syncThrow }).fetchPreview("workspace-1", "sync"),
    );
    const asyncError = await captureApiError(
      createApiClient({ onUnauthorized: asyncReject }).fetchPreview("workspace-1", "async"),
    );
    await Promise.resolve();

    expect(syncError).toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "登录已失效",
    });
    expect(asyncError).toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "登录已失效",
    });
    expect(syncThrow).toHaveBeenCalledTimes(1);
    expect(asyncReject).toHaveBeenCalledTimes(1);
  });
  it("parses image-shaped preview errors before any success body reader", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "sandbox_denied", message: "路径不在沙箱内" } }),
      {
        status: 403,
        headers: {
          "Content-Type": "image/png",
          "X-Workbuddy-Size": "4",
        },
      },
    );
    const text = vi.spyOn(response, "text");
    const blob = vi.spyOn(response, "blob");
    const createObjectURL = stubPreviewResponse(response);

    const error = await captureApiError(createApiClient().fetchPreview("workspace-1", "outside"));

    expect(error).toMatchObject({
      status: 403,
      code: "sandbox_denied",
      message: "路径不在沙箱内",
    });
    expect(text).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it("rejects non-200 preview successes before any success body reader", async () => {
    const response = new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 201,
      headers: {
        "Content-Type": "image/png",
        "X-Workbuddy-Size": "4",
      },
    });
    const text = vi.spyOn(response, "text");
    const blob = vi.spyOn(response, "blob");
    const createObjectURL = stubPreviewResponse(response);

    const error = await captureApiError(createApiClient().fetchPreview("workspace-1", "created"));

    expectRequestFailure(error, 201);
    expect(text).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it.each([
    [
      "a missing size header",
      new Response("private preview body", { headers: { "Content-Type": "text/plain" } }),
    ],
    [
      "an image missing size header",
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }),
    ],
    [
      "an empty size header",
      new Response("private preview body", {
        headers: { "Content-Type": "text/plain", "X-Workbuddy-Size": "" },
      }),
    ],
    [
      "a fractional size header",
      new Response("private preview body", {
        headers: { "Content-Type": "text/plain", "X-Workbuddy-Size": "1.5" },
      }),
    ],
    [
      "an unsafe size header",
      new Response("private preview body", {
        headers: {
          "Content-Type": "text/plain",
          "X-Workbuddy-Size": "9007199254740992",
        },
      }),
    ],
    [
      "an unexpected content type",
      new Response("private preview body", {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Workbuddy-Size": "20",
        },
      }),
    ],
  ])("rejects $0 as a stable preview request failure", async (_label, response) => {
    const createObjectURL = stubPreviewResponse(response);

    const error = await captureApiError(createApiClient().fetchPreview("workspace-1", "bad"));

    expectRequestFailure(error, 200);
    expect(error.message).not.toContain("private preview body");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("returns an empty untruncated text preview with zero original size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          headers: {
            "Content-Type": "text/plain",
            "X-Workbuddy-Size": "0",
            "X-Workbuddy-Truncated": "true",
          },
        }),
      ),
    );

    await expect(createApiClient().fetchPreview("workspace-1", "empty.txt")).resolves.toEqual({
      kind: "text",
      text: "",
      size: 0,
      truncated: false,
    });
  });
  it("returns a caller-cleanable image/jpeg preview", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:preview-jpeg-1");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([255, 216, 255]), {
          headers: {
            "Content-Type": "image/jpeg",
            "X-Workbuddy-Size": "300",
          },
        }),
      ),
    );

    const preview = await createApiClient().fetchPreview("workspace-1", "logo.jpeg");

    expect(preview).toEqual({
      kind: "image",
      url: "blob:preview-jpeg-1",
      size: 300,
      truncated: false,
    });
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!blob) {
      throw new Error("expected the JPEG Blob");
    }
    expect(blob.type).toBe("image/jpeg");
    if (preview.kind !== "image") {
      throw new Error("expected an image preview");
    }
    URL.revokeObjectURL(preview.url);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-jpeg-1");
  });

  it.each([
    [
      "text",
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private text body failure"));
          },
        }),
        {
          headers: {
            "Content-Type": "text/plain",
            "X-Workbuddy-Size": "5",
          },
        },
      ),
    ],
    [
      "image",
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private image body failure"));
          },
        }),
        {
          headers: {
            "Content-Type": "image/png",
            "X-Workbuddy-Size": "8",
          },
        },
      ),
    ],
  ])("maps a failing %s preview body to the stable fallback", async (_kind, response) => {
    const createObjectURL = stubPreviewResponse(response);

    const error = await captureApiError(createApiClient().fetchPreview("workspace-1", "broken"));

    expectRequestFailure(error, 200);
    expect(error.message).not.toContain("private");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("maps Blob URL allocation failures to the stable fallback", async () => {
    const createObjectURL = vi.fn(() => {
      throw new Error("private Blob URL failure");
    });
    vi.stubGlobal("URL", { createObjectURL });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "Content-Type": "image/png",
            "X-Workbuddy-Size": "3",
          },
        }),
      ),
    );

    const error = await captureApiError(
      createApiClient().fetchPreview("workspace-1", "url-failure"),
    );

    expectRequestFailure(error, 200);
    expect(error.message).not.toContain("private");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("Files API client audit contract", () => {
  it("lists typed events while preserving supplied filter values", async () => {
    const events = [
      {
        id: 9,
        ts: 1_726_000_000_009,
        actorId: "user-1",
        kind: "sandbox.reject",
        title: "拒绝越界路径",
        detail: { path: "../private", reason: "escaped_root" },
        workspaceId: "workspace-1",
      },
      {
        id: 8,
        ts: 1_726_000_000_008,
        actorId: "user-1",
        kind: "workspace.create",
        title: "创建工作空间",
        detail: {},
        workspaceId: null,
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ events }))
      .mockResolvedValueOnce(jsonResponse({ events: [] }));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();

    await expect(
      client.listAudit({ limit: 0, before: "cursor/%?# +中" }, { signal: controller.signal }),
    ).resolves.toEqual({ events });
    await expect(client.listAudit()).resolves.toEqual({ events: [] });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/audit?limit=0&before=cursor%2F%25%3F%23+%2B%E4%B8%AD",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/audit", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });
});

describe("Files API client wire-shape contract", () => {
  it("rejects a malformed workspace response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          workspaces: [{ ...workspace, createdAt: "1_726_000_000_000" }],
        }),
      ),
    );

    const error = await captureApiError(createApiClient().listWorkspaces());

    expectRequestFailure(error, 200);
  });

  it("rejects a malformed nested tree entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          path: "out",
          entries: [{ name: "bad.txt", type: "file", size: 1, mtime: "not-an-epoch" }],
        }),
      ),
    );

    const error = await captureApiError(createApiClient().listTree("workspace-1", "out"));

    expectRequestFailure(error, 200);
  });

  it.each([
    ["a non-object detail", [], null],
    ["a non-null workspace ID", {}, 7],
  ])("rejects an audit event with %s", async (_label, detail, workspaceId) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          events: [
            {
              id: 1,
              ts: 1_726_000_000_000,
              actorId: "user-1",
              kind: "sandbox.reject",
              title: "拒绝越界路径",
              detail,
              workspaceId,
            },
          ],
        }),
      ),
    );

    const error = await captureApiError(createApiClient().listAudit());

    expectRequestFailure(error, 200);
  });
});
