// 欢迎态暂存与首次发送（message-attachments「欢迎态暂存与首次发送」「没有工作空间的会话」「输入框附件标签」的
// 首次发送部分）：欢迎态选入的文件只是 `待上传` 标签；首次发送先建会话、再逐个上传、最后发 prompt，任何一步失败
// 即停在那一步。seam：整页挂载 + 假 API + `FakeXhr`。期望的请求次序、请求体与文案取自规格条文。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  alerts,
  area,
  chips,
  choose,
  file,
  land,
  openMenu,
  remove,
  send,
  statuses,
  uploadItem,
  xhr,
} from "./chat-attachments-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import {
  clickSend,
  renderObservedChatPage,
  sessionPromptPath,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import { composer, envelope, promptAccepted, SESSION_BUSY } from "./chat-page-ownership-support.js";
import {
  A,
  cleanupSessionMeta,
  findList,
  messagesPath,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  CREATE_REJECTED,
  CREATED_IDS,
  composerForm,
  createOf,
  createRejected,
  createRequests,
  HERO,
  leaveForWelcome,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickOption,
  promptRequests,
  SUPPORT,
  SUPPORT_OPTION,
  TEMP_WORKSPACE_IDS,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { historyUser } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import {
  calls,
  composerOptionsRoute,
  currentLocation,
  type FetchMock,
  jsonResponse,
} from "./support.js";
import { FakeXhr, installFakeXhr } from "./upload-support.js";

const W = PROJECT_A.id;
const CREATED = `${CREATED_IDS[0]}`;
const TEMP = `${TEMP_WORKSPACE_IDS[0]}`;
const OPTIONS = { ...DEFAULT_COMPOSER_OPTIONS, upload: { maxBytes: 1000, maxFiles: 3 } };
const DENIED = "路径不在工作空间内";
const NO_WORKSPACE = "此会话没有工作空间，无法上传文件";
const EMPTY = "还没有消息，发一条开始吧";
const EXISTING = "既有会话";
const UNTITLED = "新会话";

type Welcome = NonNullable<Parameters<typeof welcomeRoutes>[0]>;
type Mounted = ReturnType<typeof renderChatPage>;

afterEach(cleanupSessionMeta);

/** 欢迎态，上限为每条消息 3 个、每个 1000 字节；新会话的 prompt 缺省挂起。 */
async function welcome(extra: FetchRoutes = {}, fixture: Welcome = {}) {
  const page = renderChatPage("/", {
    ...welcomeRoutes(fixture),
    ...composerOptionsRoute(OPTIONS),
    ...extra,
  });
  await screen.findByRole("heading", { level: 1, name: HERO });
  await quiesce();
  installFakeXhr();
  return page;
}

/**
 * 新会话的 prompt 与历史：prompt 按 `outcomes` 依次应答，用完后受理；受理后的历史带回一条附件为 `paths`
 * 的用户消息与一条已完成的回答，此前是空历史。
 */
function turn(
  session: SessionView,
  content: string,
  paths: string[],
  outcomes: (() => Response)[] = [],
): FetchRoutes {
  let accepted = false;
  const messages = [
    { ...historyUser, content, attachments: paths.map((path) => ({ path, size: 10 })) },
    { ...historyUser, id: 0, role: "assistant", undo: null, content: "好的", createdAt: 0 },
  ];
  return {
    [sessionPromptPath(session.id)]: () => {
      const outcome = outcomes.shift();
      if (outcome) return outcome();
      accepted = true;
      return jsonResponse(promptAccepted, 202);
    },
    [messagesPath(session.id)]: () =>
      jsonResponse({
        session,
        messages: accepted ? messages : [],
        streamCursor: { epoch: 1, seq: 0 },
        todo: null,
      }),
  };
}

function uploadOf(workspaceId: string, name: string) {
  return [["POST", `/api/workspaces/${workspaceId}/uploads?name=${encodeURIComponent(name)}`]];
}

async function deny(index: number) {
  act(() =>
    xhr(index).respond(403, JSON.stringify({ error: { code: "sandbox_denied", message: DENIED } })),
  );
  await quiesce();
}

function prompts(fetchMock: FetchMock) {
  return promptRequests(fetchMock, CREATED).map(([, body]) => body);
}

function historyReads(fetchMock: FetchMock) {
  return calls(fetchMock, messagesPath(CREATED)).length;
}

/** 输入框锁定并显示 `生成中`：整个首次发送都算提交进行中。 */
function expectSubmitting() {
  expect(composer().disabled).toBe(true);
  expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
}

/** 发送并等到会话建出、URL 选中它。 */
async function sendFirst() {
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
  await quiesce();
}

/** 用户气泡里的附件列表各项（文件名与大小）。 */
function bubbleFiles() {
  const bubble = screen.getByRole("article", { name: "用户" });
  return within(within(bubble).getByRole("list", { name: "附件" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

/** 欢迎态选中 项目A、选入 a.pdf 与 b.png、输入 `看看` 并发送：会话已建出，a.pdf 在途。 */
async function twoStagedSent(extra: FetchRoutes = {}, fixture: Welcome = {}) {
  const page = await welcome(extra, fixture);
  await pickOption(PROJECT_A_OPTION);
  await choose(file("a.pdf"), file("b.png"));
  typeDraft("看看");
  await sendFirst();
  expect(FakeXhr.instances).toHaveLength(1);
  return page;
}

describe("欢迎态暂存", () => {
  it("未选工作空间：`上传文件` 可点且不带原因；选入的文件是 `待上传` 标签，没有任何请求，`发送` 随即可用", async () => {
    const { fetchMock } = await welcome();
    expect(send().disabled).toBe(true);
    const requests = fetchMock.mock.calls.length;
    await choose(file("a.pdf"), file("b.png", 1000));
    expect(chips()).toEqual(["a.pdf10 B待上传", "b.png1000 B待上传"]);
    expect(statuses()).toEqual(["pending", "pending"]);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(fetchMock.mock.calls).toHaveLength(requests);
    expect(send().disabled).toBe(false);
    expect(currentLocation()).toBe("/");

    const item = uploadItem(await openMenu());
    expect(item.textContent).toBe("上传文件");
    expect(item.getAttribute("aria-disabled")).toBeNull();
  });

  it("个数与大小上限在暂存时就判：超过个数整批不收，超过大小的那个不收", async () => {
    await welcome();
    await choose(file("a.pdf"), file("b.pdf"));
    await choose(file("c.pdf"), file("d.pdf"));
    expect(chips()).toEqual(["a.pdf10 B待上传", "b.pdf10 B待上传"]);
    expect(alerts()).toEqual(["每条消息最多 3 个附件"]);

    remove("a.pdf");
    remove("b.pdf");
    await choose(file("ok.txt", 1000), file("big.bin", 1001));
    expect(chips()).toEqual(["ok.txt1000 B待上传"]);
    expect(alerts()).toEqual(["「big.bin」超过大小上限"]);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("发送前移除一个待上传的标签：不发请求；首次发送只上传剩下的那个", async () => {
    const { fetchMock } = await welcome(
      turn(view(CREATED, null, { temporaryWorkspace: true, workspaceId: TEMP }), "", [
        "uploads/b.png",
      ]),
    );
    await choose(file("a.pdf"), file("b.png"));
    remove("a.pdf");
    expect(chips()).toEqual(["b.png10 B待上传"]);
    expect(FakeXhr.instances).toHaveLength(0);
    remove("b.png");
    expect(area()).toBeNull();
    expect(send().disabled).toBe(true);

    await choose(file("a.pdf"), file("b.png"));
    remove("a.pdf");
    await sendFirst();
    expect(xhr(0).opens).toEqual(uploadOf(TEMP, "b.png"));
    await land(0, "b.png");
    expect(FakeXhr.instances).toHaveLength(1);
    expect(prompts(fetchMock)).toEqual(['{"message":"","attachments":["uploads/b.png"]}']);
  });

  it("暂存后改选工作空间：标签还在，文件传到建出的会话的空间", async () => {
    const { fetchMock } = await welcome();
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"));
    await pickOption(SUPPORT_OPTION);
    expect(chips()).toEqual(["a.pdf10 B待上传"]);
    expect(FakeXhr.instances).toHaveLength(0);

    await sendFirst();
    expect(createRequests(fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${SUPPORT.id}"}`),
    ]);
    expect(xhr(0).opens).toEqual(uploadOf(SUPPORT.id, "a.pdf"));
  });

  it("暂存后切到既有会话再回到欢迎态：两边都没有标签，没有上传请求", async () => {
    const mounted = await welcome({}, { existing: [view(A, EXISTING, { workspaceId: W })] });
    await choose(file("a.pdf"));
    typeDraft("半句");

    fireEvent.click(within(await findList(EXISTING)).getByRole("button", { name: EXISTING }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${A}`));
    await quiesce();
    expect(area()).toBeNull();
    await leaveForWelcome(mounted);
    await quiesce();
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(createRequests(mounted.fetchMock)).toEqual([]);
  });
});

describe("首次发送先建会话再上传再发 prompt", () => {
  it("选中工作空间 W、两个文件、`看看`：创建挂起时不上传；建出后逐个上传到 W，传完才发 prompt；受理后气泡带两个附件、附件区清空", async () => {
    let release: (response: Response) => void = () => undefined;
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const { fetchMock } = await welcome(
      turn(created, "看看", ["uploads/a.pdf", "uploads/b (1).png"]),
      { create: () => new Promise<Response>((resolve) => (release = resolve)) },
    );
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"), file("b.png", 20));
    typeDraft("看看");
    clickSend();
    await quiesce();

    expect(createRequests(fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${W}"}`),
    ]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(chips()).toEqual(["a.pdf10 B待上传", "b.png20 B待上传"]);
    expectSubmitting();

    release(jsonResponse(created, 201));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
    await quiesce();
    expect(FakeXhr.instances).toHaveLength(1);
    expect(xhr(0).opens).toEqual(uploadOf(W, "a.pdf"));
    expect(chips()).toEqual(["a.pdf10 B上传中 0%", "b.png20 B待上传"]);
    expect(prompts(fetchMock)).toEqual([]);
    expectSubmitting();

    await land(0, "a.pdf");
    expect(FakeXhr.instances).toHaveLength(2);
    expect(xhr(1).opens).toEqual(uploadOf(W, "b.png"));
    expect(chips()).toEqual(["a.pdf10 B", "b.png20 B上传中 0%"]);
    expect(prompts(fetchMock)).toEqual([]);
    expectSubmitting();

    await land(1, "b (1).png", 20);
    expect(prompts(fetchMock).map((body) => JSON.parse(String(body)))).toEqual([
      { message: "看看", attachments: ["uploads/a.pdf", "uploads/b (1).png"] },
    ]);
    await waitFor(() => expect(bubbleFiles()).toEqual(["a.pdf10 B", "b (1).png10 B"]));
    expect(area()).toBeNull();
    expect(composer().value).toBe("");
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("从发送到第一个文件开始上传，会话页的每一次提交里附件区都在（交接时标签不闪没）", async () => {
    const commits: string[] = [];
    renderObservedChatPage("/", { ...welcomeRoutes(), ...composerOptionsRoute(OPTIONS) }, (html) =>
      commits.push(html),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();
    installFakeXhr();
    await choose(file("a.pdf"));
    typeDraft("看看");
    const before = commits.length;
    await sendFirst();

    expect(chips()).toEqual(["a.pdf10 B上传中 0%"]);
    const during = commits.slice(before);
    expect(during.length).toBeGreaterThan(1);
    expect(during.filter((html) => !html.includes('data-slot="composer-attachments"'))).toEqual([]);
  });

  it("不输入文字、只选 a.pdf：body 恰为空 `message` 加该路径；侧栏标题取列表返回的视图", async () => {
    const created = view(CREATED, null, { temporaryWorkspace: true, workspaceId: TEMP });
    const routes = { ...welcomeRoutes(), ...turn(created, "", ["uploads/a.pdf"]) };
    const sessions = routes["/api/sessions"];
    const prompt = routes[sessionPromptPath(CREATED)];
    if (typeof sessions !== "function" || typeof prompt !== "function") {
      throw new Error("夹具的路由不是函数路由");
    }
    // 服务端受理 prompt 时取文件名作标题：此后的列表读取返回带标题的条目。
    let titled = false;
    routes[sessionPromptPath(CREATED)] = (path, options) => {
      titled = true;
      return prompt(path, options);
    };
    routes["/api/sessions"] = (path, options) =>
      options?.method !== "POST" && titled
        ? jsonResponse({ sessions: [{ ...created, title: "a.pdf" }] })
        : sessions(path, options);
    const { fetchMock } = await welcome(routes);

    await choose(file("a.pdf"));
    expect(composer().value).toBe("");
    expect(send().disabled).toBe(false);
    await sendFirst();
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    expect(xhr(0).opens).toEqual(uploadOf(TEMP, "a.pdf"));
    const nav = await findList(UNTITLED);
    expect(within(nav).queryByRole("button", { name: "a.pdf" })).toBeNull();

    await land(0, "a.pdf");
    expect(prompts(fetchMock)).toEqual(['{"message":"","attachments":["uploads/a.pdf"]}']);
    await waitFor(() => expect(bubbleFiles()).toEqual(["a.pdf10 B"]));
    expect(await within(nav).findByRole("button", { name: "a.pdf" })).toBeTruthy();
    expect(area()).toBeNull();
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("未选工作空间而得到临时空间：请求次序与选了正式空间时相同，文件传到该临时空间", async () => {
    const { fetchMock } = await welcome();
    await choose(file("a.pdf"));
    typeDraft("看看");
    await sendFirst();

    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    expect(xhr(0).opens).toEqual(uploadOf(TEMP, "a.pdf"));
    expect(prompts(fetchMock)).toEqual([]);
    await land(0, "a.pdf");
    expect(prompts(fetchMock)).toEqual(['{"message":"看看","attachments":["uploads/a.pdf"]}']);
    expect(FakeXhr.instances).toHaveLength(1);
  });

  it("创建在途与上传在途时再按 Enter、再提交表单：不多建会话、不多传、不提前发 prompt", async () => {
    let release: (response: Response) => void = () => undefined;
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const { fetchMock } = await welcome(turn(created, "看看", []), {
      create: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await choose(file("a.pdf"), file("b.png"));
    typeDraft("看看");
    const again = async () => {
      fireEvent.keyDown(composer(), { key: "Enter" });
      fireEvent.submit(composerForm());
      await quiesce();
    };
    clickSend();
    await again();
    expect(createRequests(fetchMock)).toHaveLength(1);

    release(jsonResponse(created, 201));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
    await quiesce();
    await again();
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(chips()).toEqual(["a.pdf10 B上传中 0%", "b.png10 B待上传"]);
    expect(prompts(fetchMock)).toEqual([]);

    await land(0, "a.pdf");
    await again();
    expect(FakeXhr.instances).toHaveLength(2);
    await land(1, "b.png");
    expect(prompts(fetchMock)).toHaveLength(1);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(2);
  });
});

describe("首次发送的各失败点", () => {
  it("建会话被拒：标签仍是 `待上传`、草稿恢复、没有上传；再发一次重新创建并上传同一个文件", async () => {
    const routes = welcomeRoutes();
    const sessions = routes["/api/sessions"];
    if (typeof sessions !== "function") throw new Error("夹具的会话路由不是函数路由");
    let posts = 0;
    routes["/api/sessions"] = (path, options) => {
      if (options?.method !== "POST") return sessions(path, options);
      posts += 1;
      return posts === 1 ? createRejected() : sessions(path, options);
    };
    const { fetchMock } = await welcome(routes);
    await choose(file("a.pdf"));
    typeDraft("看看");
    clickSend();
    await quiesce();

    expect(alerts()).toEqual([CREATE_REJECTED]);
    expect(currentLocation()).toBe("/");
    expect(chips()).toEqual(["a.pdf10 B待上传"]);
    expect(composer().value).toBe("看看");
    expect(composer().disabled).toBe(false);
    expect(send().disabled).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);

    await sendFirst();
    expect(createRequests(fetchMock)).toHaveLength(2);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(xhr(0).opens).toEqual(uploadOf(TEMP, "a.pdf"));
    expect(xhr(0).bodies).toHaveLength(1);
    expect((xhr(0).bodies[0] as File).name).toBe("a.pdf");
    expect(prompts(fetchMock)).toEqual([]);
  });

  it("第二个上传 403：不发 prompt，新会话保持选中并补读一次历史，草稿恢复，标签为已上传与失败，`发送` 禁用；移除失败的再发不重建、不重传", async () => {
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const { fetchMock } = await twoStagedSent(turn(created, "看看", ["uploads/a.pdf"]));
    expect(historyReads(fetchMock)).toBe(0);
    await land(0, "a.pdf");
    await deny(1);

    expect(prompts(fetchMock)).toEqual([]);
    expect(currentLocation()).toBe(`/?session=${CREATED}`);
    expect(await screen.findByText(EMPTY, { exact: true })).toBeTruthy();
    await quiesce();
    expect(historyReads(fetchMock)).toBe(1);
    expect(composer().value).toBe("看看");
    expect(composer().disabled).toBe(false);
    expect(chips()).toEqual(["a.pdf10 B", `b.png10 B失败：${DENIED}`]);
    expect(statuses()).toEqual(["uploaded", "failed"]);
    expect(alerts()).toEqual([DENIED]);
    expect(send().disabled).toBe(true);
    fireEvent.submit(composerForm());
    await quiesce();
    expect(prompts(fetchMock)).toEqual([]);

    remove("b.png");
    expect(send().disabled).toBe(false);
    clickSend();
    await waitFor(() => expect(bubbleFiles()).toEqual(["a.pdf10 B"]));
    expect(prompts(fetchMock)).toEqual(['{"message":"看看","attachments":["uploads/a.pdf"]}']);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(area()).toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("三个文件、第二个 403：第三个不上传、仍是 `待上传`；移除失败的再发，只补传第三个，prompt 带第一与第三个", async () => {
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const { fetchMock } = await welcome(turn(created, "看看", ["uploads/a.pdf", "uploads/c.txt"]));
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"), file("b.png"), file("c.txt"));
    typeDraft("看看");
    await sendFirst();
    await land(0, "a.pdf");
    await deny(1);

    expect(chips()).toEqual(["a.pdf10 B", `b.png10 B失败：${DENIED}`, "c.txt10 B待上传"]);
    expect(statuses()).toEqual(["uploaded", "failed", "pending"]);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(alerts()).toEqual([DENIED]);
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(send().disabled).toBe(true);

    remove("b.png");
    clickSend();
    await quiesce();
    expect(FakeXhr.instances).toHaveLength(3);
    expect(xhr(2).opens).toEqual(uploadOf(W, "c.txt"));
    expect(chips()).toEqual(["a.pdf10 B", "c.txt10 B上传中 0%"]);
    expect(prompts(fetchMock)).toEqual([]);
    expectSubmitting();

    await land(2, "c.txt");
    expect(prompts(fetchMock)).toEqual([
      '{"message":"看看","attachments":["uploads/a.pdf","uploads/c.txt"]}',
    ]);
    await waitFor(() => expect(bubbleFiles()).toEqual(["a.pdf10 B", "c.txt10 B"]));
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(3);
  });

  it("上传都成功而 prompt 被拒（409）：两个标签回来且仍是已上传，草稿恢复；再发不建会话、不重传", async () => {
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const paths = ["uploads/a.pdf", "uploads/b (1).png"];
    const { fetchMock } = await twoStagedSent(
      turn(created, "看看", paths, [() => envelope(409, "session_busy", SESSION_BUSY)]),
    );
    await land(0, "a.pdf");
    await land(1, "b (1).png");

    expect(await screen.findByText(EMPTY, { exact: true })).toBeTruthy();
    await quiesce();
    expect(alerts()).toEqual([SESSION_BUSY]);
    expect(composer().value).toBe("看看");
    expect(chips()).toEqual(["a.pdf10 B", "b (1).png10 B"]);
    expect(statuses()).toEqual(["uploaded", "uploaded"]);
    expect(historyReads(fetchMock)).toBe(1);
    expect(send().disabled).toBe(false);

    clickSend();
    await waitFor(() => expect(bubbleFiles()).toEqual(["a.pdf10 B", "b (1).png10 B"]));
    const body = '{"message":"看看","attachments":["uploads/a.pdf","uploads/b (1).png"]}';
    expect(prompts(fetchMock)).toEqual([body, body]);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(area()).toBeNull();
  });

  it("建出的会话没有工作空间：不上传、不发 prompt，输入框上是那句原因，草稿与标签都在，`上传文件` 随即禁用并带原因", async () => {
    const unbound = view(CREATED, null, { status: "idle" });
    let created = false;
    const routes = welcomeRoutes({
      create: () => {
        created = true;
        return jsonResponse(unbound, 201);
      },
    });
    const sessions = routes["/api/sessions"];
    if (typeof sessions !== "function") throw new Error("夹具的会话路由不是函数路由");
    routes["/api/sessions"] = (path, options) =>
      options?.method !== "POST" && created
        ? jsonResponse({ sessions: [unbound] })
        : sessions(path, options);
    const { fetchMock } = await welcome({ ...routes, ...turn(unbound, "看看", []) });
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"));
    typeDraft("看看");
    await sendFirst();

    expect(await screen.findByText(EMPTY, { exact: true })).toBeTruthy();
    await quiesce();
    expect(createRequests(fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${W}"}`),
    ]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(prompts(fetchMock)).toEqual([]);
    expect(currentLocation()).toBe(`/?session=${CREATED}`);
    expect(alerts()).toEqual([NO_WORKSPACE]);
    expect(composer().value).toBe("看看");
    expect(chips()).toEqual(["a.pdf10 B待上传"]);
    const item = uploadItem(await openMenu());
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toBe(`上传文件${NO_WORKSPACE}`);
  });

  it.each<[string, string, (mounted: Mounted) => Promise<void>]>([
    [
      "另一个既有会话",
      `/?session=${A}`,
      async () => {
        fireEvent.click(within(await findList(EXISTING)).getByRole("button", { name: EXISTING }));
      },
    ],
    ["欢迎态", "/", leaveForWelcome],
  ])(
    "第一个上传在途时切到%s：在途的中止、第二个不上传、不发 prompt，切换后没有标签、草稿与错误",
    async (_, location, leave) => {
      const mounted = await twoStagedSent(
        {},
        { existing: [view(A, EXISTING, { workspaceId: W })] },
      );
      const { fetchMock } = mounted;

      await leave(mounted);
      await waitFor(() => expect(currentLocation()).toBe(location));
      await waitFor(() => expect(composer().disabled).toBe(false));
      await quiesce();
      expect(xhr(0).aborts).toBe(1);
      expect(FakeXhr.instances).toHaveLength(1);
      expect(prompts(fetchMock)).toEqual([]);
      expect(area()).toBeNull();
      expect(alerts()).toEqual([]);
      expect(composer().value).toBe("");
      expect(createRequests(fetchMock)).toHaveLength(1);
      expect(historyReads(fetchMock)).toBe(0);
    },
  );
});
