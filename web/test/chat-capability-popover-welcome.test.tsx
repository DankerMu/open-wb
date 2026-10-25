// 欢迎态的输入框「能力」弹层（skill-switches「输入框「能力」弹层」与「欢迎态带初值」、chat-web「能力读取时机」；
// s1d-experts-skills 任务 10.2 的定案）：账号缺省的读取时机（打开时取、按 client 缓存、失败重取）、页面选择与
// 首次发送的 `disabledSkills`（首次发送后不清）、弹层随会话上下文关闭。seam：整页挂载 + 假 API（`fetch`）；
// 按 client 缓存另以 `renderHook` 换 client。期望值取自规格条文与 tasks.md 10.2。当前会话原地归档再恢复与
// A → 欢迎态 → A 的逐帧持有集合取自 s1d-experts-skills-followups design D3（#1735）。
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useSessionCapabilities,
  useSkillDefaults,
} from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient, SessionCapabilities } from "../src/lib/api.js";
import {
  CATALOG,
  capsBody,
  closeSkills,
  DEPLOY,
  LOADING,
  openSkills,
  rows,
  SKILLS,
  skillReads,
  skillsBody,
  skillsDialog,
  slashLabels,
  switches,
  switchOf,
  WEEKLY,
  WEEKLY_OVER,
  WELCOME_FAILED,
} from "./chat-capability-popover-support.js";
import {
  capsPath,
  capsWrites,
  EXPERTS,
  experts,
  mountSelected,
  mountWelcome,
  optionCalls,
  SA,
} from "./chat-expert-picker-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  cleanupSessionMeta,
  envelope,
  findList,
  mountSessions,
  patchOf,
  patchPath,
  patchRequests,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { COMMANDS, COMPACT, catalogue, TODO } from "./chat-page-slash-support.js";
import {
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
} from "./chat-page-welcome-scene-support.js";
import { type FakeEventSource, latestListSource, settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";

afterEach(cleanupSessionMeta);

const ARCHIVED = '[data-slot="archived-notice"]';

/** 列表读取的当前响应：路由每次请求时读它，用例中途改写（同 chat-list-events.test.tsx 的 `replies`）。 */
function listReplies(sessions: readonly SessionView[]) {
  const state = { sessions };
  return { route: () => jsonResponse({ sessions: state.sessions }), state };
}

/** 在列表连接上派发 `sessions.changed`，并让由此发起的列表重取与渲染落定。 */
async function dispatchChanged(source: FakeEventSource = latestListSource()) {
  await act(async () => {
    source.emitNamed("sessions.changed", "{}");
    await settle();
  });
}

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

  it("首次发送后不清：关掉 deploy 后发送建会话，回到欢迎态 deploy 仍是关的、候选仍不列它，第二次首次发送仍带该集合", async () => {
    const mounted = await mountWelcome({
      [COMMANDS]: catalogue([COMPACT, TODO, DEPLOY, WEEKLY]),
      [SKILLS]: () => skillsBody([]),
    });
    const { fetchMock } = mounted;
    let dialog = await openSkills();
    fireEvent.click(switchOf(dialog, "deploy"));
    await closeSkills(dialog);
    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });

    dialog = await openSkills();
    expect(switches(dialog)).toEqual([
      ["deploy", "false", null],
      ["weekly-report", "true", null],
    ]);
    await closeSkills(dialog);
    expect(await slashLabels()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
    typeDraft("再来");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(2));
    const withSkills = createOf('{"scene":"office","disabledSkills":["deploy"]}');
    expect(createRequests(fetchMock)).toEqual([withSkills, withSkills]);
    expect(skillReads(fetchMock)).toBe(1);
  });
});

describe("能力 弹层随会话上下文关闭", () => {
  it("会话中开着弹层、不经点外面就回到欢迎态（导航）：弹层已关；在欢迎态重开恰一次 GET /api/skills，listCommands 次数不变", async () => {
    const mounted = await mountSelected(A, {
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: () => capsBody([]),
      [SKILLS]: () => skillsBody(["deploy"]),
    });
    const { fetchMock } = mounted;
    await openSkills();
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();
    expect(skillsDialog()).toBeNull();
    expect(skillReads(fetchMock)).toBe(0);

    const dialog = await openSkills();
    await waitFor(() =>
      expect(switches(dialog)).toEqual([
        ["deploy", "false", null],
        ["weekly-report", "true", null],
      ]),
    );
    expect(skillReads(fetchMock)).toBe(1);
    expect(calls(fetchMock, COMMANDS)).toHaveLength(1);
  });

  it("会话中开着弹层、经导航切到已归档的会话（输入框卸下）再回来：弹层不再自己打开", async () => {
    const mounted = mountSessions(`/?session=${A}`, [SA, view(B, "旧项目", { archivedAt: 1 })], {
      [EXPERTS]: () => experts(),
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: () => capsBody([]),
      [capsPath(B)]: () => capsBody([]),
    });
    await findList("会话甲");
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();
    await openSkills();

    await act(() => mounted.router.navigate(`/?session=${B}`));
    await waitFor(() => expect(document.querySelector(ARCHIVED)).not.toBeNull());
    expect(screen.queryByRole("button", { name: "能力" })).toBeNull();
    await act(() => mounted.router.navigate(`/?session=${A}`));
    await waitFor(() => expect(document.querySelector(ARCHIVED)).toBeNull());
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();
    expect(skillsDialog()).toBeNull();
  });

  it("当前会话原地被归档再恢复，弹层保持关闭", async () => {
    const session = `/?session=${A}`;
    const list = listReplies([SA]);
    const { fetchMock } = mountSessions(session, [SA], {
      "/api/sessions": list.route,
      [EXPERTS]: () => experts(),
      [COMMANDS]: catalogue(CATALOG),
      [capsPath(A)]: () => capsBody([]),
      [patchPath(A)]: () => jsonResponse({ ...SA, archivedAt: null }),
    });
    await findList("会话甲");
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();
    await openSkills();

    list.state.sessions = [{ ...SA, archivedAt: 1 }];
    await dispatchChanged();
    await waitFor(() => expect(document.querySelector(ARCHIVED)).not.toBeNull());
    expect(screen.queryByRole("button", { name: "能力" })).toBeNull();
    expect(currentLocation()).toBe(session);

    list.state.sessions = [SA];
    const notice = document.querySelector<HTMLElement>(ARCHIVED);
    if (!notice) throw new Error("没有 archived-notice");
    fireEvent.click(within(notice).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(document.querySelector(ARCHIVED)).toBeNull());
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();

    expect(skillsDialog()).toBeNull();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"archived":false}')]);
    expect(currentLocation()).toBe(session);
  });
});

describe("回到会话的第一帧不带欢迎态之前持有的能力", () => {
  it("A → 欢迎态 → A：回到 A 的那次渲染（effect 发起新读取之前）capabilities 为 null，不是上一次取得的集合", async () => {
    const held: SessionCapabilities = {
      expertId: "e1",
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    };
    const client = {
      getSessionCapabilities: vi
        .fn()
        .mockResolvedValueOnce(held)
        .mockImplementation(() => new Promise<never>(() => {})),
      putSessionCapabilities: vi.fn(),
    } as unknown as Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
    const frames: (SessionCapabilities | null)[] = [];
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | undefined }) => {
        const state = useSessionCapabilities(client, sessionId);
        frames.push(state.capabilities);
        return state;
      },
      { initialProps: { sessionId: A as string | undefined } },
    );
    await waitFor(() => expect(result.current.capabilities).toEqual(held));
    rerender({ sessionId: undefined });

    const back = frames.length;
    rerender({ sessionId: A });

    expect(frames[back]).toBeNull();
    expect(client.getSessionCapabilities).toHaveBeenCalledTimes(2);
  });
});
