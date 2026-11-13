/**
 * 知识库命中列表（s2b-kb-retrieval D8 的「检索测试」结果区，s2c-kb-session 起会话「知识库检索」卡共用）：每条命中
 * 显示文档名、`相似度` 加两位小数的分数与切片原文；原文是 React 文本节点（`whitespace-pre-wrap`），不经 Markdown
 * 或 HTML。`numbered` 时每条带 `#1` 起的序号徽标（检索面板），会话检索卡不带。
 */
type KbHit = { name: string; similarity: number; content: string };

/** 命中按给定次序；同一文档可有多条，所以 key 用下标（用 `documentId` 会有重复 key）。 */
export function KbHitList({ hits, numbered }: { hits: readonly KbHit[]; numbered: boolean }) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
    <ol className="m-0 flex list-none flex-col gap-2 p-0" role="list">
      {hits.map((hit, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 整份替换、只读；同一文档可有多条命中，documentId 不唯一。
        <li className="min-w-0 rounded-lg border px-3 py-2" key={index}>
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {numbered ? (
              <span className="shrink-0 rounded-[4px] border px-1 text-[10px] leading-[15px]">
                {`#${index + 1}`}
              </span>
            ) : null}
            <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{hit.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {`相似度 ${hit.similarity.toFixed(2)}`}
            </span>
          </div>
          <p className="m-0 text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {hit.content}
          </p>
        </li>
      ))}
    </ol>
  );
}
