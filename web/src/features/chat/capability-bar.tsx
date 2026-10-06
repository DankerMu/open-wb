// 输入框底部的能力栏（design D6、D13），自左向右：工作空间位（欢迎态是选择器，会话开始后是只读标签）、
// 「+」菜单（技能与命令）。权限、上传、专家等控件不渲染，也不摆禁用占位。
import { type RefObject, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/file-meta.js";
import { sourceTag, type useSlashMenu } from "./slash-menu.js";
import type { WelcomeOptions } from "./welcome-options.js";
import type { Workspace } from "./workspace-list.js";

const PREFIX = "任务启动于";
const SEARCH = "搜索工作空间";
const UNSELECTED = "未选择";

type WorkspaceChoice = Pick<WelcomeOptions, "workspace" | "workspaces" | "workspacesError"> & {
  onSelect(workspaceId: string | null): void;
};

type PlusMenu = ReturnType<typeof useSlashMenu>["plus"];

type CapabilityBarProps = {
  /** 欢迎态的空间选择；`onSelect` 只改会话页的内存状态。 */
  choice: WorkspaceChoice;
  /** 输入框锁定：选择器按钮随之禁用。 */
  disabled: boolean;
  /** 输入框元素：「+」菜单点选后把焦点交给它。 */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 「+」菜单的目录、开合与可用条件（与斜杠候选同出 `useSlashMenu`，共用一份目录）。 */
  plus: PlusMenu;
  /**
   * 已选会话绑定的工作空间：`id` 为 null 即未绑定，undefined 表示会话还没解析出来；`workspace` 是它在
   * 已读取列表里的那一项（读取中、读取失败或空间已删时为 undefined）。欢迎态不传。
   */
  session?: { id: string | null | undefined; workspace: Workspace | undefined };
};

export function CapabilityBar({ choice, disabled, inputRef, plus, session }: CapabilityBarProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-slot="composer-capabilities">
      {session === undefined ? (
        <WorkspacePicker {...choice} disabled={disabled} />
      ) : (
        <WorkspaceLabel {...session} />
      )}
      <CommandMenu inputRef={inputRef} plus={plus} />
    </div>
  );
}

/**
 * `技能与命令` 按钮与菜单：按目录顺序列出命令与技能（名称、项目标记、描述）；目录未持有（拉取中或失败）时
 * 只有 `暂无可用项`，目录到达后列表就地替换它。点选把草稿写成 `/<name> `，菜单关闭后焦点交给输入框而不是
 * 回到按钮（此时草稿非空白，按钮已禁用）；Esc 等其它关闭方式仍按菜单默认把焦点还给按钮。
 */
function CommandMenu({ inputRef, plus }: Pick<CapabilityBarProps, "inputRef" | "plus">) {
  const picked = useRef(false);
  return (
    <DropdownMenu onOpenChange={plus.onOpenChange} open={plus.open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="技能与命令"
          className="flex-none text-muted-foreground"
          disabled={plus.disabled}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Icon name="plus" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-80 max-w-(--radix-dropdown-menu-content-available-width)"
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          if (!picked.current) return;
          picked.current = false;
          event.preventDefault();
          inputRef.current?.focus();
        }}
        side="top"
      >
        {plus.commands === undefined || plus.commands.length === 0 ? (
          <p className="m-0 px-1.5 py-1 text-sm text-muted-foreground">暂无可用项</p>
        ) : (
          plus.commands.map((command) => {
            const tag = sourceTag(command);
            return (
              <DropdownMenuItem
                className="flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-5 wrap-anywhere"
                key={command.name}
                onSelect={() => {
                  picked.current = true;
                  plus.onPick(command);
                }}
              >
                <span className="font-medium">{command.label}</span>
                {tag === null ? null : (
                  <span className="rounded bg-(--wb-brand-primary-subtle) px-1.5 text-xs text-(--wb-brand-primary-deep)">
                    {tag}
                  </span>
                )}
                <span className="text-muted-foreground">{command.description}</span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 只读标签：会话开始后工作空间即锁定，这里不可操作、不发请求。会话尚未解析出来时不渲染。 */
function WorkspaceLabel({ id, workspace }: NonNullable<CapabilityBarProps["session"]>) {
  if (id === undefined) return null;
  const name = id === null ? "未绑定" : (workspace?.name ?? "已绑定空间");
  return (
    <p
      className="m-0 flex min-w-0 items-center gap-1 px-2.5 text-[0.8rem] text-muted-foreground"
      data-slot="composer-workspace"
    >
      <Icon name="folder" size={14} />
      <span className="min-w-0 truncate">{`${PREFIX} ${name}`}</span>
    </p>
  );
}

/** `任务启动于 …` 按钮与空间选择弹层；输入框锁定时按钮禁用，已打开的弹层关闭且解锁后不重开。 */
function WorkspacePicker({ disabled, ...choice }: WorkspaceChoice & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  // 渲染期间复位（与 slash-menu.tsx 同一做法）：锁定的那次渲染就不再带着打开的弹层。
  if (disabled && open) setOpen(false);
  return (
    <div className="flex min-w-0 items-center" data-slot="composer-workspace">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="max-w-full min-w-0 font-normal text-muted-foreground"
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Icon name="folder" size={14} />
            <span className="min-w-0 truncate">{`${PREFIX} ${choice.workspace?.name ?? UNSELECTED}`}</span>
            <Icon name="chevron-down" size={12} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="选择工作空间"
          className="gap-1.5 p-2"
          collisionPadding={8}
        >
          <WorkspaceOptions
            {...choice}
            onSelect={(workspaceId) => {
              choice.onSelect(workspaceId);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

const OPTION =
  "flex w-full min-w-0 cursor-pointer flex-col rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-accent";

/** 弹层内容：只在弹层打开时挂载，所以查询每次打开都为空。按名称过滤，`未选择` 恒在。 */
function WorkspaceOptions({ onSelect, workspace, workspaces, workspacesError }: WorkspaceChoice) {
  const account = useAuth().principal?.account;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = (workspaces ?? []).filter((item) =>
    item.name.toLocaleLowerCase().includes(needle),
  );
  return (
    <>
      <Input
        aria-label={SEARCH}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={SEARCH}
        value={query}
      />
      {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。 */}
      <ul className="m-0 flex max-h-60 list-none flex-col gap-0.5 overflow-y-auto p-0" role="list">
        <li>
          <button
            aria-pressed={workspace === null}
            className={OPTION}
            onClick={() => onSelect(null)}
            type="button"
          >
            {UNSELECTED}
          </button>
        </li>
        {matches.map((item) => (
          <li key={item.id}>
            <button
              aria-pressed={item.id === workspace?.id}
              className={OPTION}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              <strong className="max-w-full truncate text-[12.5px] leading-[17px] font-semibold">
                {item.name}
              </strong>
              {account === undefined ? null : (
                <span className="max-w-full truncate font-mono text-[10.5px] leading-[14px] text-(--wb-text-tertiary)">
                  {logicalPath(account, item.dir)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <WorkspaceListNote
        error={workspacesError}
        loading={workspaces === null}
        unmatched={matches.length === 0}
      />
    </>
  );
}

const NOTE = "m-0 px-2.5 py-1 text-xs wrap-anywhere";

/** 列表之下的一句：读取失败的文案、读取在途，或已有列表但没有一项匹配。 */
function WorkspaceListNote(props: { error: string | null; loading: boolean; unmatched: boolean }) {
  if (props.error !== null) {
    return (
      <p className={`${NOTE} text-(--wb-status-error-text)`} role="alert">
        {props.error}
      </p>
    );
  }
  if (!props.loading && !props.unmatched) return null;
  return (
    <p className={`${NOTE} text-muted-foreground`}>
      {props.loading ? "正在读取工作空间" : "没有匹配的工作空间"}
    </p>
  );
}
