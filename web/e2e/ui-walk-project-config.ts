// UI walk project config steps (chat-web「会话页」Project config entry): the header of a session
// whose workspace holds no project config file has exactly the three buttons; the header of a
// session bound to `ui-walk-skills`, whose tracked fixture (smoke/fixtures/sandbox) holds one
// `AGENTS.md`, has `项目配置 1` before them, opening the read-only list. That session is created
// over REST and never prompted: no omp process is started in the fixture workspace, so the fixture
// file is listed by the host and read by no model.

import { expect, type Page } from "@playwright/test";

const TITLE = "助手会读取的项目配置文件";
const NOTE = "以下位置存在配置文件；同一层有多个说明文件时只有一个生效";
const HEADER_ACTIONS = ["重命名", "对话内搜索", "产物面板"];
// 夹具 smoke/fixtures/sandbox/u1/ui-walk-skills/AGENTS.md。
const FIXTURE_FILES = [{ path: "AGENTS.md", kind: "instructions", depth: 0 }];

function headerActions(page: Page) {
  return page.getByRole("banner").locator(".topbar-actions").getByRole("button");
}

async function expectHeaderActions(page: Page, names: readonly string[]): Promise<void> {
  const actions = headerActions(page);
  await expect(actions).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(actions.nth(index)).toHaveAccessibleName(name);
  }
}

async function projectConfig(page: Page, workspaceId: string): Promise<unknown> {
  const listed = await page.request.get(`/api/project-config?workspaceId=${workspaceId}`);
  expect(listed.status(), "GET /api/project-config status").toBe(200);
  return listed.json();
}

// 当前会话绑定的空间里没有项目配置文件（服务端为证）：顶栏恰为三个按钮。页面自己的那次读取在建
// 会话时就已返回，这里不是抢在它之前的空断言。
export async function expectNoProjectConfig(page: Page, workspaceId: string): Promise<void> {
  expect(await projectConfig(page, workspaceId)).toEqual({ files: [] });
  await expectHeaderActions(page, HEADER_ACTIONS);
}

// 调用前页面在欢迎态。`created.id` 在 201 一到就记下，调用方的 `finally` 凭它删除。按钮在
// `重命名` 之前；弹层只读（唯一的控件是自带的 `关闭`），不超出视口；Escape 关闭后焦点回到按钮。
// 结束时会话已删除，页面回到欢迎态。
export async function walkProjectConfig(
  page: Page,
  workspaceId: string,
  created: { id: string | null },
): Promise<void> {
  expect(await projectConfig(page, workspaceId)).toEqual({ files: FIXTURE_FILES });
  const creation = await page.request.post("/api/sessions", { data: { workspaceId } });
  expect(creation.status(), "POST /api/sessions status").toBe(201);
  const { id } = (await creation.json()) as { id: string };
  created.id = id;

  const read = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/project-config",
  );
  await page.goto(`/?session=${id}`);
  const request = await read;
  expect(request.method()).toBe("GET");
  expect(new URL(request.url()).search).toBe(`?workspaceId=${workspaceId}`);
  await expectHeaderActions(page, ["项目配置 1", ...HEADER_ACTIONS]);

  const button = headerActions(page).first();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  const dialog = page.getByRole("dialog", { name: TITLE, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(NOTE);
  const group = dialog.getByRole("region", { name: "当前目录", exact: true });
  await expect(dialog.getByRole("region")).toHaveCount(1);
  await expect(group.getByRole("listitem")).toHaveCount(1);
  await expect(group.locator(".chat-project-config-path")).toHaveText("AGENTS.md");
  await expect(group.locator(".ui-tag")).toHaveText("说明");
  await expect(dialog.getByRole("button")).toHaveCount(1);
  await expect(dialog.getByRole("button")).toHaveAccessibleName("关闭");
  await expect(dialog.locator("a, input, textarea, select")).toHaveCount(0);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box !== null && viewport !== null, "dialog box and viewport").toBe(true);
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  const deleted = await page.request.delete(`/api/sessions/${id}`);
  expect(deleted.status(), "DELETE session status").toBe(204);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^项目配置/u })).toHaveCount(0);
}
