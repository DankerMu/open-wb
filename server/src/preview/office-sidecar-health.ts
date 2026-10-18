/**
 * 转换 sidecar 的健康判定（office-preview「转换 sidecar 的健康与 fail-closed」；change
 * office-convert-sandbox design D5）：转换器每次转换前的心跳检查与入口启动时的预检都从这里取判定。
 *
 * 健康 = `<spool>/heartbeat` 的修改时间新鲜（`now − mtime < freshMs`）。sidecar 每 2 秒 touch 它
 * （`converter/sidecar.mjs`），`converter/healthcheck.mjs` 用同一判据。
 *
 * 预检永不 reject、永不校正：spool 是部署方建的卷，属主或 mode 不对不是 app 能修的，所以只答
 * `false`（fail-closed），不 chmod、不建目录、不走 `ensureOwnedDir` 的启动失败路径。比对用的 uid
 * 缺省为本进程的有效 uid，可注入以便单元测试伪造属主不符；根与 `heartbeat` 用同一个比对 uid。
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** 心跳的新鲜阈值，10 秒；写死，不是配置项。转换器与入口都用它。 */
export const HEARTBEAT_FRESH_MS = 10_000;

/** `heartbeat` 是普通文件（`lstat`，链接不算）且 `now − mtime < freshMs`；缺席或读不到即 `false`。 */
export function heartbeatFresh(
  spoolDir: string,
  options: { freshMs: number; now?: number },
): boolean {
  try {
    const stats = lstatSync(join(spoolDir, "heartbeat"));
    return stats.isFile() && (options.now ?? Date.now()) - stats.mtimeMs < options.freshMs;
  } catch {
    return false;
  }
}

/**
 * 启动预检：(1) spool 根是目录、属比对 uid、不带组与其它用户的写位；(2) 至多等 `waitMs`（每
 * `pollMs` 看一次）直到 `heartbeat` 新鲜；(3) `heartbeat` 存在时属比对 uid。任何一项不成立、任何
 * 抛出都落为 `false`。
 */
export async function preflightOfficeSidecar(options: {
  spoolDir: string;
  waitMs: number;
  pollMs: number;
  freshMs: number;
  uid?: number;
}): Promise<boolean> {
  const { spoolDir, waitMs, pollMs, freshMs } = options;
  try {
    const uid = options.uid ?? process.geteuid?.();
    const root = lstatSync(spoolDir);
    if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o022) !== 0) {
      return false;
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      const beat = lstatSync(join(spoolDir, "heartbeat"), { throwIfNoEntry: false });
      if (beat !== undefined && beat.uid !== uid) {
        return false;
      }
      if (heartbeatFresh(spoolDir, { freshMs })) {
        return true;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return false;
      }
      await delay(Math.min(pollMs, left));
    }
  } catch {
    return false;
  }
}
