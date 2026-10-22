import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ComposerOptions } from "../../lib/composer-contract.js";

type OptionsClient = Pick<ApiClient, "getComposerOptions">;
type Read = { client: OptionsClient; status: "pending" | "done" | "failed" };
type Held = { client: OptionsClient; options: ComposerOptions };

/**
 * 输入框选项（可选档位、模型白名单、缺省值、上传上限）：每个 client 取一次并留着。读取失败不显示任何错误
 * （401 也一样），在下一次进入欢迎态或选中会话（`requestedSessionId` 变化）时各重取一次；在途期间的
 * 切换不排队。换 client（换账号）立即回到 null 并重新取。
 *
 * `invalidate()`（chat-web「输入框与能力栏」）：本页的一次设置保存成功后调用、模型菜单打开时调用
 * （model-selection「模型与推理强度控件」），立即再取一次，使 `defaults` 与模型白名单等于此刻新建会话会
 * 得到的值。重取在途与失败期间 `options` 仍是上一份；失败后按上面的失败规则再取。
 * 已有读取在途时照样再发一次并只采用最后发出的那次——在途的那次可能在这次保存之前就已算出（规格没有写
 * 这一分支，由「重取到的值等于此刻新建会话会得到的值」读代码推出）。入口属于渲染它的那个 client：记录
 * 已属于别的 client 时（换账号之后才到的旧保存）不发请求。
 *
 * `onDefaultModelChange`：落地的一份与同一 client 的上一份 `defaults.modelId` 不同时调用一次（先于新的
 * 一份进入渲染）。首次取得与换 client 后的取得没有「上一份」，不调用。
 *
 * 不中止、不写 effect cleanup：StrictMode 的模拟卸载会跑 cleanup，中止后记录仍是在途就永远不再取，
 * 清掉记录则变成两次请求。迟到的结果靠记录比对丢弃。
 */
export function useComposerOptions(
  client: OptionsClient,
  requestedSessionId: string | null,
  onDefaultModelChange: () => void,
): { options: ComposerOptions | null; invalidate(): void } {
  const [state, setState] = useState<Held | null>(null);
  const readRef = useRef<Read | null>(null);
  const heldRef = useRef<Held | null>(null);
  const changedRef = useRef(onDefaultModelChange);
  changedRef.current = onDefaultModelChange;

  const start = useCallback(() => {
    const read: Read = { client, status: "pending" };
    readRef.current = read;
    void client.getComposerOptions().then(
      (options) => {
        if (readRef.current !== read) return;
        read.status = "done";
        const last = heldRef.current;
        if (last?.client === client && last.options.defaults.modelId !== options.defaults.modelId) {
          changedRef.current();
        }
        heldRef.current = { client, options };
        setState(heldRef.current);
      },
      () => {
        read.status = "failed";
      },
    );
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedSessionId 是重取的触发量，不在 effect 里读。
  useEffect(() => {
    const last = readRef.current;
    if (last?.client === client && last.status !== "failed") {
      return;
    }
    start();
  }, [client, requestedSessionId, start]);

  const invalidate = useCallback(() => {
    if (readRef.current?.client === client) start();
  }, [client, start]);

  return { options: state?.client === client ? state.options : null, invalidate };
}
