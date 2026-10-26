import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/features/auth/index";
import {
  type ApiClient,
  ApiError,
  type CreateMountSourceInput,
  type MountSourceList,
  type MountSourceRow,
  REQUEST_FAILED_MESSAGE,
} from "@/lib/api";
import { useEscapeFallback } from "../../components/escape-fallback.js";

/**
 * 中心页「挂载源」tab（workspace-mounts「中心「挂载源」tab」，design D18；只对管理员可见，`tabs.ts`）：挂载源表
 *（名称、服务器路径、`只读` / `可写`，行操作 `删除`；没有编辑——挂载源只有登记与删除两种写，D14）、空态、
 * `登记挂载源` 对话框与删除确认。写法照中心「模型」「连接器」tab；与它们不同的是删除失败留在确认框内。
 * 挂载恰一次 `listMountSources`；登记与删除成功后各重取一次，重取失败在页顶提示、表保留。
 * `client` 供用例注入；缺省取会话客户端。
 */
export function MountSourcesPanel({ client }: { client?: ApiClient }) {
  return client ? <MountSources client={client} /> : <SessionMountSources />;
}

const HEADERS = ["名称", "服务器路径", "读写", "操作"];
const EMPTY_TITLE = "尚未登记挂载源";
const EMPTY_TEXT = "在服务器上挂好 NFS 或本机目录后，在此登记；用户即可在工作空间里挂载它。";
const DELETE_NOTE = "删除后，所有引用它的挂载都会被卸载";
const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";
/** `validateMountSourceBody` 的名称上限，按码点计。 */
const MAX_NAME_POINTS = 64;

/** 本地校验的原因（spec 未给文案；超长一条与组 11 的挂载对话框同字，design D18）。 */
const REASONS = {
  nameEmpty: "名称不能为空",
  nameLong: `名称不能超过 ${MAX_NAME_POINTS} 个字符`,
  nameControl: "名称不能含控制字符",
  path: "服务器路径须为以 / 开头的绝对路径",
} as const;

type FormValues = { name: string; path: string; readOnly: boolean };
type FieldErrors = Partial<Record<"name" | "path", string>>;

/**
 * 「挂载源端点」里客户端能判的规则（`server/src/workspaces/mounts/validate.ts` 的 `validateMountSourceBody`）：名称
 * 1..64 个码点、不含 U+0000–U+001F 与 U+007F；路径以 `/` 开头。两者都不修剪（服务端也不）。路径是否存在、是不是
 * 目录、与受保护目录的包含关系只由服务端判。
 */
function validateMountSource({ name, path }: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const points = [...name];
  if (points.length === 0) errors.name = REASONS.nameEmpty;
  else if (points.length > MAX_NAME_POINTS) errors.name = REASONS.nameLong;
  else if (points.some(isControl)) errors.name = REASONS.nameControl;

  if (!path.startsWith("/")) errors.path = REASONS.path;
  return errors;
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

/** 管理员要的是管理员视图；空表两种形状相同（`parseMountSources` 判为三键视图）。其余为无效应答。 */
function rowsOf(list: MountSourceList): MountSourceRow[] | null {
  if (list.view === "admin") return list.sources;
  return list.sources.length === 0 ? [] : null;
}

type ListState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; rows: MountSourceRow[] };
type FormState = { pending: boolean; error: string | null };
type RemoveState = { row: MountSourceRow; pending: boolean; error: string | null };

async function listRows(client: ApiClient): Promise<MountSourceRow[]> {
  const rows = rowsOf(await client.listMountSources());
  if (!rows) throw new ApiError(200, "request_failed", REQUEST_FAILED_MESSAGE);
  return rows;
}

function useMountSources(client: ApiClient) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [remove, setRemove] = useState<RemoveState | null>(null);
  const sequence = useRef(0);
  /** 同一帧里的第二次提交还看不到重渲染，靠它拦下。 */
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    const own = ++sequence.current;
    listRows(client).then(
      (rows) => {
        if (live && own === sequence.current) setList({ status: "ready", rows });
      },
      (error: unknown) => {
        if (live && own === sequence.current)
          setList({ status: "failed", message: messageOf(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  /** 只采用最后一次发出的列表请求的结果；失败只在页顶提示，表保留。 */
  const reload = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const rows = await listRows(client);
      if (own === sequence.current) setList({ status: "ready", rows });
    } catch (error) {
      if (own === sequence.current) setNotice(messageOf(error));
    }
  }, [client]);

  /** 恰调用一次 `run`：成功返回 true，失败把 message 交给 `onError` 并返回 false。调用方先查 `inFlight`。 */
  const once = async (run: () => Promise<unknown>, onError: (message: string) => void) => {
    inFlight.current = true;
    try {
      await run();
      return true;
    } catch (error) {
      onError(messageOf(error));
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  return {
    list,
    notice,
    form,
    remove,
    openCreate() {
      setNotice(null);
      setForm({ pending: false, error: null });
    },
    closeForm() {
      setForm((current) => (current?.pending ? current : null));
    },
    /** 恰一次 `createMountSource`；成功即关闭对话框并重取，失败把 message 留在对话框内。 */
    async submit(input: CreateMountSourceInput) {
      if (inFlight.current) return;
      setForm({ pending: true, error: null });
      const ok = await once(
        () => client.createMountSource(input),
        (error) => setForm({ pending: false, error }),
      );
      if (!ok) return;
      setForm(null);
      await reload();
    },
    askRemove(row: MountSourceRow) {
      setNotice(null);
      setRemove({ row, pending: false, error: null });
    },
    cancelRemove() {
      setRemove((current) => (current?.pending ? current : null));
    },
    /** 恰一次 `deleteMountSource`；成功先调 `onGone`、关闭并重取，失败把 message 留在确认框内。 */
    async confirmRemove(onGone: () => void) {
      if (!remove || inFlight.current) return;
      const { row } = remove;
      setRemove({ row, pending: true, error: null });
      const ok = await once(
        () => client.deleteMountSource(row.id),
        (error) => setRemove({ row, pending: false, error }),
      );
      if (!ok) return;
      onGone();
      setRemove(null);
      await reload();
    },
  };
}

function SessionMountSources() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <MountSources client={client} />;
}

function MountSources({ client }: { client: ApiClient }) {
  const sources = useMountSources(client);
  const { list, notice, form, remove } = sources;
  const addRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** 对话框关闭后把焦点还给打开它的按钮；行已删除时落到 `登记挂载源`。 */
  const restoreFocus = () => {
    const target = opener.current?.isConnected ? opener.current : addRef.current;
    target?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-3 pt-4">
      {notice ? (
        <p className="ui-alert" role="alert">
          {notice}
        </p>
      ) : null}
      {list.status === "loading" ? <p className="ui-muted">正在读取挂载源</p> : null}
      {list.status === "failed" ? (
        <p className="ui-alert" role="alert">
          {list.message}
        </p>
      ) : null}
      {list.status === "ready" ? (
        <>
          <div>
            <Button
              onClick={(event) => {
                opener.current = event.currentTarget;
                sources.openCreate();
              }}
              ref={addRef}
              size="sm"
            >
              登记挂载源
            </Button>
          </div>
          {list.rows.length === 0 ? (
            <section className="ui-empty">
              <h3 className="m-0 text-sm font-medium">{EMPTY_TITLE}</h3>
              <p className="ui-muted m-0">{EMPTY_TEXT}</p>
            </section>
          ) : (
            <SourceTable
              onRemove={(row, trigger) => {
                opener.current = trigger;
                sources.askRemove(row);
              }}
              rows={list.rows}
            />
          )}
        </>
      ) : null}
      {form ? (
        <SourceFormDialog
          error={form.error}
          onCancel={sources.closeForm}
          onSubmit={(input) => void sources.submit(input)}
          pending={form.pending}
          restoreFocus={restoreFocus}
        />
      ) : null}
      {remove ? (
        <RemoveSourceDialog
          {...remove}
          onCancel={sources.cancelRemove}
          onConfirm={() =>
            void sources.confirmRemove(() => {
              opener.current = null;
            })
          }
          restoreFocus={restoreFocus}
        />
      ) : null}
    </section>
  );
}

function SourceTable({
  rows,
  onRemove,
}: {
  rows: readonly MountSourceRow[];
  onRemove(row: MountSourceRow, trigger: HTMLElement): void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {HEADERS.map((label) => (
            <TableHead key={label}>{label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-normal [overflow-wrap:anywhere]">{row.name}</TableCell>
            <TableCell className="font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">
              {row.path}
            </TableCell>
            <TableCell>{row.readOnly ? "只读" : "可写"}</TableCell>
            <TableCell>
              <Button
                onClick={(event) => onRemove(row, event.currentTarget)}
                size="sm"
                variant="outline"
              >
                删除
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type FieldProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

/** 一个带 label 的字段，校验原因显示在它下方并经 `aria-describedby` 关联。 */
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error: string | undefined;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(error ? { id, "aria-describedby": errorId, "aria-invalid": true } : { id })}
      {error ? (
        <p className={ERROR_TEXT} id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `登记挂载源` 对话框：按「有打开的对话框」条件挂载，关闭即卸载、重开为空。提交前本地校验，有原因就不发请求；
 * 服务端拒绝（400 / 409）的 `ApiError.message` 就地显示。请求在途时 `登记` 与 `取消` 禁用，Escape、遮罩与关闭按钮
 * 也关不掉。
 */
function SourceFormDialog({
  pending,
  error,
  restoreFocus,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  error: string | null;
  restoreFocus(): void;
  onSubmit(input: CreateMountSourceInput): void;
  onCancel(): void;
}) {
  const [values, setValues] = useState<FormValues>({ name: "", path: "", readOnly: false });
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const readOnlyId = useId();
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });
  const set = (patch: Partial<FormValues>) => setValues((current) => ({ ...current, ...patch }));

  // 两个按钮在请求发出的那次提交里被禁用：焦点若因此落到 body，移回名称框。
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, [pending]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = validateMountSource(values);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(values);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">登记挂载源</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          data-form-type="other"
          noValidate
          onSubmit={submit}
          ref={formRef}
        >
          <Field error={errors.name} label="名称">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                onChange={(event) => set({ name: event.target.value })}
                value={values.name}
              />
            )}
          </Field>
          <Field error={errors.path} label="服务器路径">
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                className="font-mono"
                onChange={(event) => set({ path: event.target.value })}
                placeholder="/mnt/nas"
                value={values.path}
              />
            )}
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              checked={values.readOnly}
              id={readOnlyId}
              onCheckedChange={(readOnly) => set({ readOnly })}
            />
            <Label htmlFor={readOnlyId}>只读</Label>
          </div>
          {error ? (
            <p className={`${ERROR_TEXT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button aria-busy={pending ? true : undefined} disabled={pending} type="submit">
              登记
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `删除挂载源 <name>？` 确认框：说明写明连带卸载（D14）。`取消` 不发请求；`删除` 恰发一次，失败的 message 显示在
 * 框内、框保持打开。请求在途时两个按钮都禁用、Escape 也关不掉。
 */
function RemoveSourceDialog({
  row,
  pending,
  error,
  restoreFocus,
  onConfirm,
  onCancel,
}: RemoveState & { restoreFocus(): void; onConfirm(): void; onCancel(): void }) {
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
          <AlertDialogTitle>{`删除挂载源 ${row.name}？`}</AlertDialogTitle>
          <AlertDialogDescription>{DELETE_NOTE}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className={`${ERROR_TEXT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
            {error}
          </p>
        ) : null}
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
