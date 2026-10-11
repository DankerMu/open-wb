// file-previewers「与服务端的扩展名表一致」：图片、音频、视频、Notebook 四个扩展名集合两侧相等。
// 服务端那一侧直接导入源文件的导出常量——测试不进浏览器包，`web/src` 仍不导入服务端。
// 只比这四类：pdf / 办公文档 / 压缩包与文本细分不在这里。
import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTENSIONS as SERVER_AUDIO,
  IMAGE_EXTENSIONS as SERVER_IMAGE,
  NOTEBOOK_EXTENSIONS as SERVER_NOTEBOOK,
  VIDEO_EXTENSIONS as SERVER_VIDEO,
} from "../../server/src/workspaces/preview.js";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  NOTEBOOK_EXTENSIONS,
  previewKind,
  VIDEO_EXTENSIONS,
} from "../src/features/files/previewers/kind.js";

// 每行：标签、`previewKind` 的类别、前端集合、服务端集合。
const CASES = [
  ["图片", "image", IMAGE_EXTENSIONS, SERVER_IMAGE],
  ["音频", "audio", AUDIO_EXTENSIONS, SERVER_AUDIO],
  ["视频", "video", VIDEO_EXTENSIONS, SERVER_VIDEO],
  ["Notebook", "notebook", NOTEBOOK_EXTENSIONS, SERVER_NOTEBOOK],
] as const;

describe("预览类别的扩展名表与服务端一致", () => {
  it.each(CASES)("%s扩展名集合两侧相等", (_label, _kind, client, server) => {
    expect([...client].sort()).toStrictEqual([...server].sort());
  });

  // 把导出的集合绑回判定函数：服务端认的每个扩展名，`previewKind` 给出同一类别。
  it.each(CASES)("服务端的%s扩展名都判为同一类别", (_label, kind, _client, server) => {
    const judged = [...server].sort().map((ext) => [ext, previewKind(`x.${ext}`)]);
    expect(judged).toStrictEqual([...server].sort().map((ext) => [ext, kind]));
  });
});
