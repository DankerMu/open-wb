/**
 * Issue #367 step args/output split at applyFrame: result normalization, 4096-codepoint caps,
 * failure source and hostile result shapes. Expected strings are built from fixture literals.
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 7;
const MARK = "…（已截断）";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Starts one bash call with `args`, then ends it with `end` extras; returns both step events. */
function runStep(args: unknown, end: Record<string, unknown> = {}): ChatEvent<string>[] {
  const events: ChatEvent<string>[] = [];
  let state = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_7" });
  const frames: OmpFrame[] = [
    { type: "agent_start" },
    { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args },
    { type: "tool_execution_end", toolCallId: "call", toolName: "bash", ...end },
  ];
  for (const frame of frames) {
    const next = applyFrame(state, frame);
    events.push(...next.events);
    state = next.state;
  }
  return events.slice(1);
}

function detailOf(args: unknown): string {
  const start = runStep(args)[0];
  if (start?.type !== "step.start") {
    throw new Error("expected step.start");
  }
  return start.data.detail;
}

function endOf(end: Record<string, unknown>): { status: string; output: string } {
  const last = runStep({ command: "x" }, end)[1];
  if (last?.type !== "step.end") {
    throw new Error("expected step.end");
  }
  expect(Object.keys(last.data).sort()).toEqual(["messageId", "output", "status", "stepId"]);
  return { status: last.data.status, output: last.data.output };
}

function outputOf(result: unknown): string {
  return endOf({ result }).output;
}

describe("step output normalization (#367 D2)", () => {
  it.each([
    ["absent result", {}, ""],
    ["null result", { result: null }, ""],
    ["undefined result", { result: undefined }, ""],
    ["string result kept as is", { result: "line 1\nline 2" }, "line 1\nline 2"],
    [
      "non-content object as compact JSON",
      { result: { stdout: "ok\n", code: 0 } },
      '{"stdout":"ok\\n","code":0}',
    ],
    ["number as compact JSON", { result: 42 }, "42"],
    ["array as compact JSON", { result: ["a", 1] }, '["a",1]'],
    [
      "image block as placeholder only",
      { result: { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] } },
      "[图片]",
    ],
    [
      "text blocks keep newlines and drop details/providerMetadata/isError/useless",
      {
        result: {
          content: [
            { type: "text", text: "first\nsecond" },
            { type: "text", text: "third\u2028" },
          ],
          details: { exitCode: 0, secret: "d" },
          providerMetadata: { id: "p" },
          isError: true,
          useless: "u",
        },
      },
      "first\nsecond\nthird\u2028",
    ],
    ["empty content array", { result: { content: [] } }, ""],
  ])("%s", (_name, end, expected) => {
    expect(endOf(end).output).toBe(expected);
  });

  it("uses frame isError alone for failed, ignoring result.isError", () => {
    expect(endOf({ result: "boom", isError: true })).toEqual({ status: "failed", output: "boom" });
    expect(endOf({ result: { content: [{ type: "text", text: "ok" }], isError: true } })).toEqual({
      status: "done",
      output: "ok",
    });
    expect(endOf({ result: "ok", isError: "true" })).toEqual({ status: "done", output: "ok" });
  });

  it("never throws on hostile result shapes and skips unusable blocks", () => {
    expect(outputOf({ content: "not an array" })).toBe('{"content":"not an array"}');
    expect(outputOf({ content: { 0: { type: "text", text: "x" } } })).toBe(
      '{"content":{"0":{"type":"text","text":"x"}}}',
    );
    expect(
      outputOf({
        content: [
          null,
          7,
          "text",
          true,
          ["nested"],
          { type: "text", text: 5 },
          { type: "text" },
          { type: "audio", data: "QUJD" },
          { text: "no type" },
          { type: "text", text: "kept" },
        ],
      }),
    ).toBe("kept");
    const inherited = Object.create({ content: [{ type: "text", text: "proto" }] }) as object;
    expect(outputOf(inherited)).toBe("{}");
    const protoKeys = JSON.parse(
      '{"__proto__":{"content":[{"type":"text","text":"polluted"}]},"constructor":1,"content":[{"type":"text","text":"own","__proto__":{"type":"image"}}]}',
    ) as unknown;
    expect(outputOf(protoKeys)).toBe("own");
    expect(({} as { content?: unknown }).content).toBeUndefined();
  });
});

describe("step detail and output caps (#367 D3)", () => {
  it("keeps exactly 4096 codepoints whole and cuts 4097 with the marker", () => {
    const whole = { k: "a".repeat(4088) };
    expect(detailOf(whole)).toBe(`{"k":"${"a".repeat(4088)}"}`);
    expect([...detailOf(whole)]).toHaveLength(4096);
    expect(detailOf({ k: "a".repeat(4089) })).toBe(`{"k":"${"a".repeat(4089)}"${MARK}`);

    expect(outputOf("d".repeat(4096))).toBe("d".repeat(4096));
    expect(outputOf("c".repeat(4097))).toBe(`${"c".repeat(4096)}${MARK}`);
    expect(
      outputOf({
        content: [
          { type: "text", text: "x".repeat(4096) },
          { type: "text", text: "y" },
        ],
      }),
    ).toBe(`${"x".repeat(4096)}${MARK}`);
  });

  it("counts astral characters as one codepoint and never leaves a lone surrogate at the cut", () => {
    const detail = detailOf({ k: `${"a".repeat(4089)}𝄞z` });
    expect(detail).toBe(`{"k":"${"a".repeat(4089)}𝄞${MARK}`);
    expect(LONE_SURROGATE.test(detail)).toBe(false);

    const output = outputOf(`${"b".repeat(4095)}😀tail`);
    expect(output).toBe(`${"b".repeat(4095)}😀${MARK}`);
    expect(LONE_SURROGATE.test(output)).toBe(false);

    const allAstral = outputOf("😀".repeat(4097));
    expect(allAstral).toBe(`${"😀".repeat(4096)}${MARK}`);
    expect(LONE_SURROGATE.test(allAstral)).toBe(false);
  });

  it("keeps detail single-line with U+2028/U+2029 escaped while output keeps its line breaks", () => {
    const detail = detailOf({ note: "a\u2028b\u2029c\nd" });
    expect(detail).toBe('{"note":"a\\u2028b\\u2029c\\nd"}');
    expect(/[\n\r\u2028\u2029]/.test(detail)).toBe(false);
    expect(outputOf({ content: [{ type: "text", text: "a\nb\r\nc\u2029" }] })).toBe(
      "a\nb\r\nc\u2029",
    );
  });
});
