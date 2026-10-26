/**
 * The `挂载目录` dialog of the files page (workspace-mounts「挂载对话框」, design D18, D2). Opened from the
 * `新建` menu (`columns.tsx`) when `GET …/mounts` says `enabled`; its state and the request are in
 * `use-mounts.ts`, the frame is `CreationDialog` (`dialogs.tsx`: `aria-modal`, Escape / `取消` abort the
 * wait, the message in `role="alert"`).
 *
 * - Fields per `协议`: `SFTP` / `SMB` have host, optional port, path, user name and password (`SFTP`
 *   may take a private key instead, `SMB` an optional domain); `服务器目录` has the sources of
 *   `GET /api/mount-sources`, fetched once, when it is first chosen. A source's `path` (the
 *   administrator view) is never shown. A read-only source forces `只读挂载` on.
 * - Submitting checks the local rules first (`mount-input.ts`, no request on a broken one) and hands
 *   the body — the chosen backend's keys only — to `onCreate`.
 * - Credentials live in this component's state only: never in the address or Web Storage, and the
 *   dialog is unmounted on close, so a reopened one starts empty. No toast either way.
 */
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CreateMountInput, MountSourceList } from "../../lib/api.js";
import { CreationDialog } from "./dialogs.js";
import { errorMessage, isUnauthorized } from "./errors.js";
import { type Auth, EMPTY_VALUES, type MountValues, mountInput } from "./mount-input.js";

type Backend = CreateMountInput["backend"];

export type MountDialogState = {
  error: string | null;
  pending: boolean;
  /** Where focus goes after a cancelling close (the `新建` trigger). */
  returnFocus: { current: HTMLElement | null };
  onCancel(): void;
  onCreate(input: CreateMountInput): void;
  listSources(signal: AbortSignal): Promise<MountSourceList>;
};

type Sources =
  | { status: "idle" | "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; list: MountSourceList["sources"] };

const BACKENDS: readonly { value: Backend; label: string }[] = [
  { value: "sftp", label: "SFTP" },
  { value: "smb", label: "SMB" },
  { value: "local", label: "服务器目录" },
];
const FIELD = "flex flex-col gap-1.5";
const NOTE = "m-0 text-muted-foreground";

function sourceLabel(source: { name: string; readOnly: boolean }) {
  return source.readOnly ? `${source.name} · 只读` : source.name;
}

/** `state` is `use-mounts.ts`'s `creating`: `null` while the dialog is closed (nothing is rendered). */
export function MountDialog({ state }: { state: MountDialogState | null }) {
  return state ? <MountForm {...state} /> : null;
}

/** `GET /api/mount-sources`, at most one in flight, aborted when the dialog goes. */
function useSources(listSources: MountDialogState["listSources"]) {
  const [sources, setSources] = useState<Sources>({ status: "idle" });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  /** Starts the request unless one is in flight or its list is here; `onList` gets the list. */
  function load(onList: (list: MountSourceList["sources"]) => void) {
    if (sources.status === "loading" || sources.status === "ready") return;
    const controller = new AbortController();
    request.current = controller;
    setSources({ status: "loading" });
    listSources(controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        setSources({ status: "ready", list: answer.sources });
        onList(answer.sources);
      },
      (failure: unknown) => {
        if (controller.signal.aborted || isUnauthorized(failure)) return;
        setSources({ status: "failed", message: errorMessage(failure) });
      },
    );
  }

  return { load, sources };
}

function MountForm({
  error,
  listSources,
  onCancel,
  onCreate,
  pending,
  returnFocus,
}: MountDialogState) {
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const backendId = useId();
  const readOnlyId = useId();
  const readOnlyNote = useId();
  const [values, setValues] = useState(EMPTY_VALUES);
  const [backend, setBackend] = useState<Backend>("sftp");
  const [auth, setAuth] = useState<Auth>("password");
  const [readOnly, setReadOnly] = useState(true);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const { load, sources } = useSources(listSources);

  const set = (key: keyof MountValues) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));
  const local = backend === "local";
  const source =
    sources.status === "ready" ? sources.list.find((item) => item.id === sourceId) : undefined;
  const forced = local && source?.readOnly === true;
  const effectiveReadOnly = forced || readOnly;
  const sourcesError = local && sources.status === "failed" ? sources.message : null;

  function chooseBackend(next: string) {
    const chosen = BACKENDS.find((item) => item.value === next)?.value ?? "sftp";
    setBackend(chosen);
    if (chosen === "local") load((list) => setSourceId(list[0]?.id ?? null));
  }

  function submitMount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const input = mountInput(values, backend, auth, effectiveReadOnly, source?.id ?? null);
    if (typeof input === "string") {
      setValidationError(input);
      return;
    }
    setValidationError(null);
    if (input) onCreate(input);
  }

  return (
    <CreationDialog
      className="max-h-[calc(100%-2rem)] overflow-y-auto"
      error={validationError ?? sourcesError ?? error}
      initialFocus={nameRef}
      onCancel={onCancel}
      onSubmit={submitMount}
      pending={pending}
      pendingNote="正在连接…"
      returnFocus={returnFocus}
      submitDisabled={local && source === undefined}
      submitLabel="测试连通并挂载"
      title="挂载目录"
    >
      <div className={FIELD}>
        <Label htmlFor={nameId}>挂载名称</Label>
        <Input
          autoComplete="off"
          id={nameId}
          onChange={set("name")}
          placeholder="例如 数据仓库导出"
          ref={nameRef}
          value={values.name}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor={backendId}>协议</Label>
        <Select onValueChange={chooseBackend} value={backend}>
          <SelectTrigger className="w-full" id={backendId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BACKENDS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {local ? (
        <SourceField onChoose={setSourceId} sourceId={sourceId} sources={sources} />
      ) : (
        <RemoteFields auth={auth} backend={backend} onAuth={setAuth} set={set} values={values} />
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={readOnlyId}>只读挂载</Label>
          <p className="m-0 text-xs text-muted-foreground" id={readOnlyNote}>
            禁止写入，防止误改源目录
          </p>
        </div>
        <Switch
          aria-describedby={readOnlyNote}
          checked={effectiveReadOnly}
          disabled={forced}
          id={readOnlyId}
          onCheckedChange={setReadOnly}
        />
      </div>
    </CreationDialog>
  );
}

/** `服务器目录`: the sources' dropdown (read-only ones suffixed), or why there is none. */
function SourceField({
  onChoose,
  sourceId,
  sources,
}: {
  onChoose(id: string): void;
  sourceId: string | null;
  sources: Sources;
}) {
  const id = useId();
  if (sources.status === "loading") return <p className={NOTE}>正在读取服务器目录…</p>;
  if (sources.status !== "ready") return null;
  if (sources.list.length === 0) return <p className={NOTE}>管理员尚未登记服务器目录</p>;

  return (
    <div className={FIELD}>
      <Label htmlFor={id}>目录</Label>
      <Select onValueChange={onChoose} value={sourceId ?? ""}>
        <SelectTrigger className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sources.list.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {sourceLabel(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type RemoteFieldsProps = {
  auth: Auth;
  backend: Exclude<Backend, "local">;
  onAuth(auth: Auth): void;
  set(key: keyof MountValues): (event: { target: { value: string } }) => void;
  values: MountValues;
};

/** `SFTP` / `SMB`: host, port, path, user name, then the credential (and `SMB`'s domain). */
function RemoteFields({ auth, backend, onAuth, set, values }: RemoteFieldsProps) {
  const ids = {
    host: useId(),
    port: useId(),
    path: useId(),
    user: useId(),
    domain: useId(),
  };
  const smb = backend === "smb";

  return (
    <>
      <div className={FIELD}>
        <Label htmlFor={ids.host}>主机</Label>
        <Input autoComplete="off" id={ids.host} onChange={set("host")} value={values.host} />
      </div>
      <div className={FIELD}>
        <Label htmlFor={ids.port}>端口</Label>
        <Input
          autoComplete="off"
          id={ids.port}
          inputMode="numeric"
          onChange={set("port")}
          placeholder={smb ? "445" : "22"}
          value={values.port}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor={ids.path}>目录路径</Label>
        <Input
          autoComplete="off"
          id={ids.path}
          onChange={set("remotePath")}
          placeholder={smb ? "/共享名/目录" : "/srv/data"}
          value={values.remotePath}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor={ids.user}>用户名</Label>
        <Input
          autoComplete="off"
          id={ids.user}
          onChange={set("username")}
          value={values.username}
        />
      </div>
      <Credential
        auth={smb ? "password" : auth}
        onAuth={smb ? null : onAuth}
        set={set}
        values={values}
      />
      {smb ? (
        <div className={FIELD}>
          <Label htmlFor={ids.domain}>域</Label>
          <Input
            autoComplete="off"
            id={ids.domain}
            onChange={set("domain")}
            value={values.domain}
          />
        </div>
      ) : null}
    </>
  );
}

/** `认证方式`（`SFTP` only: `onAuth` given）and the password, or the multi-line private key. */
function Credential({
  auth,
  onAuth,
  set,
  values,
}: Omit<RemoteFieldsProps, "backend" | "onAuth"> & { onAuth: ((auth: Auth) => void) | null }) {
  const legend = useId();
  const byPassword = useId();
  const byKey = useId();
  const secret = useId();

  return (
    <>
      {onAuth ? (
        <div className={FIELD}>
          <Label id={legend}>认证方式</Label>
          <RadioGroup
            aria-labelledby={legend}
            className="flex gap-4"
            onValueChange={(next) => onAuth(next === "privateKey" ? "privateKey" : "password")}
            value={auth}
          >
            <div className="flex items-center gap-1.5">
              <RadioGroupItem id={byPassword} value="password" />
              <Label htmlFor={byPassword}>密码</Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem id={byKey} value="privateKey" />
              <Label htmlFor={byKey}>私钥</Label>
            </div>
          </RadioGroup>
        </div>
      ) : null}
      {auth === "privateKey" ? (
        <div className={FIELD}>
          <Label htmlFor={secret}>私钥</Label>
          <Textarea
            autoComplete="off"
            className="max-h-40 font-mono text-xs"
            id={secret}
            onChange={set("privateKey")}
            spellCheck={false}
            value={values.privateKey}
          />
        </div>
      ) : (
        <div className={FIELD}>
          <Label htmlFor={secret}>密码</Label>
          <Input
            autoComplete="new-password"
            id={secret}
            onChange={set("password")}
            type="password"
            value={values.password}
          />
        </div>
      )}
    </>
  );
}
