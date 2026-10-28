/**
 * #1823：files-web「文件操作界面」的场景「挂载内的移动范围」与 workspace-mounts「挂载内条目的行菜单」的场景
 * 「只读挂载内的移动」——文件页。会话页侧边栏的那一例在 chat-workspace-sidebar-mount-menu.test.tsx。
 *
 * 接缝：文件页的真实外壳（桩掉的 `fetch`，`openFiles` 夹具）；挂载列表由 `GET …/mounts` 应答。`远端`、`远端2`
 * 是挂载，根下普通目录 `远端备份` 只是名字以 `远端` 开头。期望值是规格里的字面量：下拉的候选与文字、`move` 的
 * 请求体（目标目录 + `/` + 原名，手写，不经 `moveTargets` / `moveDestination` 算）、信封 message。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findRow, row, settle } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  dialogGone,
  dirEntry,
  dragOnto,
  dropOn,
  expand,
  fileEntry,
  highlighted,
  type Listings,
  MOVE,
  moveButton,
  moveInto,
  notices,
  openFiles,
  rowIn,
  sftpMount,
  targetSelect,
} from "./files-ops-support.js";
import { jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const ROOT = "设计文档";
const MOUNT = "远端";
const OTHER = "远端2";
const NEAR = "远端备份";
const READ_ONLY = "只读区";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/**
 * 根下普通目录 `out`、`远端备份` 与文件 `a.md`（服务端不列出挂载点）；挂载 `远端` 里是目录 `d`（内有 `a.md`）
 * 与 `notes.txt`，挂载 `远端2` 里是 `b.md`，只读挂载 `只读区` 里是目录 `sub` 与 `a.txt`。
 */
const scene = (): Listings => ({
  "": [dirEntry("out"), dirEntry(NEAR), fileEntry("a.md")],
  out: [],
  [NEAR]: [fileEntry("x.md")],
  [MOUNT]: [dirEntry("d"), fileEntry("notes.txt")],
  [`${MOUNT}/d`]: [fileEntry("a.md")],
  [OTHER]: [fileEntry("b.md")],
  [READ_ONLY]: [dirEntry("sub"), fileEntry("a.txt")],
  [`${READ_ONLY}/sub`]: [],
});

const mountList = () => ({
  enabled: true,
  mounts: [
    sftpMount(MOUNT),
    { ...sftpMount(OTHER), id: "m-2" },
    { ...sftpMount(READ_ONLY), id: "m-3", readOnly: true },
  ],
});

/** 打开 `scene()`，等挂载根行出现（「在挂载内」按列表判定，不是列表未到时的回退），再依次展开 `expanded`。 */
async function openScene(move?: () => Response, expanded = ["out", NEAR, MOUNT, "d"]) {
  const listings = scene();
  const page = openFiles(listings, {
    [MOUNTS]: () => jsonResponse(mountList()),
    ...(move ? { [MOVE]: move } : {}),
  });
  await findRow(`展开 ${MOUNT}`);
  for (const name of expanded) await expand(name);
  return { ...page, listings };
}

/** 经 `rowButton` 那一行（树里另有同名的行时用它）自己的行菜单打开 `移动到` 对话框。 */
async function openMoveAt(rowButton: HTMLElement) {
  const item = rowButton.closest("li") as HTMLElement;
  const [trigger] = within(item).getAllByRole("button", { name: `更多操作 ${rowButton.title}` });
  await yieldMacrotask();
  pressPointer(trigger as HTMLElement);
  fireEvent.click(
    within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移动到…" }),
  );
  return screen.findByRole("dialog", { name: "移动到" });
}

const options = (dialog: HTMLElement) =>
  [...targetSelect(dialog).options].map((option) => [option.value, option.textContent]);

describe("挂载内的移动范围：移动到…", () => {
  it("远端/d/a.md 的下拉恰为 远端（显示挂载名）；选它提交恰一次 POST move {from:远端/d/a.md, to:远端/a.md}", async () => {
    const { listings, moves } = await openScene(() => {
      listings[MOUNT] = [dirEntry("d"), fileEntry("notes.txt"), fileEntry("a.md")];
      listings[`${MOUNT}/d`] = [];
      return jsonResponse({ path: `${MOUNT}/a.md` });
    });
    const dialog = await openMoveAt(rowIn("d", "a.md"));
    expect(options(dialog)).toStrictEqual([[MOUNT, MOUNT]]);

    moveInto(dialog, MOUNT);
    await dialogGone("移动到");
    await settle();
    expect(moves().map(([, init]) => init?.body)).toStrictEqual([
      JSON.stringify({ from: `${MOUNT}/d/a.md`, to: `${MOUNT}/a.md` }),
    ]);
    await waitFor(() => expect(rowIn(MOUNT, "a.md")).toBeTruthy());
  });

  it("远端/notes.txt 的下拉恰为 远端/d（没有根、挂载外目录与它的父目录 远端）", async () => {
    await openScene();
    const dialog = await openMoveAt(rowIn(MOUNT, "notes.txt"));
    expect(options(dialog)).toStrictEqual([[`${MOUNT}/d`, `${MOUNT}/d`]]);
  });

  it("挂载外的 a.md（远端、远端/d 也展开着）：下拉恰为 out、远端备份，不含 远端 与 远端/d", async () => {
    await openScene();
    const dialog = await openMoveAt(rowIn(ROOT, "a.md"));
    expect(options(dialog).map(([value]) => value)).toStrictEqual(["out", NEAR]);
  });
});

describe("挂载内的移动范围：拖放", () => {
  it.each([
    ["根下 a.md → 挂载内目录 远端/d", () => rowIn(ROOT, "a.md"), () => row("折叠 d")],
    ["远端/notes.txt → 根行", () => rowIn(MOUNT, "notes.txt"), () => row(`折叠 ${ROOT}`)],
    ["远端/notes.txt → 普通目录 out", () => rowIn(MOUNT, "notes.txt"), () => row("折叠 out")],
    ["另一挂载的 远端2/b.md → 远端/d", () => rowIn(OTHER, "b.md"), () => row("折叠 d")],
    [
      "远端/d/a.md → 挂载根行 远端（挂载根只经下拉）",
      () => rowIn("d", "a.md"),
      () => row(`折叠 ${MOUNT}`),
    ],
  ])("%s：不接受放下、不高亮，硬发 drop 之后也没有请求", async (_case, from, onto) => {
    const { mark } = await openScene(
      () => jsonResponse({ path: "不该走到" }),
      ["out", MOUNT, "d", OTHER],
    );
    const since = mark();

    const { accepted, transfer } = dragOnto(from(), onto());
    expect(accepted).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    dropOn(from(), onto(), transfer);
    await settle();
    expect(since()).toStrictEqual([]);
    expect(notices()).toStrictEqual([]);
  });

  it("远端/notes.txt → 同一挂载内的 远端/d：高亮，放下恰一次 POST move {from:远端/notes.txt, to:远端/d/notes.txt}", async () => {
    const { listings, moves } = await openScene(() => {
      listings[MOUNT] = [dirEntry("d")];
      listings[`${MOUNT}/d`] = [fileEntry("a.md"), fileEntry("notes.txt")];
      return jsonResponse({ path: `${MOUNT}/d/notes.txt` });
    });
    const source = rowIn(MOUNT, "notes.txt");
    const target = row("折叠 d");

    const { accepted, transfer } = dragOnto(source, target);
    expect(accepted).toBe(true);
    expect(highlighted()).toStrictEqual(["折叠 d"]);
    dropOn(source, target, transfer);
    await waitFor(() => expect(rowIn("d", "notes.txt")).toBeTruthy());
    await settle();
    expect(moves().map(([, init]) => init?.body)).toStrictEqual([
      JSON.stringify({ from: `${MOUNT}/notes.txt`, to: `${MOUNT}/d/notes.txt` }),
    ]);
    expect(notices()).toStrictEqual([]);
  });
});

describe("只读挂载内的移动", () => {
  it("只读区/a.txt 的下拉恰为 只读区/sub；提交收 403 mount_read_only → 框内显示信封 message，对话框仍开", async () => {
    const message = "只读挂载不能写入";
    const { moves } = await openScene(
      () => jsonResponse({ error: { code: "mount_read_only", message } }, 403),
      [READ_ONLY, "sub"],
    );
    const dialog = await openMoveAt(rowIn(READ_ONLY, "a.txt"));
    expect(options(dialog)).toStrictEqual([[`${READ_ONLY}/sub`, `${READ_ONLY}/sub`]]);

    fireEvent.click(moveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
    await settle();
    expect(screen.getByRole("dialog", { name: "移动到" })).toBe(dialog);
    expect(moves().map(([, init]) => init?.body)).toStrictEqual([
      JSON.stringify({ from: `${READ_ONLY}/a.txt`, to: `${READ_ONLY}/sub/a.txt` }),
    ]);
  });
});
