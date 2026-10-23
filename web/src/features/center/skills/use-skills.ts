import { useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError, REQUEST_FAILED_MESSAGE, type SkillList } from "@/lib/api";

/**
 * 「技能」tab 的数据与操作（skill-switches「中心「技能」tab」，s1d-experts-skills 任务 8.3）。请求时机：挂载恰一次
 * `listSkills`；此后每次切换恰一次 `putSkillDefaults`，不重取。
 *
 * 开关状态只看 `list.disabledSkills`（开 = 名称不在其中）：切换时先把它改成切换后的列表（在途期间开关显示切换后
 * 的状态、全部禁用），成功以应答整个替换 `list`，失败把停用列表还原并给出提示。
 */
type State =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; list: SkillList; pending: boolean; error: string | null };

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

/**
 * 切换后的完整停用列表：`disabled` 加上（关闭）或去掉（打开）`name`，去重后按 JS 缺省 `.sort()` 排序——与服务端
 * `normalizeSkillNames` 同一比较；列表外的名称原样保留。
 */
function toggled(disabled: readonly string[], name: string, enabled: boolean): string[] {
  const rest = disabled.filter((item) => item !== name);
  return [...new Set(enabled ? rest : [...rest, name])].sort();
}

export function useSkills(client: ApiClient) {
  const [state, setState] = useState<State>({ status: "loading" });
  /** 在途标记：同一帧里的第二次点击还看不到 `pending` 的重渲染，靠它拦下。 */
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    client.listSkills().then(
      (list) => {
        if (live) setState({ status: "ready", list, pending: false, error: null });
      },
      (error: unknown) => {
        if (live) setState({ status: "failed", message: messageOf(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  return {
    state,

    /** 把 `name` 的 `默认启用` 切到 `enabled`：恰一次 `putSkillDefaults`；在途时忽略。 */
    async toggle(name: string, enabled: boolean) {
      if (state.status !== "ready" || state.pending || inFlight.current) return;
      inFlight.current = true;
      const previous = state.list.disabledSkills;
      const next = toggled(previous, name, enabled);
      setState({
        ...state,
        list: { ...state.list, disabledSkills: next },
        pending: true,
        error: null,
      });
      try {
        const list = await client.putSkillDefaults(next);
        setState({ status: "ready", list, pending: false, error: null });
      } catch (error) {
        setState((current) =>
          current.status === "ready"
            ? {
                ...current,
                list: { ...current.list, disabledSkills: previous },
                pending: false,
                error: messageOf(error),
              }
            : current,
        );
      } finally {
        inFlight.current = false;
      }
    },
  };
}
