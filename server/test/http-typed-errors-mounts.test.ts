import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { handleHttpError } from "../src/http/index.js";

/** skeleton 场景「七个挂载码」逐字抄录（design D17 同表）：独立于 core/errors 的期望来源。 */
const MOUNT_CODES = [
  ["mount_disabled", 503, "服务器未启用远程挂载"],
  ["mount_failed", 502, "挂载失败，请检查主机、路径与凭证"],
  ["mount_offline", 409, "挂载已离线，重新连接后可用"],
  ["mount_limit", 409, "挂载数已达上限"],
  ["mount_host_rejected", 403, "该主机不允许挂载"],
  ["mount_read_only", 403, "只读挂载不能写入"],
  ["mount_boundary", 409, "挂载目录内不能删除，也不能跨挂载移动"],
] as const;

/** spec 码表中与七码同状态的既有十八码兄弟（403 / 409 / 502 / 503）。 */
const EXISTING_BY_STATUS: Record<number, readonly (readonly [string, string])[]> = {
  403: [
    ["account_disabled", "该账号已停用，请联系管理员"],
    ["sandbox_denied", "目标路径不在你的沙箱内，操作已拒绝"],
    ["forbidden", "没有权限执行此操作"],
  ],
  409: [
    ["session_busy", "会话正在生成，请稍候"],
    ["conflict", "同名资源已存在"],
    ["approval_settled", "该审批已处理"],
    ["session_archived", "会话已归档，恢复后才能继续对话"],
    ["undo_conflict", "其它会话在这之后改动过工作空间"],
    ["model_in_use", "该模型是缺省模型，先把缺省换成别的模型"],
  ],
  502: [["agent_unavailable", "Agent 运行时不可用"]],
  503: [["agent_capacity", "Agent 容量已满，请稍后重试"]],
};

const GENERIC_BODY = JSON.stringify({ error: { message: "服务器内部错误" } });

interface ReplyCapture {
  statusCode?: number;
  body?: string;
}

/** 直接驱动共享 handleHttpError 时捕获 reply.code/send（系统边界：Fastify reply）。 */
function mapError(error: unknown): ReplyCapture {
  const captured: ReplyCapture = {};
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      captured.body = JSON.stringify(body);
      return this;
    },
  } as unknown as FastifyReply;
  const request = {
    method: "GET",
    url: "/api/mount-errors/x",
    routeOptions: { url: "/api/mount-errors/:code" },
  } as unknown as FastifyRequest;
  handleHttpError(error, request, reply);
  return captured;
}

describe("七个挂载码：mount_* 的状态、信封与 no-store", () => {
  it("七码依次为 503、502、409、409、403、403、409", () => {
    expect(MOUNT_CODES.map(([, statusCode]) => statusCode)).toEqual([
      503, 502, 409, 409, 403, 403, 409,
    ]);
  });

  it.each(MOUNT_CODES)(
    "自设 no-store 的测试路由抛 HttpError(%s) -> exact %i 信封且带 no-store",
    async (code, statusCode, message) => {
      const app = fastify({ logger: false });
      app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
      app.get<{ Params: { code: string } }>("/api/mount-errors/:code", (request, reply) => {
        reply.header("cache-control", "no-store");
        throw new HttpError(request.params.code as HttpErrorCode);
      });
      try {
        const response = await app.inject({ method: "GET", url: `/api/mount-errors/${code}` });
        expect(response.statusCode).toBe(statusCode);
        expect(response.payload).toBe(JSON.stringify({ error: { code, message } }));
        expect(response.headers["cache-control"]).toBe("no-store");
      } finally {
        await app.close();
      }
    },
  );

  it.each(MOUNT_CODES)("%s 的 code / message 与同状态既有码互不相同", (code, status, message) => {
    const siblings = EXISTING_BY_STATUS[status] ?? [];
    expect(siblings.length).toBeGreaterThan(0);
    for (const [siblingCode, siblingMessage] of siblings) {
      expect(HTTP_ERROR_MESSAGES[siblingCode as HttpErrorCode]).toBe(siblingMessage);
      expect(siblingCode).not.toBe(code);
      expect(siblingMessage).not.toBe(message);
    }
  });

  it("同状态的全部码（既有 + 新增）code 与 message 各自唯一", () => {
    for (const status of [403, 409, 502, 503]) {
      const all = [
        ...(EXISTING_BY_STATUS[status] ?? []),
        ...MOUNT_CODES.filter(([, s]) => s === status).map(([c, , m]) => [c, m] as const),
      ];
      expect(new Set(all.map(([c]) => c)).size).toBe(all.length);
      expect(new Set(all.map(([, m]) => m)).size).toBe(all.length);
    }
  });

  it("HttpError 携带 code 与中文 message", () => {
    for (const [code, , message] of MOUNT_CODES) {
      expect(new HttpError(code)).toMatchObject({ name: "HttpError", code, message });
    }
  });
});

/** 守卫：伪造 code/statusCode 的普通对象或普通 Error 没有 HttpError 身份，只能得 generic 5xx。 */
describe("伪造挂载码形状的对象不被误标", () => {
  it('伪造 {code:"mount_failed",statusCode:502} 的普通对象 -> generic 500', () => {
    const captured = mapError({ code: "mount_failed", statusCode: 502 });
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toBe(GENERIC_BODY);
  });

  it.each(MOUNT_CODES)(
    "普通对象与普通 Error 携 code=%s/statusCode=%i 保持 generic 500、不回显码",
    (code, statusCode, message) => {
      const forgedObject = { code, statusCode, message };
      const forgedError = Object.assign(new Error(message), { code, statusCode });
      for (const forged of [forgedObject, forgedError]) {
        const captured = mapError(forged);
        expect(captured.statusCode).toBe(500);
        expect(captured.body).toBe(GENERIC_BODY);
        expect(captured.body).not.toContain(code);
      }
    },
  );
});
