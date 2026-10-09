// 输入框附件的整页用例共用的查询与动作：隐藏的文件框、`FakeXhr` 上的上传应答、附件区的标签、「+」菜单。
import { act, fireEvent, screen, within } from "@testing-library/react";
import { quiesce } from "./chat-page-file-changes-support.js";
import { FakeXhr } from "./upload-support.js";

export function file(name: string, size = 10) {
  return new File([new Uint8Array(size)], name);
}

export function fileInput() {
  const input = document.querySelector('[data-slot="composer-file-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("没有文件输入框");
  return input;
}

export async function choose(...files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
  await quiesce();
}

export function xhr(index: number) {
  const request = FakeXhr.instances[index];
  if (!request) throw new Error(`没有第 ${index + 1} 个上传请求`);
  return request;
}

/** 第 `index` 个上传请求应答 201，文件落在 `uploads/<name>`。 */
export async function land(index: number, name: string, size = 10) {
  act(() => xhr(index).respond(201, JSON.stringify({ path: `uploads/${name}`, name, size })));
  await quiesce();
}

/** 输入框的附件区；用户气泡里也有名为 `附件` 的列表，所以按 slot 取。 */
export function area() {
  return document.querySelector<HTMLElement>('[data-slot="composer-attachments"]');
}

/** 每个标签的全部文字：名字、大小、状态。 */
export function chips() {
  const list = area();
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    : [];
}

export function statuses() {
  const list = area();
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("data-status"))
    : [];
}

export function send() {
  return screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
}

export function remove(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `移除 ${name}` }));
}

export function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

function plusButton() {
  return screen.getByRole("button", { hidden: true, name: "添加文件或命令" }) as HTMLButtonElement;
}

export async function openMenu() {
  fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  await quiesce();
  return menu;
}

export function uploadItem(menu: HTMLElement) {
  const first = within(menu).getAllByRole("menuitem")[0];
  if (!first) throw new Error("菜单里没有条目");
  return first;
}
