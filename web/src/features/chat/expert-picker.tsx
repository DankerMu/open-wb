// 专家对话框（experts「输入框的专家选择」；s1d-experts-skills design D9、tasks.md 9.2）：「+」菜单的 `选择专家…`
// 打开它。搜索框、顶部恒有的 `不使用专家`、按 `开发` / `办公` / `设计` / `产品` 分组的可见专家（名称、`内置` /
// `自建`、描述）；选中即关闭。每次打开另重取一次专家清单并以结果更新会话页的缓存。
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EXPERT_CATEGORIES, type ExpertView } from "@/lib/api";
import { useEscapeFallback } from "../../components/escape-fallback.js";

const TITLE = "选择专家";
const SEARCH = "搜索专家";
const NONE = "不使用专家";
const NO_MATCH = "没有匹配的专家";
const LOADING = "正在读取专家…";
const FAILED = "专家读取失败，关闭后重新打开可重试";

/** 本次打开的那次重取：在途、成功或失败。 */
type Status = "loading" | "done" | "failed";

/**
 * 对话框的开合与「打开即重取」：`show()` 打开并发出一次 `refresh()`，状态只采用本次打开的那次结果（关闭后
 * 再打开的迟到结果不改新一次的状态）。重取在事件里发出，不在 effect 里：StrictMode 的 effect 重跑会多发一次。
 */
export function useExpertDialog(refresh: () => Promise<boolean>) {
  const [status, setStatus] = useState<Status | null>(null);
  const openedRef = useRef(0);
  const show = useCallback(() => {
    openedRef.current += 1;
    const opened = openedRef.current;
    setStatus("loading");
    void refresh().then((ok) => {
      if (openedRef.current === opened) setStatus(ok ? "done" : "failed");
    });
  }, [refresh]);
  const close = useCallback(() => {
    openedRef.current += 1;
    setStatus(null);
  }, []);
  return { close, show, status };
}

type ExpertPickerProps = {
  /** null 即关闭。 */
  status: Status | null;
  /** 会话页的专家清单（缓存）；从未取得时为 null。 */
  experts: readonly ExpertView[] | null;
  onChoose(expertId: string | null): void;
  onClose(): void;
  /** 关闭后焦点的去处（`添加文件或命令` 按钮）。 */
  restoreFocus(): void;
};

export function ExpertPicker({
  experts,
  onChoose,
  onClose,
  restoreFocus,
  status,
}: ExpertPickerProps) {
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open={status !== null}>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-md"
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
        <ExpertOptions
          experts={experts}
          onChoose={(expertId) => {
            onChoose(expertId);
            onClose();
          }}
          status={status ?? "done"}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 名称、描述或任一标签含查询串（先 trim、不区分大小写；空串匹配全部）——与中心「专家」tab
 * （`features/center/experts/list.tsx` 的 `matches`）同一规则。
 */
function matches(expert: ExpertView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [expert.name, expert.description, ...expert.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

const OPTION =
  "flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const NOTE = "m-0 px-2.5 py-1 text-xs wrap-anywhere text-muted-foreground";

/** 对话框内容：只在打开时挂载，所以查询每次打开都为空。分组按固定次序，无成员的分组不显示，组内按清单次序。 */
function ExpertOptions({
  experts,
  onChoose,
  status,
}: {
  experts: readonly ExpertView[] | null;
  onChoose(expertId: string | null): void;
  status: Status;
}) {
  const [query, setQuery] = useState("");
  const shown = (experts ?? []).filter((expert) => matches(expert, query));
  const note =
    experts === null
      ? status === "failed"
        ? FAILED
        : LOADING
      : shown.length === 0
        ? NO_MATCH
        : null;
  return (
    <>
      <Input
        aria-label={SEARCH}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={SEARCH}
        value={query}
      />
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <button className={OPTION} onClick={() => onChoose(null)} type="button">
          {NONE}
        </button>
        {EXPERT_CATEGORIES.map((category) => {
          const members = shown.filter((expert) => expert.category === category);
          return members.length === 0 ? null : (
            <ExpertGroup category={category} experts={members} key={category} onChoose={onChoose} />
          );
        })}
        {note === null ? null : <p className={NOTE}>{note}</p>}
      </div>
    </>
  );
}

function ExpertGroup({
  category,
  experts,
  onChoose,
}: {
  category: string;
  experts: readonly ExpertView[];
  onChoose(expertId: string): void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
      <legend className="mb-0.5 px-2.5 text-xs font-medium text-muted-foreground">
        {category}
      </legend>
      {experts.map((expert) => (
        <button
          className={OPTION}
          key={expert.id}
          onClick={() => onChoose(expert.id)}
          type="button"
        >
          <span className="flex max-w-full items-center gap-1.5">
            <strong className="min-w-0 truncate font-semibold">{expert.name}</strong>
            <span className="flex-none rounded-md bg-muted px-1.5 text-xs text-muted-foreground">
              {expert.builtin ? "内置" : "自建"}
            </span>
          </span>
          {expert.description === "" ? null : (
            <span className="max-w-full text-xs text-muted-foreground wrap-anywhere">
              {expert.description}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  );
}
