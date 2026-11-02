/**
 * RAGFlow 客户端的路由判定原语（`ragflow-client.ts` 与 `ragflow-models.ts` 共用，s2a-kb-ragflow D4）：结果类型、一条路由的
 * 判定形状与读字段的小函数。这里没有发请求的写法：三种调用只在 `createRagflowClient` 里，兄弟文件经闭包参数拿到 `json`。
 */
export const API = "/api/v1";

export const UNAVAILABLE = { kind: "kb_unavailable" } as const;
export const REJECTED = { kind: "kb_rejected" } as const;

type Failure = typeof UNAVAILABLE | typeof REJECTED;
type Ok<T> = { kind: "ok"; value: T };
export type Result<T, Typed = never> = Ok<T> | Failure | Typed;

export interface Envelope {
  code: unknown;
  message: unknown;
  data: unknown;
}

/**
 * 一条路由的判定。`typed` 是路由专属组合；`read` 在 `code:0` 时取调用点要读的字段，
 * 读不到返回 `undefined`（即「成功应答缺少调用点要读的字段」），没有要读的字段时返回 `null`。
 */
export interface Route<T, Typed> {
  typed?: (envelope: Envelope) => Typed | undefined;
  read: (data: unknown) => T | undefined;
}

/** `createRagflowClient` 里的 JSON 调用：只经闭包参数交给兄弟文件，不在模块级导出。`signal` 中止即 `kb_unavailable`。 */
export type JsonCall = <T, Typed>(
  method: string,
  path: string,
  route: Route<T, Typed>,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<Result<T, Typed>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const fieldOf = (data: unknown, name: string): unknown =>
  isRecord(data) ? data[name] : undefined;

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** 空 id 拼不出这条路由；`.`、`..` 编码后不变，会被 URL 解析吃掉，走到别的路由上。 */
export function usable(...ids: readonly string[]): boolean {
  return ids.every((id) => id !== "" && id !== "." && id !== "..");
}
