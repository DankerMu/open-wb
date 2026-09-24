import { type FormEvent, type PropsWithChildren, useEffect, useRef, useState } from "react";
import { trapDialogFocus } from "../../lib/dialog.js";

type DialogSurfaceProps = PropsWithChildren<{
  title: string;
  titleId: string;
  pending: boolean;
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

function DialogSurface({ children, onCancel, pending, title, titleId }: DialogSurfaceProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== dialog ? active : returnFocusRef.current;

    if (!dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog.open) {
        dialog.close();
      }
      const restore = returnFocusRef.current;
      if (restore?.isConnected) {
        restore.focus();
      }
    };
  }, []);

  return (
    <dialog
      aria-busy={pending || undefined}
      aria-labelledby={titleId}
      className="files-dialog"
      onKeyDown={trapDialogFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) {
          onCancel();
        }
      }}
      ref={dialogRef}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}

export function CreationMenu({ onNewDirectory, onNewWorkspace }: CreationMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstItem = menuRef.current?.querySelector('[role="menuitem"]');
    if (firstItem instanceof HTMLElement) {
      firstItem.focus();
    }
  }, [open]);

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveMenuFocus(event: {
    key: string;
    preventDefault(): void;
    currentTarget: HTMLElement;
  }) {
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')].filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    if (items.length === 0) {
      return;
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case "ArrowUp":
        nextIndex = (Math.max(currentIndex, 0) + items.length - 1) % items.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="files-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="新建"
        className="ui-button"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        ＋
      </button>
      {open ? (
        <div
          className="files-menu-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
              return;
            }
            moveMenuFocus(event);
          }}
          ref={menuRef}
          role="menu"
        >
          <button
            onClick={() => {
              closeMenu();
              onNewDirectory();
            }}
            role="menuitem"
            type="button"
          >
            新建文件夹
          </button>
          <button
            onClick={() => {
              closeMenu();
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
    <form aria-busy={pending || undefined} className="files-dialog-form" onSubmit={onSubmit}>
      {children}
      {pending ? (
        <p className="files-status ui-muted" role="status">
          正在创建
        </p>
      ) : null}
      {error ? (
        <p className="ui-alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="files-dialog-actions">
        <button
          className="ui-button"
          disabled={pending}
          onClick={() => {
            if (!pending) {
              onCancel();
            }
          }}
          type="button"
        >
          取消
        </button>
        <button className="ui-button ui-button-primary" disabled={pending} type="submit">
          创建
        </button>
      </div>
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
    <DialogSurface
      onCancel={onCancel}
      pending={pending}
      title="新建工作空间"
      titleId="workspace-dialog-title"
    >
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitWorkspace} pending={pending}>
        <p>将在你的沙箱内创建同名目录</p>
        <label className="files-field">
          工作空间名称
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="输入工作空间名称"
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
    <DialogSurface
      onCancel={onCancel}
      pending={pending}
      title="新建文件夹"
      titleId="directory-dialog-title"
    >
      <DialogForm error={message} onCancel={onCancel} onSubmit={submitDirectory} pending={pending}>
        <label className="files-field">
          位置
          <select onChange={(event) => setParent(event.target.value)} value={parent}>
            {directories.map((path) => (
              <option key={path} value={path}>
                {path.length === 0 ? "根目录　root" : path}
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
    </DialogSurface>
  );
}
