/**
 * Workspace switcher card and its popover (search, list, 新建工作空间). The popover keeps
 * `role="dialog"` and the name `工作空间切换器`; opening focuses the search box and Escape returns
 * focus to the card, both from Radix.
 */
import { useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "../../ui/index.js";
import { logicalPath } from "./file-meta.js";
import type { Workspace } from "./types.js";

type WorkspaceSwitcherProps = {
  account: string;
  currentWorkspace: Workspace | null;
  workspaces: readonly Workspace[];
  /** 回调带上切换器触发器，供对话框在取消类关闭后把焦点还给它。 */
  onCreateWorkspace(trigger: HTMLElement | null): void;
  onSelectWorkspace(id: string): void;
};

const CARD_ROW =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-(--wb-text-primary) hover:bg-(--wb-brand-primary-subtle)";

/** 空间名（`strong`）加逻辑路径，卡片与列表项同一写法。 */
function WorkspaceCopy({ name, path }: { name: string; path: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <strong className="text-[0.8rem] leading-[1.3] font-semibold [overflow-wrap:anywhere]">
        {name}
      </strong>
      <span className="font-(family-name:--wb-mono) text-[0.65rem] leading-[1.3] text-(--wb-text-tertiary) [overflow-wrap:anywhere]">
        {path}
      </span>
    </span>
  );
}

export function WorkspaceSwitcher({
  account,
  currentWorkspace,
  onCreateWorkspace,
  onSelectWorkspace,
  workspaces,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchId = useId();
  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) {
      return workspaces;
    }

    return workspaces.filter((workspace) =>
      [workspace.name, logicalPath(account, workspace.dir)].some((text) =>
        text.toLocaleLowerCase().includes(normalizedQuery),
      ),
    );
  }, [account, query, workspaces]);

  return (
    <div className="mx-[0.65rem] mt-[0.65rem] mb-1 min-w-0">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-label="选择工作空间"
            className={`${CARD_ROW} rounded-[10px] border border-(--wb-border-default) bg-(--wb-bg-primary) px-[0.65rem] py-2`}
            ref={triggerRef}
            type="button"
          >
            <Icon name="layout-grid" size={16} />
            <WorkspaceCopy
              name={currentWorkspace?.name ?? "未选择工作空间"}
              path={currentWorkspace ? logicalPath(account, currentWorkspace.dir) : "—"}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="工作空间切换器"
          className="max-h-[min(22rem,70vh)] gap-[0.4rem] overflow-hidden p-2"
          collisionPadding={8}
        >
          <div className="flex shrink-0 flex-col gap-[0.3rem]">
            <Label
              className="text-[0.75rem] font-normal text-(--wb-text-secondary)"
              htmlFor={searchId}
            >
              搜索工作空间
            </Label>
            <Input
              id={searchId}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工作空间"
              value={query}
            />
          </div>
          <ul className="min-h-0 overflow-auto" data-slot="switcher-list">
            {filteredWorkspaces.map((workspace) => {
              const current = workspace.id === currentWorkspace?.id;
              return (
                <li key={workspace.id}>
                  <button
                    aria-pressed={current}
                    className={`${CARD_ROW} rounded-[6px] px-[0.55rem] py-[0.45rem] aria-pressed:bg-(--wb-brand-primary-subtle)`}
                    onClick={() => {
                      setOpen(false);
                      onSelectWorkspace(workspace.id);
                    }}
                    type="button"
                  >
                    <WorkspaceCopy
                      name={workspace.name}
                      path={logicalPath(account, workspace.dir)}
                    />
                    {current ? (
                      <span
                        aria-label="当前工作空间"
                        className="shrink-0 font-bold text-(--wb-brand-primary)"
                        role="img"
                      >
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {filteredWorkspaces.length === 0 ? (
            <p className="mx-[0.35rem] my-1 text-[0.75rem] text-muted-foreground">
              无匹配的工作空间
            </p>
          ) : null}
          <Button
            className="shrink-0"
            onClick={() => {
              setOpen(false);
              onCreateWorkspace(triggerRef.current);
            }}
            type="button"
            variant="secondary"
          >
            ＋ 新建工作空间
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
