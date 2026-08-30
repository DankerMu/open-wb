/** app-server 自描述：健康探针与日志启动行共用，P0 起接入 /healthz。 */
export const SERVICE_INFO = {
  name: "workbuddy-app-server",
  version: "0.0.0",
} as const;

/** 语义化版本校验：CI 发布链路用它拒绝手滑写坏的版本号。 */
export function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}
