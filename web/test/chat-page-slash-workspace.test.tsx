/**
 * Issue 814 候选面板按工作空间取目录 (openspec/changes/project-config-surface, chat-web「会话页」
 * Slash candidates): K1–K4, and K5 切换工作空间后高亮回到首项
 * (openspec/changes/slash-highlight-workspace-reset). Seams: the jsdom chat page inside the real shell over a stubbed `fetch`
 * (the real `createApiClient`) for the sessions, the footer picker and the routes, and
 * `useSlashMenu` beside a bare `Composer` for the timing of one catalogue per workspace id.
 * Expected values are literals from the spec delta.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import { view } from "./chat-page-session-meta-support.js";
import {
  CATALOGUE,
  COMMANDS,
  COMPACT,
  catalogue,
  cataloguePaths,
  commandsOf,
  composerReady,
  Harness,
  highlighted,
  LABELS,
  labels,
  optionOf,
  panel,
  press,
  project,
  selection,
  skill,
  slashMenuFixture,
  TODO,
  tags,
  type,
  untilAborted,
} from "./chat-page-slash-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  HERO,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickOption,
  SUPPORT,
  SUPPORT_OPTION,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import {
  createFetchMock,
  currentLocation,
  deferredResponse,
  jsonResponse,
  paths,
} from "./support.js";

const A = PROJECT_A.id;
const B = SUPPORT.id;
const BOUND = { ...view("a".repeat(32), "绑定会话"), workspaceId: A };
const UNBOUND = view("b".repeat(32), "未绑定会话");

const PROJECT_TAG = "项目";
const OVERRIDE_TAG = "项目 · 覆盖平台技能";
/** The catalogue of workspace A in the spec scenario: two builtins, a platform skill, two project ones. */
const FIVE = [
  COMPACT,
  TODO,
  skill("minutes", "写会议纪要"),
  project("deploy", "部署到测试环境"),
  project("weekly-report", "按本项目的格式写周报", true),
];
const FIVE_LABELS = ["整理上下文", "任务清单", "minutes", "deploy", "weekly-report"];
const FIVE_TAGS = [null, null, null, PROJECT_TAG, OVERRIDE_TAG];

/**
 * Routes of an account whose workspaces are A and 客服 and whose sessions, each with an empty
 * history, are one bound to A and an unbound one; `commands` adds the catalogue routes.
 */
function routes(commands: FetchRoutes): FetchRoutes {
  const sessions = [BOUND, UNBOUND];
  const histories = sessions.map((session) => [
    `/api/sessions/${session.id}/messages`,
    () => jsonResponse({ session, messages: [], streamCursor: { epoch: 1, seq: 0 }, todo: null }),
  ]);
  return {
    ...welcomeRoutes(),
    "/api/sessions": () => jsonResponse({ sessions }),
    ...Object.fromEntries(histories),
    ...commands,
  };
}

/** Selects the listed session `title` and waits until its composer is unlocked. */
async function selectSession(title: string, id: string) {
  const list = screen.getByRole("navigation", { name: "会话列表" });
  fireEvent.click(within(list).getByRole("button", { name: title }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${id}`));
  await composerReady();
}

slashMenuFixture();

describe("候选面板按工作空间取目录 (K1, K2)", () => {
  it("K1 a bound session lists its workspace's catalogue with the project tags; an unbound one asks for its own and never shows A's; the welcome footer on A reuses the held one", async () => {
    const unbound = deferredResponse();
    const { fetchMock, router } = renderChatPage(
      `/?session=${BOUND.id}`,
      routes({ [commandsOf(A)]: catalogue(FIVE), [COMMANDS]: () => unbound.promise }),
    );
    await composerReady();
    expect(cataloguePaths(fetchMock)).toEqual([]);

    await type("/");

    expect(labels()).toEqual(FIVE_LABELS);
    expect(tags()).toEqual(FIVE_TAGS);
    expect(optionOf("deploy").textContent).toBe("deploy项目部署到测试环境可选参数");
    expect(optionOf("weekly-report").textContent).toBe(
      "weekly-report项目 · 覆盖平台技能按本项目的格式写周报可选参数",
    );
    expect(optionOf("minutes").textContent).toBe("minutes写会议纪要可选参数");
    expect(cataloguePaths(fetchMock)).toEqual([`/api/commands?workspaceId=${A}`]);

    // The draft is still the slash: the change of the workspace id alone asks for the catalogue.
    await selectSession("未绑定会话", UNBOUND.id);

    expect(composer().value).toBe("/");
    expect(cataloguePaths(fetchMock)).toEqual([`/api/commands?workspaceId=${A}`, "/api/commands"]);
    expect(panel()).toBeNull();
    await type("");
    await type("/");
    expect(panel()).toBeNull();
    // Hidden: the keys of the panel are the composer's.
    expect(press("ArrowDown")).toBe(true);
    expect(press("Tab")).toBe(true);
    expect(composer().value).toBe("/");
    expect(cataloguePaths(fetchMock)).toHaveLength(2);

    await settleDeferredResponse(unbound, jsonResponse({ commands: CATALOGUE }));

    expect(labels()).toEqual(LABELS);
    expect(tags()).toEqual([null, null, null]);

    await type("");
    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await pickOption(PROJECT_A_OPTION);
    await type("/");

    expect(labels()).toEqual(FIVE_LABELS);
    expect(tags()).toEqual(FIVE_TAGS);
    // Held for this client and workspace id: no third call, and nothing was sent on the way.
    expect(cataloguePaths(fetchMock)).toHaveLength(2);
    expect(paths(fetchMock).filter((path) => path.endsWith("/prompt"))).toEqual([]);
  });

  it("K2 the welcome state follows the footer: no workspace, then A, then 客服, each with its own catalogue and one call", async () => {
    const support = [TODO, project("reply", "按客服口径回复")];
    const { fetchMock } = renderChatPage(
      "/",
      routes({
        [COMMANDS]: catalogue(),
        [commandsOf(A)]: catalogue(FIVE),
        [commandsOf(B)]: catalogue(support),
      }),
    );
    await composerReady();

    await type("/");
    expect([labels(), tags()]).toEqual([LABELS, [null, null, null]]);

    await pickOption(PROJECT_A_OPTION);
    await quiesce();
    expect([labels(), tags()]).toEqual([FIVE_LABELS, FIVE_TAGS]);

    await pickOption(SUPPORT_OPTION);
    await quiesce();
    expect([labels(), tags()]).toEqual([
      ["任务清单", "reply"],
      [null, PROJECT_TAG],
    ]);

    await pickOption(PROJECT_A_OPTION);
    await quiesce();
    expect(labels()).toEqual(FIVE_LABELS);
    expect(cataloguePaths(fetchMock)).toEqual([COMMANDS, commandsOf(A), commandsOf(B)]);
  });

  it("K2 a requested session that cannot be resolved has no workspace id: no panel and no call", async () => {
    const missing = "c".repeat(32);
    const { fetchMock } = renderChatPage(
      `/?session=${missing}`,
      routes({
        [`/api/sessions/${missing}/messages`]: () =>
          jsonResponse({ error: { code: "internal", message: "服务器内部错误" } }, 500),
        [COMMANDS]: catalogue(),
      }),
    );
    await screen.findByText("服务器内部错误");
    await quiesce();
    const requests = paths(fetchMock);

    await type("/");

    expect(composer().value).toBe("/");
    expect(panel()).toBeNull();
    expect(paths(fetchMock)).toEqual(requests);
  });
});

describe("切换工作空间后高亮回到首项 (K5)", () => {
  /** The welcome state on `/` without a workspace, the third of its three options highlighted. */
  async function thirdHighlighted() {
    renderChatPage("/", routes({ [COMMANDS]: catalogue(), [commandsOf(A)]: catalogue(FIVE) }));
    await composerReady();
    await type("/");
    press("ArrowDown");
    press("ArrowDown");
    expect([labels(), highlighted()]).toEqual([LABELS, "weekly-report"]);
  }

  /** Picks workspace A in the composer footer and lets its catalogue arrive. */
  async function switchToA() {
    await pickOption(PROJECT_A_OPTION);
    await quiesce();
    expect(composer().value).toBe("/");
  }

  it("K5 picking workspace A under the same draft highlights A's first option, and Enter picks it", async () => {
    await thirdHighlighted();

    await switchToA();

    expect(labels()).toEqual(FIVE_LABELS);
    expect(highlighted()).toBe("整理上下文");
    expect(selection()).toEqual(["true", "false", "false", "false", "false"]);
    expect(press("Enter")).toBe(false);
    expect(composer().value).toBe("/compact ");
  });

  it("K5 a panel dismissed by Esc stays closed over the switch and returns on the first option once the draft changes", async () => {
    await thirdHighlighted();
    expect(press("Escape")).toBe(false);
    expect(panel()).toBeNull();

    await switchToA();

    expect(panel()).toBeNull();
    await type("/s");
    await type("/");
    expect(labels()).toEqual(FIVE_LABELS);
    expect(highlighted()).toBe("整理上下文");
    expect(selection()).toEqual(["true", "false", "false", "false", "false"]);
  });
});

describe("每个工作空间一份目录的时机 (K3)", () => {
  /** Mounts the harness on workspace `id` over `commands`; `show` moves it to another one. */
  function mount(id: string | null, commands: FetchRoutes) {
    const fetchMock = createFetchMock(commands);
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness enabled workspaceId={id} />);
    const show = async (next: string | null) => {
      view.rerender(<Harness enabled workspaceId={next} />);
      await quiesce();
    };
    return { fetchMock, show };
  }

  it("K3 a catalogue that arrives after the workspace changed is not shown there, is not aborted and is held for the return", async () => {
    const late = deferredResponse();
    const { fetchMock, show } = mount(A, {
      [commandsOf(A)]: () => late.promise,
      [COMMANDS]: catalogue(),
    });
    await quiesce();
    expect(panel()).toBeNull();

    await show(null);
    expect(labels()).toEqual(LABELS);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await settleDeferredResponse(late, jsonResponse({ commands: FIVE }));
    expect(labels()).toEqual(LABELS);

    await show(A);
    expect([labels(), tags()]).toEqual([FIVE_LABELS, FIVE_TAGS]);
    await show(null);
    expect(labels()).toEqual(LABELS);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A), COMMANDS]);
  });

  it("K3 a failed call of one workspace is silent, leaves the others alone and is retried when that workspace is current again", async () => {
    let reads = 0;
    const { fetchMock, show } = mount(A, {
      [commandsOf(A)]: () => {
        reads += 1;
        return reads === 1
          ? jsonResponse({ error: { code: "not_found", message: "资源不存在" } }, 404)
          : jsonResponse({ commands: FIVE });
      },
      [COMMANDS]: catalogue(),
    });
    const errors = vi.spyOn(console, "error");
    await quiesce();

    expect(panel()).toBeNull();
    expect(screen.queryAllByRole("alert")).toEqual([]);
    // Further typing while the condition holds starts no request.
    await type("/d");
    await type("/");
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);

    await show(null);
    expect(labels()).toEqual(LABELS);
    await show(A);

    expect(labels()).toEqual(FIVE_LABELS);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A), COMMANDS, commandsOf(A)]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("K3 an unknown workspace id hides the panel and asks nothing until it is known", async () => {
    const { fetchMock, show } = mount("unknown", { [commandsOf(A)]: catalogue(FIVE) });
    await quiesce();

    expect(panel()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(press("ArrowDown")).toBe(true);

    await show(A);
    expect(labels()).toEqual(FIVE_LABELS);
    await show("unknown");
    expect(panel()).toBeNull();
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);
  });

  it("K3 unmounting aborts the calls of every workspace still in flight", async () => {
    const fetchMock = createFetchMock({ [commandsOf(A)]: untilAborted, [COMMANDS]: untilAborted });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness enabled workspaceId={A} />);
    await quiesce();
    view.rerender(<Harness enabled workspaceId={null} />);
    await quiesce();
    const signals = fetchMock.mock.calls.map(([, options]) => options?.signal);
    expect(signals.map((signal) => signal?.aborted)).toEqual([false, false]);

    view.unmount();

    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
  });
});

describe("目录字符串按纯文本渲染 (K4)", () => {
  it("K4 markup in a project skill's label, description and hint is shown as typed, never as elements", async () => {
    const label = "<b>deploy</b>";
    const description = '<img src=x onerror="alert(1)"> [链接](javascript:alert(1)) &amp;';
    const hint = "<script>alert(1)</script>";
    const hostile = { ...project(label, description, true), hint };
    renderChatPage("/", routes({ [COMMANDS]: catalogue([hostile]) }));
    await composerReady();

    await type("/");

    const option = optionOf(label);
    expect(option.textContent).toBe(`${label}${OVERRIDE_TAG}${description}${hint}`);
    expect(Array.from(option.querySelectorAll("*"), (element) => element.tagName)).toEqual([
      "SPAN",
      "SPAN",
      "SPAN",
      "SPAN",
    ]);
    expect(press("Enter")).toBe(false);
    expect(composer().value).toBe(`/skill:${label} `);
  });
});
