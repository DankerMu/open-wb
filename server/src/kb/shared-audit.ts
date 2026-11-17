/**
 * 共享检索审计（s2c-kb-visibility D6；knowledge-bases「知识库审计」的 `kb.shared_retrieval`）：可见的非所有者每检索一次共享库
 * 写一条，写在检索请求之前，与检索结果无关；对自己的库检索不写。检索测试端点在检索前调它。
 *
 * detail 只取调用方首判得到的 `access`，不重读库；不含问句。不开事务（单独写入），不吞错：写失败原样抛出，由调用方决定。
 */
import type { BaseAccess } from "./visibility.js";

export interface SharedRetrievalEvent {
  kind: "kb.shared_retrieval";
  actorId: string;
  title: string;
  detail: {
    id: string;
    name: string;
    ownerId: string;
    scope: { scope: BaseAccess["scope"]["scope"]; groupId: string | null };
  };
}

/** `access.owned` 为真时什么都不做。 */
export function auditSharedRetrieval(
  deps: { audit: (event: SharedRetrievalEvent) => void },
  viewerId: string,
  access: BaseAccess,
): void {
  if (access.owned) {
    return;
  }
  deps.audit({
    kind: "kb.shared_retrieval",
    actorId: viewerId,
    title: "检索共享知识库",
    detail: {
      id: access.base.id,
      name: access.base.name,
      ownerId: access.owner.id,
      scope: { scope: access.scope.scope, groupId: access.scope.group?.id ?? null },
    },
  });
}
