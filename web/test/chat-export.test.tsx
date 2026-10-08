// 导出记录整页测试（任务 17.3）：session-sidebar「导出记录」的「导出内容」「非当前会话与失败」，数据
// 来源（当前会话用页面视图、其它会话现读一次快照），以及完整的「菜单项」场景（本刀是菜单的最后一刀）。
// 下载以对 `URL.createObjectURL` / `revokeObjectURL` 与锚点点击的桩断言；期望文本一律是字面量。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spyDownloads } from "./chat-page-artifact-card-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  cleanupSessionMeta,
  envelope,
  expectNoListToast,
  findList,
  findListAlert,
  leaveChatPage,
  listAlert,
  messagesPath,
  mountSessions,
  openEntryMenu,
  PIN,
  patchPath,
  REQUEST_FAILED,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { latestSource, settle } from "./chat-stream-support.js";
import { cleanupFilesFixture, stubBlobUrls } from "./files-fixture.js";
import { calls, deferredResponse, type FetchMock, jsonResponse, paths } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const EXPORT = "导出记录";
const PROMOTE = "另存为工作空间";
const ARCHIVE = "归档";
const BLOB_URL = "blob:export-first";
const SECOND_BLOB_URL = "blob:export-second";
const MARKDOWN = "text/markdown;charset=utf-8";
const BAD_GATEWAY = "上游服务暂不可用";
const QUARTERLY = "季度/汇报";
const OTHER = "别的任务";
/** 规格「导出内容」的逐字节期望。 */
const QUARTERLY_TEXT =
  "# 季度/汇报\n\n## 用户\n\n帮我写提纲\n\n## 助手\n\n好的。\n\n- write（已完成）\n- bash（失败）\n\n## 用户\n\n谢谢\n";

type StepStatus = "running" | "done" | "failed" | "stopped";

let blobs: ReturnType<typeof stubBlobUrls>;
let clicks: ReturnType<typeof spyDownloads>;

beforeEach(() => {
  blobs = stubBlobUrls([BLOB_URL, SECOND_BLOB_URL]);
  clicks = spyDownloads(blobs.revokeObjectURL);
});

afterEach(async () => {
  cleanupFilesFixture();
  await cleanupSessionMeta();
});

function user(id: number, content: string) {
  return {
    id,
    role: "user" as const,
    content,
    thinking: null,
    status: "done" as const,
    createdAt: 0,
    steps: [],
    approvals: [],
    undo: "none" as const,
  };
}

function step(id: number, name: string, status: StepStatus) {
  return {
    id,
    ordinal: id,
    name,
    detail: "步骤的详情",
    output: "步骤的输出",
    changes: null,
    status,
  };
}

function assistant(
  id: number,
  content: string,
  options: { status?: StepStatus; steps?: ReturnType<typeof step>[]; thinking?: string } = {},
) {
  return {
    id,
    role: "assistant" as const,
    content,
    thinking: options.thinking ?? null,
    status: options.status ?? "done",
    createdAt: 0,
    steps: options.steps ?? [],
    approvals: [],
    undo: null,
  };
}

function snapshot(session: SessionView, messages: unknown[]) {
  return { session, messages, streamCursor: { epoch: 1, seq: 0 }, todo: null };
}

/** 规格「导出内容」的会话：助手消息带 thinking，两个步骤的 detail 与 output 非空。 */
function quarterly(session: SessionView) {
  return snapshot(session, [
    user(1, "帮我写提纲"),
    assistant(2, "好的。", {
      steps: [step(0, "write", "done"), step(1, "bash", "failed")],
      thinking: "先想想",
    }),
    user(3, "谢谢"),
  ]);
}

function exportEntry(nav: HTMLElement, title: string) {
  return chooseEntryAction(nav, title, EXPORT);
}

/** 第 `index` 次下载：交给 `createObjectURL` 的 Blob（类型与 UTF-8 文本）与锚点点击时的属性。 */
async function download(index = 0) {
  await waitFor(() => expect(clicks.length).toBeGreaterThan(index));
  const blob = (blobs.createObjectURL.mock.calls as unknown as [Blob][])[index]?.[0];
  if (!(blob instanceof Blob)) throw new Error("createObjectURL 没有收到 Blob");
  return {
    filename: clicks[index]?.download,
    href: clicks[index]?.href,
    text: new TextDecoder().decode(await blob.arrayBuffer()),
    type: blob.type,
  };
}

/** 让出两轮宏任务后仍没有下载：没有 Blob URL，也没有锚点点击。 */
async function expectNoDownload() {
  await act(settle);
  await yieldMacrotask();
  expect(blobs.createObjectURL).not.toHaveBeenCalled();
  expect(clicks).toEqual([]);
}

/** 自 `before`（此前的请求数）以来发出的请求路径。 */
function requestsSince(fetchMock: FetchMock, before: number) {
  return paths(fetchMock).slice(before);
}

describe("导出记录（session-sidebar）", () => {
  it("导出内容：未选中的会话恰读一次快照后下载，文件名去掉路径分隔，内容逐字节，没有思考与步骤的 detail / output；Blob URL 在点击之后释放，没有轻提示", async () => {
    const target = view(A, QUARTERLY);
    const { fetchMock } = mountSessions("/", [target, view(B, OTHER)], {
      [messagesPath(A)]: () => jsonResponse(quarterly(target)),
    });
    const nav = await findList(QUARTERLY);
    const before = fetchMock.mock.calls.length;

    await exportEntry(nav, QUARTERLY);

    const file = await download();
    expect(file).toEqual({
      filename: "季度汇报.md",
      href: BLOB_URL,
      text: QUARTERLY_TEXT,
      type: MARKDOWN,
    });
    expect(file.text).not.toContain("先想想");
    expect(file.text).not.toContain("步骤的详情");
    expect(file.text).not.toContain("步骤的输出");
    expect(clicks[0]?.revokedAtClick).toBe(0);
    await yieldMacrotask();
    expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
    expect(blobs.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveLength(1);
    // 恰一次 GET，没有别的请求；锚点用完即移除。
    expect(requestsSince(fetchMock, before)).toEqual([messagesPath(A)]);
    expect(calls(fetchMock, messagesPath(A)).map(([, options]) => options?.method)).toEqual([
      "GET",
    ]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
  });

  it("当前选中且历史已加载的会话用页面持有的视图：不发请求，导出的是页面上流式更新后的内容；运行中的会话也可导出", async () => {
    const RUNNING = "进行中的任务";
    const target = view(A, RUNNING, { status: "running" });
    const { fetchMock } = mountSessions(`/?session=${A}`, [target, view(B, OTHER)], {
      [messagesPath(A)]: () =>
        jsonResponse(snapshot(target, [user(1, "继续"), assistant(2, "", { status: "running" })])),
    });
    const nav = await findList(RUNNING);
    await waitFor(() => expect(calls(fetchMock, messagesPath(A))).toHaveLength(1));
    await screen.findByText("继续", { exact: true });
    const source = latestSource();
    expect(source.url).toBe(`/api/sessions/${A}/events`);
    // 快照之后才到的流式内容：只有页面视图里有，再读一次快照得不到它。
    act(() => {
      source.emitOpen();
      source.emitData("text.delta", "1:1", { messageId: 2, delta: "流式正文" });
      source.emitData("step.start", "1:2", {
        messageId: 2,
        stepId: 7,
        name: "bash",
        detail: "ls",
      });
    });
    await screen.findByText("流式正文", { exact: true });
    const before = fetchMock.mock.calls.length;

    await exportEntry(nav, RUNNING);

    expect(await download()).toEqual({
      filename: "进行中的任务.md",
      href: BLOB_URL,
      text: "# 进行中的任务\n\n## 用户\n\n继续\n\n## 助手\n\n流式正文\n\n- bash（运行中）\n",
      type: MARKDOWN,
    });
    await yieldMacrotask();
    expect(requestsSince(fetchMock, before)).toEqual([]);
    expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
    expectNoListToast();
  });

  it("当前选中但历史还没读回来的会话：现读一次快照后下载", async () => {
    const target = view(A, QUARTERLY);
    let reads = 0;
    const { fetchMock } = mountSessions(`/?session=${A}`, [target, view(B, OTHER)], {
      [messagesPath(A)]: () => {
        reads += 1;
        // 页面自己的历史读取停在途中；导出发出的那一次照常返回。
        return reads === 1 ? new Promise<Response>(() => {}) : jsonResponse(quarterly(target));
      },
    });
    const nav = await findList(QUARTERLY);
    await waitFor(() => expect(reads).toBe(1));
    const before = fetchMock.mock.calls.length;

    await exportEntry(nav, QUARTERLY);

    expect((await download()).text).toBe(QUARTERLY_TEXT);
    expect(requestsSince(fetchMock, before)).toEqual([messagesPath(A)]);
  });

  it("别的会话被选中且其历史已加载时导出未选中的会话：恰读一次它自己的快照，导出的不是页面上那个会话的内容", async () => {
    const target = view(A, QUARTERLY);
    const shown = view(B, OTHER);
    const { fetchMock } = mountSessions(`/?session=${B}`, [target, shown], {
      [messagesPath(A)]: () => jsonResponse(quarterly(target)),
      [messagesPath(B)]: () =>
        jsonResponse(snapshot(shown, [user(1, "页面上的会话"), assistant(2, "它的回答")])),
    });
    const nav = await findList(QUARTERLY);
    await screen.findByText("它的回答", { exact: true });
    const before = fetchMock.mock.calls.length;

    await exportEntry(nav, QUARTERLY);

    expect(await download()).toEqual({
      filename: "季度汇报.md",
      href: BLOB_URL,
      text: QUARTERLY_TEXT,
      type: MARKDOWN,
    });
    expect(requestsSince(fetchMock, before)).toEqual([messagesPath(A)]);
  });

  it("没有标题的会话以显示标题 新会话 作一级标题与文件名；零消息时只有标题行", async () => {
    const target = view(A, null);
    mountSessions("/", [target, view(B, OTHER)], {
      [messagesPath(A)]: () => jsonResponse(snapshot(target, [])),
    });
    const nav = await findList(OTHER);

    await exportEntry(nav, "新会话");

    expect(await download()).toEqual({
      filename: "新会话.md",
      href: BLOB_URL,
      text: "# 新会话\n",
      type: MARKDOWN,
    });
  });

  it("非当前会话与失败：快照读取 502 时不下载，列表区顶部显示信封文案，恰一次 GET、没有别的请求，没有轻提示", async () => {
    const { fetchMock } = mountSessions("/", [view(A, QUARTERLY), view(B, OTHER)], {
      [messagesPath(A)]: () => envelope(502, BAD_GATEWAY),
    });
    const nav = await findList(QUARTERLY);
    const before = fetchMock.mock.calls.length;

    await exportEntry(nav, QUARTERLY);

    await findListAlert(nav, BAD_GATEWAY);
    await expectNoDownload();
    expect(requestsSince(fetchMock, before)).toEqual([messagesPath(A)]);
    expect(blobs.revokeObjectURL).not.toHaveBeenCalled();
    expectNoListToast();
  });

  it("非信封的失败显示通用文案，同样不下载", async () => {
    mountSessions("/", [view(A, QUARTERLY), view(B, OTHER)], {
      [messagesPath(A)]: () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const nav = await findList(QUARTERLY);

    await exportEntry(nav, QUARTERLY);

    await findListAlert(nav, REQUEST_FAILED);
    await expectNoDownload();
  });

  it("顶部提示在下一次列表动作发起时清除：再次导出在响应到达之前就清掉上一次的失败，成功后下载", async () => {
    const target = view(A, QUARTERLY);
    const retry = deferredResponse();
    let reads = 0;
    mountSessions("/", [target, view(B, OTHER)], {
      [messagesPath(A)]: () => {
        reads += 1;
        return reads === 1 ? envelope(502, BAD_GATEWAY) : retry.promise;
      },
    });
    const nav = await findList(QUARTERLY);
    await exportEntry(nav, QUARTERLY);
    await findListAlert(nav, BAD_GATEWAY);

    await exportEntry(nav, QUARTERLY);

    expect(listAlert(nav)).toBeNull();
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    await settleDeferredResponse(retry, jsonResponse(quarterly(target)));
    expect((await download()).text).toBe(QUARTERLY_TEXT);
    expect(listAlert(nav)).toBeNull();
  });

  it("导出失败的提示被别的列表动作清除（置顶发起时）", async () => {
    const target = view(A, QUARTERLY);
    mountSessions("/", [target, view(B, OTHER)], {
      [messagesPath(A)]: () => envelope(502, BAD_GATEWAY),
      [patchPath(B)]: () => new Promise<Response>(() => {}),
    });
    const nav = await findList(QUARTERLY);
    await exportEntry(nav, QUARTERLY);
    await findListAlert(nav, BAD_GATEWAY);

    await chooseEntryAction(nav, OTHER, PIN);

    expect(listAlert(nav)).toBeNull();
  });

  it("401 交给既有的登录失效处理：进入登录页，不下载，不显示该失败", async () => {
    mountSessions("/", [view(A, QUARTERLY), view(B, OTHER)], {
      [messagesPath(A)]: () =>
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    });
    const nav = await findList(QUARTERLY);

    await exportEntry(nav, QUARTERLY);

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await expectNoDownload();
    expect(screen.queryByRole("button", { name: "关闭提示" })).toBeNull();
    expect(screen.queryByText("登录已失效")).toBeNull();
    expectNoListToast();
  });

  it("离开会话页之后才到的快照被丢弃：不下载", async () => {
    const target = view(A, QUARTERLY);
    const late = deferredResponse();
    const { router } = mountSessions("/", [target, view(B, OTHER)], {
      [messagesPath(A)]: () => late.promise,
    });
    const nav = await findList(QUARTERLY);
    await exportEntry(nav, QUARTERLY);

    await leaveChatPage(router);
    await settleDeferredResponse(late, jsonResponse(quarterly(target)));

    await expectNoDownload();
  });
});

describe("菜单项（session-sidebar「会话条目菜单与重命名」）", () => {
  const TEMP = "7".repeat(32);
  const PROJECT = "1".repeat(32);
  const BOUND = "正式空间的会话";
  const DRAFT = "临时草稿";

  function texts(items: HTMLElement[]) {
    return items.map((item) => item.textContent);
  }

  function disabledTexts(items: HTMLElement[]) {
    return texts(items.filter((item) => item.getAttribute("aria-disabled") === "true"));
  }

  async function closeMenu(menu: HTMLElement) {
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }

  it("绑定正式空间、未置顶、done 的会话恰五项；temporaryWorkspace、running 的会话恰六项且 归档 禁用，点击它不发请求；导出记录 是最后一项且任何状态可用", async () => {
    const { fetchMock } = mountSessions(
      "/",
      [
        view(A, BOUND, { workspaceId: PROJECT }),
        view(B, DRAFT, { status: "running", temporaryWorkspace: true, workspaceId: TEMP }),
      ],
      {
        "/api/workspaces": () =>
          jsonResponse({
            workspaces: [
              {
                id: PROJECT,
                name: "项目A",
                dir: "项目A",
                root: `/srv/${PROJECT}`,
                createdAt: 1_740_000_000_000,
              },
            ],
          }),
      },
    );
    const nav = await findList(DRAFT);

    const bound = await openEntryMenu(nav, BOUND);
    expect(texts(bound.items)).toEqual(["重命名", PIN, ARCHIVE, "删除", EXPORT]);
    expect(disabledTexts(bound.items)).toEqual([]);
    await closeMenu(bound.menu);

    const draft = await openEntryMenu(nav, DRAFT);
    expect(texts(draft.items)).toEqual(["重命名", PIN, ARCHIVE, "删除", PROMOTE, EXPORT]);
    expect(disabledTexts(draft.items)).toEqual([ARCHIVE]);
    expect(draft.items.at(-1)?.hasAttribute("data-disabled")).toBe(false);
    // 危险样式仍只有 `删除`。
    expect(
      Array.from(
        draft.menu.querySelectorAll('[data-variant="destructive"]'),
        (item) => item.textContent,
      ),
    ).toEqual(["删除"]);
    const before = fetchMock.mock.calls.length;
    fireEvent.click(within(draft.menu).getByRole("menuitem", { name: ARCHIVE }));
    await act(settle);
    expect(requestsSince(fetchMock, before)).toEqual([]);
  });

  it("归档视图的菜单恰两项 恢复、删除：没有 导出记录", async () => {
    mountSessions("/", [
      view(A, DRAFT, {
        archivedAt: 1_760_000_000_000,
        temporaryWorkspace: true,
        workspaceId: TEMP,
      }),
      view(B, BOUND),
      view(C, "归档的正式会话", { archivedAt: 1_760_000_000_001 }),
    ]);
    const nav = await findList(BOUND);
    fireEvent.click(within(nav).getByRole("button", { name: "已归档" }));

    for (const title of [DRAFT, "归档的正式会话"]) {
      const { items, menu } = await openEntryMenu(nav, title);
      expect(texts(items)).toEqual(["恢复", "删除"]);
      await closeMenu(menu);
    }
  });
});
