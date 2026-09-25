import { type FormEvent, type PropsWithChildren, type RefObject, useRef, useState } from "react";
import { Button, Dialog, Menu } from "../../ui/index.js";

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

type CreationMenuProps = {
  /** 回调带上菜单触发器，供对话框在取消类关闭后把焦点还给它。 */
  onNewDirectory(trigger: HTMLElement | null): void;
  onNewWorkspace(trigger: HTMLElement | null): void;
};

export function CreationMenu({ onNewDirectory, onNewWorkspace }: CreationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Menu
      items={[
        { label: "新建文件夹", onSelect: () => onNewDirectory(triggerRef.current) },
        { label: "新建工作空间", onSelect: () => onNewWorkspace(triggerRef.current) },
      ]}
      trigger={
        <Button aria-label="新建" ref={triggerRef}>
          ＋
        </Button>
      }
    />
  );
}

type DialogFormProps = PropsWithChildren<{
  error: string | null;
  pending: boolean;
  onCancel(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}>;

function DialogForm({ children, error, onCancel, onSubmit, pending }: DialogFormProps) {
  return (
    <form aria-busy={pending || undefined} className="files-dialog-form" onSubmit={onSubmit}>
      {children}
      {pending ? (
        <p className="files-status ui-muted" role="status">
          正在创建。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。
        </p>
      ) : null}
      {error ? (
        <p className="ui-alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="files-dialog-actions">
        <Button onClick={onCancel}>取消</Button>
        <Button disabled={pending} type="submit" variant="primary">
          创建
        </Button>
      </div>
    </form>
  );
}

/** Escape、右上 `关闭`、遮罩点击都等同 `取消`（挂起期即取消等待）。 */
function cancelOnClose(onCancel: () => void) {
  return (open: boolean) => {
    if (!open) onCancel();
  };
}

export function WorkspaceDialog({
  error,
  pending,
  returnFocus,
  onCancel,
  onCreate,
}: WorkspaceDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
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
    <Dialog
      busy={pending}
      initialFocus={nameRef}
      onOpenChange={cancelOnClose(onCancel)}
      open
      returnFocus={returnFocus}
      title="新建工作空间"
    >
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitWorkspace} pending={pending}>
        <p>将在你的沙箱内创建同名目录</p>
        <label className="files-field">
          工作空间名称
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="输入工作空间名称"
            ref={nameRef}
            value={name}
          />
        </label>
        <label className="files-field">
          目录名
          <input
            onChange={(event) => setDir(event.target.value)}
            placeholder="留空则按名称生成"
            value={dir}
          />
        </label>
      </DialogForm>
    </Dialog>
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
    <Dialog
      busy={pending}
      initialFocus={parentRef}
      onOpenChange={cancelOnClose(onCancel)}
      open
      returnFocus={returnFocus}
      title="新建文件夹"
    >
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitDirectory} pending={pending}>
        <label className="files-field">
          位置
          <select
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
        </label>
        <label className="files-field">
          文件夹名称
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 out"
            value={name}
          />
        </label>
      </DialogForm>
    </Dialog>
  );
}
