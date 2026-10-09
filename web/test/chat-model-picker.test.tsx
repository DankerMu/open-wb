// 模型与推理强度控件（model-selection「模型与推理强度控件」五条场景；chat-web「能力行的次序」「锁定时三个
// 控件仍可用」的模型与强度部分）：右组的两个按钮与单选菜单、已选会话的提交（body 恰一个键，以响应为准，
// 失败回退）、欢迎态的选择与换模型时强度的重算进入创建请求、长名字与选项缺失；以及能力行三个控件共用的
// 提交次序——同一会话只采用最后发出的那次设置提交的结果。
// seam：整页挂载 + 假 API。假 API 像服务端那样在收到 PATCH 时写入会话表（只写所给的键，原始强度保留；
// 视图的强度在模型不支持推理时为 null，原始强度为空时取模型缺省），响应可按序号挂起。期望文案取自规格条文。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComposerOptions } from "../src/lib/composer-contract.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  cleanupSessionMeta,
  envelope,
  findList,
  focusOn,
  messagesPath,
  mountSessions,
  patchOf,
  patchPath,
  patchRequests,
  REQUEST_FAILED,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import {
  composerOptionsRoute,
  currentLocation,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";
import { pressPointer } from "./ui-support.js";

type Effort = ComposerOptions["models"][number]["efforts"][number];
type Mode = ComposerOptions["approvalModes"][number];
type Body = { approvalMode?: Mode; modelId?: string; reasoningEffort?: Effort };
/** 服务端对第 `index` 次 PATCH（从 1 起）的裁决：返回 `Response` 即拒绝（不写表），不返回即照常写入。 */
type Decide = (body: Body, index: number) => Response | Error | undefined;

const ALL: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LONG_NAME = `${"超长模型名".repeat(12)}一二三四`;
const OPTIONS: ComposerOptions = {
  ...DEFAULT_COMPOSER_OPTIONS,
  models: [
    { id: "m1", name: "通用", reasoning: true, vision: false, efforts: ALL, defaultEffort: "high" },
    { id: "m2", name: "m2", reasoning: false, vision: false, efforts: [], defaultEffort: null },
    {
      id: "m3",
      name: "深度",
      reasoning: true,
      vision: true,
      efforts: ["off", "low", "high"],
      defaultEffort: "high",
    },
  ],
  defaults: { approvalMode: "write", modelId: "m1", reasoningEffort: "xhigh" },
};
const OPTIONS_PATH = "/api/composer/options";
const REJECTED = "这个模型不可用";

afterEach(cleanupSessionMeta);

/** 夹具的 `view` 把模型钉成 `m1`、强度钉成 null：这里放宽这两个键（与档位）。 */
function chosen(
  id: string,
  title: string,
  modelId: string,
  reasoningEffort: Effort | null,
  rest: Parameters<typeof view>[2] & { approvalMode?: Mode } = {},
) {
  const { approvalMode = "write", ...meta } = rest;
  return {
    ...view(id, title, meta),
    approvalMode,
    modelId,
    reasoningEffort,
  } as unknown as SessionView;
}

/**
 * 会话表与读写它的三条路由。PATCH 在到达时裁决并写表（服务端的规则见文首），`hold(index)` 只推迟
 * 响应的送达——后发的请求可以先得到响应。
 */
function pickerRoutes(
  sessions: readonly SessionView[],
  decide: Decide = () => undefined,
  hold: (index: number) => Promise<void> | void = () => {},
): FetchRoutes {
  const held = new Map(
    sessions.map((session) => [
      session.id,
      { raw: session.reasoningEffort as Effort | null, view: session },
    ]),
  );
  const read = (id: string) => (held.get(id) as { view: SessionView }).view;
  const routes: FetchRoutes = {
    "/api/sessions": () => jsonResponse({ sessions: sessions.map(({ id }) => read(id)) }),
  };
  let count = 0;
  for (const { id } of sessions) {
    routes[messagesPath(id)] = () =>
      jsonResponse({
        ...chatSnapshot({
          assistantStatus: read(id).status === "running" ? "running" : "done",
          content: "回答",
        }),
        session: read(id),
      });
    routes[patchPath(id)] = async (_path, options) => {
      count += 1;
      const index = count;
      const body = JSON.parse(String(options?.body)) as Body;
      const refused = decide(body, index);
      let response = refused;
      if (refused === undefined) {
        const row = held.get(id) as { raw: Effort | null; view: SessionView };
        const raw = body.reasoningEffort ?? row.raw;
        const next = { ...row.view, ...body };
        const model = OPTIONS.models.find((item) => item.id === next.modelId);
        const stored = {
          ...next,
          reasoningEffort: model?.reasoning ? (raw ?? model.defaultEffort) : null,
        } as unknown as SessionView;
        held.set(id, { raw, view: stored });
        response = jsonResponse(stored);
      }
      await hold(index);
      if (response instanceof Error) throw response;
      return response as Response;
    };
  }
  return routes;
}

/** 按序号放行响应的闸：`release(n)` 让第 n 次 PATCH 的响应送达并等页面消化。 */
function gates() {
  const opened = new Map<number, () => void>();
  const waits = new Map<number, Promise<void>>();
  const hold = (index: number) => {
    const wait = new Promise<void>((resolve) => opened.set(index, resolve));
    waits.set(index, wait);
    return wait;
  };
  const release = (index: number) =>
    act(async () => {
      opened.get(index)?.();
      await waits.get(index);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  return { hold, release };
}

/** 整页挂载（三模型选项）并选中会话 A，等模型按钮出现。 */
async function mountSelected(
  sessions: readonly SessionView[],
  decide?: Decide,
  hold?: (index: number) => Promise<void> | void,
  extra: FetchRoutes = {},
) {
  const mounted = mountSessions(`/?session=${A}`, [], {
    ...composerOptionsRoute(OPTIONS),
    ...pickerRoutes(sessions, decide, hold),
    ...extra,
  });
  await screen.findByRole("button", { name: /^模型：/ });
  return mounted;
}

/** 欢迎态（`options` 缺省为三模型选项），等模型按钮出现。 */
async function mountWelcomeWith(options: ComposerOptions = OPTIONS) {
  const mounted = mountSessions("/", [], { ...welcomeRoutes(), ...composerOptionsRoute(options) });
  await screen.findByRole("heading", { level: 1, name: HERO });
  await screen.findByRole("button", { name: /^模型：/ });
  return mounted;
}

/** 页面内容的查询都带 `hidden`：菜单开着时页面其余部分是 `aria-hidden`。 */
function control(kind: "模型" | "推理强度" | "权限") {
  return screen.queryByRole<HTMLButtonElement>("button", {
    hidden: true,
    name: new RegExp(`^${kind}：`),
  });
}

function button(kind: "模型" | "推理强度" | "权限") {
  const found = control(kind);
  if (!found) throw new Error(`没有${kind}控件`);
  return found;
}

/** 三个控件的可访问名（没有的为 null），按 模型、强度、权限。 */
function names() {
  return (["模型", "推理强度", "权限"] as const).map(
    (kind) => control(kind)?.getAttribute("aria-label") ?? null,
  );
}

/** 模型与强度按钮各自的 `[可访问名, 文字]`；没有强度控件时第二项为 null。 */
function shown() {
  return (["模型", "推理强度"] as const).map((kind) => {
    const found = control(kind);
    return found ? [found.getAttribute("aria-label"), found.textContent] : null;
  });
}

function both(model: string, effort: string | null) {
  return [[`模型：${model}`, model], effort === null ? null : [`推理强度：${effort}`, effort]];
}

async function open(kind: "模型" | "推理强度" | "权限") {
  pressPointer(button(kind));
  return screen.findByRole("menu");
}

function radios(menu: HTMLElement) {
  return within(menu).getAllByRole("menuitemradio");
}

function checks(menu: HTMLElement) {
  return radios(menu).map((radio) => radio.getAttribute("aria-checked"));
}

async function close(menu: HTMLElement) {
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 打开 `kind` 的菜单并点选文字以 `label` 开头的一项，等菜单关闭。 */
async function pick(kind: "模型" | "推理强度" | "权限", label: string) {
  const menu = await open(kind);
  const item = radios(menu).find((radio) => radio.textContent?.startsWith(label));
  if (!item) throw new Error(`菜单里没有 ${label}`);
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

function alerts() {
  return screen.queryAllByRole("alert", { hidden: true }).map((alert) => alert.textContent);
}

/** 除 GET 之外的全部请求的 `[method, path]`。 */
function mutations(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([, options]) => (options?.method ?? "GET") !== "GET")
    .map(([path, options]) => [options?.method, path]);
}

/** 工具行右组的子元素。 */
function actions() {
  const group = document.querySelector<HTMLElement>(
    'form [data-slot="composer-toolbar"] > [data-slot="composer-actions"]',
  );
  if (!group) throw new Error("工具行没有右组");
  return Array.from(group.children);
}

async function sendFirst(fetchMock: FetchMock) {
  typeDraft("你好");
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
  return createRequests(fetchMock);
}

describe("模型与推理强度控件：切换模型与强度", () => {
  it("初始为 模型：通用 与 推理强度：高；模型菜单恰三项带能力标签；选 深度、低、m2 各恰一次 PATCH 且 body 恰一个键；最后没有强度控件", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m1", "high")]);
    expect(shown()).toEqual(both("通用", "高"));
    expect(actions()).toEqual([
      button("模型"),
      button("推理强度"),
      screen.getByRole("button", { name: "发送" }),
    ]);

    const models = await open("模型");
    expect(radios(models).map((radio) => radio.textContent)).toEqual([
      "通用推理",
      "m2",
      "深度推理看图",
    ]);
    expect(models.textContent).toBe("通用推理m2深度推理看图");
    expect(checks(models)).toEqual(["true", "false", "false"]);
    await close(models);
    const efforts = await open("推理强度");
    expect(radios(efforts).map((radio) => radio.textContent)).toEqual([
      "关闭",
      "极低",
      "低",
      "中",
      "高",
      "很高",
      "最高",
    ]);
    expect(checks(efforts)).toEqual(["false", "false", "false", "false", "true", "false", "false"]);
    await close(efforts);

    await pick("模型", "深度");
    await waitFor(() => expect(shown()).toEqual(both("深度", "高")));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
    const narrowed = await open("推理强度");
    expect(radios(narrowed).map((radio) => radio.textContent)).toEqual(["关闭", "低", "高"]);
    expect(checks(narrowed)).toEqual(["false", "false", "true"]);
    await close(narrowed);

    await pick("推理强度", "低");
    await waitFor(() => expect(shown()).toEqual(both("深度", "低")));
    await pick("模型", "m2");
    await waitFor(() => expect(shown()).toEqual(both("m2", null)));

    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"modelId":"m3"}'),
      patchOf('{"reasoningEffort":"low"}'),
      patchOf('{"modelId":"m2"}'),
    ]);
    expect(mutations(fetchMock)).toHaveLength(3);
    expect(actions()).toEqual([button("模型"), screen.getByRole("button", { name: "发送" })]);
    const last = await open("模型");
    expect(checks(last)).toEqual(["false", "true", "false"]);
    expect(alerts()).toEqual([]);
  });

  it("当前强度不在模型的可选强度里：按钮照常是 推理强度：很高，菜单恰三项且没有选中项；选 高 恰一次 PATCH", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m3", "xhigh")]);
    expect(shown()).toEqual(both("深度", "很高"));

    const menu = await open("推理强度");
    expect(radios(menu).map((radio) => radio.textContent)).toEqual(["关闭", "低", "高"]);
    expect(checks(menu)).toEqual(["false", "false", "false"]);
    fireEvent.click(radios(menu)[2] as HTMLElement);

    await waitFor(() => expect(shown()).toEqual(both("深度", "高")));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"reasoningEffort":"high"}')]);
  });

  it("换到可选强度不同的模型：只发 modelId，不在客户端重算；显示的是响应里的强度（原值，在新模型的集合之外）", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m1", "xhigh")]);

    await pick("模型", "深度");

    await waitFor(() => expect(shown()).toEqual(both("深度", "很高")));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
    expect(checks(await open("推理强度"))).toEqual(["false", "false", "false"]);
  });

  it("从不支持推理的模型换到支持推理的：只发 modelId，强度控件按响应出现", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m2", null)]);
    expect(shown()).toEqual(both("m2", null));

    await pick("模型", "深度");

    await waitFor(() => expect(shown()).toEqual(both("深度", "高")));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
  });

  it("选中当前模型、当前强度：只关闭菜单，不发请求，按钮可用", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m1", "high")]);

    await pick("模型", "通用");
    await pick("推理强度", "高");
    await quiesce();

    expect(mutations(fetchMock)).toEqual([]);
    expect(shown()).toEqual(both("通用", "高"));
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);
  });

  it("提交在途时两个按钮都禁用、显示值不变、点它们不出菜单，权限按钮不受影响；落定后恢复，焦点回到发起的按钮", async () => {
    const gate = gates();
    await mountSelected([chosen(A, "甲", "m1", "high")], undefined, gate.hold);

    await pick("推理强度", "低");
    await quiesce();
    expect(button("模型").disabled).toBe(true);
    expect(button("推理强度").disabled).toBe(true);
    expect(button("权限").disabled).toBe(false);
    expect(shown()).toEqual(both("通用", "高"));
    pressPointer(button("模型"));
    pressPointer(button("推理强度"));
    await quiesce();
    expect(screen.queryByRole("menu")).toBeNull();

    await gate.release(1);
    await waitFor(() => expect(shown()).toEqual(both("通用", "低")));
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);
    await focusOn(button("推理强度"));
  });

  it("推理模型而视图的强度为 null：没有强度控件", async () => {
    await mountSelected([chosen(A, "甲", "m1", null)]);
    await quiesce();

    expect(shown()).toEqual(both("通用", null));
  });
});

describe("模型与推理强度控件：生成中可改且不影响在途回合", () => {
  it("回合进行中「+」与文本框禁用，模型与强度可用；选另一个模型恰一次 PATCH，没有 prompt、stop、regenerate；右组为 模型、强度、生成中、停止", async () => {
    const { fetchMock } = await mountSelected([
      chosen(A, "甲", "m1", "high", { status: "running" }),
    ]);
    const stop = await screen.findByRole<HTMLButtonElement>("button", { name: "停止" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "添加文件或命令" }).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "给助手发消息" }).disabled,
    ).toBe(true);
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);
    await close(await open("推理强度"));

    await pick("模型", "深度");
    await waitFor(() => expect(shown()).toEqual(both("深度", "高")));

    expect(mutations(fetchMock)).toEqual([["PATCH", patchPath(A)]]);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
    const [status, ...rest] = actions().slice(2);
    expect(actions().slice(0, 2)).toEqual([button("模型"), button("推理强度")]);
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("生成中");
    expect(rest).toEqual([stop]);
    expect(stop.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });
});

describe("模型与推理强度控件：失败回退", () => {
  it("400 信封：输入框上显示信封文案，两个按钮的文字不变且恢复可用", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m1", "high")], () =>
      envelope(400, REJECTED),
    );

    await pick("模型", "深度");

    await waitFor(() => expect(alerts()).toEqual([REJECTED]));
    await quiesce();
    expect(shown()).toEqual(both("通用", "高"));
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"modelId":"m3"}')]);
    expect(checks(await open("模型"))).toEqual(["true", "false", "false"]);
  });

  it("网络异常：显示 request_failed 的安全文案，两个按钮的文字不变且恢复可用；下一次提交清掉它", async () => {
    const { fetchMock } = await mountSelected([chosen(A, "甲", "m1", "high")], (_body, index) =>
      index === 1 ? new TypeError("network down") : undefined,
    );

    await pick("推理强度", "低");

    await waitFor(() => expect(alerts()).toEqual([REQUEST_FAILED]));
    await quiesce();
    expect(shown()).toEqual(both("通用", "高"));
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);

    await pick("推理强度", "低");
    await waitFor(() => expect(shown()).toEqual(both("通用", "低")));
    expect(alerts()).toEqual([]);
    expect(patchRequests(fetchMock, A)).toHaveLength(2);
  });
});

describe("模型与推理强度控件：欢迎态的选择", () => {
  it("缺省 通用 / 很高；选 深度 强度变 高，选 m2 没有强度控件，选回 通用 强度是其缺省 高；全程没有请求；创建体带 modelId 与 reasoningEffort", async () => {
    const { fetchMock } = await mountWelcomeWith();
    expect(shown()).toEqual(both("通用", "很高"));
    await quiesce();
    const before = paths(fetchMock);

    await pick("模型", "深度");
    expect(shown()).toEqual(both("深度", "高"));
    expect(button("模型").disabled).toBe(false);
    await pick("模型", "m2");
    expect(shown()).toEqual(both("m2", null));
    await pick("模型", "通用");
    expect(shown()).toEqual(both("通用", "高"));
    await quiesce();
    expect(paths(fetchMock)).toEqual(before);

    expect(await sendFirst(fetchMock)).toEqual([
      createOf('{"scene":"office","modelId":"m1","reasoningEffort":"high"}'),
    ]);
    // 首次发送后（回合进行中）右组仍恰一个模型按钮：它与停止键是兄弟节点，两者的 key 不得相撞。
    await screen.findByRole("button", { name: "停止" });
    await quiesce();
    expect(actions().map((child) => child.getAttribute("aria-label") ?? child.textContent)).toEqual(
      ["模型：通用", "生成中", "停止"],
    );
    expect(mutations(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
  });

  it("只把强度从 很高 改为 低：创建体带 reasoningEffort、不带 modelId", async () => {
    const { fetchMock } = await mountWelcomeWith();
    await quiesce();
    const before = paths(fetchMock);

    await pick("推理强度", "低");
    expect(shown()).toEqual(both("通用", "低"));
    await quiesce();
    expect(paths(fetchMock)).toEqual(before);

    expect(await sendFirst(fetchMock)).toEqual([
      createOf('{"scene":"office","reasoningEffort":"low"}'),
    ]);
  });

  it("不碰两个控件，或只点选当前的模型与强度：创建体两个键都不带", async () => {
    const { fetchMock } = await mountWelcomeWith();

    await pick("模型", "通用");
    await pick("推理强度", "很高");

    expect(await sendFirst(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
  });

  it("先选强度 低 再选 m2：创建体带 modelId、没有 reasoningEffort 键", async () => {
    const { fetchMock } = await mountWelcomeWith();

    await pick("推理强度", "低");
    await pick("模型", "m2");
    expect(shown()).toEqual(both("m2", null));

    expect(await sendFirst(fetchMock)).toEqual([createOf('{"scene":"office","modelId":"m2"}')]);
  });

  it("原强度在新模型的可选强度里则保留：先选 低 再选 深度，创建体是 m3 与 low；选中会话再回来选择仍在", async () => {
    const mounted = mountSessions("/", [], {
      ...welcomeRoutes({ existing: [chosen(A, "甲", "m2", null)] }),
      ...composerOptionsRoute(OPTIONS),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });
    await screen.findByRole("button", { name: /^模型：/ });

    await pick("推理强度", "低");
    await pick("模型", "深度");
    expect(shown()).toEqual(both("深度", "低"));
    fireEvent.click(within(await findList("甲")).getByRole("button", { name: "甲" }));
    await waitFor(() => expect(shown()).toEqual(both("m2", null)));
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(shown()).toEqual(both("深度", "低"));

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    // 键按选择的先后写入（先选的强度在前）。
    expect(createRequests(mounted.fetchMock)).toEqual([
      createOf('{"scene":"office","reasoningEffort":"low","modelId":"m3"}'),
    ]);
  });
});

describe("模型与推理强度控件：长名字与选项缺失", () => {
  it("64 个码点的名字：title 是完整名字，按钮有最大宽度、内层文字截断；发送仍在右组、工具行与输入卡之内", async () => {
    expect(Array.from(LONG_NAME)).toHaveLength(64);
    const [first, ...others] = OPTIONS.models;
    await mountWelcomeWith({
      ...OPTIONS,
      models: [{ ...(first as (typeof OPTIONS.models)[number]), name: LONG_NAME }, ...others],
    });

    const model = button("模型");
    expect(model.getAttribute("aria-label")).toBe(`模型：${LONG_NAME}`);
    expect(model.title).toBe(LONG_NAME);
    for (const name of ["max-w-40", "min-w-0"]) {
      expect(model.classList.contains(name)).toBe(true);
    }
    const text = within(model).getByText(LONG_NAME, { exact: true });
    expect(text.tagName).toBe("SPAN");
    for (const name of ["min-w-0", "truncate"]) {
      expect(text.classList.contains(name)).toBe(true);
    }
    const send = screen.getByRole("button", { name: "发送" });
    expect(actions()).toEqual([model, button("推理强度"), send]);
    const group = send.parentElement as HTMLElement;
    expect(group.classList.contains("flex-none")).toBe(true);
    const toolbar = group.parentElement as HTMLElement;
    expect(toolbar.getAttribute("data-slot")).toBe("composer-toolbar");
    expect(toolbar.parentElement?.getAttribute("data-slot")).toBe("composer-card");
    expect(Array.from(toolbar.children, (child) => child.getAttribute("data-slot"))).toEqual([
      "composer-capabilities",
      "composer-actions",
    ]);
  });

  it("会话的 modelId 不在选项里：按钮的文字、可访问名与 title 都是该 id 原文，没有强度控件，菜单没有选中项", async () => {
    mountSessions(`/?session=${A}`, [], pickerRoutes([chosen(A, "甲", "m1", "high")]));
    await screen.findByRole("button", { name: /^模型：/ });
    await quiesce();

    expect(shown()).toEqual(both("m1", null));
    expect(button("模型").title).toBe("m1");
    const menu = await open("模型");
    expect(radios(menu).map((radio) => radio.textContent)).toEqual(["deepseek-v4.1-flash推理"]);
    expect(checks(menu)).toEqual(["false"]);
  });

  it("选项读取失败：两个控件都不渲染，右组只有发送，没有错误提示", async () => {
    mountSessions(`/?session=${A}`, [], {
      ...pickerRoutes([chosen(A, "甲", "m1", "high")]),
      [OPTIONS_PATH]: () => envelope(503, "服务暂不可用"),
    });
    const send = await screen.findByRole("button", { name: "发送" });
    await quiesce();

    expect(names()).toEqual([null, null, null]);
    expect(actions()).toEqual([send]);
    expect(alerts()).toEqual([]);
  });

  it("已选会话的视图还没解析出来（列表与快照都在途）：没有模型与强度控件", async () => {
    mountSessions(`/?session=${A}`, [], {
      ...composerOptionsRoute(OPTIONS),
      "/api/sessions": () => new Promise<Response>(() => {}),
      [messagesPath(A)]: () => new Promise<Response>(() => {}),
    });
    await screen.findByRole("button", { name: "添加文件或命令" });
    await quiesce();

    expect(names()).toEqual([null, null, null]);
  });
});

describe("能力行控件的提交次序：同一会话只采用最后发出的那次", () => {
  function pair() {
    return [chosen(A, "甲", "m1", "high"), chosen(B, "乙", "m2", null)];
  }

  async function select(nav: HTMLElement, title: string, id: string) {
    fireEvent.click(within(nav).getByRole("button", { name: title }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${id}`));
  }

  it("甲的第一次提交（每次都问）挂起 → 切到乙 → 回到甲再提交 全部自动 并得到响应 → 第一次的响应迟到：按钮仍是 权限：全部自动", async () => {
    const gate = gates();
    const { fetchMock } = await mountSelected(pair(), undefined, (index) =>
      index === 1 ? gate.hold(index) : undefined,
    );
    const nav = await findList("乙");
    await pick("权限", "每次都问");
    await quiesce();
    expect(button("权限").disabled).toBe(true);

    await select(nav, "乙", B);
    await waitFor(() => expect(names()).toEqual(["模型：m2", null, "权限：只问命令"]));
    await select(nav, "甲", A);
    await waitFor(() => expect(names()).toEqual(["模型：通用", "推理强度：高", "权限：只问命令"]));
    expect(button("权限").disabled).toBe(false);
    await pick("权限", "全部自动");
    fireEvent.click(await screen.findByRole("button", { name: "确认切换" }));
    await waitFor(() => expect(names()[2]).toBe("权限：全部自动"));

    await gate.release(1);
    await quiesce();

    expect(names()).toEqual(["模型：通用", "推理强度：高", "权限：全部自动"]);
    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"approvalMode":"always-ask"}'),
      patchOf('{"approvalMode":"yolo"}'),
    ]);
    expect(alerts()).toEqual([]);
  });

  it("甲的模型提交挂起时切到乙：乙的两个控件可用、显示乙的值；甲的响应落定后乙不变，回到甲显示响应里的模型", async () => {
    const gate = gates();
    await mountSelected(
      [chosen(A, "甲", "m1", "high"), chosen(B, "乙", "m3", "low")],
      undefined,
      gate.hold,
    );
    const nav = await findList("乙");
    await pick("模型", "m2");
    await quiesce();
    expect(button("模型").disabled).toBe(true);

    await select(nav, "乙", B);
    await waitFor(() => expect(shown()).toEqual(both("深度", "低")));
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);
    await gate.release(1);
    await quiesce();
    expect(shown()).toEqual(both("深度", "低"));

    await select(nav, "甲", A);
    await waitFor(() => expect(shown()).toEqual(both("m2", null)));
    expect(button("模型").disabled).toBe(false);
  });

  it("同一会话的模型提交与权限提交同时在途、响应逆序到达：三个键都以后发出的那次的响应为准", async () => {
    const gate = gates();
    const { fetchMock } = await mountSelected(pair(), undefined, gate.hold);

    await pick("模型", "m2");
    await pick("权限", "每次都问");
    await quiesce();
    expect(button("模型").disabled).toBe(true);
    expect(button("权限").disabled).toBe(true);
    expect(names()).toEqual(["模型：通用", "推理强度：高", "权限：只问命令"]);

    // 后发出的权限提交先得到响应：它的视图已含先到达服务端的模型改动。
    await gate.release(2);
    await waitFor(() => expect(names()).toEqual(["模型：m2", null, "权限：每次都问"]));
    expect(button("权限").disabled).toBe(false);
    expect(button("模型").disabled).toBe(true);
    // 先发出的模型提交的响应迟到：它的视图里档位还是旧的，不得写回。
    await gate.release(1);
    await quiesce();

    expect(names()).toEqual(["模型：m2", null, "权限：每次都问"]);
    expect(button("模型").disabled).toBe(false);
    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"modelId":"m2"}'),
      patchOf('{"approvalMode":"always-ask"}'),
    ]);
    expect(alerts()).toEqual([]);
  });

  it("先发出的那次迟到且失败：没有提示，显示值不变，按钮恢复可用；后发出的那次失败照常提示", async () => {
    const gate = gates();
    await mountSelected(
      pair(),
      (_body, index) => (index === 2 ? undefined : envelope(400, REJECTED)),
      gate.hold,
    );

    await pick("模型", "深度");
    await pick("权限", "每次都问");
    await gate.release(2);
    await waitFor(() => expect(names()[2]).toBe("权限：每次都问"));
    await gate.release(1);
    await quiesce();

    expect(alerts()).toEqual([]);
    expect(names()).toEqual(["模型：通用", "推理强度：高", "权限：每次都问"]);
    expect(button("模型").disabled).toBe(false);
    expect(button("推理强度").disabled).toBe(false);

    await pick("推理强度", "低");
    await gate.release(3);
    await waitFor(() => expect(alerts()).toEqual([REJECTED]));
    expect(names()).toEqual(["模型：通用", "推理强度：高", "权限：每次都问"]);
  });
});
