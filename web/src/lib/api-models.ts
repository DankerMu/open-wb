import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/**
 * 注册表模型可声明的六档推理强度，按固定次序（model-selection「推理强度集合」）。不含会话设置里的 `off`，
 * 所以不复用 `session-contract` 的 `REASONING_EFFORTS`。
 */
export const MODEL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** `GET /api/models` 的一项（model-registry「模型管理端点」的 `ModelView`）：恰十键，从不带密钥。 */
export type ModelView = {
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  maxTokens: number;
  /** null = 不声明强度集合；否则是六档的非空升序子集。 */
  efforts: ModelEffort[] | null;
  upstream: { baseUrl: string; hasApiKey: true } | null;
  isDefault: boolean;
  probe: { status: "never" | "ok" | "failed"; at: number | null; message: string | null };
  updatedAt: number;
};

/** `POST /api/models` 的 body：只发所给的键（缺省由服务端补）。 */
export type CreateModelInput = {
  id: string;
  name?: string;
  reasoning?: boolean;
  vision?: boolean;
  maxTokens?: number;
  efforts?: ModelEffort[];
  upstream?: { baseUrl: string; apiKey: string };
};

/** `PUT /api/models?id=` 的 body：整体替换；`efforts` 省略即不声明，`upstream.apiKey` 省略即保留已存密钥。 */
export type UpdateModelInput = {
  name: string;
  reasoning: boolean;
  vision: boolean;
  maxTokens: number;
  efforts?: ModelEffort[];
  upstream: { baseUrl: string; apiKey?: string } | null;
};

type ModelTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  noContentRequest(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
  ): Promise<void>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
};

type ModelMethods = Pick<
  ApiClient,
  "listModels" | "createModel" | "updateModel" | "deleteModel" | "setDefaultModel" | "probeModel"
>;

const MAX_TOKENS = 128000;
const PROBE_STATUSES: ReadonlySet<unknown> = new Set(["never", "ok", "failed"]);

/** 非空、只含六档、严格按固定次序递增（不重复）。 */
function parseEfforts(value: unknown): ModelEffort[] | null | undefined {
  if (value === null) {
    return null;
  }
  const efforts = parseJsonArray(value, (item) =>
    MODEL_EFFORTS.includes(item as ModelEffort) ? (item as ModelEffort) : null,
  );
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const ranks = efforts.map((effort) => MODEL_EFFORTS.indexOf(effort));
  return ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? rank))
    ? efforts
    : undefined;
}

function parseUpstream(value: unknown): ModelView["upstream"] | undefined {
  if (value === null) {
    return null;
  }
  if (!hasExactlyKeys(value, ["baseUrl", "hasApiKey"])) {
    return undefined;
  }
  const { baseUrl, hasApiKey } = value;
  return typeof baseUrl === "string" && baseUrl !== "" && hasApiKey === true
    ? { baseUrl, hasApiKey }
    : undefined;
}

function parseProbe(value: unknown): ModelView["probe"] | null {
  if (!hasExactlyKeys(value, ["status", "at", "message"])) {
    return null;
  }
  const { status, at, message } = value;
  if (
    !PROBE_STATUSES.has(status) ||
    (at !== null && !isNonNegativeSafeInteger(at)) ||
    (message !== null && typeof message !== "string")
  ) {
    return null;
  }
  return { status: status as ModelView["probe"]["status"], at, message };
}

const VIEW_KEYS = [
  "id",
  "name",
  "reasoning",
  "vision",
  "maxTokens",
  "efforts",
  "upstream",
  "isDefault",
  "probe",
  "updatedAt",
];

function parseModelView(value: unknown): ModelView | null {
  if (!hasExactlyKeys(value, VIEW_KEYS)) {
    return null;
  }
  const { id, name, reasoning, vision, maxTokens, isDefault, updatedAt } = value;
  const efforts = parseEfforts(value.efforts);
  const upstream = parseUpstream(value.upstream);
  const probe = parseProbe(value.probe);
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof name !== "string" ||
    name === "" ||
    typeof reasoning !== "boolean" ||
    typeof vision !== "boolean" ||
    !isNonNegativeSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_TOKENS ||
    efforts === undefined ||
    upstream === undefined ||
    typeof isDefault !== "boolean" ||
    !probe ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    return null;
  }
  return { id, name, reasoning, vision, maxTokens, efforts, upstream, isDefault, probe, updatedAt };
}

/** 模型 id 只经查询参数传递（`/api/*` 下百分号编码的路径分量一律 404，带 `/` 的 id 进不了路径）。 */
function modelPath(base: string, id: string): string {
  return `${base}?id=${encodeURIComponent(id)}`;
}

function jsonBody(method: "POST" | "PUT", body: unknown, base: RequestInit): RequestInit {
  return {
    ...base,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createModelMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, noContentRequest, requestOptions, getRequestOptions, requestFailed }: ModelTransport,
): ModelMethods {
  /** 一次请求加严格解析；`status` 同时是期望的成功状态码与解析失败时 `requestFailed` 的 status。 */
  async function view(path: string, init: RequestInit, status: number): Promise<ModelView> {
    const parsed = parseModelView(await request(path, init, onUnauthorized, status));
    if (!parsed) {
      throw requestFailed(status);
    }
    return parsed;
  }
  /** 两个无 body 的 POST：不带 body，也不带 Content-Type。 */
  const bodyless = (base: string, id: string, signal?: AbortSignal) =>
    view(modelPath(base, id), { ...requestOptions(signal), method: "POST" }, 200);

  return {
    async listModels(options) {
      const response = await request(
        "/api/models",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const models = hasExactlyKeys(response, ["models"])
        ? parseJsonArray(response.models, parseModelView)
        : null;
      if (!models) {
        throw requestFailed(200);
      }
      return models;
    },

    createModel(input, options) {
      return view("/api/models", jsonBody("POST", input, requestOptions(options?.signal)), 201);
    },

    updateModel(id, input, options) {
      return view(
        modelPath("/api/models", id),
        jsonBody("PUT", input, requestOptions(options?.signal)),
        200,
      );
    },

    deleteModel(id, options) {
      return noContentRequest(
        modelPath("/api/models", id),
        { ...requestOptions(options?.signal), method: "DELETE" },
        onUnauthorized,
      );
    },

    setDefaultModel(id, options) {
      return bodyless("/api/models/default", id, options?.signal);
    },

    probeModel(id, options) {
      return bodyless("/api/models/probe", id, options?.signal);
    },
  };
}
