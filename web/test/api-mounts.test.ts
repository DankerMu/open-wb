/**
 * s1b-workspace-mounts 任务 10.3 / 11.3：`web/src/lib/api-mounts.ts`（design D18）。接缝：真实的 `createApiClient`
 * 加替身 `fetch`（`listMounts`、`createMount`、`deleteMount`、`listMountSources`），与导出的 `parseMountSources`。
 * `POST …/mounts` 成功恰为 201、应答是新挂载的视图（`rest-mounts.ts`）。期望值来自
 * workspace-mounts「挂载端点」「挂载源端点」：`GET …/mounts` 为 `{enabled, mounts}`，每项恰为
 * `{id, name, backend, host, port, remotePath, sourceId, sourceName, readOnly, status, createdAt}`
 *（`server/src/workspaces/mounts/rest-mounts.ts` 的 `viewOf`）；`DELETE …/mounts/:mountId` 成功恰为 204；
 * 挂载源对管理员是行 `{id, name, path, readOnly, createdAt}`、对其余人是 `{id, name, readOnly}`（`rest.ts`）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { parseMountSources } from "../src/lib/api-mounts.js";
import { captureApiError, createFetchMock, expectRequestFailure, jsonResponse } from "./support.js";

const WS = "workspace-1";
const LIST_PATH = `/api/workspaces/${WS}/mounts`;

const SFTP = {
  id: "m-1",
  name: "数据仓库导出",
  backend: "sftp",
  host: "dw-node-02.intra",
  port: 22,
  remotePath: "/export/dw",
  sourceId: null,
  sourceName: null,
  readOnly: true,
  status: "online",
  createdAt: 1_760_000_000_000,
};
const LOCAL = {
  id: "m-2",
  name: "共享资料",
  backend: "local",
  host: null,
  port: null,
  remotePath: null,
  sourceId: "s-1",
  sourceName: "资料库",
  readOnly: false,
  status: "offline",
  createdAt: 1_760_000_000_001,
};
const SMB_NO_PORT = { ...SFTP, id: "m-3", name: "产品共享盘", backend: "smb", port: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listMounts", () => {
  it("GETs …/mounts without a cache and returns {enabled, mounts} as given", async () => {
    const body = { enabled: true, mounts: [SFTP, LOCAL, SMB_NO_PORT] };
    const fetchMock = stub({ [LIST_PATH]: () => jsonResponse(body) });

    await expect(createApiClient().listMounts(WS)).resolves.toEqual(body);
    expect(fetchMock.mock.calls).toEqual([
      [LIST_PATH, { method: "GET", cache: "no-store", credentials: "same-origin" }],
    ]);
  });

  it("accepts an empty list with the feature off", async () => {
    stub({ [LIST_PATH]: () => jsonResponse({ enabled: false, mounts: [] }) });

    await expect(createApiClient().listMounts(WS)).resolves.toEqual({
      enabled: false,
      mounts: [],
    });
  });

  it("encodes the workspace id as one path segment", async () => {
    const fetchMock = stub({
      "/api/workspaces/a%2Fb%3F/mounts": () => jsonResponse({ enabled: true, mounts: [] }),
    });

    await createApiClient().listMounts("a/b?");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workspaces/a%2Fb%3F/mounts");
  });

  const { createdAt: _createdAt, ...tenKeys } = SFTP;
  it.each([
    ["an extra top-level key", { enabled: true, mounts: [SFTP], total: 1 }],
    ["no enabled", { mounts: [SFTP] }],
    ["a string enabled", { enabled: "true", mounts: [SFTP] }],
    ["a non-array mounts", { enabled: true, mounts: SFTP }],
    ["a view with a twelfth key", { enabled: true, mounts: [{ ...SFTP, username: "dw" }] }],
    ["a view with ten keys", { enabled: true, mounts: [tenKeys] }],
    ["an unknown backend", { enabled: true, mounts: [{ ...SFTP, backend: "nfs" }] }],
    ["an unknown status", { enabled: true, mounts: [{ ...SFTP, status: "mounting" }] }],
    ["a string port", { enabled: true, mounts: [{ ...SFTP, port: "22" }] }],
    ["port 0", { enabled: true, mounts: [{ ...SFTP, port: 0 }] }],
    ["port 65536", { enabled: true, mounts: [{ ...SFTP, port: 65_536 }] }],
    ["a numeric readOnly", { enabled: true, mounts: [{ ...SFTP, readOnly: 1 }] }],
    ["a null name", { enabled: true, mounts: [{ ...SFTP, name: null }] }],
    ["a fractional createdAt", { enabled: true, mounts: [{ ...SFTP, createdAt: 1.5 }] }],
    ["a numeric host", { enabled: true, mounts: [{ ...SFTP, host: 1 }] }],
  ])("an answer with %s is request_failed", async (_label, body) => {
    stub({ [LIST_PATH]: () => jsonResponse(body) });

    expectRequestFailure(await captureApiError(createApiClient().listMounts(WS)), 200);
  });

  it("a non-200 success is request_failed", async () => {
    stub({ [LIST_PATH]: () => jsonResponse({ enabled: true, mounts: [] }, 201) });

    expectRequestFailure(await captureApiError(createApiClient().listMounts(WS)), 201);
  });

  it("an error envelope rejects with its code and message", async () => {
    stub({
      [LIST_PATH]: () =>
        jsonResponse({ error: { code: "not_found", message: "工作空间不存在" } }, 404),
    });

    expect(await captureApiError(createApiClient().listMounts(WS))).toMatchObject({
      status: 404,
      code: "not_found",
      message: "工作空间不存在",
    });
  });
});

describe("deleteMount", () => {
  it("DELETEs …/mounts/<id> with no body, the mount id encoded as one segment, and resolves on 204", async () => {
    const path = `${LIST_PATH}/m%2F1%3F%23`;
    const fetchMock = stub({ [path]: () => new Response(null, { status: 204 }) });

    await expect(createApiClient().deleteMount(WS, "m/1?#")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toEqual([
      [path, { method: "DELETE", credentials: "same-origin" }],
    ]);
  });

  it("a 200 is request_failed: 204 is the only success", async () => {
    stub({ [`${LIST_PATH}/m-1`]: () => jsonResponse({}, 200) });

    expectRequestFailure(await captureApiError(createApiClient().deleteMount(WS, "m-1")), 200);
  });

  it("a 404 envelope rejects with its message", async () => {
    stub({
      [`${LIST_PATH}/m-1`]: () =>
        jsonResponse({ error: { code: "not_found", message: "挂载不存在" } }, 404),
    });

    expect(await captureApiError(createApiClient().deleteMount(WS, "m-1"))).toMatchObject({
      status: 404,
      code: "not_found",
      message: "挂载不存在",
    });
  });
});

describe("parseMountSources", () => {
  const admin = { id: "s-1", name: "资料库", path: "/srv/share", readOnly: true, createdAt: 1 };
  const user = { id: "s-1", name: "资料库", readOnly: true };

  it("an administrator's answer: every item exactly the five keys", () => {
    expect(parseMountSources({ sources: [admin, { ...admin, id: "s-2" }] })).toEqual({
      view: "admin",
      sources: [admin, { ...admin, id: "s-2" }],
    });
  });

  it("anyone else's answer: every item exactly the three keys", () => {
    expect(parseMountSources({ sources: [user] })).toEqual({ view: "user", sources: [user] });
    expect(parseMountSources({ sources: [] })).toEqual({ view: "user", sources: [] });
  });

  const { createdAt: _at, ...fourKeys } = admin;
  it.each([
    ["the two key sets mixed in one answer", { sources: [admin, user] }],
    ["the two key sets mixed the other way round", { sources: [user, admin] }],
    ["an item with four keys", { sources: [fourKeys] }],
    ["an item with a sixth key", { sources: [{ ...admin, backend: "local" }] }],
    ["an extra top-level key", { sources: [user], total: 1 }],
    ["a non-array sources", { sources: user }],
    ["a string readOnly", { sources: [{ ...user, readOnly: "true" }] }],
    ["a numeric admin path", { sources: [{ ...admin, path: 1 }] }],
  ])("%s is a parse failure", (_label, body) => {
    expect(parseMountSources(body)).toBeNull();
  });
});

describe("createMount", () => {
  const input = {
    name: "数据仓库导出",
    backend: "sftp" as const,
    host: "dw-node-02.intra",
    port: 22,
    remotePath: "/export/dw",
    readOnly: true,
    username: "reader",
    password: "pw",
  };

  it("POSTs the input as JSON to …/mounts (workspace id encoded) and resolves with the 201 view", async () => {
    const path = "/api/workspaces/a%2Fb/mounts";
    const fetchMock = stub({ [path]: () => jsonResponse(SFTP, 201) });

    await expect(createApiClient().createMount("a/b", input)).resolves.toEqual(SFTP);
    expect(fetchMock.mock.calls).toEqual([
      [
        path,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ],
    ]);
  });

  it("a 200, or a 201 whose view has a credential key, is request_failed", async () => {
    stub({
      [LIST_PATH]: [jsonResponse(SFTP, 200), jsonResponse({ ...SFTP, password: "pw" }, 201)],
    });

    expectRequestFailure(await captureApiError(createApiClient().createMount(WS, input)), 200);
    expectRequestFailure(await captureApiError(createApiClient().createMount(WS, input)), 201);
  });

  it("a 403 envelope rejects with its message", async () => {
    stub({
      [LIST_PATH]: () =>
        jsonResponse({ error: { code: "mount_host_rejected", message: "该主机不允许挂载" } }, 403),
    });

    expect(await captureApiError(createApiClient().createMount(WS, input))).toMatchObject({
      status: 403,
      code: "mount_host_rejected",
      message: "该主机不允许挂载",
    });
  });
});

describe("listMountSources", () => {
  it("GETs /api/mount-sources without a cache and returns the parsed view", async () => {
    const user = { id: "s-1", name: "资料库", readOnly: false };
    const fetchMock = stub({ "/api/mount-sources": () => jsonResponse({ sources: [user] }) });

    await expect(createApiClient().listMountSources()).resolves.toEqual({
      view: "user",
      sources: [user],
    });
    expect(fetchMock.mock.calls).toEqual([
      ["/api/mount-sources", { method: "GET", cache: "no-store", credentials: "same-origin" }],
    ]);
  });

  it("an answer mixing the two key sets is request_failed", async () => {
    const admin = { id: "s-1", name: "资料库", path: "/srv/share", readOnly: true, createdAt: 1 };
    stub({
      "/api/mount-sources": () =>
        jsonResponse({ sources: [admin, { id: "s-2", name: "归档", readOnly: true }] }),
    });

    expectRequestFailure(await captureApiError(createApiClient().listMountSources()), 200);
  });
});
