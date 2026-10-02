/* Scene pills adapted from resource/workbuddy-live-demo.html:2540-2542 (markup), 2652-2663 (switch toast). */
import { Icon, useToast } from "../../ui/index.js";
import { WELCOME_SCENES, type WelcomeScene } from "./welcome-content.js";

type ScenePillsProps = {
  /** Composer lock, as for the quick chips. */
  disabled: boolean;
  onSelect(scene: WelcomeScene["value"]): void;
  scene: WelcomeScene["value"];
};

/** `场景` group: one pressed pill; picking another scene swaps the quick-prompt list and toasts. */
export function ScenePills({ disabled, onSelect, scene }: ScenePillsProps) {
  const toast = useToast();
  return (
    <fieldset aria-label="场景" className="chat-scene-pills">
      {WELCOME_SCENES.map((item) => (
        <button
          aria-pressed={item.value === scene}
          className="chat-scene-pill"
          disabled={disabled}
          key={item.value}
          onClick={() => {
            if (item.value === scene) return;
            onSelect(item.value);
            toast.show({ type: "info", message: `已切换到「${item.label}」场景` });
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
