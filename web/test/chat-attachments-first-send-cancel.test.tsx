// 首次发送带暂存文件的两处边角（message-attachments「欢迎态暂存与首次发送」的场景「上传阶段按停止」
// 「移空标签后不发空 prompt」，#1277）。seam：整页挂载 + 假 API + `FakeXhr`。期望的请求、请求体与文案取自
// 规格条文。第三个场景「上传落定时已离开该会话」在整页层造不出时序，见 chat-dispatch-ownership.test.ts。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREATED,
  EMPTY,
  historyReads,
  prompts,
  sendFirst,
  turn,
  uploadOf,
  W,
  welcome,
} from "./chat-attachments-first-send-support.js";
import {
  alerts,
  area,
  chips,
  choose,
  file,
  land,
  remove,
  send,
  statuses,
  xhr,
} from "./chat-attachments-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, sessionPromptPath, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer, envelope, promptAccepted } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, messagesPath, view } from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import {
  createRequests,
  PROJECT_A_OPTION,
  pickOption,
  TEMP_WORKSPACE_IDS,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import {
  calls,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
} from "./support.js";
import { FakeXhr } from "./upload-support.js";

const TEMP = `${TEMP_WORKSPACE_IDS[0]}`;
const STOP = `/api/sessions/${CREATED}/stop`;
const EMPTY_PROMPT = "消息不能为空";

afterEach(cleanupSessionMeta);

/** 没有回合时服务端对 `/stop` 答 204；用例数它被调了几次。 */
const idleStop = (): FetchRoutes => ({ [STOP]: () => new Response(null, { status: 204 }) });

/** 空 `message` 且没有附件的 prompt 在服务端是 400：页面真发出去就会显示这句。 */
const rejectEmpty = () => envelope(400, "bad_request", EMPTY_PROMPT);

function stopButton() {
  return screen.getByRole("button", { name: "停止" }) as HTMLButtonElement;
}

async function clickStop() {
  fireEvent.click(stopButton());
  await quiesce();
}

async function progress(index: number, loaded: number, total: number) {
  act(() => xhr(index).progress(loaded, total));
  await quiesce();
}

function deletes(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
}

/** 这次发送按未受理收尾、没有留下错误：输入框解锁、不显示 `生成中`，新会话仍选中、线程是零消息状态。 */
async function expectSettledWithoutError() {
  expect(await screen.findByText(EMPTY, { exact: true })).toBeTruthy();
  await quiesce();
  expect(composer().disabled).toBe(false);
  expect(screen.queryByText("生成中", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  expect(alerts()).toEqual([]);
  expect(currentLocation()).toBe(`/?session=${CREATED}`);
}

describe("上传阶段按停止", () => {
  it("三个文件、第二个传到 40% 时点 `停止`：在途的中止、第三个不发、没有 prompt / stop / 删除请求，草稿与标签回来且没有错误；再发不重建、不重传第一个，恰一次 prompt 带三个路径", async () => {
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const paths = ["uploads/a.pdf", "uploads/b.png", "uploads/c.zip"];
    const { fetchMock } = await welcome({ ...turn(created, "看看", paths), ...idleStop() });
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"), file("b.png"), file("c.zip"));
    typeDraft("看看");
    await sendFirst();
    await land(0, "a.pdf");
    await progress(1, 4, 10);
    expect(chips()).toEqual(["a.pdf10 B", "b.png10 B上传中 40%", "c.zip10 B待上传"]);
    expect(stopButton().disabled).toBe(false);

    await clickStop();
    expect(xhr(1).aborts).toBe(1);
    expect(xhr(0).aborts).toBe(0);
    expect(FakeXhr.instances).toHaveLength(2);
    expect(prompts(fetchMock)).toEqual([]);
    expect(calls(fetchMock, STOP)).toEqual([]);
    expect(deletes(fetchMock)).toEqual([]);
    await expectSettledWithoutError();
    expect(composer().value).toBe("看看");
    expect(chips()).toEqual(["a.pdf10 B", "b.png10 B待上传", "c.zip10 B待上传"]);
    expect(statuses()).toEqual(["uploaded", "pending", "pending"]);
    expect(historyReads(fetchMock)).toBe(1);
    expect(send().disabled).toBe(false);

    clickSend();
    await quiesce();
    expect(FakeXhr.instances).toHaveLength(3);
    expect(xhr(2).opens).toEqual(uploadOf(W, "b.png"));
    expect(chips()).toEqual(["a.pdf10 B", "b.png10 B上传中 0%", "c.zip10 B待上传"]);
    expect(prompts(fetchMock)).toEqual([]);
    await land(2, "b.png");
    expect(FakeXhr.instances).toHaveLength(4);
    expect(xhr(3).opens).toEqual(uploadOf(W, "c.zip"));
    await land(3, "c.zip");
    expect(prompts(fetchMock)).toEqual([
      '{"message":"看看","attachments":["uploads/a.pdf","uploads/b.png","uploads/c.zip"]}',
    ]);
    await waitFor(() => expect(area()).toBeNull());
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(FakeXhr.instances).toHaveLength(4);
    expect(calls(fetchMock, STOP)).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it("prompt 已发出之后的 `停止` 不变：prompt 挂起时与回合运行中各点一次，各恰一次 `stopSession`，上传不被中止", async () => {
    const prompt = deferredResponse();
    let accepted = false;
    const running = chatSnapshot({ sessionId: CREATED });
    const created = view(CREATED, null, { status: "idle", workspaceId: W });
    const { fetchMock } = await welcome({
      [sessionPromptPath(CREATED)]: () => prompt.promise,
      [messagesPath(CREATED)]: () =>
        jsonResponse(
          accepted
            ? running
            : { session: created, messages: [], streamCursor: { epoch: 1, seq: 0 }, todo: null },
        ),
      ...idleStop(),
    });
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"));
    typeDraft("看看");
    await sendFirst();
    await land(0, "a.pdf");
    expect(prompts(fetchMock)).toHaveLength(1);

    await clickStop();
    expect(calls(fetchMock, STOP)).toHaveLength(1);
    expect(xhr(0).aborts).toBe(0);
    expect(composer().disabled).toBe(true);
    expect(composer().value).toBe("");

    accepted = true;
    await act(async () => prompt.resolve(jsonResponse(promptAccepted, 202)));
    await quiesce();
    await waitFor(() => expect(stopButton().disabled).toBe(false));
    await clickStop();
    expect(calls(fetchMock, STOP)).toHaveLength(2);
    expect(prompts(fetchMock)).toHaveLength(1);
  });
});

describe("移空标签后不发空 prompt", () => {
  it("草稿为空、只有 a.pdf，建会话期间移除它：没有上传、没有 prompt，输入框解锁，没有 400 文案", async () => {
    const create = deferredResponse();
    const created = view(CREATED, null, { temporaryWorkspace: true, workspaceId: TEMP });
    const { fetchMock } = await welcome(turn(created, "", [], [rejectEmpty]), {
      create: () => create.promise,
    });
    await choose(file("a.pdf"));
    clickSend();
    await quiesce();
    expect(createRequests(fetchMock)).toHaveLength(1);
    remove("a.pdf");

    await act(async () => create.resolve(jsonResponse(created, 201)));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
    await expectSettledWithoutError();
    expect(prompts(fetchMock)).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(0);
    expect(area()).toBeNull();
    expect(composer().value).toBe("");
    expect(createRequests(fetchMock)).toHaveLength(1);
  });

  it("草稿为空、只有 a.pdf，上传到 40% 时移除它：上传被中止，没有 prompt，输入框解锁，没有 400 文案", async () => {
    const created = view(CREATED, null, { temporaryWorkspace: true, workspaceId: TEMP });
    const { fetchMock } = await welcome(turn(created, "", [], [rejectEmpty]));
    await choose(file("a.pdf"));
    await sendFirst();
    await progress(0, 4, 10);
    expect(chips()).toEqual(["a.pdf10 B上传中 40%"]);

    remove("a.pdf");
    await quiesce();
    expect(xhr(0).aborts).toBe(1);
    await expectSettledWithoutError();
    expect(prompts(fetchMock)).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(1);
    expect(area()).toBeNull();
    expect(composer().value).toBe("");
    expect(createRequests(fetchMock)).toHaveLength(1);
  });

  it("草稿为 `看看`、上传中途移除唯一的标签：恰一次 prompt，body 恰为只带文字的那一个键", async () => {
    const created = view(CREATED, null, { temporaryWorkspace: true, workspaceId: TEMP });
    const { fetchMock } = await welcome(turn(created, "看看", []));
    await choose(file("a.pdf"));
    typeDraft("看看");
    await sendFirst();
    await progress(0, 4, 10);

    remove("a.pdf");
    await quiesce();
    expect(xhr(0).aborts).toBe(1);
    expect(prompts(fetchMock)).toEqual(['{"message":"看看"}']);
    expect(alerts()).toEqual([]);
    expect(FakeXhr.instances).toHaveLength(1);
  });
});
