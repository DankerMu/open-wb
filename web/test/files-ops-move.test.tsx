import { pageNotices } from "./page-notices.js";
// files-web「文件操作界面」：`移动到…` 对话框——目标列表、发出的请求、请求中的状态、焦点与模态清理。
// 期望值按规格的场景手写；`to` 的写法（目标目录 + `/` + 原名，目标是根时只有原名）按 `POST …/move` 的
// 请求体约定手写，不经 `workspacePath` / `moveTargets` 算。移动之后的跟随在 files-ops-move-follow.test.tsx。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { findRow, row, rowNames, settle, tree } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  cancelButton,
  dialogGone,
  dirEntry,
  expand,
  fileEntry,
  focusedOn,
  type Listings,
  MOVE,
  menuButton,
  moveButton,
  moveInto,
  nested,
  openFiles,
  openMove,
  overlay,
  rowIn,
  rowsUnder,
  targetSelect,
  treeUrl,
} from "./files-ops-support.js";
import { createFetchMock, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const CONFLICT = () =>
  jsonResponse({ error: { code: "conflict", message: "信封里的冲突文案" } }, 409);
const NO_TARGET = "没有可用的目标目录，请先展开目标目录";
const PENDING_NOTE = "正在移动。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。";
const A_TO_OUT = `POST ${MOVE} {"from":"a.md","to":"out/a.md"}`;

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 规格场景「移动到」的树：根下 `docs`、`out` 两个目录与 `a.md`。 */
const scene = (): Listings => ({
  "": [dirEntry("docs"), dirEntry("out"), fileEntry("a.md")],
  docs: [],
  out: [fileEntry("b.md")],
});

/** `scene()` 在 `a.md` 移进 `out` 之后的样子。 */
function landed(listings: Listings) {
  listings[""] = [dirEntry("docs"), dirEntry("out")];
  listings.out = [fileEntry("b.md"), fileEntry("a.md")];
  return jsonResponse({ path: "out/a.md" });
}

const targets = (dialog: HTMLElement) =>
  [...targetSelect(dialog).options].map((option) => option.value);
const form = (dialog: HTMLElement) => dialog.querySelector("form") as HTMLFormElement;

/** 打开 `scene()`、展开 `out`、对 `a.md` 打开对话框；`move` 是 `POST move` 的应答。 */
async function openSceneMove(move?: () => Promise<Response> | Response) {
  const listings = scene();
  const opened = openFiles(listings, move ? { [MOVE]: move } : {});
  await expand("out");
  return { ...opened, dialog: await openMove("a.md"), listings };
}

describe("移动到", () => {
  it("M1 下拉恰含已展开的 out（不含根与未展开的 docs）；提交后恰一次 POST move {from, to}，源父层与目标层各重新请求一次，a.md 到了 out 之下", async () => {
    const listings = scene();
    const { mark } = openFiles(listings, { [MOVE]: () => landed(listings) });
    await expand("out");
    const dialog = await openMove("a.md");
    expect(within(dialog).getByRole("heading", { name: "移动到" })).toBeTruthy();
    expect(targets(dialog)).toStrictEqual(["out"]);
    expect(targetSelect(dialog).value).toBe("out");
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toStrictEqual(["取消", "移动", "关闭"]);
    const since = mark();

    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["b.md", "a.md"]));
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "docs", "out", "b.md", "a.md"]);
    expect(since()).toStrictEqual([A_TO_OUT, treeUrl(""), treeUrl("out")]);
  });

  it("M1b 名字含首尾空格与 %、#、?：from 与 to 原样带着它，不去空白、不解码、不编码", async () => {
    const name = " a%20b#c?.md ";
    const listings: Listings = { "": [dirEntry("out"), fileEntry(name)], out: [] };
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [dirEntry("out")];
        listings.out = [fileEntry(name)];
        return jsonResponse({ path: `out/${name}` });
      },
    });
    await expand("out");
    // 按属性逐字找：角色查询会把可访问名里的首尾空格折掉。
    const trigger = [...tree().querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === `更多操作 ${name}`,
    ) as HTMLButtonElement;
    await yieldMacrotask();
    pressPointer(trigger);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移动到…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "移动到" });
    const since = mark();

    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":" a%20b#c?.md ","to":"out/ a%20b#c?.md "}`,
      treeUrl(""),
      treeUrl("out"),
    ]);
  });

  it("M1d 目标目录的名字含首尾空格与 %：to 里目标目录那一半也原样送出，不去空白、不解码", async () => {
    const directory = " o%20ut ";
    const listings: Listings = { "": [dirEntry(directory), fileEntry("a.md")], [directory]: [] };
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [dirEntry(directory)];
        listings[directory] = [fileEntry("a.md")];
        return jsonResponse({ path: `${directory}/a.md` });
      },
    });
    await findRow("a.md");
    // 按 `title` 逐字找：角色查询会把可访问名里的首尾空格折掉。
    fireEvent.click(rowIn("设计文档", directory));
    await waitFor(() =>
      expect(rowIn("设计文档", directory).getAttribute("aria-expanded")).toBe("true"),
    );
    await within(tree()).findByText("空目录", { exact: true });
    const dialog = await openMove("a.md");
    expect(targets(dialog)).toStrictEqual([directory]);
    const since = mark();

    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"a.md","to":" o%20ut /a.md"}`,
      treeUrl(""),
      treeUrl(directory),
    ]);
  });

  it("M1c 列表里名为两个点的条目：from 与 to 原样送出，不折叠成父目录；服务端的拒绝文案显示在框内", async () => {
    // 列表是这里合成的：服务端的 `tree` 不会列出 `..`（#1101 的 D19b 同此，读代码推出）。这里只看界面拿到
    // 这样一行时送出什么——裁决是服务端的。
    const { mark } = openFiles(
      { "": [dirEntry("out")], out: [fileEntry("..")] },
      {
        [MOVE]: () =>
          jsonResponse({ error: { code: "forbidden", message: "路径越出工作空间" } }, 403),
      },
    );
    await expand("out");
    const dialog = await openMove("..");
    expect(targets(dialog)).toStrictEqual([""]);
    const since = mark();

    fireEvent.click(moveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("路径越出工作空间");
    await settle();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out/..","to":".."}`]);
  });

  it("M2 对已展开的 out 打开而它的子目录 out/sub 也已展开、别的目录都没展开：没有下拉，显示说明文案，移动 禁用，提交表单不发请求，焦点在 取消", async () => {
    const { mark } = openFiles(nested());
    await expand("out");
    await expand("sub");
    const dialog = await openMove("out");
    const since = mark();

    await yieldMacrotask();
    expect(within(dialog).queryByLabelText("目标位置")).toBeNull();
    expect(dialog.querySelector("select")).toBeNull();
    expect(within(dialog).getByText(NO_TARGET, { exact: true })).toBeTruthy();
    expect(moveButton(dialog).disabled).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(cancelButton(dialog));

    fireEvent.submit(form(dialog));
    fireEvent.click(moveButton(dialog));
    await settle();
    expect(screen.getByRole("dialog", { name: "移动到" })).toBe(dialog);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(since()).toStrictEqual([]);

    fireEvent.click(cancelButton(dialog));
    await dialogGone("移动到");
    await focusedOn(() => menuButton("out"));
  });

  it("M3 服务端答 409：框内显示目标同名的固定文案（不是信封文案，也不是重命名的那一句），对话框仍开、移动 可用，树不变且没有 tree 请求，可再次提交", async () => {
    const answers = [CONFLICT];
    const { dialog, listings, mark, moves } = await openSceneMove(() =>
      (answers.shift() ?? (() => landed(listings)))(),
    );
    const since = mark();

    fireEvent.click(moveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("目标位置已存在同名条目");
    await settle();
    expect(screen.getByRole("dialog", { name: "移动到" })).toBe(dialog);
    expect(moveButton(dialog).disabled).toBe(false);
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(rowNames()).toStrictEqual(["设计文档", "docs", "out", "b.md", "a.md"]);
    expect(rowsUnder("out")).toStrictEqual(["b.md"]);
    expect(since()).toStrictEqual([A_TO_OUT]);

    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["b.md", "a.md"]));
    expect(moves().map(([, options]) => options?.body)).toStrictEqual([
      '{"from":"a.md","to":"out/a.md"}',
      '{"from":"a.md","to":"out/a.md"}',
    ]);
  });

  it.each([
    [404, "not_found", "请求的资源不存在", "请求的资源不存在"],
    [401, "unauthorized", "登录已失效", null],
  ])(
    "M3b 服务端答 %i：框内显示的是信封文案（401 不显示，停在请求中的样子），对话框仍开",
    async (status, code, message, shown) => {
      // 整页上 401 会先把页面换成登录页、对话框随之卸载；直接渲染组件，看的是对话框自己做了什么。
      const fetchMock = createFetchMock({
        [treeUrl("")]: () =>
          jsonResponse({ path: "", entries: [dirEntry("out"), fileEntry("a.md")] }),
        [treeUrl("out")]: () => jsonResponse({ path: "out", entries: [] }),
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
      await expand("out");
      const dialog = await openMove("a.md");
      // 没给空间名时根行是 `工作空间`；这里的根是当前父目录，不在下拉里。
      expect(targets(dialog)).toStrictEqual(["out"]);

      fireEvent.click(moveButton(dialog));
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([path]) => path === MOVE)).toHaveLength(1),
      );
      await settle();
      expect(screen.getByRole("dialog", { name: "移动到" })).toBe(dialog);
      expect(within(dialog).queryByRole("alert")?.textContent ?? null).toBe(shown);
      expect(moveButton(dialog).disabled).toBe(shown === null);
      expect(rowNames()).toStrictEqual(["工作空间", "out", "a.md"]);
    },
  );

  it("M4 目标列表的细目：同级的 output 在移动 out 时仍在；展开后又折叠的 docs 不在；父目录折叠而自己还在展开集合里的 out/sub 不在；移动 out/a.md 时首项是根，文字是 根目录 加空间名", async () => {
    openFiles({
      ...nested(),
      "": [dirEntry("docs"), dirEntry("out"), dirEntry("output"), fileEntry("top.md")],
      docs: [],
    });
    await expand("output");
    await expand("docs");
    fireEvent.click(row("折叠 docs"));
    await expand("out");
    await expand("sub");
    fireEvent.click(row("折叠 out"));
    await findRow("展开 out");

    const forFile = await openMove("top.md");
    expect(targets(forFile)).toStrictEqual(["output"]);
    fireEvent.click(cancelButton(forFile));
    await dialogGone("移动到");

    const forDirectory = await openMove("out");
    expect(targets(forDirectory)).toStrictEqual(["output"]);
    fireEvent.click(cancelButton(forDirectory));
    await dialogGone("移动到");

    // 重新展开 `out`：`out/sub` 的展开项一直留着，这时它又可见。
    fireEvent.click(row("展开 out"));
    await findRow("折叠 sub");
    const forNested = await openMove("a.md");
    const options = [...targetSelect(forNested).options];
    expect(options.map((option) => option.value)).toStrictEqual(["", "out/sub", "output"]);
    expect(options.map((option) => option.textContent)).toStrictEqual([
      "根目录　设计文档",
      "out/sub",
      "output",
    ]);
    expect(targetSelect(forNested).value).toBe("");
  });
});

describe("移动到：目标列表在打开时取定", () => {
  it("M4b 对话框开着时 docs 的列表才落地：下拉不变；关掉再打开才有它", async () => {
    const held = deferredResponse();
    openFiles(scene(), { [treeUrl("docs")]: () => held.promise });
    await expand("out");
    fireEvent.click(await findRow("展开 docs"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openMove("a.md");
    expect(targets(dialog)).toStrictEqual(["out"]);

    await act(async () => {
      held.resolve(jsonResponse({ path: "docs", entries: [] }));
    });
    await settle();
    expect(targets(dialog)).toStrictEqual(["out"]);
    expect(targetSelect(dialog).value).toBe("out");

    fireEvent.click(cancelButton(dialog));
    await dialogGone("移动到");
    expect(targets(await openMove("a.md"))).toStrictEqual(["docs", "out"]);
  });
});

describe("请求中的对话框：移动到", () => {
  it("M7 挂起时 移动 禁用、再提交表单仍只有一次 POST；取消后 signal 已中止、对话框关闭；迟到的成功应答不重开、不报错、不改树、不发请求", async () => {
    const held = deferredResponse();
    const { dialog, mark, moves } = await openSceneMove(() => held.promise);
    const since = mark();

    fireEvent.click(moveButton(dialog));
    await waitFor(() => expect(moveButton(dialog).disabled).toBe(true));
    expect(within(dialog).getByRole("status").textContent).toBe(PENDING_NOTE);
    expect(form(dialog).getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(form(dialog));
    await settle();
    expect(moves()).toHaveLength(1);

    fireEvent.click(cancelButton(dialog));
    await dialogGone("移动到");
    expect(moves()[0]?.[1]?.signal?.aborted).toBe(true);

    await act(async () => {
      held.resolve(jsonResponse({ path: "out/a.md" }));
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rowNames()).toStrictEqual(["设计文档", "docs", "out", "b.md", "a.md"]);
    expect(rowsUnder("out")).toStrictEqual(["b.md"]);
    expect(since()).toStrictEqual([A_TO_OUT]);
  });

  it("M8 挂起期点遮罩：对话框关闭，请求的 signal 已中止，焦点回到该行的更多操作，全程恰一次 POST", async () => {
    const held = deferredResponse();
    const { dialog, moves } = await openSceneMove(() => held.promise);
    fireEvent.click(moveButton(dialog));
    await waitFor(() => expect(moveButton(dialog).disabled).toBe(true));
    expect(moves()).toHaveLength(1);

    await yieldMacrotask();
    pressPointer(overlay());
    await dialogGone("移动到");
    expect(moves()[0]?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(() => menuButton("a.md"));
    await settle();
    expect(moves()).toHaveLength(1);
  });
});

describe("移动到对话框的焦点与模态清理", () => {
  it("M9 初始焦点经受延迟回焦：让出一个宏任务后焦点仍在 目标位置 上，对话框是 aria-modal", async () => {
    const { dialog } = await openSceneMove();

    await yieldMacrotask();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(targetSelect(dialog));
  });

  it.each([
    ["取消", (dialog: HTMLElement) => fireEvent.click(cancelButton(dialog))],
    [
      "关闭",
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getByRole("button", { name: "关闭" })),
    ],
    ["Escape", () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })],
    ["点遮罩", () => pressPointer(overlay())],
  ])(
    "M10 取消类关闭（%s）：焦点回到该行的更多操作，body 没有 pointer-events 残留、容器没有 aria-hidden，没有 POST",
    async (_case, close) => {
      const { dialog, moves, view } = await openSceneMove();
      await yieldMacrotask();
      // 模态期两样都在：下面「没有残留」的断言因此不是空话。
      expect(view.container.getAttribute("aria-hidden")).toBe("true");
      expect(document.body.style.pointerEvents).toBe("none");

      close(dialog);
      await dialogGone("移动到");
      await focusedOn(() => menuButton("a.md"));
      expect(document.body.style.pointerEvents).toBe("");
      expect(view.container.hasAttribute("aria-hidden")).toBe(false);
      await settle();
      expect(moves()).toHaveLength(0);
    },
  );

  it("M11 成功后焦点落在新行（out 之下那一行）的更多操作上", async () => {
    const { dialog, listings } = await openSceneMove(() => landed(listings));
    // 对话框开着，树被标成 aria-hidden：按 hidden 查。
    const before = screen.getByRole("button", { name: "更多操作 a.md", hidden: true });

    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["b.md", "a.md"]));
    // 新旧两行的可访问名相同：看的是它在 `out` 那一行之内，且不是原来那个按钮。
    const landing = () =>
      within(row("折叠 out").closest("li") as HTMLElement).getByRole("button", {
        name: "更多操作 a.md",
      });
    await focusedOn(landing);
    // 对话框卸载后的回焦在下一个宏任务里跑：它之后焦点仍在新行上。
    await settle();
    expect(document.activeElement).toBe(landing());
    expect(landing()).not.toBe(before);
    expect(within(tree()).getAllByRole("button", { name: "更多操作 a.md" })).toHaveLength(1);
  });

  it("M12 成功与 409 全程不弹 Toast", async () => {
    const answers = [CONFLICT];
    const { dialog, listings } = await openSceneMove(() =>
      (answers.shift() ?? (() => landed(listings)))(),
    );
    /** 让出一轮再数：整页的提示面恰为 `notices`（应用里已没有 Toast 组件，#1398）。 */
    const noToast = async (notices: string[]) => {
      await yieldMacrotask();
      expect(pageNotices()).toEqual(notices);
    };

    fireEvent.click(moveButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("目标位置已存在同名条目");
    await noToast(["alert:目标位置已存在同名条目"]);
    moveInto(dialog, "out");
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["b.md", "a.md"]));
    await noToast([]);
  });
});
