/**
 * 十二个预览与文件键（http-service-skeleton「服务启动与装配」）。
 * 纯函数：只读传入的 env，不碰文件系统、数据库与进程环境；agent-config 不反过来导入本文件。
 * 所有错误只点名出错的键，不回显取值。
 */
import { isAbsolute, join } from "node:path";
import { resolveOwnedPath, resolvePositiveInteger } from "./agent-config.js";

/** 缺省 0：由系统分配预览监听器的端口。 */
const DEFAULT_PREVIEW_PORT = 0;
const MAX_PORT = 65_535;
const DEFAULT_PREVIEW_CACHE_RELATIVE = join("var", "preview-cache");
const DEFAULT_OFFICE_CONVERT_TIMEOUT_MS = 60_000;
const DEFAULT_OFFICE_CONVERT_CONCURRENCY = 2;
/** 文本预览的字节上限缺省值：1 MiB。 */
const DEFAULT_PREVIEW_TEXT_MAX_BYTES = 1_048_576;
/** 图片预览的字节上限缺省值：20 MiB。 */
const DEFAULT_PREVIEW_IMAGE_MAX_BYTES = 20_971_520;
/** 文档预览的字节上限缺省值：100 MiB。 */
const DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES = 104_857_600;
/** Notebook 预览的字节上限缺省值：10 MiB。 */
const DEFAULT_PREVIEW_NOTEBOOK_MAX_BYTES = 10_485_760;
const DEFAULT_PREVIEW_ARCHIVE_MAX_ENTRIES = 1_000;
/**
 * 压缩包条目上限的可配上界（#1353）：一次列表的内存与响应大小同它成正比，响应是一次
 * `JSON.stringify`。只用于这一个键，其余数值键仍到 2147483647。
 */
const MAX_PREVIEW_ARCHIVE_MAX_ENTRIES = 10_000;
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

export interface PreviewSettings {
  /** 预览监听器的端口（PREVIEW_PORT，缺省 0 即由系统分配）。 */
  previewPort: number;
  /** 预览对外的来源，只有协议与 authority（PREVIEW_ORIGIN，可选）。 */
  previewOrigin?: string;
  /** 预览缓存目录（PREVIEW_CACHE_DIR，缺省 repo root 下 var/preview-cache）。 */
  previewCacheDir: string;
  /** 与转换 sidecar 共享的 spool 目录的绝对路径（OFFICE_SPOOL_DIR，可选；未配置即转换关闭）。 */
  officeSpoolDir?: string;
  /** 一次办公文档转换的时限（OFFICE_CONVERT_TIMEOUT_MS，缺省 60000）。 */
  officeConvertTimeoutMs: number;
  /** 同时进行的办公文档转换个数上限（OFFICE_CONVERT_CONCURRENCY，缺省 2）。 */
  officeConvertConcurrency: number;
  /** 文本预览的字节上限（PREVIEW_TEXT_MAX_BYTES，缺省 1048576）。 */
  previewTextMaxBytes: number;
  /** 图片预览的字节上限（PREVIEW_IMAGE_MAX_BYTES，缺省 20971520）。 */
  previewImageMaxBytes: number;
  /** 文档预览的字节上限（PREVIEW_DOCUMENT_MAX_BYTES，缺省 104857600）。 */
  previewDocumentMaxBytes: number;
  /** Notebook 预览的字节上限（PREVIEW_NOTEBOOK_MAX_BYTES，缺省 10485760）。 */
  previewNotebookMaxBytes: number;
  /** 压缩包成员列表的条目数上限（PREVIEW_ARCHIVE_MAX_ENTRIES，缺省 1000，范围 1..10000）。 */
  previewArchiveMaxEntries: number;
  /** 回收目录的保留天数（TRASH_RETENTION_DAYS，缺省 30）。 */
  trashRetentionDays: number;
}

export function resolvePreviewSettings(
  env: Record<string, string | undefined>,
  repoRoot: string,
): PreviewSettings {
  const previewOrigin = resolvePreviewOrigin(env.PREVIEW_ORIGIN);
  const officeSpoolDir = resolveOfficeSpoolDir(env.OFFICE_SPOOL_DIR, env.OFFICE_BIN);
  return {
    previewPort: resolvePreviewPort(env.PREVIEW_PORT),
    ...(previewOrigin === undefined ? {} : { previewOrigin }),
    previewCacheDir: resolveOwnedPath(
      env.PREVIEW_CACHE_DIR,
      DEFAULT_PREVIEW_CACHE_RELATIVE,
      repoRoot,
      "PREVIEW_CACHE_DIR",
    ),
    ...(officeSpoolDir === undefined ? {} : { officeSpoolDir }),
    officeConvertTimeoutMs: resolvePositiveInteger(
      env.OFFICE_CONVERT_TIMEOUT_MS,
      DEFAULT_OFFICE_CONVERT_TIMEOUT_MS,
      "OFFICE_CONVERT_TIMEOUT_MS",
    ),
    officeConvertConcurrency: resolvePositiveInteger(
      env.OFFICE_CONVERT_CONCURRENCY,
      DEFAULT_OFFICE_CONVERT_CONCURRENCY,
      "OFFICE_CONVERT_CONCURRENCY",
    ),
    previewTextMaxBytes: resolvePositiveInteger(
      env.PREVIEW_TEXT_MAX_BYTES,
      DEFAULT_PREVIEW_TEXT_MAX_BYTES,
      "PREVIEW_TEXT_MAX_BYTES",
    ),
    previewImageMaxBytes: resolvePositiveInteger(
      env.PREVIEW_IMAGE_MAX_BYTES,
      DEFAULT_PREVIEW_IMAGE_MAX_BYTES,
      "PREVIEW_IMAGE_MAX_BYTES",
    ),
    previewDocumentMaxBytes: resolvePositiveInteger(
      env.PREVIEW_DOCUMENT_MAX_BYTES,
      DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
      "PREVIEW_DOCUMENT_MAX_BYTES",
    ),
    previewNotebookMaxBytes: resolvePositiveInteger(
      env.PREVIEW_NOTEBOOK_MAX_BYTES,
      DEFAULT_PREVIEW_NOTEBOOK_MAX_BYTES,
      "PREVIEW_NOTEBOOK_MAX_BYTES",
    ),
    previewArchiveMaxEntries: resolvePositiveInteger(
      env.PREVIEW_ARCHIVE_MAX_ENTRIES,
      DEFAULT_PREVIEW_ARCHIVE_MAX_ENTRIES,
      "PREVIEW_ARCHIVE_MAX_ENTRIES",
      MAX_PREVIEW_ARCHIVE_MAX_ENTRIES,
    ),
    trashRetentionDays: resolvePositiveInteger(
      env.TRASH_RETENTION_DAYS,
      DEFAULT_TRASH_RETENTION_DAYS,
      "TRASH_RETENTION_DAYS",
    ),
  };
}

/** canonical ASCII decimal 0..65535；除允许 0 之外与 PORT 同一解析纪律。 */
function resolvePreviewPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PREVIEW_PORT;
  }
  if (!/^[0-9]+$/u.test(raw) || (raw.length > 1 && raw.startsWith("0"))) {
    throw new Error("PREVIEW_PORT must be a canonical ASCII decimal");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(`PREVIEW_PORT must be within 0..${MAX_PORT}`);
  }
  return port;
}

/** 只有协议与 authority：无路径、无结尾斜杠、无查询与片段；不 trim、不改大小写，空串同样非法。 */
function resolvePreviewOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^https?:\/\/[^/?#\s]+$/u.test(raw)) {
    throw new Error("PREVIEW_ORIGIN must be a scheme and authority only");
  }
  return raw;
}

/**
 * 给出时须为绝对路径（原样保留，不绑 repo root、不规范化、不查存在性、不建目录——存在性、属主与
 * mode 归启动预检）；空串同样非法。它 1:1 替换了 `OFFICE_BIN`（change office-convert-sandbox，owner
 * B8）：旧键仍被设置时不论取值都拒绝启动，免得升级后的部署把「没配 spool」看成 sidecar 宕机。
 */
function resolveOfficeSpoolDir(
  raw: string | undefined,
  retired: string | undefined,
): string | undefined {
  if (retired !== undefined) {
    throw new Error("OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR");
  }
  if (raw === undefined) {
    return undefined;
  }
  if (!isAbsolute(raw)) {
    throw new Error("OFFICE_SPOOL_DIR must be an absolute path");
  }
  return raw;
}
