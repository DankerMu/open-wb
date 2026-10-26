// files-web「文件操作界面」各测试文件共用的夹具：一份可改的目录列表、请求记录的写法、行菜单的打开方式。

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { dirEntry, fileEntry, findRow, tree } from "./files-deep-link-support.js";
import {
  authenticatedFilesRoutes,
  type FetchRoutes,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { isMountsRequest, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
export const MOVE = `${API}/move`;
/** `DELETE …/entries?path=` 的地址：`path` 整段编码一次。 */
export const entriesUrl = (path: string) => `${API}/entries?path=${encodeURIComponent(path)}`;
export const treeUrl = (path: string) => `${API}/tree?path=${encodeURIComponent(path)}`;
export const fileUrl = (path: string) => `${API}/file?path=${encodeURIComponent(path)}`;

type Entry = ReturnType<typeof dirEntry>;
/** 目录路径 → 它的条目；用例在 `move` 的应答里改它，之后的 `tree` 请求读到改后的样子。 */
export type Listings = Record<string, Entry[]>;

export { dirEntry, fileEntry };

/** 根下两个文件。 */
export const flat = (): Listings => ({ "": [fileEntry("notes.md"), fileEntry("readme.md", 8)] });

/** 根下 `out`（含 `sub` 与两个文件）、同级的 `output`、一个文件。 */
export const nested = (): Listings => ({
  "": [dirEntry("out"), dirEntry("output"), fileEntry("top.md")],
  out: [dirEntry("sub"), fileEntry("a.md"), fileEntry("b.md")],
  "out/sub": [fileEntry("x.md")],
  output: [fileEntry("o.md")],
});

/** `nested()` 的根在 `out` 被拿掉之后的样子。 */
export const withoutOut = () => [dirEntry("output"), fileEntry("top.md")];

export async function expand(name: string) {
  fireEvent.click(await findRow(`展开 ${name}`));
  await findRow(`折叠 ${name}`);
}

/**
 * 以 `listings` 为目录内容打开文件页。没列出的目录、`extra` 里没有的地址一经请求就抛错，并留在请求
 * 记录里。返回的 `since()` 是调用之后发出的请求，按顺序：`GET` 只写地址，其余方法写成
 * `<方法> <地址>`，带请求体的后面再接请求体（`POST <地址> <请求体>`、`DELETE <地址>`）。
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
    mounted.fetchMock.mock.calls
      .filter(([path]) => !isMountsRequest(path))
      .map(([path, options]) => {
        const method = options?.method ?? "GET";
        const body = options?.body == null ? [] : [String(options.body)];
        return method === "GET" ? path : [method, path, ...body].join(" ");
      });
  return {
    ...mounted,
    /** 从现在起的请求记录。 */
    mark() {
      const start = log().length;
      return () => log().slice(start);
    },
    moves: () => mounted.fetchMock.mock.calls.filter(([path]) => path === MOVE),
    /** 条目的 `DELETE`（卸载挂载的 `DELETE …/mounts/<id>` 不算，见 `isMountsRequest`）。 */
    deletes: () =>
      mounted.fetchMock.mock.calls.filter(
        ([path, options]) => options?.method === "DELETE" && !isMountsRequest(path),
      ),
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

/** 经行菜单打开 `name` 这一行的 `移动到` 对话框。 */
export async function openMove(name: string) {
  fireEvent.click(within(await openRowMenu(name)).getByRole("menuitem", { name: "移动到…" }));
  return screen.findByRole("dialog", { name: "移动到" });
}

/** 经行菜单打开 `name` 这一行的删除确认框（`alertdialog`，按标题找）。 */
export async function openDelete(name: string) {
  fireEvent.click(within(await openRowMenu(name)).getByRole("menuitem", { name: "删除" }));
  return screen.findByRole("alertdialog", { name: `删除「${name}」？` });
}

export function confirmGone() {
  return waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

export function cancelButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>("button", { name: "取消" });
}

/** 确认框里的 `删除`。 */
export function confirmButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>("button", { name: "删除" });
}

/** `DELETE` 成功的应答：204，没有正文。 */
export const deleted = () => new Response(null, { status: 204 });

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

/** `移动到` 对话框里的下拉 `目标位置`；没有可选目标时没有它，这里会抛错。 */
export function targetSelect(dialog: HTMLElement) {
  return within(dialog).getByLabelText<HTMLSelectElement>("目标位置");
}

export function moveButton(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLButtonElement>("button", { name: "移动" });
}

/** 在 `目标位置` 选 `target` 并点 `移动`。 */
export function moveInto(dialog: HTMLElement, target: string) {
  fireEvent.change(targetSelect(dialog), { target: { value: target } });
  fireEvent.click(moveButton(dialog));
}

/** 树里 Tab 会停的控件各自的名字，按文档顺序；有正的 `tabindex`（Tab 次序就不是文档顺序了）即抛错。 */
export function tabStops() {
  const controls = tree().querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]");
  if ([...controls].some((control) => control.tabIndex > 0)) throw new Error("positive tabindex");
  return [...controls]
    .filter((control) => control.tabIndex >= 0 && !(control as HTMLButtonElement).disabled)
    .map((control) => control.getAttribute("aria-label") ?? control.getAttribute("title"));
}

/**
 * 在聚焦着的原生 `button` 上按一次 `key`（`Enter` 或空格）。jsdom 不做「键盘激活按钮」这一步——那是
 * 浏览器的缺省动作，不是 DOM 事件自带的——这里照浏览器补上：Enter 在 `keydown` 之后点击，空格在
 * `keyup` 之后点击；处理器拦了缺省动作就不点。发的是键盘事件，点击只由它们引出。
 * 只有原生的 `<button type="button">` 才有这个缺省动作：换成 `<div role="button">` 浏览器就不点了，
 * 所以不是它即抛错。
 */
export function pressKey(button: HTMLElement, key: "Enter" | " ") {
  if (!(button instanceof HTMLButtonElement) || button.type !== "button") {
    throw new Error('expected a native <button type="button">');
  }
  if (document.activeElement !== button) throw new Error("expected the button to have focus");
  const down = fireEvent.keyDown(button, { key });
  if (key === "Enter" && down) fireEvent.click(button);
  const up = fireEvent.keyUp(button, { key });
  if (key === " " && down && up) fireEvent.click(button);
}

/** 树的拖放写进 `dataTransfer` 的自定义类型（手写，不从实现导入）。 */
export const ENTRY_DRAG = "application/x-workbuddy-entry";

/**
 * 一次拖动的 `dataTransfer` 桩：jsdom 没有 `DragEvent` 与 `DataTransfer`，`fireEvent` 把给它的对象原样
 * 挂到事件上，同一次拖动的各事件共用一个。`types` 是 `foreign`（预置的外来类型，如 `Files`）加上
 * `setData` 写过的类型。
 */
export function dragTransfer(foreign: string[] = []) {
  const data = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [],
    items: [],
    get types() {
      return [...foreign, ...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

type Transfer = ReturnType<typeof dragTransfer>;

/** 拖着 `transfer` 经过 `target`（不经本树的 `dragstart`）；返回值：这一行是否接受放下（拦了缺省动作）。 */
export function hoverOver(target: Element, transfer: Transfer) {
  fireEvent.dragEnter(target, { dataTransfer: transfer });
  return fireEvent.dragOver(target, { dataTransfer: transfer }) === false;
}

/** 从 `source` 拖起、经过 `target`，还没放下。`accepted`：`target` 是否接受放下。 */
export function dragOnto(source: Element, target: Element, transfer = dragTransfer()) {
  fireEvent.dragStart(source, { dataTransfer: transfer });
  return { accepted: hoverOver(target, transfer), transfer };
}

/**
 * 在 `target` 上放下并结束拖动。真实浏览器在不接受的行上不发 `drop`，这里照发：「不接受」的用例因此
 * 另断言放下之后没有请求。
 */
export function dropOn(source: Element, target: Element, transfer: Transfer) {
  fireEvent.drop(target, { dataTransfer: transfer });
  fireEvent.dragEnd(source, { dataTransfer: transfer });
}

/**
 * 已展开的目录 `directory`（按行上的名字，根是空间名）直属的、名字逐字为 `name` 的行按钮。树上别处有
 * 同名的行、或名字带首尾空格（角色查询会折掉）时用它：行按钮的 `title` 就是列表里的名字。
 */
export function rowIn(directory: string, name: string) {
  const item = screen.getByRole("button", { name: `折叠 ${directory}` }).closest("li");
  const rows = item?.querySelectorAll<HTMLButtonElement>(":scope > ul > li > button[title]");
  const found = [...(rows ?? [])].find((button) => button.title === name);
  if (!found) throw new Error(`expected a row named ${JSON.stringify(name)} in ${directory}`);
  return found;
}

/** 拷入层 `dialog` 的遮罩。 */
export function overlay() {
  const element = document.querySelector('[data-slot="dialog-overlay"]');
  if (!element) throw new Error("expected the dialog overlay");
  return element;
}

/** `折叠 <目录>` 那一行之下的各行名字。对话框开着（树被标成 aria-hidden）的时候也能用。 */
export function rowsUnder(directory: string) {
  const names = screen
    .getByRole("button", { name: `折叠 ${directory}`, hidden: true })
    .closest("li")
    ?.querySelectorAll(':scope > ul [data-slot="tree-name"]');
  return [...(names ?? [])].map((node) => node.textContent);
}

export function dialogGone(name = "重命名") {
  return waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
}

export function focusedOn(element: () => Element) {
  return waitFor(() => expect(document.activeElement).toBe(element()));
}
