// assistant-ui 运行时接入（design D1）：应用继续持有状态，运行时只读消息数组并转发三个回调。
import { type AppendMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import { convertMessage } from "./runtime-convert.js";
import type { ChatState } from "./stream.js";

type ThreadRuntimeOptions = {
  /** 选中会话的消息。 */
  messages: ChatState["messages"];
  /** 重新生成末条回答；自行落定每个分支，从不 reject。 */
  onRegenerate(): Promise<unknown>;
  /** 现有发送路径；没有 UI 调用运行时的 composer，这里只满足适配器的必填项。 */
  onSend(prompt: string): void;
  /** 停止当前回合；从不 reject。 */
  onStop(): Promise<unknown>;
};

function appendedText(message: AppendMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * `isRunning` 只在末条消息是状态为 `running` 的助手消息时为真：运行时在「运行中且末条不是助手消息」
 * 时会自己补一条乐观的助手占位，这条规则让它永远没有机会补。输入框的 `生成中` / `停止` / 锁定由
 * 应用自己的 `generating` 驱动，不读这里。不提供 threadList、工具审批与 `onEdit`。
 */
export function useThreadRuntime({ messages, onRegenerate, onSend, onStop }: ThreadRuntimeOptions) {
  const last = messages.at(-1);
  return useExternalStoreRuntime({
    messages,
    isRunning: last?.role === "assistant" && last.status === "running",
    convertMessage,
    onNew: async (message) => onSend(appendedText(message)),
    onCancel: async () => {
      await onStop();
    },
    onReload: async () => {
      await onRegenerate();
    },
  });
}
