import { useId, useState } from "react";
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
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EXPERT_CATEGORIES, type ExpertCategory, type ExpertView } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";

const ALL = "全部";
const CHIPS = [ALL, ...EXPERT_CATEGORIES] as const;
const NO_MATCH = "没有匹配的专家";
const TAG = "rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";

type Chip = typeof ALL | ExpertCategory;

type CardActions = {
  /** 卡片按钮的点击把按钮本身交出去，供对话框关闭后归还焦点。 */
  onStart(expert: ExpertView): void;
  onEdit(expert: ExpertView, trigger: HTMLElement): void;
  onRemove(expert: ExpertView, trigger: HTMLElement): void;
};

/** 名称、描述或任一标签含 `query`（不区分大小写；空串匹配全部）。 */
function matches(expert: ExpertView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [expert.name, expert.description, ...expert.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

function ExpertCard({ expert, onStart, onEdit, onRemove }: CardActions & { expert: ExpertView }) {
  const titleId = useId();
  return (
    <li aria-labelledby={titleId}>
      <Card className="h-full" size="sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-sm font-medium [overflow-wrap:anywhere]" id={titleId}>
              {expert.name}
            </h3>
            <span className={TAG}>{expert.builtin ? "内置" : "自建"}</span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2">
          {expert.description === "" ? null : (
            <p className="ui-muted m-0 text-xs [overflow-wrap:anywhere]">{expert.description}</p>
          )}
          {expert.tags.length === 0 ? null : (
            <div className="flex flex-wrap gap-1">
              {expert.tags.map((tag) => (
                <span className={TAG} key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-1">
          <Button onClick={() => onStart(expert)} size="sm">
            开始会话
          </Button>
          {expert.builtin ? null : (
            <>
              <Button
                onClick={(event) => onEdit(expert, event.currentTarget)}
                size="sm"
                variant="outline"
              >
                编辑
              </Button>
              <Button
                onClick={(event) => onRemove(expert, event.currentTarget)}
                size="sm"
                variant="outline"
              >
                删除
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </li>
  );
}

/**
 * 分类 chip（单选，缺省 `全部`）、搜索框与卡片网格（experts「中心「专家」tab」）。chip 与搜索取交集；
 * 卡片按 `listExperts` 的次序（内置在前、自建在后）。
 */
export function ExpertBrowser({ experts, ...actions }: CardActions & { experts: ExpertView[] }) {
  const [chip, setChip] = useState<Chip>(ALL);
  const [query, setQuery] = useState("");
  const shown = experts.filter(
    (expert) => (chip === ALL || expert.category === chip) && matches(expert, query),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">分类</legend>
          {CHIPS.map((name) => (
            <Button
              aria-pressed={chip === name}
              key={name}
              onClick={() => setChip(name)}
              size="sm"
              variant={chip === name ? "secondary" : "ghost"}
            >
              {name}
            </Button>
          ))}
        </fieldset>
        <Input
          aria-label="搜索专家"
          className="w-full max-w-60"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索专家"
          type="search"
          value={query}
        />
      </div>
      {shown.length === 0 ? (
        <p className="ui-muted m-0">{NO_MATCH}</p>
      ) : (
        <ul
          aria-label="专家列表"
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3 p-0"
          // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
          role="list"
        >
          {shown.map((expert) => (
            <ExpertCard expert={expert} key={expert.id} {...actions} />
          ))}
        </ul>
      )}
    </div>
  );
}

type RemoveProps = {
  expert: ExpertView;
  pending: boolean;
  restoreFocus(): void;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * `删除专家 <名称>？` 确认框（拷入层 alert-dialog）。`取消` 不发请求；`删除` 恰发一次。请求在途时两个按钮都
 * 禁用、Escape 与遮罩也关不掉。
 */
export function RemoveExpertDialog({
  expert,
  pending,
  restoreFocus,
  onConfirm,
  onCancel,
}: RemoveProps) {
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
          <AlertDialogTitle>{`删除专家 ${expert.name}？`}</AlertDialogTitle>
          <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
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
