import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";
import {
  blockBody,
  COLOR_LITERAL_PATTERNS,
  readRepoFile,
  ruleBody,
  stripComments,
} from "./ui-support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const BASH_START = '{"command":"echo workbuddy-smoke"}';
const BASH_END = '{"output":"workbuddy-smoke"}';
const READ_START = "plain line\nsecond";
const SANDBOX_PATH = "/srv/workbuddy/sandbox/u1/demo/a.md";
const SANDBOX_DETAIL = `{"path":"${SANDBOX_PATH}"}`;

afterEach(() => {
  cleanupChatPage();
});

function mountRunningSteps() {
  const snapshot: ChatMessageSnapshot = chatSnapshot({
    content: "处理中",
    assistantStatus: "running",
    steps: [
      { id: 11, ordinal: 0, name: "bash", detail: BASH_START, status: "running" },
      { id: 12, ordinal: 1, name: "read", detail: READ_START, status: "running" },
    ],
    cursor: { epoch: 1, seq: 3 },
  });
  return renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
  });
}

function hasIcon(root: HTMLElement, name: string): boolean {
  return [...root.querySelectorAll("svg")].some((svg) => svg.classList.contains(`lucide-${name}`));
}

describe("(S2) step cards render icon, Chinese badge, summary and collapsed raw detail", () => {
  it("shows the running cards and swaps badge/summary when steps end", async () => {
    mountRunningSteps();
    const bash = await screen.findByRole("region", { name: "bash" });
    expect(hasIcon(bash, "terminal")).toBe(true);
    expect(bash.querySelector("strong")?.textContent).toBe("bash");
    const bashBadge = within(bash).getByRole("status", { name: "bash 运行中" });
    expect(bashBadge.textContent).toBe("运行中");
    expect(bashBadge.className).toContain("ui-pulse");
    expect(bash.querySelector("p.chat-step-line")?.textContent).toBe(
      "command: echo workbuddy-smoke",
    );
    const disclosure = bash.querySelector("details.chat-step-disclosure") as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toBe("原始输出");
    expect(disclosure.querySelector("pre.chat-step-detail")?.textContent).toBe(BASH_START);

    const read = screen.getByRole("region", { name: "read" });
    expect(hasIcon(read, "wrench")).toBe(true);
    expect(hasIcon(read, "terminal")).toBe(false);
    expect(within(read).getByRole("status", { name: "read 运行中" }).textContent).toBe("运行中");
    expect(read.querySelector("p.chat-step-line")?.textContent).toBe("plain line");
    expect(read.querySelector("pre.chat-step-detail")?.textContent).toBe(READ_START);

    await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
    const source = latestSource();
    act(() => {
      source.emitOpen();
      source.emitData("step.end", "1:4", {
        messageId: 0,
        stepId: 11,
        status: "done",
        detail: BASH_END,
      });
      source.emitData("step.end", "1:5", {
        messageId: 0,
        stepId: 12,
        status: "failed",
        detail: "",
      });
    });

    const doneBadge = await within(bash).findByRole("status", { name: "bash 已完成" });
    expect(doneBadge.textContent).toBe("已完成");
    expect(doneBadge.className).not.toContain("ui-pulse");
    expect(bash.querySelector("p.chat-step-line")?.textContent).toBe("output: workbuddy-smoke");
    expect(bash.querySelector("pre.chat-step-detail")?.textContent).toBe(BASH_END);

    expect(within(read).getByRole("status", { name: "read 失败" }).textContent).toBe("失败");
    expect(read.querySelector(".chat-step-line")).toBeNull();
    expect(read.querySelector("details")).toBeNull();
    expect(screen.queryByRole("status", { name: /running|done|failed/ })).toBeNull();
  });

  it("styles the step cards from semantic tokens in the split messages.css", () => {
    const messagesRaw = readRepoFile("web/src/features/chat/messages.css");
    const messages = stripComments(messagesRaw);
    expect(ruleBody(messages, ".chat-step-status-done")).toContain("var(--wb-status-success-text)");
    for (const pattern of COLOR_LITERAL_PATTERNS) {
      expect(messagesRaw).not.toMatch(pattern);
    }
    expect(messagesRaw).not.toContain("--wb-palette");
    expect(blockBody(messages, /@media \(max-width: 760px\) \{/)).toContain(".chat-msg-user");

    const chatRaw = readRepoFile("web/src/features/chat/chat.css");
    expect(chatRaw.split("\n").length).toBeLessThanOrEqual(800);
    const chat = stripComments(chatRaw);
    for (const moved of [".chat-step", ".chat-md", ".chat-msg-"]) {
      expect(chat).not.toContain(moved);
    }

    const styles = readRepoFile("web/src/styles.css");
    const chatImport = styles.indexOf('@import "./features/chat/chat.css";');
    const messagesImport = styles.indexOf('@import "./features/chat/messages.css";');
    expect(chatImport).toBeGreaterThanOrEqual(0);
    expect(messagesImport).toBeGreaterThan(chatImport);
  });
});

describe("step cards keep absolute sandbox paths verbatim (ADR-0011)", () => {
  it("shows the absolute path unchanged in the summary line and the 原始输出 details", async () => {
    const snapshot: ChatMessageSnapshot = chatSnapshot({
      status: "done",
      content: "读完了",
      assistantStatus: "done",
      steps: [{ id: 21, ordinal: 0, name: "read", detail: SANDBOX_DETAIL, status: "done" }],
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [messagesPath]: () => jsonResponse(snapshot),
    });

    const read = await screen.findByRole("region", { name: "read" });
    expect(within(read).getByRole("status", { name: "read 已完成" }).textContent).toBe("已完成");
    expect(read.querySelector("p.chat-step-line")?.textContent).toBe(`path: ${SANDBOX_PATH}`);
    const disclosure = read.querySelector("details.chat-step-disclosure") as HTMLDetailsElement;
    expect(disclosure.querySelector("summary")?.textContent).toBe("原始输出");
    expect(disclosure.textContent).toContain(SANDBOX_PATH);
    expect(disclosure.querySelector("pre.chat-step-detail")?.textContent).toBe(SANDBOX_DETAIL);
  });
});

describe("(S3) ui-walk locates steps by the Chinese badge and the Markdown body", () => {
  it("uses Chinese badge names, the .chat-md body and the split gate module", () => {
    const walk = readRepoFile("web/e2e/ui-walk.spec.ts");
    expect(walk).toContain('name: "bash 已完成"');
    expect(walk).toContain('name: "bash 运行中"');
    expect(walk).not.toContain('"bash done"');
    expect(walk).not.toContain('"bash running"');
    expect(walk).not.toContain('assistant.locator("p")');
    expect(walk.split("\n").length).toBeLessThanOrEqual(800);
    expect(walk).toMatch(/from "\.\/ui-walk-gate\.js";/);
  });
});
