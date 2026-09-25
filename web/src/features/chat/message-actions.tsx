/* Assistant message action row (S1e 4.6 / parent design D8): a single 复制 button, adapted from resource/workbuddy-live-demo.html:2394-2395 and :1188-1191 (copyText), without the execCommand fallback. */
import { Button, Icon, useToast } from "../../ui/index.js";

export function MessageActions({ text }: { text: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ type: "success", message: "已复制到剪贴板" });
    } catch {
      toast.show({ type: "error", message: "复制失败" });
    }
  }
  return (
    <div className="chat-msg-actions">
      <Button
        aria-label="复制"
        className="chat-msg-action"
        onClick={() => void copy()}
        size="icon"
        title="复制"
        variant="ghost"
      >
        <Icon name="copy" size={12} />
      </Button>
    </div>
  );
}
