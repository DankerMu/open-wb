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
import { STATE_MARK } from "@/lib/kb-status";
import { MUTED } from "./ingest-tree.js";
import { templateLabel } from "./templates.js";

const HEADERS = ["名称", "模板", "编译", "文档", "状态", "范围", "操作"];
export const TAG = "rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";
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
const SCOPE_TEXT: Readonly<Record<BaseView["scope"]["scope"], string>> = {
  me: "仅自己可见",
  dept: "本部门可见",
  group: "项目组可见",
  all: "全员可见",
};
const READ_ONLY = "只读";
const NAME_CLASS = "whitespace-normal [overflow-wrap:anywhere]";

/** 表头行（列表与文档表共用）。 */
export function HeaderRow({ headers }: { headers: readonly string[] }) {
  return (
    <TableHeader>
      <TableRow>
        {headers.map((header) => (
          <TableHead key={header}>{header}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** 页内错误与 `重试`（面板与详情共用）。 */
export function RetryAlert({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="ui-alert" role="alert">
        {message}
      </p>
      <Button onClick={onRetry} size="sm" type="button" variant="secondary">
        重试
      </Button>
    </div>
  );
}

/** 没有知识库时的空态。 */
export function KnowledgeBasesEmpty() {
  return (
    <section className="ui-empty">
      <p className="ui-muted">{EMPTY_TEXT}</p>
    </section>
  );
}

/** 范围标签（自有库与共享库同用，四档文案只在这里）；`group` 档带项目组名。本刀为纯文本，组 12 改为按钮。 */
export function ScopeLabel({ scope }: { scope: BaseView["scope"] }) {
  const text = SCOPE_TEXT[scope.scope];
  return <span className={TAG}>{scope.group ? `${text} · ${scope.group.name}` : text}</span>;
}

/** 名称格：自有库只有名称（`rowOf` 等定位器按全文匹配）；共享库加 `只读` 标签，下一行写所有者账号与部门。 */
function NameCell({ base }: { base: BaseView }) {
  if (base.owned) return <TableCell className={NAME_CLASS}>{base.name}</TableCell>;
  const { account, department } = base.owner;
  return (
    <TableCell className={NAME_CLASS}>
      <div className="flex flex-wrap items-center gap-1">
        <span>{base.name}</span>
        <span className={TAG}>{READ_ONLY}</span>
      </div>
      <p className={MUTED}>
        {department === null ? `来自 ${account}` : `来自 ${account} · ${department}`}
      </p>
    </TableCell>
  );
}

/**
 * 开着的每种编译一个标签。自有库加状态文案：`compile` 为 `null`（这一次没读到）时为 `状态未知`，有 `pending` 时带
 * 旁注；共享库只出标签。
 */
function CompileCell({ base }: { base: BaseView }) {
  const kinds = KINDS.filter(([kind]) => base[kind]);
  if (kinds.length === 0) return null;
  if (!base.owned) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {kinds.map(([kind, label]) => (
          <span className={TAG} key={kind}>
            {label}
          </span>
        ))}
      </div>
    );
  }
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
      {pending ? <p className={MUTED}>{PENDING_NOTE}</p> : null}
    </div>
  );
}

/**
 * 表上方的计数行（由 `bases` 现算）与知识库表（拷入层 table）：每行一个知识库，按 `listKnowledgeBases` 的次序；
 * 点行进入详情，当前打开的行带 `data-state="selected"`；行可聚焦，按 Enter 同样进入。`删除知识库` 只在自有库、
 * 且不在 `重建中` 时渲染，共享库整行没有按钮。
 */
export function KnowledgeBaseList({
  bases,
  selected,
  onOpen,
  onRemove,
}: {
  bases: readonly BaseView[];
  selected: string | null;
  onOpen(base: BaseView): void;
  /** 行按钮的点击把按钮本身交出去，供对话框关闭后归还焦点。 */
  onRemove(base: BaseView, trigger: HTMLElement): void;
}) {
  const owned = bases.filter((base) => base.owned).length;
  return (
    <>
      <p className="ui-muted">{`我的 ${owned} 个 · 共享给我 ${bases.length - owned} 个`}</p>
      <Table>
        <HeaderRow headers={HEADERS} />
        <TableBody>
          {bases.map((base) => {
            const mark = STATE_MARK[base.state];
            return (
              <TableRow
                className="cursor-pointer"
                data-state={base.id === selected ? "selected" : undefined}
                key={base.id}
                onClick={() => onOpen(base)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && event.key === "Enter") onOpen(base);
                }}
                tabIndex={0}
              >
                <NameCell base={base} />
                <TableCell>{templateLabel(base.template)}</TableCell>
                <TableCell>
                  <CompileCell base={base} />
                </TableCell>
                <TableCell>{base.documents}</TableCell>
                <TableCell>{mark ? <span className={TAG}>{mark}</span> : null}</TableCell>
                <TableCell>
                  <ScopeLabel scope={base.scope} />
                </TableCell>
                <TableCell>
                  {!base.owned || base.state === "rebuilding" ? null : (
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(base, event.currentTarget);
                      }}
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
    </>
  );
}
