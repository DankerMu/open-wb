import { useCallback, useState } from "react";
import type { WelcomeScene } from "./welcome-content.js";
import type { Workspace } from "./workspace-list.js";

/**
 * 欢迎态的场景与空间选择：会话页的内存状态（不写 storage、不进 URL、不发请求），活在 `ChatPage`
 * 所以选中会话后回到欢迎态仍在。选中的空间只存 id，每次渲染按当前已读取的列表解析：列表里找不到
 * （重读后已不存在、读取失败或换了账号）即 `workspace` 为 null，按钮文本与 `createBody()` 随之一致；
 * 它重新出现在列表里时选择恢复。
 */
export function useWelcomeOptions(
  workspaces: readonly Workspace[] | null,
  workspacesError: string | null,
) {
  const [scene, selectScene] = useState<WelcomeScene["value"]>("office");
  const [workspaceId, selectWorkspace] = useState<string | null>(null);
  const workspace = workspaces?.find((item) => item.id === workspaceId) ?? null;
  const effectiveId = workspace?.id;
  /** `POST /api/sessions` 的 body：没有生效空间时不带 `workspaceId` 键。 */
  const createBody = useCallback(
    () => (effectiveId === undefined ? { scene } : { scene, workspaceId: effectiveId }),
    [effectiveId, scene],
  );
  return {
    createBody,
    scene,
    selectScene,
    selectWorkspace,
    workspace,
    workspaces,
    workspacesError,
  };
}

export type WelcomeOptions = ReturnType<typeof useWelcomeOptions>;
