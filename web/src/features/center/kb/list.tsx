import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BaseView } from "@/lib/api";
import { templateLabel } from "./templates.js";

const HEADERS = ["名称", "模板", "编译", "文档", "状态", "操作"];
const TAG = "rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";
const EMPTY_TEXT = "还没有知识库";

type CompileState = NonNullable<BaseView["compile"]>["raptor"];

/**
 * 编译状态文案（s2a-kb-ragflow D14 的已知限制、D19）：都不写「编译失败」——`pending` 没有失败信号，`failed` 来自文档。
 * `off` 只出现在关着的类型上，关着的类型不显示。
 */
const COMPILE_TEXT: Readonly<Record<Exclude<CompileState, "off">, string>> = {
  pending: "尚未产出",
  running: "编译中",
  done: "已完成",
  failed: "有文档失败",
};
const UNKNOWN_TEXT = "状态未知";
const PENDING_NOTE = "解析完成后长时间没有变化，可能是知识库对话模型不可用，请联系管理员";
const KINDS = [
  ["raptor", "RAPTOR"],
  ["graph", "知识图谱"],
] as const;

const STATE_MARK: Readonly<Record<BaseView["state"], string | null>> = {
  ready: null,
  rebuilding: "重建中",
  rebuild_failed: "重建失败",
};

/** 没有知识库时的空态。 */
export function KnowledgeBasesEmpty() {
  return (
    <section className="ui-empty">
      <p className="ui-muted">{EMPTY_TEXT}</p>
    </section>
  );
}

/** 开着的每种编译一个标签加状态文案；`compile` 为 `null`（这一次没读到）时为 `状态未知`；有 `pending` 时带旁注。 */
function CompileCell({ base }: { base: BaseView }) {
  const kinds = KINDS.filter(([kind]) => base[kind]);
  if (kinds.length === 0) return null;
  const { compile } = base;
  const pending = compile !== null && kinds.some(([kind]) => compile[kind] === "pending");
  return (
    <div className="flex flex-col gap-1 whitespace-normal">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {kinds.map(([kind, label]) => {
          const state = compile?.[kind];
          return (
            <span className="flex items-center gap-1" key={kind}>
              <span className={TAG}>{label}</span>
              {state === undefined ? UNKNOWN_TEXT : state === "off" ? null : COMPILE_TEXT[state]}
            </span>
          );
        })}
      </div>
      {pending ? <p className="m-0 text-xs text-muted-foreground">{PENDING_NOTE}</p> : null}
    </div>
  );
}

/** 知识库表（拷入层 table）：每行一个知识库，按 `listKnowledgeBases` 的次序；`重建中` 的行不渲染 `删除知识库`。 */
export function KnowledgeBaseList({
  bases,
  onRemove,
}: {
  bases: readonly BaseView[];
  /** 行按钮的点击把按钮本身交出去，供对话框关闭后归还焦点。 */
  onRemove(base: BaseView, trigger: HTMLElement): void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {bases.map((base) => {
          const mark = STATE_MARK[base.state];
          return (
            <TableRow key={base.id}>
              <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
                {base.name}
              </TableCell>
              <TableCell>{templateLabel(base.template)}</TableCell>
              <TableCell>
                <CompileCell base={base} />
              </TableCell>
              <TableCell>{base.documents}</TableCell>
              <TableCell>{mark ? <span className={TAG}>{mark}</span> : null}</TableCell>
              <TableCell>
                {base.state === "rebuilding" ? null : (
                  <Button
                    onClick={(event) => onRemove(base, event.currentTarget)}
                    size="sm"
                    variant="outline"
                  >
                    删除知识库
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
