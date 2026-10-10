// files-web「API 客户端扩展」里 `fetchPreview` 按 Content-Type 判定的两个场景：
// 「预览元数据与资源」新增的图片类型，与「失败不变成预览」里主站不该返回的类型。
// png / jpeg 与其余失败分支的既有用例留在 api-files.test.ts，这里不重复。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { captureApiError, expectRequestFailure } from "./support.js";

const BODY_BYTES = [71, 73, 70, 56, 0, 255];
/** 头里的原始大小，故意不等于正文长度。 */
const ORIGINAL_SIZE = 4096;
/** 被拒绝的响应的正文，不得出现在错误里。 */
const REFUSED_BODY = "private preview body";

function previewResponse(contentType: string, body: BodyInit): Response {
  return new Response(body, {
    headers: { "Content-Type": contentType, "X-Workbuddy-Size": String(ORIGINAL_SIZE) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPreview 的图片类型集合", () => {
  // 第二列是 Blob 上保留下来的 MIME：类型本身小写，参数原样跟随。
  it.each([
    ["image/gif", "image/gif"],
    ["image/webp", "image/webp"],
    ["image/bmp", "image/bmp"],
    ["image/x-icon", "image/x-icon"],
    ["IMAGE/GIF; charset=binary", "image/gif;charset=binary"],
    ["image/webp ;q=1", "image/webp;q=1"],
  ])("%s 的 200 响应成为调用方可释放的图片预览", async (contentType, blobType) => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:preview-type-1");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(previewResponse(contentType, new Uint8Array(BODY_BYTES))),
    );

    const preview = await createApiClient().fetchPreview("workspace-1", "picture");

    expect(preview).toEqual({
      kind: "image",
      url: "blob:preview-type-1",
      size: ORIGINAL_SIZE,
      truncated: false,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) {
      throw new Error("expected the image Blob");
    }
    expect(blob.type).toBe(blobType);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(BODY_BYTES);

    if (preview.kind !== "image") {
      throw new Error("expected an image preview");
    }
    URL.revokeObjectURL(preview.url);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-type-1");
  });

  it.each([
    ["text/html"],
    ["image/svg+xml"],
    ["IMAGE/SVG+XML; charset=utf-8"],
    ["video/mp4"],
    ["audio/mpeg"],
    ["image/avif"],
    ["image/vnd.microsoft.icon"],
    ["image/ico"],
    ["image/gif+xml"],
  ])("%s 的 200 响应按失败处理，不读成预览也不分配图片地址", async (contentType) => {
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(previewResponse(contentType, REFUSED_BODY)));

    const request = createApiClient().fetchPreview("workspace-1", "unsupported");

    expectRequestFailure(await captureApiError(request), 200);
    expect((await captureApiError(request)).message).not.toContain(REFUSED_BODY);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
