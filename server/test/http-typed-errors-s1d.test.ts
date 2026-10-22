import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { handleHttpError } from "../src/http/index.js";

/** skeleton 场景「两个 s1d 新码」逐字抄录：独立于 core/errors 的期望来源。 */
const S1D_CODES = [
  ["forbidden", 403, "没有权限执行此操作"],
  ["model_in_use", 409, "该模型是缺省模型，先把缺省换成别的模型"],
] as const;

/** 同状态码兄弟（spec 码表既有十六码中的 403 与 409）。 */
const SIBLINGS = {
  forbidden: [
    ["account_disabled", "该账号已停用，请联系管理员"],
    ["sandbox_denied", "目标路径不在你的沙箱内，操作已拒绝"],
  ],
  model_in_use: [
    ["session_busy", "会话正在生成，请稍候"],
    ["conflict", "同名资源已存在"],
    ["approval_settled", "该审批已处理"],
    ["session_archived", "会话已归档，恢复后才能继续对话"],
    ["undo_conflict", "其它会话在这之后改动过工作空间"],
  ],
} as const;

describe("两个 s1d 新码：forbidden 403 / model_in_use 409", () => {
  it.each(S1D_CODES)(
    "自设 no-store 的测试路由抛 HttpError(%s) -> exact %i 信封且带 no-store",
    async (code, statusCode, message) => {
      const app = fastify({ logger: false });
      app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
      app.get<{ Params: { code: string } }>("/api/s1d-errors/:code", (request, reply) => {
        reply.header("cache-control", "no-store");
        throw new HttpError(request.params.code as HttpErrorCode);
      });
      try {
        const response = await app.inject({ method: "GET", url: `/api/s1d-errors/${code}` });
        expect(response.statusCode).toBe(statusCode);
        expect(response.payload).toBe(JSON.stringify({ error: { code, message } }));
        expect(response.headers["cache-control"]).toBe("no-store");
      } finally {
        await app.close();
      }
    },
  );

  it.each(S1D_CODES)("%s 的 code / message 与同状态码兄弟互不相同", (code, _status, message) => {
    const siblings = SIBLINGS[code];
    for (const [siblingCode, siblingMessage] of siblings) {
      expect(HTTP_ERROR_MESSAGES[siblingCode]).toBe(siblingMessage);
      expect(siblingCode).not.toBe(code);
      expect(siblingMessage).not.toBe(message);
    }
    expect(new Set([message, ...siblings.map(([, m]) => m)]).size).toBe(siblings.length + 1);
  });

  it("HttpError 携带 code 与中文 message", () => {
    for (const [code, , message] of S1D_CODES) {
      expect(new HttpError(code)).toMatchObject({ name: "HttpError", code, message });
    }
  });
});
