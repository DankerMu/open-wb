import { type FormEvent, type PropsWithChildren, useEffect, useRef, useState } from "react";

type DialogSurfaceProps = PropsWithChildren<{
  title: string;
  titleId: string;
  onCancel(): void;
}>;

type WorkspaceInput = {
  name: string;
  dir?: string;
};

type WorkspaceDialogProps = {
  error: string | null;
  pending: boolean;
  onCancel(): void;
  onCreate(input: WorkspaceInput): void;
};

type DirectoryDialogProps = {
  directories: readonly string[];
  error: string | null;
  pending: boolean;
  onCancel(): void;
  onCreate(parent: string, name: string): void;
};

type CreationMenuProps = {
  onNewDirectory(): void;
  onNewWorkspace(): void;
};

function DialogSurface({ children, onCancel, title, titleId }: DialogSurfaceProps) {
  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      role="dialog"
      style={{
        border: "1px solid currentColor",
        marginTop: "1rem",
        maxWidth: "28rem",
        padding: "1rem",
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  );
}

export function CreationMenu({ onNewDirectory, onNewWorkspace }: CreationMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      menuRef.current?.focus();
    }
  }, [open]);

  return (
    <div>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="新建"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        ＋
      </button>
      {open ? (
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
          ref={menuRef}
          role="menu"
          tabIndex={-1}
        >
          <button
            onClick={() => {
              setOpen(false);
              onNewDirectory();
            }}
            role="menuitem"
            type="button"
          >
            新建文件夹
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onNewWorkspace();
            }}
            role="menuitem"
            type="button"
          >
            新建工作空间
          </button>
        </div>
      ) : null}
    </div>
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
    <form onSubmit={onSubmit}>
      {children}
      {error ? <p role="alert">{error}</p> : null}
      <button onClick={onCancel} type="button">
        取消
      </button>
      <button disabled={pending} type="submit">
        创建
      </button>
    </form>
  );
}

export function WorkspaceDialog({ error, pending, onCancel, onCreate }: WorkspaceDialogProps) {
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
    <DialogSurface onCancel={onCancel} title="新建工作空间" titleId="workspace-dialog-title">
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitWorkspace} pending={pending}>
        <p>将在你的沙箱内创建同名目录</p>
        <p>
          <label>
            工作空间名称
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder="输入工作空间名称"
              value={name}
            />
          </label>
        </p>
        <p>
          <label>
            目录名
            <input
              onChange={(event) => setDir(event.target.value)}
              placeholder="留空则按名称生成"
              value={dir}
            />
          </label>
        </p>
      </DialogForm>
    </DialogSurface>
  );
}

export function DirectoryDialog({
  directories,
  error,
  pending,
  onCancel,
  onCreate,
}: DirectoryDialogProps) {
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
    <DialogSurface onCancel={onCancel} title="新建文件夹" titleId="directory-dialog-title">
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitDirectory} pending={pending}>
        <p>
          <label>
            位置
            <select onChange={(event) => setParent(event.target.value)} value={parent}>
              {directories.map((path) => (
                <option key={path} value={path}>
                  {path.length === 0 ? "根目录　root" : path}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            文件夹名称
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 out"
              value={name}
            />
          </label>
        </p>
      </DialogForm>
    </DialogSurface>
  );
}
