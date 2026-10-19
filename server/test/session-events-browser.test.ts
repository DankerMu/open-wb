/**
 * Issue #1526 chat-stream「纯协议事件归约」 scenario「Browser write becomes a browser step」 at the pure
 * createEventState/applyFrame seam (session-events.test.ts is near its size limit). Frames follow
 * omp v18.0.10's shapes (design Context: `write` to `xd://browser`, `details.xdev.inner`); every
 * expected event is a literal from that scenario.
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 41;
const MARK = "…（已截断）";
const OPEN = '{"action":"open","url":"file:///ws/index.html"}';
const SHOT = '{"action":"run","code":"return await tab.screenshot()"}';
const NO_AUDIT = { action: null, url: null, external: null };

function run(frames: readonly OmpFrame[]): ChatEvent<string>[] {
  let state = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_1" });
  const events: ChatEvent<string>[] = [];
  for (const frame of [{ type: "agent_start" }, ...frames]) {
    const next = applyFrame(state, frame);
    events.push(...next.events);
    state = next.state;
  }
  return events;
}

function start(toolCallId: string, args: unknown): OmpFrame {
  return { type: "tool_execution_start", toolCallId, toolName: "write", args };
}

function browserStart(toolCallId: string, content: unknown, path = "xd://browser"): OmpFrame {
  return start(toolCallId, { path, content });
}

function end(toolCallId: string, result: unknown, isError = false): OmpFrame {
  return { type: "tool_execution_end", toolCallId, toolName: "write", isError, result };
}

function xdevResult(inner: unknown, content: unknown[] = [{ type: "text", text: "ok" }]) {
  return { content, details: { xdev: { tool: "browser", mode: "execute", tier: "exec", inner } } };
}

function stepStarts(events: ChatEvent<string>[]) {
  return events.flatMap((event) => (event.type === "step.start" ? [event.data] : []));
}

describe("Browser write becomes a browser step", () => {
  it("open, a screenshot run and an ordinary write: names, details, browser field, files.changed", () => {
    const shots = [
      {
        dest: "screenshots/screenshot-1.png",
        mimeType: "image/png",
        bytes: 10,
        width: 1,
        height: 1,
      },
    ];
    const notes = { path: "notes.md", content: "hi" };
    const events = run([
      browserStart("b1", OPEN),
      end(
        "b1",
        xdevResult({ action: "open", name: "main", url: "file:///ws/index.html" }, [
          { type: "text", text: "Opened" },
        ]),
      ),
      browserStart("b2", SHOT),
      end(
        "b2",
        xdevResult({ action: "run", screenshots: shots }, [
          { type: "text", text: "shot" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ]),
      ),
      start("w3", notes),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "turn.start", data: { messageId: MESSAGE_ID } },
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "b1",
          name: "browser",
          detail: `浏览器：打开 file:///ws/index.html\n${OPEN}`,
          browser: { action: "open", url: "file:///ws/index.html", external: null },
        },
      },
      {
        type: "step.end",
        data: { messageId: MESSAGE_ID, stepId: "b1", status: "done", output: "Opened" },
      },
    ]);
    const [b2Start, files, b2End, w3] = events.slice(3);
    expect(b2Start).toMatchObject({ type: "step.start", data: { stepId: "b2", name: "browser" } });
    expect(b2Start?.type === "step.start" && b2Start.data.detail.split("\n")[0]).toBe(
      "浏览器：在标签页 main 执行脚本",
    );
    expect(files).toEqual({
      type: "files.changed",
      data: {
        messageId: MESSAGE_ID,
        stepId: "b2",
        files: [
          { path: "screenshots/screenshot-1.png", added: null, removed: null, kind: "write" },
        ],
      },
    });
    expect(b2End).toMatchObject({ type: "step.end", data: { stepId: "b2", status: "done" } });
    expect(b2End?.type === "step.end" && b2End.data.output).toContain("[图片]");
    expect(w3).toEqual({
      type: "step.start",
      data: { messageId: MESSAGE_ID, stepId: "w3", name: "write", detail: JSON.stringify(notes) },
    });
    expect(w3?.type === "step.start" && "browser" in w3.data).toBe(false);
    expect(events).toHaveLength(7);
  });

  it.each([
    [
      "a failed call",
      end("b1", xdevResult({ action: "run", screenshots: [{ dest: "s.png" }] }), true),
      "failed",
    ],
    [
      "details.xdev without inner",
      end("b1", { content: [], details: { xdev: { tool: "browser", mode: "execute" } } }),
      "done",
    ],
    ["inner without screenshots", end("b1", xdevResult({ action: "run" })), "done"],
  ])("%s emits only its step.end and no files.changed", (_name, frame, status) => {
    const events = run([browserStart("b1", SHOT), frame]);
    expect(events.map((event) => event.type)).toEqual(["turn.start", "step.start", "step.end"]);
    expect(events[2]).toMatchObject({ type: "step.end", data: { stepId: "b1", status } });
  });

  it("wrapped path, unparsable and non-string content, and a prototype-only path", () => {
    const cut = { path: "xd://browser", content: '{"action":"run","code":"x' };
    const seven = { path: "xd://browser", content: 7 };
    const inherited = Object.assign(Object.create({ path: "xd://browser" }), { content: OPEN });
    const starts = stepStarts(
      run([
        browserStart("c1", '{"action":"close","all":true}', "[xd://browser]"),
        start("c2", cut),
        start("c3", seven),
        start("c4", inherited),
      ]),
    );
    expect(starts[0]).toMatchObject({ name: "browser" });
    expect(starts[0]?.detail.split("\n")[0]).toBe("浏览器：关闭全部标签页");
    expect(starts.slice(1)).toEqual([
      {
        messageId: MESSAGE_ID,
        stepId: "c2",
        name: "browser",
        detail: `浏览器操作\n${JSON.stringify(cut)}`,
        browser: NO_AUDIT,
      },
      {
        messageId: MESSAGE_ID,
        stepId: "c3",
        name: "browser",
        detail: `浏览器操作\n${JSON.stringify(seven)}`,
        browser: NO_AUDIT,
      },
      {
        messageId: MESSAGE_ID,
        stepId: "c4",
        name: "write",
        detail: JSON.stringify({ content: OPEN }),
      },
    ]);
    expect("browser" in (starts[3] ?? {})).toBe(false);
  });

  it("a 5000-x url: the capped summary, then the flag line; the browser field keeps the url", () => {
    const url = `https://a/${"x".repeat(5000)}`;
    const content = JSON.stringify({ action: "open", url, app: { path: "/bin/sh" } });
    const [step] = stepStarts(run([browserStart("u1", content)]));
    const lines = step?.detail.split("\n") ?? [];
    expect(lines.slice(0, 2)).toEqual([
      `浏览器：打开 https://a/${"x".repeat(190)}…`,
      "⚠ 启动外部程序：/bin/sh",
    ]);
    expect(step?.detail.endsWith(MARK)).toBe(true);
    expect(step?.browser).toEqual({ action: "open", url, external: { path: "/bin/sh" } });
  });

  it("a long run is capped at 4096 code points while its browser field keeps the external program", () => {
    const content = JSON.stringify({
      action: "run",
      code: "𝒳".repeat(5000),
      app: { path: "/bin/sh" },
    });
    const [step] = stepStarts(run([browserStart("b9", content)]));
    const full = `浏览器：在标签页 main 执行脚本\n⚠ 启动外部程序：/bin/sh\n${content}`;
    expect(step?.detail).toBe(Array.from(full).slice(0, 4096).join("") + MARK);
    expect(step).toMatchObject({
      name: "browser",
      browser: { action: "run", url: null, external: { path: "/bin/sh" } },
    });
  });
});
