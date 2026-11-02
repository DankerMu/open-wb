import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import type { BaseView, DocumentView } from "@/lib/api";
import { formatSize } from "../../files/index.js";
import { HeaderRow, TAG } from "./list.js";

const HEADERS = ["名称", "来源", "大小", "状态", "操作"];
const ROW_ERROR = "m-0 mt-1 text-xs whitespace-normal text-(--wb-status-error-text)";
const CHANGED = "源文件已变更";
const UPLOAD = "本地上传";

/** 状态文案（knowledge-bases「中心「知识库」tab」的详情）；`done` 为 `已切片 N`，N 可以是 0。 */
const STATUS_TEXT: Readonly<Record<Exclude<DocumentView["status"], "done">, string>> = {
  queued: "排队中",
  parsing: "解析中",
  failed: "解析失败",
  cancelled: "已取消",
  unparsed: "未解析",
  missing: "已丢失",
};

function statusText(item: DocumentView): string {
  return item.status === "done" ? `已切片 ${item.chunkCount}` : STATUS_TEXT[item.status];
}

/** 工作空间来源为 `<空间名>/<路径>`；空间名未知（不在列表里或列表没读到）时只有路径。 */
function sourceText(item: DocumentView, spaces: ReadonlyMap<string, string>): string {
  if (item.source === "upload") return UPLOAD;
  const space = item.workspaceId === null ? undefined : spaces.get(item.workspaceId);
  const path = item.path ?? "";
  return space === undefined ? path : `${space}/${path}`;
}

type Props = {
  documents: readonly DocumentView[];
  state: BaseView["state"];
  spaces: ReadonlyMap<string, string>;
  rowErrors: Readonly<Record<string, string>>;
  pending: ReadonlySet<string>;
  onReingest(id: string): void;
  onRemove(id: string): void;
};

/**
 * 文档表（拷入层 table），按 `listKbDocuments` 的次序。`源文件已变更` 只在 `sourceChanged` 为 `true` 时显示；
 * 工作空间来源的行有 `重新入库`，只在知识库 `ready` 时渲染；`移出` 在 `rebuilding` 时不渲染。行内错误在操作列下方。
 */
export function DocumentsTable({
  documents,
  state,
  spaces,
  rowErrors,
  pending,
  ...actions
}: Props) {
  return (
    <Table>
      <HeaderRow headers={HEADERS} />
      <TableBody>
        {documents.map((item) => {
          const busy = pending.has(item.id);
          const error = rowErrors[item.id];
          return (
            <TableRow key={item.id}>
              <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
                {item.name}
              </TableCell>
              <TableCell className="whitespace-normal font-mono text-xs [overflow-wrap:anywhere]">
                {sourceText(item, spaces)}
              </TableCell>
              <TableCell>{formatSize(item.size)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  <span>{statusText(item)}</span>
                  {item.sourceChanged === true ? <span className={TAG}>{CHANGED}</span> : null}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {state === "ready" && item.source === "workspace" ? (
                    <Button
                      disabled={busy}
                      onClick={() => actions.onReingest(item.id)}
                      size="sm"
                      variant="outline"
                    >
                      重新入库
                    </Button>
                  ) : null}
                  {state === "rebuilding" ? null : (
                    <Button
                      disabled={busy}
                      onClick={() => actions.onRemove(item.id)}
                      size="sm"
                      variant="outline"
                    >
                      移出
                    </Button>
                  )}
                </div>
                {error ? (
                  <p className={ROW_ERROR} role="alert">
                    {error}
                  </p>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
