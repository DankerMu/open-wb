/* Message action rows (S1e 4.6 / parent design D8; S1c 7.3a/7.3b). Assistant: 复制 when the text is non-empty, adapted from resource/workbuddy-live-demo.html:2394-2395 and :1188-1191 (copyText) without the execCommand fallback, then 重新生成 on the regenerate-eligible last message (demo:2396, toast demo:2485). User: a single 从此处分叉 (no toast). */
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

/** The user message row: one 从此处分叉; `onFork` settles every branch itself and never rejects. */
export function ForkAction({ disabled, onFork }: { disabled: boolean; onFork: () => void }) {
  return (
    <div className="chat-msg-actions">
      <Button
        aria-label="从此处分叉"
        className="chat-msg-action"
        disabled={disabled}
        onClick={onFork}
        size="icon"
        title="从此处分叉"
        type="button"
        variant="ghost"
      >
        <Icon name="git-branch" size={12} />
      </Button>
    </div>
  );
}
