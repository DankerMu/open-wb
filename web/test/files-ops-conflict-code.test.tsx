/**
 * #1823：409 按 `code` 提示——files-web「文件操作界面」的场景「move 的 409 按 code 提示」与「工作空间页」的
 * `新建文件夹`。只有 `code` 为 `conflict` 的 409 显示固定的同名文案，其它 409（挂载的 `mount_boundary`、
 * `mount_offline`）显示应答信封的 message。
 *
 * 接缝：文件页的真实外壳（桩掉的 `fetch`，`openFiles` 夹具）。期望值是规格里的字面量与应答信封里的 message；
 * 每一种 code 的信封 message 各不相同且不等于任何固定文案。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findRow, row, settle } from "./files-deep-link-support.js";
import { cleanupFilesFixture, openDirectoryDialog } from "./files-fixture.js";
import {
  dirEntry,
  dragOnto,
  dropOn,
  expand,
  fileEntry,
  type Listings,
  MOVE,
  moveButton,
  notices,
  openFiles,
  openMove,
  openRename,
  renameTo,
} from "./files-ops-support.js";
import { jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const DIRS = "/api/workspaces/workspace-1/dirs";
const MOVE_SAME = "目标位置已存在同名条目";
const DIALOG_SAME = "该目录下已存在同名条目";
const ENVELOPES = {
  conflict: "信封里的冲突文案",
  mount_boundary: "不能跨越挂载边界",
  mount_offline: "挂载离线，请稍后重试",
} as const;
type Code = keyof typeof ENVELOPES;

const answer409 = (code: Code) => () =>
  jsonResponse({ error: { code, message: ENVELOPES[code] } }, 409);

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 根下已展开的目录 `out` 与文件 `a.md`。 */
const scene = (): Listings => ({ "": [dirEntry("out"), fileEntry("a.md")], out: [] });

async function openScene(routes: Parameters<typeof openFiles>[1]) {
  const page = openFiles(scene(), routes);
  await expand("out");
  return page;
}

/** 每种 code 期望显示的文字：`conflict` 是固定文案 `same`，其余是信封 message。 */
const cases = (same: string) =>
  (Object.keys(ENVELOPES) as Code[]).map((code) => [
    code,
    code === "conflict" ? same : ENVELOPES[code],
  ]);

describe("move 的 409 按 code 提示", () => {
  it.each(cases(MOVE_SAME))("移动到… 收 409 %s：框内显示 %s，对话框仍开", async (code, shown) => {
    await openScene({ [MOVE]: answer409(code as Code) });
    const dialog = await openMove("a.md");

    fireEvent.click(moveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(shown);
    await settle();
    expect(screen.getByRole("dialog", { name: "移动到" })).toBe(dialog);
  });

  it.each(cases(MOVE_SAME))("拖放收 409 %s：树区上方显示 %s", async (code, shown) => {
    await openScene({ [MOVE]: answer409(code as Code) });
    const source = await findRow("a.md");
    const target = row("折叠 out");

    const { accepted, transfer } = dragOnto(source, target);
    expect(accepted).toBe(true);
    dropOn(source, target, transfer);
    await waitFor(() => expect(notices()).toStrictEqual([shown]));
  });

  it.each(cases(DIALOG_SAME))("重命名收 409 %s：框内显示 %s，对话框仍开", async (code, shown) => {
    await openScene({ [MOVE]: answer409(code as Code) });
    const dialog = await openRename("a.md");

    renameTo(dialog, "b.md");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(shown);
    await settle();
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
  });
});

describe("新建文件夹的 409 按 code 提示", () => {
  it.each(cases(DIALOG_SAME))("收 409 %s：框内显示 %s，对话框仍开", async (code, shown) => {
    await openScene({ [DIRS]: answer409(code as Code) });
    const dialog = await openDirectoryDialog();

    fireEvent.change(within(dialog).getByLabelText("文件夹名称"), { target: { value: "新" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(shown);
    await settle();
    expect(screen.getByRole("dialog", { name: "新建文件夹" })).toBe(dialog);
  });
});
