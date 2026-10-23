// 输入框「能力」弹层（skill-switches「输入框「能力」弹层」与「停用技能对 omp 生效」的客户端过滤、chat-web「输入框
// 与能力栏」的 `能力` 按钮、「停用技能过滤」与「能力读取时机」；s1d-experts-skills 任务 10.2 的定案）：弹层列出
// 目录的 `skill:` 条目与开关（初值、项目标记、底部说明、`暂无可用技能`），会话中切换恰一次 `PUT`（完整集合、
// 成功以应答为准、失败回滚、401、在途不可操作、切走后丢弃），会话能力读取中 / 失败，欢迎态账号缺省的读取时机与
// 首次发送的 `disabledSkills`，斜杠候选与「+」菜单的过滤与 `listCommands` 次数。seam：整页挂载 + 假 API
// （`fetch`）；在途守卫另以 `renderHook` 同闭包连调（`aria-disabled` 的开关照样分派点击，守卫必须真实存在）。
// 期望值取自规格条文与 tasks.md 10.2。
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useSessionCapabilities,
  useSkillDefaults,
} from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient } from "../src/lib/api.js";
import { TESTER } from "./center-experts-support.js";
import {
  alerts,
  capsPath,
  capsReads,
  capsWrites,
  EXPERTS,
  experts,
  labelText,
  mountSelected,
  mountWelcome,
  openMenu,
  optionCalls,
  pickItem,
  removeButton,
  SA,
  select,
} from "./chat-expert-picker-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
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
import {
  COMMANDS,
  COMPACT,
  catalogue,
  commandsOf,
  labels,
  panel,
  project,
  skill,
  TODO,
  type,
} from "./chat-page-slash-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
  PROJECT_A,
  workspaceList,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { calls, deferredResponse, type FetchMock, jsonResponse } from "./support.js";

const SKILLS = "/api/skills";
const DIALOG = "能力";
const LOADING = "正在读取技能…";
const SESSION_FAILED = "技能读取失败，重新选中该会话可重试";
const WELCOME_FAILED = "技能读取失败，关闭后重新打开可重试";
const EMPTY = "暂无可用技能";
const FOOTER = "改动从下一条消息起生效";
const DEPLOY = skill("deploy", "部署");
const WEEKLY = skill("weekly-report", "写周报");
/** `overrides` 为真的项目技能：与平台技能同名。 */
const WEEKLY_OVER = project("weekly-report", "写周报", true);
const LINT = project("lint", "检查");
/** 两条内建、平台技能 `deploy`、覆盖平台技能的项目技能 `weekly-report`。 */
const CATALOG = [COMPACT, TODO, DEPLOY, WEEKLY_OVER];

afterEach(cleanupSessionMeta);

function capsBody(disabledSkills: readonly string[], expertId: string | null = null) {
  return jsonResponse({ expertId, disabledSkills });
}

function skillsBody(disabledSkills: readonly string[]) {
  return jsonResponse({ skills: [], disabledSkills });
}

function capabilityButton() {
  return screen.getByRole<HTMLButtonElement>("button", { name: DIALOG });
}

async function openSkills() {
  fireEvent.click(capabilityButton());
  const dialog = await screen.findByRole("dialog", { name: DIALOG });
  await quiesce();
  return dialog;
}

async function closeSkills(dialog: HTMLElement) {
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull());
}

/** 弹层的开关：`[accessible name, aria-checked, aria-disabled]`，按文档顺序。 */
function switches(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("switch")
    .map((item) => [
      item.getAttribute("aria-label"),
      item.getAttribute("aria-checked"),
      item.getAttribute("aria-disabled"),
    ]);
}

function switchOf(dialog: HTMLElement, name: string) {
  return within(dialog).getByRole<HTMLButtonElement>("switch", { name });
}

function rows(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("listitem")
    .map((row) => row.textContent);
}

function skillReads(fetchMock: FetchMock) {
  return calls(fetchMock, SKILLS).length;
}

/** 「+」菜单命令段各项的名称（`上传文件`、`选择专家…` 之后），按文档顺序；关菜单后返回。 */
async function menuCommands() {
  const menu = await openMenu();
  const items = within(menu)
    .getAllByRole("menuitem")
    .slice(2)
    .map((item) => item.querySelector("span")?.textContent);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return items;
}

/** 输入 `/` 时斜杠候选的名称；之后清空草稿。 */
async function slashLabels() {
  await type("/");
  const shown = panel() === null ? [] : labels();
  await type("");
  return shown;
}

describe("会话中的 能力 弹层", () => {
  it("列出平台与项目技能（项目标记、覆盖平台技能）；初值同一规则：名称不在会话停用集合里；底部说明；按钮在权限之后", async () => {
    await mountSelected(A, {
      [COMMANDS]: catalogue([COMPACT, DEPLOY, LINT, WEEKLY_OVER]),
      [capsPath(A)]: () => capsBody(["ghost", "lint", "weekly-report"]),
    });
    const left = composer()
      .closest("form")
      ?.querySelector('[data-slot="composer-capabilities"]') as HTMLElement;
    expect(left.lastElementChild).toBe(capabilityButton());
    expect(left.lastElementChild?.previousElementSibling?.getAttribute("aria-label")).toBe(
      "权限：只问命令",
    );

    const dialog = await openSkills();
    expect(rows(dialog)).toEqual(["deploy", "lint项目", "weekly-report项目 · 覆盖平台技能"]);
    expect(switches(dialog)).toEqual([
      ["deploy", "true", null],
      ["lint", "false", null],
      ["weekly-report", "false", null],
    ]);
    expect(within(dialog).getByText(FOOTER)).toBeTruthy();
    expect(within(dialog).queryByText(EMPTY)).toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("「会话中停用技能」：关掉 deploy 恰一次 PUT {disabledSkills} 为完整集合（含列表外名称）；斜杠候选与「+」菜单不再有它，listCommands 恰一次", async () => {
    let held = ["ghost"];
    const { fetchMock } = await mountSelected(A, {
      [COMMANDS]: catalogue([COMPACT, TODO, DEPLOY, WEEKLY]),
      [capsPath(A)]: (_path, init) => {
        if (init?.method === "PUT") held = JSON.parse(String(init.body)).disabledSkills;
        return capsBody(held);
      },
    });
    expect(await menuCommands()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);

    const dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));
    await waitFor(() => expect(switches(dialog)[0]).toEqual(["deploy", "false", null]));
    await closeSkills(dialog);

    expect(capsWrites(fetchMock)).toEqual([[capsPath(A), '{"disabledSkills":["deploy","ghost"]}']]);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
    expect(await menuCommands()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);
  });

  it("chat-web「专家标签、能力 按钮与停用技能过滤」：左组次序；菜单与候选不列 deploy；弹层重新打开后候选含它；全程恰一次 listCommands(A)、GET …/capabilities 与 listExperts", async () => {
    const boundA = { ...view(A, "绑定会话"), workspaceId: PROJECT_A.id } as unknown as SessionView;
    const { fetchMock } = mountSessions(`/?session=${A}`, [boundA], {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      [EXPERTS]: () => experts([TESTER]),
      [commandsOf(PROJECT_A.id)]: catalogue([COMPACT, TODO, WEEKLY, DEPLOY]),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? capsBody([], TESTER.id) : capsBody(["deploy"], TESTER.id),
    });
    await findList("绑定会话");
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    await quiesce();
    const left = composer()
      .closest("form")
      ?.querySelector('[data-slot="composer-capabilities"]') as HTMLElement;
    expect(
      Array.from(left.children, (child) => child.getAttribute("aria-label") ?? child.textContent),
    ).toEqual([
      "添加文件或命令",
      "专家 · 测试工程师",
      "任务启动于 项目A",
      "权限：只问命令",
      "能力",
    ]);

    expect(await menuCommands()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
    const dialog = await openSkills();
    expect(switches(dialog)).toEqual([
      ["weekly-report", "true", null],
      ["deploy", "false", null],
    ]);
    fireEvent.click(switchOf(dialog, "deploy"));
    await waitFor(() => expect(switches(dialog)[1]).toEqual(["deploy", "true", null]));
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "weekly-report", "deploy"]);

    expect(calls(fetchMock, commandsOf(PROJECT_A.id))).toHaveLength(1);
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);
    expect(calls(fetchMock, EXPERTS)).toHaveLength(1);
    expect(capsWrites(fetchMock)).toEqual([[capsPath(A), '{"disabledSkills":[]}']]);
  });

  it("PUT 成功：应答与本地预期不同时以应答为准（开关与过滤都按应答）", async () => {
    await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? capsBody(["weekly-report"]) : capsBody([]),
    });
    const dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));

    await waitFor(() =>
      expect(switches(dialog)).toEqual([
        ["deploy", "true", null],
        ["weekly-report", "false", null],
      ]),
    );
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy"]);
  });

  it("PUT 失败：开关回滚，chat column 里以 alert 显示 message；PUT 401 交给登录失效处理、不显示", async () => {
    let put = () => envelope(500, "内部错误");
    const { fetchMock } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: (_path, init) => (init?.method === "PUT" ? put() : capsBody([])),
    });
    const dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));

    await waitFor(() => expect(alerts()).toEqual(["内部错误"]));
    expect(switches(dialog)[0]).toEqual(["deploy", "true", null]);
    expect(screen.getByRole("alert").closest('[data-slot="chat-column"]')).not.toBeNull();
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);

    put = () => jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401);
    fireEvent.click(switchOf(await openSkills(), "deploy"));
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(screen.queryByText("登录已失效")).toBeNull();
    expect(capsWrites(fetchMock)).toHaveLength(2);
  });

  it("PUT 在途：被切换的开关显示新值，全部开关 aria-disabled（不是 disabled，焦点留在开关上）、再点不发；专家控件同样不可用；换专家在途时开关同样不可操作", async () => {
    const skillPut = deferredResponse();
    const expertPut = deferredResponse();
    const puts = [skillPut, expertPut];
    const { fetchMock } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT"
          ? (puts.shift()?.promise ?? capsBody([]))
          : capsBody(["weekly-report"], TESTER.id),
    });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    let dialog = await openSkills();
    const deploy = switchOf(dialog, "deploy");
    deploy.focus();
    fireEvent.click(deploy);
    await quiesce();

    expect(switches(dialog)).toEqual([
      ["deploy", "false", "true"],
      ["weekly-report", "false", "true"],
    ]);
    expect(deploy.disabled).toBe(false);
    expect(document.activeElement).toBe(deploy);
    fireEvent.click(switchOf(dialog, "weekly-report"));
    fireEvent.click(deploy);
    await quiesce();
    expect(capsWrites(fetchMock)).toHaveLength(1);
    expect(removeButton().disabled).toBe(true);
    await closeSkills(dialog);
    expect(pickItem(await openMenu()).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await settleDeferredResponse(skillPut, capsBody(["deploy", "weekly-report"], TESTER.id));
    fireEvent.click(removeButton());
    dialog = await openSkills();
    expect(switches(dialog)).toEqual([
      ["deploy", "false", "true"],
      ["weekly-report", "false", "true"],
    ]);
    fireEvent.click(switchOf(dialog, "deploy"));
    await quiesce();
    expect(capsWrites(fetchMock)).toEqual([
      [capsPath(A), '{"disabledSkills":["deploy","weekly-report"]}'],
      [capsPath(A), '{"expertId":null}'],
    ]);
    await settleDeferredResponse(expertPut, capsBody(["deploy", "weekly-report"]));
    expect(switches(dialog)[0]).toEqual(["deploy", "false", null]);
  });

  it("技能 PUT 在途时切到 B：A 的应答与失败都丢弃，B 的开关照常可切换", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const puts = [first, second];
    const { nav } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? (puts.shift()?.promise ?? capsBody([])) : capsBody([]),
      [capsPath(B)]: () => capsBody(["weekly-report"]),
    });
    let dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));
    await closeSkills(dialog);
    await select(nav, "会话乙", B);
    await settleDeferredResponse(first, capsBody(["deploy"]));
    dialog = await openSkills();
    expect(switches(dialog)).toEqual([
      ["deploy", "true", null],
      ["weekly-report", "false", null],
    ]);
    await closeSkills(dialog);

    await select(nav, "会话甲", A);
    dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));
    await closeSkills(dialog);
    await select(nav, "会话乙", B);
    await settleDeferredResponse(second, envelope(500, "内部错误"));
    expect(alerts()).toEqual([]);
    dialog = await openSkills();
    expect(switches(dialog)[1]).toEqual(["weekly-report", "false", null]);
  });

  it("会话能力 GET 在途：正在读取技能…、开关不可操作、不过滤；GET 失败：alert 与开关不可操作、不过滤", async () => {
    const read = deferredResponse();
    const { fetchMock, nav } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: () => read.promise,
      [capsPath(B)]: () => envelope(500, "内部错误"),
    });
    let dialog = await openSkills();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    expect(switches(dialog)).toEqual([
      ["deploy", "true", "true"],
      ["weekly-report", "true", "true"],
    ]);
    fireEvent.click(switchOf(dialog, "deploy"));
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);

    await select(nav, "会话乙", B);
    dialog = await openSkills();
    expect(within(dialog).getByRole("alert").textContent).toBe(SESSION_FAILED);
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    expect(switches(dialog).map(([, , disabled]) => disabled)).toEqual(["true", "true"]);
    fireEvent.click(switchOf(dialog, "deploy"));
    await closeSkills(dialog);
    expect(await menuCommands()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);
    expect(capsWrites(fetchMock)).toEqual([]);
    await settleDeferredResponse(read, capsBody(["deploy"]));
  });

  it("同一闭包连调两次 toggleSkill：恰一次 PUT；能力尚未取得时 toggleSkill 不发", async () => {
    const put = vi.fn(() => new Promise<never>(() => {}));
    let answer: (value: { expertId: null; disabledSkills: string[] }) => void = () => undefined;
    const client = {
      getSessionCapabilities: vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
      putSessionCapabilities: put,
    } as unknown as Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
    const { result } = renderHook(() => useSessionCapabilities(client, A));
    act(() => result.current.toggleSkill("deploy", false));
    expect(put).not.toHaveBeenCalled();
    await act(async () => answer({ expertId: null, disabledSkills: ["ghost"] }));

    act(() => {
      const { toggleSkill } = result.current;
      toggleSkill("deploy", false);
      toggleSkill("lint", false);
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(A, { disabledSkills: ["deploy", "ghost"] });
    expect(result.current.pending).toBe(true);
    expect(result.current.disabledSkills).toEqual(["deploy", "ghost"]);
  });
});

describe("能力 弹层的目录", () => {
  it("目录读取失败、没有 skill: 条目：暂无可用技能（底部说明仍在）；失败后重开弹层再取一次", async () => {
    let asked = 0;
    await mountSelected(A, {
      [COMMANDS]: () => {
        asked += 1;
        return asked === 1 ? envelope(500, "内部错误") : jsonResponse({ commands: [COMPACT] });
      },
    });
    for (const expected of [1, 2]) {
      const dialog = await openSkills();
      expect(asked).toBe(expected);
      expect(within(dialog).getByText(EMPTY)).toBeTruthy();
      expect(within(dialog).getByText(FOOTER)).toBeTruthy();
      expect(switches(dialog)).toEqual([]);
      expect(alerts()).toEqual([]);
      await closeSkills(dialog);
    }
  });

  it("回合进行中（输入框锁定）且目录未取得：能力 按钮可用，打开恰一次 listCommands，暂无可用技能 原位替换，开关可切换", async () => {
    const running = chatSnapshot();
    const id = running.session.id;
    const pending = deferredResponse();
    const { fetchMock } = renderChatPage(`/?session=${id}`, {
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [messagesPath(id)]: () => jsonResponse(running),
      [COMMANDS]: () => pending.promise,
      [capsPath(id)]: () => capsBody([]),
    });
    await screen.findByRole("button", { name: "停止" });
    await quiesce();
    expect(composer().disabled).toBe(true);
    expect(capabilityButton().disabled).toBe(false);
    expect(calls(fetchMock, COMMANDS)).toHaveLength(0);

    const dialog = await openSkills();
    expect(within(dialog).getByText(EMPTY)).toBeTruthy();
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
    await settleDeferredResponse(pending, jsonResponse({ commands: CATALOG }));

    expect(within(dialog).queryByText(EMPTY)).toBeNull();
    fireEvent.click(switchOf(dialog, "deploy"));
    await waitFor(() => expect(capsWrites(fetchMock)).toHaveLength(1));
    await closeSkills(dialog);
    await openSkills();
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
  });

  it("会话还没解析出来（历史读取失败、不在列表里）：暂无可用技能，不发 listCommands 与 GET …/capabilities", async () => {
    const { fetchMock } = mountSessions(`/?session=${C}`, [SA], {
      [COMMANDS]: catalogue(CATALOG),
      [messagesPath(C)]: () => envelope(500, "内部错误"),
    });
    await findList("会话甲");
    await waitFor(() => expect(alerts()).toEqual([expect.stringContaining("内部错误")]));
    await quiesce();

    const dialog = await openSkills();
    expect(within(dialog).getByText(EMPTY)).toBeTruthy();
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    expect(calls(fetchMock, COMMANDS)).toHaveLength(0);
    expect(capsReads(fetchMock)).toEqual([]);
  });
});

describe("欢迎态的 能力 弹层", () => {
  it("挂载不取 /api/skills、不过滤；第一次打开恰一次 GET，挂起时 正在读取技能… 且不可切换、重开不重发；失败显示 alert；重开恰重取一次，成功后按 disabledSkills 可切换", async () => {
    const first = deferredResponse();
    let asked = 0;
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue(CATALOG),
      [SKILLS]: () => {
        asked += 1;
        return asked === 1 ? first.promise : skillsBody(["weekly-report"]);
      },
    });
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);
    expect(skillReads(fetchMock)).toBe(0);

    let dialog = await openSkills();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    expect(switches(dialog).map(([, , disabled]) => disabled)).toEqual(["true", "true"]);
    fireEvent.click(switchOf(dialog, "deploy"));
    expect(switches(dialog)[0]).toEqual(["deploy", "true", "true"]);
    await closeSkills(dialog);
    dialog = await openSkills();
    expect(skillReads(fetchMock)).toBe(1);

    await settleDeferredResponse(first, envelope(500, "内部错误"));
    expect(within(dialog).getByRole("alert").textContent).toBe(WELCOME_FAILED);
    expect(switches(dialog).map(([, , disabled]) => disabled)).toEqual(["true", "true"]);
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy", "weekly-report"]);

    dialog = await openSkills();
    await waitFor(() =>
      expect(switches(dialog)).toEqual([
        ["deploy", "true", null],
        ["weekly-report", "false", null],
      ]),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(skillReads(fetchMock)).toBe(2);
    await closeSkills(dialog);
    await openSkills();
    expect(skillReads(fetchMock)).toBe(2);
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
  });

  it("账号缺省按 client 缓存：同一 client 取得后不再取；换 client 回到未取得，打开时为新 client 再取一次", async () => {
    const clientOf = (disabledSkills: string[]) =>
      ({ listSkills: vi.fn(async () => ({ skills: [], disabledSkills })) }) as unknown as Pick<
        ApiClient,
        "listSkills"
      > & { listSkills: ReturnType<typeof vi.fn> };
    const first = clientOf(["deploy"]);
    const second = clientOf(["lint"]);
    const { result, rerender } = renderHook(({ client }) => useSkillDefaults(client), {
      initialProps: { client: first },
    });
    expect(result.current.status).toBe("idle");
    await act(async () => result.current.load());
    await act(async () => result.current.load());
    expect(result.current.disabledSkills).toEqual(["deploy"]);

    rerender({ client: second });
    expect([result.current.status, result.current.disabledSkills]).toEqual(["idle", null]);
    await act(async () => result.current.load());

    expect(result.current.disabledSkills).toEqual(["lint"]);
    expect(first.listSkills).toHaveBeenCalledTimes(1);
    expect(second.listSkills).toHaveBeenCalledTimes(1);
  });

  it("「欢迎态带初值」：不改动发送不带 disabledSkills；关掉 deploy 后发送带完整集合；共恰一次 GET /api/skills，且没有第二次 getComposerOptions", async () => {
    const mounted = await mountWelcome({
      [COMMANDS]: catalogue([COMPACT, TODO, DEPLOY, WEEKLY]),
      [SKILLS]: () => skillsBody(["weekly-report"]),
    });
    const { fetchMock } = mounted;
    await closeSkills(await openSkills());
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "deploy"]);
    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });

    const dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));
    expect(switches(dialog)[0]).toEqual(["deploy", "false", null]);
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单"]);
    typeDraft("再来");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(2));
    await quiesce();

    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office"}'),
      createOf('{"scene":"office","disabledSkills":["deploy","weekly-report"]}'),
    ]);
    expect(skillReads(fetchMock)).toBe(1);
    expect(optionCalls(fetchMock)).toBe(1);
    expect(capsWrites(fetchMock)).toEqual([]);
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
  });

  it("「欢迎态带初值」：缺省停用 ghost 与覆盖平台技能的 weekly-report；打开它后发送的 body 为 [ghost]", async () => {
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue([DEPLOY, WEEKLY_OVER]),
      [SKILLS]: () => skillsBody(["ghost", "weekly-report"]),
    });
    const dialog = await openSkills();
    expect(rows(dialog)).toEqual(["deploy", "weekly-report项目 · 覆盖平台技能"]);
    expect(switches(dialog)).toEqual([
      ["deploy", "true", null],
      ["weekly-report", "false", null],
    ]);
    fireEvent.click(switchOf(dialog, "weekly-report"));
    await closeSkills(dialog);
    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(1));

    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","disabledSkills":["ghost"]}'),
    ]);
  });
});
