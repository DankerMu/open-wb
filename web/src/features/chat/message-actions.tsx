/* Assistant message action row (S1e 4.6 / parent design D8; S1c 7.3a): 复制 when the text is non-empty, adapted from resource/workbuddy-live-demo.html:2394-2395 and :1188-1191 (copyText) without the execCommand fallback, then 重新生成 on the regenerate-eligible last message (demo:2396, toast demo:2485). */
import { Button, Icon, useToast } from "../../ui/index.js";

/** `onRegenerate` resolves `true` on a still-owned 202 (toast) and never rejects. */
type Regenerate = { disabled: boolean; onRegenerate: () => Promise<boolean> };

export function MessageActions({
  regenerate,
  text,
}: {
  regenerate?: Regenerate | undefined;
  text: string;
}) {
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
      {text === "" ? null : (
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
      )}
      {regenerate ? (
        <Button
          aria-label="重新生成"
          className="chat-msg-action"
          disabled={regenerate.disabled}
          onClick={() =>
            void regenerate.onRegenerate().then((ok) => {
              if (ok) {
                toast.show({ type: "info", message: "正在重新生成…" });
              }
            })
          }
          size="icon"
          title="重新生成"
          type="button"
          variant="ghost"
        >
          <Icon name="refresh-cw" size={12} />
        </Button>
      ) : null}
    </div>
  );
}
