/**
 * Issue #1068：预览监听器的响应头与内容类型表（preview-origin「预览响应头与内容类型」里由纯函数
 * 即可证明的四个场景），外加规格没有写、实施注记要求钉住的分支：无扩展名与原型键、PDF 例外按
 * 算出的类型判、`embedOrigin` 在汇点 fail-closed。
 * 期望值全部是规格字面量——CSP 与类型串逐字写在这里，不从源码导入、不由源码拼出。
 */
import { describe, expect, it } from "vitest";
import { previewFailureHeaders, previewHeaders } from "../src/preview/headers.js";

const ORIGIN = "http://127.0.0.1:3000";
const SANDBOXED =
  "sandbox allow-scripts allow-forms allow-modals; frame-ancestors http://127.0.0.1:3000";
const OCTET = "application/octet-stream";

function typeOf(name: string): string | undefined {
  return previewHeaders(name, ORIGIN)["Content-Type"];
}

function cspOf(name: string, embedOrigin: string | null): string | undefined {
  return previewHeaders(name, embedOrigin)["Content-Security-Policy"];
}

describe("预览响应头：HTML 响应是不透明来源", () => {
  it("成功响应恰七个头，CSP 逐字为 sandbox 三项加 frame-ancestors <embedOrigin>", () => {
    const headers = previewHeaders("site/index.html", ORIGIN);

    expect(headers).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy":
        "sandbox allow-scripts allow-forms allow-modals; frame-ancestors http://127.0.0.1:3000",
    });
    expect(Object.keys(headers)).toHaveLength(7);
  });

  it.each([
    "allow-same-origin",
    "allow-top-navigation",
    "allow-popups",
    "default-src",
    "script-src",
    "connect-src",
  ])("CSP 不含 %s", (forbidden) => {
    expect(cspOf("site/index.html", ORIGIN)).not.toContain(forbidden);
    expect(cspOf("doc.pdf", ORIGIN)).not.toContain(forbidden);
  });

  it("每次调用返回新对象：调用方改了上一次的结果不影响下一次", () => {
    const first = previewHeaders("a.html", ORIGIN);
    first["Content-Security-Policy"] = "tampered";
    delete first["X-Content-Type-Options"];

    expect(previewHeaders("a.html", ORIGIN)).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": SANDBOXED,
    });
  });
});

describe("预览响应头：PDF 响应不带 sandbox", () => {
  it("doc.pdf 的类型是 application/pdf，CSP 恰为 frame-ancestors <embedOrigin>", () => {
    expect(previewHeaders("doc.pdf", ORIGIN)).toEqual({
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": "frame-ancestors http://127.0.0.1:3000",
    });
  });

  it("没有 embedOrigin 时 doc.pdf 的 CSP 恰为 frame-ancestors 'none'", () => {
    expect(cspOf("doc.pdf", null)).toBe("frame-ancestors 'none'");
  });

  it("没有 embedOrigin 时 HTML 的 CSP 仍带 sandbox，frame-ancestors 为 'none'", () => {
    expect(cspOf("a.html", null)).toBe(
      "sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'none'",
    );
  });

  it("X.PDF：例外按算出的类型判，不按原始文件名", () => {
    expect(typeOf("X.PDF")).toBe("application/pdf");
    expect(cspOf("X.PDF", ORIGIN)).toBe("frame-ancestors http://127.0.0.1:3000");
  });

  it.each([
    "a.svg",
    "a.html",
    "a.htm",
    "app.mjs",
    "notes.txt",
    "data.bin",
    "README",
    "pdf",
    "a.pdf.html",
    "a.pdf/b",
  ])("%s 不是 PDF，CSP 带 sandbox", (name) => {
    expect(cspOf(name, ORIGIN)).toBe(SANDBOXED);
  });
});

describe("预览响应头：类型只看文件名", () => {
  it.each([
    ["html", "text/html; charset=utf-8"],
    ["htm", "text/html; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["js", "text/javascript; charset=utf-8"],
    ["mjs", "text/javascript; charset=utf-8"],
    ["json", "application/json; charset=utf-8"],
    ["map", "application/json; charset=utf-8"],
    ["svg", "image/svg+xml"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["bmp", "image/bmp"],
    ["ico", "image/x-icon"],
    ["woff", "font/woff"],
    ["woff2", "font/woff2"],
    ["ttf", "font/ttf"],
    ["otf", "font/otf"],
    ["pdf", "application/pdf"],
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["txt", "text/plain; charset=utf-8"],
    ["md", "text/plain; charset=utf-8"],
    ["csv", "text/plain; charset=utf-8"],
    ["tsv", "text/plain; charset=utf-8"],
    ["xml", "text/plain; charset=utf-8"],
  ])("固定表：扩展名 %s → %s", (extension, contentType) => {
    expect(typeOf(`dir/file.${extension}`)).toBe(contentType);
  });

  it("规格场景：notes.txt、README、data.bin、a.svg、app.mjs", () => {
    expect(["notes.txt", "README", "data.bin", "a.svg", "app.mjs"].map(typeOf)).toEqual([
      "text/plain; charset=utf-8",
      "application/octet-stream",
      "application/octet-stream",
      "image/svg+xml",
      "text/javascript; charset=utf-8",
    ]);
  });

  it.each([
    "README",
    "data.bin",
    "html",
    "pdf",
    "a.",
    "a.xhtml",
    "a.ts",
    "a.docx",
    "a.zip",
    "a.constructor",
    "a.__proto__",
    "a.toString",
    "site.v2/README",
    ".gitignore",
    "a.tar.gz",
    "a.html ",
    "",
  ])("表外：%j → application/octet-stream", (name) => {
    expect(typeOf(name)).toBe(OCTET);
  });

  it.each([
    ["A.HTML", "text/html; charset=utf-8"],
    ["Photo.JpEg", "image/jpeg"],
    [".html", "text/html; charset=utf-8"],
    ["a.pdf.html", "text/html; charset=utf-8"],
    ["site.v2/index.html", "text/html; charset=utf-8"],
  ])("大小写与最后一个点：%s → %s", (name, contentType) => {
    expect(typeOf(name)).toBe(contentType);
  });

  it.each(["site/index.html", "doc.pdf", "README", "a.svg", "clip.mp4"])(
    "%s 一律带 nosniff、no-store、no-referrer、ACAO * 与 CORP cross-origin",
    (name) => {
      const headers = previewHeaders(name, null);

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Cache-Control"]).toBe("no-store");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
      expect(Object.keys(headers)).toHaveLength(7);
    },
  );
});

describe("预览响应头：失败响应的头", () => {
  it("恰四个头：text/plain 加三项公共头，没有 ACAO、CORP 与 CSP", () => {
    expect(previewFailureHeaders()).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    expect(Object.keys(previewFailureHeaders())).toHaveLength(4);
  });

  it.each(["X-Content-Type-Options", "Cache-Control", "Referrer-Policy"])(
    "公共头 %s 与成功响应逐值相同",
    (key) => {
      const failure = previewFailureHeaders()[key];

      expect(failure).toBeTypeOf("string");
      expect(previewHeaders("a.html", ORIGIN)[key]).toBe(failure);
      expect(previewHeaders("doc.pdf", null)[key]).toBe(failure);
    },
  );

  it("每次调用返回新对象", () => {
    const first = previewFailureHeaders();
    first["Access-Control-Allow-Origin"] = "*";

    expect(Object.keys(previewFailureHeaders())).toHaveLength(4);
  });
});

describe("预览响应头：embedOrigin 不是一个来源时按没有处理", () => {
  it.each([
    "*",
    "null",
    "",
    "'none'",
    "http://a.test/",
    "http://a.test/path",
    "http://a.test; sandbox allow-same-origin",
    "http://a.test http://evil.test",
    "http://a.test, http://evil.test",
    "http://a.test\r\nX-Injected: 1",
    "javascript:alert(1)",
    "data:text/html,x",
    "http:",
  ])("非法 %j → frame-ancestors 'none'", (embedOrigin) => {
    expect(cspOf("a.html", embedOrigin)).toBe(
      "sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'none'",
    );
    expect(cspOf("doc.pdf", embedOrigin)).toBe("frame-ancestors 'none'");
  });

  // 这一组能解析且 `origin` 原样往返（WHATWG 主机名不禁这些字符），但在 CSP 里是通配、追加指令或追加策略。
  it.each([
    "http://*",
    "http://*.a.test",
    "http://a.test;sandbox",
    "http://a.test;script-src",
    "http://a.test,x",
    "http://a'none'",
  ])("能当来源解析但含 CSP 语法字符 %j → frame-ancestors 'none'", (embedOrigin) => {
    expect(new URL(embedOrigin).origin).toBe(embedOrigin);
    expect(cspOf("a.html", embedOrigin)).toBe(
      "sandbox allow-scripts allow-forms allow-modals; frame-ancestors 'none'",
    );
    expect(cspOf("doc.pdf", embedOrigin)).toBe("frame-ancestors 'none'");
  });

  it.each([
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://preview.example.test",
    "http://localhost:5173",
  ])("合法 %s 原样写入", (embedOrigin) => {
    expect(cspOf("a.html", embedOrigin)).toBe(
      `sandbox allow-scripts allow-forms allow-modals; frame-ancestors ${embedOrigin}`,
    );
    expect(cspOf("doc.pdf", embedOrigin)).toBe(`frame-ancestors ${embedOrigin}`);
  });
});
