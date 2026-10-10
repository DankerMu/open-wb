// files-web「API 客户端扩展」的场景「地址函数与严格解析」里地址函数的一半：两个只拼地址、不发请求的纯函数。
// 只从公共入口 `lib/api.js` 取——`api-files.ts` 的导出只供 `api.ts` 使用（见 chat-module-layout.test.ts）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadUrl, fileUrl } from "../src/lib/api.js";

/** 浏览器按同源相对地址解析后读到的 `path` 参数。 */
function pathParam(url: string): string | null {
  return new URL(url, "http://x").searchParams.get("path");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("工作空间文件的地址函数", () => {
  it("fileUrl 把路径整体编码成 file 端点的 path 参数，解码后等于原路径", () => {
    const path = "报告 2026/a b#1.mp4";
    const url = fileUrl("w1", path);

    expect(url).toBe("/api/workspaces/w1/file?path=%E6%8A%A5%E5%91%8A%202026%2Fa%20b%231.mp4");
    expect(pathParam(url)).toBe(path);
  });

  it("downloadUrl 把路径里的 & 编码进 download 端点的 path 参数，不拆成第二个参数", () => {
    const path = "a&b.txt";
    const url = downloadUrl("w1", path);

    expect(url).toBe("/api/workspaces/w1/download?path=a%26b.txt");
    expect(pathParam(url)).toBe(path);
    expect([...new URL(url, "http://x").searchParams.keys()]).toEqual(["path"]);
  });

  it("工作空间 id 作为一个路径段编码，保留字符不改变地址结构", () => {
    const id = "ws/%#?+ 中";
    const segment = "ws%2F%25%23%3F%2B%20%E4%B8%AD";

    expect(fileUrl(id, "a.txt")).toBe(`/api/workspaces/${segment}/file?path=a.txt`);
    expect(downloadUrl(id, "a.txt")).toBe(`/api/workspaces/${segment}/download?path=a.txt`);
    expect(new URL(fileUrl(id, "a.txt"), "http://x").pathname).toBe(
      `/api/workspaces/${segment}/file`,
    );
  });

  it.each([
    ["查询与百分号", "100% ?q=1+2", "100%25%20%3Fq%3D1%2B2"],
    ["首尾斜杠", "/a/", "%2Fa%2F"],
    ["上级目录段", "../x/./y", "..%2Fx%2F.%2Fy"],
    ["空路径", "", ""],
    ["首尾空白", " a ", "%20a%20"],
    ["分解形式（NFD）的重音字符", "e\u0301", "e%CC%81"],
  ])("路径是数据，不规范化：%s", (_name, path, encoded) => {
    expect(fileUrl("w1", path)).toBe(`/api/workspaces/w1/file?path=${encoded}`);
    expect(downloadUrl("w1", path)).toBe(`/api/workspaces/w1/download?path=${encoded}`);
    expect(pathParam(fileUrl("w1", path))).toBe(path);
    expect(pathParam(downloadUrl("w1", path))).toBe(path);
  });

  it("孤立代理项无法编码，同步抛出 URIError", () => {
    expect(() => fileUrl("w1", "\uD800")).toThrow(URIError);
    expect(() => downloadUrl("w1", "\uD800")).toThrow(URIError);
  });

  it("没有发出请求", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fileUrl("w1", "报告 2026/a b#1.mp4");
    downloadUrl("w1", "a&b.txt");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
