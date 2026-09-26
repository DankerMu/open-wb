import { isAbsolute, join } from "node:path";
import { assertSafeSudoPath, assertSetprivExecutable } from "./core/process-path.js";

export const DEFAULT_OMP_BIN_RELATIVE = join("var", "omp", "omp");
export const DEFAULT_OMP_STATE_RELATIVE = join("var", "omp-state");
export const DEFAULT_SANDBOX_RELATIVE = join("var", "sandbox");
export const DEFAULT_OMP_IDLE_MS = 600_000;
export const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";
const DEFAULT_OMP_MAX_PROCESSES = 16;
/** 两个正整数键的共同上界（原生计时器上限）。 */
const MAX_POSITIVE_SETTING = 2_147_483_647;

export interface AgentSettings {
  ompBin: string;
  ompStateDir: string;
  ompIdleMs: number;
  /** supervisor 全局活进程上限（4.1 消费）。 */
  ompMaxProcesses: number;
  sandboxRoot: string;
  modelUpstreamBaseUrl?: string;
  modelUpstreamApiKey?: string;
  modelId: string;
  ompUser?: string;
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
    sandboxRoot: resolveOwnedPath(
      env.SANDBOX_ROOT,
      DEFAULT_SANDBOX_RELATIVE,
      repoRoot,
      "SANDBOX_ROOT",
    ),
    ...(modelUpstreamBaseUrl === undefined ? {} : { modelUpstreamBaseUrl }),
    ...(modelUpstreamApiKey === undefined ? {} : { modelUpstreamApiKey }),
    modelId: env.MODEL_ID === undefined ? DEFAULT_MODEL_ID : env.MODEL_ID,
    ...(env.OMP_USER === undefined ? {} : { ompUser: resolveOmpUser(env.OMP_USER, env.PATH) }),
  };
}

function resolveOwnedPath(
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
function resolvePositiveInteger(raw: string | undefined, fallback: number, key: string): number {
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
