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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ConnectorSummary, ConnectorView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";

const MEMBER_HEADERS = ["名称", "类型", "描述", "默认启用"];
const ADMIN_HEADERS = ["名称", "类型", "描述", "命令或地址", "探活", "启用", "默认启用", "操作"];
const EMPTY_TITLE = "尚未接入内网连接器";
const EMPTY_TEXT =
  "公网 SaaS 连接器（文档/邮箱/IM）在内网部署下已移除。内网 GitLab 等系统部署完成后在此接入。";
/**
 * 不可切换的开关一律 `aria-disabled="true"`（不用 `disabled`：按下的开关立刻进入在途，`disabled` 会让焦点落到
 * `body`）。`aria-disabled` 的开关照样分派点击与空格，拦截靠 `useConnectors` 的在途守卫。
 */
const ARIA_DISABLED = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** 没有可见连接器时的空态（connectors「启用开关与空态」）。 */
export function ConnectorsEmpty() {
  return (
    <section className="ui-empty">
      <h3 className="m-0 text-sm font-medium">{EMPTY_TITLE}</h3>
      <p className="ui-muted m-0">{EMPTY_TEXT}</p>
    </section>
  );
}

/** 探活完成时刻的本地时间（24 小时制，与模型 tab 同一写法）。 */
function probeTime(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

function ProbeCell({ probe }: { probe: ConnectorView["probe"] }) {
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

type DefaultProps = {
  /** 账号缺省停用列表：开 = 名称不在其中。 */
  disabled: readonly string[];
  /** `默认启用` 在途：全部 `默认启用` 开关不可切换。 */
  defaultsPending: boolean;
  onToggleDefault(name: string, enabled: boolean): void;
};

function DefaultSwitch({
  name,
  disabled,
  defaultsPending,
  onToggleDefault,
}: DefaultProps & { name: string }) {
  return (
    <Switch
      aria-disabled={defaultsPending ? true : undefined}
      aria-label={`默认启用 ${name}`}
      checked={!disabled.includes(name)}
      className={ARIA_DISABLED}
      onCheckedChange={(enabled) => onToggleDefault(name, enabled)}
    />
  );
}

function SummaryCells({ connector }: { connector: ConnectorSummary }) {
  return (
    <>
      <TableCell className="font-mono text-xs">{connector.name}</TableCell>
      <TableCell>{connector.type}</TableCell>
      <TableCell className="whitespace-normal [overflow-wrap:anywhere]">
        {connector.description}
      </TableCell>
    </>
  );
}

function Headers({ labels }: { labels: readonly string[] }) {
  return (
    <TableHeader>
      <TableRow>
        {labels.map((label) => (
          <TableHead key={label}>{label}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** 普通用户的表：名称、类型、描述与 `默认启用`；没有命令、地址与任何管理按钮。 */
export function MemberConnectorList({
  connectors,
  ...defaults
}: DefaultProps & { connectors: readonly ConnectorSummary[] }) {
  return (
    <Table>
      <Headers labels={MEMBER_HEADERS} />
      <TableBody>
        {connectors.map((connector) => (
          <TableRow key={connector.name}>
            <SummaryCells connector={connector} />
            <TableCell>
              <DefaultSwitch name={connector.name} {...defaults} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type AdminActions = DefaultProps & {
  /** `启用` 在途的行：该行的 `启用` 开关不可切换，显示切换后的状态。 */
  enabling: ReadonlySet<string>;
  probing: ReadonlySet<string>;
  onToggleEnabled(view: ConnectorView): void;
  /** 行按钮的点击把按钮本身交出去，供对话框关闭后归还焦点。 */
  onEdit(view: ConnectorView, trigger: HTMLElement): void;
  onRemove(view: ConnectorView, trigger: HTMLElement): void;
  onProbe(name: string): void;
};

/** 管理员的表：另有命令或地址、探活状态、`启用` 开关与行操作 `编辑` / `删除` / `探活`。 */
export function AdminConnectorList({
  connectors,
  enabling,
  probing,
  onToggleEnabled,
  onEdit,
  onRemove,
  onProbe,
  ...defaults
}: AdminActions & { connectors: readonly ConnectorView[] }) {
  const trigger = (event: MouseEvent<HTMLButtonElement>) => event.currentTarget;
  return (
    <Table>
      <Headers labels={ADMIN_HEADERS} />
      <TableBody>
        {connectors.map((view) => {
          const switching = enabling.has(view.name);
          return (
            <TableRow key={view.name}>
              <SummaryCells connector={view} />
              <TableCell className="font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">
                {view.type === "stdio" ? view.command : view.url}
              </TableCell>
              <TableCell>
                <ProbeCell probe={view.probe} />
              </TableCell>
              <TableCell>
                <Switch
                  aria-disabled={switching ? true : undefined}
                  aria-label={`启用 ${view.name}`}
                  checked={switching ? !view.enabled : view.enabled}
                  className={ARIA_DISABLED}
                  onCheckedChange={() => onToggleEnabled(view)}
                />
              </TableCell>
              <TableCell>
                <DefaultSwitch name={view.name} {...defaults} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Button
                    onClick={(event) => onEdit(view, trigger(event))}
                    size="sm"
                    variant="outline"
                  >
                    编辑
                  </Button>
                  <Button
                    onClick={(event) => onRemove(view, trigger(event))}
                    size="sm"
                    variant="outline"
                  >
                    删除
                  </Button>
                  <Button
                    disabled={probing.has(view.name)}
                    onClick={() => onProbe(view.name)}
                    size="sm"
                    variant="outline"
                  >
                    探活
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

type RemoveProps = {
  connector: ConnectorView;
  pending: boolean;
  restoreFocus(): void;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * `删除连接器 <name>？` 确认框（照模型 tab 的 `RemoveModelDialog`）。`取消` 不发请求；`删除` 恰发一次。请求在途时两个
 * 按钮都禁用、Escape 与遮罩也关不掉。
 */
export function RemoveConnectorDialog({
  connector,
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
          <AlertDialogTitle>{`删除连接器 ${connector.name}？`}</AlertDialogTitle>
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
