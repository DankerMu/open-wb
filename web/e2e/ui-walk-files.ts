// /files probes for the UI walk that need a real browser's computed styles, and the walk's
// steps over the new previews (highlighted source, the isolated-origin html preview with its
// relative stylesheet and source view, audio, download link, deep link).

import { expect, type Page, type Response } from "@playwright/test";

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const BUILT_SCRIPT = /^\/assets\/[^/]+\.js$/;

// ui-foundation「旧页面规则压过 preflight」：ui.css 的 `.ui-icon { display: inline-block }` 在 legacy 层，
// 压过 base 层 preflight 给 svg 的 `display: block`。探针是临时插入 body 的 svg，读完即移除。
// 随 legacy 层整体移除（change s1f-files-page 收尾）删除。
export async function expectLegacyOverPreflight(page: Page): Promise<void> {
  const display = await page.evaluate(() => {
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    probe.setAttribute("class", "ui-icon");
    document.body.append(probe);
    const value = getComputedStyle(probe).display;
    probe.remove();
    return value;
  });
  expect(display, "svg.ui-icon display under the legacy layer").toBe("inline-block");
}

// files-web「文件页不自涂底色」（issue 420）：分栏容器与预览区的计算底色都是透明，页面底色只来自 body。
export async function expectFilesUnpainted(page: Page): Promise<void> {
  for (const slot of ["files-layout", "files-preview"]) {
    const container = page.locator(`main [data-slot="${slot}"]`);
    await expect(container, slot).toHaveCount(1);
    expect(
      await container.evaluate((el) => getComputedStyle(el).backgroundColor),
      `${slot} paints no background`,
    ).toBe(TRANSPARENT);
  }
}

// ui-foundation「构建产物确有按需块」：`select()`（选中第一个文件）使页面新取回至少一个同源
// `assets/` 下的 200 `.js`，且它不在选中之前已加载的脚本里。只对构建产物成立——对 dev server 必红。
// 「选中之前没有预览器块」没有直接断言，只由这个集合差间接保证。
export async function expectOnDemandChunk(page: Page, select: () => Promise<void>): Promise<void> {
  const origin = new URL(page.url()).origin;
  const builtScript = (address: string) => {
    const url = new URL(address);
    return url.origin === origin && BUILT_SCRIPT.test(url.pathname);
  };
  const loadedBefore = new Set(
    (
      await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name))
    ).filter(builtScript),
  );
  // 快照为空说明页面不是构建产物（或资源计时被清空），其后的「新增」断言就是空转。
  expect(loadedBefore.size, "built scripts loaded before selecting a file").toBeGreaterThan(0);

  const fetched: string[] = [];
  const onResponse = (response: Response) => {
    const address = response.url();
    if (response.status() === 200 && builtScript(address) && !loadedBefore.has(address)) {
      fetched.push(address);
    }
  };
  page.on("response", onResponse);
  try {
    await select();
    await expect
      .poll(() => fetched.length, "selecting a file fetches an on-demand previewer chunk")
      .toBeGreaterThan(0);
  } finally {
    page.off("response", onResponse);
  }
}

// files-harness「走查 /files 步骤」(a)(b)，再选中 `clip.wav` 做 (c)(d)。调用时页面已选中工作空间、树已加载。
export async function expectNewPreviews(page: Page, workspaceId: string): Promise<void> {
  const files = page.locator("main");
  const tree = files.getByRole("navigation", { name: "工作空间目录树" });
  const preview = files.getByRole("region", { name: "文件预览" });

  await tree.getByRole("button", { name: "sample.py", exact: true }).click();
  const firstLine = preview.locator('[data-slot="preview-code"]').getByRole("row").first();
  await expect(firstLine.getByRole("cell").nth(0), "sample.py line number").toHaveText("1");
  // 未着色的行第二格只有文本节点，着色后才有元素；着色在 effect 里晚于源码落地（读代码推出），所以轮询。
  await expect(
    firstLine.getByRole("cell").nth(1).locator("span"),
    "sample.py first line carries a syntax-highlight element",
  ).not.toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("path"), "path after selecting sample.py")
    .toBe("sample.py");

  await expectSitePreview(page, workspaceId);

  await tree.getByRole("button", { name: "clip.wav", exact: true }).click();
  await expectClipSelected(page, workspaceId);
}

// (b)：`site/index.html` 在隔离来源的 iframe 里渲染，标题颜色来自它用相对地址引的 `style.css`；再切到源码视图。
// `base` 取自这一次点击引出的 `preview-token` 响应（预览端口由系统分配，写不死）；监听先于点击挂上。
async function expectSitePreview(page: Page, workspaceId: string): Promise<void> {
  const files = page.locator("main");
  const tree = files.getByRole("navigation", { name: "工作空间目录树" });
  const preview = files.getByRole("region", { name: "文件预览" });
  const tokenPath = `/api/workspaces/${workspaceId}/preview-token`;

  await tree.getByRole("button", { name: "展开 site", exact: true }).click();
  const [issued] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === tokenPath,
    ),
    tree.getByRole("button", { name: "index.html", exact: true }).click(),
  ]);
  expect(issued.status(), "preview-token status").toBe(200);
  const base = previewBase(await issued.json());
  // 规格条文之外：预览若与页面同源，下面的 `src` 恰等照样通过，要到标题可见性才红（实测）；这一句让它红在原因上。
  expect(new URL(base).origin, "preview origin is not the page origin").not.toBe(
    new URL(page.url()).origin,
  );

  const frame = preview.locator("iframe");
  await expect(frame, "site/index.html frame").toHaveCount(1);
  await expect(frame, "site/index.html frame src").toHaveAttribute("src", `${base}site/index.html`);
  await expect(frame, "site/index.html frame sandbox").toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-modals",
  );
  // 帧是跨源且带 sandbox 的；标题的计算颜色在帧内取（Chromium 下取得到，实测）。
  const heading = frame
    .contentFrame()
    .getByRole("heading", { level: 1, name: "smoke-site", exact: true });
  await expect(heading, "smoke-site heading inside the frame").toBeVisible();
  await expect(heading, "smoke-site heading colour from the relative stylesheet").toHaveCSS(
    "color",
    "rgb(0, 128, 0)",
  );

  await preview.getByRole("button", { name: "查看源码" }).click();
  await expect(preview.locator("iframe"), "source view has no frame").toHaveCount(0);
  const code = preview.locator('[data-slot="preview-code"]');
  await expect(
    code.getByRole("row").first().getByRole("cell").nth(0),
    "index.html source line number",
  ).toHaveText("1");
  const headingRow = code.getByRole("row").filter({ hasText: "<h1>smoke-site</h1>" });
  await expect(headingRow, "index.html source row with the heading").toHaveCount(1);
  await expect(headingRow.getByRole("cell").nth(0), "heading source line number").toHaveText("9");
}

function previewBase(body: unknown): string {
  if (body === null || typeof body !== "object" || !("base" in body)) {
    throw new Error("preview-token 200 body has no base");
  }
  if (typeof body.base !== "string") {
    throw new Error("preview-token base is not a string");
  }
  return body.base;
}

// (c)(d) 与选中态；重载之后再调一次即 (e)。地址里的 `path` 重载后原样还在，证明不了恢复——
// (e) 的判据是树行的 `aria-current` 与重新出现的播放器、下载链接。
export async function expectClipSelected(page: Page, workspaceId: string): Promise<void> {
  const files = page.locator("main");
  const tree = files.getByRole("navigation", { name: "工作空间目录树" });
  const preview = files.getByRole("region", { name: "文件预览" });
  const origin = new URL(page.url()).origin;
  const query = (name: string) => new URL(page.url()).searchParams.get(name);

  await expect.poll(() => query("ws"), "ws while clip.wav is selected").toBe(workspaceId);
  await expect.poll(() => query("path"), "path while clip.wav is selected").toBe("clip.wav");
  await expect(
    tree.getByRole("button", { name: "clip.wav", exact: true }),
    "clip.wav row is the current one",
  ).toHaveAttribute("aria-current", "true");
  await expect(tree.locator('[aria-current="true"]'), "exactly one current row").toHaveCount(1);

  // (c)：`src` 读属性值（解析后的绝对地址）；首次选中与由地址恢复的选中都不带 `v`（实测）。
  const audio = preview.locator("audio");
  await expect(audio, "clip.wav audio player").toHaveCount(1);
  await expect(audio, "clip.wav audio controls").toHaveAttribute("controls", "");
  await expect(audio, "clip.wav audio src").toHaveJSProperty(
    "src",
    `${origin}/api/workspaces/${workspaceId}/file?path=clip.wav`,
  );
  // 规格条文之外：出错时播放器会被换成「无法播放该文件」，只数元素可能赶在出错之前就过（读代码推出）；
  // 这里等到元数据读到（HAVE_METADATA）且没有错误。
  await expect
    .poll(
      () => audio.evaluate((el: HTMLAudioElement) => [el.error === null, el.readyState >= 1]),
      "clip.wav metadata loaded without error",
    )
    .toEqual([true, true]);

  // (d)：只读属性，不点击（点击会触发下载导航）。
  const download = preview
    .locator('[data-slot="preview-header"]')
    .getByRole("link", { name: "下载 clip.wav", exact: true });
  await expect(download, "clip.wav download href").toHaveJSProperty(
    "href",
    `${origin}/api/workspaces/${workspaceId}/download?path=clip.wav`,
  );
  await expect(download, "clip.wav download attribute").toHaveAttribute("download", "");
}
