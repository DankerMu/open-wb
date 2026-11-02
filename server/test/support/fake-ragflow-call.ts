/** 夹具自测的请求：用 `fetch` 直接打假 RAGFlow，不经客户端。 */
import { afterEach, beforeEach, expect } from "vitest";
import { type FakeRagflowServer, start } from "./fake-ragflow.mjs";

export interface FakeCallOptions {
  json?: unknown;
  form?: FormData;
  /** `null` 不带 Authorization。 */
  key?: string | null;
  /** 原样作为 Authorization 请求头，优先于 `key`。 */
  authorization?: string;
}

export interface FakeCallAnswer {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}

export async function callFake(
  baseUrl: string,
  defaultKey: string,
  method: string,
  path: string,
  options: FakeCallOptions = {},
): Promise<FakeCallAnswer> {
  const { json, form, key = defaultKey } = options;
  const authorization = options.authorization ?? (key === null ? undefined : `Bearer ${key}`);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(form === undefined ? {} : { body: form }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON 应答：`text` 才是判据。
  }
  return { status: response.status, headers: response.headers, text, body };
}

/** 每个用例起一个以 `key` 鉴权的假 RAGFlow，用完关掉；`started` 把它交给测试文件，返回打它的 `call`。 */
export function useFakeRagflow(key: string, started: (fake: FakeRagflowServer) => void) {
  let fake: FakeRagflowServer;
  beforeEach(async () => {
    fake = await start({ apiKey: key });
    started(fake);
  });
  afterEach(async () => {
    await fake.close();
  });
  return (method: string, path: string, options?: FakeCallOptions) =>
    callFake(fake.baseUrl, key, method, path, options);
}

export function formOf(name: string, content: string, field = "file"): FormData {
  const form = new FormData();
  form.append(field, new Blob([content]), name);
  return form;
}

/** 记录没有依据的请求落到未知路由（§12 的 404），这样的用例不能悄悄通过。 */
export function expectUnknownRoute(
  fake: FakeRagflowServer,
  answer: { status: number },
  path: string,
): void {
  expect(answer.status).toBe(404);
  expect(fake.unknownRoutes()).toMatchObject([{ path, unknown: true }]);
}
