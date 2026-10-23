import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, parseJsonArray } from "./api-json.js";

/** 专家的四个分类，按显示次序（experts「专家校验与可见性」）。 */
export const EXPERT_CATEGORIES = ["开发", "办公", "设计", "产品"] as const;

export type ExpertCategory = (typeof EXPERT_CATEGORIES)[number];

/** `GET /api/experts` 的一项（experts「专家管理端点」的 `ExpertView`）：恰八键。 */
export type ExpertView = {
  id: string;
  name: string;
  description: string;
  category: ExpertCategory;
  tags: string[];
  prompt: string;
  skills: string[];
  builtin: boolean;
};

/** `POST /api/experts` 与 `PUT /api/experts?id=` 的 body：界面恒发六键（整体替换）。 */
export type ExpertInput = {
  name: string;
  description: string;
  category: ExpertCategory;
  tags: string[];
  prompt: string;
  skills: string[];
};

type ExpertTransport = {
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

type ExpertMethods = Pick<
  ApiClient,
  "listExperts" | "createExpert" | "updateExpert" | "deleteExpert"
>;

const VIEW_KEYS = ["id", "name", "description", "category", "tags", "prompt", "skills", "builtin"];

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseExpertView(value: unknown): ExpertView | null {
  if (!hasExactlyKeys(value, VIEW_KEYS)) {
    return null;
  }
  const { id, name, description, category, tags, prompt, skills, builtin } = value;
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof name !== "string" ||
    name === "" ||
    typeof description !== "string" ||
    !EXPERT_CATEGORIES.includes(category as ExpertCategory) ||
    !isStringArray(tags) ||
    typeof prompt !== "string" ||
    !isStringArray(skills) ||
    typeof builtin !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    name,
    description,
    category: category as ExpertCategory,
    tags,
    prompt,
    skills,
    builtin,
  };
}

/** 专家 id 只经查询参数传递（内置专家的 id 带 `:`，自建的是 32 位 hex）。 */
function expertPath(id: string): string {
  return `/api/experts?id=${encodeURIComponent(id)}`;
}

function jsonBody(method: "POST" | "PUT", body: ExpertInput, base: RequestInit): RequestInit {
  return {
    ...base,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createExpertMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, noContentRequest, requestOptions, getRequestOptions, requestFailed }: ExpertTransport,
): ExpertMethods {
  /** 一次请求加严格解析；`status` 同时是期望的成功状态码与解析失败时 `requestFailed` 的 status。 */
  async function view(path: string, init: RequestInit, status: number): Promise<ExpertView> {
    const parsed = parseExpertView(await request(path, init, onUnauthorized, status));
    if (!parsed) {
      throw requestFailed(status);
    }
    return parsed;
  }

  return {
    async listExperts(options) {
      const response = await request(
        "/api/experts",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const experts = hasExactlyKeys(response, ["experts"])
        ? parseJsonArray(response.experts, parseExpertView)
        : null;
      if (!experts) {
        throw requestFailed(200);
      }
      return experts;
    },

    createExpert(input, options) {
      return view("/api/experts", jsonBody("POST", input, requestOptions(options?.signal)), 201);
    },

    updateExpert(id, input, options) {
      return view(expertPath(id), jsonBody("PUT", input, requestOptions(options?.signal)), 200);
    },

    deleteExpert(id, options) {
      return noContentRequest(
        expertPath(id),
        { ...requestOptions(options?.signal), method: "DELETE" },
        onUnauthorized,
      );
    },
  };
}
