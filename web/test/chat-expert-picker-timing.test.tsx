// 会话能力的读取时机与迟到 / 在途的丢弃（chat-web「能力读取时机」、experts「输入框的专家选择」；
// s1d-experts-skills 任务 9.2「读取与状态的定案」）：按已解析的选中会话 id 变化一次 `GET …/capabilities`（URL 里
// 无法解析的 id 不取、归档会话照取、发消息 / 回合结束 / 重读列表不重取），首次 `GET` 与 `PUT` 交错时谁落地，
// 切换会话后迟到的 `GET` 与在途的 `PUT`，以及同闭包连调的 ref 守卫。seam：整页挂载 + 假 API（`fetch`）；
// 在途守卫另以 `renderHook` 同闭包连调（禁用的按钮不分派 React 事件，整页够不到 ref 守卫）。
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionCapabilities } from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient } from "../src/lib/api.js";
import { ANALYST, DESIGNER, FRONTEND, TESTER } from "./center-experts-support.js";
import {
  alerts,
  caps,
  capsPath,
  capsReads,
  capsWrites,
  choose,
  EXPERTS,
  experts,
  label,
  labelText,
  mountSelected,
  openExperts,
  openMenu,
  pickItem,
  removeButton,
  SA,
  SB,
  select,
} from "./chat-expert-picker-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  C,
  cleanupSessionMeta,
  envelope,
  findList,
  messagesPath,
  mountSessions,
  view,
} from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue } from "./chat-page-slash-support.js";
import { chatSnapshot, latestListSource, latestSource, settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";

const ARCHIVED_AT = 1_760_000_000_000;
const LIST_READ = "/api/sessions";

afterEach(cleanupSessionMeta);

describe("会话能力的读取时机", () => {
  it("选中的会话 id 每变化一次恰一次 GET（A→B→A 共三次）；同一会话发消息、回合结束、重读列表不重取", async () => {
    let snapshot = chatSnapshot({ assistantStatus: "done", content: "回答" });
    const { fetchMock, nav } = await mountSelected(A, {
      [messagesPath(A)]: () => jsonResponse({ ...snapshot, session: SA }),
      [`/api/sessions/${A}/prompt`]: () => {
        snapshot = chatSnapshot({ assistantStatus: "done", content: "第二个回答" });
        return jsonResponse({ userMessageId: 5, assistantMessageId: 6, undo: "none" }, 202);
      },
    });
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);

    typeDraft("再问一句");
    clickSend();
    await waitFor(() => expect(calls(fetchMock, `/api/sessions/${A}/prompt`)).toHaveLength(1));
    await quiesce();
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);

    // 回合结束，随后列表事件触发一次会话列表重读：选中会话的视图换成新对象，id 不变。
    const listReads = calls(fetchMock, LIST_READ).length;
    await act(async () => {
      latestSource().emitData("turn.end", "1:1", { messageId: 6, status: "done" });
      await settle();
    });
    await act(async () => {
      latestListSource().emitNamed("sessions.changed", "{}");
      await settle();
    });
    await waitFor(() => expect(calls(fetchMock, LIST_READ).length).toBeGreaterThan(listReads));
    await quiesce();
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);

    await select(nav, "会话乙", B);
    await select(nav, "会话甲", A);
    expect(capsReads(fetchMock)).toEqual([capsPath(A), capsPath(B), capsPath(A)]);
  });

  it("URL 里无法解析的 id（历史 404、不在列表里）：不发 GET …/capabilities", async () => {
    const { fetchMock } = mountSessions(`/?session=${C}`, [SA], {
      [EXPERTS]: () => experts(),
      [COMMANDS]: catalogue(),
      [messagesPath(C)]: () => envelope(404, "会话不存在"),
    });
    await findList("会话甲");
    await waitFor(() => expect(calls(fetchMock, messagesPath(C))).toHaveLength(1));
    await quiesce();

    expect(capsReads(fetchMock)).toEqual([]);
  });

  it("选中的 id 还没解析出来（历史读取失败、不在列表里）：不发 GET，选择专家… 禁用", async () => {
    const { fetchMock } = mountSessions(`/?session=${C}`, [SA], {
      [EXPERTS]: () => experts(),
      [COMMANDS]: catalogue(),
      [messagesPath(C)]: () => envelope(500, "内部错误"),
    });
    await findList("会话甲");
    await waitFor(() => expect(alerts()).toEqual([expect.stringContaining("内部错误")]));
    await quiesce();

    expect(currentLocation()).toBe(`/?session=${C}`);
    expect(capsReads(fetchMock)).toEqual([]);
    expect(pickItem(await openMenu()).getAttribute("aria-disabled")).toBe("true");
  });

  it("归档会话照取：选中已归档的会话恰一次 GET 它的 …/capabilities", async () => {
    const { fetchMock } = mountSessions(
      `/?session=${A}`,
      [view(A, "旧项目", { archivedAt: ARCHIVED_AT }), SB],
      { [EXPERTS]: () => experts(), [COMMANDS]: catalogue() },
    );
    await findList("会话乙");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="archived-notice"]')).not.toBeNull(),
    );
    await quiesce();

    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);
  });

  it("GET 失败：没有标签、没有提示；下次选中该会话再取", async () => {
    let asked = 0;
    const { fetchMock, nav } = await mountSelected(A, {
      [capsPath(A)]: () => {
        asked += 1;
        return asked === 1 ? envelope(500, "内部错误") : caps(TESTER.id);
      },
    });
    expect(label()).toBeNull();
    expect(alerts()).toEqual([]);

    await select(nav, "会话乙", B);
    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    expect(capsReads(fetchMock)).toEqual([capsPath(A), capsPath(B), capsPath(A)]);
  });

  it("A 的 GET 在切到 B 之后才到：丢弃，B 的标签不受影响", async () => {
    const late = deferredResponse();
    let reads = 0;
    const { nav } = await mountSelected(B, {
      [capsPath(A)]: () => {
        reads += 1;
        return reads === 1 ? late.promise : caps(DESIGNER.id);
      },
      [capsPath(B)]: () => caps(TESTER.id),
    });
    await select(nav, "会话甲", A);
    expect(label()).toBeNull();

    await select(nav, "会话乙", B);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    await settleDeferredResponse(late, caps(ANALYST.id));
    expect(labelText()).toBe("专家 · 测试工程师");

    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 品牌视觉设计师"));
  });

  it("PUT 在途：选择专家… 与 移除专家 禁用；切到 B 后 B 照常可用，A 的应答与失败都丢弃", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const puts = [first, second];
    const { fetchMock, nav } = await mountSelected(A, {
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? (puts.shift()?.promise ?? caps(null)) : caps(TESTER.id),
      [capsPath(B)]: () => caps(FRONTEND.id),
    });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));

    fireEvent.click(removeButton());
    await quiesce();
    expect(removeButton().disabled).toBe(true);
    fireEvent.click(removeButton());
    const menu = await openMenu();
    expect(pickItem(menu).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(capsWrites(fetchMock)).toHaveLength(1);

    await select(nav, "会话乙", B);
    await waitFor(() => expect(labelText()).toBe("专家 · 前端架构师"));
    expect(removeButton().disabled).toBe(false);
    await settleDeferredResponse(first, caps(null));
    expect(labelText()).toBe("专家 · 前端架构师");

    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    fireEvent.click(removeButton());
    await quiesce();
    await select(nav, "会话乙", B);
    await settleDeferredResponse(second, envelope(409, "会话已归档"));
    expect(alerts()).toEqual([]);
    expect(labelText()).toBe("专家 · 前端架构师");
  });

  it("首次 GET 在途时换专家、PUT 失败：之后到达的 GET 照常落地，保留原标签并显示失败", async () => {
    const read = deferredResponse();
    await mountSelected(A, {
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? envelope(500, "内部错误") : read.promise,
    });
    expect(label()).toBeNull();

    await choose(await openExperts(), "前端架构师");
    await waitFor(() => expect(alerts()).toEqual(["内部错误"]));
    await settleDeferredResponse(read, caps(TESTER.id));

    expect(labelText()).toBe("专家 · 测试工程师");
    expect(alerts()).toEqual(["内部错误"]);
  });

  it("首次 GET 在途时换专家、PUT 先成功：之后到达的旧 GET 丢弃，标签为 PUT 的应答", async () => {
    const read = deferredResponse();
    await mountSelected(A, {
      [capsPath(A)]: (_path, init) => (init?.method === "PUT" ? caps(FRONTEND.id) : read.promise),
    });

    await choose(await openExperts(), "前端架构师");
    await waitFor(() => expect(labelText()).toBe("专家 · 前端架构师"));
    await settleDeferredResponse(read, caps(TESTER.id));

    expect(labelText()).toBe("专家 · 前端架构师");
    expect(alerts()).toEqual([]);
  });

  it("同一闭包连调两次 chooseExpert：恰一次 PUT（hook 内的 ref 守卫）", async () => {
    const put = vi.fn(() => new Promise<never>(() => {}));
    const client = {
      getSessionCapabilities: vi.fn(async () => ({
        expertId: TESTER.id,
        disabledSkills: [],
        disabledConnectors: [],
      })),
      putSessionCapabilities: put,
    } as unknown as Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
    const { result } = renderHook(() => useSessionCapabilities(client, A));
    await waitFor(() => expect(result.current.capabilities?.expertId).toBe(TESTER.id));

    act(() => {
      const { chooseExpert } = result.current;
      chooseExpert(null);
      chooseExpert(FRONTEND.id);
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(A, { expertId: null });
    expect(result.current.pending).toBe(true);
  });
});
