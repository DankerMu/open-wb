// /files probes for the UI walk that need a real browser's computed styles, and the walk's
// steps over the new previews (highlighted source, the isolated-origin html preview with its
// relative stylesheet and source view, audio, download link, deep link) and over the row menu
// (rename the walk directory, then delete it through the confirmation dialog).

import { expect, type Locator, type Page, type Response } from "@playwright/test";

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const BUILT_SCRIPT = /^\/assets\/[^/]+\.js$/;

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

// (f)：经行菜单把目录 `from` 改名为 `to`，再经行菜单与确认框删除 `to`；两次变更之后各用 `tree` 接口复核。
// 调用时页面刚重载：`from` 行是折叠的，选中的是根下的 `clip.wav`。`root` 是根行的名字（空间名）。
export async function walkRenameThenDelete(
  page: Page,
  workspaceId: string,
  names: { from: string; to: string; root: string },
): Promise<void> {
  const { from, to, root } = names;
  const tree = page.locator("main").getByRole("navigation", { name: "工作空间目录树" });

  await openRowMenu(page, tree, from, "重命名");
  const rename = page.getByRole("dialog", { name: "重命名", exact: true });
  const field = rename.getByLabel("名称", { exact: true });
  // 初值是这一行的名字：开的是这一行的框。
  await expect(field, "rename dialog starts from the walk directory name").toHaveValue(from);
  await field.fill(to);
  await rename.getByRole("button", { name: "重命名", exact: true }).click();
  await expect(rename, "rename dialog closes").toHaveCount(0);
  // 新行在前、旧行在后：旧行的四个计数才不是对着一棵还没更新的树空转。
  await expect(
    tree.getByRole("button", { name: `展开 ${to}`, exact: true }),
    "renamed directory row",
  ).toBeVisible();
  await expectNoRow(tree, from);
  // 规格条文之外（files-web「文件操作界面」的回焦句）：改名成功后焦点在新行的菜单按钮上。
  await expect(
    tree.getByRole("button", { name: `更多操作 ${to}`, exact: true }),
    "focus after rename is on the renamed row's menu button",
  ).toBeFocused();
  // `readme.md` 是正向对照：没有它，「不含」对空列表或别的空间恒真。
  const renamed = await rootNames(page, workspaceId);
  expect(renamed, "tree after rename lists the new name").toContain(to);
  expect(renamed, "tree after rename still lists readme.md").toContain("readme.md");
  expect(renamed, "tree after rename no longer lists the old name").not.toContain(from);

  await openRowMenu(page, tree, to, "删除");
  const confirm = page.getByRole("alertdialog", { name: `删除「${to}」？`, exact: true });
  await expect(confirm, "delete confirmation").toBeVisible();
  await expect(
    confirm.getByText(DELETE_DIRECTORY_NOTE, { exact: true }),
    "delete confirmation note for a directory",
  ).toBeVisible();
  // 未确认不删。确认框开着时按角色取不到框外的树与行（实测：计数为 0），所以两层都带 `includeHidden`。
  await expect(
    page
      .locator("main")
      .getByRole("navigation", { name: "工作空间目录树", includeHidden: true })
      .getByRole("button", { name: `展开 ${to}`, exact: true, includeHidden: true }),
    "renamed directory row while the confirmation is open",
  ).toHaveCount(1);
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await expect(confirm, "delete confirmation closes").toHaveCount(0);
  await expectNoRow(tree, to);
  // 规格条文之外（同一句回焦）：删除成功后焦点在父目录的行上，这里是根行。
  await expect(
    tree.getByRole("button", { name: `折叠 ${root}`, exact: true }),
    "focus after delete is on the root row",
  ).toBeFocused();
  const removed = await rootNames(page, workspaceId);
  expect(removed, "tree after delete still lists readme.md").toContain("readme.md");
  expect(removed, "tree after delete no longer lists the renamed directory").not.toContain(to);
  expect(removed, "tree after delete does not list the old name either").not.toContain(from);

  // 规格条文之外：`clip.wav` 不在被操作的目录之下，两次操作之后选中、地址、播放器与下载链接都还在。
  await expectClipSelected(page, workspaceId);
}

// files-web「文件操作界面」目录的确认说明，逐字。
const DELETE_DIRECTORY_NOTE =
  "文件夹及其全部内容将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。";

// 点开 `name` 那一行的 `更多操作 <名>`，再点菜单里的 `item`。菜单经 portal 渲染，在 page 作用域取。
async function openRowMenu(page: Page, tree: Locator, name: string, item: string): Promise<void> {
  await tree.getByRole("button", { name: `更多操作 ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

// 目录行的名字（折叠、展开两种）、同名文件行与它的菜单按钮都不在树里。
async function expectNoRow(tree: Locator, name: string): Promise<void> {
  for (const label of [name, `展开 ${name}`, `折叠 ${name}`, `更多操作 ${name}`]) {
    await expect(tree.getByRole("button", { name: label, exact: true }), label).toHaveCount(0);
  }
}

// 工作空间根目录的条目名。`page.request` 带着页面的登录 cookie；它的 404 没有进 oracle 的记账（实测）。
async function rootNames(page: Page, workspaceId: string): Promise<string[]> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/tree`);
  expect(response.status(), "GET tree status").toBe(200);
  return ((await response.json()) as { entries: { name: string }[] }).entries.map(
    (entry) => entry.name,
  );
}
