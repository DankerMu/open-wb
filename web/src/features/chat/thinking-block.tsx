// Deep-thinking fold adapted from resource/workbuddy-live-demo.html:2383-2386. Stateless: React
// writes `open` only when `running` changes, so a manual toggle survives every other re-render.
import { Icon } from "../../ui/index.js";

export function ThinkingBlock({ running, text }: { running: boolean; text: string }) {
  return (
    <details className="thinking-block" open={running}>
      <summary className="thinking-summary">
        <Icon name="chevron-right" size={14} />
        深度思考过程
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}
