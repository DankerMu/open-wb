/**
 * Issue 816 项目配置入口 (openspec/changes/project-config-surface, chat-web「会话页」Project config
 * entry, scenarios 项目配置入口 and 顶栏入口; session-sidebar 顶栏重命名入口): G1–G9. Seams: the jsdom
 * chat page inside the real shell over a stubbed `fetch` (the real `createApiClient`),
 * `useProjectConfig` in a bare harness for the change of a workspace id and of the client, and the
 * pure `groupByDepth` / `chatTopbar`. Expected values are literals from the spec delta.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupByDepth, useProjectConfig } from "../src/features/chat/project-config.js";
import { chatTopbar } from "../src/features/chat/topbar-actions.js";
import { type ApiClient, createApiClient } from "../src/lib/api.js";
import type { ProjectConfigFile } from "../src/lib/api-commands.js";
import type { ChatSession } from "../src/lib/session-contract.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  cleanupSessionMeta,
  crumb,
  focusOn,
  installNarrowViewport,
  messagesPath,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  HERO,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickOption,
  SUPPORT,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import {
  createFetchMock,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";

const CONFIG = "/api/project-config";
const A = PROJECT_A.id;
const B = SUPPORT.id;

function session(digit: string, title: string, workspaceId: string | null): ChatSession {
  return { ...view(digit.repeat(32), title), workspaceId };
}

const BOUND = session("a", "绑定会话", A);
const UNBOUND = session("b", "未绑定会话", null);
const OTHER = session("c", "客服会话", B);
const SESSIONS = [BOUND, UNBOUND, OTHER];

const TITLE = "助手会读取的项目配置文件";
const NOTE = "以下位置存在配置文件；同一层有多个说明文件时只有一个生效";
const THREE_BUTTONS = ["重命名", "对话内搜索", "产物面板"];

const file = (path: string, depth: number, kind: ProjectConfigFile["kind"] = "instructions") => ({
  path,
  kind,
  depth,
});
/** The list of the spec scenario: two files in the cwd, one a level above. */
const THREE = [file(".omp/RULES.md", 0), file("AGENTS.md", 0), file("AGENTS.md", 1)];

const configOf = (id: string) => `${CONFIG}?workspaceId=${id}`;
const answer = (files: readonly unknown[]) => () => jsonResponse({ files });

/** Routes of an account with the three sessions, each with an empty history; `config` adds routes. */
function routes(config: FetchRoutes): FetchRoutes {
  const all: FetchRoutes = {
    ...welcomeRoutes(),
    "/api/sessions": () => jsonResponse({ sessions: SESSIONS }),
  };
  for (const listed of SESSIONS) {
    all[messagesPath(listed.id)] = () =>
      jsonResponse({ session: listed, messages: [], streamCursor: { epoch: 1, seq: 0 } });
  }
  return { ...all, ...config };
}

/** The project-config requests so far, in call order. */
function configPaths(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.split("?")[0] === CONFIG);
}

/** `aria-label` of every banner button, in document order (hidden ones too: a dialog may be open). */
function bannerButtons() {
  return within(screen.getByRole("banner", { hidden: true }))
    .getAllByRole("button", { hidden: true })
    .map((button) => button.getAttribute("aria-label"));
}

function configButton(count: number) {
  return within(screen.getByRole("banner", { hidden: true })).getByRole<HTMLButtonElement>(
    "button",
    { name: `项目配置 ${count}`, hidden: true },
  );
}

function configDialog() {
  return screen.queryByRole("dialog", { name: TITLE });
}

/** `[group label, [path, kind label][]]` of every group of the open dialog, in document order. */
function groups(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("region")
    .map((region) => [
      region.getAttribute("aria-label"),
      within(region).getByRole("heading", { level: 3 }).textContent,
      within(region)
        .getAllByRole("listitem")
        .map((item) => Array.from(item.children, (child) => child.textContent)),
    ]);
}

async function mount(path: string, config: FetchRoutes) {
  const page = renderChatPage(path, routes(config));
  await quiesce();
  return page;
}

async function selectSession(session: ChatSession) {
  const list = screen.getByRole("navigation", { name: "会话列表" });
  fireEvent.click(within(list).getByRole("button", { name: session.title ?? "" }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${session.id}`));
}

/** A 500 of the server, the body of the error contract. */
const failure = () => jsonResponse({ error: { code: "internal", message: "服务异常" } }, 500);

/**
 * BOUND with its list open, then left for `away` and selected again while its second call is
 * pending: the first call of workspace A answers THREE, every later one waits for `again`.
 */
async function reopenedAfter(away: string, config: FetchRoutes = {}) {
  const again = deferredResponse();
  let asked = 0;
  const { fetchMock, router } = await mount(`/?session=${BOUND.id}`, {
    ...config,
    [configOf(A)]: () => {
      asked += 1;
      return asked === 1 ? jsonResponse({ files: THREE }) : again.promise;
    },
  });
  await crumb("绑定会话");
  fireEvent.click(configButton(3));
  expect(await screen.findByRole("dialog", { name: TITLE })).toBeTruthy();

  // The sidebar is behind the modal dialog: the session changes by navigation.
  await act(() => router.navigate(away));
  await waitFor(() => expect(configDialog()).toBeNull());
  await quiesce();
  expect(screen.queryByRole("button", { name: /项目配置/, hidden: true })).toBeNull();

  await act(() => router.navigate(`/?session=${BOUND.id}`));
  await crumb("绑定会话");
  await quiesce();
  expect(configPaths(fetchMock).filter((path) => path === configOf(A))).toHaveLength(2);
  return again;
}

afterEach(cleanupSessionMeta);

describe("项目配置入口 (G1–G7)", () => {
  it("G1 a non-empty list puts 项目配置 <count> before 重命名; it opens the read-only grouped list and Escape hands the focus back", async () => {
    const { fetchMock } = await mount(`/?session=${BOUND.id}`, { [configOf(A)]: answer(THREE) });
    await crumb("绑定会话");

    expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);
    expect(configPaths(fetchMock)).toEqual([`/api/project-config?workspaceId=${A}`]);
    const button = configButton(3);
    expect(
      button.closest('[data-slot="topbar-actions"]')?.firstElementChild?.contains(button),
    ).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("lucide-file-text");
    expect(configDialog()).toBeNull();

    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: TITLE });
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(TITLE);
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(NOTE);
    expect(groups(dialog)).toEqual([
      [
        "当前目录",
        "当前目录",
        [
          [".omp/RULES.md", "说明"],
          ["AGENTS.md", "说明"],
        ],
      ],
      ["上 1 级目录", "上 1 级目录", [["AGENTS.md", "说明"]]],
    ]);
    expect(configButton(3).getAttribute("aria-expanded")).toBe("true");
    // Read-only: the only control is the dialog's own 关闭.
    expect(within(dialog).getAllByRole("button")).toEqual([
      within(dialog).getByRole("button", { name: "关闭" }),
    ]);
    expect(dialog.querySelectorAll("a, input, textarea, select, [contenteditable]")).toHaveLength(
      0,
    );
    expect(configPaths(fetchMock)).toHaveLength(1);

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });

    await waitFor(() => expect(configDialog()).toBeNull());
    await focusOn(configButton(3));
    expect(configButton(3).getAttribute("aria-expanded")).toBe("false");
    expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);
  });

  it("G2 every kind has its label, a deeper level its own group, and a path is text only", async () => {
    const markup = '<img src="x" alt="注入">.md';
    const files = [
      file(".omp/SYSTEM.md", 0, "system"),
      file(markup, 0),
      file(".omp/agents/reviewer.md", 2, "agent"),
    ];
    await mount(`/?session=${BOUND.id}`, { [configOf(A)]: answer(files) });
    await crumb("绑定会话");

    fireEvent.click(configButton(3));

    const dialog = await screen.findByRole("dialog", { name: TITLE });
    expect(groups(dialog)).toEqual([
      [
        "当前目录",
        "当前目录",
        [
          [".omp/SYSTEM.md", "系统提示"],
          [markup, "说明"],
        ],
      ],
      ["上 2 级目录", "上 2 级目录", [[".omp/agents/reviewer.md", "智能体"]]],
    ]);
    expect(dialog.querySelector("img")).toBeNull();
  });

  it.each([
    ["an empty list", answer([])],
    ["a 500", failure],
    ["a 404", () => jsonResponse({ error: { code: "not_found", message: "资源不存在" } }, 404)],
    ["a network failure", () => Promise.reject(new Error("offline"))],
    ["an element of an unknown kind", answer([...THREE, file("X.md", 0, "rules" as never)])],
  ])("G3 %s renders no button and no error", async (_label, config) => {
    const { fetchMock } = await mount(`/?session=${BOUND.id}`, { [configOf(A)]: config });
    await crumb("绑定会话");

    expect(bannerButtons()).toEqual(THREE_BUTTONS);
    expect(configPaths(fetchMock)).toEqual([configOf(A)]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toasts()).toEqual([]);
    expect(configDialog()).toBeNull();
  });

  it("G4 a pending call renders no button; the button appears with the answer", async () => {
    const pending = deferredResponse();
    const { fetchMock } = await mount(`/?session=${BOUND.id}`, {
      [configOf(A)]: () => pending.promise,
    });
    await crumb("绑定会话");

    expect(bannerButtons()).toEqual(THREE_BUTTONS);
    expect(screen.queryByRole("alert")).toBeNull();

    await settleDeferredResponse(pending, jsonResponse({ files: THREE }));

    expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);
    expect(configPaths(fetchMock)).toEqual([configOf(A)]);
  });

  it("G5 switching sessions asks again by the new session's workspace id and never shows the previous list", async () => {
    const unbound = deferredResponse();
    const { fetchMock } = await mount(`/?session=${BOUND.id}`, {
      [configOf(A)]: answer(THREE),
      [CONFIG]: () => unbound.promise,
      [configOf(B)]: answer([]),
    });
    await crumb("绑定会话");
    expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);

    await selectSession(UNBOUND);
    await crumb("未绑定会话");
    await quiesce();

    // No workspace: no query string at all. Until it answers, A's button is not shown.
    expect(configPaths(fetchMock)).toEqual([configOf(A), "/api/project-config"]);
    expect(bannerButtons()).toEqual(THREE_BUTTONS);

    await settleDeferredResponse(unbound, jsonResponse({ files: [file("AGENTS.md", 0)] }));
    expect(bannerButtons()).toEqual(["项目配置 1", ...THREE_BUTTONS]);

    await selectSession(OTHER);
    await crumb("客服会话");
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([configOf(A), CONFIG, configOf(B)]);
    expect(bannerButtons()).toEqual(THREE_BUTTONS);

    // Back on the first session: a new selection, a new call.
    await selectSession(BOUND);
    await crumb("绑定会话");
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([configOf(A), CONFIG, configOf(B), configOf(A)]);
    expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);
  });

  it("G5 an answer that arrives after its session was left is dropped, and an open list closes with its session", async () => {
    const late = deferredResponse();
    const { fetchMock } = await mount(`/?session=${OTHER.id}`, {
      [configOf(A)]: answer(THREE),
      [configOf(B)]: () => late.promise,
      [CONFIG]: answer([]),
    });
    await crumb("客服会话");
    expect(configPaths(fetchMock)).toEqual([configOf(B)]);

    await selectSession(UNBOUND);
    await crumb("未绑定会话");
    await settleDeferredResponse(late, jsonResponse({ files: THREE }));
    await quiesce();
    expect(bannerButtons()).toEqual(THREE_BUTTONS);

    await selectSession(BOUND);
    await crumb("绑定会话");
    await quiesce();
    fireEvent.click(configButton(3));
    expect(await screen.findByRole("dialog", { name: TITLE })).toBeTruthy();

    // The sidebar is behind the modal dialog: the session changes by navigation.
    window.history.back();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${UNBOUND.id}`));
    await waitFor(() => expect(configDialog()).toBeNull());
    await quiesce();
    expect(bannerButtons()).toEqual(THREE_BUTTONS);

    // Back on its session the list is closed: it opens on a press only.
    await selectSession(BOUND);
    await crumb("绑定会话");
    await quiesce();
    expect(configDialog()).toBeNull();
    expect(configButton(3).getAttribute("aria-expanded")).toBe("false");
  });

  it.each<[string, string, FetchRoutes]>([
    ["the welcome state", "/", {}],
    [
      "a session whose call stays pending",
      `/?session=${OTHER.id}`,
      { [configOf(B)]: () => deferredResponse().promise },
    ],
  ])(
    "G5 the list of a session left for %s is not shown on return until the new call answers, and then it is closed",
    async (_label, away, config) => {
      const again = await reopenedAfter(away, config);

      expect(bannerButtons()).toEqual(THREE_BUTTONS);
      expect(configDialog()).toBeNull();

      await settleDeferredResponse(again, jsonResponse({ files: THREE }));

      expect(bannerButtons()).toEqual(["项目配置 3", ...THREE_BUTTONS]);
      expect(configButton(3).getAttribute("aria-expanded")).toBe("false");
      expect(configDialog()).toBeNull();
    },
  );

  it("G5 the list of a session left for one whose call fails is not shown on return, nor when the new call fails too", async () => {
    const again = await reopenedAfter(`/?session=${OTHER.id}`, { [configOf(B)]: failure });

    expect(bannerButtons()).toEqual(THREE_BUTTONS);
    expect(configDialog()).toBeNull();

    await settleDeferredResponse(again, failure());
    await quiesce();

    expect(bannerButtons()).toEqual(THREE_BUTTONS);
    expect(configDialog()).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it("G6 the welcome state asks nothing, with or without a workspace chosen in the footer", async () => {
    const { fetchMock } = await mount("/", {
      [configOf(A)]: answer(THREE),
      [CONFIG]: answer(THREE),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });

    await pickOption(PROJECT_A_OPTION);
    await quiesce();

    expect(configPaths(fetchMock)).toEqual([]);
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: /项目配置/ })).toBeNull();
  });

  it("G7 ≤760px: 打开导航 first, then 项目配置 <count> and the three buttons; the welcome state keeps 打开导航 only", async () => {
    installNarrowViewport();
    const { fetchMock, router } = await mount(`/?session=${BOUND.id}`, {
      [configOf(A)]: answer(THREE),
    });
    await crumb("绑定会话");

    expect(bannerButtons()).toEqual(["打开导航", "项目配置 3", ...THREE_BUTTONS]);

    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();
    expect(bannerButtons()).toEqual(["打开导航"]);
    expect(configPaths(fetchMock)).toEqual([configOf(A)]);
  });
});

/** `useProjectConfig` alone: the button's label, or `无` while there is no slot. */
function Harness({ client, session }: { client: ApiClient; session: ChatSession | undefined }) {
  const { slot } = useProjectConfig(client, session);
  return <output>{slot?.label ?? "无"}</output>;
}

describe("useProjectConfig (G8)", () => {
  it("G8 one call per client, session id and workspace id: a re-render asks nothing, a change of the workspace id or of the client asks again", async () => {
    const fetchMock = createFetchMock({
      [configOf(A)]: answer(THREE),
      [configOf(B)]: answer([file("AGENTS.md", 0)]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = createApiClient();
    const label = () => screen.getByRole("status").textContent;
    const page = render(<Harness client={first} session={undefined} />);
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([]);
    expect(label()).toBe("无");

    page.rerender(<Harness client={first} session={BOUND} />);
    await quiesce();
    expect(label()).toBe("项目配置 3");

    // Another object for the same session (a list refresh): nothing is asked.
    page.rerender(<Harness client={first} session={{ ...BOUND, title: "改名" }} />);
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([configOf(A)]);

    page.rerender(<Harness client={first} session={{ ...BOUND, workspaceId: B }} />);
    expect(label()).toBe("无");
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([configOf(A), configOf(B)]);
    expect(label()).toBe("项目配置 1");

    page.rerender(<Harness client={createApiClient()} session={{ ...BOUND, workspaceId: B }} />);
    expect(label()).toBe("无");
    await quiesce();
    expect(configPaths(fetchMock)).toEqual([configOf(A), configOf(B), configOf(B)]);
    expect(label()).toBe("项目配置 1");

    page.rerender(<Harness client={first} session={undefined} />);
    await quiesce();
    expect(label()).toBe("无");
    expect(configPaths(fetchMock)).toHaveLength(3);
  });
});

describe("groupByDepth 与 chatTopbar (G9)", () => {
  it("G9 groups ascend by depth and keep the order received inside a group", () => {
    const files = [
      file("AGENTS.md", 2),
      file("b.md", 0, "agent"),
      file("a.md", 0),
      file("AGENTS.md", 1),
    ];

    expect(groupByDepth(files)).toEqual([
      { depth: 0, label: "当前目录", files: [files[1], files[2]] },
      { depth: 1, label: "上 1 级目录", files: [files[3]] },
      { depth: 2, label: "上 2 级目录", files: [files[0]] },
    ]);
    expect(groupByDepth([])).toEqual([]);
  });

  it("G9 chatTopbar puts the filled config slot first under its own label; without it the three slots only", () => {
    const onSelect = vi.fn();
    const search = { expanded: false, onSelect: vi.fn() };
    const describeActions = (config?: Parameters<typeof chatTopbar>[4]) =>
      chatTopbar(BOUND, vi.fn(), search, vi.fn(), config).actions?.map(
        ({ expanded, icon, key, label }) => ({ expanded, icon, key, label }),
      );
    const three = [
      { expanded: undefined, icon: "pencil", key: "rename", label: "重命名" },
      { expanded: false, icon: "search", key: "search", label: "对话内搜索" },
      { expanded: undefined, icon: "package", key: "artifacts", label: "产物面板" },
    ];

    expect(describeActions()).toEqual(three);
    expect(describeActions({ label: "项目配置 3", expanded: true, onSelect })).toEqual([
      { expanded: true, icon: "file-text", key: "config", label: "项目配置 3" },
      ...three,
    ]);
    expect(
      chatTopbar(undefined, vi.fn(), search, vi.fn(), { expanded: false, onSelect }),
    ).toStrictEqual({});

    const trigger = document.createElement("button");
    chatTopbar(BOUND, vi.fn(), search, vi.fn(), {
      expanded: false,
      onSelect,
    }).actions?.[0]?.onSelect(trigger);
    expect(onSelect.mock.calls).toEqual([[trigger]]);
  });
});
