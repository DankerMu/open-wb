// 模型与推理强度控件（model-selection「模型与推理强度控件」）：能力行右组的前两项。这里只管显示名、
// 能力标签、欢迎态换模型时强度的重算与提交在途的禁用；已选会话的显示值恒为传入的会话视图。
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ComposerOptions } from "../../lib/composer-contract.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { Icon } from "../../ui/index.js";
import type { WelcomeOptions } from "./welcome-options.js";

type Effort = NonNullable<ChatSession["reasoningEffort"]>;
type Model = ComposerOptions["models"][number];
type Shown = Pick<ChatSession, "modelId" | "reasoningEffort">;

const EFFORTS: Record<Effort, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

/** 欢迎态显示的模型与强度：选过的值，没选过回落到缺省；模型不支持推理（或不在白名单里）时没有强度。 */
function welcomeShown(
  { defaults, models }: ComposerOptions,
  picked: WelcomeOptions["picked"],
): Shown {
  const modelId = picked.modelId ?? defaults.modelId;
  const reasoning = models.find((model) => model.id === modelId)?.reasoning ?? false;
  return {
    modelId,
    reasoningEffort: reasoning ? (picked.reasoningEffort ?? defaults.reasoningEffort) : null,
  };
}

/**
 * 欢迎态换到 `model` 之后的强度：此刻显示的强度在它的可选强度里则保留，否则取它的缺省；它不支持推理
 * （或没有缺省强度）时为 undefined，即从创建请求里去掉该键。
 */
function carried(model: Model, effort: Effort | null) {
  if (!model.reasoning) return undefined;
  return effort !== null && model.efforts.includes(effort)
    ? effort
    : (model.defaultEffort ?? undefined);
}

type ModelPickerProps = {
  /** 输入框选项：模型白名单与缺省值。 */
  options: ComposerOptions;
  /**
   * 已选会话：视图里的模型与强度，以及提交一次设置（恰一次 PATCH，返回的 promise 在任何结果下都落定）。
   * null 即欢迎态。
   */
  session:
    | (Shown & { patch(patch: { modelId: string } | { reasoningEffort: Effort }): Promise<void> })
    | null;
  /** 欢迎态选过的值与写入它的函数（页面内存，不发请求）。 */
  welcome: Pick<WelcomeOptions, "picked" | "pick">;
};

/**
 * 模型按钮与推理强度按钮，各带一个单选菜单。选中当前值只关菜单。已选会话：换模型只提交 `{modelId}`、
 * 换强度只提交 `{reasoningEffort}`，强度随模型怎么变由服务端决定，按钮只显示会话视图、不做乐观更新；
 * 一次提交在途时两个按钮都禁用。欢迎态：选择同步写进页面内存，换模型时一并写入重算后的强度（所见即
 * 所发）。两个按钮都不随输入框锁定禁用（生成中可改）。强度按钮只在当前模型支持推理且有强度时渲染；模型
 * 不在白名单里时按钮退为 id 原文、没有强度按钮。在途是组件内状态：调用方以会话 id 为 `key`，换会话即复位。
 */
export function ModelPicker({ options, session, welcome }: ModelPickerProps) {
  const [pending, setPending] = useState(false);
  const modelRef = useRef<HTMLButtonElement>(null);
  const effortRef = useRef<HTMLButtonElement>(null);
  /** 发起在途提交的那个按钮：落定后焦点还给它（强度按钮随新模型消失时还给模型按钮）。 */
  const origin = useRef(modelRef);
  const settled = useRef(true);

  // 在途时按钮禁用，菜单归还的焦点落不到它上面：落定的那次提交里补上，不让焦点留在 body。
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!pending && !settled.current && (active === document.body || active === null)) {
      (origin.current.current ?? modelRef.current)?.focus();
    }
    settled.current = !pending;
  }, [pending]);

  const shown = session ?? welcomeShown(options, welcome.picked);
  const model = options.models.find((item) => item.id === shown.modelId);
  const name = model?.name ?? shown.modelId;
  const effort = model?.reasoning ? shown.reasoningEffort : null;

  const submit = (from: RefObject<HTMLButtonElement | null>, settling: Promise<void>) => {
    origin.current = from;
    setPending(true);
    void settling.then(() => setPending(false));
  };
  const chooseModel = (modelId: string) => {
    const next = options.models.find((item) => item.id === modelId);
    if (next === undefined || modelId === shown.modelId) return;
    if (session === null) {
      return welcome.pick({ modelId, reasoningEffort: carried(next, effort) });
    }
    submit(modelRef, session.patch({ modelId }));
  };
  const chooseEffort = (reasoningEffort: Effort) => {
    if (reasoningEffort === effort) return;
    if (session === null) return welcome.pick({ reasoningEffort });
    submit(effortRef, session.patch({ reasoningEffort }));
  };

  return (
    <>
      <Choice
        buttonRef={modelRef}
        capped
        disabled={pending}
        label={`模型：${name}`}
        onChange={chooseModel}
        text={name}
        value={shown.modelId}
      >
        {options.models.map((item) => (
          <DropdownMenuRadioItem
            className="flex-wrap gap-x-2 gap-y-0.5 text-[13px] leading-5 wrap-anywhere"
            key={item.id}
            value={item.id}
          >
            <span className="font-medium">{item.name}</span>
            {item.reasoning ? <span className={TAG}>推理</span> : null}
            {item.vision ? <span className={TAG}>看图</span> : null}
          </DropdownMenuRadioItem>
        ))}
      </Choice>
      {model === undefined || effort === null ? null : (
        <Choice
          buttonRef={effortRef}
          disabled={pending}
          label={`推理强度：${EFFORTS[effort]}`}
          onChange={(value) => chooseEffort(value as Effort)}
          text={EFFORTS[effort]}
          value={effort}
        >
          {model.efforts.map((item) => (
            <DropdownMenuRadioItem className="text-[13px] leading-5" key={item} value={item}>
              {EFFORTS[item]}
            </DropdownMenuRadioItem>
          ))}
        </Choice>
      )}
    </>
  );
}

const TAG = "rounded bg-(--wb-brand-primary-subtle) px-1.5 text-xs text-(--wb-brand-primary-deep)";

type ChoiceProps = {
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** 按钮有最大宽度、文字截断，完整文字在 `title` 里（模型名可以很长；右组不收缩，不设上限会把发送键挤出去）。 */
  capped?: boolean;
  /** 菜单里的单选项。 */
  children: ReactNode;
  disabled: boolean;
  /** 按钮的可访问名。 */
  label: string;
  onChange(value: string): void;
  text: string;
  /** 当前值；没有与它相同的单选项时菜单里没有选中项。 */
  value: string;
};

/** 一个按钮加它的单选菜单；选中任何一项（含当前值）都回调，由调用方判定是否提交。 */
function Choice(props: ChoiceProps) {
  return (
    <DropdownMenu>
      {/* 禁用写在 Trigger 上（它转给按钮）：菜单在 pointerdown 就打开，只禁用按钮挡不住。 */}
      <DropdownMenuTrigger asChild disabled={props.disabled}>
        <Button
          aria-label={props.label}
          className={`font-normal text-muted-foreground ${props.capped ? "max-w-40 min-w-0" : "flex-none"}`}
          ref={props.buttonRef}
          size="sm"
          title={props.capped ? props.text : undefined}
          type="button"
          variant="ghost"
        >
          <span className="min-w-0 truncate">{props.text}</span>
          <Icon name="chevron-down" size={12} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-w-(--radix-dropdown-menu-content-available-width)"
        collisionPadding={8}
        side="top"
      >
        <DropdownMenuRadioGroup onValueChange={props.onChange} value={props.value}>
          {props.children}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
