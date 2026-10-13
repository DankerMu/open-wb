// 欢迎态首次发送的整页用例共用的夹具：欢迎态挂载、新会话的 prompt 与历史路由、对上传与 prompt 请求的查询。
import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, sessionPromptPath } from "./chat-page-lifecycle-support.js";
import { promptAccepted } from "./chat-page-ownership-support.js";
import { messagesPath, type SessionView } from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  HERO,
  PROJECT_A,
  promptRequests,
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
import { installFakeXhr } from "./upload-support.js";

export const W = PROJECT_A.id;
export const CREATED = `${CREATED_IDS[0]}`;
export const OPTIONS = { ...DEFAULT_COMPOSER_OPTIONS, upload: { maxBytes: 1000, maxFiles: 3 } };
export const EMPTY = "还没有消息，发一条开始吧";

export type Welcome = NonNullable<Parameters<typeof welcomeRoutes>[0]>;

/** 欢迎态，上限为每条消息 3 个、每个 1000 字节；新会话的 prompt 缺省挂起。 */
export async function welcome(extra: FetchRoutes = {}, fixture: Welcome = {}) {
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
export function turn(
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

export function uploadOf(workspaceId: string, name: string) {
  return [["POST", `/api/workspaces/${workspaceId}/uploads?name=${encodeURIComponent(name)}`]];
}

export function prompts(fetchMock: FetchMock) {
  return promptRequests(fetchMock, CREATED).map(([, body]) => body);
}

export function historyReads(fetchMock: FetchMock) {
  return calls(fetchMock, messagesPath(CREATED)).length;
}

/** 发送并等到会话建出、URL 选中它。 */
export async function sendFirst() {
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
  await quiesce();
}
