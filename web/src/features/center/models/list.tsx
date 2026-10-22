import type { MouseEvent } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ModelView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";

const HEADERS = ["ID", "名称", "能力", "最大 tokens", "上游", "探活", "缺省", "操作"];
const TAG = "rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";
const ROW_ERROR = "m-0 mt-1 text-xs whitespace-normal text-(--wb-status-error-text)";

type RowActions = {
  probing: ReadonlySet<string>;
  defaulting: ReadonlySet<string>;
  rowErrors: Readonly<Record<string, string>>;
  /** 行按钮的点击把按钮本身交出去，供对话框关闭后归还焦点。 */
  onEdit(model: ModelView, trigger: HTMLElement): void;
  onRemove(model: ModelView, trigger: HTMLElement): void;
  onSetDefault(id: string): void;
  onProbe(id: string): void;
};

/** 探活完成时刻的本地时间（24 小时制）。 */
function probeTime(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

function ProbeCell({ probe }: { probe: ModelView["probe"] }) {
  if (probe.status === "never") return <>从未</>;
  return (
    <div className="flex flex-col gap-0.5 whitespace-normal">
      <span>{probe.status === "ok" ? "正常" : `失败：${probe.message ?? ""}`}</span>
      {probe.at === null ? null : (
        <span className="text-xs text-muted-foreground">{probeTime(probe.at)}</span>
      )}
    </div>
  );
}

/** 模型表（拷入层 table）：每行一个模型，按 `listModels` 的次序；行操作在最后一列。 */
export function ModelList({ models, ...actions }: RowActions & { models: readonly ModelView[] }) {
  const trigger = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget;
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
        {models.map((model) => (
          <TableRow key={model.id}>
            <TableCell className="font-mono text-xs">{model.id}</TableCell>
            <TableCell>{model.name}</TableCell>
            <TableCell>
              <div className="flex gap-1">
                {model.reasoning ? <span className={TAG}>推理</span> : null}
                {model.vision ? <span className={TAG}>看图</span> : null}
              </div>
            </TableCell>
            <TableCell>{model.maxTokens}</TableCell>
            <TableCell>{model.upstream ? "已配置" : "未配置"}</TableCell>
            <TableCell>
              <ProbeCell probe={model.probe} />
            </TableCell>
            <TableCell>{model.isDefault ? <span className={TAG}>缺省</span> : null}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                <Button
                  onClick={(event) => actions.onEdit(model, trigger(event))}
                  size="sm"
                  variant="outline"
                >
                  编辑
                </Button>
                <Button
                  onClick={(event) => actions.onRemove(model, trigger(event))}
                  size="sm"
                  variant="outline"
                >
                  删除
                </Button>
                {model.isDefault ? null : (
                  <Button
                    disabled={actions.defaulting.has(model.id)}
                    onClick={() => actions.onSetDefault(model.id)}
                    size="sm"
                    variant="outline"
                  >
                    设为缺省
                  </Button>
                )}
                <Button
                  disabled={actions.probing.has(model.id)}
                  onClick={() => actions.onProbe(model.id)}
                  size="sm"
                  variant="outline"
                >
                  探活
                </Button>
              </div>
              {actions.rowErrors[model.id] ? (
                <p className={ROW_ERROR} role="alert">
                  {actions.rowErrors[model.id]}
                </p>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type RemoveProps = {
  model: ModelView;
  pending: boolean;
  restoreFocus(): void;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * `删除模型 <name>？` 确认框（拷入层 alert-dialog）。`取消` 不发请求；`删除` 恰发一次。请求在途时两个按钮都
 * 禁用、Escape 与遮罩也关不掉（结果总落在打开的确认框上，没有晚到结果）。
 */
export function RemoveModelDialog({
  model,
  pending,
  restoreFocus,
  onConfirm,
  onCancel,
}: RemoveProps) {
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });

  return (
    <AlertDialog onOpenChange={onOpenChange} open>
      <AlertDialogContent
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{`删除模型 ${model.name}？`}</AlertDialogTitle>
          <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <Button
            aria-busy={pending ? true : undefined}
            disabled={pending}
            onClick={onConfirm}
            variant="destructive"
          >
            删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
