import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { handleHttpError } from "../src/http/index.js";

/** skeleton 场景「十二个知识库码」逐字抄录，次序同场景：独立于 core/errors 的期望来源。 */
const KB_CODES = [
  ["kb_disabled", 503, "知识库未启用"],
  ["kb_unavailable", 503, "知识库服务暂不可用"],
  ["kb_rejected", 400, "知识库服务拒绝了这个请求"],
  ["kb_not_ready", 409, "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型"],
  ["kb_rebuilding", 409, "知识库正在重建，请稍后再试"],
  ["kb_rebuild_required", 409, "更换嵌入模型需要重建全部知识库，请确认后再保存"],
  ["kb_limit", 409, "知识库或文档数已达上限"],
  ["kb_source_unreadable", 409, "源文件无法读取或已变动，未重新入库"],
  ["kb_model_in_use", 409, "该模型是知识库对话模型，先在知识库模型设置里换掉它"],
  ["kb_chat_model_locked", 409, "已有开启 RAPTOR 或知识图谱的知识库，不能更换或取消知识库对话模型"],
  ["kb_document_busy", 409, "文档正在停止解析，请稍后再试"],
  ["kb_file_unsupported", 400, "这个文件不能入库：模板不支持这种类型，或文件是空的"],
] as const;

/** spec 码表中与十二码同状态的既有十二码（400 / 409 / 503）。 */
const EXISTING_BY_STATUS: Record<number, readonly (readonly [HttpErrorCode, string])[]> = {
  400: [["bad_request", "请求格式不正确"]],
  409: [
    ["session_busy", "会话正在生成，请稍候"],
    ["conflict", "同名资源已存在"],
    ["approval_settled", "该审批已处理"],
    ["session_archived", "会话已归档，恢复后才能继续对话"],
    ["undo_conflict", "其它会话在这之后改动过工作空间"],
    ["model_in_use", "该模型是缺省模型，先把缺省换成别的模型"],
    ["mount_offline", "挂载已离线，重新连接后可用"],
    ["mount_limit", "挂载数已达上限"],
    ["mount_boundary", "挂载目录内不能删除，也不能跨挂载移动"],
  ],
  503: [
    ["agent_capacity", "Agent 容量已满，请稍后重试"],
    ["mount_disabled", "服务器未启用远程挂载"],
  ],
};

const GENERIC_BODY = JSON.stringify({ error: { message: "服务器内部错误" } });

/** 自设 no-store 的测试路由把 `thrown` 交给共享映射器；路由自带缓存策略（spec「Cache policy remains route-owned」）。 */
async function throwThroughRoute(thrown: unknown) {
  const app = fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  app.get("/api/kb-errors", (_request, reply) => {
    reply.header("cache-control", "no-store");
    throw thrown;
  });
  try {
    return await app.inject({ method: "GET", url: "/api/kb-errors" });
  } finally {
    await app.close();
  }
}

describe("十二个知识库码", () => {
  it("十二码依次响应 503、503、400、八个 409、400", async () => {
    const statuses: number[] = [];
    for (const [code] of KB_CODES) {
      statuses.push((await throwThroughRoute(new HttpError(code))).statusCode);
    }
    expect(statuses).toEqual([503, 503, 400, 409, 409, 409, 409, 409, 409, 409, 409, 400]);
  });

  it.each(KB_CODES)(
    "测试路由抛 HttpError(%s) -> exact %i 信封且带 no-store",
    async (code, statusCode, message) => {
      const response = await throwThroughRoute(new HttpError(code));
      expect(response.statusCode).toBe(statusCode);
      expect(response.payload).toBe(JSON.stringify({ error: { code, message } }));
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );

  it("码表恰三十七码，十二码都在其中", () => {
    const codes = Object.keys(HTTP_ERROR_MESSAGES);
    expect(codes).toHaveLength(37);
    expect(codes).toEqual(expect.arrayContaining(KB_CODES.map(([code]) => code)));
  });

  it.each([400, 409, 503])("%i 的全部码（既有 + 知识库）code 与 message 各自唯一", (status) => {
    const existing = EXISTING_BY_STATUS[status] ?? [];
    const kb = KB_CODES.filter(([, statusCode]) => statusCode === status);
    expect(kb.length).toBeGreaterThan(0);
    for (const [code, message] of existing) {
      expect(HTTP_ERROR_MESSAGES[code]).toBe(message);
    }
    for (const [code, , message] of kb) {
      expect(HTTP_ERROR_MESSAGES[code]).toBe(message);
    }
    const all = [...existing, ...kb.map(([code, , message]) => [code, message] as const)];
    expect(new Set(all.map(([code]) => code)).size).toBe(all.length);
    expect(new Set(all.map(([, message]) => message)).size).toBe(all.length);
  });

  it("HttpError 携带 code 与中文 message", () => {
    for (const [code, , message] of KB_CODES) {
      expect(new HttpError(code)).toMatchObject({ name: "HttpError", code, message });
    }
  });
});

/** 守卫，预期始终为绿：伪造 code/statusCode 的对象没有 HttpError 身份，只能得 generic 5xx。 */
describe("伪造知识库码形状的对象不被误标（守卫）", () => {
  it('伪造 {code:"kb_unavailable",statusCode:503} 的普通对象 -> generic 500', async () => {
    const response = await throwThroughRoute({ code: "kb_unavailable", statusCode: 503 });
    expect(response.statusCode).toBe(500);
    expect(response.payload).toBe(GENERIC_BODY);
  });

  it.each(KB_CODES)(
    "普通对象与普通 Error 携 code=%s/statusCode=%i 保持 generic 500、不回显码与文案",
    async (code, statusCode, message) => {
      const forgedObject = { code, statusCode, message };
      const forgedError = Object.assign(new Error(message), { code, statusCode });
      for (const forged of [forgedObject, forgedError]) {
        const response = await throwThroughRoute(forged);
        expect(response.statusCode).toBe(500);
        expect(response.payload).toBe(GENERIC_BODY);
      }
    },
  );
});
