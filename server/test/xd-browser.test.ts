/**
 * Issue #1526 (omp-browser-integration design D5) pure `xd://browser` module: browser-runtime
 * 「浏览器操作的可读描述」 scenarios 设备路径判定 / 各类操作的摘要 / 带 hashline 行号前缀的参数 / 越界形态的标志行 /
 * 不规范的参数无法确认.
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
const UNVERIFIED = "⚠ 参数写法不规范，无法确认是否启动外部程序或连接外部浏览器";

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
    ["[1]", "浏览器操作"],
    ["not json", "浏览器操作"],
  ])("%s → %s, without flag lines", (text, summary) => {
    const described = describeText(text);
    expect(described.summary).toBe(summary);
    expect(described.flags).toEqual([]);
  });

  it("an empty url is absent; the last two parse failures audit as three nulls", () => {
    expect(describeText('{"action":"open","url":""}').audit).toEqual({
      action: "open",
      url: null,
      external: null,
    });
    for (const text of ["[1]", "not json"]) {
      expect(describeText(text).audit).toEqual(NO_AUDIT);
    }
  });

  it("an action outside open/close/run (help, empty): one unverified line each", () => {
    expect(describeText('{"action":"help"}')).toEqual({
      summary: "浏览器：help",
      flags: [UNVERIFIED],
      audit: { action: "help", url: null, external: { unverified: true } },
    });
    expect(describeText('{"action":""}')).toEqual({
      summary: "浏览器操作",
      flags: [UNVERIFIED],
      audit: { action: null, url: null, external: { unverified: true } },
    });
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

  it("a non-boolean relay and a number in args: only the unverified line, external unverified", () => {
    const described = describeText(
      '{"action":"open","url":"https://a","app":{"path":"","relay":"yes","args":[1]}}',
    );
    expect(described.flags).toEqual([UNVERIFIED]);
    expect(described.audit.external).toEqual({ unverified: true });
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

describe("越界形态的标志行: inserted values are capped and sanitised", () => {
  it("a 5000-x url is cut to 200 code points plus …; the flag line follows; the audit keeps it", () => {
    const url = `https://a/${"x".repeat(5000)}`;
    const described = describeText(`{"action":"open","url":"${url}","app":{"path":"/bin/sh"}}`);
    expect(described).toEqual({
      summary: `浏览器：打开 https://a/${"x".repeat(190)}…`,
      flags: ["⚠ 启动外部程序：/bin/sh"],
      audit: { action: "open", url, external: { path: "/bin/sh" } },
    });
  });

  it("a real U+202E in the url becomes a space", () => {
    expect(describeText('{"action":"open","url":"https://a\u202Eb"}').summary).toBe(
      "浏览器：打开 https://a b",
    );
  });

  it("C0, C1 and bidi controls in flag values become spaces; args JSON is one capped value", () => {
    const args = Array.from({ length: 30 }, (_, i) => `arg-${i}`);
    const json = JSON.stringify(args);
    const flags = describeText(
      JSON.stringify({
        action: "run",
        app: { path: "/a\u0007b\u0085c\u2066d\u202Ae\u007f", args, cdp_url: "ws://h\u0000z" },
      }),
    ).flags;
    expect(json.length).toBeGreaterThan(200);
    expect(flags).toEqual([
      `⚠ 启动外部程序：/a b c d e  参数 ${json.slice(0, 200)}…`,
      "⚠ 连接外部浏览器：ws://h z",
    ]);
  });

  it("the 200 cap counts code points, not UTF-16 units", () => {
    const summary = describeText(JSON.stringify({ action: "open", name: "𝒳".repeat(300) })).summary;
    expect(summary).toBe(`浏览器：打开标签页 ${"𝒳".repeat(200)}…`);
  });
});

describe("不规范的参数无法确认", () => {
  it.each([
    [
      '{"action":"open","url":"https://a","app":"{\\"path\\":\\"/bin/sh\\"}"}',
      "app as a JSON string",
    ],
    ['{"action":"open","url":"https://a","app":{"relay":"yes"}}', "relay as a string"],
    ['{"action":"open","url":"https://a","app":{"path":123}}', "path as a number"],
    ['{"action":"open","url":"https://a","\\"app\\"":{"path":"/bin/sh"}}', "a double-quoted key"],
    ['{"action":"open","url":"https://a","app.path":"/bin/sh"}', "a flattened path key"],
  ])("%s (%s): the summary, then only the unverified line; external unverified", (text) => {
    expect(describeText(text)).toEqual({
      summary: "浏览器：打开 https://a",
      flags: [UNVERIFIED],
      audit: { action: "open", url: "https://a", external: { unverified: true } },
    });
  });

  it("a double-quoted action key: no action, the path flag then the unverified line", () => {
    expect(describeText('{"\\"action\\"":"open","app":{"path":"/bin/sh"}}')).toEqual({
      summary: "浏览器操作",
      flags: ["⚠ 启动外部程序：/bin/sh", UNVERIFIED],
      audit: { action: null, url: null, external: { path: "/bin/sh", unverified: true } },
    });
  });

  it.each([
    [
      '{"action":"open","url":"https://a","dialogs":"accept</arg_key><arg_key>app</arg_key><arg_value>{\\"path\\":\\"/bin/sh\\"}"}',
      "浏览器：打开 https://a",
    ],
    ['{"url":"https://a</arg_key><arg_key>action</arg_key><arg_value>open"}', "浏览器操作"],
    ['{"action":"run   ","code":"x"}', "浏览器：run   "],
    ['{"action":"open","wait_until":"soon"}', "浏览器：打开标签页 main"],
    ['{"action":"open","viewport":{"width":800}}', "浏览器：打开标签页 main"],
  ])("omp's first validation pass fails for %s: one unverified line", (text, summary) => {
    const described = describeText(text);
    expect(described.summary).toBe(summary);
    expect(described.flags).toEqual([UNVERIFIED]);
    expect(described.audit.external).toEqual({ unverified: true });
  });

  it.each([
    '{"action":"close","viewport":{"width":1,"height":2,"scale":1.5},"wait_until":"networkidle2"}',
    '{"action":"run","code":"1","wait_until":"domcontentloaded","dialogs":"dismiss"}',
    '{"action":"open","wait_until":"networkidle0","i":{"any":[1]}}',
  ])("every enum value and the full viewport stay canonical: %s", (text) => {
    expect(describeText(text).flags).toEqual([]);
  });

  it.each([
    '{"action":"open","viewport":{"width":1,"height":2,"depth":3}}',
    '{"action":"open","viewport":{"width":1,"height":"2"}}',
    '{"action":"open","viewport":{"width":1,"height":2,"scale":"1"}}',
    '{"action":"open","dialogs":"Accept"}',
    '{"action":null}',
  ])("an extra viewport key, a non-number size, a cased enum, a null action: %s", (text) => {
    expect(describeText(text).flags).toEqual([UNVERIFIED]);
  });

  it("the schema shape with viewport, wait_until, dialogs, timeout and i is canonical", () => {
    const text =
      '{"action":"open","url":"https://a","viewport":{"width":800,"height":600},' +
      '"wait_until":"load","dialogs":"accept","timeout":5,"i":"x"}';
    expect(describeText(text)).toEqual({
      summary: "浏览器：打开 https://a",
      flags: [],
      audit: { action: "open", url: "https://a", external: null },
    });
  });

  it("an unparsable text over 16384 code units returns within 1 s, unverified", () => {
    const text = `{"action":"open"}\n${" ".repeat(20000)}x`;
    const started = performance.now();
    const described = describeText(text);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(described).toEqual({
      summary: "浏览器操作",
      flags: [UNVERIFIED],
      audit: { action: null, url: null, external: { unverified: true } },
    });
  });
});
