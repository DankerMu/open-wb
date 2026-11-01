/**
 * 知识库的四个配置键（s2a-kb-ragflow D3，http-service-skeleton「服务启动与装配」的知识库键）。
 * 纯配置 seam 的一部分：由 `resolveServerConfig` 展开，不碰文件系统——密钥文件的内容归启动阶段 `kb_key`
 * （`key-file.ts`）。错误只点名键，不回显任何取值。
 */
import { isAbsolute } from "node:path";
import { resolvePositiveInteger } from "../agent-config.js";
import { SCHEME_AND_AUTHORITY } from "../preview-config.js";

/** 单个文件的字节上限缺省值：100 MiB。 */
const DEFAULT_KB_UPLOAD_MAX_BYTES = 104_857_600;
const DEFAULT_KB_UPLOAD_MAX_FILES = 10;

export interface KbSettings {
  /** RAGFlow 的地址（RAGFLOW_BASE_URL）；未配置即知识库关闭，与 `ragflowApiKeyFile` 同在。 */
  ragflowBaseUrl?: string;
  /** 密钥文件的绝对路径（RAGFLOW_API_KEY_FILE）；解析时不读它。 */
  ragflowApiKeyFile?: string;
  /** 单个文件的字节上限（KB_UPLOAD_MAX_BYTES，缺省 104857600）。 */
  kbUploadMaxBytes: number;
  /** 一次上传的文件数上限（KB_UPLOAD_MAX_FILES，缺省 10）。 */
  kbUploadMaxFiles: number;
}

export function resolveKbSettings(env: Record<string, string | undefined>): KbSettings {
  const { RAGFLOW_BASE_URL: ragflowBaseUrl, RAGFLOW_API_KEY_FILE: ragflowApiKeyFile } = env;
  if (ragflowBaseUrl !== undefined && !SCHEME_AND_AUTHORITY.test(ragflowBaseUrl)) {
    throw new Error("RAGFLOW_BASE_URL must be a scheme and authority only");
  }
  if (ragflowApiKeyFile !== undefined && !isAbsolute(ragflowApiKeyFile)) {
    throw new Error("RAGFLOW_API_KEY_FILE must be an absolute path");
  }
  if (ragflowBaseUrl !== undefined && ragflowApiKeyFile === undefined) {
    throw new Error("RAGFLOW_API_KEY_FILE must be set together with RAGFLOW_BASE_URL");
  }
  if (ragflowBaseUrl === undefined && ragflowApiKeyFile !== undefined) {
    throw new Error("RAGFLOW_BASE_URL must be set together with RAGFLOW_API_KEY_FILE");
  }
  return {
    ...(ragflowBaseUrl === undefined ? {} : { ragflowBaseUrl }),
    ...(ragflowApiKeyFile === undefined ? {} : { ragflowApiKeyFile }),
    kbUploadMaxBytes: resolvePositiveInteger(
      env.KB_UPLOAD_MAX_BYTES,
      DEFAULT_KB_UPLOAD_MAX_BYTES,
      "KB_UPLOAD_MAX_BYTES",
    ),
    kbUploadMaxFiles: resolvePositiveInteger(
      env.KB_UPLOAD_MAX_FILES,
      DEFAULT_KB_UPLOAD_MAX_FILES,
      "KB_UPLOAD_MAX_FILES",
    ),
  };
}
