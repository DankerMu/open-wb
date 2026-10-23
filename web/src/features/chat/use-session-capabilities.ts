import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiClient, ExpertView, SessionCapabilities } from "../../lib/api.js";
import { errorMessage, isUnauthorized } from "./errors.js";

type ExpertsClient = Pick<ApiClient, "listExperts">;
type ExpertRead = { client: ExpertsClient; status: "pending" | "done" | "failed" };
type HeldExperts = { client: ExpertsClient; experts: ExpertView[] };

/** 会话页的专家清单：标签的名称与专家对话框的列表都取自它。 */
export type ExpertList = {
  /** 本 client 已取得的清单；读取中或失败（且从未取得过）时为 null。 */
  experts: ExpertView[] | null;
  /** 再取一次并以结果更新清单（专家对话框每次打开时）；成功为 true。从不 reject。 */
  refresh(): Promise<boolean>;
};

/**
 * 专家清单（chat-web「能力读取时机」）：写法照 `composer-options.ts` 的 `useComposerOptions`——每个 client 取
 * 一次并留着，读取失败不显示任何错误，在下一次进入欢迎态或选中会话（`requestedSessionId` 变化）时重取；在途
 * 期间的切换不排队；换 client 立即回到 null 并重新取。`refresh()` 照样再发一次并只采用最后发出的那次；它失败时
 * 已有的清单保留，记录按失败计（下一次进入欢迎态或选中会话时重取）。不中止、不写 effect cleanup，迟到的结果
 * 靠记录比对丢弃（理由同 `useComposerOptions`）。
 */
export function useExpertList(
  client: ExpertsClient,
  requestedSessionId: string | null,
): ExpertList {
  const [held, setHeld] = useState<HeldExperts | null>(null);
  const readRef = useRef<ExpertRead | null>(null);

  const start = useCallback((): Promise<boolean> => {
    const read: ExpertRead = { client, status: "pending" };
    readRef.current = read;
    return client.listExperts().then(
      (experts) => {
        read.status = "done";
        if (readRef.current === read) setHeld({ client, experts });
        return true;
      },
      () => {
        read.status = "failed";
        return false;
      },
    );
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedSessionId 是重取的触发量，不在 effect 里读。
  useEffect(() => {
    const last = readRef.current;
    if (last?.client === client && last.status !== "failed") {
      return;
    }
    void start();
  }, [client, requestedSessionId, start]);

  return { experts: held?.client === client ? held.experts : null, refresh: start };
}

type CapabilitiesClient = Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
/** 一次读取或写入的记录：它属于哪个 client 与会话；只有仍是「当前那次」的记录才落地。 */
type Flight = { client: CapabilitiesClient; sessionId: string };
type HeldCapabilities = Flight & { capabilities: SessionCapabilities | null };
type ShownError = Flight & { message: string };

/** 已选会话的能力与换专家。 */
export type SessionCapabilityState = {
  /** 当前会话的能力；未选会话、读取中或读取失败时为 null（读取失败视为没有专家，不提示）。 */
  capabilities: SessionCapabilities | null;
  /** 本会话的 `PUT` 在途：`选择专家…` 与 `移除专家` 禁用。 */
  pending: boolean;
  /** 上一次 `PUT` 的失败文案（`ApiError.message`；401 不显示）；没有时为 null。 */
  error: string | null;
  /** 换专家：恰一次 `PUT …/capabilities` body `{expertId}`；`PUT` 在途时什么也不做。 */
  chooseExpert(expertId: string | null): void;
};

/**
 * 已选会话的能力（chat-web「能力读取时机」；tasks.md 9.2 的定案）：`sessionId` 是会话页解析出的选中会话 id
 * （欢迎态与无法解析的 id 为 undefined）。每次非 undefined 的 id 变化恰一次 `GET`（A→B→A 共三次），同一会话里
 * 不重取；换 client 也重取。迟到的 `GET` 与在途的 `PUT` 靠记录比对丢弃：切换会话、回到欢迎态或开始一次 `PUT`
 * 之后，此前发出的 `GET` 的结果不再落地；切换会话或回到欢迎态之后，此前在途的 `PUT` 的成功与失败都不落地、
 * 也不再使新会话禁用。`PUT` 的失败文案在下一次 `PUT` 开始、切换会话或回到欢迎态时清除。
 *
 * 同一会话的 `GET` 记录在：StrictMode 的模拟重挂再跑一次 effect，记录仍是这个会话就不再发（不写 cleanup，理由
 * 同 `useComposerOptions`）。在途守卫是 ref：同一帧里连点两次只发一次（按钮的禁用要到下一次渲染才生效）。
 */
export function useSessionCapabilities(
  client: CapabilitiesClient,
  sessionId: string | undefined,
): SessionCapabilityState {
  const [held, setHeld] = useState<HeldCapabilities | null>(null);
  const [writing, setWriting] = useState<Flight | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const readRef = useRef<Flight | null>(null);
  const writeRef = useRef<Flight | null>(null);

  useEffect(() => {
    writeRef.current = null;
    setWriting(null);
    setError(null);
    if (sessionId === undefined) {
      readRef.current = null;
      return;
    }
    const last = readRef.current;
    if (last?.client === client && last.sessionId === sessionId) return;
    const read: Flight = { client, sessionId };
    readRef.current = read;
    const land = (capabilities: SessionCapabilities | null) => {
      if (readRef.current === read) setHeld({ client, sessionId, capabilities });
    };
    client.getSessionCapabilities(sessionId).then(land, () => land(null));
  }, [client, sessionId]);

  const chooseExpert = useCallback(
    (expertId: string | null) => {
      if (sessionId === undefined || writeRef.current !== null) return;
      const write: Flight = { client, sessionId };
      writeRef.current = write;
      // 此前发出的 GET（若仍在途）比这次写入旧：换一条同会话的记录，它的结果不再落地。
      readRef.current = { client, sessionId };
      setWriting(write);
      setError(null);
      client.putSessionCapabilities(sessionId, { expertId }).then(
        (capabilities) => {
          if (writeRef.current !== write) return;
          writeRef.current = null;
          setWriting(null);
          setHeld({ client, sessionId, capabilities });
        },
        (failure: unknown) => {
          if (writeRef.current !== write) return;
          writeRef.current = null;
          setWriting(null);
          if (!isUnauthorized(failure)) {
            setError({ client, sessionId, message: errorMessage(failure) });
          }
        },
      );
    },
    [client, sessionId],
  );

  const current = (flight: Flight | null) =>
    flight !== null && flight.client === client && flight.sessionId === sessionId;
  return {
    capabilities: current(held) ? (held?.capabilities ?? null) : null,
    pending: current(writing),
    error: current(error) ? (error?.message ?? null) : null,
    chooseExpert,
  };
}

/**
 * 中心 `开始会话` 的带入（experts「中心「专家」tab」）：`navigate("/", {state: {expertId}})` 来的 state 读一次即
 * 选中该专家（欢迎态的页面状态），随即以 replace 清掉 state——刷新或回到同一条历史记录不再带入。按
 * `location.key` 去重：StrictMode 的 effect 重跑只处理一次。由 `page.tsx` 调用（Router 内）；不放进
 * `useWelcomeOptions`，它在没有 Router 的 `renderHook` 里也要能用。
 */
export function useExpertHandOff(selectExpert: (expertId: string) => void) {
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const state: unknown = location.state;
    if (typeof state !== "object" || state === null || !("expertId" in state)) return;
    if (typeof state.expertId !== "string" || handled.current === location.key) return;
    handled.current = location.key;
    selectExpert(state.expertId);
    const { hash, pathname, search } = location;
    navigate({ hash, pathname, search }, { replace: true, state: null });
  }, [location, navigate, selectExpert]);
}
