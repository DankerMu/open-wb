// 输入框知识库引用的选择列表与标签区（message-attachments「输入框知识库引用」；s2c-kb-session 任务 8.2）：「+」菜单的
// `引用知识库…` 打开选择列表，每次打开重取一次库列表，点选切换引用、不关闭；标签区经输入卡的附件插槽放在文本框上方。
// 引用状态在 kb-refs-state.ts。
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEscapeFallback } from "../../components/escape-fallback.js";
import { Icon } from "../../components/icon.js";
import type { ApiClient, BaseView } from "../../lib/api.js";
import { STATE_MARK } from "../../lib/kb-status.js";
import { errorMessage } from "./errors.js";
import { KB_REF_LIMIT, type KbRef } from "./kb-refs-state.js";

const TITLE = "引用知识库";
const TAGS = "引用的知识库";
const LOADING = "正在读取知识库…";
const EMPTY = "还没有知识库";

/** 本次打开的那次读取：在途、取得或失败（带失败的 message）。 */
type ListState =
  | { status: "loading" }
  | { status: "done"; bases: readonly BaseView[] }
  | { status: "failed"; message: string };

/**
 * 选择列表的开合与「打开即重取」：`show()` 打开并发出一次 `listKnowledgeBases()`，只采用本次打开的结果（关闭后再
 * 打开，先前那次迟到的应答被丢弃）。读取在事件里发出，不在 effect 里：StrictMode 的 effect 重跑会多发一次。
 */
export function useKbRefDialog(client: Pick<ApiClient, "listKnowledgeBases">) {
  const [list, setList] = useState<ListState | null>(null);
  const openedRef = useRef(0);
  const show = useCallback(() => {
    openedRef.current += 1;
    const opened = openedRef.current;
    const settle = (next: ListState) => {
      if (openedRef.current === opened) setList(next);
    };
    setList({ status: "loading" });
    client.listKnowledgeBases().then(
      (bases) => settle({ status: "done", bases }),
      (error: unknown) => settle({ status: "failed", message: errorMessage(error) }),
    );
  }, [client]);
  const close = useCallback(() => {
    openedRef.current += 1;
    setList(null);
  }, []);
  return { close, list, show };
}

/** 知识库开启时会话页交给输入框的一组：选择列表的开合、当前归属的引用、切换与移除。 */
export type KbRefEntry = {
  dialog: ReturnType<typeof useKbRefDialog>;
  onRemove(id: string): void;
  onToggle(ref: KbRef): void;
  refs: readonly KbRef[];
};

const OPTION =
  "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-accent";
const NOTE = "m-0 px-2.5 py-1 text-xs wrap-anywhere";

/** 选择列表（`Dialog`，可访问名 `引用知识库`）；关闭后焦点交给 `restoreFocus`（`添加文件或命令` 按钮）。 */
export function KbRefPicker({
  dialog,
  onToggle,
  refs,
  restoreFocus,
}: Omit<KbRefEntry, "onRemove"> & { restoreFocus(): void }) {
  const onOpenChange = (open: boolean) => {
    if (!open) dialog.close();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open={dialog.list !== null}>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{TITLE}</DialogTitle>
        </DialogHeader>
        <KbRefOptions list={dialog.list ?? { status: "loading" }} onToggle={onToggle} refs={refs} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 列表内容：每个库一个 `aria-pressed` 按钮（库名；非 `ready` 附状态字样，同样可选）。已引用 `KB_REF_LIMIT` 个时
 * 其余未选项禁用。在途显示读取中，失败显示该失败的 message，都不改动已有引用。
 */
function KbRefOptions({
  list,
  onToggle,
  refs,
}: {
  list: ListState;
  onToggle(ref: KbRef): void;
  refs: readonly KbRef[];
}) {
  if (list.status === "failed") {
    return (
      <p className={`${NOTE} text-(--wb-status-error-text)`} role="alert">
        {list.message}
      </p>
    );
  }
  if (list.status === "loading" || list.bases.length === 0) {
    return (
      <p className={`${NOTE} text-muted-foreground`}>
        {list.status === "loading" ? LOADING : EMPTY}
      </p>
    );
  }
  const full = refs.length >= KB_REF_LIMIT;
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
    <ul className="m-0 flex min-h-0 list-none flex-col gap-0.5 overflow-y-auto p-0" role="list">
      {list.bases.map((base) => {
        const pressed = refs.some((ref) => ref.id === base.id);
        const mark = STATE_MARK[base.state];
        return (
          <li key={base.id}>
            <button
              aria-pressed={pressed}
              className={OPTION}
              disabled={full && !pressed}
              onClick={() => onToggle(base)}
              type="button"
            >
              <span className="min-w-0 truncate font-medium">{base.name}</span>
              {mark === null ? null : (
                <span className="flex-none rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
                  {mark}
                </span>
              )}
              {pressed ? (
                <span className="ml-auto flex flex-none text-(--wb-brand-primary)">
                  <Icon name="check" size={14} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 输入卡里的引用标签区（`role="list"`，可访问名 `引用的知识库`）：库名与 `移除 <库名>`，按加入次序；没有引用时不渲染。 */
export function KbRefTags({ onRemove, refs }: Pick<KbRefEntry, "onRemove" | "refs">) {
  return refs.length === 0 ? null : (
    <ul
      aria-label={TAGS}
      className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
      data-slot="composer-kb-refs"
      // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
      role="list"
    >
      {refs.map((ref) => (
        <li
          className="flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-(--wb-brand-primary-subtle) py-0.5 pr-0.5 pl-2 text-xs leading-5 text-(--wb-brand-primary-deep)"
          key={ref.id}
        >
          <span className="min-w-0 truncate font-medium" title={ref.name}>
            {ref.name}
          </span>
          <Button
            aria-label={`移除 ${ref.name}`}
            className="flex-none text-(--wb-brand-primary-deep)"
            onClick={() => onRemove(ref.id)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Icon name="x" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
