import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ComposerOptions } from "../../lib/composer-contract.js";

type OptionsClient = Pick<ApiClient, "getComposerOptions">;
type Read = { client: OptionsClient; status: "pending" | "done" | "failed" };

/**
 * 输入框选项（可选档位、模型白名单、缺省值、上传上限）：每个 client 取一次。读取失败不显示任何错误
 * （401 也一样），在下一次进入欢迎态或选中会话（`requestedSessionId` 变化）时各重取一次；在途期间的
 * 切换不排队。换 client（换账号）立即回到 null 并重新取。
 *
 * 不中止、不写 effect cleanup：StrictMode 的模拟卸载会跑 cleanup，中止后记录仍是在途就永远不再取，
 * 清掉记录则变成两次请求。迟到的结果靠记录比对丢弃。
 */
export function useComposerOptions(
  client: OptionsClient,
  requestedSessionId: string | null,
): ComposerOptions | null {
  const [state, setState] = useState<{ client: OptionsClient; options: ComposerOptions } | null>(
    null,
  );
  const readRef = useRef<Read | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedSessionId 是重取的触发量，不在 effect 里读。
  useEffect(() => {
    const last = readRef.current;
    if (last?.client === client && last.status !== "failed") {
      return;
    }
    const read: Read = { client, status: "pending" };
    readRef.current = read;
    void client.getComposerOptions().then(
      (options) => {
        if (readRef.current !== read) return;
        read.status = "done";
        setState({ client, options });
      },
      () => {
        read.status = "failed";
      },
    );
  }, [client, requestedSessionId]);

  return state?.client === client ? state.options : null;
}
