// files-web「文件操作界面」各测试文件共用的夹具：一份可改的目录列表、请求记录的写法、行菜单的打开方式。

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { dirEntry, fileEntry, tree } from "./files-deep-link-support.js";
import {
  authenticatedFilesRoutes,
  type FetchRoutes,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
export const MOVE = `${API}/move`;
export const treeUrl = (path: string) => `${API}/tree?path=${encodeURIComponent(path)}`;
export const fileUrl = (path: string) => `${API}/file?path=${encodeURIComponent(path)}`;

type Entry = ReturnType<typeof dirEntry>;
/** 目录路径 → 它的条目；用例在 `move` 的应答里改它，之后的 `tree` 请求读到改后的样子。 */
export type Listings = Record<string, Entry[]>;

export { dirEntry, fileEntry };

/**
 * 以 `listings` 为目录内容打开文件页。没列出的目录、`extra` 里没有的地址一经请求就抛错，并留在请求
 * 记录里。返回的 `since()` 是调用之后发出的请求，按顺序：`POST` 写成 `POST <地址> <请求体>`，其余
 * 只写地址。
 */
export function openFiles(
  listings: Listings,
  extra: FetchRoutes = {},
  at = "/files?ws=workspace-1",
) {
  const trees: FetchRoutes = {};
  for (const path of Object.keys(listings)) {
    trees[treeUrl(path)] = () => {
      const entries = listings[path];
      if (!entries) {
        throw new Error(`unexpected tree request for ${path}`);
      }
      return jsonResponse({ path, entries });
    };
  }
  const mounted = renderFiles(at, authenticatedFilesRoutes([workspace], { ...trees, ...extra }));
  const log = () =>
    mounted.fetchMock.mock.calls.map(([path, options]) =>
      options?.method === "POST" ? `POST ${path} ${String(options.body)}` : path,
    );
  return {
    ...mounted,
    /** 从现在起的请求记录。 */
    mark() {
      const start = log().length;
      return () => log().slice(start);
    },
    moves: () => mounted.fetchMock.mock.calls.filter(([path]) => path === MOVE),
  };
}

export function menuButton(name: string) {
  return within(tree()).getByRole<HTMLButtonElement>("button", { name: `更多操作 ${name}` });
}

/**
 * 用指针打开一行的菜单：Radix DropdownMenu 在 pointerdown 打开。先让出一个宏任务——上一个覆盖层卸载
 * 时的焦点归还在 setTimeout(0) 里跑，落在已打开的菜单之外会把它关掉。
 */
export async function openRowMenu(name: string) {
  await yieldMacrotask();
  pressPointer(menuButton(name));
  return screen.findByRole("menu");
}

export async function openRename(name: string) {
  fireEvent.click(within(await openRowMenu(name)).getByRole("menuitem", { name: "重命名" }));
  return screen.findByRole("dialog", { name: "重命名" });
}

export function nameInput(dialog: HTMLElement) {
  return within(dialog).getByLabelText<HTMLInputElement>("名称");
}

export function submitButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>("button", { name: "重命名" });
}

/** 把 `名称` 改成 `name` 并点 `重命名`。 */
export function renameTo(dialog: HTMLElement, name: string) {
  fireEvent.change(nameInput(dialog), { target: { value: name } });
  fireEvent.click(submitButton(dialog));
}

export function dialogGone(name = "重命名") {
  return waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
}

export function focusedOn(element: () => Element) {
  return waitFor(() => expect(document.activeElement).toBe(element()));
}
