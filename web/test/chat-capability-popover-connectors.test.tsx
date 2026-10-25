// 输入框「能力」弹层的 `连接器` 段（skill-switches「输入框「能力」弹层」的「连接器段」；chat-web「输入框与能力栏」
// 的「能力读取时机」五种读取与「设置保存」豁免；session-sidebar「欢迎页场景胶囊与场景化快捷任务」的首次发送 body；
// s1d-connectors 任务 7.2 与编排方的两处裁定）：只列启用的连接器、开关初值（欢迎态取账号缺省、会话中取能力）、
// 会话中切换恰一次 `PUT {disabledConnectors}`、失败回滚、欢迎态动过才带 `disabledConnectors`、读取中与失败态、
// 重开只重取失败的那一个、读取时机与 `getComposerOptions` 计数。seam：整页挂载 + 假 API（`fetch`）；共用在途守卫
// 另以 `renderHook` 同闭包连调。期望值取自规格条文与 tasks.md 7.2 / 7.3。
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionCapabilities } from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient } from "../src/lib/api.js";
import { httpView, stdioView } from "./center-connectors-support.js";
import {
  adminConnectorsBody,
  CATALOG,
  CONNECTOR_DEFAULTS,
  CONNECTOR_EMPTY,
  CONNECTOR_FAILED,
  CONNECTOR_LOADING,
  CONNECTORS,
  capsBody,
  closeSkills,
  connectorDefaultsBody,
  connectorReads,
  connectorSection,
  connectorsBody,
  LOADING,
  openSkills,
  rows,
  SESSION_FAILED,
  SKILLS,
  skillSwitches,
  skillSwitchOf,
  skillsBody,
  switches,
  switchOf,
} from "./chat-capability-popover-support.js";
import {
  alerts,
  capsPath,
  capsWrites,
  mountSelected,
  mountWelcome,
  optionCalls,
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
} from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue } from "./chat-page-slash-support.js";
import { createOf, createRequests } from "./chat-page-welcome-scene-support.js";
import { deferredResponse } from "./support.js";

afterEach(cleanupSessionMeta);

describe("欢迎态的 连接器 段", () => {
  it("「连接器段」：技能段之后列出 gitlab（开）与 wiki（关，账号缺省 [ghost, wiki]）；打开 wiki 后发送 body 带 disabledConnectors:[ghost]；两项读取各恰一次，挂载时不取；只动连接器开关不重取输入框选项", async () => {
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue(CATALOG),
      [SKILLS]: () => skillsBody([]),
      [CONNECTORS]: () => connectorsBody(["gitlab", "wiki"]),
      [CONNECTOR_DEFAULTS]: () => connectorDefaultsBody(["ghost", "wiki"]),
    });
    expect(connectorReads(fetchMock)).toEqual([0, 0]);

    const dialog = await openSkills();
    expect(rows(dialog)).toEqual(["deploy", "weekly-report项目 · 覆盖平台技能", "gitlab", "wiki"]);
    const section = connectorSection(dialog);
    expect(within(section).getByText("连接器")).toBeTruthy();
    expect(rows(section)).toEqual(["gitlab", "wiki"]);
    expect(switches(section)).toEqual([
      ["gitlab", "true", null],
      ["wiki", "false", null],
    ]);
    expect(within(section).queryByText(CONNECTOR_EMPTY)).toBeNull();
    fireEvent.click(switchOf(section, "wiki"));
    expect(switches(section)[1]).toEqual(["wiki", "true", null]);
    await closeSkills(dialog);
    await closeSkills(await openSkills());

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
    await quiesce();
    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","disabledConnectors":["ghost"]}'),
    ]);
    expect(connectorReads(fetchMock)).toEqual([1, 1]);
    expect(optionCalls(fetchMock)).toBe(1);
    expect(capsWrites(fetchMock)).toEqual([]);
  });

  it("「连接器段」另一次：不碰连接器开关只关掉同名技能 deploy（按段取开关）后发送：body 带 disabledSkills、不带 disabledConnectors，连接器 deploy 仍开", async () => {
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue(CATALOG),
      [SKILLS]: () => skillsBody([]),
      [CONNECTORS]: () => connectorsBody(["deploy", "gitlab"]),
      [CONNECTOR_DEFAULTS]: () => connectorDefaultsBody(["ghost"]),
    });
    const dialog = await openSkills();
    fireEvent.click(skillSwitchOf(dialog, "deploy"));
    expect(skillSwitches(dialog)).toEqual([
      ["deploy", "false", null],
      ["weekly-report", "true", null],
    ]);
    expect(switches(connectorSection(dialog))).toEqual([
      ["deploy", "true", null],
      ["gitlab", "true", null],
    ]);
    await closeSkills(dialog);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(1));
    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","disabledSkills":["deploy"]}'),
    ]);
  });

  it("连接器缺省挂起：正在读取连接器… 且开关 aria-disabled、点了不变；以 500 失败：段内 alert、开关仍不可切换；重开只重取缺省（清单不重取），成功后按缺省可切换", async () => {
    const pending = deferredResponse();
    let asked = 0;
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue(CATALOG),
      [SKILLS]: () => skillsBody([]),
      [CONNECTORS]: () => connectorsBody(["gitlab"]),
      [CONNECTOR_DEFAULTS]: () => {
        asked += 1;
        return asked === 1 ? pending.promise : connectorDefaultsBody(["gitlab"]);
      },
    });
    let dialog = await openSkills();
    let section = connectorSection(dialog);
    expect(within(section).getByText(CONNECTOR_LOADING)).toBeTruthy();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    fireEvent.click(switchOf(section, "gitlab"));
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    // 技能段不受连接器读取影响。
    expect(skillSwitches(dialog).map(([, , disabled]) => disabled)).toEqual([null, null]);

    await settleDeferredResponse(pending, envelope(500, "内部错误"));
    expect(within(section).getByRole("alert").textContent).toBe(CONNECTOR_FAILED);
    expect(within(section).queryByText(CONNECTOR_LOADING)).toBeNull();
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    await closeSkills(dialog);
    expect(connectorReads(fetchMock)).toEqual([1, 1]);

    dialog = await openSkills();
    section = connectorSection(dialog);
    await waitFor(() => expect(switches(section)).toEqual([["gitlab", "false", null]]));
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(connectorReads(fetchMock)).toEqual([1, 2]);
    await closeSkills(dialog);
    await openSkills();
    expect(connectorReads(fetchMock)).toEqual([1, 2]);
  });

  it("连接器清单失败、缺省成功：段内 alert、没有开关；重开只重取清单（缺省不重取），成功后列出并可切换", async () => {
    let asked = 0;
    const { fetchMock } = await mountWelcome({
      [CONNECTORS]: () => {
        asked += 1;
        return asked === 1 ? envelope(500, "内部错误") : connectorsBody(["wiki"]);
      },
      [CONNECTOR_DEFAULTS]: () => connectorDefaultsBody([]),
    });
    let dialog = await openSkills();
    let section = connectorSection(dialog);
    expect(within(section).getByRole("alert").textContent).toBe(CONNECTOR_FAILED);
    expect(switches(section)).toEqual([]);
    expect(within(section).queryAllByRole("listitem")).toEqual([]);
    expect(within(section).queryByText(CONNECTOR_EMPTY)).toBeNull();
    await closeSkills(dialog);

    dialog = await openSkills();
    section = connectorSection(dialog);
    await waitFor(() => expect(switches(section)).toEqual([["wiki", "true", null]]));
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(connectorReads(fetchMock)).toEqual([2, 1]);
  });

  it("没有启用的连接器：段内只显示 暂无可用连接器，没有 listitem 与 switch，也没有提示", async () => {
    const { fetchMock } = await mountWelcome({ [COMMANDS]: catalogue(CATALOG) });
    const dialog = await openSkills();
    const section = connectorSection(dialog);
    expect(within(section).getByText(CONNECTOR_EMPTY)).toBeTruthy();
    expect(within(section).queryAllByRole("listitem")).toEqual([]);
    expect(within(section).queryAllByRole("switch")).toEqual([]);
    expect(within(section).queryByText(CONNECTOR_LOADING)).toBeNull();
    expect(alerts()).toEqual([]);
    expect(connectorReads(fetchMock)).toEqual([1, 1]);
  });
});

describe("会话中的 连接器 段", () => {
  it("「连接器段」：能力 {disabledConnectors:[ghost]} 下关掉 gitlab 恰一次 PUT，body 恰为 {disabledConnectors:[ghost,gitlab]}；不取账号缺省", async () => {
    const { fetchMock } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [CONNECTORS]: () => connectorsBody(["gitlab", "wiki"]),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT"
          ? capsBody([], null, ["ghost", "gitlab"])
          : capsBody([], null, ["ghost"]),
    });
    expect(connectorReads(fetchMock)).toEqual([0, 0]);
    const dialog = await openSkills();
    const section = connectorSection(dialog);
    expect(switches(section)).toEqual([
      ["gitlab", "true", null],
      ["wiki", "true", null],
    ]);
    fireEvent.click(switchOf(section, "gitlab"));
    await waitFor(() => expect(switches(section)[0]).toEqual(["gitlab", "false", null]));
    await closeSkills(dialog);
    await openSkills();

    expect(capsWrites(fetchMock)).toEqual([
      [capsPath(A), '{"disabledConnectors":["ghost","gitlab"]}'],
    ]);
    expect(connectorReads(fetchMock)).toEqual([1, 0]);
    expect(optionCalls(fetchMock)).toBe(1);
  });

  it("「连接器段」500：开关回到开启，chat column 里以 alert 显示 message", async () => {
    await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [CONNECTORS]: () => connectorsBody(["gitlab", "wiki"]),
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? envelope(500, "内部错误") : capsBody([], null, ["ghost"]),
    });
    const dialog = await openSkills();
    const section = connectorSection(dialog);
    fireEvent.click(switchOf(section, "gitlab"));

    await waitFor(() => expect(alerts()).toEqual(["内部错误"]));
    expect(switches(section)).toEqual([
      ["gitlab", "true", null],
      ["wiki", "true", null],
    ]);
    expect(screen.getByRole("alert").closest('[data-slot="chat-column"]')).not.toBeNull();
  });

  it("只列启用的连接器：管理员视图里 enabled:false 的行不出现；初值取会话能力（含列表外名称）", async () => {
    await mountSelected(A, {
      [CONNECTORS]: () =>
        adminConnectorsBody([
          stdioView("gitlab"),
          httpView("wiki", { enabled: false }),
          httpView("docs"),
        ]),
      [capsPath(A)]: () => capsBody([], null, ["docs", "ghost"]),
    });
    const section = connectorSection(await openSkills());
    expect(rows(section)).toEqual(["gitlab", "docs"]);
    expect(switches(section)).toEqual([
      ["gitlab", "true", null],
      ["docs", "false", null],
    ]);
  });

  it("清单挂起：正在读取连接器…、没有开关；以 500 失败：段内 alert（与欢迎态同一文案）；重开恰再取一次，成功后列出", async () => {
    const pending = deferredResponse();
    let asked = 0;
    const { fetchMock } = await mountSelected(A, {
      [CONNECTORS]: () => {
        asked += 1;
        return asked === 1 ? pending.promise : connectorsBody(["gitlab"]);
      },
    });
    let dialog = await openSkills();
    let section = connectorSection(dialog);
    expect(within(section).getByText(CONNECTOR_LOADING)).toBeTruthy();
    expect(switches(section)).toEqual([]);
    expect(within(section).queryByText(CONNECTOR_EMPTY)).toBeNull();
    await settleDeferredResponse(pending, envelope(500, "内部错误"));
    expect(within(section).getByRole("alert").textContent).toBe(CONNECTOR_FAILED);
    await closeSkills(dialog);

    dialog = await openSkills();
    section = connectorSection(dialog);
    await waitFor(() => expect(switches(section)).toEqual([["gitlab", "true", null]]));
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(connectorReads(fetchMock)).toEqual([2, 0]);
  });

  it("会话能力 GET 在途或失败：连接器开关 aria-disabled、点了不发 PUT；连接器段不另加提示（沿用技能段那一条）", async () => {
    const read = deferredResponse();
    const { fetchMock, nav } = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [CONNECTORS]: () => connectorsBody(["gitlab"]),
      [capsPath(A)]: () => read.promise,
      [capsPath(B)]: () => envelope(500, "内部错误"),
    });
    let dialog = await openSkills();
    let section = connectorSection(dialog);
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    expect(within(dialog).getAllByText(LOADING)).toHaveLength(1);
    expect(within(section).queryByText(CONNECTOR_LOADING)).toBeNull();
    fireEvent.click(switchOf(section, "gitlab"));
    await quiesce();
    await closeSkills(dialog);

    await select(nav, "会话乙", B);
    dialog = await openSkills();
    section = connectorSection(dialog);
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((item) => item.textContent),
    ).toEqual([SESSION_FAILED]);
    fireEvent.click(switchOf(section, "gitlab"));
    await quiesce();
    expect(capsWrites(fetchMock)).toEqual([]);
    expect(connectorReads(fetchMock)).toEqual([1, 0]);
    await settleDeferredResponse(read, capsBody([]));
  });

  it("会话还没解析出来时打开弹层：照样取一次 GET /api/connectors，开关 aria-disabled，不发 GET …/capabilities 与账号缺省", async () => {
    const { fetchMock } = mountSessions(`/?session=${C}`, [SA], {
      [CONNECTORS]: () => connectorsBody(["gitlab"]),
      [messagesPath(C)]: () => envelope(500, "内部错误"),
    });
    await findList("会话甲");
    await waitFor(() => expect(alerts()).toEqual([expect.stringContaining("内部错误")]));
    await quiesce();

    const section = connectorSection(await openSkills());
    expect(switches(section)).toEqual([["gitlab", "true", "true"]]);
    expect(connectorReads(fetchMock)).toEqual([1, 0]);
    expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/capabilities"))).toBe(false);
  });

  it("同一闭包连调 toggleConnector 与 toggleSkill：共用一个在途写，恰一次 PUT {disabledConnectors}；能力尚未取得时不发", async () => {
    const put = vi.fn(() => new Promise<never>(() => {}));
    let answer: (value: unknown) => void = () => undefined;
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
    act(() => result.current.toggleConnector("gitlab", false));
    expect(put).not.toHaveBeenCalled();
    await act(async () =>
      answer({ expertId: null, disabledSkills: [], disabledConnectors: ["ghost"] }),
    );

    act(() => {
      const { toggleConnector, toggleSkill } = result.current;
      toggleConnector("gitlab", false);
      toggleSkill("deploy", false);
      toggleConnector("wiki", false);
    });

    expect(put.mock.calls).toEqual([[A, { disabledConnectors: ["ghost", "gitlab"] }]]);
    expect(result.current.pending).toBe(true);
    expect(result.current.disabledConnectors).toEqual(["ghost", "gitlab"]);
    expect(result.current.disabledSkills).toEqual([]);
  });
});

describe("连接器的读取时机（chat-web「能力读取时机」）", () => {
  it("先在欢迎态打开再在会话中打开：GET /api/connectors 全程恰一次、缺省只在欢迎态取一次；五种读取与只动连接器开关的首次发送都不重取输入框选项", async () => {
    const { fetchMock } = await mountWelcome({
      [COMMANDS]: catalogue(CATALOG),
      [SKILLS]: () => skillsBody([]),
      [CONNECTORS]: () => connectorsBody(["gitlab"]),
      [CONNECTOR_DEFAULTS]: () => connectorDefaultsBody([]),
    });
    expect(optionCalls(fetchMock)).toBe(1);
    let dialog = await openSkills();
    fireEvent.click(switchOf(connectorSection(dialog), "gitlab"));
    await closeSkills(dialog);
    expect(connectorReads(fetchMock)).toEqual([1, 1]);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
    await quiesce();
    dialog = await openSkills();
    // 会话中初值取会话能力（假路由的缺省能力 `disabledConnectors: []`），不是欢迎态的页面选择。
    expect(switches(connectorSection(dialog))).toEqual([["gitlab", "true", null]]);
    await closeSkills(dialog);

    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","disabledConnectors":["gitlab"]}'),
    ]);
    expect(connectorReads(fetchMock)).toEqual([1, 1]);
    expect(optionCalls(fetchMock)).toBe(1);
  });
});
