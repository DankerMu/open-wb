import { pageNotices } from "./page-notices.js";
// files-web「文件操作界面」的「拖拽移动」：哪些行可拖、哪些行接受放下、经过时的高亮、放下发出的请求、
// 失败文案的位置与清除、放下之后的跟随。期望值按规格的场景手写；`to` 的写法（目标目录 + `/` + 原名，
// 目标是根时只有原名）按 `POST …/move` 的请求体约定手写，不经 `canMoveInto` / `moveDestination` 算。
// 拖放用 `dataTransfer` 打桩的 dragstart / dragenter / dragover / drop / dragend 事件驱动（jsdom 没有
// `DragEvent`）：「接受放下」即 `dragover` 的缺省动作被拦；真实浏览器里的拖动另在 PR 描述里记实测。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  address,
  findRow,
  previewRegion,
  row,
  rowNames,
  selectedRow,
  settle,
  tree,
} from "./files-deep-link-support.js";
import { cleanupFilesFixture, expectLocation } from "./files-fixture.js";
import {
  cancelButton,
  confirmButton,
  confirmGone,
  deleted,
  dialogGone,
  dirEntry,
  dragOnto,
  dragTransfer,
  dropOn,
  ENTRY_DRAG,
  entriesUrl,
  expand,
  fileEntry,
  fileUrl,
  focusedOn,
  highlighted,
  hoverOver,
  type Listings,
  MOVE,
  menuButton,
  nested,
  notices,
  openDelete,
  openFiles,
  openRename,
  renameTo,
  rowIn,
  rowsUnder,
  treeUrl,
} from "./files-ops-support.js";
import {
  createFetchMock,
  deferredResponse,
  jsonResponse,
  paths,
  textPreviewResponse,
} from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const CONFLICT = () =>
  jsonResponse({ error: { code: "conflict", message: "信封里的冲突文案" } }, 409);
const SAME_NAME = "目标位置已存在同名条目";
const A_TO_OUT = `POST ${MOVE} {"from":"a.md","to":"out/a.md"}`;
const B_TO_ROOT = `POST ${MOVE} {"from":"out/b.md","to":"b.md"}`;
const ROOT = "设计文档";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 规格场景「拖拽」的树：根下目录 `out` 与 `a.md`、`b.md`；`out` 里有子目录 `sub` 与另一个 `b.md`。 */
const scene = (): Listings => ({
  "": [dirEntry("out"), fileEntry("a.md"), fileEntry("b.md")],
  out: [dirEntry("sub"), fileEntry("b.md")],
  "out/sub": [],
});

/** `scene()` 在根下的 `a.md` 移进 `out` 之后的样子。 */
function landed(listings: Listings) {
  listings[""] = [dirEntry("out"), fileEntry("b.md")];
  listings.out = [dirEntry("sub"), fileEntry("b.md"), fileEntry("a.md")];
  return jsonResponse({ path: "out/a.md" });
}

/** 展开 `out`，把 `out/b.md` 拖到根行上放下：根下已有 `b.md`，服务端答 409。 */
async function conflictOnRoot() {
  await expand("out");
  const source = rowIn("out", "b.md");
  const dragged = dragOnto(source, row(`折叠 ${ROOT}`));
  dropOn(source, row(`折叠 ${ROOT}`), dragged.transfer);
  await waitFor(() => expect(notices()).toStrictEqual([SAME_NAME]));
  return dragged;
}

describe("拖拽", () => {
  it("D1 a.md 拖到未展开的 out 上：经过时 out 行高亮；放下后恰一次 POST move {from, to}，根与 out 各重新请求一次，高亮消失，out 展开且含 a.md，焦点在新行的更多操作上", async () => {
    const listings = scene();
    const { mark } = openFiles(listings, { [MOVE]: () => landed(listings) });
    const source = await findRow("a.md");
    const target = row("展开 out");
    expect(highlighted()).toStrictEqual([]);
    const since = mark();

    const { accepted, transfer } = dragOnto(source, target);
    expect(accepted).toBe(true);
    expect(highlighted()).toStrictEqual(["展开 out"]);
    expect(target.getAttribute("data-drop-target")).toBe("true");
    // 写进拖动数据的只有自定义类型一项，没有文字类型：拖进输入框不会插入路径。
    expect(transfer.types).toStrictEqual([ENTRY_DRAG]);
    expect([transfer.effectAllowed, transfer.dropEffect]).toStrictEqual(["move", "move"]);
    expect(since()).toStrictEqual([]);

    // 高亮在 drop 里就清：移动成功后源行卸载，它的 dragend 到不了。
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(highlighted()).toStrictEqual([]);
    fireEvent.dragEnd(source, { dataTransfer: transfer });
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "a.md"]));
    const landing = () =>
      within(row("折叠 out").closest("li") as HTMLElement).getByRole("button", {
        name: "更多操作 a.md",
      });
    await focusedOn(landing);
    await settle();
    expect(row("折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toStrictEqual([ROOT, "out", "sub", "b.md", "a.md", "b.md"]);
    expect(since()).toStrictEqual([A_TO_OUT, treeUrl(""), treeUrl("out")]);
    expect(document.activeElement).toBe(landing());
    expect(highlighted()).toStrictEqual([]);
    expect(notices()).toStrictEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["D2 目录 out 拖到它自己的子目录 out/sub 上", "out", "sub"],
    ["D3 out/b.md 拖到它当前的父目录 out 上", "b.md", "out"],
    ["D3b 目录 out 拖到它自己这一行上", "out", "out"],
    ["D3c 目录 out/sub 拖到它当前的父目录 out 上", "sub", "out"],
  ])("%s：不接受放下、没有高亮，硬发 drop 之后也没有请求", async (_case, from, onto) => {
    const { mark } = openFiles(scene(), { [MOVE]: () => jsonResponse({ path: "不该走到" }) });
    await expand("out");
    await expand("sub");
    const rowOf = (name: string) => (name === "out" ? row("折叠 out") : rowIn("out", name));
    const since = mark();

    const { accepted, transfer } = dragOnto(rowOf(from), rowOf(onto));
    expect(accepted).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    dropOn(rowOf(from), rowOf(onto), transfer);
    await settle();
    expect(since()).toStrictEqual([]);
    expect(notices()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual([ROOT, "out", "sub", "b.md", "a.md", "b.md"]);
  });

  it("D3d 根下的 a.md 拖到根行（它当前的父目录）上：不接受、没有请求", async () => {
    const { mark } = openFiles(scene(), { [MOVE]: () => jsonResponse({ path: "不该走到" }) });
    const source = await findRow("a.md");
    const since = mark();

    const { accepted, transfer } = dragOnto(source, row(`折叠 ${ROOT}`));
    expect(accepted).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    dropOn(source, row(`折叠 ${ROOT}`), transfer);
    await settle();
    expect(since()).toStrictEqual([]);
  });

  it("D4 out/b.md 拖到根行上而根下已有 b.md：根行高亮，发出请求，409 后树区上方（目录树之外）出现固定的同名文案，树不变、不重列，没有对话框、没有 Toast", async () => {
    const { mark } = openFiles(scene(), { [MOVE]: CONFLICT });
    await expand("out");
    const source = rowIn("out", "b.md");
    const root = row(`折叠 ${ROOT}`);
    const since = mark();

    const { accepted, transfer } = dragOnto(source, root);
    expect(accepted).toBe(true);
    expect(highlighted()).toStrictEqual([`折叠 ${ROOT}`]);
    dropOn(source, root, transfer);
    expect(highlighted()).toStrictEqual([]);

    const column = screen.getByRole("complementary", { name: "工作空间文件" });
    const alert = await within(column).findByRole("alert");
    expect(alert.textContent).toBe(SAME_NAME);
    expect(alert.closest("nav")).toBeNull();
    // 文案在目录树之前：树区的上方。
    expect(alert.compareDocumentPosition(tree()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await settle();
    await yieldMacrotask();
    expect(screen.getAllByRole("alert")).toStrictEqual([alert]);
    expect(rowNames()).toStrictEqual([ROOT, "out", "sub", "b.md", "a.md", "b.md"]);
    expect(since()).toStrictEqual([B_TO_ROOT]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // 整页的提示面只有树区上方的这一条（应用里已没有 Toast 组件，#1398）。
    expect(pageNotices()).toEqual([`alert:${SAME_NAME}`]);
  });

  it.each([
    [403, "forbidden", "路径越出工作空间", ["路径越出工作空间"]],
    [401, "unauthorized", "登录已失效", []],
  ])(
    "D5 服务端答 %i：树区上方显示的是信封文案（401 不显示），树不变、不重列；之后的拖动照常被接受",
    async (status, code, message, shown) => {
      // 整页上 401 会把页面换成登录页；直接渲染组件，看的是拖放自己做了什么。
      const fetchMock = createFetchMock({
        [treeUrl("")]: () =>
          jsonResponse({ path: "", entries: [dirEntry("out"), fileEntry("a.md")] }),
        [MOVE]: () => jsonResponse({ error: { code, message } }, status),
      });
      vi.stubGlobal("fetch", fetchMock);
      render(
        <WorkspaceBrowser
          account="zhangsan"
          client={createApiClient()}
          onPathChange={() => {}}
          path={null}
          workspaceId="workspace-1"
        />,
      );
      const source = await findRow("a.md");

      const { transfer } = dragOnto(source, row("展开 out"));
      dropOn(source, row("展开 out"), transfer);
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([path]) => path === MOVE)).toHaveLength(1),
      );
      await settle();
      expect(notices()).toStrictEqual(shown);
      expect(rowNames()).toStrictEqual(["工作空间", "out", "a.md"]);
      expect(paths(fetchMock)).toStrictEqual([treeUrl(""), MOVE]);
      expect(dragOnto(source, row("展开 out")).accepted).toBe(true);
    },
  );

  it("D6 失败文案的清除：只拖起、被拒绝的放下、点刷新都不清；下一次被接受的放下发出请求时即清（应答还没回来）", async () => {
    const held = deferredResponse();
    const answers = [CONFLICT, () => held.promise];
    const listings = scene();
    const { moves } = openFiles(listings, { [MOVE]: () => (answers.shift() ?? CONFLICT)() });
    await conflictOnRoot();

    const source = rowIn(ROOT, "a.md");
    fireEvent.dragStart(source, { dataTransfer: dragTransfer() });
    fireEvent.dragEnd(source);
    expect(notices()).toStrictEqual([SAME_NAME]);

    const refused = dragOnto(rowIn("out", "b.md"), row("折叠 out"));
    expect(refused.accepted).toBe(false);
    dropOn(rowIn("out", "b.md"), row("折叠 out"), refused.transfer);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await settle();
    expect(notices()).toStrictEqual([SAME_NAME]);
    expect(moves()).toHaveLength(1);

    const { accepted, transfer } = dragOnto(source, row("折叠 out"));
    expect(accepted).toBe(true);
    expect(notices()).toStrictEqual([SAME_NAME]);
    dropOn(source, row("折叠 out"), transfer);
    expect(notices()).toStrictEqual([]);
    expect(moves()).toHaveLength(2);

    await act(async () => {
      held.resolve(landed(listings));
    });
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "a.md"]));
    expect(notices()).toStrictEqual([]);
  });

  it.each([
    [
      "重命名",
      async (listings: Listings) => {
        listings[""] = [dirEntry("out"), fileEntry("c.md"), fileEntry("b.md")];
        renameTo(await openRename("a.md"), "c.md");
        await dialogGone();
        await findRow("c.md");
      },
    ],
    [
      "删除",
      async (listings: Listings) => {
        listings[""] = [dirEntry("out"), fileEntry("b.md")];
        fireEvent.click(confirmButton(await openDelete("a.md")));
        await confirmGone();
      },
    ],
  ])("D6b 失败文案在下一次成功的条目操作（%s）之后消失", async (_case, operate) => {
    const answers = [CONFLICT];
    const listings = scene();
    openFiles(listings, {
      [MOVE]: () => (answers.shift() ?? (() => jsonResponse({ path: "c.md" })))(),
      [entriesUrl("a.md")]: deleted,
    });
    await conflictOnRoot();

    await operate(listings);
    await settle();
    expect(notices()).toStrictEqual([]);
  });

  it("D6c 对话框只打开又取消（没有成功的操作）：失败文案还在", async () => {
    openFiles(scene(), { [MOVE]: CONFLICT });
    await conflictOnRoot();

    fireEvent.click(cancelButton(await openRename("a.md")));
    await dialogGone();
    await settle();
    expect(notices()).toStrictEqual([SAME_NAME]);
  });

  it("D7 高亮按进入次数算：进到行内的子元素、再离开行，仍高亮，再离开一次才消失；进入另一行即换过去；不经 drop 的 dragend 也清掉", async () => {
    openFiles(scene());
    await expand("out");
    const source = rowIn(ROOT, "a.md");
    const out = row("折叠 out");
    const inside = out.querySelector('[data-slot="tree-name"]') as HTMLElement;
    const transfer = dragTransfer();
    const over = { dataTransfer: transfer };
    fireEvent.dragStart(source, over);

    fireEvent.dragEnter(out, over);
    fireEvent.dragEnter(inside, over);
    fireEvent.dragLeave(out, over);
    expect(highlighted()).toStrictEqual(["折叠 out"]);
    fireEvent.dragLeave(inside, over);
    expect(highlighted()).toStrictEqual([]);

    // 多出来的一次离开不欠账：下一次进入照常高亮。
    fireEvent.dragLeave(out, over);
    fireEvent.dragEnter(out, over);
    expect(highlighted()).toStrictEqual(["折叠 out"]);

    // 真实浏览器先发新行的 dragenter、后发旧行的 dragleave。
    const sub = rowIn("out", "sub");
    fireEvent.dragEnter(sub, over);
    expect(highlighted()).toStrictEqual(["展开 sub"]);
    fireEvent.dragLeave(out, over);
    expect(highlighted()).toStrictEqual(["展开 sub"]);

    fireEvent.dragEnd(source, over);
    expect(highlighted()).toStrictEqual([]);
    // 拖动已结束：同一份数据再经过也不被接受。
    expect(hoverOver(out, transfer)).toBe(false);
    expect(highlighted()).toStrictEqual([]);
  });

  it("D8 文件行不是放下目标：a.md 拖到 b.md 上不接受、没有高亮，硬发 drop 之后没有请求", async () => {
    const { mark } = openFiles(scene(), { [MOVE]: () => jsonResponse({ path: "不该走到" }) });
    const source = await findRow("a.md");
    const since = mark();

    const { accepted, transfer } = dragOnto(source, row("b.md"));
    expect(accepted).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    dropOn(source, row("b.md"), transfer);
    await settle();
    expect(since()).toStrictEqual([]);
  });

  it("D9 放下的请求挂起时：第二次拖动不被接受、没有高亮，硬发 drop 仍恰一次 POST；应答回来后又接受；卸载时在途的请求被中止，迟到的应答不报错", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const answers = [first, second];
    const listings = scene();
    const { fetchMock, moves, view } = openFiles(listings, {
      [MOVE]: () => (answers.shift() ?? second).promise,
    });
    const source = await findRow("a.md");
    const started = dragOnto(source, row("展开 out"));
    dropOn(source, row("展开 out"), started.transfer);
    expect(moves()).toHaveLength(1);

    const blocked = dragOnto(row("b.md"), row("展开 out"));
    expect(blocked.accepted).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    dropOn(row("b.md"), row("展开 out"), blocked.transfer);
    await settle();
    expect(moves()).toHaveLength(1);
    expect(moves()[0]?.[1]?.signal?.aborted).toBe(false);

    await act(async () => {
      first.resolve(landed(listings));
    });
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "a.md"]));
    await settle();
    const next = dragOnto(rowIn(ROOT, "b.md"), rowIn("out", "sub"));
    expect(next.accepted).toBe(true);
    dropOn(rowIn(ROOT, "b.md"), rowIn("out", "sub"), next.transfer);
    expect(moves().map(([, options]) => options?.body)).toStrictEqual([
      '{"from":"a.md","to":"out/a.md"}',
      '{"from":"b.md","to":"out/sub/b.md"}',
    ]);
    expect(moves()[1]?.[1]?.signal?.aborted).toBe(false);

    view.unmount();
    expect(moves()[1]?.[1]?.signal?.aborted).toBe(true);
    // 迟到的成功应答不交付：不跟随，因此也没有随之而来的 tree 请求。
    const requests = fetchMock.mock.calls.length;
    await act(async () => {
      second.resolve(jsonResponse({ path: "out/sub/b.md" }));
    });
    await settle();
    expect(fetchMock.mock.calls).toHaveLength(requests);
  });
});

describe("拖拽：不是从本树拖起的拖动", () => {
  it("D10 没有本树的 dragstart：带 Files 的拖动、带同一自定义类型与一条路径的拖动，在目录行与根行上都不被接受，硬发 drop 没有请求", async () => {
    const { mark } = openFiles(scene(), { [MOVE]: () => jsonResponse({ path: "不该走到" }) });
    await expand("out");
    const since = mark();
    const forged = dragTransfer();
    forged.setData(ENTRY_DRAG, "out/b.md");
    const both = dragTransfer(["Files"]);
    both.setData(ENTRY_DRAG, "out/b.md");

    for (const transfer of [dragTransfer(["Files"]), forged, both]) {
      for (const target of [rowIn("out", "sub"), row(`折叠 ${ROOT}`)]) {
        expect(hoverOver(target, transfer)).toBe(false);
        expect(highlighted()).toStrictEqual([]);
        fireEvent.drop(target, { dataTransfer: transfer });
      }
    }
    await settle();
    expect(since()).toStrictEqual([]);
  });

  it("D10b 从本树拖起之后换成别的拖动数据：不带自定义类型的不被接受；带着另一条路径的，放下时对不上，没有请求——路径不从拖动数据里取", async () => {
    const { mark } = openFiles(scene(), { [MOVE]: () => jsonResponse({ path: "不该走到" }) });
    const source = await findRow("a.md");
    const target = row("展开 out");
    const since = mark();

    fireEvent.dragStart(source, { dataTransfer: dragTransfer() });
    const files = dragTransfer(["Files"]);
    expect(hoverOver(target, files)).toBe(false);
    expect(highlighted()).toStrictEqual([]);
    fireEvent.drop(target, { dataTransfer: files });
    // 被拒绝的放下也结束了这次拖动：没有 dragend、没有新的 dragstart，带着原路径的同类型数据不再被接受。
    const stale = dragTransfer();
    stale.setData(ENTRY_DRAG, "a.md");
    expect(hoverOver(target, stale)).toBe(false);
    expect(highlighted()).toStrictEqual([]);

    fireEvent.dragStart(source, { dataTransfer: dragTransfer() });
    const other = dragTransfer();
    other.setData(ENTRY_DRAG, "b.md");
    fireEvent.drop(target, { dataTransfer: other });
    await settle();
    expect(since()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual([ROOT, "out", "a.md", "b.md"]);
  });

  it("D11 根行不可拖，其余各行可拖；onlyPaths 生效期间哪一行都不可拖、拖放事件不起作用，撤掉后又可拖", async () => {
    const fetchMock = createFetchMock({
      [treeUrl("")]: () =>
        jsonResponse({ path: "", entries: [dirEntry("out"), fileEntry("notes.md")] }),
      [MOVE]: () => jsonResponse({ path: "不该走到" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();
    const browser = (onlyPaths?: ReadonlySet<string>) => (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        onlyPaths={onlyPaths}
        onPathChange={() => {}}
        path={null}
        workspaceId="workspace-1"
      />
    );
    const rows = () => [...tree().querySelectorAll<HTMLButtonElement>("li > button[title]")];
    const draggable = () =>
      rows().map((button) => [button.title, button.getAttribute("draggable")]);
    const view = render(browser());
    await findRow("notes.md");
    expect(draggable()).toStrictEqual([
      ["工作空间", null],
      ["out", "true"],
      ["notes.md", "true"],
    ]);
    // 行菜单的按钮不可拖。
    expect(menuButton("notes.md").getAttribute("draggable")).toBeNull();

    view.rerender(browser(new Set(["notes.md", "out/a.md"])));
    expect(draggable()).toStrictEqual([
      ["工作空间", null],
      ["out", null],
      ["a.md", null],
      ["notes.md", null],
    ]);
    const source = row("notes.md");
    const { accepted, transfer } = dragOnto(source, row("折叠 out"));
    expect(accepted).toBe(false);
    expect(transfer.types).toStrictEqual([]);
    expect(highlighted()).toStrictEqual([]);
    dropOn(source, row("折叠 out"), transfer);
    await settle();
    expect(paths(fetchMock)).toStrictEqual([treeUrl("")]);

    view.rerender(browser());
    expect(draggable()).toStrictEqual([
      ["工作空间", null],
      ["out", "true"],
      ["notes.md", "true"],
    ]);
  });
});

describe("拖拽之后的跟随", () => {
  it("D12 预览 out/a.md 时把目录 out 拖进未展开的 output：选中项与地址跟到 output/out/a.md，output 展开，out 与 out/sub 的展开跟过去且不重新请求；其后的请求恰为 POST、新路径的 file、根的 tree、output 的 tree", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("output/out/a.md")]: () => textPreviewResponse("拖过去之后的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("output"), fileEntry("top.md")];
          listings.output = [dirEntry("out"), fileEntry("o.md")];
          return jsonResponse({ path: "output/out" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    await expand("sub");
    const source = row("折叠 out");
    const target = row("展开 output");
    const since = mark();

    const { accepted, transfer } = dragOnto(source, target);
    expect(accepted).toBe(true);
    dropOn(source, target, transfer);
    await expectLocation("/files?ws=workspace-1&path=output%2Fout%2Fa.md");
    expect(await previewRegion().findByText("拖过去之后的正文", { exact: true })).toBeTruthy();
    await waitFor(() =>
      expect(rowsUnder("output")).toStrictEqual(["out", "sub", "x.md", "a.md", "b.md", "o.md"]),
    );
    await settle();
    await selectedRow("a.md");
    expect(row("折叠 sub").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toStrictEqual([
      ROOT,
      "output",
      "out",
      "sub",
      "x.md",
      "a.md",
      "b.md",
      "o.md",
      "top.md",
    ]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"output/out"}`,
      fileUrl("output/out/a.md"),
      treeUrl(""),
      treeUrl("output"),
    ]);
    await focusedOn(() => menuButton("out"));
  });

  it("D13 条目名与目标目录名都含首尾空格与 %、#、?：from 与 to 原样带着它们，不去空白、不解码、不编码", async () => {
    const name = " a%20b#c?.md ";
    const directory = " o%20ut ";
    const listings: Listings = { "": [dirEntry(directory), fileEntry(name)], [directory]: [] };
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [dirEntry(directory)];
        listings[directory] = [fileEntry(name)];
        return jsonResponse({ path: `${directory}/${name}` });
      },
    });
    await waitFor(() => expect(rowNames()).toStrictEqual([ROOT, directory, name]));
    // 按 `title` 逐字找：角色查询会把可访问名里的首尾空格折掉。
    const source = rowIn(ROOT, name);
    const target = rowIn(ROOT, directory);
    const since = mark();

    const { accepted, transfer } = dragOnto(source, target);
    expect(accepted).toBe(true);
    expect(transfer.getData(ENTRY_DRAG)).toBe(name);
    dropOn(source, target, transfer);
    await waitFor(() => expect(rowNames()).toStrictEqual([ROOT, directory, name]));
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":" a%20b#c?.md ","to":" o%20ut / a%20b#c?.md "}`,
      treeUrl(""),
      treeUrl(directory),
    ]);
    expect(target.getAttribute("aria-expanded")).toBe("true");
  });

  it("D13b 目录 out 里名为两个点的条目拖到根行上：from 与 to 原样送出，不折叠成父目录；服务端的拒绝文案显示在树区上方", async () => {
    // 列表是这里合成的：服务端的 `tree` 不会列出 `..`（#1101 的 D19b、#1102 的 M1c 同此，读代码推出）。
    // 这里只看界面拿到这样一行时送出什么——裁决是服务端的。
    const { mark } = openFiles(
      { "": [dirEntry("out")], out: [fileEntry("..")] },
      {
        [MOVE]: () =>
          jsonResponse({ error: { code: "forbidden", message: "路径越出工作空间" } }, 403),
      },
    );
    await expand("out");
    const source = rowIn("out", "..");
    const since = mark();

    const { accepted, transfer } = dragOnto(source, row(`折叠 ${ROOT}`));
    expect(accepted).toBe(true);
    dropOn(source, row(`折叠 ${ROOT}`), transfer);
    await waitFor(() => expect(notices()).toStrictEqual(["路径越出工作空间"]));
    await settle();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out/..","to":".."}`]);
  });

  it("D14 放下成功而目标层重列失败：out 展开、带着失败文案，新行没出现，焦点不动；之后刷新出新行，焦点也不被它拿走", async () => {
    const listings = scene();
    let failing = true;
    openFiles(listings, {
      [MOVE]: () => landed(listings),
      [treeUrl("out")]: () =>
        failing
          ? jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500)
          : jsonResponse({ path: "out", entries: listings.out }),
    });
    const source = await findRow("a.md");
    row("b.md").focus();

    const { transfer } = dragOnto(source, row("展开 out"));
    dropOn(source, row("展开 out"), transfer);
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    await settle();
    expect(row("折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toStrictEqual([ROOT, "out", "b.md"]);
    expect(notices()).toStrictEqual([]);
    expect(document.activeElement).toBe(row("b.md"));

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "a.md"]));
    await settle();
    expect(document.activeElement).toBe(rowIn(ROOT, "b.md"));
  });

  it("D15 源父目录的重列失败而目标层的成功：新行照样出现，焦点照样落在它的更多操作上（作废只看新行所在的那一层）", async () => {
    const listings = scene();
    let moved = false;
    openFiles(listings, {
      [MOVE]: () => {
        moved = true;
        listings["out/sub"] = [fileEntry("b.md")];
        return jsonResponse({ path: "out/sub/b.md" });
      },
      [treeUrl("out")]: () =>
        moved
          ? jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500)
          : jsonResponse({ path: "out", entries: listings.out }),
    });
    await expand("out");
    const source = rowIn("out", "b.md");

    const { accepted, transfer } = dragOnto(source, rowIn("out", "sub"));
    expect(accepted).toBe(true);
    dropOn(source, rowIn("out", "sub"), transfer);
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    await waitFor(() => expect(rowsUnder("sub")).toStrictEqual(["b.md"]));
    await focusedOn(() => rowIn("sub", "b.md").nextElementSibling as Element);
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("更多操作 b.md");
  });

  it.each([
    [
      "打开重命名对话框又取消",
      async () => {
        // 根下的那一行：`out` 展开后树上有两个 `b.md`。
        const trigger = rowIn(ROOT, "b.md").nextElementSibling as HTMLElement;
        await yieldMacrotask();
        pressPointer(trigger);
        fireEvent.click(
          within(await screen.findByRole("menu")).getByRole("menuitem", { name: "重命名" }),
        );
        fireEvent.click(cancelButton(await screen.findByRole("dialog", { name: "重命名" })));
        await dialogGone();
        await focusedOn(() => trigger);
      },
    ],
    [
      "另一次放下（答 409）",
      async () => {
        const dragged = dragOnto(rowIn(ROOT, "b.md"), row("折叠 out"));
        dropOn(rowIn(ROOT, "b.md"), row("折叠 out"), dragged.transfer);
        await waitFor(() => expect(notices()).toStrictEqual([SAME_NAME]));
      },
    ],
  ])(
    "D14b 放下成功而目标层重列回来的列表里还没有新行：焦点不动；另起一次操作（%s）之后再刷新出新行，焦点不被它拿走",
    async (_case, operate) => {
      const listings = scene();
      const answers = [
        () => {
          // 服务端答了成功，但随后那一次 `out` 的列表里还没有它。
          listings[""] = [dirEntry("out"), fileEntry("b.md")];
          return jsonResponse({ path: "out/a.md" });
        },
      ];
      openFiles(listings, { [MOVE]: () => (answers.shift() ?? CONFLICT)() });
      const source = await findRow("a.md");
      row("b.md").focus();

      const { transfer } = dragOnto(source, row("展开 out"));
      dropOn(source, row("展开 out"), transfer);
      await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md"]));
      await settle();
      expect(document.activeElement).toBe(rowIn(ROOT, "b.md"));

      await operate();
      const focused = document.activeElement;
      listings.out = [dirEntry("sub"), fileEntry("b.md"), fileEntry("a.md")];
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "a.md"]));
      await settle();
      expect(document.activeElement).toBe(focused);
      expect(focused?.closest("li")).toBe(rowIn(ROOT, "b.md").closest("li"));
    },
  );
});
