import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { type ApiClient, ApiError, type MountView, REQUEST_FAILED_MESSAGE } from "@/lib/api";
import { formatSize } from "../../files/index.js";

export const ALERT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";
export const MUTED = "m-0 text-xs text-muted-foreground";
const ROW = "flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-sm";
const TAG = "shrink-0 rounded-[4px] border px-1 text-[10px] leading-[15px] text-muted-foreground";

export function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

type Listing =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; entries: Awaited<ReturnType<ApiClient["listTree"]>>["entries"] };

type Mounts = { status: "loading" } | { status: "failed"; message: string } | MountView[];

type TreeProps = {
  client: ApiClient;
  workspaceId: string;
  checked: readonly string[];
  /** 已勾满 `uploadMaxFiles` 个：没勾的文件不可勾。 */
  full: boolean;
  onToggle(path: string, on: boolean): void;
};

type RowState = Pick<TreeProps, "checked" | "full" | "onToggle">;

const childPath = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`);

/**
 * `从工作空间入库` 的目录树（s2a-kb-ragflow 16.5）：挂载时读根（`listTree`）与该空间的挂载（`listMounts`），展开一个
 * 目录才读那一层，读到的层不重读，失败的层再展开时重读。文件行是复选框；目录不可勾（整个目录入库不在本阶段）。
 *
 * 挂载根行同文件页（workspace-mounts「挂载根行」）：根的 `tree` 不列挂载点（design D21），挂载按列表次序排在根的条目
 * 之后；在线的像目录一样 `展开|折叠 <名>`，其下的路径以挂载名开头；离线的不能展开，显示 `离线，重新连接后可浏览`；
 * 只读的带 `只读`。读挂载失败时根下显示信封文案，树照常可用。调用方按空间 id 设 `key`：换空间即重新挂载，旧空间在途
 * 的应答随之作废。
 */
export function WorkspaceFiles({ client, workspaceId, ...rows }: TreeProps) {
  // Map 而不是对象：目录名可以是 `constructor` 之类原型上的键。
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [mounts, setMounts] = useState<Mounts>({ status: "loading" });
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
    const { signal } = controller;
    live.current = signal;
    load("");
    client.listMounts(workspaceId, { signal }).then(
      (list) => {
        if (!signal.aborted) setMounts(list.mounts);
      },
      (error: unknown) => {
        if (!signal.aborted) setMounts({ status: "failed", message: messageOf(error) });
      },
    );
    return () => controller.abort();
  }, [client, workspaceId, load]);

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

  const folder = (path: string, label: string, tags: ReactNode = null) => (
    <li key={path}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          aria-expanded={expanded.has(path)}
          aria-label={`${expanded.has(path) ? "折叠" : "展开"} ${label}`}
          className={`${ROW} hover:bg-muted`}
          onClick={() => toggle(path)}
          type="button"
        >
          <span aria-hidden="true">{expanded.has(path) ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
        {tags}
      </div>
      {expanded.has(path) ? <div className="pl-4">{level(path)}</div> : null}
    </li>
  );

  const mountRow = (mount: MountView) => {
    const online = mount.status === "online";
    const tags = (
      <>
        {mount.readOnly ? <span className={TAG}>只读</span> : null}
        <span className="sr-only">{online ? "在线" : "离线"}</span>
      </>
    );
    if (online) return folder(mount.name, mount.name, tags);
    return (
      <li key={mount.name}>
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <span className={ROW}>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 flex-1 truncate">{mount.name}</span>
          </span>
          {tags}
        </div>
        <p className={`${MUTED} pl-4`}>离线，重新连接后可浏览</p>
      </li>
    );
  };

  function level(path: string) {
    const listing = listings.get(path);
    const roots = path === "" && Array.isArray(mounts) ? mounts : [];
    if (listing === undefined || listing.status === "loading")
      return <p className={MUTED}>正在读取目录</p>;
    if (listing.status === "failed") {
      return (
        <p className={ALERT} role="alert">
          {listing.message}
        </p>
      );
    }
    const mountError =
      path === "" && !Array.isArray(mounts) && mounts.status === "failed" ? (
        <p className={ALERT} role="alert">
          {mounts.message}
        </p>
      ) : null;
    if (listing.entries.length === 0 && roots.length === 0) {
      return (
        <>
          <p className={MUTED}>空目录</p>
          {mountError}
        </>
      );
    }
    return (
      <>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。 */}
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" role="list">
          {listing.entries.map((entry) => {
            const entryPath = childPath(path, entry.name);
            return entry.type === "dir" ? (
              folder(entryPath, entry.name)
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
          {roots.map(mountRow)}
        </ul>
        {mountError}
      </>
    );
  }

  return level("");
}

function FileRow({
  name,
  path,
  size,
  checked,
  full,
  onToggle,
}: RowState & { name: string; path: string; size: number }) {
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
