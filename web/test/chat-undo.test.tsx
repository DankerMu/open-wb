// 用户消息的 `撤回`（message-undo「web 撤回」；chat-web「用户消息操作行的按钮与次序」）：按钮、撤回动作、
// 冲突对话框与所有权 fence。seam：整页挂载 + 假 API / 假 EventSource。测试不派发 `session.rewound`。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionUndo } from "../src/lib/session-contract.js";
import { area, chips, choose, file, land, send, statuses } from "./chat-attachments-support.js";
import { renderChatPageWithAuthProbe, renewAccount } from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID, promptAccepted } from "./chat-page-ownership-support.js";
import { PROJECT_A, workspaceList } from "./chat-page-welcome-scene-support.js";
import {
  FakeEventSource,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
} from "./chat-stream-support.js";
import {
  A_URL,
  alerts,
  assistant,
  bar,
  buttons,
  CONFLICT,
  CONFLICT_TEXT,
  cleanupUndoPage,
  clickUndo,
  conflictDialog,
  description,
  envelope,
  expectNoDialog,
  expectNoNotice,
  expectRewound,
  FORK_LABEL,
  FULL,
  flush,
  GUIDANCE,
  LIST,
  listGets,
  MESSAGES,
  mount,
  nav,
  QUERY,
  REASONS,
  REWOUND_SESSION,
  S,
  secondUndo,
  selectInNav,
  session,
  snapshotOf,
  TRIMMED,
  textarea,
  transcript,
  typeDraft,
  UNDO,
  UNDO_LABEL,
  undoBodies,
  undoButton,
  undone,
  user,
  userArticles,
} from "./chat-undo-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse, paths } from "./support.js";
import { FakeXhr, installFakeXhr } from "./upload-support.js";

afterEach(cleanupUndoPage);

describe("撤回按钮", () => {
  it("用户消息操作行的按钮与次序：done 会话里 撤回 在 从此处分叉 之前，二者可用；助手消息没有", async () => {
    await mount(S);
    const users = userArticles();
    expect(users).toHaveLength(2);
    for (const article of users) {
      const row = article.querySelector<HTMLElement>('[data-slot="message-actions"]');
      expect(row).not.toBeNull();
      const all = within(row as HTMLElement).getAllByRole<HTMLButtonElement>("button");
      expect(all.map((b) => b.getAttribute("aria-label"))).toEqual([UNDO_LABEL, FORK_LABEL]);
      expect(all.map((b) => b.title)).toEqual([UNDO_LABEL, FORK_LABEL]);
      expect(all.map((b) => b.disabled)).toEqual([false, false]);
      expect(all.map((b) => b.getAttribute("aria-disabled"))).toEqual([null, null]);
      expect(all.map((b) => b.type)).toEqual(["button", "button"]);
      expect(description(undoButton(article))).toBeNull();
    }
    for (const article of screen.getAllByRole("article", { name: "助手" })) {
      expect(buttons(UNDO_LABEL, article)).toHaveLength(0);
    }
  });

  it("锁定与归档时：回合进行中每条用户消息的 撤回 与 从此处分叉 都禁用，点击不发请求", async () => {
    const running = snapshotOf(session(SESSION_ID, "running", "saved title", 1_740_000_000_023), [
      user(1, "第一个问题", "available"),
      assistant(2, "一"),
      user(3, "第二个问题", "available"),
      assistant(4, "", "running"),
    ]);
    const { fetchMock } = await mount(running, { [UNDO]: () => undone() });
    const undos = buttons(UNDO_LABEL);
    expect(undos).toHaveLength(2);
    expect(undos.map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons(FORK_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    for (const button of undos) {
      fireEvent.click(button);
    }
    await flush();
    expect(calls(fetchMock, UNDO)).toHaveLength(0);
  });

  it("锁定时不可撤回的消息同时带 disabled 与 aria-disabled", async () => {
    const running = snapshotOf(session(SESSION_ID, "running", "saved title", 1_740_000_000_023), [
      user(1, "/todo", "command"),
      assistant(2, "", "running"),
    ]);
    await mount(running);
    const [button] = buttons(UNDO_LABEL) as [HTMLButtonElement];
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(description(button)).toBe("命令消息无法撤回");
  });

  it("锁定与归档时：已归档的会话里用户消息没有 撤回 与 从此处分叉", async () => {
    const archived = snapshotOf({ ...S.session, archivedAt: 1_760_000_000_000 }, S.messages);
    await mount(archived);
    expect(await screen.findByText("该会话已归档，恢复后才能继续对话")).toBeTruthy();
    expect(userArticles()).toHaveLength(2);
    expect(buttons(UNDO_LABEL)).toHaveLength(0);
    expect(buttons(FORK_LABEL)).toHaveLength(0);
  });

  it("不可撤回的原因：五种取值各自 aria-disabled 并带原因描述，点击不发出任何请求", async () => {
    const messages = REASONS.flatMap(([undo], index) => [
      user(index * 2 + 1, `问题 ${undo}`, undo),
      assistant(index * 2 + 2, "答"),
    ]);
    const { fetchMock } = await mount(snapshotOf(S.session, messages), { [UNDO]: () => undone() });
    const undos = userArticles().map((article) => undoButton(article));
    expect(undos).toHaveLength(5);
    expect(undos.map((b) => b.getAttribute("aria-disabled"))).toEqual(Array(5).fill("true"));
    expect(undos.map(description)).toEqual(REASONS.map(([, reason]) => reason));
    // 不是原生禁用（读屏可达），名字与 tooltip 仍是 `撤回`；同一行的分叉不受影响。
    expect(undos.map((b) => b.disabled)).toEqual(Array(5).fill(false));
    expect(undos.map((b) => b.title)).toEqual(Array(5).fill(UNDO_LABEL));
    expect(buttons(FORK_LABEL).map((b) => b.getAttribute("aria-disabled"))).toEqual(
      Array(5).fill(null),
    );
    const before = paths(fetchMock).length;
    for (const button of undos) {
      fireEvent.click(button);
    }
    await flush();
    expect(calls(fetchMock, UNDO)).toHaveLength(0);
    expect(paths(fetchMock)).toHaveLength(before);
    expect(textarea().disabled).toBe(false);
    expectNoDialog();
    expect(alerts()).toEqual([]);
  });
});

describe("撤回动作", () => {
  it("撤回并回填：不确认，恰一次 POST，恰一次快照读取，线程回退，原文覆盖草稿并聚焦，列表条目更新", async () => {
    // 按时间分组：列表条目的 `updatedAt` 更新后从 `更早` 挪到 `今天`。
    window.localStorage.setItem("workbuddy-session-grouping", "time");
    const undo = deferredResponse();
    const { fetchMock, source } = await mount(S, { [UNDO]: () => undo.promise }, true);
    expect(within(nav()).queryByRole("group", { name: "今天" })).toBeNull();
    typeDraft("半句话");
    const button = secondUndo();
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();

    expectNoDialog();
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
    // 请求期间：输入框锁定，但不是生成中；操作行的按钮都禁用。
    expect(textarea().disabled).toBe(true);
    expect(textarea().value).toBe("半句话");
    expect(bar().queryByRole("button", { name: "停止" })).toBeNull();
    expect(bar().queryByText("生成中")).toBeNull();
    expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons(FORK_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    expect(transcript()).toEqual(FULL);

    const reads = calls(fetchMock, MESSAGES).length;
    const lists = listGets(fetchMock);
    undo.resolve(undone());
    await flush();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    // 新连接 open 之前计数：恰一次快照读取，旧连接已关闭。
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`);
    expectRewound();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(currentLocation()).toBe(A_URL);
    // 列表条目用响应的 `session` 更新（`updatedAt` 落到今天），不另发列表 GET。
    expect(listGets(fetchMock)).toBe(lists);
    const today = within(nav()).getByRole("group", { name: "今天" });
    expect(within(today).getByRole("button", { name: "saved title" })).toBeTruthy();
    expect(within(today).queryByRole("button", { name: "other session" })).toBeNull();
    expect(paths(fetchMock).filter((path) => path.endsWith("/prompt"))).toEqual([]);
    // 留下的那条用户消息仍可撤回。
    expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([false]);
  });

  it("同步在途闩：同一次提交前的两次点击只发一次请求", async () => {
    const undo = deferredResponse();
    const { fetchMock } = await mount(S, { [UNDO]: () => undo.promise });
    const button = secondUndo();
    act(() => {
      button.click();
      button.click();
    });
    await flush();
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
    expect(textarea().disabled).toBe(true);
  });

  it("401：交给登录，不显示错误与对话框，不重读", async () => {
    const { fetchMock, source } = await mount(S, {
      [UNDO]: () => jsonResponse(envelope("unauthorized", "登录已失效"), 401),
    });
    const reads = calls(fetchMock, MESSAGES).length;
    await clickUndo();
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(alerts()).toEqual([]);
    expectNoDialog();
    expect(screen.queryByText("登录已失效")).toBeNull();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(source.closeCount).toBe(1);
  });

  it("重读到的快照仍在运行（输入框没有解锁）：焦点标记不留到之后无关的解锁", async () => {
    const running = snapshotOf({ ...REWOUND_SESSION, status: "running" }, [
      user(1, "第一个问题", "available"),
      assistant(2, "", "running"),
    ]);
    const { router } = await mount(S, { [UNDO]: () => undone(() => jsonResponse(running)) });
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(["第一个问题", ""]));
    expect(textarea().value).toBe("第二个问题");
    expect(textarea().disabled).toBe(true);
    expect(document.activeElement).not.toBe(textarea());

    await act(async () => {
      await router.navigate(`/?session=${OTHER_SESSION_ID}${QUERY}`);
    });
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    expect(document.activeElement).not.toBe(textarea());
  });

  it("草稿为空时同样写入原文；撤回第一条后线程为空", async () => {
    const empty = snapshotOf({ ...REWOUND_SESSION, status: "idle" }, []);
    const { fetchMock } = await mount(S, {
      [UNDO]: () => undone(() => jsonResponse(empty), "第一个问题"),
    });
    await clickUndo(undoButton((userArticles() as [HTMLElement])[0]));
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":1,"files":"restore"}']);
    await waitFor(() => expect(transcript()).toEqual([]));
    expect(textarea().value).toBe("第一个问题");
    expect(document.activeElement).toBe(textarea());
    expectNoNotice();
  });

  it.each([
    [
      "400",
      () => jsonResponse(envelope("bad_request", "这条消息无法撤回"), 400),
      "这条消息无法撤回",
    ],
    ["404", () => jsonResponse(envelope("not_found", "会话不存在"), 404), "会话不存在"],
    [
      "409 session_busy",
      () => jsonResponse(envelope("session_busy", "会话正在生成"), 409),
      "会话正在生成",
    ],
    [
      "409 session_archived",
      () => jsonResponse(envelope("session_archived", "会话已归档"), 409),
      "会话已归档",
    ],
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502), "Agent 不可用"],
    [
      "503",
      () => jsonResponse(envelope("agent_capacity", "Agent 容量已满"), 503),
      "Agent 容量已满",
    ],
    ["network", () => new TypeError("offline"), "请求失败，请稍后重试"],
  ] as const)(
    "失败就地显示：%s 时文案在输入框上，线程与草稿不变，输入框可用",
    async (_, reply, text) => {
      const { fetchMock, source } = await mount(S, { [UNDO]: reply });
      typeDraft("半句话");
      const reads = calls(fetchMock, MESSAGES).length;
      const lists = listGets(fetchMock);
      await clickUndo();

      expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
      expect(alerts()).toEqual([text]);
      expect(transcript()).toEqual(FULL);
      expect(textarea().value).toBe("半句话");
      expect(textarea().disabled).toBe(false);
      expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([false, false]);
      expect(currentLocation()).toBe(A_URL);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(listGets(fetchMock)).toBe(lists);
      expect(source.closeCount).toBe(0);
      expect(FakeEventSource.instances).toHaveLength(1);
      expectNoDialog();
      expectNoNotice();
    },
  );

  it("200 之后的重读失败：草稿已写入，显示带刷新指引的错误", async () => {
    const { fetchMock } = await mount(S, {
      [UNDO]: () => undone(() => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502)),
    });
    typeDraft("半句话");
    const reads = calls(fetchMock, MESSAGES).length;
    await clickUndo();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(textarea().value).toBe("第二个问题");
    expect(alerts()).toEqual([`Agent 不可用。${GUIDANCE}`]);
    expect(textarea().disabled).toBe(true);
    expect(bar().queryByText("生成中")).toBeNull();
  });
});

describe("撤回带附件的消息恢复标签", () => {
  // `S` 的会话没有工作空间，种不出标签：这一组用绑定了项目 A 的同一个会话。
  const BOUND = { ...S.session, workspaceId: PROJECT_A.id };
  const PROMPT = `/api/sessions/${SESSION_ID}/prompt`;
  const A_PDF: ChatSessionUndo["attachments"] = [{ path: "uploads/a.pdf", size: 3 }];
  const rewound = () =>
    jsonResponse(
      snapshotOf({ ...BOUND, updatedAt: REWOUND_SESSION.updatedAt }, S.messages.slice(0, 2)),
    );

  /** u1/a2 之后的 u3 是 `content` 加 `attachments`；undo 回 `draft` 与 `back`。挂载后装上 `FakeXhr`。 */
  async function mountBound(
    content: string,
    attachments: ChatSessionUndo["attachments"],
    reply: () => Response | Promise<Response>,
    withB = false,
  ) {
    const u3 = { ...user(3, content, "available"), attachments };
    const mounted = await mount(
      snapshotOf(BOUND, [...S.messages.slice(0, 2), u3, assistant(4, "二")]),
      {
        "/api/workspaces": () => workspaceList(PROJECT_A),
        [PROMPT]: () => jsonResponse(promptAccepted, 202),
        [UNDO]: reply,
      },
      withB,
    );
    installFakeXhr();
    return mounted;
  }

  async function seedOld() {
    await choose(file("old.txt"));
    await land(0, "old.txt");
    expect(chips()).toEqual(["old.txt10 B"]);
    expect(statuses()).toEqual(["uploaded"]);
  }

  it("仍在的附件覆盖已有标签，不发上传请求；直接发送带的就是它", async () => {
    const two = [...A_PDF, { path: "uploads/b.png", size: 5 }];
    const { fetchMock } = await mountBound("看看这两个", two, () =>
      undone(rewound, "看看这两个", {}, A_PDF),
    );
    await seedOld();
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));

    expect(textarea().value).toBe("看看这两个");
    expect(chips()).toEqual(["a.pdf3 B"]);
    expect(statuses()).toEqual(["uploaded"]);
    // 唯一的上传请求是种 `old.txt` 的那一个。
    expect(FakeXhr.instances).toHaveLength(1);
    expect(alerts()).toEqual([]);

    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await flush();
    expect(calls(fetchMock, PROMPT).map(([, init]) => init?.body)).toEqual([
      '{"message":"看看这两个","attachments":["uploads/a.pdf"]}',
    ]);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("响应的 attachments 为空：附件区不渲染（已有标签被清掉），草稿照常回填", async () => {
    await mountBound("第二个问题", A_PDF, () => undone(rewound));
    await seedOld();
    await clickUndo();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));

    expect(area()).toBeNull();
    expect(textarea().value).toBe("第二个问题");
    expect(FakeXhr.instances).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it("撤回只有附件的消息：空 draft 覆盖已有草稿，标签恢复，发送可用", async () => {
    await mountBound("", A_PDF, () => undone(rewound, "", {}, A_PDF));
    typeDraft("半句话");
    expect(userArticles()).toHaveLength(2);
    expect(send().disabled).toBe(false);
    await clickUndo();
    await waitFor(() => expect(userArticles()).toHaveLength(1));

    expect(transcript()).toEqual(TRIMMED);
    expect(textarea().value).toBe("");
    expect(chips()).toEqual(["a.pdf3 B"]);
    expect(statuses()).toEqual(["uploaded"]);
    await waitFor(() => expect(send().disabled).toBe(false));
    expect(FakeXhr.instances).toHaveLength(0);
    expect(alerts()).toEqual([]);
  });

  it.each([
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502), false],
    ["409 undo_conflict", CONFLICT, true],
  ] as const)("失败不动标签：%s 之后已有的标签还在", async (_, reply, dialog) => {
    await mountBound("看看这两个", A_PDF, reply);
    await seedOld();
    await clickUndo();

    expect(conflictDialog() !== null).toBe(dialog);
    if (dialog) {
      // 对话框开着时页面其余部分是 `aria-hidden`，标签按角色查不到：先取消。
      fireEvent.click(
        within(conflictDialog() as HTMLElement).getByRole("button", { name: "取消" }),
      );
      await waitFor(() => expectNoDialog());
    }
    expect(chips()).toEqual(["old.txt10 B"]);
    expect(statuses()).toEqual(["uploaded"]);
    expect(transcript()).toEqual(["第一个问题", "一", "看看这两个", "二"]);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("请求在途时切换会话：迟到的 200 不动标签，回到原会话也没有", async () => {
    const undo = deferredResponse();
    await mountBound("看看这两个", A_PDF, () => undo.promise, true);
    await clickUndo();
    await selectInNav("other session", OTHER_SESSION_ID);

    undo.resolve(undone(rewound, "看看这两个", {}, A_PDF));
    await flush();
    expect(area()).toBeNull();
    expect(textarea().value).toBe("");

    // 标签按会话存：写进了 A 的记录要回到 A 才看得见。
    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(area()).toBeNull();
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe("撤回冲突对话框", () => {
  async function mountConflict(second: () => Response | Promise<Response> = () => undone()) {
    let posts = 0;
    const mounted = await mount(S, {
      [UNDO]: () => {
        posts += 1;
        return posts === 1 ? CONFLICT() : second();
      },
    });
    typeDraft("半句话");
    const trigger = secondUndo();
    await clickUndo(trigger);
    return { ...mounted, trigger };
  }

  function dialogButtons(dialog: HTMLElement) {
    return within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent);
  }

  it("冲突三选一：409 undo_conflict 打开对话框，标题、说明与三个按钮；输入框已解锁、没有报错", async () => {
    const { fetchMock } = await mountConflict();
    const dialog = conflictDialog();
    expect(dialog).not.toBeNull();
    expect(description(dialog as HTMLElement)).toBe(CONFLICT_TEXT);
    expect(dialogButtons(dialog as HTMLElement).sort()).toEqual(
      ["只撤回对话", "连文件一起还原", "取消"].sort(),
    );
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
    expect(textarea().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    expect(transcript()).toEqual(FULL);
    expect(textarea().value).toBe("半句话");
  });

  it.each([
    [
      "取消",
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getByRole("button", { name: "取消" })),
    ],
    [
      "Escape",
      (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" }),
    ],
  ] as const)(
    "冲突三选一：%s 关闭对话框，没有第二个请求，线程与草稿不变，焦点回到该 撤回",
    async (_, close) => {
      const { fetchMock, trigger } = await mountConflict();
      const reads = calls(fetchMock, MESSAGES).length;
      close(conflictDialog() as HTMLElement);
      await flush();
      await waitFor(() => expectNoDialog());
      expect(undoBodies(fetchMock)).toHaveLength(1);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(transcript()).toEqual(FULL);
      expect(textarea().value).toBe("半句话");
      expect(textarea().disabled).toBe(false);
      expect(trigger.isConnected).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(alerts()).toEqual([]);
    },
  );

  it("遮罩点击不关闭对话框", async () => {
    const { fetchMock } = await mountConflict();
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay as HTMLElement);
    fireEvent.click(overlay as HTMLElement);
    await flush();
    expect(conflictDialog()).not.toBeNull();
    expect(undoBodies(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["只撤回对话", "keep"],
    ["连文件一起还原", "force"],
  ] as const)(
    "冲突三选一：%s 关闭对话框并以 %s 恰再发一次，200 之后与撤回并回填相同",
    async (label, files) => {
      const second = deferredResponse();
      const { fetchMock } = await mountConflict(() => second.promise);
      const reads = calls(fetchMock, MESSAGES).length;
      fireEvent.click(within(conflictDialog() as HTMLElement).getByRole("button", { name: label }));
      await flush();
      await waitFor(() => expectNoDialog());
      expect(undoBodies(fetchMock)).toEqual([
        '{"messageId":3,"files":"restore"}',
        `{"messageId":3,"files":"${files}"}`,
      ]);
      expect(textarea().disabled).toBe(true);
      expect(textarea().value).toBe("半句话");

      second.resolve(undone());
      await flush();
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
      await flush();
      expectRewound();
      expect(undoBodies(fetchMock)).toHaveLength(2);
    },
  );

  it("重发的失败（含再次 undo_conflict）进输入框上的错误，不再开对话框，焦点交给输入框", async () => {
    const second = deferredResponse();
    const { fetchMock } = await mountConflict(() => second.promise);
    fireEvent.click(
      within(conflictDialog() as HTMLElement).getByRole("button", { name: "连文件一起还原" }),
    );
    await flush();
    await waitFor(() => expectNoDialog());
    expect(document.activeElement).toBe(document.body);

    second.resolve(CONFLICT());
    await flush();
    expectNoDialog();
    expect(undoBodies(fetchMock)).toHaveLength(2);
    expect(alerts()).toEqual(["别的会话动过"]);
    expect(transcript()).toEqual(FULL);
    expect(textarea().value).toBe("半句话");
    expect(textarea().disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
  });

  it.each([
    ["只撤回对话 两次", "只撤回对话", "只撤回对话"],
    ["只撤回对话 再 连文件一起还原", "只撤回对话", "连文件一起还原"],
  ] as const)("对话框里同一次提交前的两次点击（%s）恰再发一次", async (_, first, then) => {
    const second = deferredResponse();
    const { fetchMock } = await mountConflict(() => second.promise);
    const dialog = within(conflictDialog() as HTMLElement);
    const one = dialog.getByRole("button", { name: first });
    const two = dialog.getByRole("button", { name: then });
    act(() => {
      one.click();
      two.click();
    });
    await flush();
    expect(undoBodies(fetchMock)).toEqual([
      '{"messageId":3,"files":"restore"}',
      '{"messageId":3,"files":"keep"}',
    ]);
  });

  it("换会话后冲突作废：回到原会话不再弹出对话框，没有新的 undo 请求，输入框可用", async () => {
    const { fetchMock, router } = await mountConflict();
    await act(async () => {
      await router.navigate(`/?session=${OTHER_SESSION_ID}${QUERY}`);
    });
    await flush();
    expectNoDialog();
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    await act(async () => {
      await router.navigate(A_URL);
    });
    await flush();
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(FULL);
    expectNoDialog();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(textarea().disabled).toBe(false);
    typeDraft("还能打字");
    expect(textarea().value).toBe("还能打字");
    expect(alerts()).toEqual([]);
  });
});

describe("撤回的所有权 fence", () => {
  it.each([
    ["200", () => undone()],
    ["409 undo_conflict", CONFLICT],
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502)],
  ] as const)("请求在途时切换会话，草稿不变：迟到的 %s 被丢弃", async (_, reply) => {
    const undo = deferredResponse();
    const { fetchMock } = await mount(S, { [UNDO]: () => undo.promise }, true);
    typeDraft("半句话");
    await clickUndo();
    expect(undoBodies(fetchMock)).toHaveLength(1);

    await selectInNav("other session", OTHER_SESSION_ID);
    const sourceB = latestSource();
    expect(textarea().disabled).toBe(false);
    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    const lists = listGets(fetchMock);

    undo.resolve(reply());
    await flush();
    expect(textarea().value).toBe("半句话");
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(textarea().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    expectNoDialog();
    expect(currentLocation()).toBe(`/?session=${OTHER_SESSION_ID}${QUERY}`);
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(sourceB.closeCount).toBe(0);
    expect(listGets(fetchMock)).toBe(lists);
  });

  it("离开又回到同一会话后到达的 200 照常应用（不带历史令牌）", async () => {
    const undo = deferredResponse();
    await mount(S, { [UNDO]: () => undo.promise }, true);
    await clickUndo();
    await selectInNav("other session", OTHER_SESSION_ID);
    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(FULL);
    expect(textarea().disabled).toBe(true);

    undo.resolve(undone());
    await flush();
    await waitFor(() => expect(textarea().value).toBe("第二个问题"));
    expect(textarea().disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
    expect(alerts()).toEqual([]);
  });

  it("换账号后旧账号的 200 被丢弃", async () => {
    const stale = deferredResponse();
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      [LIST]: () => jsonResponse({ sessions: [S.session] }),
      [MESSAGES]: () => jsonResponse(S),
      [UNDO]: () => stale.promise,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(textarea().disabled).toBe(false));
    await clickUndo();
    expect(calls(fetchMock, UNDO)).toHaveLength(1);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    typeDraft("新草稿");
    const reads = calls(fetchMock, MESSAGES).length;

    stale.resolve(undone());
    await flush();
    expect(textarea().value).toBe("新草稿");
    expect(textarea().disabled).toBe(false);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(transcript()).toEqual(FULL);
    expect(alerts()).toEqual([]);
  });

  it("页面卸载后到达的 200 被丢弃，不报错", async () => {
    const observer = observeUnhandledRejections();
    try {
      const undo = deferredResponse();
      const { fetchMock, router } = await mount(S, { [UNDO]: () => undo.promise });
      await clickUndo();
      await act(async () => {
        await router.navigate("/center");
      });
      expect(await screen.findByText("中心暂不可用")).toBeTruthy();
      const reads = calls(fetchMock, MESSAGES).length;
      const consoleError = vi.spyOn(console, "error");

      undo.resolve(undone());
      await flush();
      expect(currentLocation().startsWith("/center")).toBe(true);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(consoleError).not.toHaveBeenCalled();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});
