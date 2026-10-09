import {
  type FormEvent,
  type PropsWithChildren,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeFallback } from "../../ui/index.js";

type ReturnFocus = RefObject<HTMLElement | null>;

type WorkspaceInput = {
  name: string;
  dir?: string;
};

type WorkspaceDialogProps = {
  error: string | null;
  pending: boolean;
  /** 取消类关闭后的焦点归还目标：发起本流程的触发器（`选择工作空间` 或 `新建`）。 */
  returnFocus: ReturnFocus;
  onCancel(): void;
  onCreate(input: WorkspaceInput): void;
};

type DirectoryDialogProps = {
  directories: readonly string[];
  /** 根项显示 `根目录　<空间名>`，不显示字面 root 或绝对路径。 */
  workspaceName: string;
  error: string | null;
  pending: boolean;
  returnFocus: ReturnFocus;
  onCancel(): void;
  onCreate(parent: string, name: string): void;
};

type CreationDialogProps = PropsWithChildren<{
  title: string;
  error: string | null;
  pending: boolean;
  /** 打开时聚焦的控件（`工作空间名称` / `位置`）。 */
  initialFocus: RefObject<HTMLElement | null>;
  returnFocus: ReturnFocus;
  onCancel(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}>;

const FIELD = "flex flex-col gap-1.5";
/** `位置` 是原生 `<select>`（拷入层没有 select）；外观对齐拷入层 `Input`。 */
const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/**
 * 两个创建对话框共用的外框：标题、表单、挂起说明、错误与 `取消` / `创建`。Escape、右上 `关闭`、
 * 遮罩点击都等同 `取消`（挂起期即取消等待，不锁关闭）；取消类关闭后焦点还给 `returnFocus`。
 * Enter 走表单的原生提交，本文件不写键盘处理。
 */
function CreationDialog({
  children,
  error,
  initialFocus,
  onCancel,
  onSubmit,
  pending,
  returnFocus,
  title,
}: CreationDialogProps) {
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  const content = fallback.ref;

  // `创建` 在请求发出的那次提交里被禁用：焦点若已丢失——活动元素是 body（Chromium 在禁用的当下就把
  // 焦点移走），或是对话框内已禁用的控件（jsdom 不移焦点）——移到右上的 `关闭`；焦点在对话框内仍可用
  // 的控件上时不动。不取「首个可用控件」：拷入层把 `关闭` 放在内容最后，首个可用控件是表单字段。
  useLayoutEffect(() => {
    const root = content.current;
    if (!pending || !root) return;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      (root.contains(active) && (active as HTMLButtonElement).disabled === true);
    if (lost) root.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.focus();
  }, [pending, content]);

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          initialFocus.current?.focus();
        }}
        ref={content}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{title}</DialogTitle>
        </DialogHeader>
        <form aria-busy={pending || undefined} className="flex flex-col gap-3" onSubmit={onSubmit}>
          {children}
          {pending ? (
            <p className="m-0 text-xs text-muted-foreground" role="status">
              正在创建。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。
            </p>
          ) : null}
          {error ? (
            <p
              className="m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={pending} type="submit">
              创建
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceDialog({
  error,
  pending,
  returnFocus,
  onCancel,
  onCreate,
}: WorkspaceDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const dirId = useId();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const message = validationError ?? error;

  function submitWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      setValidationError("请输入名称");
      return;
    }

    setValidationError(null);
    const normalizedDir = dir.trim();
    onCreate({
      name: normalizedName,
      ...(normalizedDir.length === 0 ? {} : { dir: normalizedDir }),
    });
  }

  return (
    <CreationDialog
      error={message}
      initialFocus={nameRef}
      onCancel={onCancel}
      onSubmit={submitWorkspace}
      pending={pending}
      returnFocus={returnFocus}
      title="新建工作空间"
    >
      <p className="m-0 text-muted-foreground">将在你的沙箱内创建同名目录</p>
      <div className={FIELD}>
        <Label htmlFor={nameId}>工作空间名称</Label>
        <Input
          id={nameId}
          onChange={(event) => setName(event.target.value)}
          placeholder="输入工作空间名称"
          ref={nameRef}
          value={name}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor={dirId}>目录名</Label>
        <Input
          id={dirId}
          onChange={(event) => setDir(event.target.value)}
          placeholder="留空则按名称生成"
          value={dir}
        />
      </div>
    </CreationDialog>
  );
}

export function DirectoryDialog({
  directories,
  error,
  pending,
  returnFocus,
  workspaceName,
  onCancel,
  onCreate,
}: DirectoryDialogProps) {
  const parentRef = useRef<HTMLSelectElement>(null);
  const parentId = useId();
  const nameId = useId();
  const [name, setName] = useState("");
  const [parent, setParent] = useState(directories[0] ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const message = validationError ?? error;

  function submitDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      setValidationError("请填写文件夹名称");
      return;
    }
    if (/[\\/]/.test(normalizedName)) {
      setValidationError("名称不能包含路径分隔符");
      return;
    }

    setValidationError(null);
    onCreate(parent, normalizedName);
  }

  return (
    <CreationDialog
      error={message}
      initialFocus={parentRef}
      onCancel={onCancel}
      onSubmit={submitDirectory}
      pending={pending}
      returnFocus={returnFocus}
      title="新建文件夹"
    >
      <div className={FIELD}>
        <Label htmlFor={parentId}>位置</Label>
        <select
          className={SELECT}
          id={parentId}
          onChange={(event) => setParent(event.target.value)}
          ref={parentRef}
          value={parent}
        >
          {directories.map((path) => (
            <option key={path} value={path}>
              {path.length === 0 ? `根目录　${workspaceName}` : path}
            </option>
          ))}
        </select>
      </div>
      <div className={FIELD}>
        <Label htmlFor={nameId}>文件夹名称</Label>
        <Input
          id={nameId}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 out"
          value={name}
        />
      </div>
    </CreationDialog>
  );
}
