// 输入框附件（message-attachments「输入框附件标签」「没有工作空间的会话」、chat-web「输入框与能力栏」）：已选会话里
// 经隐藏的文件框选入、串行上传、标签与进度、发送闸、带附件发送与被拒后的恢复、切换会话清空。seam：整页挂载 +
// 假 API + `FakeXhr`。期望文案与请求体取自规格条文。拖入与粘贴走同一个入口；jsdom 没有 `DataTransfer` 也没有
// 缺省动作，事件带的是普通对象，「没有被拦」以 `fireEvent.*` 返回 true 断言。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { typeDraft } from "./chat-page-lifecycle-support.js";
import { composer, envelope, promptAccepted, SESSION_BUSY } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, type SessionView, view } from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue, commandsOf } from "./chat-page-slash-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { PROJECT_A, workspaceList } from "./chat-page-welcome-scene-support.js";
import { historyUser } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import { calls, composerOptionsRoute, type FetchMock, jsonResponse, paths } from "./support.js";
import { FakeXhr, installFakeXhr } from "./upload-support.js";

const W = PROJECT_A.id;
const S = view("a".repeat(32), "绑定会话", { workspaceId: W });
const OTHER = view("b".repeat(32), "另一个会话", { workspaceId: W });
const UNBOUND = view("c".repeat(32), "未绑定会话");
const PROMPT = `/api/sessions/${S.id}/prompt`;
const OPTIONS = { ...DEFAULT_COMPOSER_OPTIONS, upload: { maxBytes: 1000, maxFiles: 3 } };
const TOO_BIG = "文件超过大小上限";
const NO_WORKSPACE = "此会话没有工作空间，无法上传文件";

afterEach(() => {
  cleanupSessionMeta();
  vi.restoreAllMocks();
});

function file(name: string, size = 10) {
  return new File([new Uint8Array(size)], name);
}

function messagesPath(id: string) {
  return `/api/sessions/${id}/messages`;
}

function snapshotOf(session: SessionView, messages: unknown[] = []) {
  return { session, messages, streamCursor: { epoch: 1, seq: 0 }, todo: null };
}

/** 受理后重读到的快照：带附件的用户消息与一条已完成的回答。 */
function answered(attachments: string[]) {
  return snapshotOf(S, [
    { ...historyUser, attachments: attachments.map((path) => ({ path, size: 10 })) },
    {
      id: 0,
      role: "assistant",
      undo: null,
      attachments: [],
      approvals: [],
      content: "好的",
      status: "done",
      createdAt: 0,
      steps: [],
      thinking: null,
    },
  ]);
}

/** 打开会话 `session`（历史为空），装上 `FakeXhr`；`S` 的第二次历史读取带回 `after`。 */
async function open(session: SessionView = S, extra: FetchRoutes = {}, after: string[] = []) {
  let reads = 0;
  const page = renderChatPage(`/?session=${session.id}`, {
    "/api/workspaces": () => workspaceList(PROJECT_A),
    ...composerOptionsRoute(OPTIONS),
    "/api/sessions": () => jsonResponse({ sessions: [S, OTHER, UNBOUND] }),
    [messagesPath(S.id)]: () => {
      reads += 1;
      return jsonResponse(reads === 1 ? snapshotOf(S) : answered(after));
    },
    [messagesPath(OTHER.id)]: () => jsonResponse(snapshotOf(OTHER)),
    [messagesPath(UNBOUND.id)]: () => jsonResponse(snapshotOf(UNBOUND)),
    [commandsOf(W)]: catalogue(),
    [COMMANDS]: catalogue(),
    [PROMPT]: () => jsonResponse(promptAccepted, 202),
    ...extra,
  });
  await screen.findByRole("textbox", { name: "给助手发消息" });
  await quiesce();
  installFakeXhr();
  return page;
}

function fileInput() {
  const input = document.querySelector('[data-slot="composer-file-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("没有文件输入框");
  return input;
}

async function choose(...files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
  await quiesce();
}

function xhr(index: number) {
  const request = FakeXhr.instances[index];
  if (!request) throw new Error(`没有第 ${index + 1} 个上传请求`);
  return request;
}

/** 第 `index` 个上传请求应答 201，文件落在 `uploads/<name>`。 */
async function land(index: number, name: string, size = 10) {
  act(() => xhr(index).respond(201, JSON.stringify({ path: `uploads/${name}`, name, size })));
  await quiesce();
}

async function fail(index: number) {
  act(() =>
    xhr(index).respond(413, JSON.stringify({ error: { code: "too_large", message: TOO_BIG } })),
  );
  await quiesce();
}

/** 输入框的附件区；用户气泡里也有名为 `附件` 的列表，所以按 slot 取。 */
function area() {
  return document.querySelector<HTMLElement>('[data-slot="composer-attachments"]');
}

/** 每个标签的全部文字：名字、大小、状态。 */
function chips() {
  const list = area();
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    : [];
}

function statuses() {
  const list = area();
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-status"))
    : [];
}

function send() {
  return screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
}

function remove(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `移除 ${name}` }));
}

function bodies(fetchMock: FetchMock) {
  return calls(fetchMock, PROMPT).map(([, options]) => options?.body);
}

function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

async function pressEnter() {
  fireEvent.keyDown(composer(), { key: "Enter" });
  await quiesce();
}

async function clickSend() {
  fireEvent.click(send());
  await quiesce();
}

/** 选入 a.pdf 并传完。 */
async function withUploaded(extra: FetchRoutes = {}, after: string[] = []) {
  const page = await open(S, extra, after);
  await choose(file("a.pdf"));
  await land(0, "a.pdf");
  expect(chips()).toEqual(["a.pdf10 B"]);
  return page;
}

function card() {
  return composer().closest('[data-slot="composer-card"]') as HTMLElement;
}

function dropActive() {
  return card().getAttribute("data-drop-active");
}

type Dragged = { types: string[]; files: File[]; items: unknown[] };

/** 拖拽经过时的 `dataTransfer`：真实浏览器此时只给 `types`，`files` 是空的。 */
function hovering(...types: string[]): { dataTransfer: Dragged } {
  return { dataTransfer: { types, files: [], items: [] } };
}

/** 放下时的 `dataTransfer`；`folders` 里的名字是文件夹（真实浏览器里它在 `files` 中也占一项）。 */
function dropped(files: File[], folders: string[] = []): { dataTransfer: Dragged } {
  const entry = (item: File, isDirectory: boolean) => ({
    kind: "file",
    getAsFile: () => item,
    webkitGetAsEntry: () => ({ isDirectory }),
  });
  const dirs = folders.map((name) => file(name, 0));
  return {
    dataTransfer: {
      types: ["Files"],
      files: [...dirs, ...files],
      items: [...dirs.map((dir) => entry(dir, true)), ...files.map((item) => entry(item, false))],
    },
  };
}

const TEXT_DRAG: { dataTransfer: Dragged } = {
  dataTransfer: { types: ["text/plain"], files: [], items: [{ kind: "string" }] },
};

async function drop(files: File[], folders: string[] = []) {
  const allowed = fireEvent.drop(card(), dropped(files, folders));
  await quiesce();
  return allowed;
}

/** 粘贴：`types` 是剪贴板里的类型，带文件时浏览器给 `Files`。 */
async function paste(types: string[], ...files: File[]) {
  const allowed = fireEvent.paste(composer(), { clipboardData: { types, files } });
  await quiesce();
  return allowed;
}

function plusButton() {
  return screen.getByRole("button", { hidden: true, name: "添加文件或命令" }) as HTMLButtonElement;
}

async function openMenu() {
  fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  await quiesce();
  return menu;
}

function uploadItem(menu: HTMLElement) {
  const first = within(menu).getAllByRole("menuitem")[0];
  if (!first) throw new Error("菜单里没有条目");
  return first;
}

describe("选择即上传", () => {
  it("逐个上传并显示进度，传完前不可发送；带文字发送时 prompt 带上两个路径，受理后附件区消失", async () => {
    const { fetchMock } = await open(S, {}, ["uploads/a.pdf", "uploads/b (1).png"]);
    expect(area()).toBeNull();

    await choose(file("a.pdf"), file("b.png", 20));
    expect(FakeXhr.instances).toHaveLength(1);
    expect(xhr(0).opens).toEqual([["POST", `/api/workspaces/${W}/uploads?name=a.pdf`]]);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%", "b.png20 B上传中 0%"]);

    act(() => xhr(0).progress(5, 10));
    expect(chips()[0]).toBe("a.pdf10 B上传中 50%");
    const bar = screen.getByRole("progressbar", { name: "a.pdf 上传进度" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(FakeXhr.instances).toHaveLength(1);
    typeDraft("看看");
    expect(send().disabled).toBe(true);

    await land(0, "a.pdf");
    expect(FakeXhr.instances).toHaveLength(2);
    expect(send().disabled).toBe(true);
    await land(1, "b (1).png", 2048);
    expect(chips()).toEqual(["a.pdf10 B", "b (1).png2.0 KB"]);
    expect(statuses()).toEqual(["uploaded", "uploaded"]);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(send().disabled).toBe(false);

    // 卡片内：附件区在文本框之前。
    const list = area() as HTMLElement;
    expect(list.parentElement).toBe(composer().closest('[data-slot="composer-card"]'));
    expect(
      list.compareDocumentPosition(composer()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await clickSend();
    expect(bodies(fetchMock).map((body) => JSON.parse(String(body)))).toEqual([
      { message: "看看", attachments: ["uploads/a.pdf", "uploads/b (1).png"] },
    ]);
    await waitFor(() => expect(screen.getAllByRole("article", { name: "用户" })).toHaveLength(1));
    expect(area()).toBeNull();
    expect(composer().value).toBe("");
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("从「+」菜单的 `上传文件` 打开文件框：菜单关闭，草稿不变，不发请求", async () => {
    const { fetchMock } = await open();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    typeDraft("半句");
    const menu = await openMenu();
    const item = uploadItem(menu);
    expect(item.textContent).toBe("上传文件");
    expect(item.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(item);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toBe(fileInput());
    expect(composer().value).toBe("半句");
    expect(bodies(fetchMock)).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    const input = fileInput();
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(true);
  });
});

describe("数量与大小限制", () => {
  it("超过个数：整批不接受，提示 `每条消息最多 3 个附件`", async () => {
    await open();
    await choose(file("a.pdf"), file("b.pdf"));
    await choose(file("c.pdf"), file("d.pdf"));
    expect(chips()).toHaveLength(2);
    expect(alerts()).toEqual(["每条消息最多 3 个附件"]);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("超过大小：该文件不接受，提示 `「big.bin」超过大小上限`，其余照常", async () => {
    await open();
    await choose(file("ok.txt", 1000), file("big.bin", 1001));
    expect(chips()).toEqual(["ok.txt1000 B上传中 0%"]);
    expect(alerts()).toEqual(["「big.bin」超过大小上限"]);
    expect(FakeXhr.instances).toHaveLength(1);
  });
});

describe("失败、移除与取消", () => {
  it("失败的标签显示信封文案并挡住发送；移除在途项即中止，移除已上传项不发请求；没有标签的空草稿不可发送", async () => {
    const { fetchMock } = await open();
    await choose(file("a.pdf"), file("b.pdf"), file("c.pdf"));
    await fail(0);
    expect(chips()[0]).toBe(`a.pdf10 B失败：${TOO_BIG}`);
    expect(statuses()).toEqual(["failed", "uploading", "uploading"]);
    expect(alerts()).toEqual([]);

    // b 在途：移除即中止，c 接着发出。
    expect(FakeXhr.instances).toHaveLength(2);
    remove("b.pdf");
    await quiesce();
    expect(xhr(1).aborts).toBe(1);
    expect(FakeXhr.instances).toHaveLength(3);
    await land(2, "c.pdf");
    expect(chips()).toEqual([`a.pdf10 B失败：${TOO_BIG}`, "c.pdf10 B"]);

    // 还有失败的标签：有文字也不能发送。
    typeDraft("看看");
    expect(send().disabled).toBe(true);
    await pressEnter();
    expect(bodies(fetchMock)).toEqual([]);

    remove("a.pdf");
    expect(send().disabled).toBe(false);
    typeDraft("");
    expect(send().disabled).toBe(false);

    const requests = paths(fetchMock).length;
    remove("c.pdf");
    await quiesce();
    expect(area()).toBeNull();
    expect(FakeXhr.instances).toHaveLength(3);
    expect(xhr(2).aborts).toBe(0);
    expect(paths(fetchMock)).toHaveLength(requests);
    expect(send().disabled).toBe(true);
    typeDraft("   ");
    expect(send().disabled).toBe(true);
  });
});

describe("只有附件时可发送", () => {
  it("上传中：`发送` 禁用，Enter 与点击都不发 prompt", async () => {
    const { fetchMock } = await open();
    await choose(file("a.pdf"));
    expect(send().disabled).toBe(true);
    await pressEnter();
    fireEvent.submit(composer().form as HTMLFormElement);
    await quiesce();
    expect(bodies(fetchMock)).toEqual([]);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%"]);
  });

  it.each([
    ["Enter", pressEnter],
    ["点击 `发送`", clickSend],
  ])("传完后空草稿可发送（%s）：恰一次 prompt，`message` 为空串", async (_name, submit) => {
    const { fetchMock } = await withUploaded({}, ["uploads/a.pdf"]);
    expect(composer().value).toBe("");
    expect(send().disabled).toBe(false);

    await submit();
    expect(bodies(fetchMock)).toEqual(['{"message":"","attachments":["uploads/a.pdf"]}']);
    await waitFor(() => expect(screen.getAllByRole("article", { name: "用户" })).toHaveLength(1));
    expect(area()).toBeNull();
  });

  it("三个空格的草稿原样发出", async () => {
    const { fetchMock } = await withUploaded({}, ["uploads/a.pdf"]);
    typeDraft("   ");
    expect(send().disabled).toBe(false);
    await clickSend();
    expect(bodies(fetchMock)).toEqual(['{"message":"   ","attachments":["uploads/a.pdf"]}']);
  });

  it("带一个失败标签时禁用；移除唯一的标签后禁用", async () => {
    const { fetchMock } = await withUploaded();
    await choose(file("b.pdf"));
    await fail(1);
    expect(statuses()).toEqual(["uploaded", "failed"]);
    expect(send().disabled).toBe(true);
    await pressEnter();
    fireEvent.submit(composer().form as HTMLFormElement);
    await quiesce();
    expect(bodies(fetchMock)).toEqual([]);

    remove("b.pdf");
    expect(send().disabled).toBe(false);
    remove("a.pdf");
    expect(send().disabled).toBe(true);
    await pressEnter();
    fireEvent.submit(composer().form as HTMLFormElement);
    await quiesce();
    expect(bodies(fetchMock)).toEqual([]);
  });
});

describe("发送被拒时恢复", () => {
  const busy: FetchRoutes = { [PROMPT]: () => envelope(409, "session_busy", SESSION_BUSY) };

  async function twoUploaded() {
    const page = await open(S, busy);
    await choose(file("a.pdf"), file("b.png"));
    await land(0, "a.pdf");
    await land(1, "b (1).png");
    return page;
  }

  it("有草稿：草稿与两个标签都回来，仍是已上传、名字不变，不重新上传", async () => {
    const { fetchMock } = await twoUploaded();
    typeDraft("看看");
    await clickSend();

    expect(bodies(fetchMock)).toHaveLength(1);
    expect(alerts()).toEqual([SESSION_BUSY]);
    expect(composer().value).toBe("看看");
    expect(chips()).toEqual(["a.pdf10 B", "b (1).png10 B"]);
    expect(statuses()).toEqual(["uploaded", "uploaded"]);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(send().disabled).toBe(false);
  });

  it("空草稿：草稿仍为空，标签回来，`发送` 仍可用；再发一次带的还是同两个路径", async () => {
    const { fetchMock } = await twoUploaded();
    await clickSend();

    expect(alerts()).toEqual([SESSION_BUSY]);
    expect(composer().value).toBe("");
    expect(chips()).toEqual(["a.pdf10 B", "b (1).png10 B"]);
    expect(statuses()).toEqual(["uploaded", "uploaded"]);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(send().disabled).toBe(false);

    await clickSend();
    const body = '{"message":"","attachments":["uploads/a.pdf","uploads/b (1).png"]}';
    expect(bodies(fetchMock)).toEqual([body, body]);
    expect(FakeXhr.instances).toHaveLength(2);
  });
});

describe("切换会话", () => {
  async function leave(target: "另一个会话" | "新建会话") {
    fireEvent.click(screen.getByRole("button", { name: target }));
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();
  }

  it("切换会话清空标签：回来后也没有", async () => {
    const { fetchMock } = await withUploaded();
    await leave("另一个会话");
    expect(area()).toBeNull();
    expect(send().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "绑定会话" }));
    await quiesce();
    expect(area()).toBeNull();
    expect(bodies(fetchMock)).toEqual([]);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toEqual([]);
  });

  it.each(["另一个会话", "新建会话"] as const)(
    "上传中切到%s：在途的中止、排队的不发出，没有提示，不删文件",
    async (target) => {
      const { fetchMock } = await open();
      await choose(file("a.pdf"), file("b.pdf"), file("c.pdf"));
      await land(0, "a.pdf");
      expect(FakeXhr.instances).toHaveLength(2);
      // b 传到 40% 时切走。
      act(() => xhr(1).progress(4, 10));
      expect(chips()).toEqual(["a.pdf10 B", "b.pdf10 B上传中 40%", "c.pdf10 B上传中 0%"]);

      await leave(target);
      expect(xhr(1).aborts).toBe(1);
      expect(FakeXhr.instances).toHaveLength(2);
      expect(area()).toBeNull();
      expect(alerts()).toEqual([]);
      expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toEqual(
        [],
      );
    },
  );
});

describe("没有上传目标", () => {
  it("未绑定会话：`上传文件` 不可选并写明原因，点了不打开文件框，草稿不变", async () => {
    const { fetchMock } = await open(UNBOUND);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    typeDraft("半句");
    const before = paths(fetchMock).length;
    const item = uploadItem(await openMenu());
    expect(item.textContent).toBe(`上传文件${NO_WORKSPACE}`);
    expect(item.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(item);
    await quiesce();
    expect(click).not.toHaveBeenCalled();
    // 菜单还开着：页面其余部分是 aria-hidden，输入框按 hidden 取。
    const input = screen.getByRole("textbox", { hidden: true, name: "给助手发消息" });
    expect((input as HTMLTextAreaElement).value).toBe("半句");
    expect(FakeXhr.instances).toHaveLength(0);
    // 打开菜单只多了一次目录请求。
    expect(paths(fetchMock).slice(before)).toEqual([COMMANDS]);
  });

  it("输入框选项读取失败：`上传文件` 不可选，没有原因文字", async () => {
    await open(S, { "/api/composer/options": () => envelope(503, "unavailable", "服务不可用") });
    const item = uploadItem(await openMenu());
    expect(item.textContent).toBe("上传文件");
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("回合进行中：文件框收到文件也不接受", async () => {
    const running = { ...S, status: "running" as const };
    await open(S, {
      "/api/sessions": () => jsonResponse({ sessions: [running] }),
      [messagesPath(S.id)]: () => jsonResponse(snapshotOf(running)),
    });
    expect(composer().disabled).toBe(true);

    await choose(file("a.pdf"));
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe("拖入与粘贴", () => {
  it("文件拖到输入框上方：容器带 `data-drop-active`，放下后去掉，两个文件成为标签并逐个上传", async () => {
    await open();
    expect(card().hasAttribute("data-drop-active")).toBe(false);

    expect(fireEvent.dragEnter(card(), hovering("Files"))).toBe(false);
    expect(fireEvent.dragOver(card(), hovering("Files"))).toBe(false);
    expect(dropActive()).toBe("true");
    expect(area()).toBeNull();

    expect(await drop([file("a.pdf"), file("b.png", 20)])).toBe(false);
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%", "b.png20 B上传中 0%"]);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(xhr(0).opens).toEqual([["POST", `/api/workspaces/${W}/uploads?name=a.pdf`]]);
    await land(0, "a.pdf");
    expect(FakeXhr.instances).toHaveLength(2);
    await land(1, "b.png", 20);
    expect(statuses()).toEqual(["uploaded", "uploaded"]);
  });

  it("指针在容器的子元素之间移动时高亮不闪：进入两次、离开一次仍在，再离开才去掉", async () => {
    await open();
    fireEvent.dragEnter(card(), hovering("Files"));
    fireEvent.dragEnter(composer(), hovering("Files"));
    fireEvent.dragLeave(card(), hovering("Files"));
    expect(dropActive()).toBe("true");
    fireEvent.dragLeave(composer(), hovering("Files"));
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(area()).toBeNull();

    // 多出来的一次离开不欠账：下一次进入照常高亮。
    fireEvent.dragLeave(card(), hovering("Files"));
    fireEvent.dragEnter(card(), hovering("Files"));
    expect(dropActive()).toBe("true");
  });

  it("拖入一段文字：不处理，没有高亮，不产生标签", async () => {
    await open();
    typeDraft("半句");
    expect(fireEvent.dragEnter(card(), TEXT_DRAG)).toBe(true);
    expect(fireEvent.dragOver(card(), TEXT_DRAG)).toBe(true);
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(fireEvent.dragLeave(card(), TEXT_DRAG)).toBe(true);
    expect(fireEvent.drop(card(), TEXT_DRAG)).toBe(true);
    await quiesce();
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(composer().value).toBe("半句");
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("粘贴截图：多一个 `image.png` 标签，草稿没有多出文字", async () => {
    await withUploaded();
    typeDraft("半句");
    expect(await paste(["Files"], file("image.png"))).toBe(false);
    expect(chips()).toEqual(["a.pdf10 B", "image.png10 B上传中 0%"]);
    expect(composer().value).toBe("半句");
    expect(FakeXhr.instances).toHaveLength(2);
    expect(xhr(1).opens).toEqual([["POST", `/api/workspaces/${W}/uploads?name=image.png`]]);
  });

  it.each<[string, string[], File[]]>([
    ["纯文字", ["text/plain"], []],
    ["文字附带一张渲染图", ["text/plain", "text/html", "Files"], [file("image.png")]],
  ])("粘贴%s：不拦截，没有新标签", async (_name, types, files) => {
    await open();
    typeDraft("半句");
    expect(await paste(types, ...files)).toBe(true);
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(composer().value).toBe("半句");
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("拖入的文件走同一个入口：超过个数时整批不接受并提示", async () => {
    await open();
    const four = ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map((name) => file(name));
    expect(await drop(four)).toBe(false);
    expect(area()).toBeNull();
    expect(alerts()).toEqual(["每条消息最多 3 个附件"]);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("拖入文件夹：文件夹被跳过，同批的文件照常", async () => {
    await open();
    expect(await drop([file("a.pdf")], ["资料"])).toBe(false);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%"]);
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(1);

    // 只有文件夹：什么都不发生，已有的提示也不动。
    await choose(file("big.bin", 1001));
    expect(alerts()).toEqual(["「big.bin」超过大小上限"]);
    expect(await drop([], ["资料"])).toBe(false);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%"]);
    expect(alerts()).toEqual(["「big.bin」超过大小上限"]);
  });
});

describe("拖入与粘贴没有上传目标", () => {
  // 提示是单槽：拖入与粘贴各用一个会话，连着做时后一半永远判不了红。
  it.each<[string, () => Promise<boolean>]>([
    ["拖入一个文件", () => drop([file("a.pdf")])],
    ["粘贴一张截图", () => paste(["Files"], file("image.png"))],
  ])("未绑定会话%s：输入框上显示原因，没有标签，不发请求，草稿不变", async (_name, give) => {
    const { fetchMock } = await open(UNBOUND);
    typeDraft("半句");
    const before = paths(fetchMock).length;

    expect(await give()).toBe(false);
    expect(alerts()).toEqual([NO_WORKSPACE]);
    expect(area()).toBeNull();
    expect(FakeXhr.instances).toHaveLength(0);
    expect(paths(fetchMock)).toHaveLength(before);
    expect(composer().value).toBe("半句");
  });

  it("回合进行中：拖入的文件不接受也没有高亮，但缺省动作仍被拦下（页面不被带走）", async () => {
    const running = { ...S, status: "running" as const };
    await open(S, {
      "/api/sessions": () => jsonResponse({ sessions: [running] }),
      [messagesPath(S.id)]: () => jsonResponse(snapshotOf(running)),
    });
    expect(composer().disabled).toBe(true);

    expect(fireEvent.dragEnter(card(), hovering("Files"))).toBe(false);
    expect(fireEvent.dragOver(card(), hovering("Files"))).toBe(false);
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(await drop([file("a.pdf")])).toBe(false);
    await paste(["Files"], file("image.png"));
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("欢迎态：拖入与粘贴都不处理（暂存属首次发送一刀）", async () => {
    renderChatPage("/", {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      ...composerOptionsRoute(OPTIONS),
      "/api/sessions": () => jsonResponse({ sessions: [S] }),
      [COMMANDS]: catalogue(),
    });
    await screen.findByRole("textbox", { name: "给助手发消息" });
    await quiesce();
    installFakeXhr();
    expect(composer().disabled).toBe(false);

    expect(fireEvent.dragEnter(card(), hovering("Files"))).toBe(true);
    expect(fireEvent.dragOver(card(), hovering("Files"))).toBe(true);
    expect(card().hasAttribute("data-drop-active")).toBe(false);
    expect(await drop([file("a.pdf")])).toBe(true);
    expect(await paste(["Files"], file("image.png"))).toBe(true);
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(send().disabled).toBe(true);
  });
});
