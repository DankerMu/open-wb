// 另存为工作空间整页测试（任务 17.2）：session-sidebar「另存为工作空间对话框」三个场景与菜单项的
// 出现条件。完整的「菜单项」场景由任务 17.3 的 `chat-export.test.tsx` 断言，这里断言本刀的那一项及其位置。
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  cleanupSessionMeta,
  entryTitles,
  envelope,
  expectNoListToast,
  findList,
  findListAlert,
  focusOn,
  listAlert,
  mountSessions,
  openEntryMenu,
  PIN,
  partition,
  partitionTitles,
  patchPath,
  REQUEST_FAILED,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { calls, deferredResponse, type FetchMock, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const PROMOTE = "另存为工作空间";
const EXPORT = "导出记录";
const DESCRIPTION =
  "临时空间会原地变成正式工作空间，文件不移动；之后它出现在文件页，删除会话不再删除这些文件。";
const TEMPORARY_GROUP = "临时空间";
const CONFLICT = "同名资源已存在";
const NAME = "调研资料";
const DRAFT = "临时草稿";
const SIBLING = "同空间的另一个";
const BOUND = "正式空间的会话";
const LEGACY = "存量会话";
/** 临时空间的 id：转正之前不在 `GET /api/workspaces` 的返回里。 */
const TEMP = "7".repeat(32);
const PROJECT = "1".repeat(32);
const PROMOTE_PATH = `/api/workspaces/${TEMP}/promote`;
const SESSION_A = `/?session=${A}`;

afterEach(cleanupSessionMeta);

function workspace(id: string, name: string) {
  return { id, name, dir: name, root: `/srv/${id}`, createdAt: 1_740_000_000_000 };
}

function temporary(id: string, title: string, status: SessionView["status"] = "done") {
  return view(id, title, { status, temporaryWorkspace: true, workspaceId: TEMP });
}

/**
 * 两个共用临时空间的会话与一个绑定正式空间的会话。`promote` 得到 200 之后，其后的列表读取里那两个
 * 会话 `temporaryWorkspace` 为 false、工作空间列表多出以请求里的名字命名的那个空间（服务端原地转正）。
 */
function mountTemporary(
  promote: (name: string) => Response | Promise<Response>,
  path = "/",
  status: SessionView["status"] = "done",
) {
  let promoted: string | null = null;
  let held: Promise<Response> | null = null;
  const sessions = () =>
    [temporary(A, DRAFT, status), temporary(B, SIBLING), view(C, BOUND, { workspaceId: PROJECT })]
      // 转正后服务端把它们报成绑定正式空间的会话。
      .map((session) =>
        promoted !== null && session.workspaceId === TEMP
          ? { ...session, temporaryWorkspace: false }
          : session,
      );
  const mounted = mountSessions(path, sessions(), {
    "/api/sessions": () => held ?? jsonResponse({ sessions: sessions() }),
    "/api/workspaces": () =>
      jsonResponse({
        workspaces: [
          workspace(PROJECT, "项目A"),
          ...(promoted === null ? [] : [workspace(TEMP, promoted)]),
        ],
      }),
    [PROMOTE_PATH]: async (_path, options) => {
      const { name } = JSON.parse(String(options?.body)) as { name: string };
      const response = await promote(name);
      if (response.status === 200) promoted = name;
      return response;
    },
  });
  /** 此后的会话列表读取停在途中（不返回）：条目不会移动。 */
  const holdList = () => {
    held = new Promise<Response>(() => {});
  };
  return { ...mounted, holdList };
}

function promoted(name: string) {
  return jsonResponse(workspace(TEMP, name));
}

function conflict() {
  return jsonResponse({ error: { code: "conflict", message: CONFLICT } }, 409);
}

function promoteDialog() {
  return screen.queryByRole("dialog", { name: PROMOTE });
}

async function dialogGone() {
  await waitFor(() => expect(promoteDialog()).toBeNull());
}

/** 条目菜单 → `另存为工作空间`，等对话框出现；`trigger` 是打开它的「更多」按钮。 */
async function openPromote(scope: HTMLElement, title: string) {
  const trigger = await chooseEntryAction(scope, title, PROMOTE);
  const dialog = await screen.findByRole("dialog", { name: PROMOTE });
  const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "工作空间名称" });
  const form = input.closest("form");
  if (!form) throw new Error("工作空间名称 输入框不在表单内");
  return {
    cancel: within(dialog).getByRole("button", { name: "取消" }),
    dialog,
    form,
    input,
    save: within(dialog).getByRole<HTMLButtonElement>("button", { name: "保存" }),
    trigger,
  };
}

type PromoteControls = Awaited<ReturnType<typeof openPromote>>;

function typeName({ input }: PromoteControls, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

function saveName(controls: PromoteControls, text: string) {
  typeName(controls, text);
  fireEvent.click(controls.save);
}

function dialogAlert(dialog: HTMLElement) {
  return within(dialog).queryByRole("alert")?.textContent ?? null;
}

/** 发往 promote 端点的请求，按调用顺序。 */
function promoteRequests(fetchMock: FetchMock) {
  return calls(fetchMock, PROMOTE_PATH).map(([, options]) => ({
    body: options?.body,
    contentType: new Headers(options?.headers).get("Content-Type"),
    method: options?.method,
  }));
}

function promoteOf(name: string) {
  return { body: JSON.stringify({ name }), contentType: "application/json", method: "POST" };
}

async function menuTexts(nav: HTMLElement, title: string) {
  const { items, menu } = await openEntryMenu(nav, title);
  const texts = items.map((item) => item.textContent);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return texts;
}

function capabilityLabel() {
  return document.querySelector('form [data-slot="composer-workspace"]')?.textContent;
}

describe("另存为工作空间对话框（session-sidebar）", () => {
  it("转正后移入新分组：恰一次 POST（trim 后的名字），对话框关闭、焦点归还，两份列表重读，条目移入以新名字为名的分组，没有轻提示", async () => {
    const { fetchMock } = mountTemporary(promoted, SESSION_A);
    const nav = await findList(DRAFT);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([DRAFT, SIBLING]);
    await waitFor(() => expect(capabilityLabel()).toBe("任务启动于 临时空间"));
    const listReads = calls(fetchMock, "/api/sessions").length;
    const workspaceReads = calls(fetchMock, "/api/workspaces").length;

    const controls = await openPromote(nav, DRAFT);
    saveName(controls, `  ${NAME}  `);

    await dialogGone();
    await waitFor(() => expect(partitionTitles(nav, NAME)).toEqual([DRAFT, SIBLING]));
    expect(promoteRequests(fetchMock)).toEqual([promoteOf(NAME)]);
    expect(partition(nav, TEMPORARY_GROUP)).toBeNull();
    expect(entryTitles(nav)).toEqual([BOUND, DRAFT, SIBLING]);
    expect(calls(fetchMock, "/api/sessions").length).toBeGreaterThan(listReads);
    expect(calls(fetchMock, "/api/workspaces").length).toBeGreaterThan(workspaceReads);
    await waitFor(() => expect(capabilityLabel()).toBe(`任务启动于 ${NAME}`));
    for (const title of [DRAFT, SIBLING]) {
      expect(await menuTexts(nav, title)).toEqual(["重命名", PIN, "归档", "删除", EXPORT]);
    }
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
    expect(document.body.textContent).not.toContain("已另存");
  });

  it("200 关闭对话框时焦点还给打开它的「更多」按钮", async () => {
    const promote = deferredResponse();
    const { holdList } = mountTemporary(() => promote.promise);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);
    saveName(controls, NAME);
    // 让其后的列表重读停在途中：条目还没移动，焦点落点可以确定地断言。
    holdList();

    await settleDeferredResponse(promote, promoted(NAME));

    await dialogGone();
    await focusOn(controls.trigger);
    expectNoListToast();
  });

  it("同名冲突留在对话框：框内 role=alert 为信封文案，列表不变；改名再次保存时该提示清除", async () => {
    const second = deferredResponse();
    const answers = [conflict(), second.promise];
    const { fetchMock } = mountTemporary(() => answers.shift() ?? conflict());
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);

    saveName(controls, NAME);

    await waitFor(() => expect(dialogAlert(controls.dialog)).toBe(CONFLICT));
    expect(promoteDialog()).toBe(controls.dialog);
    expect(controls.input.value).toBe(NAME);
    expect(controls.save.disabled).toBe(false);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([DRAFT, SIBLING]);
    expect(partition(nav, NAME)).toBeNull();
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();

    saveName(controls, "调研资料二");
    expect(dialogAlert(controls.dialog)).toBeNull();
    expect(controls.save.disabled).toBe(true);
    expect(controls.save.getAttribute("aria-busy")).toBe("true");

    await settleDeferredResponse(second, promoted("调研资料二"));
    await dialogGone();
    await waitFor(() => expect(partitionTitles(nav, "调研资料二")).toEqual([DRAFT, SIBLING]));
    expect(promoteRequests(fetchMock)).toEqual([promoteOf(NAME), promoteOf("调研资料二")]);
  });

  it("只在临时空间的会话上出现：绑定正式空间的会话与 workspaceId 为 null 的存量会话都没有；临时空间会话在 删除 之后多这一项", async () => {
    mountSessions(
      "/",
      [view(A, BOUND, { workspaceId: PROJECT }), view(B, LEGACY), temporary(C, DRAFT, "running")],
      { "/api/workspaces": () => jsonResponse({ workspaces: [workspace(PROJECT, "项目A")] }) },
    );
    const nav = await findList(DRAFT);

    expect(await menuTexts(nav, BOUND)).toEqual(["重命名", PIN, "归档", "删除", EXPORT]);
    expect(await menuTexts(nav, LEGACY)).toEqual(["重命名", PIN, "归档", "删除", EXPORT]);

    const { items, menu } = await openEntryMenu(nav, DRAFT);
    expect(items.map((item) => item.textContent)).toEqual([
      "重命名",
      PIN,
      "归档",
      "删除",
      PROMOTE,
      EXPORT,
    ]);
    // 会话运行中也可使用；危险样式仍只有 `删除`。
    const item = within(menu).getByRole("menuitem", { name: PROMOTE });
    expect(item.hasAttribute("aria-disabled")).toBe(false);
    expect(item.hasAttribute("data-disabled")).toBe(false);
    expect(menu.querySelectorAll('[data-variant="destructive"]')).toHaveLength(1);
  });

  it("归档视图的菜单里没有：已归档的临时空间会话恰为 恢复、删除", async () => {
    mountSessions("/", [
      view(A, DRAFT, {
        archivedAt: 1_760_000_000_000,
        temporaryWorkspace: true,
        workspaceId: TEMP,
      }),
      view(B, BOUND),
    ]);
    const nav = await findList(BOUND);
    fireEvent.click(within(nav).getByRole("button", { name: "已归档" }));

    expect(await menuTexts(nav, DRAFT)).toEqual(["恢复", "删除"]);
  });
});

describe("另存为工作空间：对话框的形状与校验", () => {
  it("标题、说明、空的已聚焦输入框、取消 / 保存；运行中的会话也能打开", async () => {
    mountTemporary(promoted, "/", "running");
    const nav = await findList(DRAFT);

    const { cancel, dialog, input, save } = await openPromote(nav, DRAFT);

    expect(within(dialog).getByRole("heading", { name: PROMOTE })).toBeTruthy();
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(DESCRIPTION);
    expect(dialog.contains(description)).toBe(true);
    expect(input.value).toBe("");
    await focusOn(input);
    expect(cancel.textContent).toBe("取消");
    expect(save.textContent).toBe("保存");
    expect(save.disabled).toBe(true);
    expect(dialogAlert(dialog)).toBeNull();
  });

  it.each([
    ["空", "", false],
    ["只有空白", " \t　 ", false],
    ["一个字符", "a", true],
    ["64 个字符", "a".repeat(64), true],
    ["65 个字符", "a".repeat(65), false],
    ["首尾空白不计：64 个字符外加空白", `  ${"a".repeat(64)}  `, true],
    ["64 个码点（辅助平面字符，128 个 UTF-16 单元）", "𠀀".repeat(64), true],
    ["65 个码点（辅助平面字符）", "𠀀".repeat(65), false],
    ["64 个码点，混合 BMP 与辅助平面", `${"😀".repeat(32)}${"文".repeat(32)}`, true],
  ])("名字校验：%s", async (_label, text, valid) => {
    const { fetchMock } = mountTemporary(promoted);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);

    typeName(controls, text);
    expect(controls.save.disabled).toBe(!valid);
    // 输入框内 Enter 走表单提交：不合法的名字不发请求，合法的恰发一次且是 trim 后的名字。
    fireEvent.submit(controls.form);
    await yieldMacrotask();

    expect(promoteRequests(fetchMock)).toEqual(valid ? [promoteOf(text.trim())] : []);
    if (!valid) expect(promoteDialog()).toBe(controls.dialog);
  });

  it("请求中 保存 忙碌禁用，重复提交不再发送", async () => {
    const promote = deferredResponse();
    const { fetchMock } = mountTemporary(() => promote.promise);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);

    saveName(controls, NAME);
    expect(controls.save.disabled).toBe(true);
    expect(controls.save.getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(controls.form);
    fireEvent.click(controls.save);
    fireEvent.submit(controls.form);
    await yieldMacrotask();

    expect(promoteRequests(fetchMock)).toEqual([promoteOf(NAME)]);
    await settleDeferredResponse(promote, promoted(NAME));
    await dialogGone();
    expect(promoteRequests(fetchMock)).toEqual([promoteOf(NAME)]);
  });

  it.each([
    ["Escape", ({ input }: PromoteControls) => fireEvent.keyDown(input, { key: "Escape" })],
    ["取消", ({ cancel }: PromoteControls) => fireEvent.click(cancel)],
  ])("%s 关闭对话框：不发请求，焦点回到「更多」按钮，再次打开是全新状态", async (_name, close) => {
    const { fetchMock } = mountTemporary(promoted);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);
    typeName(controls, NAME);

    close(controls);

    await dialogGone();
    await focusOn(controls.trigger);
    expect(promoteRequests(fetchMock)).toEqual([]);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([DRAFT, SIBLING]);
    expectNoListToast();

    const reopened = await openPromote(nav, DRAFT);
    expect(reopened.input.value).toBe("");
    expect(reopened.save.disabled).toBe(true);
  });
});

describe("另存为工作空间：失败与迟到的结果", () => {
  it("非信封失败留在对话框内：请求失败，请稍后重试", async () => {
    mountTemporary(() => Promise.reject(new TypeError("offline")));
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);

    saveName(controls, NAME);

    await waitFor(() => expect(dialogAlert(controls.dialog)).toBe(REQUEST_FAILED));
    expect(controls.save.disabled).toBe(false);
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
  });

  it("请求中关闭对话框后才到的失败走列表区顶部提示，对话框不重开", async () => {
    const promote = deferredResponse();
    const { fetchMock } = mountTemporary(() => promote.promise);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);
    saveName(controls, NAME);
    fireEvent.click(controls.cancel);
    await dialogGone();
    await focusOn(controls.trigger);

    await settleDeferredResponse(promote, conflict());

    await findListAlert(nav, CONFLICT);
    expect(promoteDialog()).toBeNull();
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([DRAFT, SIBLING]);
    expect(promoteRequests(fetchMock)).toEqual([promoteOf(NAME)]);
    expectNoListToast();
  });

  it("请求中关闭对话框后才到的 200 照常重读：条目移入新分组", async () => {
    const promote = deferredResponse();
    mountTemporary(() => promote.promise);
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);
    saveName(controls, NAME);
    fireEvent.keyDown(controls.input, { key: "Escape" });
    await dialogGone();

    await settleDeferredResponse(promote, promoted(NAME));

    await waitFor(() => expect(partitionTitles(nav, NAME)).toEqual([DRAFT, SIBLING]));
    expect(partition(nav, TEMPORARY_GROUP)).toBeNull();
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
  });

  it("上一次打开的迟到失败不进新打开的对话框，走列表区顶部提示；新对话框提交时该提示清除", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const answers = [first.promise, second.promise];
    mountTemporary(() => answers.shift() ?? conflict());
    const nav = await findList(DRAFT);
    const opened = await openPromote(nav, DRAFT);
    saveName(opened, NAME);
    fireEvent.click(opened.cancel);
    await dialogGone();
    const reopened = await openPromote(nav, DRAFT);

    await settleDeferredResponse(first, conflict());

    await findListAlert(nav, CONFLICT);
    expect(dialogAlert(reopened.dialog)).toBeNull();
    expect(reopened.save.disabled).toBe(true);
    expect(reopened.input.value).toBe("");

    saveName(reopened, "另一个名字");
    await waitFor(() => expect(listAlert(nav)).toBeNull());
    expect(reopened.save.getAttribute("aria-busy")).toBe("true");
  });

  it("打开对话框时清除列表区顶部的提示", async () => {
    mountSessions("/", [temporary(A, DRAFT)], {
      [patchPath(A)]: () => envelope(409, "会话正在生成，请稍候"),
    });
    const nav = await findList(DRAFT);
    await chooseEntryAction(nav, DRAFT, PIN);
    await findListAlert(nav, "会话正在生成，请稍候");

    await openPromote(nav, DRAFT);

    expect(listAlert(nav)).toBeNull();
  });

  it("401 交给既有的登录失效处理：进入登录页，不显示该失败", async () => {
    mountTemporary(() =>
      jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    );
    const nav = await findList(DRAFT);
    const controls = await openPromote(nav, DRAFT);

    saveName(controls, NAME);

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await yieldMacrotask();
    expect(screen.queryByRole("button", { name: "关闭提示" })).toBeNull();
    expect(screen.queryByText("登录已失效")).toBeNull();
    expectNoListToast();
  });
});
