import { useCallback, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { toggledSkills } from "./use-session-capabilities.js";
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
 *
 * 专家（experts「输入框的专家选择」）另存一份、不进 `picked`：`picked` 非空的创建成功后输入框选项缓存失效
 * （`use-chat-session.ts`），只选专家的首次发送不应多一次 `getComposerOptions`。null 即没有专家（含选了
 * `不使用专家`），此时创建请求不带 `expertId` 键（`POST /api/sessions` 不接受 null）。同样与 `scene` 同生命周期。
 *
 * 技能（skill-switches「输入框「能力」弹层」）同样另存、不进 `picked`：`disabledSkills` 为 null（没动过开关）或
 * 完整停用集合——第一次切换以账号缺省为底加上或去掉该名称，之后在此基础上累积。非 null 时创建请求才带
 * `disabledSkills` 键。与 `scene` 同生命周期（首次发送后不清）。连接器（同一弹层的 `连接器` 段）照此另存一份
 * `disabledConnectors`：以账号缺省停用连接器为底，非 null 时创建请求才带该键。
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
  const [expertId, selectExpert] = useState<string | null>(null);
  const [disabledSkills, setDisabledSkills] = useState<string[] | null>(null);
  const [disabledConnectors, setDisabledConnectors] = useState<string[] | null>(null);
  /** 切一个技能的开关（`enabled` 为新值）；`defaults` 是已取得的账号缺省停用列表，没动过开关时以它为底。 */
  const toggleSkill = useCallback((name: string, enabled: boolean, defaults: readonly string[]) => {
    setDisabledSkills((current) => toggledSkills(current ?? defaults, name, enabled));
  }, []);
  /** 切一个连接器的开关；`defaults` 是已取得的账号缺省停用连接器，没动过开关时以它为底。 */
  const toggleConnector = useCallback(
    (name: string, enabled: boolean, defaults: readonly string[]) => {
      setDisabledConnectors((current) => toggledSkills(current ?? defaults, name, enabled));
    },
    [],
  );
  /** 合并进 `picked`；值为 `undefined` 的键删除（换到不支持推理的模型时清掉强度）。 */
  const pick = useCallback((patch: { [K in keyof Picked]?: Picked[K] | undefined }) => {
    setPicked(
      (current) =>
        Object.fromEntries(
          Object.entries({ ...current, ...patch }).filter(([, value]) => value !== undefined),
        ) as Picked,
    );
  }, []);
  /**
   * 重取到的缺省模型变了（chat-web「输入框与能力栏」）：页面上没选过模型时，已选的强度相对的是原来的
   * 缺省模型，丢弃；选过模型时强度相对的是所选的模型，不动。档位与模型的选择从不因重取而变。
   */
  const defaultModelChanged = useCallback(() => {
    setPicked((current) => {
      if (current.modelId !== undefined || current.reasoningEffort === undefined) return current;
      return current.approvalMode === undefined ? {} : { approvalMode: current.approvalMode };
    });
  }, []);
  /**
   * `POST /api/sessions` 的 body：没有生效空间时不带 `workspaceId` 键，`picked` 只带选过的键，没有专家时不带
   * `expertId` 键，没动过技能开关时不带 `disabledSkills` 键，没动过连接器开关时不带 `disabledConnectors` 键。
   */
  const createBody = useCallback(
    () => ({
      scene,
      ...(effectiveId === undefined ? {} : { workspaceId: effectiveId }),
      ...picked,
      ...(expertId === null ? {} : { expertId }),
      ...(disabledSkills === null ? {} : { disabledSkills }),
      ...(disabledConnectors === null ? {} : { disabledConnectors }),
    }),
    [disabledConnectors, disabledSkills, effectiveId, expertId, picked, scene],
  );
  return {
    createBody,
    defaultModelChanged,
    disabledConnectors,
    disabledSkills,
    expertId,
    pick,
    picked,
    scene,
    selectExpert,
    selectScene,
    selectWorkspace,
    toggleConnector,
    toggleSkill,
    workspace,
    workspaces,
    workspacesError,
  };
}

export type WelcomeOptions = ReturnType<typeof useWelcomeOptions>;
