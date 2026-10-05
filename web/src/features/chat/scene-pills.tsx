/* Scene pills adapted from resource/workbuddy-live-demo.html:345-351 (look), 2540-2542 (markup). */
import { Icon } from "../../ui/index.js";
import { WELCOME_SCENES, type WelcomeScene } from "./welcome-content.js";

type ScenePillsProps = {
  /** Composer lock, as for the quick chips. */
  disabled: boolean;
  onSelect(scene: WelcomeScene["value"]): void;
  scene: WelcomeScene["value"];
};

/**
 * `场景` group: one pressed pill. A scene is only a suggestion group of the welcome state, so
 * picking another one swaps the quick-prompt list and nothing else: no toast, no announcement.
 * The demo's 64px bottom margin is 12px here: the disclaimer has to stay inside the first viewport.
 */
export function ScenePills({ disabled, onSelect, scene }: ScenePillsProps) {
  return (
    <fieldset
      aria-label="场景"
      className="m-0 mb-3 inline-flex h-9 min-w-0 flex-none items-center gap-0.5 rounded-full border-0 bg-(--wb-bg-tertiary) p-0.5"
    >
      {WELCOME_SCENES.map((item) => (
        <button
          aria-pressed={item.value === scene}
          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-full px-3 text-[13px] whitespace-nowrap text-muted-foreground enabled:hover:bg-card enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-(--wb-bg-pill-active) aria-pressed:font-semibold aria-pressed:text-(--wb-pill-active-fg) aria-pressed:enabled:hover:bg-(--wb-bg-pill-active-hover) aria-pressed:enabled:hover:text-(--wb-pill-active-fg)"
          disabled={disabled}
          key={item.value}
          onClick={() => {
            if (item.value !== scene) onSelect(item.value);
          }}
          type="button"
        >
          <Icon name={item.icon} size={16} />
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
