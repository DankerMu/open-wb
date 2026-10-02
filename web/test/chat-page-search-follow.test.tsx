/**
 * Issue 538 对话内搜索 (parent tasks 7.7): S8–S11 and S17 of
 * openspec/changes/conversation-search/design.md — a changing message set under an open search,
 * and jumps against the bottom-follow rules. Seams: the jsdom chat page inside the real shell over a
 * stubbed `fetch` and the fake event source, the scroll metrics and `scrollIntoView` (jsdom has
 * neither layout nor that method), and a bare `FollowTranscript`. Expected values are literals
 * from the spec deltas.
 */
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { goLive } from "./chat-page-file-changes-support.js";
import {
  answered,
  asked,
  bottom,
  CENTER,
  conversation,
  conversationSearchFixture,
  count,
  geometry,
  highlighted,
  installGeometry,
  jumpButton,
  jumps,
  landing,
  openConversation,
  press,
  renderTranscript,
  runningConversation,
  toggleSearch,
  typeQuery,
} from "./chat-page-search-support.js";

const WEEKLY = "周报";

conversationSearchFixture();
beforeEach(installGeometry);

describe("消息集合变化 (S8, S9)", () => {
  it("S8 a streamed match raises the count without moving the current match or the transcript", async () => {
    await openConversation(runningConversation("周报怎么写", "正在写"));
    const send = await goLive();
    expect(geometry.scrollTop).toBe(2500);
    landing.scrollTop = 1200;

    toggleSearch();
    typeQuery(WEEKLY);
    expect([count(), highlighted()]).toEqual(["1/1", ["-3"]]);
    expect(jumps).toEqual([["-3", CENTER]]);
    expect(geometry.scrollTop).toBe(1200);

    geometry.scrollHeight = 3200;
    send("text.delta", { delta: "，周报初稿如下" });
    await screen.findByText("正在写，周报初稿如下");

    expect([count(), highlighted()]).toEqual(["1/2", ["-3"]]);
    expect(jumps).toHaveLength(1);
    expect(geometry.scrollTop).toBe(1200);
  });

  /** `问题`, an answer (id 0) holding `content`, then two more messages that hold 周报. */
  const drafted = (content: string) =>
    conversation([
      asked(-3, "问题"),
      answered(0, content),
      asked(1, "再给一份周报"),
      answered(2, "第二份周报"),
    ]);

  /** The current match (the message 0) stops matching in a reloaded snapshot. */
  async function loseCurrentMatch() {
    const page = await openConversation(drafted("周报初稿"));
    toggleSearch();
    typeQuery(WEEKLY);
    expect([count(), highlighted()]).toEqual(["1/3", ["0"]]);
    expect(jumps).toEqual([["0", CENTER]]);

    await page.reload(drafted("已撤回"));

    expect(screen.getByText("已撤回")).toBeTruthy();
    expect([count(), highlighted()]).toEqual(["0/2", []]);
    expect(jumps).toHaveLength(1);
    return page;
  }

  it("S9 a match appearing before the current one moves its place, not the highlight or the transcript", async () => {
    const page = await openConversation(drafted("无关"));
    toggleSearch();
    typeQuery(WEEKLY);
    expect([count(), highlighted()]).toEqual(["1/2", ["1"]]);
    expect(jumps).toEqual([["1", CENTER]]);

    await page.reload(drafted("周报初稿"));

    expect(screen.getByText("周报初稿")).toBeTruthy();
    expect([count(), highlighted()]).toEqual(["2/3", ["1"]]);
    expect(jumps).toHaveLength(1);
  });

  it("S9 a current match that stopped matching is cleared without scrolling and is not restored when it matches again", async () => {
    const page = await loseCurrentMatch();

    await page.reload(drafted("周报二稿"));

    expect(screen.getByText("周报二稿")).toBeTruthy();
    expect([count(), highlighted()]).toEqual(["0/3", []]);
    expect(jumps).toHaveLength(1);

    press("Enter");

    expect([count(), highlighted()]).toEqual(["1/3", ["0"]]);
    expect(jumps.slice(1)).toEqual([["0", CENTER]]);
  });

  it("S9 Enter without a current match takes the first match", async () => {
    await loseCurrentMatch();

    press("Enter");

    expect([count(), highlighted()]).toEqual(["1/2", ["1"]]);
    expect(jumps.slice(1)).toEqual([["1", CENTER]]);
  });

  it("S9 Shift+Enter without a current match takes the last match", async () => {
    await loseCurrentMatch();

    press("Enter", { shiftKey: true });

    expect([count(), highlighted()]).toEqual(["2/2", ["2"]]);
    expect(jumps.slice(1)).toEqual([["2", CENTER]]);
  });
});

describe("跳转与贴底跟随 (S10, S11, S17)", () => {
  /** A pinned running transcript with the stream live; the last message (id 0) is the only match. */
  async function openPinned() {
    await openConversation(runningConversation("写一份", "周报正在写"));
    const send = await goLive();
    expect(geometry.scrollTop).toBe(2500);
    expect(jumpButton()).toBeNull();
    return send;
  }

  /** Grows the content by 200px, then streams `delta` and waits until it renders. */
  async function growAndStream(send: Awaited<ReturnType<typeof goLive>>, delta: string) {
    geometry.scrollHeight = 3200;
    send("text.delta", { delta });
    await screen.findByText(`周报正在写${delta}`);
  }

  it("S10 a jump away from the bottom unpins at once: 回到最新 shows and a streamed delta does not pull the view back", async () => {
    const send = await openPinned();
    landing.scrollTop = 0;

    toggleSearch();
    typeQuery(WEEKLY);

    expect(jumps).toEqual([["0", CENTER]]);
    expect(geometry.scrollTop).toBe(0);
    expect(jumpButton()).not.toBeNull();

    await growAndStream(send, "，第一段");

    expect(geometry.scrollTop).toBe(0);
    expect(jumpButton()).not.toBeNull();
    expect(highlighted()).toEqual(["0"]);

    // 回到最新 goes back to the bottom and leaves the highlight alone.
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(geometry.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
    expect(highlighted()).toEqual(["0"]);
  });

  it("S11 a jump that lands within 4px of the bottom keeps following", async () => {
    const send = await openPinned();
    landing.scrollTop = 2496;

    toggleSearch();
    typeQuery(WEEKLY);

    expect(jumps).toEqual([["0", CENTER]]);
    expect(geometry.scrollTop).toBe(2496);
    expect(jumpButton()).toBeNull();

    await growAndStream(send, "，第一段");

    expect(bottom()).toBe(2700);
    expect(geometry.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
  });

  it("S11 a jump that lands between 4px and one viewport from the bottom unpins without 回到最新", async () => {
    const send = await openPinned();
    landing.scrollTop = 2300;

    toggleSearch();
    typeQuery(WEEKLY);

    expect(jumps).toEqual([["0", CENTER]]);
    expect(geometry.scrollTop).toBe(2300);
    expect(jumpButton()).toBeNull();

    await growAndStream(send, "，第一段");

    expect(bottom()).toBe(2700);
    expect(geometry.scrollTop).toBe(2300);
    expect(jumpButton()).toBeNull();
  });

  it("S11 a jump back to within 4px of the bottom hides 回到最新 and follows again", async () => {
    const send = await openPinned();
    landing.scrollTop = 0;
    toggleSearch();
    typeQuery(WEEKLY);
    expect(geometry.scrollTop).toBe(0);
    expect(jumpButton()).not.toBeNull();

    landing.scrollTop = 2497;
    press("Enter");

    expect(jumps).toEqual([
      ["0", CENTER],
      ["0", CENTER],
    ]);
    expect(geometry.scrollTop).toBe(2497);
    expect(jumpButton()).toBeNull();

    await growAndStream(send, "，第一段");

    expect(geometry.scrollTop).toBe(2700);
    expect(jumpButton()).toBeNull();
  });

  it("S17 scrollToMessage does nothing for a message the transcript does not hold", () => {
    const jump = renderTranscript();
    expect(geometry.scrollTop).toBe(2500);

    jump(1);
    expect(jumps).toEqual([["1", CENTER]]);
    expect(jumpButton()).toBeNull();

    // Moved without a scroll event: only a recompute would notice and show 回到最新.
    geometry.scrollTop = 0;
    expect(() => jump(999)).not.toThrow();
    // The id 7 exists in the document, outside this transcript.
    jump(7);
    expect(jumps).toHaveLength(1);
    expect(jumpButton()).toBeNull();

    jump(2);
    expect(jumps.slice(1)).toEqual([["2", CENTER]]);
    expect(jumpButton()).not.toBeNull();

    geometry.scrollTop = bottom();
    jump(999);
    expect(jumps).toHaveLength(2);
    expect(jumpButton()).not.toBeNull();
  });
});
