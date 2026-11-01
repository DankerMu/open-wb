/**
 * Canonical application errors: codes, messages, and HttpError identity.
 * HTTP statuses, content-parser ownership, and reply mapping remain in http/.
 */
export const HTTP_ERROR_MESSAGES = Object.freeze({
  bad_request: "请求格式不正确",
  invalid_credentials: "账号或密码不正确",
  account_disabled: "该账号已停用，请联系管理员",
  unauthorized: "请先登录",
  not_found: "请求的资源不存在",
  session_busy: "会话正在生成，请稍候",
  agent_unavailable: "Agent 运行时不可用",
  sandbox_denied: "目标路径不在你的沙箱内，操作已拒绝",
  conflict: "同名资源已存在",
  preview_too_large: "文件过大，无法预览",
  preview_unsupported: "该类型不支持预览",
  agent_capacity: "Agent 容量已满，请稍后重试",
  approval_settled: "该审批已处理",
  session_archived: "会话已归档，恢复后才能继续对话",
  undo_conflict: "其它会话在这之后改动过工作空间",
  upload_too_large: "文件超过大小上限",
  forbidden: "没有权限执行此操作",
  model_in_use: "该模型是缺省模型，先把缺省换成别的模型",
  mount_disabled: "服务器未启用远程挂载",
  mount_failed: "挂载失败，请检查主机、路径与凭证",
  mount_offline: "挂载已离线，重新连接后可用",
  mount_limit: "挂载数已达上限",
  mount_host_rejected: "该主机不允许挂载",
  mount_read_only: "只读挂载不能写入",
  mount_boundary: "挂载目录内不能删除，也不能跨挂载移动",
  kb_disabled: "知识库未启用",
  kb_unavailable: "知识库服务暂不可用",
  kb_rejected: "知识库服务拒绝了这个请求",
  kb_not_ready: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
  kb_rebuilding: "知识库正在重建，请稍后再试",
  kb_rebuild_required: "更换嵌入模型需要重建全部知识库，请确认后再保存",
  kb_limit: "知识库或文档数已达上限",
  kb_source_unreadable: "源文件无法读取或已变动，未重新入库",
  kb_model_in_use: "该模型是知识库对话模型，先在知识库模型设置里换掉它",
  kb_chat_model_locked: "已有开启 RAPTOR 或知识图谱的知识库，不能更换或取消知识库对话模型",
  kb_document_busy: "文档正在停止解析，请稍后再试",
  kb_file_unsupported: "这个文件不能入库：模板不支持这种类型，或文件是空的",
});

export type HttpErrorCode = keyof typeof HTTP_ERROR_MESSAGES;

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode) {
    super(HTTP_ERROR_MESSAGES[code]);
    this.name = "HttpError";
    this.code = code;
  }
}
