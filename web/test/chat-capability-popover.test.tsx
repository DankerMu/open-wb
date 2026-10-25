// 输入框「能力」弹层（skill-switches「输入框「能力」弹层」与「停用技能对 omp 生效」的客户端过滤、chat-web「输入框
// 与能力栏」的 `能力` 按钮、「停用技能过滤」与「能力读取时机」；s1d-experts-skills 任务 10.2 的定案）：弹层列出
// 目录的 `skill:` 条目与开关（初值、项目标记、底部说明、`暂无可用技能`），会话中切换恰一次 `PUT`（完整集合、
// 成功以应答为准、失败回滚、401、在途不可操作、切走后丢弃），会话能力读取中 / 失败 / 重新选中后重读，斜杠候选与
// 「+」菜单的过滤与 `listCommands` 次数，会话中不取账号缺省（欢迎态见 `chat-capability-popover-welcome.test.tsx`）。
// seam：整页挂载 + 假 API（`fetch`）；在途守卫与 `PUT` 应答后的同帧再切另以 `renderHook` 同闭包连调
// （`aria-disabled` 的开关照样分派点击，守卫必须真实存在）。期望值取自规格条文与 tasks.md 10.2。
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionCapabilities } from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient, SessionCapabilities } from "../src/lib/api.js";
import { TESTER } from "./center-experts-support.js";
import {
  CATALOG,
  capabilityButton,
  capsBody,
  closeSkills,
  DEPLOY,
  EMPTY,
  FOOTER,
  LINT,
  LOADING,
  menuCommands,
  openSkills,
  rows,
  SESSION_FAILED,
  skillReads,
  slashLabels,
  switches,
  switchOf,
  WEEKLY,
  WEEKLY_OVER,
} from "./chat-capability-popover-support.js";
import {
  alerts,
  capsPath,
  capsReads,
  capsWrites,
  EXPERTS,
  experts,
  labelText,
  mountSelected,
  openMenu,
  pickItem,
  removeButton,
  SA,
  select,
} from "./chat-expert-picker-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
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
import { COMMANDS, COMPACT, catalogue, commandsOf, TODO } from "./chat-page-slash-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  HERO,
  leaveForWelcome,
  PROJECT_A,
  workspaceList,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";

afterEach(cleanupSessionMeta);

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
    expect(skillReads(fetchMock)).toBe(0);
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
    expect(skillReads(fetchMock)).toBe(0);
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
    const reopened = switchOf(dialog, "deploy");
    reopened.focus();
    fireEvent.click(reopened);
    await quiesce();
    expect(capsWrites(fetchMock)).toEqual([
      [capsPath(A), '{"disabledSkills":["deploy","weekly-report"]}'],
      [capsPath(A), '{"expertId":null}'],
    ]);
    await settleDeferredResponse(expertPut, capsBody(["deploy", "weekly-report"]));
    expect(switches(dialog)[0]).toEqual(["deploy", "false", null]);
    // 应答后开关恢复可切换，焦点仍在按下的开关上。
    expect(document.activeElement).toBe(reopened);
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

  it("回到欢迎态再选中同一会话：重读在途时 正在读取技能…、开关 aria-disabled、点了不发 PUT（不以上一次的集合为底）；重读落地后开关按应答", async () => {
    const reread = deferredResponse();
    let reads = 0;
    const mounted = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: (_path, init) => {
        if (init?.method === "PUT") return capsBody(["deploy"]);
        reads += 1;
        return reads === 1 ? capsBody([]) : reread.promise;
      },
    });
    const { fetchMock, nav } = mounted;
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await select(nav, "会话甲", A);

    const dialog = await openSkills();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(switches(dialog)).toEqual([
      ["deploy", "true", "true"],
      ["weekly-report", "true", "true"],
    ]);
    fireEvent.click(switchOf(dialog, "deploy"));
    await quiesce();
    expect(capsWrites(fetchMock)).toEqual([]);

    await settleDeferredResponse(reread, capsBody(["deploy"]));
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    expect(switches(dialog)).toEqual([
      ["deploy", "false", null],
      ["weekly-report", "true", null],
    ]);
    expect(capsReads(fetchMock)).toEqual([capsPath(A), capsPath(A)]);
  });

  it("上一次读取失败、重新选中该会话：重读在途时是 正在读取技能…，不是失败提示", async () => {
    const reread = deferredResponse();
    let reads = 0;
    const mounted = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: () => {
        reads += 1;
        return reads === 1 ? envelope(500, "内部错误") : reread.promise;
      },
    });
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await select(mounted.nav, "会话甲", A);

    const dialog = await openSkills();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await settleDeferredResponse(reread, capsBody([]));
    expect(switches(dialog)[0]).toEqual(["deploy", "true", null]);
  });

  it("同一闭包连调两次 toggleSkill：恰一次 PUT；能力尚未取得时 toggleSkill 不发", async () => {
    const put = vi.fn(() => new Promise<never>(() => {}));
    let answer: (value: SessionCapabilities) => void = () => undefined;
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
    await act(async () =>
      answer({ expertId: null, disabledSkills: ["ghost"], disabledConnectors: [] }),
    );

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

  it("PUT 应答落地的同一帧里（重渲染之前）用旧闭包再切：以应答的集合为底", async () => {
    let settle: (value: SessionCapabilities) => void = () => undefined;
    const put = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockImplementation(() => new Promise<never>(() => {}));
    const client = {
      getSessionCapabilities: vi.fn(async () => ({
        expertId: null,
        disabledSkills: [],
        disabledConnectors: [],
      })),
      putSessionCapabilities: put,
    } as unknown as Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
    const { result } = renderHook(() => useSessionCapabilities(client, A));
    await waitFor(() => expect(result.current.read).toBe("done"));
    act(() => result.current.toggleSkill("deploy", false));
    const stale = result.current;

    await act(async () => {
      settle({
        expertId: null,
        disabledSkills: ["deploy", "weekly-report"],
        disabledConnectors: [],
      });
      await Promise.resolve();
      stale.toggleSkill("lint", false);
    });

    expect(put.mock.calls).toEqual([
      [A, { disabledSkills: ["deploy"] }],
      [A, { disabledSkills: ["deploy", "lint", "weekly-report"] }],
    ]);
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

  it("会话还没解析出来（历史读取失败、不在列表里）：暂无可用技能，不发 listCommands、GET …/capabilities 与 GET /api/skills，没有提示", async () => {
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
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(skillReads(fetchMock)).toBe(0);
  });
});
