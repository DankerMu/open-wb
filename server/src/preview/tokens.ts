/**
 * 预览令牌登记表（preview-origin「预览令牌登记表」）：进程内、只在内存。
 * 每个 (ownerId, workspaceId) 至多一个未过期令牌；`issue` 续期，`lookup` 只做精确匹配、不续期。
 * 时钟由每次调用传入。本模块不做归属判断、不碰文件系统、不写日志与审计——那是调用方的事。
 */
import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
/** 闲置 15 分钟失效。 */
const TTL_MS = 900_000;

interface PreviewTokenBinding {
  ownerId: string;
  workspaceId: string;
  /** 签发请求的 `Origin` 头；没有该头时为 null。 */
  embedOrigin: string | null;
}

interface PreviewTokenRecord extends PreviewTokenBinding {
  expiresAt: number;
}

export interface PreviewTokens {
  /** `now` 为毫秒时间戳。未过期时返回同一个令牌并把到期时间赋值为 `now + 900000`。 */
  issue(binding: PreviewTokenBinding, now: number): { token: string; expiresAt: number };
  /** 精确字符串匹配；到期的记录视为不存在并被清除。不推后到期时间。 */
  lookup(token: string, now: number): PreviewTokenBinding | null;
}

/** 到期判定只有这一处：恰在 `expiresAt` 那一毫秒即已过期。 */
function isExpired(record: PreviewTokenRecord, now: number): boolean {
  return now >= record.expiresAt;
}

export function createPreviewTokens(): PreviewTokens {
  const byToken = new Map<string, PreviewTokenRecord>();
  /** ownerId → workspaceId → token。两层 Map，不把两个 id 拼成一个字符串键。 */
  const byOwner = new Map<string, Map<string, string>>();

  /** 两张表同时删。 */
  function drop(token: string, record: PreviewTokenRecord): void {
    byToken.delete(token);
    const workspaces = byOwner.get(record.ownerId);
    workspaces?.delete(record.workspaceId);
    if (workspaces?.size === 0) {
      byOwner.delete(record.ownerId);
    }
  }

  return {
    issue({ ownerId, workspaceId, embedOrigin }, now) {
      const expiresAt = now + TTL_MS;
      const held = byOwner.get(ownerId)?.get(workspaceId);
      const heldRecord = held === undefined ? undefined : byToken.get(held);
      if (held !== undefined && heldRecord !== undefined && !isExpired(heldRecord, now)) {
        heldRecord.expiresAt = expiresAt;
        heldRecord.embedOrigin = embedOrigin;
        return { token: held, expiresAt };
      }

      const token = randomBytes(TOKEN_BYTES).toString("hex");
      // 失败关闭：覆盖会把别人手里的令牌改指到本次的账号与空间。先查再动表，抛出时两张表原样。
      if (byToken.has(token)) {
        throw new Error("failed to issue preview token");
      }
      if (held !== undefined && heldRecord !== undefined) {
        drop(held, heldRecord);
      }
      byToken.set(token, { ownerId, workspaceId, embedOrigin, expiresAt });
      const workspaces = byOwner.get(ownerId) ?? new Map<string, string>();
      workspaces.set(workspaceId, token);
      byOwner.set(ownerId, workspaces);
      return { token, expiresAt };
    },

    lookup(token, now) {
      const record = byToken.get(token);
      if (record === undefined) {
        return null;
      }
      if (isExpired(record, now)) {
        drop(token, record);
        return null;
      }
      return {
        ownerId: record.ownerId,
        workspaceId: record.workspaceId,
        embedOrigin: record.embedOrigin,
      };
    },
  };
}
