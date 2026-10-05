// 能力栏「+」菜单（chat-web「输入框与能力栏」场景「「+」菜单写入草稿」）：`技能与命令` 按钮的可用条件、菜单
// 列出的目录与项目标记、点选写入草稿并聚焦输入框而不发送、拉取中与失败的 `暂无可用项`、与斜杠候选共用
// 一份目录。seam：整页挂载 + 假 API；「菜单开着时输入框被锁定」用 `useSlashMenu` + 裸 `CapabilityBar`。
// 期望文案与条目取自规格条文。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityBar } from "../src/features/chat/capability-bar.js";
import { useSlashMenu } from "../src/features/chat/slash-menu.js";
import { createApiClient } from "../src/lib/api.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { composer, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, view } from "./chat-page-session-meta-support.js";
import {
  welcomeRoutes as accountRoutes,
  CATALOGUE,
  COMMANDS,
  COMPACT,
  catalogue,
  cataloguePaths,
  commandsOf,
  composerReady,
  labels,
  project,
  TODO,
  tags,
  type,
  WEEKLY,
} from "./chat-page-slash-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { PROJECT_A, welcomeRoutes } from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import {
  createFetchMock,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";

const A = PROJECT_A.id;
const BOUND = { ...view("a".repeat(32), "绑定会话"), workspaceId: A };
const EMPTY = "暂无可用项";
/** 规格场景里空间 A 的目录：两条内建、平台技能 `skill:weekly-report`、项目技能 `skill:deploy`。 */
const FOUR = [COMPACT, TODO, WEEKLY, project("deploy", "部署到测试环境")];
const FOUR_LABELS = ["整理上下文", "任务清单", "weekly-report", "deploy"];
/** 每项是名称、项目标记（仅项目技能）与描述，不带参数提示。 */
const FOUR_TEXTS = [
  "整理上下文压缩较长对话的上下文，保留要点",
  "任务清单查看或修改助手的任务清单",
  "weekly-report写周报",
  "deploy项目部署到测试环境",
];

afterEach(cleanupSessionMeta);

/** 打开绑定空间 A 的会话（历史为空），等输入框解锁；`commands` 应答 A 的目录。 */
async function openBound(commands: FetchRoutes[string]) {
  const page = renderChatPage(`/?session=${BOUND.id}`, {
    ...welcomeRoutes(),
    "/api/sessions": () => jsonResponse({ sessions: [BOUND] }),
    [`/api/sessions/${BOUND.id}/messages`]: () =>
      jsonResponse({ session: BOUND, messages: [], streamCursor: { epoch: 1, seq: 0 } }),
    [commandsOf(A)]: commands,
  });
  await composerReady();
  return page;
}

function plusButton() {
  return screen.getByRole("button", { hidden: true, name: "技能与命令" }) as HTMLButtonElement;
}

/** 左键 pointerdown 打开菜单（Radix DropdownMenu 不认 click），并让它触发的目录请求走完。 */
async function openMenu() {
  fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  await quiesce();
  return menu;
}

function itemTexts(menu: HTMLElement) {
  return within(menu)
    .queryAllByRole("menuitem")
    .map((item) => item.textContent);
}

function prompts(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.endsWith("/prompt"));
}

/** `Bar` 最近一次渲染的钩子输出与草稿：菜单内容卸载后仍能看到 `plus.commands`，也能绕过菜单直接点选。 */
let seam: {
  draft: string;
  plus: ReturnType<typeof useSlashMenu>["plus"];
  setDraft(text: string): void;
};

/** `useSlashMenu` + 裸 `CapabilityBar`（未绑定空间的会话），不经整页。 */
function Bar({ enabled }: { enabled: boolean }) {
  const [client] = useState(() => createApiClient());
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { plus } = useSlashMenu(client, null, draft, enabled, setDraft);
  seam = { draft, plus, setDraft };
  return (
    <CapabilityBar
      choice={{ onSelect: () => undefined, workspace: null, workspaces: [], workspacesError: null }}
      disabled={!enabled}
      inputRef={inputRef}
      plus={plus}
      session={{ id: null, workspace: undefined }}
    />
  );
}

/** 挂载 `Bar` 并打开菜单，账号目录（三项）已取回。 */
async function openBar() {
  vi.stubGlobal("fetch", createFetchMock({ [COMMANDS]: catalogue() }));
  const bar = render(<Bar enabled />);
  return { bar, menu: await openMenu() };
}

/** 方向键下移到第一项，再在该项上按 `key`（Radix 菜单项对 Enter 与空格都触发点选）。 */
function pickFirstByKey(menu: HTMLElement, key: string) {
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  const first = within(menu).getAllByRole("menuitem")[0];
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first as HTMLElement, { key });
}

describe("「+」菜单写入草稿", () => {
  it("草稿非空白时禁用、空白时可用；菜单按目录顺序列四项并标出项目技能；点选写入 `/skill:deploy `、关闭菜单、聚焦输入框、不发送；之后的斜杠候选用同一份目录", async () => {
    const { fetchMock } = await openBound(catalogue(FOUR));

    await type("半句");
    expect(plusButton().disabled).toBe(true);
    await type("  \n ");
    expect(plusButton().disabled).toBe(false);
    await type("");
    expect(plusButton().disabled).toBe(false);
    // 菜单没打开过：还没有任何目录请求。
    expect(cataloguePaths(fetchMock)).toEqual([]);

    const menu = await openMenu();

    expect(itemTexts(menu)).toEqual(FOUR_TEXTS);
    expect(menu.textContent).toBe(FOUR_TEXTS.join(""));
    for (const absent of ["权限", "上传", "专家"]) expect(menu.textContent).not.toContain(absent);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: /deploy/ }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(composer().value).toBe("/skill:deploy ");
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    expect(plusButton().disabled).toBe(true);
    await quiesce();
    expect(prompts(fetchMock)).toEqual([]);

    await type("");
    await type("/");

    expect(labels()).toEqual(FOUR_LABELS);
    expect(tags()).toEqual([null, null, null, "项目"]);
    // 共用缓存：斜杠候选直接用菜单取回的那份，没有第二次请求。
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);
    expect(prompts(fetchMock)).toEqual([]);
  });

  it("覆盖平台技能的项目技能带 `项目 · 覆盖平台技能` 标记；目录字符串按纯文本呈现", async () => {
    const markup = project("<b>x</b>", "<img src=x>", true);
    await openBound(catalogue([markup]));

    const menu = await openMenu();

    expect(itemTexts(menu)).toEqual(["<b>x</b>项目 · 覆盖平台技能<img src=x>"]);
    expect(menu.querySelector("b, img")).toBeNull();
  });

  it("斜杠候选先取回的目录，菜单打开时直接列出、不再请求", async () => {
    const { fetchMock } = await openBound(catalogue(FOUR));
    await type("/");
    expect(labels()).toEqual(FOUR_LABELS);
    await type("");

    const menu = await openMenu();

    expect(itemTexts(menu)).toEqual(FOUR_TEXTS);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);
  });

  it("拉取中只显示 `暂无可用项`；目录到达后在仍打开的菜单里就地换成条目列表", async () => {
    const pending = deferredResponse();
    const { fetchMock } = await openBound(() => pending.promise);

    const menu = await openMenu();

    expect(menu.textContent).toBe(EMPTY);
    expect(itemTexts(menu)).toEqual([]);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);

    await settleDeferredResponse(pending, jsonResponse({ commands: FOUR }));

    // 同一个菜单元素：没有关闭重开。
    expect(screen.getByRole("menu")).toBe(menu);
    expect(itemTexts(menu)).toEqual(FOUR_TEXTS);
    expect(menu.textContent).not.toContain(EMPTY);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(A)]);
  });

  it("拉取失败后打开菜单：不列条目、只显示 `暂无可用项`、不显示错误；重新打开时按同一时机规则再取一次", async () => {
    let reads = 0;
    const { fetchMock } = await openBound(() => {
      reads += 1;
      return reads <= 2
        ? jsonResponse({ error: { code: "unavailable", message: "服务暂不可用" } }, 503)
        : jsonResponse({ commands: FOUR });
    });
    const errors = vi.spyOn(console, "error");
    // 斜杠候选的那次拉取先失败。
    await type("/");
    await type("");
    expect(cataloguePaths(fetchMock)).toHaveLength(1);

    const menu = await openMenu();

    expect(menu.textContent).toBe(EMPTY);
    expect(itemTexts(menu)).toEqual([]);
    expect(screen.queryAllByRole("alert", { hidden: true })).toEqual([]);
    expect(document.body.textContent).not.toContain("服务暂不可用");
    expect(cataloguePaths(fetchMock)).toHaveLength(2);

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(itemTexts(await openMenu())).toEqual(FOUR_TEXTS);
    expect(cataloguePaths(fetchMock)).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it("Esc 关闭菜单：草稿不变，焦点回到 `技能与命令` 按钮", async () => {
    const { fetchMock } = await openBound(catalogue(FOUR));
    const menu = await openMenu();

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(composer().value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(plusButton()));
    expect(prompts(fetchMock)).toEqual([]);
  });

  it.each([
    ["Enter", "Enter"],
    ["空格", " "],
  ])(
    "键盘点选：方向键下移到第一项后按 %s，写入 `/compact `、关闭菜单、聚焦输入框、不发送",
    async (_name, key) => {
      const { fetchMock } = await openBound(catalogue(FOUR));
      const menu = await openMenu();

      pickFirstByKey(menu, key);

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(composer().value).toBe("/compact ");
      await waitFor(() => expect(document.activeElement).toBe(composer()));
      await quiesce();
      expect(prompts(fetchMock)).toEqual([]);
    },
  );

  it("欢迎态未选择空间：菜单列出账号自己的目录（`GET /api/commands`），点选同样写入草稿", async () => {
    const { fetchMock } = renderChatPage("/", accountRoutes(catalogue()));
    await composerReady();

    const menu = await openMenu();
    expect(itemTexts(menu)).toEqual([
      "整理上下文压缩较长对话的上下文，保留要点",
      "任务清单查看或修改助手的任务清单",
      "weekly-report写周报",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /任务清单/ }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(composer().value).toBe("/todo ");
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    expect(cataloguePaths(fetchMock)).toEqual([COMMANDS]);
    expect(paths(fetchMock).filter((path) => path === "/api/sessions")).toHaveLength(1);
  });
});

describe("「+」按钮随输入框锁定", () => {
  it("回合进行中（输入框锁定）：`技能与命令` 按钮禁用，草稿为空白也一样，不发目录请求", async () => {
    const running = chatSnapshot();
    const { fetchMock } = renderChatPage(`/?session=${running.session.id}`, {
      ...accountRoutes(catalogue()),
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(running),
    });
    // `停止` 出现即回合进行中（而不只是历史加载中的锁定）。
    await screen.findByRole("button", { name: "停止" });
    await quiesce();

    expect(composer().disabled).toBe(true);
    expect(composer().value).toBe("");
    expect(plusButton().disabled).toBe(true);
    fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await quiesce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(cataloguePaths(fetchMock)).toEqual([]);
  });

  it("菜单开着时输入框被锁定：菜单关闭、按钮禁用，解锁后不自动重开", async () => {
    const { bar, menu } = await openBar();
    expect(itemTexts(menu)).toHaveLength(3);

    bar.rerender(<Bar enabled={false} />);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(plusButton().disabled).toBe(true);

    bar.rerender(<Bar enabled />);
    await quiesce();

    expect(plusButton().disabled).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("菜单关闭后目录仍在手：`plus.commands` 还是那份目录，退场动画期间不会塌成 `暂无可用项`", async () => {
    const { menu } = await openBar();
    expect(seam.plus.commands).toEqual(CATALOGUE);

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(seam.plus.open).toBe(false);
    expect(seam.plus.commands).toEqual(CATALOGUE);
  });

  it("菜单已禁用时的点选不落地：草稿非空白时不覆盖草稿，输入框锁定时不写入", async () => {
    const { bar } = await openBar();
    act(() => seam.setDraft("半句"));
    expect(seam.plus.disabled).toBe(true);
    expect(seam.plus.commands).toEqual(CATALOGUE);

    act(() => seam.plus.onPick(TODO));

    expect(seam.draft).toBe("半句");

    act(() => seam.setDraft(""));
    bar.rerender(<Bar enabled={false} />);
    act(() => seam.plus.onPick(TODO));

    expect(seam.draft).toBe("");

    // 对照：可用时同一个 `onPick` 照常写入。
    bar.rerender(<Bar enabled />);
    act(() => seam.plus.onPick(TODO));

    expect(seam.draft).toBe("/todo ");
  });
});
