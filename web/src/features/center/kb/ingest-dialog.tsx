import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ApiClient, ApiError, type KbIngestResult, REQUEST_FAILED_MESSAGE } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import { formatSize } from "../../files/index.js";

const ALERT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";
const MUTED = "m-0 text-xs text-muted-foreground";

/** 一次入库或上传的结果：整批拒绝的提示，与逐条未入库的文件及其文案。 */
export type IngestOutcome = {
  notice: string | null;
  failures: { name: string; message: string }[];
};

/**
 * 入库结果（两个入口共用，s2a-kb-ragflow 16.5）：`从工作空间入库` 被拒的条目与 `上传文件` 的就地拒绝、失败，逐条为
 * `<路径或文件名>：<文案>`。一批里的路径（文件名）互不相同，用作 key。没有可显示的内容时不渲染。
 */
export function IngestResults({ outcome }: { outcome: IngestOutcome | null }) {
  if (!outcome || (outcome.notice === null && outcome.failures.length === 0)) return null;
  return (
    <div className="ui-alert flex flex-col gap-1" role="alert">
      {outcome.notice}
      {outcome.failures.length > 0 ? (
        // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
        <ul className="m-0 list-none p-0" role="list">
          {outcome.failures.map((item) => (
            <li className="[overflow-wrap:anywhere]" key={item.name}>
              {`${item.name}：${item.message}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

type Listing =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; entries: Awaited<ReturnType<ApiClient["listTree"]>>["entries"] };

type TreeProps = {
  client: ApiClient;
  workspaceId: string;
  checked: readonly string[];
  /** 已勾满 `uploadMaxFiles` 个：没勾的文件不可勾。 */
  full: boolean;
  onToggle(path: string, on: boolean): void;
};

const childPath = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`);

/**
 * 一个工作空间的目录树：挂载时读根，展开一个目录才读那一层（`listTree`），读到的层不重读，失败的层再展开时重读。
 * 文件行是复选框；目录不可勾（整个目录入库不在本阶段）。调用方按空间 id 设 `key`，换空间即重新挂载。
 */
function WorkspaceFiles({ client, workspaceId, ...rows }: TreeProps) {
  // Map 而不是对象：目录名可以是 `constructor` 之类原型上的键。
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const live = useRef<AbortSignal | null>(null);

  const load = useCallback(
    (path: string) => {
      const signal = live.current;
      const put = (listing: Listing) => {
        if (signal && !signal.aborted)
          setListings((current) => new Map(current).set(path, listing));
      };
      put({ status: "loading" });
      client.listTree(workspaceId, path, signal ? { signal } : undefined).then(
        ({ entries }) => put({ status: "ready", entries }),
        (error: unknown) => put({ status: "failed", message: messageOf(error) }),
      );
    },
    [client, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    live.current = controller.signal;
    load("");
    return () => controller.abort();
  }, [load]);

  const toggle = (path: string) => {
    const open = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    const listing = listings.get(path);
    if (open && (listing === undefined || listing.status === "failed")) load(path);
  };

  const level = (path: string) => {
    const listing = listings.get(path);
    if (listing === undefined || listing.status === "loading")
      return <p className={MUTED}>正在读取目录</p>;
    if (listing.status === "failed") {
      return (
        <p className={ALERT} role="alert">
          {listing.message}
        </p>
      );
    }
    if (listing.entries.length === 0) return <p className={MUTED}>空目录</p>;
    return (
      // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0" role="list">
        {listing.entries.map((entry) => {
          const entryPath = childPath(path, entry.name);
          return entry.type === "dir" ? (
            <li key={entryPath}>
              <button
                aria-expanded={expanded.has(entryPath)}
                aria-label={`${expanded.has(entryPath) ? "折叠" : "展开"} ${entry.name}`}
                className="w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
                onClick={() => toggle(entryPath)}
                type="button"
              >
                {`${expanded.has(entryPath) ? "▾" : "▸"} ${entry.name}`}
              </button>
              {expanded.has(entryPath) ? <div className="pl-4">{level(entryPath)}</div> : null}
            </li>
          ) : (
            <FileRow
              key={entryPath}
              name={entry.name}
              path={entryPath}
              size={entry.size}
              {...rows}
            />
          );
        })}
      </ul>
    );
  };

  return level("");
}

function FileRow({
  name,
  path,
  size,
  checked,
  full,
  onToggle,
}: Pick<TreeProps, "checked" | "full" | "onToggle"> & {
  name: string;
  path: string;
  size: number;
}) {
  const id = useId();
  const on = checked.includes(path);
  return (
    <li className="flex items-center gap-2 px-1 py-0.5">
      <Checkbox
        checked={on}
        disabled={!on && full}
        id={id}
        onCheckedChange={(next) => onToggle(path, next === true)}
      />
      <Label className="min-w-0 flex-1 truncate font-normal" htmlFor={id}>
        {name}
      </Label>
      <span aria-hidden="true" className="flex-none text-xs text-muted-foreground">
        {formatSize(size)}
      </span>
    </li>
  );
}

type IngestDialogProps = {
  client: ApiClient;
  baseId: string;
  /** 当前用户的工作空间，按列表次序；缺省选第一个。 */
  workspaces: readonly { id: string; name: string }[];
  /** `GET /api/kb/status` 的 `uploadMaxFiles`。 */
  maxFiles: number;
  restoreFocus(): void;
  /** 201：调用方关闭对话框、显示被拒的条目并重取一次文档列表。 */
  onDone(result: KbIngestResult): void;
  onCancel(): void;
};

/**
 * `从工作空间入库` 对话框（knowledge-bases「中心「知识库」tab」，s2a-kb-ragflow 16.5）：选工作空间，逐级浏览目录并勾选
 * 文件，至多 `maxFiles` 个；提交恰调用一次 `ingestFromWorkspace`。请求在途时两个按钮禁用，Escape、遮罩与关闭按钮
 * 也关不掉；整个请求失败时信封文案以 `role="alert"` 留在框内。换空间清掉勾选。
 */
export function IngestDialog({
  client,
  baseId,
  workspaces,
  maxFiles,
  restoreFocus,
  onDone,
  onCancel,
}: IngestDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 在途标记：同一帧里的第二次提交还看不到 `pending` 的重渲染，靠它拦下。 */
  const sending = useRef(false);
  const spaceId = useId();
  const workspace = workspaces.find((item) => item.id === chosen) ?? workspaces[0];
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || checked.length === 0 || sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      onDone(
        await client.ingestFromWorkspace(baseId, { workspaceId: workspace.id, paths: checked }),
      );
    } catch (failure) {
      setError(messageOf(failure));
      setPending(false);
    } finally {
      sending.current = false;
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">从工作空间入库</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void submit(event)}>
          {workspace ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={spaceId}>工作空间</Label>
                <Select
                  disabled={pending}
                  onValueChange={(id) => {
                    setChosen(id);
                    setChecked([]);
                  }}
                  value={workspace.id}
                >
                  <SelectTrigger className="w-full" id={spaceId}>
                    <SelectValue>{workspace.name}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border p-1.5">
                <WorkspaceFiles
                  checked={checked}
                  client={client}
                  full={checked.length >= maxFiles}
                  key={workspace.id}
                  onToggle={(path, on) =>
                    setChecked((current) =>
                      on
                        ? current.includes(path)
                          ? current
                          : [...current, path]
                        : current.filter((p) => p !== path),
                    )
                  }
                  workspaceId={workspace.id}
                />
              </div>
              <p className={MUTED}>{`已选 ${checked.length} / ${maxFiles}`}</p>
            </>
          ) : (
            <p className={MUTED}>没有可用的工作空间</p>
          )}
          {error ? (
            <p className={`${ALERT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button
              aria-busy={pending ? true : undefined}
              disabled={pending || checked.length === 0}
              type="submit"
            >
              入库并解析
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
