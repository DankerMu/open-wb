import {
  type FormEvent,
  type PropsWithChildren,
  type Ref,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

type RenameDialogProps = {
  /** 条目现在的名字：输入框的初值。 */
  name: string;
  error: string | null;
  pending: boolean;
  /** 该行的 `更多操作 <名>`。 */
  returnFocus: ReturnFocus;
  onCancel(): void;
  /** `name` 已去掉首尾空白，非空、不含 `/` 与 `\`、不等于原名；除此之外原样（`.`、`..` 也是）。 */
  onRename(name: string): void;
};

type DeleteEntryDialogProps = {
  /** 条目的名字与类别：标题与说明用。 */
  name: string;
  type: "dir" | "file";
  error: string | null;
  pending: boolean;
  /** 取消类关闭后是该行的 `更多操作 <名>`；删除成功后调用方把它换成父目录的行按钮。 */
  returnFocus: ReturnFocus;
  onCancel(): void;
  onConfirm(): void;
};

type MoveDialogProps = {
  /** 可选的目标目录（`moveTargets`），对话框打开时取定；空数组即没有可选目标。 */
  targets: readonly string[];
  workspaceName: string;
  error: string | null;
  pending: boolean;
  /** 该行的 `更多操作 <名>`。 */
  returnFocus: ReturnFocus;
  onCancel(): void;
  /** `target` 是 `targets` 里的一项，原样。 */
  onMove(target: string): void;
};

type DirectoryFieldProps = {
  label: string;
  directories: readonly string[];
  /** 根项显示 `根目录　<空间名>`，不显示字面 root 或绝对路径。 */
  workspaceName: string;
  value: string;
  onChange(path: string): void;
  ref: Ref<HTMLSelectElement>;
};

type CreationDialogProps = PropsWithChildren<{
  title: string;
  /** 提交按钮的字样，缺省 `创建`。 */
  submitLabel?: string;
  /** 为真时提交按钮禁用（没有可提交的内容）；请求挂起期间它本来就禁用。 */
  submitDisabled?: boolean;
  /** 请求挂起期间的说明，缺省是创建的那一句。 */
  pendingNote?: string;
  error: string | null;
  pending: boolean;
  /**
   * 打开时聚焦的控件（`工作空间名称` / `位置` / `名称` / `目标位置`）；是输入框时连同全选它的内容。
   * 没有挂上（`移动到` 没有可选目标时不渲染下拉）就聚焦 `取消`。
   */
  initialFocus: RefObject<HTMLElement | null>;
  returnFocus: ReturnFocus;
  onCancel(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}>;

/** 删除确认框的说明，逐字照规格（files-web「文件操作界面」）。 */
const DELETE_NOTES = {
  dir: "文件夹及其全部内容将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。",
  file: "文件将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。",
};

const FIELD = "flex flex-col gap-1.5";
/** 对话框内的失败文案。 */
const ERROR_NOTE =
  "m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";
/** `位置`、`目标位置` 是原生 `<select>`（拷入层没有 select）；外观对齐拷入层 `Input`。 */
const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/**
 * 创建、重命名与移动对话框共用的外框：标题、表单、挂起说明、错误与 `取消` / 提交按钮（`创建`、`重命名`、`移动`）。
 * Escape、右上 `关闭`、遮罩点击都等同 `取消`（挂起期即取消等待，不锁关闭）；取消类关闭后焦点还给
 * `returnFocus`。Enter 走表单的原生提交，本文件不写键盘处理。
 */
function CreationDialog({
  children,
  error,
  initialFocus,
  onCancel,
  onSubmit,
  pending,
  pendingNote = "正在创建。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。",
  returnFocus,
  submitDisabled = false,
  submitLabel = "创建",
  title,
}: CreationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  const content = fallback.ref;

  // 提交按钮在请求发出的那次提交里被禁用：焦点若已丢失——活动元素是 body（Chromium 在禁用的当下就把
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
          const first = initialFocus.current ?? cancelRef.current;
          first?.focus();
          if (first instanceof HTMLInputElement) first.select();
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
              {pendingNote}
            </p>
          ) : null}
          {error ? (
            <p className={ERROR_NOTE} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onCancel} ref={cancelRef} type="button" variant="ghost">
              取消
            </Button>
            <Button disabled={pending || submitDisabled} type="submit">
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 一行标签加目录下拉：`新建文件夹` 的 `位置` 与 `移动到` 的 `目标位置`。选项的值是目录路径，根是 `""`。 */
function DirectoryField({
  directories,
  label,
  onChange,
  ref,
  value,
  workspaceName,
}: DirectoryFieldProps) {
  const id = useId();

  return (
    <div className={FIELD}>
      <Label htmlFor={id}>{label}</Label>
      <select
        className={SELECT}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        ref={ref}
        value={value}
      >
        {directories.map((path) => (
          <option key={path} value={path}>
            {path.length === 0 ? `根目录　${workspaceName}` : path}
          </option>
        ))}
      </select>
    </div>
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
      <DirectoryField
        directories={directories}
        label="位置"
        onChange={setParent}
        ref={parentRef}
        value={parent}
        workspaceName={workspaceName}
      />
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

/**
 * `重命名` 对话框。提交时依次：输入与原名逐字相同 → 关闭；去掉首尾空白后为空 → `请输入名称`；含 `/`
 * 或 `\` → `名称不能包含路径分隔符`；去掉首尾空白后等于原名 → 关闭；否则 `onRename`。前四种都不发
 * 请求。名字只检查这些：`.`、`..` 照样交出去，由服务端答复（它的文案显示在框内）。
 */
export function RenameDialog({
  error,
  name,
  onCancel,
  onRename,
  pending,
  returnFocus,
}: RenameDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const [text, setText] = useState(name);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = text.trim();
    if (text === name) {
      onCancel();
    } else if (next.length === 0) {
      setValidationError("请输入名称");
    } else if (/[\\/]/.test(next)) {
      setValidationError("名称不能包含路径分隔符");
    } else if (next === name) {
      onCancel();
    } else {
      setValidationError(null);
      onRename(next);
    }
  }

  return (
    <CreationDialog
      error={validationError ?? error}
      initialFocus={nameRef}
      onCancel={onCancel}
      onSubmit={submitName}
      pending={pending}
      pendingNote="正在重命名。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。"
      returnFocus={returnFocus}
      submitLabel="重命名"
      title="重命名"
    >
      <div className={FIELD}>
        <Label htmlFor={nameId}>名称</Label>
        <Input
          id={nameId}
          onChange={(event) => setText(event.target.value)}
          ref={nameRef}
          value={text}
        />
      </div>
    </CreationDialog>
  );
}

/**
 * `移动到` 对话框。`目标位置` 的选项就是 `targets`，缺省选第一项；提交把选中的那一项交给 `onMove`，
 * 这里不拼路径。没有可选目标：不渲染下拉，显示说明文案，`移动` 禁用，提交表单也不调 `onMove`，初始
 * 焦点落在 `取消`（外框的回落）。
 */
export function MoveDialog({
  error,
  onCancel,
  onMove,
  pending,
  returnFocus,
  targets,
  workspaceName,
}: MoveDialogProps) {
  const targetRef = useRef<HTMLSelectElement>(null);
  const [target, setTarget] = useState(targets[0]);

  function submitTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target !== undefined) onMove(target);
  }

  return (
    <CreationDialog
      error={error}
      initialFocus={targetRef}
      onCancel={onCancel}
      onSubmit={submitTarget}
      pending={pending}
      pendingNote="正在移动。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。"
      returnFocus={returnFocus}
      submitDisabled={target === undefined}
      submitLabel="移动"
      title="移动到"
    >
      {target === undefined ? (
        <p className="m-0 text-muted-foreground">没有可用的目标目录，请先展开目标目录</p>
      ) : (
        <DirectoryField
          directories={targets}
          label="目标位置"
          onChange={setTarget}
          ref={targetRef}
          value={target}
          workspaceName={workspaceName}
        />
      )}
    </CreationDialog>
  );
}

/**
 * `删除` 确认框（拷入层 `alert-dialog`：没有右上 `关闭`，点遮罩不关闭）。初始焦点在 `取消`，是拷入层
 * 的缺省，这里不写 `onOpenAutoFocus`。`删除` 是普通按钮而不是 `AlertDialogAction`：点了不关框，关不关
 * 由请求的结局定——失败时文案显示在框内、框留着。`取消` 与 Escape 都是 `onCancel`（挂起期即中止等待）；
 * 关闭后焦点给 `returnFocus`。
 */
export function DeleteEntryDialog({
  error,
  name,
  onCancel,
  onConfirm,
  pending,
  returnFocus,
  type,
}: DeleteEntryDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });

  // `删除` 在请求发出的那次提交里被禁用：焦点若在它上面（jsdom 不移焦点）或已被浏览器移到 body，
  // 移到 `取消`，不让焦点留在禁用的控件上或逃出确认框。
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (pending && (active === document.body || (active as HTMLButtonElement | null)?.disabled)) {
      cancelRef.current?.focus();
    }
  }, [pending]);

  return (
    <AlertDialog onOpenChange={onOpenChange} open>
      <AlertDialogContent
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{`删除「${name}」？`}</AlertDialogTitle>
          <AlertDialogDescription>{DELETE_NOTES[type]}</AlertDialogDescription>
        </AlertDialogHeader>
        {pending ? (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            正在删除。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。
          </p>
        ) : null}
        {error ? (
          <p className={ERROR_NOTE} role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>取消</AlertDialogCancel>
          <Button
            aria-busy={pending || undefined}
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
