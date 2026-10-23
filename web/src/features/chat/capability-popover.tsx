// 能力行的 `能力` 按钮与弹层（skill-switches「输入框「能力」弹层」；s1d-experts-skills design D9、tasks.md 10.2）：
// 列出本会话可用技能（与「+」菜单同一份命令目录的 `skill:` 条目，按目录次序，项目技能带标记），每项一个开关
// （开 = 未停用），底部注明 `改动从下一条消息起生效`。欢迎态的停用集合是页面选择或账号缺省，会话中是会话能力。
// 按钮不随输入框锁定禁用（回合进行中也能改，从下一条消息起生效）。
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Icon } from "../../components/icon.js";
import type { Command } from "../../lib/api-commands.js";
import { sourceTag } from "./slash-menu.js";
import { skillName } from "./slash-menu-state.js";
import type { SessionCapabilityState, SkillDefaults } from "./use-session-capabilities.js";
import type { WelcomeOptions } from "./welcome-options.js";

const LABEL = "能力";
const LOADING = "正在读取技能…";
const SESSION_FAILED = "技能读取失败，重新选中该会话可重试";
const WELCOME_FAILED = "技能读取失败，关闭后重新打开可重试";
const EMPTY = "暂无可用技能";
const FOOTER = "改动从下一条消息起生效";

/** 弹层的 props（`conversation-view.tsx` 经 `skillSwitches` 组装）。 */
export type SkillSwitches = {
  /** 目录的 `skill:` 条目（含停用的）；目录未持有（读取中、失败、会话还没解析出来）时为 undefined。 */
  commands: readonly Command[] | undefined;
  /** 当前停用集合：名称在其中的开关为关。 */
  disabled: readonly string[];
  /** 停用集合的读取状态：在途时一行说明，失败时一条 alert；已取得时为 null。 */
  notice: { text: string; alert: boolean } | null;
  /**
   * 开关可切换；否则一律 `aria-disabled="true"`（不用 `disabled`：焦点留在按下的开关上）。`aria-disabled` 的开关
   * 照样分派点击，所以不可切换时 `onToggle` 自己什么也不做（会话中是 hook 的在途 / 未取得守卫，欢迎态是账号
   * 缺省未取得的守卫）。
   */
  toggleable: boolean;
  /** 切一个技能（`name` 不带 `skill:`；`enabled` 为开关的新值）；不可切换时什么也不做。 */
  onToggle(name: string, enabled: boolean): void;
  open: boolean;
  onOpenChange(open: boolean): void;
};

type SkillSources = {
  capabilities: SessionCapabilityState;
  defaults: SkillDefaults;
  requestedSessionId: string | null;
  /** `useSlashMenu` 的弹层位：目录的技能条目与开合。 */
  skills: Pick<SkillSwitches, "commands" | "open" | "onOpenChange">;
  welcome: Pick<WelcomeOptions, "disabledSkills" | "toggleSkill">;
};

/**
 * 组装弹层的 props。欢迎态：停用集合 = 页面选择 ?? 账号缺省 ?? 空；打开弹层即 `defaults.load()`（只在从未取得
 * 时真的发请求）；账号缺省未取得（读取中或失败）时不可切换。会话中：停用集合为会话能力（切技能在途时为切换
 * 后的集合）；能力 `GET` 在途或失败、任一 `PUT` 在途时不可切换。会话还没解析出来时目录与能力都没有，弹层只有
 * `暂无可用技能`，不发请求。
 */
export function skillSwitches({
  capabilities,
  defaults,
  requestedSessionId,
  skills,
  welcome,
}: SkillSources): SkillSwitches {
  if (!requestedSessionId) {
    const base = defaults.disabledSkills;
    const notice =
      base !== null
        ? null
        : defaults.status === "failed"
          ? { text: WELCOME_FAILED, alert: true }
          : { text: LOADING, alert: false };
    return {
      ...skills,
      disabled: welcome.disabledSkills ?? base ?? [],
      notice,
      onOpenChange: (open) => {
        skills.onOpenChange(open);
        if (open) defaults.load();
      },
      onToggle: (name, enabled) => {
        if (base !== null) welcome.toggleSkill(name, enabled, base);
      },
      toggleable: base !== null,
    };
  }
  const notice = {
    done: null,
    failed: { text: SESSION_FAILED, alert: true },
    loading: { text: LOADING, alert: false },
  }[capabilities.read];
  return {
    ...skills,
    disabled: capabilities.disabledSkills ?? [],
    notice,
    onToggle: capabilities.toggleSkill,
    toggleable: capabilities.read === "done" && !capabilities.pending,
  };
}

const NOTE = "m-0 px-1.5 py-1 text-xs wrap-anywhere";

export function CapabilityPopover(props: SkillSwitches) {
  const { commands, notice, onOpenChange, open } = props;
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={LABEL}
          className="flex-none font-normal text-muted-foreground"
          size="sm"
          type="button"
          variant="ghost"
        >
          <Icon name="zap" size={14} />
          {LABEL}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={LABEL}
        className="gap-1 p-2"
        collisionPadding={8}
        side="top"
      >
        {notice === null ? null : (
          <p
            className={`${NOTE} ${notice.alert ? "text-(--wb-status-error-text)" : "text-muted-foreground"}`}
            role={notice.alert ? "alert" : undefined}
          >
            {notice.text}
          </p>
        )}
        {commands === undefined || commands.length === 0 ? (
          <p className={`${NOTE} text-sm text-muted-foreground`}>{EMPTY}</p>
        ) : (
          // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
          <ul className="m-0 flex max-h-60 list-none flex-col overflow-y-auto p-0" role="list">
            {commands.map((command) => (
              <SkillRow command={command} key={command.name} {...props} />
            ))}
          </ul>
        )}
        <p className={`${NOTE} border-t pt-1.5 text-muted-foreground`}>{FOOTER}</p>
      </PopoverContent>
    </Popover>
  );
}

/** 一项：名称、项目标记与开关（accessible name 为 `command.label`，状态由 `aria-checked` 表示）。 */
function SkillRow({
  command,
  disabled,
  onToggle,
  toggleable,
}: SkillSwitches & { command: Command }) {
  const name = skillName(command) ?? command.name;
  const tag = sourceTag(command);
  return (
    <li className="flex items-center gap-2 px-1.5 py-1 text-[13px] leading-5">
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 wrap-anywhere">
        <span className="font-medium">{command.label}</span>
        {tag === null ? null : (
          <span className="rounded bg-(--wb-brand-primary-subtle) px-1.5 text-xs text-(--wb-brand-primary-deep)">
            {tag}
          </span>
        )}
      </span>
      <Switch
        aria-disabled={toggleable ? undefined : true}
        aria-label={command.label}
        checked={!disabled.includes(name)}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onCheckedChange={(enabled) => onToggle(name, enabled)}
      />
    </li>
  );
}
