import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/**
 * 连接器的 API 客户端（connectors「中心「连接器」tab」「连接器管理端点」「连接器账号缺省」）。七个方法，名称只经
 * 查询参数 `?name=` 传递（`encodeURIComponent`）。按角色两种视图严格解析：管理员视图恰十一键、其它角色恰
 * `{name, type, description}`；一张列表须整张同一形状，多键、缺键或值不合法即无效应答。写与探活的应答只收管理员视图。
 */

/** 管理员视图（服务端 `connectors/store.ts` 的 `ConnectorView`）：另一类型的字段为 null，从不带凭证值。 */
export type ConnectorView = {
  name: string;
  type: "stdio" | "http";
  description: string;
  enabled: boolean;
  command: string | null;
  args: string[] | null;
  envKeys: string[] | null;
  url: string | null;
  headerKeys: string[] | null;
  probe: { status: "never" | "ok" | "failed"; at: number | null; message: string | null };
  updatedAt: number;
};

/** 其它角色的视图：只有启用的行，恰三键。 */
export type ConnectorSummary = Pick<ConnectorView, "name" | "type" | "description">;

/** `GET /api/connectors` 的结果，按应答形状标出是哪种视图（空表按管理员视图）。 */
export type ConnectorListing =
  | { admin: true; connectors: ConnectorView[] }
  | { admin: false; connectors: ConnectorSummary[] };

/** `POST /api/connectors` 的 body：只发所给的键（缺省由服务端补）。 */
export type CreateConnectorInput =
  | {
      name: string;
      type: "stdio";
      description?: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      enabled?: boolean;
    }
  | {
      name: string;
      type: "http";
      description?: string;
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    };

/** `PUT /api/connectors?name=` 的 body：整体替换；`env` / `headers` 里的 `null` = 保留该键既有的值。 */
export type UpdateConnectorInput =
  | {
      description: string;
      command: string;
      args: string[];
      env: Record<string, string | null>;
      enabled: boolean;
    }
  | {
      description: string;
      url: string;
      headers: Record<string, string | null>;
      enabled: boolean;
    };

type ConnectorTransport = {
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

type ConnectorMethods = Pick<
  ApiClient,
  | "listConnectors"
  | "createConnector"
  | "updateConnector"
  | "deleteConnector"
  | "probeConnector"
  | "getConnectorDefaults"
  | "putConnectorDefaults"
>;

/** 与服务端 `connectors/validate.ts` 的 `NAME` 同一规则。 */
const NAME = /^[a-z]{1,32}$/u;
const PROBE_STATUSES: ReadonlySet<unknown> = new Set(["never", "ok", "failed"]);
const VIEW_KEYS = [
  "name",
  "type",
  "description",
  "enabled",
  "command",
  "args",
  "envKeys",
  "url",
  "headerKeys",
  "probe",
  "updatedAt",
];

function isName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

/** 字符串数组；空串是合法项（服务端 `argsOf` 收 0–1024 码点的参数），故不走会拒掉假值的 `parseJsonArray`。 */
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function parseProbe(value: unknown): ConnectorView["probe"] | null {
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
  return { status: status as ConnectorView["probe"]["status"], at, message };
}

/** 按类型的五个连接字段：本类型的为值，另一类型的恰为 null。 */
function parseConnection(
  value: Record<string, unknown>,
): Pick<ConnectorView, "type" | "command" | "args" | "envKeys" | "url" | "headerKeys"> | null {
  const { type, command, url } = value;
  if (type === "stdio") {
    const args = strings(value.args);
    const envKeys = strings(value.envKeys);
    return typeof command === "string" &&
      args &&
      envKeys &&
      url === null &&
      value.headerKeys === null
      ? { type, command, args, envKeys, url: null, headerKeys: null }
      : null;
  }
  if (type === "http") {
    const headerKeys = strings(value.headerKeys);
    return typeof url === "string" &&
      headerKeys &&
      command === null &&
      value.args === null &&
      value.envKeys === null
      ? { type, command: null, args: null, envKeys: null, url, headerKeys }
      : null;
  }
  return null;
}

function parseConnectorView(value: unknown): ConnectorView | null {
  if (!hasExactlyKeys(value, VIEW_KEYS)) {
    return null;
  }
  const { name, description, enabled, updatedAt } = value;
  const connection = parseConnection(value);
  const probe = parseProbe(value.probe);
  if (
    !isName(name) ||
    typeof description !== "string" ||
    typeof enabled !== "boolean" ||
    !connection ||
    !probe ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    return null;
  }
  return { name, description, enabled, ...connection, probe, updatedAt };
}

function parseConnectorSummary(value: unknown): ConnectorSummary | null {
  if (!hasExactlyKeys(value, ["name", "type", "description"])) {
    return null;
  }
  const { name, type, description } = value;
  return isName(name) && (type === "stdio" || type === "http") && typeof description === "string"
    ? { name, type, description }
    : null;
}

/** 整张表先按管理员视图解析，不成再按三键视图；两种都不成（含混排）即 null。 */
function parseListing(value: unknown): ConnectorListing | null {
  if (!hasExactlyKeys(value, ["connectors"])) {
    return null;
  }
  const views = parseJsonArray(value.connectors, parseConnectorView);
  if (views) {
    return { admin: true, connectors: views };
  }
  const summaries = parseJsonArray(value.connectors, parseConnectorSummary);
  return summaries ? { admin: false, connectors: summaries } : null;
}

function parseDefaults(value: unknown): string[] | null {
  if (!hasExactlyKeys(value, ["disabledConnectors"])) {
    return null;
  }
  const names = strings(value.disabledConnectors);
  return names?.every(isName) ? names : null;
}

function connectorPath(base: string, name: string): string {
  return `${base}?name=${encodeURIComponent(name)}`;
}

function jsonBody(method: "POST" | "PUT", body: unknown, base: RequestInit): RequestInit {
  return {
    ...base,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createConnectorMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  {
    request,
    noContentRequest,
    requestOptions,
    getRequestOptions,
    requestFailed,
  }: ConnectorTransport,
): ConnectorMethods {
  /** 一次请求加严格解析；`status` 同时是期望的成功状态码与解析失败时 `requestFailed` 的 status。 */
  async function parsed<T>(
    path: string,
    init: RequestInit,
    status: number,
    parse: (value: unknown) => T | null,
  ): Promise<T> {
    const result = parse(await request(path, init, onUnauthorized, status));
    if (result === null) {
      throw requestFailed(status);
    }
    return result;
  }
  const defaults = (init: RequestInit) =>
    parsed("/api/connectors/defaults", init, 200, parseDefaults);

  return {
    listConnectors(options) {
      return parsed("/api/connectors", getRequestOptions(options?.signal), 200, parseListing);
    },

    createConnector(input, options) {
      const init = jsonBody("POST", input, requestOptions(options?.signal));
      return parsed("/api/connectors", init, 201, parseConnectorView);
    },

    updateConnector(name, input, options) {
      const init = jsonBody("PUT", input, requestOptions(options?.signal));
      return parsed(connectorPath("/api/connectors", name), init, 200, parseConnectorView);
    },

    deleteConnector(name, options) {
      return noContentRequest(
        connectorPath("/api/connectors", name),
        { ...requestOptions(options?.signal), method: "DELETE" },
        onUnauthorized,
      );
    },

    /** 无 body 的 POST：不带 body，也不带 Content-Type。 */
    probeConnector(name, options) {
      const init = { ...requestOptions(options?.signal), method: "POST" };
      return parsed(connectorPath("/api/connectors/probe", name), init, 200, parseConnectorView);
    },

    getConnectorDefaults(options) {
      return defaults(getRequestOptions(options?.signal));
    },

    /** 整表替换账号缺省停用列表；应答与随后的 `GET` 相同。 */
    putConnectorDefaults(disabledConnectors, options) {
      return defaults(jsonBody("PUT", { disabledConnectors }, requestOptions(options?.signal)));
    },
  };
}
