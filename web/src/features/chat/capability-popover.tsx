// 能力行的 `能力` 按钮与弹层（skill-switches「输入框「能力」弹层」；s1d-experts-skills design D9、tasks.md 10.2）：
// 列出本会话可用技能（与「+」菜单同一份命令目录的 `skill:` 条目，按目录次序，项目技能带标记），每项一个开关
// （开 = 未停用），底部注明 `改动从下一条消息起生效`。欢迎态的停用集合是页面选择或账号缺省，会话中是会话能力。
// 按钮不随输入框锁定禁用（回合进行中也能改，从下一条消息起生效）。技能段之后是 `连接器` 段（s1d-connectors
// design D10、tasks.md 7.3）：启用的连接器各一个开关，欢迎态的停用集合是页面选择或账号缺省，会话中是会话能力。
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Icon } from "../../components/icon.js";
import type { Command } from "../../lib/api-commands.js";
import { sourceTag } from "./slash-menu.js";
import { skillName } from "./slash-menu-state.js";
import type {
  ConnectorDefaults,
  ConnectorList,
  SessionCapabilityState,
  SkillDefaults,
} from "./use-session-capabilities.js";
import type { WelcomeOptions } from "./welcome-options.js";

const LABEL = "能力";
const LOADING = "正在读取技能…";
const SESSION_FAILED = "技能读取失败，重新选中该会话可重试";
const WELCOME_FAILED = "技能读取失败，关闭后重新打开可重试";
const EMPTY = "暂无可用技能";
const FOOTER = "改动从下一条消息起生效";
const CONNECTORS = "连接器";
const CONNECTOR_LOADING = "正在读取连接器…";
const CONNECTOR_FAILED = "连接器读取失败，关闭后重新打开可重试";
const CONNECTOR_EMPTY = "暂无可用连接器";

/** 读取状态的一行说明：在途时为说明，失败时为 alert。 */
type Notice = { text: string; alert: boolean };

/** `连接器` 段的 props。 */
type ConnectorSwitches = {
  /** 启用的连接器名称（按清单次序）；清单未取得（读取中、失败）时为 null：不列行，也不显示空态。 */
  names: readonly string[] | null;
  /** 当前停用连接器集合：名称在其中的开关为关。 */
  disabled: readonly string[];
  /** 连接器读取（欢迎态：清单与账号缺省；会话中：清单）的状态；都已取得时为 null。 */
  notice: Notice | null;
  /** 开关可切换；否则一律 `aria-disabled="true"`，`onToggle` 自己什么也不做（理由同技能段）。 */
  toggleable: boolean;
  onToggle(name: string, enabled: boolean): void;
};

/** 弹层的 props（`conversation-view.tsx` 经 `skillSwitches` 组装）。 */
export type SkillSwitches = {
  /** 目录的 `skill:` 条目（含停用的）；目录未持有（读取中、失败、会话还没解析出来）时为 undefined。 */
  commands: readonly Command[] | undefined;
  /** 当前停用集合：名称在其中的开关为关。 */
  disabled: readonly string[];
  /** 停用集合的读取状态：在途时一行说明，失败时一条 alert；已取得时为 null。 */
  notice: Notice | null;
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
  /** 技能段之后的 `连接器` 段。 */
  connectors: ConnectorSwitches;
};

type SkillSources = {
  capabilities: SessionCapabilityState;
  defaults: SkillDefaults;
  connectorList: ConnectorList;
  connectorDefaults: ConnectorDefaults;
  requestedSessionId: string | null;
  /** `useSlashMenu` 的弹层位：目录的技能条目与开合。 */
  skills: Pick<SkillSwitches, "commands" | "open" | "onOpenChange">;
  welcome: Pick<
    WelcomeOptions,
    "disabledConnectors" | "disabledSkills" | "toggleConnector" | "toggleSkill"
  >;
};

/** 连接器读取的说明：任一失败即 alert，否则任一未取得即读取中，都已取得时为 null。 */
function connectorNotice(statuses: readonly ConnectorList["status"][]): Notice | null {
  if (statuses.includes("failed")) return { text: CONNECTOR_FAILED, alert: true };
  return statuses.every((status) => status === "done")
    ? null
    : { text: CONNECTOR_LOADING, alert: false };
}

/**
 * 组装弹层的 props。欢迎态：停用集合 = 页面选择 ?? 账号缺省 ?? 空；打开弹层即 `defaults.load()`（只在从未取得
 * 时真的发请求）；账号缺省未取得（读取中或失败）时不可切换。会话中：停用集合为会话能力（切技能在途时为切换
 * 后的集合）；能力 `GET` 在途或失败、任一 `PUT` 在途时不可切换。会话还没解析出来时目录与能力都没有，技能段
 * 只有 `暂无可用技能`。
 *
 * 连接器段同一规则：两个分支打开弹层都 `connectorList.load()`（会话还没解析出来时也取，编排方裁定），欢迎态另
 * `connectorDefaults.load()`——都只重取失败或从未取得的那一个。欢迎态清单与账号缺省都取得才可切换；会话中清单
 * 与会话能力都取得、且没有 `PUT` 在途才可切换，能力 `GET` 在途或失败时不另加提示（技能段已有一条）。
 */
export function skillSwitches({
  capabilities,
  connectorDefaults,
  connectorList,
  defaults,
  requestedSessionId,
  skills,
  welcome,
}: SkillSources): SkillSwitches {
  const listed = connectorList.value;
  if (!requestedSessionId) {
    const connectorBase = connectorDefaults.value;
    const connectorsReady = listed !== null && connectorBase !== null;
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
        if (!open) return;
        defaults.load();
        connectorList.load();
        connectorDefaults.load();
      },
      onToggle: (name, enabled) => {
        if (base !== null) welcome.toggleSkill(name, enabled, base);
      },
      toggleable: base !== null,
      connectors: {
        names: listed,
        disabled: welcome.disabledConnectors ?? connectorBase ?? [],
        notice: connectorNotice([connectorList.status, connectorDefaults.status]),
        onToggle: (name, enabled) => {
          if (connectorsReady) welcome.toggleConnector(name, enabled, connectorBase);
        },
        toggleable: connectorsReady,
      },
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
    onOpenChange: (open) => {
      skills.onOpenChange(open);
      if (open) connectorList.load();
    },
    onToggle: capabilities.toggleSkill,
    toggleable: capabilities.read === "done" && !capabilities.pending,
    connectors: {
      names: listed,
      disabled: capabilities.disabledConnectors ?? [],
      notice: connectorNotice([connectorList.status]),
      onToggle: capabilities.toggleConnector,
      toggleable: listed !== null && capabilities.capabilities !== null && !capabilities.pending,
    },
  };
}

const NOTE = "m-0 px-1.5 py-1 text-xs wrap-anywhere";
const EMPTY_NOTE = `${NOTE} text-sm text-muted-foreground`;
const LIST = "m-0 flex max-h-60 list-none flex-col overflow-y-auto p-0";

export function CapabilityPopover(props: SkillSwitches) {
  const { commands, connectors, notice, onOpenChange, open } = props;
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
        <ReadNotice notice={notice} />
        {commands === undefined || commands.length === 0 ? (
          <p className={EMPTY_NOTE}>{EMPTY}</p>
        ) : (
          // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
          <ul className={LIST} role="list">
            {commands.map((command) => {
              const name = skillName(command) ?? command.name;
              return (
                <SwitchRow
                  checked={!props.disabled.includes(name)}
                  key={command.name}
                  label={command.label}
                  onToggle={(enabled) => props.onToggle(name, enabled)}
                  tag={sourceTag(command)}
                  toggleable={props.toggleable}
                />
              );
            })}
          </ul>
        )}
        <ConnectorSection {...connectors} />
        <p className={`${NOTE} border-t pt-1.5 text-muted-foreground`}>{FOOTER}</p>
      </PopoverContent>
    </Popover>
  );
}

function ReadNotice({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <p
      className={`${NOTE} ${notice.alert ? "text-(--wb-status-error-text)" : "text-muted-foreground"}`}
      role={notice.alert ? "alert" : undefined}
    >
      {notice.text}
    </p>
  );
}

/** `连接器` 段（`fieldset`，即名称为段标题的 `role="group"`）：读取说明、空态或启用的连接器各一个开关。 */
function ConnectorSection({ disabled, names, notice, onToggle, toggleable }: ConnectorSwitches) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="w-full border-t px-1.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
        {CONNECTORS}
      </legend>
      <ReadNotice notice={notice} />
      {names === null ? null : names.length === 0 ? (
        <p className={EMPTY_NOTE}>{CONNECTOR_EMPTY}</p>
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: 理由同技能段。
        <ul className={LIST} role="list">
          {names.map((name) => (
            <SwitchRow
              checked={!disabled.includes(name)}
              key={name}
              label={name}
              onToggle={(enabled) => onToggle(name, enabled)}
              tag={null}
              toggleable={toggleable}
            />
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** 一项：名称、可选标记与开关（accessible name 为 `label`，状态由 `aria-checked` 表示）。 */
function SwitchRow({
  checked,
  label,
  onToggle,
  tag,
  toggleable,
}: {
  checked: boolean;
  label: string;
  onToggle(enabled: boolean): void;
  tag: string | null;
  toggleable: boolean;
}) {
  return (
    <li className="flex items-center gap-2 px-1.5 py-1 text-[13px] leading-5">
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 wrap-anywhere">
        <span className="font-medium">{label}</span>
        {tag === null ? null : (
          <span className="rounded bg-(--wb-brand-primary-subtle) px-1.5 text-xs text-(--wb-brand-primary-deep)">
            {tag}
          </span>
        )}
      </span>
      <Switch
        aria-disabled={toggleable ? undefined : true}
        aria-label={label}
        checked={checked}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onCheckedChange={onToggle}
      />
    </li>
  );
}
