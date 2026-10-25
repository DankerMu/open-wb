import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type {
  ApiClient,
  ConnectorListing,
  ExpertView,
  SessionCapabilities,
} from "../../lib/api.js";
import type { SessionCapabilitiesPatch } from "../../lib/api-session-capabilities.js";
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
/** 在途的 `PUT`；切技能 / 连接器时带切换后的停用集合（在途期间开关显示它），没带的为 null。 */
type Write = Flight & { disabledSkills: string[] | null; disabledConnectors: string[] | null };
type ShownError = Flight & { message: string };

/**
 * 切换后的完整停用集合：`disabled` 加上（关闭，`enabled` 为 false）或去掉（打开）`name`，去重后按 JS 缺省
 * `.sort()` 排序（与服务端存储同一比较）；不在弹层列表里的名称原样保留。同 `center/skills/use-skills.ts`
 * 的 `toggled`（那份不导出）。停用连接器集合同一规则，也用它。
 */
export function toggledSkills(
  disabled: readonly string[],
  name: string,
  enabled: boolean,
): string[] {
  const rest = disabled.filter((item) => item !== name);
  return [...new Set(enabled ? rest : [...rest, name])].sort();
}

/** 已选会话的能力、换专家、切技能与切连接器。 */
export type SessionCapabilityState = {
  /** 当前会话的能力；未选会话、读取中或读取失败时为 null（读取失败视为没有专家，不提示）。 */
  capabilities: SessionCapabilities | null;
  /**
   * 当前会话能力的 `GET`：`loading` 在途（含尚未发出），`failed` 失败，`done` 已取得（或一次 `PUT` 成功）；
   * 未选会话时为 `done`。在途与失败时技能开关不可操作。
   */
  read: "loading" | "failed" | "done";
  /** 弹层显示的停用集合：切技能的 `PUT` 在途时是切换后的集合，否则同 `capabilities`；未取得时为 null。 */
  disabledSkills: readonly string[] | null;
  /** 弹层显示的停用连接器集合：规则同 `disabledSkills`（切连接器的 `PUT` 在途时是切换后的集合）。 */
  disabledConnectors: readonly string[] | null;
  /**
   * 本会话的 `PUT` 在途（换专家、切技能与切连接器共用一个）：`选择专家…`、`移除专家`、技能与连接器开关都不可
   * 操作。
   */
  pending: boolean;
  /** 上一次 `PUT` 的失败文案（`ApiError.message`；401 不显示）；没有时为 null。 */
  error: string | null;
  /** 换专家：恰一次 `PUT …/capabilities` body `{expertId}`；`PUT` 在途时什么也不做。 */
  chooseExpert(expertId: string | null): void;
  /**
   * 切技能（`enabled` 为开关的新值）：恰一次 `PUT …/capabilities` body `{disabledSkills}`，为切换后的完整集合；
   * `PUT` 在途或能力尚未取得（在途、失败）时什么也不做。
   */
  toggleSkill(name: string, enabled: boolean): void;
  /**
   * 切连接器：恰一次 `PUT …/capabilities` body `{disabledConnectors}`，为切换后的完整集合（含不在弹层列表里的
   * 名称）；守卫同 `toggleSkill`。
   */
  toggleConnector(name: string, enabled: boolean): void;
};

/**
 * 已选会话的能力（chat-web「能力读取时机」；tasks.md 9.2、10.2 的定案）：`sessionId` 是会话页解析出的选中会话
 * id（欢迎态与无法解析的 id 为 undefined）。每次非 undefined 的 id 变化恰一次 `GET`（A→B→A 共三次），同一会话
 * 里不重取；换 client 也重取。迟到的 `GET` 与在途的 `PUT` 靠记录比对丢弃：切换会话、回到欢迎态或一次 `PUT`
 * 成功之后，此前发出的 `GET` 的结果不再落地（`PUT` 失败不丢它：仍在途的首次 `GET` 照常落地，标签即服务端
 * 保留的原专家）；切换会话或回到欢迎态之后，此前在途的 `PUT` 的成功与失败都不落地、也不再使新会话禁用。
 * `PUT` 成功以应答整体替换能力（与本地预期不同时以应答为准），失败不动已取得的能力（切技能的开关随之回滚）；
 * 失败文案在下一次 `PUT` 开始、切换会话或回到欢迎态时清除。每次发出 `GET` 即丢掉已取得的能力，回到欢迎态也
 * 丢掉：A→欢迎态→A 回到 A 的第一次提交与其后的重读在途时都是「读取中」（不是上一次的能力、也不是上一次的
 * 失败），切技能不以上一次取得的集合为底。
 *
 * 同一会话的 `GET` 记录在：StrictMode 的模拟重挂再跑一次 effect，记录仍是这个会话就不再发（不写 cleanup，理由
 * 同 `useComposerOptions`）。换专家、切技能与切连接器共用一个在途写，守卫是 ref：同一帧里连点两次只发一次
 *（不可操作的状态要到下一次渲染才生效，开关用 `aria-disabled` 也照样分派点击）。切技能 / 连接器的底同样取自
 * ref（与 `held` 同步写入）：`PUT` 应答落地到重渲染之间的一次点击以应答的集合为底，不是渲染时闭包里的旧集合。
 */
export function useSessionCapabilities(
  client: CapabilitiesClient,
  sessionId: string | undefined,
): SessionCapabilityState {
  const [held, setHeld] = useState<HeldCapabilities | null>(null);
  const [writing, setWriting] = useState<Write | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const heldRef = useRef<HeldCapabilities | null>(null);
  const readRef = useRef<Flight | null>(null);
  const writeRef = useRef<Flight | null>(null);
  /** 写 `held` 一律经它：`heldRef` 与之同步，切技能从 ref 读最新的集合。 */
  const hold = useCallback((next: HeldCapabilities | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  useEffect(() => {
    writeRef.current = null;
    setWriting(null);
    setError(null);
    if (sessionId === undefined) {
      // 回到欢迎态即丢掉已持有的集合：回到会话的第一次提交按「未取得」处理（专家标签与停用过滤不用上一次的
      // 集合），不靠弹层作用域重置兜底。
      readRef.current = null;
      hold(null);
      return;
    }
    const last = readRef.current;
    if (last?.client === client && last.sessionId === sessionId) return;
    const read: Flight = { client, sessionId };
    readRef.current = read;
    hold(null);
    const land = (capabilities: SessionCapabilities | null) => {
      if (readRef.current === read) hold({ client, sessionId, capabilities });
    };
    client.getSessionCapabilities(sessionId).then(land, () => land(null));
  }, [client, hold, sessionId]);

  const current = (flight: Flight | null): flight is Flight =>
    flight !== null && flight.client === client && flight.sessionId === sessionId;
  const capabilities = current(held) ? held.capabilities : null;

  /** 恰一次 `PUT`；patch 里的停用集合即在途期间开关显示的集合。调用方已查过守卫。 */
  const put = (id: string, patch: SessionCapabilitiesPatch) => {
    const write: Write = {
      client,
      sessionId: id,
      disabledSkills: patch.disabledSkills ?? null,
      disabledConnectors: patch.disabledConnectors ?? null,
    };
    writeRef.current = write;
    setWriting(write);
    setError(null);
    client.putSessionCapabilities(id, patch).then(
      (answer) => {
        if (writeRef.current !== write) return;
        writeRef.current = null;
        // 此前发出的 GET（若仍在途）比这次写入旧：换一条同会话的记录，它的结果不再落地。
        readRef.current = { client, sessionId: id };
        setWriting(null);
        hold({ client, sessionId: id, capabilities: answer });
      },
      (failure: unknown) => {
        if (writeRef.current !== write) return;
        writeRef.current = null;
        setWriting(null);
        if (!isUnauthorized(failure)) {
          setError({ client, sessionId: id, message: errorMessage(failure) });
        }
      },
    );
  };

  const chooseExpert = (expertId: string | null) => {
    if (sessionId === undefined || writeRef.current !== null) return;
    put(sessionId, { expertId });
  };

  /** 切技能与切连接器共用的守卫与底：底取自 `heldRef`（最新的应答），不是渲染时闭包里的集合。 */
  const toggle = (key: "disabledSkills" | "disabledConnectors", name: string, enabled: boolean) => {
    const latest = heldRef.current;
    if (sessionId === undefined || writeRef.current !== null || capabilities === null) return;
    if (!current(latest) || latest.capabilities === null) return;
    put(sessionId, { [key]: toggledSkills(latest.capabilities[key], name, enabled) });
  };

  const shownWrite = current(writing) ? writing : null;
  let read: SessionCapabilityState["read"] = "done";
  if (sessionId !== undefined && capabilities === null) read = current(held) ? "failed" : "loading";
  return {
    capabilities,
    read,
    disabledSkills: shownWrite?.disabledSkills ?? capabilities?.disabledSkills ?? null,
    disabledConnectors: shownWrite?.disabledConnectors ?? capabilities?.disabledConnectors ?? null,
    pending: shownWrite !== null,
    error: current(error) ? error.message : null,
    chooseExpert,
    toggleSkill: (name, enabled) => toggle("disabledSkills", name, enabled),
    toggleConnector: (name, enabled) => toggle("disabledConnectors", name, enabled),
  };
}

/** 一次按需读取：在途、失败或已取得（`value`）。 */
type LazyRead<C, T> = { client: C; status: "pending" | "failed" | "done"; value: T | null };

/** 按需读取的结果（欢迎态的账号缺省、本页的连接器清单）。 */
type Lazy<T> = {
  /** 已取得的值；未取得时为 null。 */
  value: T | null;
  /** 本 client 的读取：从未发出为 `idle`。 */
  status: "idle" | "pending" | "failed" | "done";
  /** 打开 `能力` 弹层时调用：从未取得且没有在途的读取时恰发一次。 */
  load(): void;
};

/**
 * 按 client 缓存的按需读取（`ChatPage` 存活期间复用；换 client 回到未取得）。只在 `load()` 时读取：第一次打开
 * 弹层恰一次，在途时重开不重发，失败后下一次打开恰重取一次，成功后不再取。读取在事件里发出，不在 effect 里
 *（StrictMode 的 effect 重跑会多发一次）。不计入、也不使输入框选项缓存失效。`fetch` 须是模块级的稳定函数。
 */
function useLazyRead<C, T>(client: C, fetch: (client: C) => Promise<T>): Lazy<T> {
  const [read, setRead] = useState<LazyRead<C, T> | null>(null);
  const readRef = useRef<LazyRead<C, T> | null>(null);

  const load = useCallback(() => {
    const last = readRef.current;
    if (last?.client === client && last.status !== "failed") return;
    const flight: LazyRead<C, T> = { client, status: "pending", value: null };
    const settle = (next: LazyRead<C, T>) => {
      if (readRef.current !== flight) return;
      readRef.current = next;
      setRead(next);
    };
    readRef.current = flight;
    setRead(flight);
    fetch(client).then(
      (value) => settle({ client, status: "done", value }),
      () => settle({ client, status: "failed", value: null }),
    );
  }, [client, fetch]);

  const own = read?.client === client ? read : null;
  return { value: own?.value ?? null, status: own?.status ?? "idle", load };
}

type SkillsClient = Pick<ApiClient, "listSkills">;

/** 欢迎态的账号缺省停用列表（skill-switches「输入框「能力」弹层」）。 */
export type SkillDefaults = {
  /** `GET /api/skills` 的 `disabledSkills`（含列表外的名称）；未取得时为 null。 */
  disabledSkills: readonly string[] | null;
  /** 本 client 的读取：从未发出为 `idle`。 */
  status: Lazy<string[]>["status"];
  /** 欢迎态打开 `能力` 弹层时调用：从未取得且没有在途的读取时恰发一次 `GET /api/skills`。 */
  load(): void;
};

const readSkillDefaults = (client: SkillsClient) =>
  client.listSkills().then((list) => list.disabledSkills);

/** 账号缺省停用列表，按 client 缓存，读取规则见 `useLazyRead`。 */
export function useSkillDefaults(client: SkillsClient): SkillDefaults {
  const { value, status, load } = useLazyRead(client, readSkillDefaults);
  return { disabledSkills: value, status, load };
}

type ConnectorListClient = Pick<ApiClient, "listConnectors">;
type ConnectorDefaultsClient = Pick<ApiClient, "getConnectorDefaults">;

/**
 * 本页的连接器清单（skill-switches「输入框「能力」弹层」的 `连接器` 段）：`value` 为启用的连接器名称，按应答
 * 次序；普通用户视图本就只含启用的行，管理员视图取 `enabled` 为真的行。欢迎态与会话中都在打开弹层时 `load()`。
 */
export type ConnectorList = Lazy<string[]>;

/** 欢迎态的账号缺省停用连接器（`GET /api/connectors/defaults`，含列表外的名称）。 */
export type ConnectorDefaults = Lazy<string[]>;

const enabledNames = (listing: ConnectorListing) =>
  listing.admin
    ? listing.connectors.filter((item) => item.enabled).map((item) => item.name)
    : listing.connectors.map((item) => item.name);

const readConnectorList = (client: ConnectorListClient) =>
  client.listConnectors().then(enabledNames);

const readConnectorDefaults = (client: ConnectorDefaultsClient) => client.getConnectorDefaults();

/** 连接器清单，按 client 缓存、每页一次（chat-web「能力读取时机」），读取规则见 `useLazyRead`。 */
export function useConnectorList(client: ConnectorListClient): ConnectorList {
  return useLazyRead(client, readConnectorList);
}

/** 账号缺省停用连接器，按 client 缓存，只在欢迎态打开弹层时读取，规则见 `useLazyRead`。 */
export function useConnectorDefaults(client: ConnectorDefaultsClient): ConnectorDefaults {
  return useLazyRead(client, readConnectorDefaults);
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
