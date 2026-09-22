import { isAbsolute, join } from "node:path";

export const DEFAULT_OMP_BIN_RELATIVE = join("var", "omp", "omp");
export const DEFAULT_OMP_STATE_RELATIVE = join("var", "omp-state");
export const DEFAULT_SANDBOX_RELATIVE = join("var", "sandbox");
export const DEFAULT_OMP_IDLE_MS = 600_000;
export const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";
const MAX_OMP_IDLE_MS = 2_147_483_647;

export interface AgentSettings {
  ompBin: string;
  ompStateDir: string;
  ompIdleMs: number;
  sandboxRoot: string;
  modelUpstreamBaseUrl?: string;
  modelUpstreamApiKey?: string;
  modelId: string;
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
    ompIdleMs: resolveIdleMs(env.OMP_IDLE_MS),
    sandboxRoot: resolveOwnedPath(
      env.SANDBOX_ROOT,
      DEFAULT_SANDBOX_RELATIVE,
      repoRoot,
      "SANDBOX_ROOT",
    ),
    ...(modelUpstreamBaseUrl === undefined ? {} : { modelUpstreamBaseUrl }),
    ...(modelUpstreamApiKey === undefined ? {} : { modelUpstreamApiKey }),
    modelId: env.MODEL_ID === undefined ? DEFAULT_MODEL_ID : env.MODEL_ID,
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

function resolveIdleMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_OMP_IDLE_MS;
  }
  if (!/^[0-9]+$/u.test(raw) || (raw.length > 1 && raw.startsWith("0"))) {
    throw new Error("OMP_IDLE_MS must be a canonical ASCII decimal");
  }
  const idleMs = Number(raw);
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > MAX_OMP_IDLE_MS) {
    throw new Error("OMP_IDLE_MS must be within 1..2147483647");
  }
  return idleMs;
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
