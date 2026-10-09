import { useCallback, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { WelcomeScene } from "./welcome-content.js";
import type { Workspace } from "./workspace-list.js";

/** 欢迎态的档位、模型、强度选择：只含用户碰过的键，没碰的键不进创建请求（由服务端取缺省）。 */
type Picked = Pick<
  NonNullable<Parameters<ApiClient["createSession"]>[0]>,
  "approvalMode" | "modelId" | "reasoningEffort"
>;

/**
 * 欢迎态的场景与空间选择：会话页的内存状态（不写 storage、不进 URL、不发请求），活在 `ChatPage`
 * 所以选中会话后回到欢迎态仍在。选中的空间只存 id，每次渲染按当前已读取的列表解析：列表里找不到
 * （重读后已不存在、读取失败或换了账号）即 `workspace` 为 null，按钮文本与 `createBody()` 随之一致；
 * 它重新出现在列表里时选择恢复。`picked` 与 `scene` 同生命周期：首次发送后不清，换账号不清。
 */
export function useWelcomeOptions(
  workspaces: readonly Workspace[] | null,
  workspacesError: string | null,
) {
  const [scene, selectScene] = useState<WelcomeScene["value"]>("office");
  const [workspaceId, selectWorkspace] = useState<string | null>(null);
  const workspace = workspaces?.find((item) => item.id === workspaceId) ?? null;
  const effectiveId = workspace?.id;
  const [picked, setPicked] = useState<Picked>({});
  /** 合并进 `picked`；值为 `undefined` 的键删除（换到不支持推理的模型时清掉强度）。 */
  const pick = useCallback((patch: { [K in keyof Picked]?: Picked[K] | undefined }) => {
    setPicked(
      (current) =>
        Object.fromEntries(
          Object.entries({ ...current, ...patch }).filter(([, value]) => value !== undefined),
        ) as Picked,
    );
  }, []);
  /** `POST /api/sessions` 的 body：没有生效空间时不带 `workspaceId` 键，`picked` 只带选过的键。 */
  const createBody = useCallback(
    () => ({
      scene,
      ...(effectiveId === undefined ? {} : { workspaceId: effectiveId }),
      ...picked,
    }),
    [effectiveId, picked, scene],
  );
  return {
    createBody,
    pick,
    picked,
    scene,
    selectScene,
    selectWorkspace,
    workspace,
    workspaces,
    workspacesError,
  };
}

export type WelcomeOptions = ReturnType<typeof useWelcomeOptions>;
