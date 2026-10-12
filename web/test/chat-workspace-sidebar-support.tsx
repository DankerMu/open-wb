// 工作空间侧边栏（#1105）整页测试的夹具与页面查询：五个会话（两个各绑一个正式空间、一个与第一个同
// 空间、一个未绑定、一个用临时空间）、两个空间的目录与一份文本预览的路由、顶栏按钮与侧边栏的读取。
// 页面搭法来自 chat-page-session-meta-support.tsx（不改它）。
import "./radix-platform.js";
import { fireEvent, screen, within } from "@testing-library/react";
import { ROOT_PREFIX } from "./chat-page-file-changes-support.js";
import { A, B, C, crumb, mountSessions, view } from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { calls, type FetchMock, jsonResponse, textPreviewResponse } from "./support.js";

export const NAME = "工作空间侧边栏";
export const CLOSE = "关闭工作空间侧边栏";
export const OPEN_IN_FILES = "在文件页打开";
export const STORAGE_KEY = "workbuddy-workspace-sidebar";

export const W1 = {
  id: "1".repeat(32),
  name: "项目甲",
  dir: "proj-a",
  root: `${ROOT_PREFIX}/u-1/proj-a`,
  createdAt: 1_740_000_000_000,
};
export const W2 = { ...W1, id: "2".repeat(32), name: "项目乙", dir: "proj-b" };
/** 临时空间：会话的 `workspaceId`，不在工作空间列表里。 */
export const TEMP = "7".repeat(32);

const titled = <T extends string>(title: T, session: ReturnType<typeof view>) => ({
  ...session,
  title,
});
export const BOUND = titled("甲会话", view(A, "甲会话", { workspaceId: W1.id }));
export const OTHER = titled("乙会话", view(B, "乙会话", { workspaceId: W2.id }));
export const UNBOUND = titled("未绑定会话", view(C, "未绑定会话"));
export const SAME_SPACE = titled(
  "同空间会话",
  view("d".repeat(32), "同空间会话", { workspaceId: W1.id }),
);
export const TEMPORARY = titled(
  "临时会话",
  view("e".repeat(32), "临时会话", { temporaryWorkspace: true, workspaceId: TEMP }),
);
const SESSIONS = [BOUND, OTHER, UNBOUND, SAME_SPACE, TEMPORARY];

const pathOf = (session: { id: string }) => `/?session=${session.id}`;
export const treeOf = (workspaceId: string, path = "") =>
  `/api/workspaces/${workspaceId}/tree?path=${encodeURIComponent(path)}`;
export const fileOf = (workspaceId: string, path: string) =>
  `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`;

export const dir = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
export const file = (name: string) => ({ name, type: "file", size: 4, mtime: 200 });
export const listing = (path: string, entries: readonly unknown[]) => () =>
  jsonResponse({ path, entries });

/**
 * W1 的根下是目录 `out`（内有 `a.md`）与 `readme.md`；W2 的根下只有 `w2.txt`；临时空间的根下只有
 * `scratch.txt`。三个空间的项目配置列表都是空的。
 */
function routes(extra: FetchRoutes): FetchRoutes {
  const all: FetchRoutes = {
    "/api/workspaces": () => jsonResponse({ workspaces: [W1, W2] }),
    [treeOf(W1.id)]: listing("", [dir("out"), file("readme.md")]),
    [treeOf(W1.id, "out")]: listing("out", [file("a.md")]),
    [fileOf(W1.id, "readme.md")]: () => textPreviewResponse("自述正文"),
    [fileOf(W1.id, "out/a.md")]: () => textPreviewResponse("甲的正文"),
    [treeOf(W2.id)]: listing("", [file("w2.txt")]),
    [treeOf(TEMP)]: listing("", [file("scratch.txt")]),
  };
  for (const id of [W1.id, W2.id, TEMP]) {
    all[`/api/project-config?workspaceId=${id}`] = () => jsonResponse({ files: [] });
  }
  all["/api/project-config"] = () => jsonResponse({ files: [] });
  return { ...all, ...extra };
}

/** 在真实外壳里打开 `session`，等到它的面包屑出现（标题已知即会话列表已读到）。 */
export async function mountSidebarPage(
  session: { id: string; title: string } = BOUND,
  extra: FetchRoutes = {},
) {
  const page = mountSessions(pathOf(session), SESSIONS, routes(extra));
  await crumb(session.title);
  return page;
}

/** 宽屏下外壳侧栏里的会话列表区。 */
function sessionList() {
  return screen.getByRole("navigation", { name: "会话列表" });
}

/** 点会话列表里的 `session`，等到它的面包屑出现。 */
export async function selectSession(session: { title: string }) {
  fireEvent.click(within(sessionList()).getByRole("button", { name: session.title }));
  await crumb(session.title);
}

function banner() {
  return screen.getByRole("banner", { hidden: true });
}

/** 顶栏每个按钮的 `aria-label`，按文档顺序（模态层打开期间顶栏被 aria-hidden，照样读）。 */
export function bannerButtons() {
  return within(banner())
    .getAllByRole("button", { hidden: true })
    .map((button) => button.getAttribute("aria-label"));
}

export function sidebarButton() {
  return within(banner()).getByRole<HTMLButtonElement>("button", { name: NAME, hidden: true });
}

/** 宽屏的侧边栏（`complementary` 地标），没有打开时为 null。 */
export function sidebarRegion() {
  return screen.queryByRole("complementary", { name: NAME });
}

/** 点顶栏按钮打开侧边栏（宽屏），等到根目录里的 `entry` 出现；返回地标与触发按钮。 */
export async function openSidebar(entry: string) {
  const trigger = sidebarButton();
  fireEvent.click(trigger);
  const region = await screen.findByRole("complementary", { name: NAME });
  await within(region).findByRole("button", { name: entry });
  return { region, trigger };
}

/** 侧边栏头部（空间名、逻辑路径、`在文件页打开`、关闭按钮所在的那一条）。 */
export function sidebarHead(scope: HTMLElement) {
  const head = scope.querySelector<HTMLElement>('[data-slot="workspace-sidebar-head"]');
  if (!head) throw new Error("侧边栏缺少头部");
  return head;
}

/** 对 `workspaceId` 的 `path` 目录发出的 `tree` 请求，按调用顺序。 */
export function treeCalls(fetchMock: FetchMock, workspaceId: string, path = "") {
  return calls(fetchMock, treeOf(workspaceId, path));
}
