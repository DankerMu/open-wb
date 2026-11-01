/** 请求头是否恰为 `Authorization: Bearer <密钥>`：密钥本身不进记录。 */
export type FakeRagflowBearer = "ok" | "missing" | "other";

/** 一份上传的 multipart 部件：`bytes` 是文件字节数。 */
export interface FakeRagflowPart {
  field: string;
  filename: string;
  bytes: number;
}

/** 收到的一个请求。请求头到达时入记录，请求体读完后补全字段。 */
export interface FakeRagflowRequest {
  method: string;
  path: string;
  /** 不带 `?` 的查询串，没有时为空串。 */
  query: string;
  bearer: FakeRagflowBearer;
  /** 请求头 `Content-Length`，没有时为 `null`。 */
  contentLength: number | null;
  /** 解析出的 JSON body，没有或解析失败时为 `null`。 */
  json: unknown;
  /** multipart 请求的部件，不是 multipart 时为 `null`。 */
  multipart: FakeRagflowPart[] | null;
  /** 未知路由：应答 §12 的 404。 */
  unknown: boolean;
  /** 请求体没到结尾连接就断了。 */
  aborted: boolean;
}

/** 协议应答：HTTP 状态缺省 200；`code` 只接受实测记录里出现过的值。 */
export interface FakeRagflowAnswer {
  status?: number;
  code: number;
  message?: string | null;
  data?: unknown;
}

/** 故障注入：只限 tasks.md 头部的四种。 */
export type FakeRagflowFault =
  /** 传输层：不应答，直到客户端离开或夹具关闭。 */
  | { kind: "hang" }
  /** 传输层：挂起，`release()` 后照常处理这个请求。 */
  | { kind: "hold" }
  /** 传输层：不发应答头就断开连接。 */
  | { kind: "reset" }
  /** 传输层：发出应答头与 `body` 后断开。 */
  | { kind: "cut"; headers?: Record<string, string>; body: string }
  /** 传输层：发出应答头与 `body` 后不再有字节，连接保持。 */
  | { kind: "stall"; headers?: Record<string, string>; body: string }
  /** HTTP 层：3xx，`body` 可带任意正文。 */
  | { kind: "redirect"; status?: number; location: string; body?: string }
  /** HTTP 层：5xx，`headers` 可带任意响应头。 */
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  /** HTTP 层：非 JSON。 */
  | { kind: "not_json"; status?: number; body?: string }
  /** HTTP 层：把 `envelope` 的 JSON 用空格补到恰 `bytes` 字节。 */
  | { kind: "oversize"; bytes: number; envelope?: unknown }
  /** 漂移值：不符的版本串。 */
  | { kind: "version"; value: string }
  /** 防御性组合：`code` 为 100、101、102、403；或 `deletedList` 即 `{code:0, data:{deleted:[]}}`。 */
  | { kind: "combo"; code: number; message?: string; data?: unknown }
  | { kind: "combo"; deletedList: true };

export interface FakeRagflowGate {
  /** 请求已到达并挂起时 resolve。 */
  reached: Promise<void>;
  release(): void;
}

export interface FakeRagflowScriptOptions {
  /** 生效次数，缺省 1；之后恢复正常。 */
  times?: number;
}

export interface FakeRagflowDocumentSeed {
  name: string;
  content: Buffer | string;
  ingestionStatus?: string;
}

export interface FakeRagflowDatasetView {
  id: string;
  name: string;
  parserId: string;
  embeddingModel: string;
}

export interface FakeRagflowDocumentView {
  id: string;
  name: string;
  size: number;
  ingestionStatus: string;
}

export interface FakeRagflowServer {
  port: number;
  baseUrl: string;
  /** 到目前为止的全部请求的副本，按到达次序。 */
  requests(): FakeRagflowRequest[];
  /** 其中落到未知路由的那些：用例据此断言没有发生。 */
  unknownRoutes(): FakeRagflowRequest[];
  /** `route` 形如 `POST /api/v1/datasets/<*>/documents`，其中 `*` 匹配一段路径。 */
  answer(route: string, reply: FakeRagflowAnswer, options?: FakeRagflowScriptOptions): void;
  fault(
    route: string,
    fault: { kind: "hold" },
    options?: FakeRagflowScriptOptions,
  ): FakeRagflowGate;
  fault(route: string, fault: FakeRagflowFault, options?: FakeRagflowScriptOptions): void;
  addDataset(name?: string): string;
  addDocument(datasetId: string, seed: FakeRagflowDocumentSeed): string;
  setDocumentStatus(datasetId: string, documentId: string, status: string): void;
  datasets(): FakeRagflowDatasetView[];
  documents(datasetId: string): FakeRagflowDocumentView[];
  close(): Promise<void>;
}

export function start(options?: { apiKey?: string }): Promise<FakeRagflowServer>;
