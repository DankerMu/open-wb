import { availableParallelism } from "node:os";
import { isAbsolute, join } from "node:path";
import { assertSafeSudoPath, assertSetprivExecutable } from "./core/process-path.js";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type ModelCatalog,
  resolveModelCatalog,
} from "./model-catalog.js";

export { DEFAULT_MODEL_ID } from "./model-catalog.js";

export const DEFAULT_OMP_BIN_RELATIVE = join("var", "omp", "omp");
export const DEFAULT_OMP_STATE_RELATIVE = join("var", "omp-state");
export const DEFAULT_SANDBOX_RELATIVE = join("var", "sandbox");
export const DEFAULT_OMP_IDLE_MS = 600_000;
export const DEFAULT_OMP_MAX_PROCESSES = 16;
/** 单个上传文件的字节上限缺省值：500 MiB。 */
export const DEFAULT_UPLOAD_MAX_BYTES = 524_288_000;
export const DEFAULT_UPLOAD_MAX_FILES = 10;
/** 快照的单文件上限缺省值：20 MiB。 */
const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 20_971_520;
/** 一份快照的总字节上限缺省值：500 MiB。 */
const DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES = 524_288_000;
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 50_000;
/** 缺省只排除依赖目录；`.git` 不在其中（版本库目录进快照）。 */
const DEFAULT_SNAPSHOT_EXCLUDE_NAMES: readonly string[] = ["node_modules", ".venv", "__pycache__"];
/** 四个快照设置；经 sessions 的 runtime settings 对象到达 createApp 构造的快照服务。 */
export type SnapshotSettings = Pick<
  AgentSettings,
  "snapshotMaxFileBytes" | "snapshotMaxTotalBytes" | "snapshotMaxEntries" | "snapshotExcludeNames"
>;
/** runtime settings 对象未带某项时 createApp 取的值，与 `resolveAgentSettings` 的缺省同源。 */
export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotSettings = {
  snapshotMaxFileBytes: DEFAULT_SNAPSHOT_MAX_FILE_BYTES,
  snapshotMaxTotalBytes: DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES,
  snapshotMaxEntries: DEFAULT_SNAPSHOT_MAX_ENTRIES,
  snapshotExcludeNames: DEFAULT_SNAPSHOT_EXCLUDE_NAMES,
};
/** 正整数键的共同上界（原生计时器上限）。 */
const MAX_POSITIVE_SETTING = 2_147_483_647;

export interface AgentSettings {
  ompBin: string;
  ompStateDir: string;
  ompIdleMs: number;
  /** supervisor 全局活进程上限（4.1 消费）。 */
  ompMaxProcesses: number;
  /** supervisor 并发 spawn 上限（OMP_SPAWN_CONCURRENCY，缺省 os.availableParallelism()）。 */
  ompSpawnConcurrency: number;
  sandboxRoot: string;
  modelUpstreamBaseUrl?: string;
  modelUpstreamApiKey?: string;
  /** 模型白名单与缺省模型（MODEL_CATALOG；未设置时为 MODEL_ID / MODEL_REASONING 的单模型）。 */
  modelCatalog: ModelCatalog;
  ompUser?: string;
  /** 所有会话可用审批档位的上界（APPROVAL_MAX_MODE，缺省 yolo 即三档都开放）。 */
  approvalMaxMode: ApprovalMode;
  /** 单个上传文件的字节上限（UPLOAD_MAX_BYTES，缺省 524288000）。 */
  uploadMaxBytes: number;
  /** 一条消息可带的附件个数上限（UPLOAD_MAX_FILES，缺省 10）。 */
  uploadMaxFiles: number;
  /** 进快照的单个文件的字节上限（SNAPSHOT_MAX_FILE_BYTES，缺省 20971520）。 */
  snapshotMaxFileBytes: number;
  /** 一份快照里文件大小之和的上限（SNAPSHOT_MAX_TOTAL_BYTES，缺省 524288000）。 */
  snapshotMaxTotalBytes: number;
  /** 一份快照的条目数上限（SNAPSHOT_MAX_ENTRIES，缺省 50000）。 */
  snapshotMaxEntries: number;
  /** 任何层级上整棵不进快照的目录名（SNAPSHOT_EXCLUDE_NAMES，缺省 node_modules,.venv,__pycache__）。 */
  snapshotExcludeNames: readonly string[];
}

export function resolveAgentSettings(
  env: Record<string, string | undefined>,
  repoRoot: string,
): AgentSettings {
  const modelUpstreamBaseUrl = optionalSetting(
    env.MODEL_UPSTREAM_BASE_URL,
    "MODEL_UPSTREAM_BASE_URL",
  );
  const modelUpstreamApiKey = optionalSetting(env.MODEL_UPSTREAM_API_KEY, "MODEL_UPSTREAM_API_KEY");
  const modelCatalog = resolveModelCatalog(env);
  return {
    ompBin: resolveOwnedPath(env.OMP_BIN, DEFAULT_OMP_BIN_RELATIVE, repoRoot, "OMP_BIN"),
    ompStateDir: resolveOwnedPath(
      env.OMP_STATE_DIR,
      DEFAULT_OMP_STATE_RELATIVE,
      repoRoot,
      "OMP_STATE_DIR",
    ),
    ompIdleMs: resolvePositiveInteger(env.OMP_IDLE_MS, DEFAULT_OMP_IDLE_MS, "OMP_IDLE_MS"),
    ompMaxProcesses: resolvePositiveInteger(
      env.OMP_MAX_PROCESSES,
      DEFAULT_OMP_MAX_PROCESSES,
      "OMP_MAX_PROCESSES",
    ),
    ompSpawnConcurrency: resolvePositiveInteger(
      env.OMP_SPAWN_CONCURRENCY,
      availableParallelism(),
      "OMP_SPAWN_CONCURRENCY",
    ),
    sandboxRoot: resolveOwnedPath(
      env.SANDBOX_ROOT,
      DEFAULT_SANDBOX_RELATIVE,
      repoRoot,
      "SANDBOX_ROOT",
    ),
    ...(modelUpstreamBaseUrl === undefined ? {} : { modelUpstreamBaseUrl }),
    ...(modelUpstreamApiKey === undefined ? {} : { modelUpstreamApiKey }),
    modelCatalog,
    ...(env.OMP_USER === undefined ? {} : { ompUser: resolveOmpUser(env.OMP_USER, env.PATH) }),
    approvalMaxMode: resolveApprovalMaxMode(env.APPROVAL_MAX_MODE),
    uploadMaxBytes: resolvePositiveInteger(
      env.UPLOAD_MAX_BYTES,
      DEFAULT_UPLOAD_MAX_BYTES,
      "UPLOAD_MAX_BYTES",
    ),
    uploadMaxFiles: resolvePositiveInteger(
      env.UPLOAD_MAX_FILES,
      DEFAULT_UPLOAD_MAX_FILES,
      "UPLOAD_MAX_FILES",
    ),
    snapshotMaxFileBytes: resolvePositiveInteger(
      env.SNAPSHOT_MAX_FILE_BYTES,
      DEFAULT_SNAPSHOT_MAX_FILE_BYTES,
      "SNAPSHOT_MAX_FILE_BYTES",
    ),
    snapshotMaxTotalBytes: resolvePositiveInteger(
      env.SNAPSHOT_MAX_TOTAL_BYTES,
      DEFAULT_SNAPSHOT_MAX_TOTAL_BYTES,
      "SNAPSHOT_MAX_TOTAL_BYTES",
    ),
    snapshotMaxEntries: resolvePositiveInteger(
      env.SNAPSHOT_MAX_ENTRIES,
      DEFAULT_SNAPSHOT_MAX_ENTRIES,
      "SNAPSHOT_MAX_ENTRIES",
    ),
    snapshotExcludeNames: resolveSnapshotExcludeNames(env.SNAPSHOT_EXCLUDE_NAMES),
  };
}

export function resolveOwnedPath(
  raw: string | undefined,
  relativeDefault: string,
  repoRoot: string,
  key: string,
): string {
  if (raw === undefined) {
    return join(repoRoot, relativeDefault);
  }
  if (raw.length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  return isAbsolute(raw) ? raw : join(repoRoot, raw);
}

/** canonical ASCII decimal 正整数 1..2147483647；错误只命名键，不回显输入值。 */
export function resolvePositiveInteger(
  raw: string | undefined,
  fallback: number,
  key: string,
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[0-9]+$/u.test(raw) || (raw.length > 1 && raw.startsWith("0"))) {
    throw new Error(`${key} must be a canonical ASCII decimal`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POSITIVE_SETTING) {
    throw new Error(`${key} must be within 1..${MAX_POSITIVE_SETTING}`);
  }
  return value;
}

/** 只接受三个档位字面量的精确拼写（不 trim、不改大小写）；错误只命名键，不回显输入值。 */
function resolveApprovalMaxMode(raw: string | undefined): ApprovalMode {
  if (raw === undefined) {
    return "yolo";
  }
  const mode = APPROVAL_MODES.find((candidate) => candidate === raw);
  if (mode !== undefined) {
    return mode;
  }
  throw new Error("APPROVAL_MAX_MODE must be exactly always-ask, write or yolo");
}

/**
 * 逗号分隔的目录名（不 trim、不去重、保持书写顺序）；空字符串表示不排除任何目录。
 * 每个名字非空、不含 `/` 与 NUL、不是 `.` 或 `..`；错误只命名键，不回显输入值。
 */
function resolveSnapshotExcludeNames(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [...DEFAULT_SNAPSHOT_EXCLUDE_NAMES];
  }
  if (raw === "") {
    return [];
  }
  const names = raw.split(",");
  for (const name of names) {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new Error(
        "SNAPSHOT_EXCLUDE_NAMES must be comma-separated directory names without empty, '.', '..', '/' or NUL entries",
      );
    }
  }
  return names;
}

function optionalSetting(raw: string | undefined, key: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  return raw;
}

function resolveOmpUser(raw: string, path: string | undefined): string {
  if (raw.length < 1 || raw.length > 32 || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(raw)) {
    throw new Error("OMP_USER must match [a-z_][a-z0-9_-]{0,31}");
  }
  assertSafeSudoPath(path);
  assertSetprivExecutable();
  return raw;
}
