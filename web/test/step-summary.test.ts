import { describe, expect, it } from "vitest";
import { summarizeStepDetail } from "../src/features/chat/step-summary.js";

const CASES: readonly (readonly [string, string, string])[] = [
  ["empty detail", "", ""],
  ["whitespace-only detail", "   \n  ", ""],
  [
    "first key of a JSON object",
    '{"command":"echo workbuddy-smoke"}',
    "command: echo workbuddy-smoke",
  ],
  ["first key of a path args object", '{"path":"README.md"}', "path: README.md"],
  [
    "server-truncated args are no longer JSON and fall back to the first line",
    '{"command":"echo hi…（已截断）',
    '{"command":"echo hi…（已截断）',
  ],
  ["text wins over the first key", '{"a":1,"text":"hello"}', "hello"],
  [
    "blank text is skipped for the first line of content",
    JSON.stringify({ text: "  ", content: "c1\nc2" }),
    "c1",
  ],
  ["text wins over content regardless of key order", '{"content":"c","text":"t"}', "t"],
  ["non-string content falls back to the first key", '{"content":["x"]}', 'content: ["x"]'],
  ["non-string first value is JSON-encoded", '{"n":{"k":true}}', 'n: {"k":true}'],
  ["empty object", "{}", ""],
  ["JSON array is treated as text", '[{"text":"x"}]', '[{"text":"x"}]'],
  ["JSON number is treated as text", "42", "42"],
  ["JSON string is treated as text", '"quoted"', '"quoted"'],
  ["JSON null is treated as text", "null", "null"],
  ["first non-empty line, trimmed", "\n\n  first line  \nsecond", "first line"],
  ["invalid JSON is treated as text", "{not json", "{not json"],
  ["long text is cut to 120 code points", "x".repeat(200), "x".repeat(120)],
  ["astral characters are cut by code point", "😀".repeat(130), "😀".repeat(120)],
  ["CJK text field is cut by code point", `{"text":"${"字".repeat(130)}"}`, "字".repeat(120)],
];

describe("(S1) summarizeStepDetail", () => {
  it.each(CASES)("%s", (_name, input, expected) => {
    expect(summarizeStepDetail(input)).toBe(expected);
  });

  it("keeps surrogate pairs whole when truncating", () => {
    const summary = summarizeStepDetail("😀".repeat(130));
    expect(summary.length).toBe(240);
    expect(Array.from(summary)).toHaveLength(120);
  });
});
