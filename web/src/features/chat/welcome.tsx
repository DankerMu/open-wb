/* Welcome state adapted from resource/workbuddy-live-demo.html:341-359 (.hero, .quick-row), 402-414 (.playbooks-*, .ai-disclaimer), 2537-2567 (markup); the chip expand toggle and 查看更多 are not rendered (undelivered /center). */
import { useState } from "react";
import { Icon } from "../../ui/index.js";
import { ScenePills } from "./scene-pills.js";
import { playbookWindow, WELCOME_SCENES, type WelcomeScene } from "./welcome-content.js";

type WelcomeProps = {
  /** Composer lock: while a send is pending, picking a prompt must not overwrite the draft. */
  disabled: boolean;
  onPick(prompt: string): void;
};

type WelcomeIntroProps = WelcomeProps & {
  onSelectScene(scene: WelcomeScene["value"]): void;
  scene: WelcomeScene["value"];
};

/**
 * Hero, scene pills and the selected scene's quick-prompt chips; sits above the composer.
 * ≤760px: one scrolling chip row instead of three wrapped ones keeps the disclaimer inside the
 * first viewport at 390x844. `overflow-x: auto` also clips the block axis, so the 4px padding
 * (cancelled by the negative margin) leaves room for the chips' focus ring.
 */
export function WelcomeIntro({ disabled, onPick, onSelectScene, scene }: WelcomeIntroProps) {
  const prompts = WELCOME_SCENES.find((item) => item.value === scene)?.prompts ?? [];
  return (
    <div className="flex flex-col items-center px-2">
      <h1 className="m-0 mb-4 text-center text-[30px] leading-[42px] font-semibold text-balance text-foreground">
        WorkBuddy，我帮你
      </h1>
      <ScenePills disabled={disabled} onSelect={onSelectScene} scene={scene} />
      <fieldset
        aria-label="快捷任务"
        className="m-0 flex max-w-3xl min-w-0 flex-wrap justify-center gap-2 border-0 p-0 narrow:-m-1 narrow:max-w-full narrow:flex-nowrap narrow:justify-start narrow:overflow-x-auto narrow:p-1 narrow:[scrollbar-width:none]"
      >
        {prompts.map((item) => (
          <button
            className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border border-(--wb-color-border-secondary) bg-card px-3 text-sm leading-[22px] whitespace-nowrap text-muted-foreground transition-[background-color,color] duration-150 enabled:hover:bg-(--wb-home-composer-chip-bg-hover) enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none narrow:flex-none"
            disabled={disabled}
            key={item.label}
            onClick={() => onPick(item.prompt)}
            type="button"
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/**
 * Rotating playbook cards and the AI disclaimer; rendered after the composer, flowing below it
 * instead of the demo's absolute bottom pinning. The bottom auto margin (with the intro's top one)
 * centers the column while keeping its top reachable when a short viewport makes it scroll.
 * ≥761px: one row per demo:408-409; no `overflow: hidden` on the row (it would clip the focus
 * ring), `flex: 1 1 0` + `min-width: 0` already keep it inside its box. ≤760px wraps, since the
 * demo's single row squeezes the cards to ~60px at 390.
 */
export function WelcomePlaybooks({ disabled, onPick }: WelcomeProps) {
  const [start, setStart] = useState(0);
  return (
    <div className="mx-auto mt-4 mb-auto box-border w-full max-w-3xl px-2 pb-3">
      <section aria-label="最佳实践案例" className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
          <Icon name="sparkles" size={12} />
          <p className="m-0 min-w-0">不知道做什么，试试最佳实践案例</p>
          <button
            className="ml-auto flex-none cursor-pointer rounded px-1 py-0.5 text-xs leading-[22px] text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onClick={() => setStart((current) => current + 1)}
            type="button"
          >
            换一批
          </button>
        </div>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-none drops the list semantics in Safari; the explicit role restores them. */}
        <ul className="m-0 flex list-none flex-nowrap gap-2.5 p-0 narrow:flex-wrap" role="list">
          {playbookWindow(start).map((item) => (
            <li className="max-w-55 min-w-0 flex-[1_1_0] narrow:basis-35" key={item.title}>
              <button
                className="box-border flex size-full cursor-pointer flex-col rounded-xl border border-border bg-secondary px-3.5 py-3 text-left text-foreground transition-[border-color,box-shadow] duration-150 enabled:hover:border-(--wb-text-tertiary) enabled:hover:shadow-(--wb-activity-card-shadow) disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
                disabled={disabled}
                onClick={() => onPick(item.prompt)}
                type="button"
              >
                {/* The title text is its own span: a bare text node in the flex title cannot
                    ellipsize, and the narrowest ≥761px card is ~75px. */}
                <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[12.5px] leading-[18px] font-semibold [&>svg]:flex-none [&>svg]:text-(--wb-brand-primary)">
                  <Icon name={item.icon} size={12} />
                  <span className="min-w-0 truncate">{item.title}</span>
                </span>
                <span className="mt-[3px] line-clamp-2 text-[11.5px] leading-[17px] text-muted-foreground">
                  {item.desc}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="m-0 mt-3 text-center text-[11px] text-muted-foreground">
        内容由 AI 生成，请核实重要信息
      </p>
    </div>
  );
}
