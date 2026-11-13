// 用户气泡中的知识库引用（message-attachments「用户气泡中的知识库引用」场景「受理后与刷新后一致」；s2c-kb-session
// 任务 8.3）：受理后重装的快照与重新打开会话的快照给出同一份引用，气泡在文本下方列出它们，纯文本、不进气泡文本。
// seam：整页挂载 + 假 API。期望的可访问名与文本取自规格条文。
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  exchange,
  kbRoutes,
  mountSelected,
  PRODUCT,
  refer,
  SA,
  SB,
  TAGS,
  tagArea,
} from "./chat-kb-ref-support.js";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  cleanupSessionMeta,
  messagesPath,
  mountSessions,
} from "./chat-page-session-meta-support.js";
import { jsonResponse } from "./support.js";

afterEach(cleanupSessionMeta);

const REF = { id: PRODUCT.id, name: PRODUCT.name };

function userArticles() {
  return screen.getAllByRole("article", { name: "用户" });
}

/** 气泡里 `引用的知识库` 列表各项的文字；没有该列表时为 null。 */
function bubbleRefs(article: HTMLElement) {
  const list = within(article).queryByRole("list", { name: TAGS });
  return list === null
    ? null
    : within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
}

/** 唯一一条引用了 `产品文档` 的 `查一下`：列表在气泡内、文本之后，项是纯文本，气泡文本不含引用说明。 */
function expectReferencedBubble(article: HTMLElement) {
  expect(bubbleRefs(article)).toEqual(["产品文档"]);
  const bubble = article.querySelector<HTMLElement>('[data-slot="message-bubble"]') as HTMLElement;
  const list = within(article).getByRole("list", { name: TAGS });
  expect(bubble.contains(list)).toBe(true);
  const body = bubble.querySelector('[data-slot="message-body"]') as HTMLElement;
  expect(body.textContent).toBe("查一下");
  expect(body.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(list).queryByRole("button")).toBeNull();
  expect(within(list).queryByRole("link")).toBeNull();
  expect(article.textContent).not.toContain("kb_search");
}

describe("受理后与刷新后一致", () => {
  it("受理后重装的快照与重新打开会话的快照都给出一项 `产品文档`；助手消息与无引用的用户消息没有该列表", async () => {
    await mountSelected();
    await refer("产品文档");
    typeDraft("查一下");
    clickSend();
    await waitFor(() => expect(tagArea()).toBeNull());
    const [accepted] = userArticles();
    expectReferencedBubble(accepted as HTMLElement);
    const assistant = screen.getByRole("article", { name: "助手" });
    expect(bubbleRefs(assistant)).toBeNull();

    // 刷新：重新挂载页面，历史直接来自快照（另带一轮没有引用的问答）。
    cleanup();
    const history = [...exchange("查一下", [REF]), ...exchange("再问", [], 3)];
    mountSessions(`/?session=${A}`, [SA, SB], {
      ...kbRoutes(),
      [messagesPath(A)]: () =>
        jsonResponse({
          session: SA,
          messages: history,
          streamCursor: { epoch: 1, seq: 0 },
          todo: null,
        }),
      [messagesPath(B)]: () =>
        jsonResponse({ session: SB, messages: [], streamCursor: { epoch: 1, seq: 0 }, todo: null }),
    });
    await waitFor(() => expect(userArticles()).toHaveLength(2));
    const [first, second] = userArticles();
    expectReferencedBubble(first as HTMLElement);
    expect(bubbleRefs(second as HTMLElement)).toBeNull();
    for (const assistant of screen.getAllByRole("article", { name: "助手" })) {
      expect(bubbleRefs(assistant)).toBeNull();
    }
  });
});
