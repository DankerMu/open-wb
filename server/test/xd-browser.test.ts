/**
 * Issue #1526 (omp-browser-integration design D5) pure `xd://browser` module: browser-runtime
 * 「浏览器操作的可读描述」 scenarios 设备路径判定 / 各类操作的摘要 / 带 hashline 行号前缀的参数 / 越界形态的标志行.
 * Every expected value is a literal copied from that spec delta, not derived from production code.
 */
import { describe, expect, it } from "vitest";
import {
  browserAuditFields,
  browserFlags,
  browserSummary,
  isBrowserDevicePath,
  parseBrowserContent,
} from "../src/sessions/omp/xd-browser.js";

/** Summary line, flag lines and audit fields of one parameter text. */
function describeText(text: unknown) {
  const call = parseBrowserContent(text);
  return {
    summary: browserSummary(call),
    flags: browserFlags(call),
    audit: browserAuditFields(call),
  };
}

const NO_AUDIT = { action: null, url: null, external: null };

describe("设备路径判定 (omp v18.0.10 write → xd:// dispatch)", () => {
  it.each([
    ["xd://browser", true],
    ["XD://browser", true],
    ["[xd://browser]", true],
    ["[xd://browser#0a1B]", true],
    ["xd://browser ", true],
    ["xd://Browser", false],
    ["xd://browser2", false],
    ["[xd://browser#XYZ1]", false],
    ["notes/xd://browser", false],
    ["xd://browser/x", false],
  ])("first group %j → %s", (path, expected) => {
    expect(isBrowserDevicePath(path)).toBe(expected);
  });

  it.each([
    "xd://bro\twser",
    "xd://browser\n",
    "[xd://brow\rser]",
    "xd://browser\u0001",
    "[xd://browser\u001f]",
  ])(
    "tabs, newlines and trailing C0 controls the URL serialiser drops: %j is the browser",
    (path) => {
      expect(isBrowserDevicePath(path)).toBe(true);
    },
  );

  it.each([
    " xd://browser",
    "\txd://browser",
    "\u0000xd://browser",
    " [xd://browser]",
    "xd://browser ",
  ])("leading whitespace or control, trailing Unicode space: %j is not the browser", (path) => {
    expect(isBrowserDevicePath(path)).toBe(false);
  });

  it.each([
    ["xd://browser:", true],
    ["xd://@browser", true],
    ["xd://:@browser", true],
    ["[xd://browser:]", true],
    ["xd://browser/", false],
    ["xd://browser:80", false],
  ])("empty port and empty userinfo serialise away: %j → %s", (path, expected) => {
    expect(isBrowserDevicePath(path)).toBe(expected);
  });
});

describe("各类操作的摘要", () => {
  it.each([
    ['{"action":"open","url":"https://example.com"}', "浏览器：打开 https://example.com"],
    ['{"action":"open","name":"b"}', "浏览器：打开标签页 b"],
    ['{"action":"open","url":""}', "浏览器：打开标签页 main"],
    ['{"action":"run","code":"1"}', "浏览器：在标签页 main 执行脚本"],
    ['{"action":"close","name":"b","kill":true}', "浏览器：关闭标签页 b并结束外部浏览器"],
    ['{"action":"close","all":true}', "浏览器：关闭全部标签页"],
    ['{"action":"help"}', "浏览器：help"],
    ['{"action":""}', "浏览器操作"],
    ["[1]", "浏览器操作"],
    ["not json", "浏览器操作"],
  ])("%s → %s, without flag lines", (text, summary) => {
    const described = describeText(text);
    expect(described.summary).toBe(summary);
    expect(described.flags).toEqual([]);
  });

  it("an empty url is absent; the last three parse failures audit as three nulls", () => {
    expect(describeText('{"action":"open","url":""}').audit).toEqual({
      action: "open",
      url: null,
      external: null,
    });
    for (const text of ['{"action":""}', "[1]", "not json"]) {
      expect(describeText(text).audit).toEqual(NO_AUDIT);
    }
  });

  it("a value that is not a string fails like unparsable text", () => {
    expect(parseBrowserContent(7)).toBeUndefined();
    expect(describeText(7)).toEqual({ summary: "浏览器操作", flags: [], audit: NO_AUDIT });
  });

  it("close all with kill also ends the external browser", () => {
    expect(describeText('{"action":"close","all":true,"kill":true}').summary).toBe(
      "浏览器：关闭全部标签页并结束外部浏览器",
    );
  });
});

describe("带 hashline 行号前缀的参数 (omp stripWriteContent)", () => {
  it("one prefixed line: summary, one flag line, external path", () => {
    expect(describeText('1:{"action":"open","url":"https://a","app":{"path":"/bin/sh"}}')).toEqual({
      summary: "浏览器：打开 https://a",
      flags: ["⚠ 启动外部程序：/bin/sh"],
      audit: { action: "open", url: "https://a", external: { path: "/bin/sh" } },
    });
  });

  it("two prefixed lines", () => {
    expect(describeText('1:{"action":"run",\n2:"code":"1"}').summary).toBe(
      "浏览器：在标签页 main 执行脚本",
    );
  });

  it("a strict [path#XXXX] header line is dropped with the prefixes", () => {
    expect(describeText('[a.json#0A1B]\n1:{"action":"open",\n2:"url":"https://a"}').summary).toBe(
      "浏览器：打开 https://a",
    );
  });

  it("a loose header (not four hex digits) falls back: drop it, then strip", () => {
    expect(describeText('[a.json#zz]\n1:{"action":"open",\n2:"url":"https://a"}').summary).toBe(
      "浏览器：打开 https://a",
    );
  });

  it("a content line without a prefix stops the strip: the parse fails", () => {
    const described = describeText('1:{"action":"open",\n"url":"https://a"}');
    expect(described).toEqual({ summary: "浏览器操作", flags: [], audit: NO_AUDIT });
  });
});

describe("越界形态的标志行", () => {
  it("path with args, cdp_url and relay: three flag lines in order and the full external", () => {
    const text =
      '{"action":"open","url":"https://a","app":{"path":"/bin/sh","args":["-c","id"],' +
      '"cdp_url":"http://10.0.0.5:9222","relay":true}}';
    expect(describeText(text)).toEqual({
      summary: "浏览器：打开 https://a",
      flags: [
        '⚠ 启动外部程序：/bin/sh 参数 ["-c","id"]',
        "⚠ 连接外部浏览器：http://10.0.0.5:9222",
        "⚠ 经中继连接用户自己的浏览器",
      ],
      audit: {
        action: "open",
        url: "https://a",
        external: {
          path: "/bin/sh",
          args: ["-c", "id"],
          cdpUrl: "http://10.0.0.5:9222",
          relay: true,
        },
      },
    });
  });

  it("fields of the wrong type are absent: no flag line, external null", () => {
    const described = describeText(
      '{"action":"open","url":"https://a","app":{"path":"","relay":"yes","args":[1]}}',
    );
    expect(described.flags).toEqual([]);
    expect(described.audit.external).toBeNull();
  });

  it("a newline inside a string value becomes a space, so each line stays one line", () => {
    expect(describeText('{"action":"open","url":"https://a\\nb"}').summary).toBe(
      "浏览器：打开 https://a b",
    );
    const flags = describeText(
      '{"action":"run","app":{"path":"/x\\r\\u2028y","cdp_url":"ws://h\\u2029z"}}',
    ).flags;
    expect(flags).toEqual(["⚠ 启动外部程序：/x  y", "⚠ 连接外部浏览器：ws://h z"]);
  });

  it("only own properties are read", () => {
    const call = parseBrowserContent('{"action":"open","__proto__":{"url":"https://x"}}');
    expect(browserSummary(call)).toBe("浏览器：打开标签页 main");
  });
});
