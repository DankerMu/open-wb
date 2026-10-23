// 输入框底部的能力栏（design D6、D13、D14；s1d-experts-skills D9），即工具行的左组，自左向右：「+」菜单（添加
// 文件或命令）、专家标签（有专家时）、工作空间位（欢迎态是选择器，会话开始后是只读标签）；权限档位控件排在
// 工作空间之后，`能力` 按钮在最后。麦克风不渲染，也不摆禁用占位。窄屏下工作空间位与专家标签有最大宽度，
// 完整文字在 `title` 里。
import { type ComponentProps, type RefObject, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "../../components/icon.js";
import type { ExpertView } from "../../lib/api.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/index.js";
import { CapabilityPopover, type SkillSwitches } from "./capability-popover.js";
import { ExpertPicker, useExpertDialog } from "./expert-picker.js";
import { PermissionTier } from "./permission-tier.js";
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

/**
 * 专家（experts「输入框的专家选择」）：`selected` 为当前专家 id，null 即没有专家、不渲染标签；`onChoose` 在欢迎态
 * 只改页面状态，会话中恰一次 `PUT …/capabilities`；`pending` 即该 `PUT` 在途或会话还没解析出来（`选择专家…` 与
 * `移除专家` 禁用）。
 * `experts` 是会话页的专家清单（标签名称与对话框列表的来源），`refresh` 在对话框每次打开时重取它。
 */
export type ExpertChoice = {
  experts: readonly ExpertView[] | null;
  onChoose(expertId: string | null): void;
  pending: boolean;
  refresh(): Promise<boolean>;
  selected: string | null;
};

type CapabilityBarProps = {
  /** 欢迎态的空间选择；`onSelect` 只改会话页的内存状态。 */
  choice: WorkspaceChoice;
  /** 输入框锁定：选择器按钮随之禁用。 */
  disabled: boolean;
  expert: ExpertChoice;
  /** 输入框元素：「+」菜单点选后把焦点交给它。 */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * 权限档位控件的 props；输入框选项未取得（或已选会话还没解析出来）时不传，控件不渲染、不摆占位。
   * `scope` 是它的 `key`：换会话即重挂，在途禁用与打开的确认框不带到另一个会话。不随 `disabled` 禁用。
   */
  permission?: ComponentProps<typeof PermissionTier> & { scope: string };
  /** 「+」菜单的目录、开合与可用条件（与斜杠候选同出 `useSlashMenu`，共用一份目录）。 */
  plus: PlusMenu;
  /**
   * 已选会话绑定的工作空间：`id` 为 null 即未绑定，undefined 表示会话还没解析出来；`workspace` 是它在
   * 已读取列表里的那一项（读取中、读取失败或空间已删时为 undefined）；`temporary` 即会话的
   * `temporaryWorkspace`（临时空间不在列表里，标签不靠列表判定）。欢迎态不传。
   */
  session?: { id: string | null | undefined; workspace: Workspace | undefined; temporary: boolean };
  /** `能力` 弹层（技能开关）；按钮恒在，不随 `disabled` 禁用。 */
  skills: SkillSwitches;
  /**
   * 「+」菜单的 `上传文件` 项：`open` 打开文件选择框；`disabled` 时不可选，`reason` 非 null 则跟在后面。
   * 不传（欢迎态）就没有这一项。
   */
  upload?: { disabled: boolean; reason: string | null; open(): void } | undefined;
};

export function CapabilityBar({
  choice,
  disabled,
  expert,
  inputRef,
  permission,
  plus,
  session,
  skills,
  upload,
}: CapabilityBarProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialog = useExpertDialog(expert.refresh);
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1 narrow:basis-auto"
      data-slot="composer-capabilities"
    >
      <CommandMenu
        expertDisabled={expert.pending}
        inputRef={inputRef}
        onPickExpert={dialog.show}
        plus={plus}
        triggerRef={triggerRef}
        upload={upload}
      />
      {expert.selected === null ? null : <ExpertLabel {...expert} selected={expert.selected} />}
      {session === undefined ? (
        <WorkspacePicker {...choice} disabled={disabled} />
      ) : (
        <WorkspaceLabel {...session} />
      )}
      {permission === undefined ? null : (
        <PermissionTier
          key={permission.scope}
          mode={permission.mode}
          modes={permission.modes}
          onChange={permission.onChange}
        />
      )}
      <CapabilityPopover {...skills} />
      <ExpertPicker
        experts={expert.experts}
        onChoose={expert.onChoose}
        onClose={dialog.close}
        restoreFocus={() => triggerRef.current?.focus()}
        status={dialog.status}
      />
    </div>
  );
}

/**
 * `专家 · <名称>` 标签与清除按钮 `移除专家`：名称取自专家清单，id 尚不在清单里（读取中、失败或已不可见）时只
 * 显示 `专家`，清除照常。
 */
function ExpertLabel({
  experts,
  onChoose,
  pending,
  selected,
}: ExpertChoice & { selected: string }) {
  const name = experts?.find((item) => item.id === selected)?.name;
  const text = name === undefined ? "专家" : `专家 · ${name}`;
  return (
    <span
      className="flex min-w-0 flex-none items-center gap-0.5 rounded-md bg-(--wb-brand-primary-subtle) pl-2 text-[0.8rem] text-(--wb-brand-primary-deep) narrow:max-w-40 narrow:flex-initial"
      data-slot="composer-expert"
      title={text}
    >
      <span className="min-w-0 truncate">{text}</span>
      <Button
        aria-label="移除专家"
        className="flex-none text-(--wb-brand-primary-deep)"
        disabled={pending}
        onClick={() => onChoose(null)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Icon name="x" size={12} />
      </Button>
    </span>
  );
}

const MENU_NOTE = "m-0 px-1.5 py-1 text-sm text-muted-foreground";

/**
 * `添加文件或命令` 按钮与菜单：按目录顺序列出命令与技能（名称、项目标记、描述）；目录未持有（拉取中或失败）时
 * 只有 `暂无可用项`，目录到达后列表就地替换它。点选把草稿写成 `/<name> `，菜单关闭后焦点交给输入框而不是
 * 回到按钮；Esc 等其它关闭方式仍按菜单默认把焦点还给按钮。草稿非空白时菜单照常打开，命令条目不可选，
 * 列表前有一行 `清空输入后可选择命令`（菜单的直接子元素）。给出 `upload` 时第一项是 `上传文件`：它不看草稿、
 * 不看目录（拉取中、失败、为空时都在），点选只打开文件选择框，不动草稿。其后是 `选择专家…`：同样不看草稿与
 * 目录，`PUT …/capabilities` 在途或会话还没解析出来时禁用；点选打开专家对话框，菜单关闭时焦点留给对话框。
 */
function CommandMenu({
  expertDisabled,
  inputRef,
  onPickExpert,
  plus,
  triggerRef,
  upload,
}: Pick<CapabilityBarProps, "inputRef" | "plus" | "upload"> & {
  expertDisabled: boolean;
  onPickExpert(): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  /** 关闭菜单的那次点选要把焦点交给谁：命令交给输入框，`选择专家…` 交给对话框；其余按菜单默认还给按钮。 */
  const picked = useRef<"input" | "dialog" | null>(null);
  return (
    <DropdownMenu onOpenChange={plus.onOpenChange} open={plus.open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="添加文件或命令"
          className="flex-none text-muted-foreground"
          disabled={plus.disabled}
          ref={triggerRef}
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
          const target = picked.current;
          if (target === null) return;
          picked.current = null;
          event.preventDefault();
          if (target === "input") inputRef.current?.focus();
        }}
        side="top"
      >
        {upload === undefined ? null : (
          <DropdownMenuItem
            className="flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-5"
            disabled={upload.disabled}
            onSelect={upload.open}
          >
            <span className="font-medium">上传文件</span>
            {upload.reason === null ? null : (
              <span className="text-muted-foreground">{upload.reason}</span>
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-[13px] leading-5 font-medium"
          disabled={expertDisabled}
          onSelect={() => {
            picked.current = "dialog";
            onPickExpert();
          }}
        >
          选择专家…
        </DropdownMenuItem>
        {plus.commands === undefined || plus.commands.length === 0 ? (
          <p className={MENU_NOTE}>暂无可用项</p>
        ) : (
          <>
            {plus.locked ? <p className={MENU_NOTE}>清空输入后可选择命令</p> : null}
            {plus.commands.map((command) => {
              const tag = sourceTag(command);
              return (
                <DropdownMenuItem
                  className="flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-5 wrap-anywhere"
                  disabled={plus.locked}
                  key={command.name}
                  onSelect={() => {
                    picked.current = "input";
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
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 只读标签：会话开始后工作空间即锁定，这里不可操作、不发请求。会话尚未解析出来时不渲染。四种取值，
 * 临时空间的判定在最前：它有 `workspaceId` 却不在列表里，按列表判会读成 `已绑定空间`。
 */
function WorkspaceLabel({ id, temporary, workspace }: NonNullable<CapabilityBarProps["session"]>) {
  if (id === undefined) return null;
  const name = temporary ? "临时空间" : id === null ? "未绑定" : (workspace?.name ?? "已绑定空间");
  const text = `${PREFIX} ${name}`;
  return (
    <p
      className="m-0 flex min-w-0 items-center gap-1 px-2.5 text-[0.8rem] text-muted-foreground narrow:max-w-40"
      data-slot="composer-workspace"
      title={text}
    >
      <Icon name="folder" size={14} />
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

/**
 * `任务启动于 …` 按钮与空间选择弹层；输入框锁定时按钮禁用，已打开的弹层关闭且解锁后不重开。窄屏的最大宽度
 * 取代了 `max-w-full`，按钮靠 `narrow:shrink` 仍随外层收窄（拷入层的按钮默认不收缩），不越出左组。
 */
function WorkspacePicker({ disabled, ...choice }: WorkspaceChoice & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  // 渲染期间复位（与 slash-menu.tsx 同一做法）：锁定的那次渲染就不再带着打开的弹层。
  if (disabled && open) setOpen(false);
  const text = `${PREFIX} ${choice.workspace?.name ?? UNSELECTED}`;
  return (
    <div className="flex min-w-0 items-center" data-slot="composer-workspace">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="max-w-full min-w-0 font-normal text-muted-foreground narrow:max-w-40 narrow:shrink"
            disabled={disabled}
            size="sm"
            title={text}
            type="button"
            variant="ghost"
          >
            <Icon name="folder" size={14} />
            <span className="min-w-0 truncate">{text}</span>
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
