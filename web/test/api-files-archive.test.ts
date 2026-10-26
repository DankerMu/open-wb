// files-web「API 客户端扩展」里 `listArchive` 的部分：「方法与错误码」中它的一行（`GET …/archive?path=`、
// 返回形状、错误信封与 401 回调），「地址函数与严格解析」里 `entries` 含 `type` 为 `link` 的残缺响应；
// 以及「方法与错误码」里「十个发请求的方法」这个总数。
// 只从公共入口 `lib/api.js` 取——`api-files.ts` 的导出只供 `api.ts` 使用（见 chat-module-layout.test.ts）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

/** workspaces「压缩包列表」场景里 `x.zip` 的三项。 */
const ZIP_ENTRIES = [
  { path: "a.txt", type: "file", size: 5 },
  { path: "dir/", type: "dir", size: 0 },
  { path: "dir/b.md", type: "file", size: 7 },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("listArchive", () => {
  it("发一次无 body 的 GET …/archive?path=，id 与 path 都编码，不走缓存", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ format: "zip", entries: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { signal } = new AbortController();

    // path 是数据：首尾各一个空格、前导 `/`、中间的 `..` 段都原样发出；é 两种写法并排：已合成的 `é`
    // （NFD 会拆开它）与未合成的 `é`（NFC 会并掉它），所以两个方向的 `normalize` 都看得出。
    const path = " /x/../报告 2026/éé b#1&x.md ";

    await createApiClient().listArchive("ws/%#?+ 中", path, { signal });

    // 逐键严格相等：`toHaveBeenCalledWith` 会放过多出来的 `undefined` 键。没有 body、headers。
    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/archive?path=%20%2Fx%2F..%2F%E6%8A%A5%E5%91%8A%202026%2F%C3%A9e%CC%81%20b%231%26x.md%20",
        { method: "GET", credentials: "same-origin", cache: "no-store", signal },
      ],
    ]);
  });

  it("空串 path 不预检，原样发出 …?path=；不给 signal 时请求里也没有这个键", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ format: "zip", entries: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);

    await createApiClient().listArchive("workspace-1", "");

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/workspace-1/archive?path=",
        { method: "GET", credentials: "same-origin", cache: "no-store" },
      ],
    ]);
  });

  it.each([
    ["规格里 zip 的三项", { format: "zip", entries: ZIP_ENTRIES, truncated: false }],
    ["format 为 tar.gz", { format: "tar.gz", entries: ZIP_ENTRIES, truncated: false }],
    [
      "gz 的 size 为 null",
      {
        format: "gz",
        entries: [{ path: "notes.txt", type: "file", size: null }],
        truncated: false,
      },
    ],
    ["空 entries 且 truncated", { format: "tar", entries: [], truncated: true }],
    [
      "成员名是数据、目录的 size 原样保留",
      {
        format: "tar",
        entries: [
          { path: "../../etc/passwd", type: "file", size: 1 },
          { path: "/abs/x", type: "file", size: 2 },
          { path: "<script>", type: "file", size: 3 },
          { path: " a ", type: "file", size: 4 },
          { path: "é", type: "file", size: 5 },
          { path: "é", type: "file", size: 6 },
          { path: "d", type: "dir", size: 1024 },
          // 服务端对名为 `.gz` 的文件真会发出空成员名；本行 format 是 tar，所以 null 的 size 也不限于 gz。
          { path: "", type: "file", size: null },
        ],
        truncated: false,
      },
    ],
  ])("成功响应原样返回：%s", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const listing = await createApiClient().listArchive("workspace-1", "x.zip");

    expect(listing).toStrictEqual(body);
  });

  it.each([
    [
      "entries 含 type 为 link 的项",
      { format: "tar", entries: [{ path: "l", type: "link", size: 0 }], truncated: false },
    ],
    ["顶层多一键", { format: "zip", entries: ZIP_ENTRIES, truncated: false, total: 3 }],
    [
      "条目多一键",
      {
        format: "zip",
        entries: [{ path: "a", type: "file", size: 5, mtime: 1 }],
        truncated: false,
      },
    ],
    ["条目缺 size", { format: "zip", entries: [{ path: "a", type: "file" }], truncated: false }],
    [
      "size 是字符串",
      { format: "zip", entries: [{ path: "a", type: "file", size: "5" }], truncated: false },
    ],
    [
      "size 为负",
      { format: "zip", entries: [{ path: "a", type: "file", size: -1 }], truncated: false },
    ],
    [
      "size 不是整数",
      { format: "zip", entries: [{ path: "a", type: "file", size: 1.5 }], truncated: false },
    ],
    [
      "path 不是字符串",
      { format: "zip", entries: [{ path: 1, type: "file", size: 5 }], truncated: false },
    ],
    ["format 为 rar", { format: "rar", entries: ZIP_ENTRIES, truncated: false }],
    ["缺 truncated", { format: "zip", entries: ZIP_ENTRIES }],
    ["truncated 不是布尔", { format: "zip", entries: ZIP_ENTRIES, truncated: 1 }],
    ["entries 不是数组", { format: "zip", entries: {}, truncated: false }],
  ])("残缺的成功响应按 request_failed 处理：%s", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await captureApiError(createApiClient().listArchive("workspace-1", "x.zip"));

    expectRequestFailure(error, 200);
  });

  it("成功码只认 200：201 按失败处理", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ format: "zip", entries: [], truncated: false }, 201)),
    );

    const error = await captureApiError(createApiClient().listArchive("workspace-1", "x.zip"));

    expectRequestFailure(error, 201);
  });

  // 前四行是规格点名的四种信封。409 与 413 钉的是与路由无关的客户端映射：读 `rest-archive.ts`
  // 推出本路由不发这两种，未实测。
  it.each([
    [403, "sandbox_denied", "路径不在沙箱内"],
    [409, "conflict", "目录已存在"],
    [413, "preview_too_large", "文件过大"],
    [415, "preview_unsupported", "不支持预览"],
    [404, "not_found", "工作空间不存在"],
  ])("%i 的错误信封原样保留 status / code / message，不重发", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).listArchive("workspace-1", "x.zip"),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(unauthorizedResponseCases())("%s 401 恰好通知一次", async (kind, response) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { signal } = new AbortController();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).listArchive("workspace-1", "x.zip", { signal }),
    );

    if (kind === "a legal") {
      expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
    } else {
      expectRequestFailure(error, 401);
    }
    expect(onUnauthorized.mock.calls).toEqual([[signal]]);
  });
});

type RequestingMethod = [
  name: string,
  call: (client: ApiClient) => Promise<unknown>,
  address: string,
  method: string,
];

// 名字依规格句序。`promoteWorkspace` 不在内：它归 chat-web。各方法的 body 与返回形状由各自的测试文件承担。
const REQUESTING_METHODS: RequestingMethod[] = [
  ["listWorkspaces", (client) => client.listWorkspaces(), "/api/workspaces", "GET"],
  ["createWorkspace", (client) => client.createWorkspace({ name: "n" }), "/api/workspaces", "POST"],
  ["listTree", (client) => client.listTree("w1", "a"), "/api/workspaces/w1/tree?path=a", "GET"],
  ["createDir", (client) => client.createDir("w1", "a"), "/api/workspaces/w1/dirs", "POST"],
  [
    "fetchPreview",
    (client) => client.fetchPreview("w1", "a"),
    "/api/workspaces/w1/file?path=a",
    "GET",
  ],
  ["listAudit", (client) => client.listAudit(), "/api/audit", "GET"],
  [
    "listArchive",
    (client) => client.listArchive("w1", "a"),
    "/api/workspaces/w1/archive?path=a",
    "GET",
  ],
  [
    "moveEntry",
    (client) => client.moveEntry("w1", { from: "a", to: "b" }),
    "/api/workspaces/w1/move",
    "POST",
  ],
  [
    "deleteEntry",
    (client) => client.deleteEntry("w1", "a"),
    "/api/workspaces/w1/entries?path=a",
    "DELETE",
  ],
  [
    "issuePreviewToken",
    (client) => client.issuePreviewToken("w1"),
    "/api/workspaces/w1/preview-token",
    "POST",
  ],
];

// 客户端上不属于 files-web 那十个的方法，按来源分组。
const OTHER_CLIENT_METHODS = [
  // 会话（chat-web）
  "listSessions",
  "createSession",
  "patchSession",
  "deleteSession",
  "getMessages",
  "prompt",
  "stopSession",
  "regenerateSession",
  "forkSession",
  "undoMessage",
  "decideApproval",
  "getComposerOptions",
  // 由 api-files.ts 实现，但归 chat-web
  "promoteWorkspace",
  // 命令与项目配置
  "listCommands",
  "listProjectConfig",
  // 上传
  "uploadFile",
  // 模型注册表（model-registry「模型 tab」）
  "listModels",
  "createModel",
  "updateModel",
  "deleteModel",
  "setDefaultModel",
  "probeModel",
  // 专家与技能清单（experts「中心「专家」tab」；账号缺省停用列表：skill-switches「中心「技能」tab」）
  "listExperts",
  "createExpert",
  "updateExpert",
  "deleteExpert",
  "listSkills",
  "putSkillDefaults",
  // 连接器（connectors「中心「连接器」tab」；账号缺省停用列表：connectors「连接器账号缺省」）
  "listConnectors",
  "createConnector",
  "updateConnector",
  "deleteConnector",
  "probeConnector",
  "getConnectorDefaults",
  "putConnectorDefaults",
  // 挂载（workspace-mounts「挂载端点」，s1b-workspace-mounts D18）
  "listMounts",
  "deleteMount",
  // 会话能力（design D7；experts「输入框的专家选择」）
  "getSessionCapabilities",
  "putSessionCapabilities",
  // 登录态与服务信息
  "getMe",
  "getInfo",
  "login",
  "logout",
];

describe("十个发请求的方法", () => {
  it("恰是规格列出的十个", () => {
    expect(REQUESTING_METHODS.map(([name]) => name)).toStrictEqual([
      "listWorkspaces",
      "createWorkspace",
      "listTree",
      "createDir",
      "fetchPreview",
      "listAudit",
      "listArchive",
      "moveEntry",
      "deleteEntry",
      "issuePreviewToken",
    ]);
  });

  // 新增的客户端方法必须在这里归类：是 files-web 的发请求方法就给 `REQUESTING_METHODS` 加一行（上一例
  // 随之变红，逼着对照规格），否则把名字加进 `OTHER_CLIENT_METHODS`。两边都不加，本例变红。
  // 比的是键集，不比顺序：顺序只是 `createApiClient` 里展开的先后。
  it("客户端的全部方法恰是这十个加上已归类的其余方法", () => {
    const client = createApiClient();

    expect(Object.keys(client).sort()).toStrictEqual(
      [...REQUESTING_METHODS.map(([name]) => name), ...OTHER_CLIENT_METHODS].sort(),
    );
    expect(Object.values(client).every((member) => typeof member === "function")).toBe(true);
  });

  it.each(REQUESTING_METHODS)(
    "%s 发一次请求到自己的地址，错误保留 status / code / message",
    async (_name, call, address, method) => {
      const message = "服务器内部错误";
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: { code: "internal_error", message } }, 500));
      vi.stubGlobal("fetch", fetchMock);

      const error = await captureApiError(call(createApiClient()));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(address);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(method);
      expect(error).toMatchObject({ status: 500, code: "internal_error", message });
    },
  );
});
