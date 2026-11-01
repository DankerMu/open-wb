import { describe, expect, it } from "vitest";
import type { AuthErrorCode } from "../src/auth/errors.js";
import { HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { loginSessionPair, withApp } from "./auth-lifecycle-helpers.js";

describe("HTTP typed error map 恰三十七码（auth 域只复用既有 unauthorized）", () => {
  const codes = {
    bad_request: { statusCode: 400, message: "请求格式不正确" },
    invalid_credentials: { statusCode: 401, message: "账号或密码不正确" },
    account_disabled: { statusCode: 403, message: "该账号已停用，请联系管理员" },
    unauthorized: { statusCode: 401, message: "请先登录" },
    not_found: { statusCode: 404, message: "请求的资源不存在" },
    session_busy: { statusCode: 409, message: "会话正在生成，请稍候" },
    agent_unavailable: { statusCode: 502, message: "Agent 运行时不可用" },
    sandbox_denied: { statusCode: 403, message: "目标路径不在你的沙箱内，操作已拒绝" },
    conflict: { statusCode: 409, message: "同名资源已存在" },
    preview_too_large: { statusCode: 413, message: "文件过大，无法预览" },
    preview_unsupported: { statusCode: 415, message: "该类型不支持预览" },
    agent_capacity: { statusCode: 503, message: "Agent 容量已满，请稍后重试" },
    approval_settled: { statusCode: 409, message: "该审批已处理" },
    session_archived: { statusCode: 409, message: "会话已归档，恢复后才能继续对话" },
    undo_conflict: { statusCode: 409, message: "其它会话在这之后改动过工作空间" },
    upload_too_large: { statusCode: 413, message: "文件超过大小上限" },
    forbidden: { statusCode: 403, message: "没有权限执行此操作" },
    model_in_use: { statusCode: 409, message: "该模型是缺省模型，先把缺省换成别的模型" },
    mount_disabled: { statusCode: 503, message: "服务器未启用远程挂载" },
    mount_failed: { statusCode: 502, message: "挂载失败，请检查主机、路径与凭证" },
    mount_offline: { statusCode: 409, message: "挂载已离线，重新连接后可用" },
    mount_limit: { statusCode: 409, message: "挂载数已达上限" },
    mount_host_rejected: { statusCode: 403, message: "该主机不允许挂载" },
    mount_read_only: { statusCode: 403, message: "只读挂载不能写入" },
    mount_boundary: { statusCode: 409, message: "挂载目录内不能删除，也不能跨挂载移动" },
    kb_disabled: { statusCode: 503, message: "知识库未启用" },
    kb_unavailable: { statusCode: 503, message: "知识库服务暂不可用" },
    kb_rejected: { statusCode: 400, message: "知识库服务拒绝了这个请求" },
    kb_not_ready: {
      statusCode: 409,
      message: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
    },
    kb_rebuilding: { statusCode: 409, message: "知识库正在重建，请稍后再试" },
    kb_rebuild_required: {
      statusCode: 409,
      message: "更换嵌入模型需要重建全部知识库，请确认后再保存",
    },
    kb_limit: { statusCode: 409, message: "知识库或文档数已达上限" },
    kb_source_unreadable: { statusCode: 409, message: "源文件无法读取或已变动，未重新入库" },
    kb_model_in_use: {
      statusCode: 409,
      message: "该模型是知识库对话模型，先在知识库模型设置里换掉它",
    },
    kb_chat_model_locked: {
      statusCode: 409,
      message: "已有开启 RAPTOR 或知识图谱的知识库，不能更换或取消知识库对话模型",
    },
    kb_document_busy: { statusCode: 409, message: "文档正在停止解析，请稍后再试" },
    kb_file_unsupported: {
      statusCode: 400,
      message: "这个文件不能入库：模板不支持这种类型，或文件是空的",
    },
  } as const satisfies Record<HttpErrorCode, { statusCode: number; message: string }>;

  /**
   * 编译期双向穷尽守卫：HTTP typed map 增码会让 `HttpCodesNotListed` 非 never，
   * 从而使下面的赋值在 `make typecheck` 失败；删码则由上面的 `satisfies Record<HttpErrorCode,…>`
   * 注解失败。auth 域同理：只允许既有四码，不把 session_busy/agent_unavailable 扩进 AuthErrorCode。
   */
  type HttpCodesNotListed = Exclude<HttpErrorCode, keyof typeof codes>;
  type AuthCodesNotListed = Exclude<
    AuthErrorCode,
    "bad_request" | "invalid_credentials" | "account_disabled" | "unauthorized"
  >;
  const noExtraHttpCodes: [HttpCodesNotListed] extends [[]] ? true : false = true;
  const noExtraAuthCodes: [AuthCodesNotListed] extends [[]] ? true : false = true;
  void noExtraHttpCodes;
  void noExtraAuthCodes;

  it.each(Object.entries(codes))(
    "typed code %s 的 exact 信封逐字节稳定（me/logout 复用同一 unauthorized 定义）",
    async (code, definition) => {
      await withApp({}, async ({ app }) => {
        app.get(`/api/test-envelope/${code}`, () => {
          throw new HttpError(code as HttpErrorCode);
        });
        // typed 信封是 handler/error-handler 层合同：先建立会话穿过 #19 守卫再观察
        const pair = await loginSessionPair(app);
        const response = await app.inject({
          method: "GET",
          url: `/api/test-envelope/${code}`,
          headers: { cookie: pair },
        });
        expect(response.statusCode).toBe(definition.statusCode);
        expect(response.payload).toBe(
          JSON.stringify({ error: { code, message: definition.message } }),
        );
      });
    },
  );
});
