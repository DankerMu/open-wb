// 复制反馈（design D8）：消息级 `复制` 与代码块 `复制代码` 共用的一条规则，不弹轻提示。
import { useEffect, useState } from "react";

const COPIED_MS = 2000;

type CopyResult = "idle" | "copied" | "failed";

/**
 * 经 `navigator.clipboard.writeText` 复制 `text`。成功后 `result` 为 `copied` 约 2 秒再回到 `idle`；
 * 剪贴板 API 缺失、抛错或 reject 都落进 catch，`result` 为 `failed`，直到下一次点击——每次点击先回到
 * `idle`，所以上一次的失败提示在再次点击时清除。`copy` 从不抛错、从不 reject。
 */
export function useCopyFeedback(text: string): { copy(): Promise<void>; result: CopyResult } {
  const [result, setResult] = useState<CopyResult>("idle");
  useEffect(() => {
    if (result !== "copied") return;
    const timer = setTimeout(() => setResult("idle"), COPIED_MS);
    return () => clearTimeout(timer);
  }, [result]);
  async function copy() {
    setResult("idle");
    try {
      await navigator.clipboard.writeText(text);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  }
  return { copy, result };
}
