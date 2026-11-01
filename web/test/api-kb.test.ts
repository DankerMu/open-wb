/**
 * s2a-kb-ragflow 组 15 首刀（#1841）：`web/src/lib/api-kb.ts`。接缝：真实的 `createApiClient` 加替身 `fetch`；
 * 类型与方法只从公共入口 `lib/api.js` 取。
 *
 * 期望值抄自规格，不从实现推：knowledge-bases「知识库端点」「工作空间来源入库」「本地上传入库」「文档列表与状态」
 *「重新入库与移出」「中心「知识库」tab」，ragflow-backend「知识库状态端点」「知识库模型设置」「嵌入模型更换与全量重建」，
 * model-registry「模型 tab」的 input 契约。每个应答形状一组：精确键集通过；多键、少键、类型不符各 `requestFailed`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiClient,
  type BaseView,
  type CreateKnowledgeBaseInput,
  createApiClient,
  type DocumentView,
  type IngestFromWorkspaceInput,
  type KbIngestResult,
  type KbSettingsView,
  type KbStatus,
  type UpdateKbSettingsInput,
} from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

type Case = [name: string, body: unknown];
type Options = { signal?: AbortSignal };
type Call = (client: ApiClient, options?: Options) => Promise<unknown>;
type Embedding = NonNullable<KbSettingsView["embedding"]>;

const AT = 1_760_000_000_000;
const COUNT_WRONG = ["4", -1, 1.5, null];
const STRING_WRONG = [1, null];
const NULLABLE_STRING_WRONG = [1, true];
const AT_WRONG = ["1", -1, 1.5, null];

// ragflow-backend「知识库状态端点」
const STATUS_OFF: KbStatus = { enabled: false };
const STATUS_ON: Extract<KbStatus, { enabled: true }> = {
  enabled: true,
  available: true,
  embeddingReady: true,
  compileReady: false,
  uploadMaxBytes: 104_857_600,
  uploadMaxFiles: 10,
};

// ragflow-backend「知识库模型设置」的读视图；计数取自「compileBases 的口径」
const PROBE: Embedding["probe"] = { status: "ok", message: null, at: AT };
const EMBEDDING: Embedding = { name: "bge-m3", baseUrl: "https://gw.example/v1", probe: PROBE };
const SETTINGS: KbSettingsView = {
  embedding: EMBEDDING,
  chatModelId: "m2",
  bases: 4,
  compileBases: 3,
  documents: 5,
  rebuilding: 1,
  rebuildFailed: 1,
};
const SETTINGS_EMPTY: KbSettingsView = {
  embedding: null,
  chatModelId: null,
  bases: 0,
  compileBases: 0,
  documents: 0,
  rebuilding: 0,
  rebuildFailed: 0,
};

// knowledge-bases「建库应答不读 RAGFlow」的 201 `BaseView`
const COMPILE: NonNullable<BaseView["compile"]> = { raptor: "pending", graph: "off" };
const BASE: BaseView = {
  id: "0123456789abcdef0123456789abcdef",
  name: "规范库",
  template: "manual",
  raptor: true,
  graph: false,
  state: "ready",
  stateMessage: null,
  documents: 0,
  compile: COMPILE,
  createdAt: AT,
};

// knowledge-bases「混合批次」与「上传不落盘」的写端点视图
const WORKSPACE_DOCUMENT: DocumentView = {
  id: "fedcba9876543210fedcba9876543210",
  name: "a.md",
  size: 12,
  source: "workspace",
  workspaceId: "w1",
  path: "a.md",
  status: "queued",
  chunkCount: null,
  message: null,
  sourceChanged: false,
  createdAt: AT,
};
const UPLOAD_DOCUMENT: DocumentView = {
  ...WORKSPACE_DOCUMENT,
  name: "b.pdf",
  source: "upload",
  workspaceId: null,
  path: null,
  sourceChanged: null,
};

// knowledge-bases「工作空间来源入库」应答一节的 `reason` / `message` 表，十一行
const REJECT_MESSAGES: Record<KbIngestResult["rejected"][number]["reason"], string> = {
  outside: "目标路径不在你的沙箱内",
  not_file: "不是普通文件，或文件不存在",
  too_large: "文件超过大小上限",
  unsupported_type: "这个模板不支持这种文件",
  empty: "文件是空的，不能入库",
  offline: "挂载已离线",
  duplicate: "已在知识库里",
  limit: "知识库文档数已达上限",
  changed: "读取期间文件发生了变化",
  rejected: "知识库服务拒绝了这个文件",
  unavailable: "知识库服务暂不可用",
};
const REJECTED_ITEM: KbIngestResult["rejected"][number] = {
  path: "../x",
  reason: "outside",
  message: "目标路径不在你的沙箱内",
};
const INGEST: KbIngestResult = { documents: [WORKSPACE_DOCUMENT], rejected: [REJECTED_ITEM] };

/** 多一键、逐键少一键，加 `wrong` 列出的类型不符；`wrong` 按键必填，视图加键而不写这一列就编译不过。 */
function malformed<T extends object>(view: T, wrong: { [K in keyof T]: unknown[] }): Case[] {
  const without = (key: string) =>
    Object.fromEntries(Object.entries(view).filter(([name]) => name !== key));
  return [
    ["多一键", { ...view, extra: 1 }],
    ...Object.keys(view).map((key): Case => [`缺 ${key}`, without(key)]),
    ...Object.entries<unknown[]>(wrong).flatMap(([key, values]) =>
      values.map(
        (value): Case => [`${key} 为 ${JSON.stringify(value)}`, { ...view, [key]: value }],
      ),
    ),
  ];
}

/** 把内层形状的用例包回外层应答。 */
function inside(prefix: string, wrap: (body: unknown) => unknown, cases: Case[]): Case[] {
  return cases.map(([name, body]) => [`${prefix}：${name}`, wrap(body)]);
}

const NOT_AN_OBJECT: Case[] = [
  ["null", null],
  ["数组", []],
  ["字符串", "ok"],
];

const STATUS_REJECTED: Case[] = [
  ...NOT_AN_OBJECT,
  ["空对象", {}],
  ["enabled 为 true 而没有其余键", { enabled: true }],
  ["enabled 为字符串", { enabled: "false" }],
  ["关闭时多一键", { enabled: false, available: false }],
  ...malformed(STATUS_ON, {
    enabled: [false, "true", 1],
    available: ["true", 1, null],
    embeddingReady: ["true", 1, null],
    compileReady: ["true", 1, null],
    // 两个上限是 `KB_UPLOAD_MAX_*` 的配置值，服务端按正整数解析（`=0` 启动失败），所以 0 也不合规。
    uploadMaxBytes: ["1", 0, -1, 1.5, null],
    uploadMaxFiles: ["1", 0, -1, 1.5, null],
  }),
];

const SETTINGS_REJECTED: Case[] = [
  ...NOT_AN_OBJECT,
  ...malformed(SETTINGS, {
    embedding: ["bge-m3", 1, []],
    chatModelId: NULLABLE_STRING_WRONG,
    bases: COUNT_WRONG,
    compileBases: COUNT_WRONG,
    documents: COUNT_WRONG,
    rebuilding: COUNT_WRONG,
    rebuildFailed: COUNT_WRONG,
  }),
  ...inside(
    "embedding",
    (embedding) => ({ ...SETTINGS, embedding }),
    malformed(EMBEDDING, {
      name: STRING_WRONG,
      baseUrl: STRING_WRONG,
      probe: ["ok", null],
    }),
  ),
  ...inside(
    "probe",
    (probe) => ({ ...SETTINGS, embedding: { ...EMBEDDING, probe } }),
    malformed(PROBE, {
      status: ["running", null],
      message: NULLABLE_STRING_WRONG,
      at: ["1", -1, 1.5],
    }),
  ),
];

const BASE_REJECTED: Case[] = [
  ...NOT_AN_OBJECT,
  ...malformed(BASE, {
    id: STRING_WRONG,
    name: STRING_WRONG,
    // `tag` 与 `audio` 不在十一种里；`general` 是发给 RAGFlow 的 `parser_id`，不是模板名。
    template: ["tag", "audio", "general", 1, null],
    raptor: [1, 0, "true", null],
    graph: [1, 0, "true", null],
    state: ["failed", 1, null],
    stateMessage: NULLABLE_STRING_WRONG,
    documents: COUNT_WRONG,
    compile: ["pending", 1, []],
    createdAt: AT_WRONG,
  }),
  ...inside(
    "compile",
    (compile) => ({ ...BASE, compile }),
    malformed(COMPILE, {
      raptor: ["idle", "compile_failed", 1, null],
      graph: ["idle", "compile_failed", 1, null],
    }),
  ),
];

const DOCUMENT_REJECTED: Case[] = [
  ...NOT_AN_OBJECT,
  ...malformed(WORKSPACE_DOCUMENT, {
    id: STRING_WRONG,
    name: STRING_WRONG,
    size: COUNT_WRONG,
    source: ["mount", 1, null],
    workspaceId: NULLABLE_STRING_WRONG,
    path: NULLABLE_STRING_WRONG,
    // RAGFlow 的 `ingestion_status` 不是本系统的状态。
    status: ["COMPLETED", "RUNNING", "error", 1, null],
    chunkCount: ["12", -1, 1.5],
    message: NULLABLE_STRING_WRONG,
    sourceChanged: [0, 1, "true"],
    createdAt: AT_WRONG,
  }),
];

const INGEST_REJECTED: Case[] = [
  ...NOT_AN_OBJECT,
  ...malformed(INGEST, { documents: [{}, null, "a"], rejected: [{}, null, "a"] }),
  ...inside(
    "documents 的一项",
    (document) => ({ documents: [WORKSPACE_DOCUMENT, document], rejected: [] }),
    DOCUMENT_REJECTED,
  ),
  ...inside("rejected 的一项", (item) => ({ documents: [], rejected: [REJECTED_ITEM, item] }), [
    ...NOT_AN_OBJECT,
    ...malformed(REJECTED_ITEM, {
      path: STRING_WRONG,
      reason: ["forbidden", "kb_rejected", 1, null],
      message: STRING_WRONG,
    }),
  ]),
];

/** `{<key>: […]}` 形状的外层：包一层的合法项与残缺项，加外层自身的残缺。 */
function listRejected(key: string, valid: unknown, items: Case[]): Case[] {
  return [
    ...NOT_AN_OBJECT,
    ["空对象", {}],
    ["外层多一键", { [key]: [], extra: 1 }],
    [`${key} 为 null`, { [key]: null }],
    [`${key} 不是数组`, { [key]: {} }],
    ...inside("一项", (item) => ({ [key]: [valid, item] }), items),
  ];
}

const SEVEN_STATUSES: DocumentView[] = [
  // knowledge-bases「状态映射」：`done` 带切片数、`failed` 带固定句子，其余两者都是 null
  { ...WORKSPACE_DOCUMENT, status: "unparsed" },
  { ...WORKSPACE_DOCUMENT, status: "queued" },
  { ...WORKSPACE_DOCUMENT, status: "parsing" },
  { ...WORKSPACE_DOCUMENT, status: "cancelled" },
  { ...WORKSPACE_DOCUMENT, status: "done", chunkCount: 12 },
  { ...WORKSPACE_DOCUMENT, status: "failed", message: "解析失败" },
  { ...WORKSPACE_DOCUMENT, status: "missing" },
];
const DOCUMENTS_ACCEPTED: Case[] = [
  ...SEVEN_STATUSES.map((document): Case => [`status 为 ${document.status}`, document]),
  ["0 切片", { ...WORKSPACE_DOCUMENT, status: "done", chunkCount: 0 }],
  ["sourceChanged 为 true", { ...WORKSPACE_DOCUMENT, sourceChanged: true }],
  ["sourceChanged 为 false", { ...WORKSPACE_DOCUMENT, sourceChanged: false }],
  ["sourceChanged 为 null", { ...WORKSPACE_DOCUMENT, sourceChanged: null }],
  ["本地上传", UPLOAD_DOCUMENT],
];

const TEMPLATES = [
  "naive",
  "book",
  "email",
  "laws",
  "manual",
  "one",
  "paper",
  "picture",
  "presentation",
  "qa",
  "table",
] as const;
const BASES_ACCEPTED: Case[] = [
  ...TEMPLATES.map((template): Case => [`模板 ${template}`, { ...BASE, template }]),
  ["重建中", { ...BASE, state: "rebuilding" }],
  ["重建失败", { ...BASE, state: "rebuild_failed", stateMessage: "重建失败，可在模型设置里重试" }],
  ["compile 为 null", { ...BASE, compile: null }],
  // knowledge-bases「编译状态文案」「编译状态按任务日志判定」
  ["编译中与已完成", { ...BASE, compile: { raptor: "running", graph: "done" } }],
  ["两种都有文档失败", { ...BASE, compile: { raptor: "failed", graph: "failed" } }],
  ["两个开关都关", { ...BASE, raptor: false, compile: { raptor: "off", graph: "off" } }],
  ["两个开关都开", { ...BASE, graph: true, compile: { raptor: "pending", graph: "pending" } }],
];

const KB_ID = "kb/1 中";
const KB_PATH = "/api/kb/bases/kb%2F1%20%E4%B8%AD";
const DOC_ID = "d&1=#";
const DOC_QUERY = "doc=d%261%3D%23";
const FILE = new File(["0123456789"], "报告 1#.pdf", { type: "application/pdf" });
const FILE_QUERY = "name=%E6%8A%A5%E5%91%8A%201%23.pdf";

const CREATE_INPUT: CreateKnowledgeBaseInput = { name: "规范库", template: "manual", raptor: true };
const INGEST_INPUT: IngestFromWorkspaceInput = { workspaceId: "w1", paths: ["a.md", "docs/b.pdf"] };

const CALLS = {
  getKbStatus: (client, options) => client.getKbStatus(options),
  getKbSettings: (client, options) => client.getKbSettings(options),
  updateKbSettings: (client, options) => client.updateKbSettings({ chatModelId: "m2" }, options),
  probeKbEmbedding: (client, options) => client.probeKbEmbedding(options),
  retryKbRebuild: (client, options) => client.retryKbRebuild(options),
  listKnowledgeBases: (client, options) => client.listKnowledgeBases(options),
  createKnowledgeBase: (client, options) => client.createKnowledgeBase(CREATE_INPUT, options),
  deleteKnowledgeBase: (client, options) => client.deleteKnowledgeBase(KB_ID, options),
  listKbDocuments: (client, options) => client.listKbDocuments(KB_ID, options),
  ingestFromWorkspace: (client, options) =>
    client.ingestFromWorkspace(KB_ID, INGEST_INPUT, options),
  uploadToKnowledgeBase: (client, options) => client.uploadToKnowledgeBase(KB_ID, FILE, options),
  reingestKbDocument: (client, options) => client.reingestKbDocument(KB_ID, DOC_ID, options),
  removeKbDocument: (client, options) => client.removeKbDocument(KB_ID, DOC_ID, options),
} satisfies Record<string, Call>;
type KbMethod = keyof typeof CALLS;

function invoke(method: KbMethod, client = createApiClient(), options?: Options) {
  return CALLS[method](client, options);
}

const GET: RequestInit = { method: "GET", credentials: "same-origin", cache: "no-store" };
const POST: RequestInit = { method: "POST", credentials: "same-origin" };
const DELETE: RequestInit = { method: "DELETE", credentials: "same-origin" };
const jsonPost = (body: string): RequestInit => ({
  ...POST,
  headers: { "Content-Type": "application/json" },
  body,
});

/** 十三个方法各一行：状态端点加 ragflow-backend「未配置即关闭」数出的十二条路由，一一对应。 */
const REQUESTS: [name: KbMethod, url: string, init: RequestInit, status: number, body: unknown][] =
  [
    ["getKbStatus", "/api/kb/status", GET, 200, STATUS_OFF],
    ["getKbSettings", "/api/kb/settings", GET, 200, SETTINGS],
    [
      "updateKbSettings",
      "/api/kb/settings",
      { ...jsonPost('{"chatModelId":"m2"}'), method: "PUT" },
      200,
      SETTINGS,
    ],
    ["probeKbEmbedding", "/api/kb/settings/probe", POST, 200, SETTINGS],
    ["retryKbRebuild", "/api/kb/settings/rebuild", POST, 200, SETTINGS],
    ["listKnowledgeBases", "/api/kb/bases", GET, 200, { bases: [BASE] }],
    [
      "createKnowledgeBase",
      "/api/kb/bases",
      jsonPost('{"name":"规范库","template":"manual","raptor":true}'),
      201,
      BASE,
    ],
    ["deleteKnowledgeBase", KB_PATH, DELETE, 204, null],
    ["listKbDocuments", `${KB_PATH}/documents`, GET, 200, { documents: [WORKSPACE_DOCUMENT] }],
    [
      "ingestFromWorkspace",
      `${KB_PATH}/documents`,
      jsonPost('{"workspaceId":"w1","paths":["a.md","docs/b.pdf"]}'),
      201,
      INGEST,
    ],
    [
      "uploadToKnowledgeBase",
      `${KB_PATH}/uploads?${FILE_QUERY}`,
      { ...POST, headers: { "Content-Type": "application/octet-stream" }, body: FILE },
      201,
      UPLOAD_DOCUMENT,
    ],
    [
      "reingestKbDocument",
      `${KB_PATH}/documents/reingest?${DOC_QUERY}`,
      POST,
      200,
      WORKSPACE_DOCUMENT,
    ],
    ["removeKbDocument", `${KB_PATH}/documents?${DOC_QUERY}`, DELETE, 204, null],
  ];

function stub(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function success(status: number, body: unknown) {
  return status === 204 ? new Response(null, { status }) : jsonResponse(body, status);
}

/** 两个列表的单键外层由客户端拆掉（同 `listModels`），其余方法原样返回解析后的应答。 */
function resultOf(method: KbMethod, body: unknown): unknown {
  if (method === "listKnowledgeBases") {
    return (body as { bases: unknown }).bases;
  }
  return method === "listKbDocuments" ? (body as { documents: unknown }).documents : body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("十三个知识库方法的请求", () => {
  it.each(REQUESTS)(
    "%s：恰发一次，地址、方法、头与 body 逐键相同，返回解析后的应答",
    async (name, url, init, status, body) => {
      const fetchMock = stub(success(status, body));

      const result = await invoke(name);

      // 逐键严格相等：无 body 的 POST 不带 body，也不带 Content-Type。
      expect(fetchMock.mock.calls).toStrictEqual([[url, init]]);
      expect(result).toStrictEqual(status === 204 ? undefined : resultOf(name, body));
    },
  );

  it.each(REQUESTS)("%s：传入的 signal 进请求", async (name, url, init, status, body) => {
    const fetchMock = stub(success(status, body));
    const { signal } = new AbortController();

    await invoke(name, undefined, { signal });

    expect(fetchMock.mock.calls).toStrictEqual([[url, { ...init, signal }]]);
  });

  it("上传的请求体就是 File 本身，不是字符串，也不是 FormData", async () => {
    const fetchMock = stub(jsonResponse(UPLOAD_DOCUMENT, 201));

    await createApiClient().uploadToKnowledgeBase(KB_ID, FILE);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(FILE);
  });

  it.each(REQUESTS)("%s：成功码只认规格写的那一个", async (name, _url, _init, status, body) => {
    const other = status === 200 ? 201 : 200;
    stub(jsonResponse(body, other));

    const error = await captureApiError(invoke(name));

    expectRequestFailure(error, other);
  });

  it.each(REQUESTS)("%s：错误信封原样保留，不重发", async (name) => {
    const onUnauthorized = vi.fn();
    const envelope = { error: { code: "kb_rebuilding", message: "知识库正在重建" } };
    const fetchMock = stub(jsonResponse(envelope, 409));

    const error = await captureApiError(invoke(name, createApiClient({ onUnauthorized })));

    expect(error).toMatchObject({ status: 409, ...envelope.error });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(REQUESTS)("%s：401 恰好通知一次", async (name) => {
    for (const [kind, response] of unauthorizedResponseCases()) {
      const onUnauthorized = vi.fn();
      stub(response as Response);
      const { signal } = new AbortController();

      const error = await captureApiError(
        invoke(name, createApiClient({ onUnauthorized }), { signal }),
      );

      if (kind === "a legal") {
        expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
      } else {
        expectRequestFailure(error, 401);
      }
      expect(onUnauthorized.mock.calls).toEqual([[signal]]);
    }
  });
});

describe("input 只发所给的键", () => {
  const EMBED = { name: "bge-m3", baseUrl: "https://gw.example/v1" };

  // model-registry「模型 tab」：`updateKbSettings({chatModelId})`、密钥留空即省略、确认后带 `confirmRebuild:true`。
  it.each<[string, UpdateKbSettingsInput, string]>([
    ["指定对话模型", { chatModelId: "m2" }, '{"chatModelId":"m2"}'],
    ["不使用", { chatModelId: null }, '{"chatModelId":null}'],
    [
      "首次配置带密钥",
      { embedding: { ...EMBED, apiKey: "k" } },
      '{"embedding":{"name":"bge-m3","baseUrl":"https://gw.example/v1","apiKey":"k"}}',
    ],
    [
      "留空保留现有密钥",
      { embedding: EMBED },
      '{"embedding":{"name":"bge-m3","baseUrl":"https://gw.example/v1"}}',
    ],
    [
      "确认重建",
      { embedding: EMBED, confirmRebuild: true },
      '{"embedding":{"name":"bge-m3","baseUrl":"https://gw.example/v1"},"confirmRebuild":true}',
    ],
    [
      "两键同发",
      { embedding: EMBED, chatModelId: null },
      '{"embedding":{"name":"bge-m3","baseUrl":"https://gw.example/v1"},"chatModelId":null}',
    ],
  ])("updateKbSettings：%s", async (_name, input, body) => {
    const fetchMock = stub(jsonResponse(SETTINGS));

    await createApiClient().updateKbSettings(input);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body);
  });

  it.each<[string, CreateKnowledgeBaseInput, string]>([
    ["不带开关", { name: "a", template: "naive" }, '{"name":"a","template":"naive"}'],
    [
      "两个开关",
      { name: "a", template: "table", raptor: true, graph: false },
      '{"name":"a","template":"table","raptor":true,"graph":false}',
    ],
  ])("createKnowledgeBase：%s", async (_name, input, body) => {
    const fetchMock = stub(jsonResponse(BASE, 201));

    await createApiClient().createKnowledgeBase(input);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body);
  });
});

type Shape = {
  shape: string;
  methods: KbMethod[];
  status: number;
  accepted: Case[];
  rejected: Case[];
};

const SHAPES: Shape[] = [
  {
    shape: "状态",
    methods: ["getKbStatus"],
    status: 200,
    accepted: [
      ["关闭", STATUS_OFF],
      ["开启", STATUS_ON],
      ["开启且编译可用", { ...STATUS_ON, compileReady: true }],
      ["不可用、未就绪", { ...STATUS_ON, available: false, embeddingReady: false }],
    ],
    rejected: STATUS_REJECTED,
  },
  {
    shape: "设置读视图",
    methods: ["getKbSettings", "updateKbSettings", "probeKbEmbedding", "retryKbRebuild"],
    status: 200,
    accepted: [
      ["已配置", SETTINGS],
      ["未配置", SETTINGS_EMPTY],
      [
        "探活从未",
        {
          ...SETTINGS,
          embedding: { ...EMBEDDING, probe: { status: "never", message: null, at: null } },
        },
      ],
      [
        "探活失败带摘要",
        {
          ...SETTINGS,
          embedding: { ...EMBEDDING, probe: { status: "failed", message: "HTTP 500", at: AT } },
        },
      ],
    ],
    rejected: SETTINGS_REJECTED,
  },
  {
    shape: "BaseView（建库 201）",
    methods: ["createKnowledgeBase"],
    status: 201,
    accepted: BASES_ACCEPTED,
    rejected: BASE_REJECTED,
  },
  {
    shape: "{bases}",
    methods: ["listKnowledgeBases"],
    status: 200,
    accepted: [
      ["空列表", { bases: [] }],
      ["全部形态同列", { bases: BASES_ACCEPTED.map(([, base]) => base) }],
    ],
    rejected: listRejected("bases", BASE, BASE_REJECTED),
  },
  {
    shape: "{documents}",
    methods: ["listKbDocuments"],
    status: 200,
    accepted: [
      ["空列表", { documents: [] }],
      ["全部形态同列", { documents: DOCUMENTS_ACCEPTED.map(([, document]) => document) }],
    ],
    rejected: listRejected("documents", WORKSPACE_DOCUMENT, DOCUMENT_REJECTED),
  },
  {
    shape: "入库结果",
    methods: ["ingestFromWorkspace"],
    status: 201,
    accepted: [
      ["全被拒", { documents: [], rejected: [REJECTED_ITEM] }],
      ["全成功", { documents: [WORKSPACE_DOCUMENT], rejected: [] }],
      [
        "十一种 reason",
        {
          documents: [],
          rejected: Object.entries(REJECT_MESSAGES).map(([reason, message]) => ({
            path: `${reason}.md`,
            reason,
            message,
          })),
        },
      ],
    ],
    rejected: INGEST_REJECTED,
  },
  {
    shape: "DocumentView（上传 201）",
    methods: ["uploadToKnowledgeBase"],
    status: 201,
    accepted: DOCUMENTS_ACCEPTED,
    rejected: DOCUMENT_REJECTED,
  },
  {
    shape: "DocumentView（重新入库 200）",
    methods: ["reingestKbDocument"],
    status: 200,
    accepted: DOCUMENTS_ACCEPTED,
    rejected: DOCUMENT_REJECTED,
  },
];

describe.each(SHAPES)("$shape 的严格解析", ({ methods, status, accepted, rejected }) => {
  describe.each(methods)("%s", (method) => {
    it.each(accepted)("精确键集通过：%s", async (_name, body) => {
      stub(jsonResponse(body, status));

      await expect(invoke(method)).resolves.toStrictEqual(resultOf(method, body));
    });

    it.each(rejected)("残缺应答按 request_failed 处理：%s", async (_name, body) => {
      stub(jsonResponse(body, status));

      const error = await captureApiError(invoke(method));

      expectRequestFailure(error, status);
    });
  });
});
