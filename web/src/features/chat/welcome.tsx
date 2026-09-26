/* Welcome state adapted from resource/workbuddy-live-demo.html:2537-2567; scene pills, chip expand toggle and 查看更多 are not rendered (S1c / undelivered /center). */
import { useState } from "react";
import { Icon } from "../../ui/index.js";
import { playbookWindow, WELCOME_QUICK_PROMPTS } from "./welcome-content.js";

type WelcomeProps = {
  /** Composer lock: while a send is pending, picking a prompt must not overwrite the draft. */
  disabled: boolean;
  onPick(prompt: string): void;
};

/** Hero and quick-prompt chips; sits in the transcript slot above the composer. */
export function WelcomeIntro({ disabled, onPick }: WelcomeProps) {
  return (
    <div className="chat-welcome-intro">
      <h1 className="chat-hero">WorkBuddy，我帮你</h1>
      <fieldset aria-label="快捷任务" className="chat-quick-row">
        {WELCOME_QUICK_PROMPTS.map((item) => (
          <button
            className="chat-quick-chip"
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

/** Rotating playbook cards and the AI disclaimer; rendered after the composer. */
export function WelcomePlaybooks({ disabled, onPick }: WelcomeProps) {
  const [start, setStart] = useState(0);
  return (
    <div className="chat-welcome-foot">
      <section aria-label="最佳实践案例" className="chat-playbooks">
        <div className="chat-playbooks-head">
          <Icon name="sparkles" size={12} />
          <p>不知道做什么，试试最佳实践案例</p>
          <button
            className="chat-playbooks-refresh"
            disabled={disabled}
            onClick={() => setStart((current) => current + 1)}
            type="button"
          >
            换一批
          </button>
        </div>
        <ul className="chat-playbooks-row">
          {playbookWindow(start).map((item) => (
            <li key={item.title}>
              <button
                className="chat-playbook-card"
                disabled={disabled}
                onClick={() => onPick(item.prompt)}
                type="button"
              >
                <span className="chat-playbook-title">
                  <Icon name={item.icon} size={12} />
                  <span className="chat-playbook-title-text">{item.title}</span>
                </span>
                <span className="chat-playbook-desc">{item.desc}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="chat-disclaimer">内容由 AI 生成，请核实重要信息</p>
    </div>
  );
}
