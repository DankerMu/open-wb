// 权限档位控件（session-permission-tier「权限档位控件」五条场景；chat-web「锁定时三个控件仍可用」的权限
// 部分）：按钮与单选菜单、`全部自动` 的确认框与警示色、提交与失败回退、欢迎态的选择进入创建请求、封顶与
// 继承的呈现，以及所有权 fence（为甲会话发起的提交与确认不落到乙会话）。
// seam：整页挂载 + 假 API。假 API 的列表、快照与 PATCH 读写同一份会话表，列表重读不会把显示值改回去。
// 期望文案取自规格条文。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  footerButton,
  HERO,
  mountWelcome,
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
import { pressPointer, yieldMacrotask } from "./ui-support.js";

type Mode = "always-ask" | "write" | "yolo";
type Patch = (held: SessionView, body: { approvalMode: Mode }) => Promise<Response> | Response;

const ASK = "每次都问";
const WRITE = "只问命令";
const YOLO = "全部自动";
const ITEMS = [
  `${ASK}写文件与执行命令前都要你确认`,
  `${WRITE}执行命令前要你确认，写文件不用`,
  `${YOLO}不经确认执行命令与修改文件`,
];
const FOOTNOTE = "更改从下一条消息起生效";
const CONFIRM_TITLE = "切换到全部自动？";
const CONFIRM_BODY = "助手将不经确认直接执行命令与修改文件。";
const WARNING = "text-(--wb-status-warning-text)";
const REJECTED = "这个档位不可用";
const OPTIONS = "/api/composer/options";

afterEach(cleanupSessionMeta);

/** 夹具的 `view` 把 `approvalMode` 钉成 `write`：别的档位在这里放宽该键。 */
function tiered(
  id: string,
  title: string,
  approvalMode: Mode,
  meta: Parameters<typeof view>[2] = {},
) {
  return { ...view(id, title, meta), approvalMode } as unknown as SessionView;
}

/** 缺省的 PATCH：像服务端那样写入请求的档位并返回视图。 */
const accept: Patch = (held, body) => jsonResponse({ ...held, approvalMode: body.approvalMode });

/**
 * 会话表与读写它的三条路由：列表、各会话的快照、`PATCH /api/sessions/<id>`。PATCH 的 200 响应体写回
 * 会话表（不是请求值），之后的列表与快照读到的就是它。
 */
function tierRoutes(sessions: readonly SessionView[], patch: Patch = accept): FetchRoutes {
  const held = new Map(sessions.map((session) => [session.id, session]));
  const read = (id: string) => held.get(id) as SessionView;
  const routes: FetchRoutes = {
    "/api/sessions": () => jsonResponse({ sessions: [...held.values()] }),
  };
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
      const body = JSON.parse(String(options?.body)) as { approvalMode: Mode };
      const response = await patch(read(id), body);
      if (response.ok) held.set(id, (await response.clone().json()) as SessionView);
      return response;
    };
  }
  return routes;
}

/** 整页挂载并选中会话 A（经 URL），等权限按钮出现。 */
async function mountSelected(
  sessions: readonly SessionView[],
  patch?: Patch,
  extra: FetchRoutes = {},
) {
  const mounted = mountSessions(`/?session=${A}`, [], { ...tierRoutes(sessions, patch), ...extra });
  await findTier();
  return mounted;
}

/** 页面内容的查询都带 `hidden`：菜单与确认框开着时页面其余部分是 `aria-hidden`。 */
function tier() {
  return screen.getByRole<HTMLButtonElement>("button", { hidden: true, name: /^权限：/ });
}

function queryTier() {
  return screen.queryByRole("button", { hidden: true, name: /^权限：/ });
}

function findTier() {
  return screen.findByRole("button", { name: /^权限：/ });
}

/** 按钮的可访问名、文字、`data-tier` 是否为 yolo、是否带警示色。 */
function shown() {
  const button = tier();
  return {
    name: button.getAttribute("aria-label"),
    text: button.textContent,
    yolo: button.getAttribute("data-tier") === "yolo",
    warning: button.classList.contains(WARNING),
  };
}

function plain(label: string) {
  return { name: `权限：${label}`, text: label, yolo: false, warning: false };
}

const WARNED = { name: `权限：${YOLO}`, text: YOLO, yolo: true, warning: true };

async function openTier() {
  pressPointer(tier());
  return screen.findByRole("menu");
}

function radios(menu: HTMLElement) {
  return within(menu).getAllByRole("menuitemradio");
}

/** 打开菜单并点选界面名为 `label` 的一项，等菜单关闭。 */
async function pick(label: string) {
  const menu = await openTier();
  const item = radios(menu).find((radio) => radio.textContent?.startsWith(label));
  if (!item) throw new Error(`菜单里没有 ${label}`);
  fireEvent.click(item);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

function confirmBox() {
  return screen.queryByRole("alertdialog", { name: CONFIRM_TITLE });
}

async function findConfirm() {
  return screen.findByRole("alertdialog", { name: CONFIRM_TITLE });
}

async function answer(name: "取消" | "确认切换") {
  fireEvent.click(within(await findConfirm()).getByRole("button", { name }));
  await waitFor(() => expect(confirmBox()).toBeNull());
}

/** 输入框工具行内的查询（`生成中` 之外页面上还有别的 `status`）。 */
function toolbar() {
  const element = document.querySelector<HTMLElement>('form [data-slot="composer-toolbar"]');
  if (!element) throw new Error("输入框没有工具栏");
  return within(element);
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

function deferredPatch() {
  let settle: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return {
    patch: (() => promise) as Patch,
    settle: (response: Response) =>
      act(async () => {
        settle(response);
        await promise;
      }),
  };
}

async function selectSession(nav: HTMLElement, title: string, id: string) {
  fireEvent.click(within(nav).getByRole("button", { name: title }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${id}`));
}

describe("权限档位控件：切换到全部自动要确认", () => {
  it("菜单恰三项带说明与底部提示；取消不发请求、按钮不变；确认切换恰一次 PATCH，按钮变为警示色的 权限：全部自动", async () => {
    const { fetchMock } = await mountSelected([view(A, "甲")]);
    expect(shown()).toEqual(plain(WRITE));

    const menu = await openTier();
    expect(radios(menu).map((radio) => radio.textContent)).toEqual(ITEMS);
    expect(radios(menu).map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(menu.textContent).toBe(`${ITEMS.join("")}${FOOTNOTE}`);
    expect(menu.lastElementChild?.tagName).toBe("P");
    expect(menu.lastElementChild?.textContent).toBe(FOOTNOTE);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await pick(YOLO);
    const box = await findConfirm();
    expect(within(box).getByText(CONFIRM_BODY, { exact: true })).toBeTruthy();
    expect(
      within(box)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["取消", "确认切换"]);
    // 点击遮罩不关闭，也不提交。
    const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
    if (!overlay) throw new Error("确认框没有遮罩");
    pressPointer(overlay);
    await quiesce();
    expect(confirmBox()).toBe(box);
    await answer("取消");
    await quiesce();
    expect(patchRequests(fetchMock, A)).toEqual([]);
    expect(mutations(fetchMock)).toEqual([]);
    expect(shown()).toEqual(plain(WRITE));

    await pick(YOLO);
    await answer("确认切换");
    await waitFor(() => expect(shown()).toEqual(WARNED));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"yolo"}')]);
    expect(alerts()).toEqual([]);
  });

  it("确认框开着时按 Esc：关闭、零请求、按钮不变，焦点回到权限按钮", async () => {
    const { fetchMock } = await mountSelected([view(A, "甲")]);
    let returned = 0;
    tier().addEventListener("focus", () => {
      returned += 1;
    });
    await pick(YOLO);
    const box = await findConfirm();
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true));
    // 菜单关闭时不把焦点还给按钮：确认框开着的这段时间焦点没有离开过它。
    await yieldMacrotask();
    expect(returned).toBe(0);
    expect(box.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(confirmBox()).toBeNull());
    await focusOn(tier());
    await quiesce();
    expect(mutations(fetchMock)).toEqual([]);
    expect(shown()).toEqual(plain(WRITE));
  });
});

describe("权限档位控件：其它档位直接生效与失败回退", () => {
  it("全部自动 → 每次都问 不弹确认框、恰一次 PATCH、警示色消失；随后的 400 就地显示信封文案，按钮仍是 权限：每次都问", async () => {
    const patch: Patch = (held, body) =>
      body.approvalMode === "write" ? envelope(400, REJECTED) : accept(held, body);
    const { fetchMock } = await mountSelected([tiered(A, "甲", "yolo")], patch);
    expect(shown()).toEqual(WARNED);

    await pick(ASK);
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));
    expect(confirmBox()).toBeNull();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"always-ask"}')]);
    expect(alerts()).toEqual([]);

    await pick(WRITE);
    await waitFor(() => expect(alerts()).toEqual([REJECTED]));
    await quiesce();
    expect(shown()).toEqual(plain(ASK));
    expect(tier().disabled).toBe(false);
    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"approvalMode":"always-ask"}'),
      patchOf('{"approvalMode":"write"}'),
    ]);
    const menu = await openTier();
    expect(radios(menu).map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // 下一次提交发起时清掉上一条失败文案。
    await pick(YOLO);
    await answer("确认切换");
    await waitFor(() => expect(shown()).toEqual(WARNED));
    expect(alerts()).toEqual([]);
  });

  it("PATCH 收到 401：交给既有的登录失效处理，进入登录页，不显示该失败", async () => {
    const unauthorized: Patch = () =>
      jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401);
    const { fetchMock } = await mountSelected([view(A, "甲")], unauthorized);

    await pick(ASK);

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await yieldMacrotask();
    expect(alerts()).toEqual([]);
    expect(queryTier()).toBeNull();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"always-ask"}')]);
  });

  it("响应视图与请求值不同：以响应为准", async () => {
    const clamp: Patch = (held) => jsonResponse({ ...held, approvalMode: "yolo" });
    const { fetchMock } = await mountSelected([view(A, "甲")], clamp);

    await pick(ASK);

    await waitFor(() => expect(shown()).toEqual(WARNED));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"always-ask"}')]);
    expect(confirmBox()).toBeNull();
  });

  it("选中当前档位：只关闭菜单，不发请求、不弹确认框", async () => {
    const { fetchMock } = await mountSelected([tiered(A, "甲", "yolo")]);

    await pick(YOLO);
    await quiesce();

    expect(confirmBox()).toBeNull();
    expect(mutations(fetchMock)).toEqual([]);
    expect(shown()).toEqual(WARNED);
    expect(tier().disabled).toBe(false);
  });

  it("提交在途时按钮禁用、点它不出菜单；落定后恢复，焦点回到按钮", async () => {
    const pending = deferredPatch();
    const { fetchMock } = await mountSelected([view(A, "甲")], pending.patch);

    await pick(ASK);
    await quiesce();
    expect(tier().disabled).toBe(true);
    expect(shown()).toEqual(plain(WRITE));
    pressPointer(tier());
    await quiesce();
    expect(screen.queryByRole("menu")).toBeNull();

    await pending.settle(jsonResponse({ ...view(A, "甲"), approvalMode: "always-ask" }));
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));
    expect(tier().disabled).toBe(false);
    await focusOn(tier());
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"always-ask"}')]);
  });
});

describe("权限档位控件：生成中可改", () => {
  function running() {
    return [view(A, "甲", { status: "running" })];
  }

  it("回合进行中选 每次都问：恰一次 PATCH，没有 prompt、stop 或其它请求；生成中 与 停止 不受影响", async () => {
    const { fetchMock } = await mountSelected(running());
    const stop = await screen.findByRole<HTMLButtonElement>("button", { name: "停止" });
    expect(stop.disabled).toBe(false);

    await pick(ASK);
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));

    expect(mutations(fetchMock)).toEqual([["PATCH", patchPath(A)]]);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"always-ask"}')]);
    expect(toolbar().getByRole("status").textContent).toBe("生成中");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "停止" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("锁定时仍可用：「+」与文本框禁用，权限按钮未禁用且能打开菜单，生成中 与 停止 照常显示", async () => {
    await mountSelected(running());
    await screen.findByRole("button", { name: "停止" });

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "添加文件或命令" }).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "给助手发消息" }).disabled,
    ).toBe(true);
    expect(tier().disabled).toBe(false);
    const menu = await openTier();
    expect(radios(menu)).toHaveLength(3);
    expect(toolbar().getByRole("status", { hidden: true }).textContent).toBe("生成中");
    expect(screen.getByRole("button", { hidden: true, name: "停止" })).toBeTruthy();
  });
});

describe("权限档位控件：欢迎态的选择进入创建请求", () => {
  it("选 每次都问 不发任何请求；首次发送的创建体带 approvalMode，建出的会话按钮是 权限：每次都问", async () => {
    const { fetchMock } = await mountWelcome();
    await findTier();
    expect(shown()).toEqual(plain(WRITE));
    await quiesce();
    const before = paths(fetchMock);

    await pick(ASK);
    await quiesce();
    expect(shown()).toEqual(plain(ASK));
    expect(tier().disabled).toBe(false);
    expect(paths(fetchMock)).toEqual(before);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","approvalMode":"always-ask"}'),
    ]);
    await quiesce();
    expect(shown()).toEqual(plain(ASK));
    expect(mutations(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
  });

  it("不碰权限控件直接发送：创建体不含 approvalMode 键", async () => {
    const { fetchMock } = await mountWelcome();
    await findTier();

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));

    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
  });

  it("欢迎态选 全部自动 同样先确认：取消后创建体不带该键；确认后按钮为警示色，创建体带 yolo，全程没有 PATCH", async () => {
    const { fetchMock } = await mountWelcome();
    await findTier();
    await quiesce();
    const before = paths(fetchMock);

    await pick(YOLO);
    await answer("取消");
    expect(shown()).toEqual(plain(WRITE));
    await pick(YOLO);
    expect(shown()).toEqual(plain(WRITE));
    await answer("确认切换");
    await waitFor(() => expect(shown()).toEqual(WARNED));
    await quiesce();
    expect(paths(fetchMock)).toEqual(before);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","approvalMode":"yolo"}'),
    ]);
    await quiesce();
    expect(shown()).toEqual(WARNED);
    expect(mutations(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
  });

  it("欢迎态取消确认后直接发送：创建体不含 approvalMode 键", async () => {
    const { fetchMock } = await mountWelcome();
    await findTier();

    await pick(YOLO);
    await answer("取消");
    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));

    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
  });

  it("缺省档位是 全部自动：欢迎态按钮直接是警示色的 权限：全部自动、没有确认框；选当前档位不弹框不发请求，创建体不含 approvalMode 键；回到欢迎态改选 只问命令 后创建体带 write", async () => {
    const { fetchMock, router } = mountSessions("/", [], {
      ...welcomeRoutes(),
      ...composerOptionsRoute({
        ...DEFAULT_COMPOSER_OPTIONS,
        defaults: { ...DEFAULT_COMPOSER_OPTIONS.defaults, approvalMode: "yolo" },
      }),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });
    await findTier();
    await quiesce();
    expect(shown()).toEqual(WARNED);
    expect(screen.queryAllByRole("alertdialog", { hidden: true })).toEqual([]);
    const before = paths(fetchMock);

    await pick(YOLO);
    await quiesce();
    expect(confirmBox()).toBeNull();
    expect(shown()).toEqual(WARNED);
    expect(paths(fetchMock)).toEqual(before);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);

    // 没选过档位：回到欢迎态仍取缺省档。
    await act(() => router.navigate("/", { replace: true }));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await waitFor(() => expect(shown()).toEqual(WARNED));
    await pick(WRITE);
    expect(shown()).toEqual(plain(WRITE));
    expect(confirmBox()).toBeNull();
    typeDraft("再来");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[1]}`));
    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office"}'),
      createOf('{"scene":"office","approvalMode":"write"}'),
    ]);
    expect(mutations(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
  });
});

describe("权限档位控件：封顶与继承的呈现", () => {
  const CAPPED = composerOptionsRoute({
    ...DEFAULT_COMPOSER_OPTIONS,
    approvalModes: ["always-ask", "write"],
  });

  it("可用档位只有两个：菜单恰两项，没有 全部自动", async () => {
    await mountSelected([view(A, "甲")], accept, CAPPED);

    const menu = await openTier();

    expect(radios(menu).map((radio) => radio.textContent)).toEqual(ITEMS.slice(0, 2));
    expect(menu.textContent).not.toContain(YOLO);
    expect(menu.textContent).toBe(`${ITEMS.slice(0, 2).join("")}${FOOTNOTE}`);
  });

  it("只有一个可用档位：控件仍渲染，菜单只含该项", async () => {
    await mountSelected([tiered(A, "甲", "always-ask")], accept, {
      ...composerOptionsRoute({
        ...DEFAULT_COMPOSER_OPTIONS,
        approvalModes: ["always-ask"],
        defaults: { ...DEFAULT_COMPOSER_OPTIONS.defaults, approvalMode: "always-ask" },
      }),
    });
    expect(shown()).toEqual(plain(ASK));

    const menu = await openTier();

    expect(radios(menu).map((radio) => radio.textContent)).toEqual(ITEMS.slice(0, 1));
  });

  it("继承而来的 全部自动：按钮直接是警示色的 权限：全部自动，没有确认框，没有请求", async () => {
    const { fetchMock } = await mountSelected([tiered(A, "甲", "yolo")]);
    await quiesce();

    expect(shown()).toEqual(WARNED);
    expect(screen.queryAllByRole("alertdialog", { hidden: true })).toEqual([]);
    expect(mutations(fetchMock)).toEqual([]);
  });

  it("会话的档位不在可用档位里：按钮如实显示会话的档位（全部自动 带警示色），菜单只列可用档位且没有选中项", async () => {
    const { fetchMock } = await mountSelected([tiered(A, "甲", "yolo")], accept, CAPPED);
    expect(shown()).toEqual(WARNED);

    const menu = await openTier();
    expect(radios(menu).map((radio) => radio.textContent)).toEqual(ITEMS.slice(0, 2));
    expect(radios(menu).map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ]);
    fireEvent.click(radios(menu)[1] as HTMLElement);

    await waitFor(() => expect(shown()).toEqual(plain(WRITE)));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"approvalMode":"write"}')]);
  });

  it("已选会话的视图还没解析出来（列表与快照都在途）：没有权限控件；列表到达后出现", async () => {
    let arrive: (response: Response) => void = () => {};
    const list = new Promise<Response>((resolve) => {
      arrive = resolve;
    });
    mountSessions(`/?session=${A}`, [], {
      "/api/sessions": () => list,
      [messagesPath(A)]: () => new Promise<Response>(() => {}),
    });
    await screen.findByRole("button", { name: "添加文件或命令" });
    await quiesce();
    expect(queryTier()).toBeNull();

    await act(async () => {
      arrive(jsonResponse({ sessions: [tiered(A, "甲", "always-ask")] }));
      await list;
    });

    await findTier();
    expect(shown()).toEqual(plain(ASK));
  });

  it("选项读取失败：能力行里没有权限控件，「+」、工作空间位与发送照常", async () => {
    mountSessions("/", [], {
      ...welcomeRoutes(),
      [OPTIONS]: () => envelope(503, "服务暂不可用"),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();

    expect(queryTier()).toBeNull();
    expect(screen.getByRole("button", { name: "添加文件或命令" })).toBeTruthy();
    expect(footerButton("任务启动于 未选择").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(alerts()).toEqual([]);
  });
});

describe("权限档位控件：所有权", () => {
  function pair() {
    return [view(A, "甲"), tiered(B, "乙", "always-ask")];
  }

  it("甲的 PATCH 挂起时切到乙：乙的按钮可用、显示乙的档位；甲的失败落定后全程没有提示，回到甲也没有，甲的档位不变", async () => {
    const pending = deferredPatch();
    const { fetchMock } = await mountSelected(pair(), pending.patch);
    const nav = await findList("乙");
    await pick(ASK);
    await quiesce();
    expect(tier().disabled).toBe(true);

    await selectSession(nav, "乙", B);
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));
    expect(tier().disabled).toBe(false);
    await pending.settle(envelope(400, REJECTED));
    await quiesce();
    expect(alerts()).toEqual([]);
    expect(shown()).toEqual(plain(ASK));
    expect(tier().disabled).toBe(false);

    await selectSession(nav, "甲", A);
    await waitFor(() => expect(shown()).toEqual(plain(WRITE)));
    await quiesce();
    expect(alerts()).toEqual([]);
    expect(tier().disabled).toBe(false);
    expect(patchRequests(fetchMock, A)).toHaveLength(1);
    expect(patchRequests(fetchMock, B)).toEqual([]);
  });

  it("甲的 PATCH 挂起时切到乙，随后 200：乙的按钮不变；回到甲显示响应里的档位", async () => {
    const pending = deferredPatch();
    await mountSelected(pair(), pending.patch);
    const nav = await findList("乙");
    await pick(YOLO);
    await answer("确认切换");
    await quiesce();

    await selectSession(nav, "乙", B);
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));
    await pending.settle(jsonResponse({ ...view(A, "甲"), approvalMode: "yolo" }));
    await quiesce();
    expect(shown()).toEqual(plain(ASK));

    await selectSession(nav, "甲", A);
    await waitFor(() => expect(shown()).toEqual(WARNED));
  });

  it("为甲打开的确认框不会提交到乙：换到乙后确认框已关闭，甲、乙都没有 PATCH，乙的档位不变", async () => {
    const { fetchMock, router } = await mountSelected(pair());
    await pick(YOLO);
    await findConfirm();

    await act(() => router.navigate(`/?session=${B}`));
    await waitFor(() => expect(shown()).toEqual(plain(ASK)));
    await quiesce();

    expect(screen.queryAllByRole("alertdialog", { hidden: true })).toEqual([]);
    expect(screen.queryByRole("button", { hidden: true, name: "确认切换" })).toBeNull();
    expect(mutations(fetchMock)).toEqual([]);
    expect(tier().disabled).toBe(false);
  });

  it("为甲打开的确认框，回到欢迎态后同样关闭：欢迎态的档位不变，随后的创建体不带 approvalMode", async () => {
    const { fetchMock, router } = mountSessions(`/?session=${A}`, [], {
      ...welcomeRoutes({ existing: [view(A, "甲")] }),
    });
    await findTier();
    await pick(YOLO);
    await findConfirm();

    await act(() => router.navigate("/", { replace: true }));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();

    expect(screen.queryAllByRole("alertdialog", { hidden: true })).toEqual([]);
    expect(shown()).toEqual(plain(WRITE));
    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    expect(mutations(fetchMock).filter(([method]) => method === "PATCH")).toEqual([]);
  });
});
