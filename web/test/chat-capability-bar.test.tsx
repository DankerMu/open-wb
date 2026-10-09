// 能力行（chat-web「输入框与能力栏」、session-sidebar「composer footer 工作空间选择」）：已选会话的工作空间位
// 是只读标签的四种文案（临时空间的判定在最前，不看工作空间列表），回到欢迎态后是可操作的选择器；左组次序
// 是「+」、工作空间、权限档位，右组是模型、推理强度、`发送`（三个控件在输入框选项取得后才有）；能力行没有
// 专家与麦克风控件。临时空间会话以其 workspaceId 取命令目录与项目配置。窄屏的换行与截断只断言类名与结构
// （jsdom 不排版）。选项读取失败后没有这三个控件，重取成功后出现。
// seam：整页挂载 + 假 API。期望文案取自规格条文。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  C,
  cleanupSessionMeta,
  envelope,
  findList,
  messagesPath,
  mountSessions,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { cardChildren, cataloguePaths, commandsOf, type } from "./chat-page-slash-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  footerButton,
  HERO,
  leaveForWelcome,
  mountWelcome,
  openExistingSession,
  openPicker,
  options,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickOption,
  queryFooterButton,
  SUPPORT_OPTION,
  TEMP_WORKSPACE_IDS,
  workspaceList,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import { currentLocation, type FetchMock, jsonResponse, paths } from "./support.js";
import { pressPointer } from "./ui-support.js";

const D = "d".repeat(32);
const GONE = "9".repeat(32);
/** 临时空间的 id：不在任何一次 `GET /api/workspaces` 的返回里。 */
const TEMP = "7".repeat(32);
const CONFIG = "/api/project-config";
const OPTIONS = "/api/composer/options";
const PLUS = "添加文件或命令";
const TIER = "权限：只问命令";
/** 缺省选项的那个模型与它的缺省强度：欢迎态的右组，以及用它建的会话。 */
const MODEL = "模型：deepseek-v4.1-flash";
const EFFORT = "推理强度：高";
const PICKED = [MODEL, EFFORT];
/** 夹具会话的 `m1` 不在缺省选项里：按钮退为 id 原文，没有强度控件。 */
const UNLISTED = ["模型：m1"];
/** 名称长到窄屏必然截断的工作空间。 */
const LONG = {
  ...PROJECT_A,
  id: "5".repeat(32),
  name: "一个名字很长很长很长很长很长很长的工作空间",
};

afterEach(cleanupSessionMeta);

/** 夹具的 `view` 把 `workspaceId` 钉成 null：绑定会话在这里放宽该键。 */
function bound(id: string, title: string, workspaceId: string) {
  return { ...view(id, title), workspaceId } as unknown as SessionView;
}

/** 四个会话：绑定 项目A、未绑定、绑定一个不在列表里的空间、用临时空间（同样不在列表里）。 */
function sessions(): SessionView[] {
  return [
    bound(A, "绑定会话", PROJECT_A.id),
    view(B, "未绑定会话"),
    bound(C, "空间已删", GONE),
    view(D, "临时会话", { temporaryWorkspace: true, workspaceId: TEMP }),
  ];
}

function workspaceSlot() {
  const slot = document.querySelector('form [data-slot="composer-workspace"]');
  if (!(slot instanceof HTMLElement)) throw new Error("能力栏没有工作空间位");
  return slot;
}

/** 只读标签：文本恰为 `text`，其内没有任何可操作元素，页面上也没有选择器按钮。 */
async function expectReadOnly(text: string) {
  await waitFor(() => expect(workspaceSlot().textContent).toBe(text));
  expect(within(workspaceSlot()).queryAllByRole("button")).toEqual([]);
  expect(workspaceSlot().querySelector("a, input, select, [tabindex]")).toBeNull();
  expect(queryFooterButton()).toBeNull();
  expect(screen.queryByRole("dialog", { name: "选择工作空间" })).toBeNull();
}

/** 工具行的两个子元素：左组（能力栏）与右组（`生成中`、`停止` / `发送`）。 */
function toolbarGroups() {
  const toolbar = composer().closest("form")?.querySelector('[data-slot="composer-toolbar"]');
  if (!(toolbar instanceof HTMLElement)) throw new Error("输入框没有工具栏");
  expect(Array.from(toolbar.children, (child) => child.getAttribute("data-slot"))).toEqual([
    "composer-capabilities",
    "composer-actions",
  ]);
  const [left, right] = Array.from(toolbar.children) as [HTMLElement, HTMLElement];
  return { left, right, toolbar };
}

/**
 * 左组恰为「+」按钮、工作空间位与可访问名为 `tier` 的权限按钮（`tier` 为 null 即没有权限控件，左组恰两项），
 * 右组恰为可访问名依次为 `picker` 的模型与强度按钮（空数组即没有这两个控件）再加 `发送`；工具行里没有错误提示。
 */
function expectOrder(tier: string | null, picker: readonly string[]) {
  const { left, right, toolbar } = toolbarGroups();
  expect(Array.from(left.children)).toEqual([
    within(toolbar).getByRole("button", { name: PLUS }),
    workspaceSlot(),
    ...(tier === null ? [] : [within(toolbar).getByRole("button", { name: tier })]),
  ]);
  expect(within(toolbar).queryAllByRole("button", { name: /^权限：/ })).toHaveLength(
    tier === null ? 0 : 1,
  );
  expect(Array.from(right.children)).toEqual([
    ...picker.map((name) => within(toolbar).getByRole("button", { name })),
    within(toolbar).getByRole("button", { name: "发送" }),
  ]);
  expect(within(toolbar).queryAllByRole("button", { name: /^(模型|推理强度)：/ })).toHaveLength(
    picker.length,
  );
  expect(within(toolbar).queryAllByRole("alert")).toEqual([]);
}

function optionsRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path === OPTIONS).length;
}

function mutations(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([, options]) => (options?.method ?? "GET") !== "GET");
}

describe("能力栏：已选会话工作空间只读", () => {
  it("绑定 / 未绑定 / 绑定的空间不在列表里 / 临时空间 → 四种只读文案；回欢迎态后是选择器，全程没有修改请求", async () => {
    const mounted = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    const nav = await findList("绑定会话");

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    await openExistingSession(nav, "未绑定会话", B);
    await expectReadOnly("任务启动于 未绑定");
    await openExistingSession(nav, "空间已删", C);
    await expectReadOnly("任务启动于 已绑定空间");
    await openExistingSession(nav, "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");

    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    const trigger = footerButton("任务启动于 未选择");
    expect(trigger.disabled).toBe(false);
    expect(workspaceSlot().contains(trigger)).toBe(true);
    expect(mutations(mounted.fetchMock)).toEqual([]);
  });

  it("点击只读标签：不出现弹层，没有新请求", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    await openExistingSession(await findList("绑定会话"), "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    await quiesce();
    const before = paths(fetchMock);
    const text = within(workspaceSlot()).getByText("任务启动于 项目A", { exact: true });

    for (const target of [text, workspaceSlot()]) {
      pressPointer(target);
      fireEvent.keyDown(target, { key: "Enter" });
    }
    await quiesce();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "搜索工作空间" })).toBeNull();
    expect(workspaceSlot().textContent).toBe("任务启动于 项目A");
    expect(paths(fetchMock)).toEqual(before);
  });

  it("工作空间列表读取失败：绑定会话显示 任务启动于 已绑定空间，未绑定会话仍是 任务启动于 未绑定，临时空间会话仍是 任务启动于 临时空间", async () => {
    mountSessions("/", sessions(), { "/api/workspaces": () => envelope(503, "服务暂不可用") });
    const nav = await findList("绑定会话");

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 已绑定空间");
    await openExistingSession(nav, "未绑定会话", B);
    await expectReadOnly("任务启动于 未绑定");
    await openExistingSession(nav, "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");
  });

  it("点击临时空间的只读标签：不出现弹层，没有新请求", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    await openExistingSession(await findList("临时会话"), "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");
    await quiesce();
    const before = paths(fetchMock);

    pressPointer(within(workspaceSlot()).getByText("任务启动于 临时空间", { exact: true }));
    await quiesce();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(paths(fetchMock)).toEqual(before);
  });
});

describe("能力栏：临时空间会话", () => {
  it("未选择空间发送：创建请求不带 workspaceId，返回临时空间会话后标签是 任务启动于 临时空间，条目在 临时空间 分组", async () => {
    const created = `${CREATED_IDS[0]}`;
    const { fetchMock } = await mountWelcome();
    expect(footerButton("任务启动于 未选择").disabled).toBe(false);
    const dialog = await openPicker();
    await waitFor(() =>
      expect(options(dialog).map(([text]) => text)).toEqual([
        "未选择",
        PROJECT_A_OPTION,
        SUPPORT_OPTION,
      ]),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作空间" })).toBeNull());

    typeDraft("你好");
    clickSend();

    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    await expectReadOnly("任务启动于 临时空间");
    // 夹具为这次创建铸的临时空间 id（不在上面弹层列出的空间里）：页面以它取项目配置。
    await waitFor(() =>
      expect(paths(fetchMock)).toContain(`${CONFIG}?workspaceId=${TEMP_WORKSPACE_IDS[0]}`),
    );
    const group = await within(await findList("新会话")).findByRole("group", { name: "临时空间" });
    expect(within(group).getByRole("button", { name: "新会话" })).toBeTruthy();
  });

  it("临时空间会话以其 workspaceId 请求项目配置与命令目录（该 id 不在工作空间列表里）", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      [`${CONFIG}?workspaceId=${TEMP}`]: () => jsonResponse({ files: [] }),
      [commandsOf(TEMP)]: () => jsonResponse({ commands: [] }),
    });
    await openExistingSession(await findList("临时会话"), "临时会话", D);
    await waitFor(() => expect(composer().disabled).toBe(false));

    await type("/");

    const asked = (base: string) => paths(fetchMock).filter((path) => path.split("?")[0] === base);
    expect(asked(CONFIG)).toEqual([`${CONFIG}?workspaceId=${TEMP}`]);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(TEMP)]);
  });
});

describe("能力栏：欢迎态", () => {
  it("「+」按钮在左组最前、工作空间选择器其后、权限按钮第三，模型、强度与发送键在右组；没有专家与麦克风控件，未选入文件时没有附件标签区", async () => {
    mountSessions("/", []);
    await screen.findByRole("heading", { level: 1, name: HERO });
    const { left, right, toolbar } = toolbarGroups();

    await within(toolbar).findByRole("button", { name: TIER });
    const buttons = within(toolbar).getAllByRole("button");
    expect(
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual([PLUS, "任务启动于 未选择", TIER, MODEL, EFFORT, "发送"]);
    expect(toolbar.firstElementChild).toBe(left);
    expect(left.children[0]).toBe(buttons[0]);
    expect(left.children[1]).toBe(workspaceSlot());
    expect(left.children[2]).toBe(buttons[2]);
    expect(Array.from(right.children)).toEqual(buttons.slice(3));
    expect(right.contains(buttons[5] as HTMLElement)).toBe(true);
    expect(left.contains(buttons[5] as HTMLElement)).toBe(false);
    for (const text of ["专家", "麦克风", "完全访问", "默认权限"]) {
      expect(toolbar.textContent).not.toContain(text);
    }
    expect(cardChildren()).toEqual(["label", "textarea", "composer-toolbar"]);
  });
});

describe("能力行的次序", () => {
  it("已选绑定会话：`添加文件或命令`、只读 任务启动于 项目A、权限：只问命令，右组是模型、推理强度、发送；回欢迎态次序相同且第二项是可点的选择器；全程恰一次选项请求", async () => {
    const [first, ...others] = sessions();
    const picked = {
      ...first,
      modelId: DEFAULT_COMPOSER_OPTIONS.defaults.modelId,
      reasoningEffort: "high",
    } as unknown as SessionView;
    const mounted = mountSessions("/", [picked, ...others], {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    await openExistingSession(await findList("绑定会话"), "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    expectOrder(TIER, PICKED);

    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    expectOrder(TIER, PICKED);
    const trigger = footerButton("任务启动于 未选择");
    expect(trigger.disabled).toBe(false);
    expect(workspaceSlot().contains(trigger)).toBe(true);
    await quiesce();
    expect(optionsRequests(mounted.fetchMock)).toBe(1);
  });

  it("选项读取失败：能力行同样只有 `添加文件或命令`、工作空间项与发送，没有占位元素与错误提示", async () => {
    const mounted = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      [OPTIONS]: () => envelope(503, "服务暂不可用"),
    });
    const nav = await findList("绑定会话");
    await quiesce();
    expectOrder(null, []);

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    await quiesce();
    expectOrder(null, []);
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(optionsRequests(mounted.fetchMock)).toBe(2);
  });
});

describe("选项读取失败后重取", () => {
  it("第一次失败后没有权限、模型与强度控件；选中会话恰发出第二次请求，成功后控件出现，再切两次会话不再请求（全程恰两次）", async () => {
    let asked = 0;
    const { fetchMock } = mountSessions("/", sessions(), {
      [OPTIONS]: () => {
        asked += 1;
        return asked === 1 ? envelope(503, "服务暂不可用") : jsonResponse(DEFAULT_COMPOSER_OPTIONS);
      },
    });
    const nav = await findList("绑定会话");
    await quiesce();
    expect(asked).toBe(1);
    expectOrder(null, []);

    await openExistingSession(nav, "绑定会话", A);
    await waitFor(() => expect(asked).toBe(2));
    await screen.findByRole("button", { name: TIER });
    expectOrder(TIER, UNLISTED);
    await openExistingSession(nav, "未绑定会话", B);
    await openExistingSession(nav, "空间已删", C);
    await quiesce();

    expectOrder(TIER, UNLISTED);
    expect(asked).toBe(2);
    expect(optionsRequests(fetchMock)).toBe(2);
  });
});

describe("能力行：窄屏的类名与结构", () => {
  it("工具行可换行，左组让出整行，右组整体靠右；回合进行中 模型按钮、生成中 与 停止 都在右组内", async () => {
    const running = { ...bound(A, "绑定会话", PROJECT_A.id), status: "running" as const };
    mountSessions("/", [running], {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      [messagesPath(A)]: () => jsonResponse({ ...chatSnapshot(), session: running }),
    });
    await openExistingSession(await findList("绑定会话"), "绑定会话", A);
    const { left, right, toolbar } = toolbarGroups();
    const stop = await within(toolbar).findByRole("button", { name: "停止" });

    expect(toolbar.classList.contains("narrow:flex-wrap")).toBe(true);
    expect(left.classList.contains("narrow:basis-auto")).toBe(true);
    expect(left.classList.contains("min-w-0")).toBe(true);
    expect(right.classList.contains("ml-auto")).toBe(true);
    expect(right.classList.contains("flex-none")).toBe(true);
    const status = within(toolbar).getByRole("status");
    expect(status.textContent).toBe("生成中");
    expect(Array.from(right.children)).toEqual([
      within(toolbar).getByRole("button", { name: "模型：m1" }),
      status,
      stop,
    ]);
  });

  it("长名空间：选择器按钮与只读标签各有最大宽度，title 带完整文字，内层文字截断", async () => {
    const full = `任务启动于 ${LONG.name}`;
    const mounted = mountSessions("/", [bound(A, "长名会话", LONG.id)], {
      "/api/workspaces": () => workspaceList(LONG),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });
    await pickOption(`${LONG.name}zhangsan/${LONG.dir}`);
    const trigger = footerButton(full);
    expect(trigger.classList.contains("narrow:max-w-40")).toBe(true);
    // 最大宽度取代了 max-w-full：按钮要能随外层收窄，否则左组不够宽时越出输入卡。
    for (const name of ["min-w-0", "narrow:shrink"]) {
      expect(trigger.classList.contains(name)).toBe(true);
    }
    expect(trigger.title).toBe(full);
    expect(within(trigger).getByText(full, { exact: true }).classList.contains("truncate")).toBe(
      true,
    );

    await openExistingSession(await findList("长名会话"), "长名会话", A);
    await expectReadOnly(full);
    const label = workspaceSlot();
    expect(label.classList.contains("narrow:max-w-40")).toBe(true);
    expect(label.classList.contains("min-w-0")).toBe(true);
    expect(label.title).toBe(full);
    expect(within(label).getByText(full, { exact: true }).classList.contains("truncate")).toBe(
      true,
    );
    expect(mutations(mounted.fetchMock)).toEqual([]);
  });
});
