// `useComposerOptions`（每个 client 取一次、失败后在下一次换选择时重取、保存设置后失效并重取）与欢迎态
// 三项内存选择的 hook 层用例；其后是 chat-web「输入框与能力栏」场景「保存设置后重取缺省值」的整页用例
// （整页挂载 + 假 API，期望文案与请求体取自规格条文）。
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerOptions } from "../src/features/chat/composer-options.js";
import { useWelcomeOptions } from "../src/features/chat/welcome-options.js";
import { ApiError } from "../src/lib/api.js";
import type { ComposerOptions } from "../src/lib/composer-contract.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  cleanupSessionMeta,
  envelope,
  findList,
  mountSessions,
  openTopbarRename,
  patchOf,
  patchPath,
  patchRequests,
  renameDialog,
  type SessionView,
  saveTitle,
  view,
} from "./chat-page-session-meta-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { deferred } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import {
  currentLocation,
  type DeferredResponse,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";
import { pressPointer } from "./ui-support.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const CAPPED: ComposerOptions = { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: ["always-ask"] };

function fakeClient() {
  const reads: ReturnType<typeof deferred<ComposerOptions>>[] = [];
  const getComposerOptions = vi.fn(() => {
    const read = deferred<ComposerOptions>();
    reads.push(read);
    return read.promise;
  });
  return { getComposerOptions, reads };
}

type Fake = ReturnType<typeof fakeClient>;

/** `changed` 是「重取到的缺省模型与上一份不同」的回调。 */
function mount(strict = false) {
  const client = fakeClient();
  const changed = vi.fn();
  const { rerender, result } = renderHook(
    (props: { client: Fake; sessionId: string | null }) =>
      useComposerOptions(props.client, props.sessionId, changed),
    {
      initialProps: { client, sessionId: null as string | null },
      ...(strict ? { wrapper: StrictMode } : {}),
    },
  );
  let current = client;
  const settle = (fake: Fake, index: number, outcome: ComposerOptions | Error) =>
    act(async () => {
      if (outcome instanceof Error) fake.reads[index]?.reject(outcome);
      else fake.reads[index]?.resolve(outcome);
      await Promise.resolve();
    });
  return {
    changed,
    client,
    /** 失效入口：`from` 缺省取此刻渲染出的那一个。 */
    invalidate: (from = result.current.invalidate) => act(() => from()),
    /** 此刻渲染出的失效入口（留着它，换 client 之后再调即旧 client 的迟到保存）。 */
    invalidator: () => result.current.invalidate,
    result: {
      get current() {
        return result.current.options;
      },
    },
    settle,
    select: (sessionId: string | null) => rerender({ client: current, sessionId }),
    swap(next: Fake, sessionId: string | null = null) {
      current = next;
      rerender({ client: next, sessionId });
    },
  };
}

const failure = () => new ApiError(500, "internal", "读取失败");

describe("useComposerOptions", () => {
  it("同一个 client：同值重渲染与 A→B→欢迎态→A 恰取一次，结果可用", async () => {
    const { client, result, select, settle } = mount();
    expect(result.current).toBeNull();
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    for (const sessionId of [A, B, null, A]) {
      select(sessionId);
      expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    }
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 的双挂载恰取一次，结果可用", async () => {
    const { client, result, settle } = mount(true);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("失败后：同值重渲染不重取，切到另一个会话恰重取一次，成功后不再取", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    await settle(client, 0, failure());
    expect(result.current).toBeNull();
    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);

    select(B);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
    await settle(client, 1, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);

    select(A);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
  });

  it("失败后回到欢迎态恰重取一次；401 与其它失败同样处理", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    await settle(client, 0, new ApiError(401, "unauthorized", "未登录"));
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    await settle(client, 1, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
  });

  it("连续失败：每次换选择各重取一次，失败、失败、成功共三次", async () => {
    const { client, result, select, settle } = mount();
    await settle(client, 0, failure());
    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    await settle(client, 1, failure());
    expect(result.current).toBeNull();
    select(B);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);
    await settle(client, 2, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);
  });

  it("在途时换选择不发第二次，也不排队重取", async () => {
    const { client, result, select, settle } = mount();
    select(A);
    select(B);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("换 client：立即回到 null 并重新取，旧 client 迟到的结果不落地", async () => {
    const { client, result, settle, swap } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);

    const next = fakeClient();
    swap(next);
    expect(result.current).toBeNull();
    expect(next.getComposerOptions).toHaveBeenCalledTimes(1);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);

    // 旧 client 在途时被换下：它迟到的成功不落地，也不盖掉新 client 已落定的结果。
    const third = fakeClient();
    swap(third);
    expect(result.current).toBeNull();
    await settle(third, 0, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    await settle(next, 0, CAPPED);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    swap(third, A);
    expect(third.getComposerOptions).toHaveBeenCalledTimes(1);
  });

  it("旧 client 迟到的失败不把新 client 的在途记录改成可重取", async () => {
    const { client, result, settle, swap } = mount();
    const next = fakeClient();
    swap(next);
    await settle(client, 0, failure());
    swap(next, A);
    expect(next.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(next, 0, CAPPED);
    expect(result.current).toBe(CAPPED);
  });
});

describe("useComposerOptions 的失效入口", () => {
  /** 与缺省配置只差缺省模型的一份。 */
  const OTHER_MODEL: ComposerOptions = {
    ...DEFAULT_COMPOSER_OPTIONS,
    defaults: { ...DEFAULT_COMPOSER_OPTIONS.defaults, modelId: "m2" },
  };

  it("失效后恰多取一次：在途期间仍是上一份，返回后换成新的一份，其后换选择不再取", async () => {
    const { client, invalidate, result, select, settle } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    invalidate();
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);

    await settle(client, 1, CAPPED);
    expect(result.current).toBe(CAPPED);
    select(B);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
  });

  it("失效后的重取失败：仍是上一份，同值重渲染不重取，换选择恰重取一次", async () => {
    const { client, invalidate, result, select, settle } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    invalidate();
    await settle(client, 1, failure());
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    select(null);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);

    select(A);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
    await settle(client, 2, CAPPED);
    expect(result.current).toBe(CAPPED);
  });

  it("在途时再次失效：再发一次，只采用最后发出的那次，先发的迟到结果不落地", async () => {
    const { changed, client, invalidate, result, settle } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    invalidate();
    invalidate();
    expect(client.getComposerOptions).toHaveBeenCalledTimes(3);

    await settle(client, 2, CAPPED);
    expect(result.current).toBe(CAPPED);
    await settle(client, 1, OTHER_MODEL);
    expect(result.current).toBe(CAPPED);
    expect(changed).not.toHaveBeenCalled();
  });

  it("首次读取在途时失效：再发一次，先发的结果不落地", async () => {
    const { client, invalidate, result, settle } = mount();
    invalidate();
    expect(client.getComposerOptions).toHaveBeenCalledTimes(2);
    await settle(client, 0, CAPPED);
    expect(result.current).toBeNull();
    await settle(client, 1, DEFAULT_COMPOSER_OPTIONS);
    expect(result.current).toBe(DEFAULT_COMPOSER_OPTIONS);
  });

  it("换 client 之后旧 client 的失效入口不发请求，也不顶掉新 client 的在途读取", async () => {
    const { client, invalidate, invalidator, result, settle, swap } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    const stale = invalidator();
    const next = fakeClient();
    swap(next);

    invalidate(stale);
    expect(client.getComposerOptions).toHaveBeenCalledTimes(1);
    expect(next.getComposerOptions).toHaveBeenCalledTimes(1);
    await settle(next, 0, CAPPED);
    expect(result.current).toBe(CAPPED);
  });

  it("缺省模型的回调：首次取得与重取到同一个缺省模型不调用，重取到另一个恰调用一次", async () => {
    const { changed, client, invalidate, result, settle } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    invalidate();
    await settle(client, 1, CAPPED);
    expect(changed).not.toHaveBeenCalled();

    invalidate();
    await settle(client, 2, OTHER_MODEL);
    expect(result.current).toBe(OTHER_MODEL);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("缺省模型的回调：换 client 后取得另一个缺省模型不调用（上一份属于别的 client）", async () => {
    const { changed, client, result, settle, swap } = mount();
    await settle(client, 0, DEFAULT_COMPOSER_OPTIONS);
    const next = fakeClient();
    swap(next);
    await settle(next, 0, OTHER_MODEL);
    expect(result.current).toBe(OTHER_MODEL);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("useWelcomeOptions 的三项内存选择", () => {
  const mountWelcome = () => renderHook(() => useWelcomeOptions(null, null)).result;

  it("未选时 picked 为空，createBody() 恰为 {scene}", () => {
    const result = mountWelcome();
    expect(result.current.picked).toStrictEqual({});
    expect(result.current.createBody()).toStrictEqual({ scene: "office" });
  });

  it("pick 合并所选键，createBody() 恰含这些键", () => {
    const result = mountWelcome();
    act(() => result.current.pick({ approvalMode: "yolo" }));
    expect(result.current.createBody()).toStrictEqual({ scene: "office", approvalMode: "yolo" });
    act(() => result.current.pick({ modelId: "m2", reasoningEffort: "low" }));
    expect(result.current.picked).toStrictEqual({
      approvalMode: "yolo",
      modelId: "m2",
      reasoningEffort: "low",
    });
    expect(result.current.createBody()).toStrictEqual({
      scene: "office",
      approvalMode: "yolo",
      modelId: "m2",
      reasoningEffort: "low",
    });
  });

  it("pick 的值为 undefined 时删除该键，其余键保留", () => {
    const result = mountWelcome();
    act(() => result.current.pick({ modelId: "m2", reasoningEffort: "low" }));
    act(() => result.current.pick({ modelId: "m3", reasoningEffort: undefined }));
    expect(Object.keys(result.current.picked)).toEqual(["modelId"]);
    expect(Object.keys(result.current.createBody()).sort()).toEqual(["modelId", "scene"]);
    expect(result.current.createBody()).toStrictEqual({ scene: "office", modelId: "m3" });
  });

  it("defaultModelChanged：没选过模型时只丢掉强度，档位留着", () => {
    const result = mountWelcome();
    act(() => result.current.pick({ approvalMode: "always-ask", reasoningEffort: "low" }));
    act(() => result.current.defaultModelChanged());
    expect(result.current.picked).toStrictEqual({ approvalMode: "always-ask" });
    expect(result.current.createBody()).toStrictEqual({
      scene: "office",
      approvalMode: "always-ask",
    });
  });

  it("defaultModelChanged：选过模型时三项都不动", () => {
    const result = mountWelcome();
    const all = { approvalMode: "yolo", modelId: "m3", reasoningEffort: "low" } as const;
    act(() => result.current.pick(all));
    act(() => result.current.defaultModelChanged());
    expect(result.current.picked).toStrictEqual(all);
  });
});

type Effort = ComposerOptions["models"][number]["efforts"][number];
type Kind = "权限" | "模型" | "推理强度";
type Answer = ComposerOptions | DeferredResponse | Response;

const OPTIONS_PATH = "/api/composer/options";
const ALL: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WARNING = "text-(--wb-status-warning-text)";
const REJECTED = "这个设置不可用";
/** 三个模型：`通用`（m1）与 `深度`（m3）支持推理，`快速`（m2）不支持；缺省是 只问命令、通用、高。 */
const FIRST: ComposerOptions = {
  ...DEFAULT_COMPOSER_OPTIONS,
  models: [
    { id: "m1", name: "通用", reasoning: true, vision: false, efforts: ALL, defaultEffort: "high" },
    { id: "m2", name: "快速", reasoning: false, vision: false, efforts: [], defaultEffort: null },
    { id: "m3", name: "深度", reasoning: true, vision: false, efforts: ALL, defaultEffort: "high" },
  ],
  defaults: { approvalMode: "write", modelId: "m1", reasoningEffort: "high" },
};
/** 夹具的 `view` 把强度钉成 null：这里放宽该键，会话里三个控件都在（只问命令、通用、高）。 */
const SESSION_A = { ...view(A, "甲"), reasoningEffort: "high" } as unknown as SessionView;
const SESSION_B = { ...view(B, "乙"), reasoningEffort: "high" } as unknown as SessionView;
const IN_SESSION = ["权限：只问命令", "模型：通用", "推理强度：高"];

function withDefaults(defaults: ComposerOptions["defaults"]): ComposerOptions {
  return { ...FIRST, defaults };
}

/** 像服务端那样把请求体的键写进视图并返回。 */
const saved: (body: object, index: number) => Promise<Response> | Response = (body) =>
  jsonResponse({ ...SESSION_A, ...body });

/**
 * 整页挂载：会话甲、乙在列表里，欢迎态可建会话；`answers` 依次应答各次 `getComposerOptions`（挂起的那次由
 * 用例放行），多出来的请求得到 500；`patch` 是甲的 PATCH（`index` 从 1 起），缺省照写照回。
 */
async function mountPage(path: string, answers: readonly Answer[], patch = saved) {
  let asked = 0;
  let patched = 0;
  const mounted = mountSessions(path, [], {
    ...welcomeRoutes({ existing: [SESSION_A, SESSION_B] }),
    [OPTIONS_PATH]: () => {
      const answer = answers[asked] ?? envelope(500, "夹具没有这一次应答");
      asked += 1;
      if (answer instanceof Response) return answer;
      return "promise" in answer ? answer.promise : jsonResponse(answer);
    },
    [patchPath(A)]: (_path, options) => {
      patched += 1;
      return patch(JSON.parse(String(options?.body)) as object, patched);
    },
  });
  await screen.findByRole("button", { name: /^权限：/ });
  await quiesce();
  return mounted;
}

/** 至此发出的 `getComposerOptions` 次数。 */
function asked({ fetchMock }: { fetchMock: FetchMock }) {
  return paths(fetchMock).filter((path) => path === OPTIONS_PATH).length;
}

/** 页面内容的查询都带 `hidden`：菜单与确认框开着时页面其余部分是 `aria-hidden`。 */
function control(kind: Kind) {
  return screen.queryByRole("button", { hidden: true, name: new RegExp(`^${kind}：`) });
}

/** 权限、模型、强度三个控件的可访问名；没有的为 null。 */
function controls() {
  return (["权限", "模型", "推理强度"] as const).map(
    (kind) => control(kind)?.getAttribute("aria-label") ?? null,
  );
}

/** 打开 `kind` 的菜单并点选文字以 `label` 开头的一项，等菜单关闭。 */
async function choose(kind: Kind, label: string) {
  const trigger = control(kind);
  if (!trigger) throw new Error(`没有${kind}控件`);
  pressPointer(trigger);
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitemradio");
  const item = items.find((radio) => radio.textContent?.startsWith(label));
  if (!item) throw new Error(`菜单里没有 ${label}`);
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

async function openSession(title: string, id: string) {
  fireEvent.click(within(await findList(title)).getByRole("button", { name: title }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${id}`));
}

async function backToWelcome(mounted: Parameters<typeof leaveForWelcome>[0]) {
  await leaveForWelcome(mounted);
  await screen.findByRole("heading", { level: 1, name: HERO });
}

/** 欢迎态发送，返回至此的全部创建请求。 */
async function send({ fetchMock }: { fetchMock: FetchMock }) {
  typeDraft("你好");
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
  return createRequests(fetchMock);
}

/**
 * 欢迎态选好之后让一次重取在欢迎态落地：选中甲，把它的强度改为 `中`（带键的 PATCH，成功后发出第
 * `expected` 次选项请求并挂起——此前每打开一次模型菜单多一次），回到欢迎态，再以 `defaults` 放行那次重取。
 */
async function refetchOnWelcome(
  mounted: Awaited<ReturnType<typeof mountPage>>,
  refetch: DeferredResponse,
  defaults: ComposerOptions["defaults"],
  expected: number,
) {
  const picked = controls();
  await openSession("甲", A);
  await waitFor(() => expect(controls()).toEqual(IN_SESSION));
  await choose("推理强度", "中");
  await waitFor(() => expect(asked(mounted)).toBe(expected));
  await backToWelcome(mounted);
  expect(controls()).toEqual(picked);
  await settleDeferredResponse(refetch, jsonResponse(withDefaults(defaults)));
  await quiesce();
}

describe("保存设置后重取缺省值", () => {
  afterEach(cleanupSessionMeta);

  it("带键的 patchSession 成功后恰多取一次，挂起期间三个控件仍在；返回后欢迎态是警示色的 权限：全部自动，不碰控件发送的创建体不带档位，其后没有第三次", async () => {
    const refetch = deferredResponse();
    const mounted = await mountPage(`/?session=${A}`, [FIRST, refetch]);
    expect(controls()).toEqual(IN_SESSION);
    expect(asked(mounted)).toBe(1);

    await choose("权限", "全部自动");
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认切换" }),
    );
    await waitFor(() => expect(controls()[0]).toBe("权限：全部自动"));
    await quiesce();
    expect(patchRequests(mounted.fetchMock, A)).toEqual([patchOf('{"approvalMode":"yolo"}')]);
    expect(asked(mounted)).toBe(2);
    expect(controls()).toEqual(["权限：全部自动", "模型：通用", "推理强度：高"]);
    await backToWelcome(mounted);
    expect(controls()).toEqual(IN_SESSION);

    await settleDeferredResponse(
      refetch,
      jsonResponse(withDefaults({ ...FIRST.defaults, approvalMode: "yolo" })),
    );
    await waitFor(() =>
      expect(controls()).toEqual(["权限：全部自动", "模型：通用", "推理强度：高"]),
    );
    const tier = control("权限");
    expect(tier?.getAttribute("data-tier")).toBe("yolo");
    expect(tier?.classList.contains(WARNING)).toBe(true);

    expect(await send(mounted)).toEqual([createOf('{"scene":"office"}')]);
    await quiesce();
    expect(asked(mounted)).toBe(2);
  });

  it("欢迎态选过 每次都问 后发送：带 approvalMode 的 createSession 成功后恰多取一次", async () => {
    const mounted = await mountPage("/", [FIRST, FIRST]);
    await choose("权限", "每次都问");
    await quiesce();
    expect(asked(mounted)).toBe(1);

    expect(await send(mounted)).toEqual([
      createOf('{"scene":"office","approvalMode":"always-ask"}'),
    ]);
    await waitFor(() => expect(asked(mounted)).toBe(2));
    await quiesce();
    expect(asked(mounted)).toBe(2);
  });

  it("只带 title 的 patchSession 成功：没有新的选项请求", async () => {
    const mounted = await mountPage(`/?session=${A}`, [FIRST]);
    saveTitle(await openTopbarRename(), "新名字");
    await waitFor(() => expect(renameDialog()).toBeNull());
    await quiesce();

    expect(patchRequests(mounted.fetchMock, A)).toEqual([patchOf('{"title":"新名字"}')]);
    expect(asked(mounted)).toBe(1);
  });

  it("带 modelId 的 patchSession 失败：除菜单打开外没有新的选项请求", async () => {
    const mounted = await mountPage(`/?session=${A}`, [FIRST, FIRST], () =>
      envelope(400, REJECTED),
    );
    await choose("模型", "深度");
    await screen.findByText(REJECTED);
    await quiesce();

    expect(patchRequests(mounted.fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
    expect(controls()).toEqual(IN_SESSION);
    expect(asked(mounted)).toBe(2);
  });

  it("只选过强度 低，重取到的缺省模型换成不支持推理的 快速：强度控件消失、模型按钮是 快速，创建体不带 reasoningEffort 也不带 modelId", async () => {
    const refetch = deferredResponse();
    const mounted = await mountPage("/", [FIRST, refetch]);
    await choose("推理强度", "低");
    expect(controls()).toEqual(["权限：只问命令", "模型：通用", "推理强度：低"]);

    await refetchOnWelcome(
      mounted,
      refetch,
      { approvalMode: "write", modelId: "m2", reasoningEffort: null },
      2,
    );

    expect(controls()).toEqual(["权限：只问命令", "模型：快速", null]);
    expect(await send(mounted)).toEqual([createOf('{"scene":"office"}')]);
  });

  it("选过 每次都问、深度 与 低，重取到的三项缺省都变了：三个控件不变，创建体带这三项", async () => {
    const refetch = deferredResponse();
    const mounted = await mountPage("/", [FIRST, FIRST, refetch, FIRST]);
    await choose("权限", "每次都问");
    await choose("模型", "深度");
    await choose("推理强度", "低");
    const picked = ["权限：每次都问", "模型：深度", "推理强度：低"];
    expect(controls()).toEqual(picked);

    await refetchOnWelcome(
      mounted,
      refetch,
      { approvalMode: "yolo", modelId: "m2", reasoningEffort: null },
      3,
    );

    expect(controls()).toEqual(picked);
    expect(await send(mounted)).toEqual([
      createOf(
        '{"scene":"office","approvalMode":"always-ask","modelId":"m3","reasoningEffort":"low"}',
      ),
    ]);
  });

  it("只选过 每次都问 与 低，重取只换了缺省档位：档位与强度都保留，模型按钮仍是缺省的 通用", async () => {
    const refetch = deferredResponse();
    const mounted = await mountPage("/", [FIRST, refetch, FIRST]);
    await choose("权限", "每次都问");
    await choose("推理强度", "低");
    const picked = ["权限：每次都问", "模型：通用", "推理强度：低"];
    expect(controls()).toEqual(picked);

    await refetchOnWelcome(mounted, refetch, { ...FIRST.defaults, approvalMode: "yolo" }, 2);

    expect(controls()).toEqual(picked);
    expect(await send(mounted)).toEqual([
      createOf('{"scene":"office","approvalMode":"always-ask","reasoningEffort":"low"}'),
    ]);
  });

  it("保存后的那次重取失败：三个控件按上一份照常显示、没有提示；选中另一个会话时再取一次", async () => {
    const mounted = await mountPage(`/?session=${A}`, [
      FIRST,
      envelope(503, "服务暂不可用"),
      FIRST,
    ]);
    await choose("推理强度", "中");
    await waitFor(() => expect(asked(mounted)).toBe(2));
    await quiesce();
    expect(controls()).toEqual(["权限：只问命令", "模型：通用", "推理强度：中"]);
    expect(screen.queryAllByRole("alert", { hidden: true })).toEqual([]);
    expect(asked(mounted)).toBe(2);

    await openSession("乙", B);
    await waitFor(() => expect(asked(mounted)).toBe(3));
    await quiesce();
    expect(controls()).toEqual(IN_SESSION);
    await backToWelcome(mounted);
    await quiesce();
    expect(asked(mounted)).toBe(3);
  });

  it("两次设置提交重叠、后发的失败：先发的那次成功仍触发恰一次重取（保存已经成立）", async () => {
    const first = deferredResponse();
    const mounted = await mountPage(`/?session=${A}`, [FIRST, FIRST], (_body, index) =>
      index === 1 ? first.promise : envelope(400, REJECTED),
    );
    await choose("推理强度", "中");
    await choose("权限", "每次都问");
    await screen.findByText(REJECTED);
    await quiesce();
    expect(asked(mounted)).toBe(1);

    await settleDeferredResponse(first, jsonResponse({ ...SESSION_A, reasoningEffort: "medium" }));
    await waitFor(() => expect(asked(mounted)).toBe(2));
    await quiesce();
    expect(asked(mounted)).toBe(2);
  });
});
