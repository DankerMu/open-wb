// files-web「文件操作界面」：行菜单 `更多操作 <名>`、`重命名` 对话框与改名之后的跟随。期望值按规格的
// 场景手写；`to` 的写法（父目录 + `/` + 新名）按 `POST …/move` 的请求体约定手写，不经 `renameTarget` 算。

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  dialogGone,
  dirEntry,
  fileEntry,
  fileUrl,
  focusedOn,
  type Listings,
  MOVE,
  menuButton,
  nameInput,
  openFiles,
  openRename,
  renameTo,
  submitButton,
  treeUrl,
} from "./files-ops-support.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const CONFLICT = () =>
  jsonResponse({ error: { code: "conflict", message: "信封里的冲突文案" } }, 409);
const PENDING_NOTE = "正在重命名。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 根下两个文件。 */
const flat = (): Listings => ({ "": [fileEntry("notes.md"), fileEntry("readme.md", 8)] });

/** 根下 `out`（含 `sub` 与两个文件）、同级的 `output`、一个文件。 */
const nested = (): Listings => ({
  "": [dirEntry("out"), dirEntry("output"), fileEntry("top.md")],
  out: [dirEntry("sub"), fileEntry("a.md"), fileEntry("b.md")],
  "out/sub": [fileEntry("x.md")],
  output: [fileEntry("o.md")],
});

const moved = (path: string) => () => jsonResponse({ path });

function overlay() {
  const element = document.querySelector('[data-slot="dialog-overlay"]');
  if (!element) throw new Error("expected the dialog overlay");
  return element;
}

async function expand(name: string) {
  fireEvent.click(await findRow(`展开 ${name}`));
  await findRow(`折叠 ${name}`);
}

/** `折叠 <目录>` 那一行之下的各行名字。 */
function rowsUnder(directory: string) {
  const names = row(`折叠 ${directory}`)
    .closest("li")
    ?.querySelectorAll(':scope > ul [data-slot="tree-name"]');
  return [...(names ?? [])].map((node) => node.textContent);
}

describe("重命名", () => {
  it("R1 合法新名：恰一次 POST move {from, to}，对话框关闭，根层被重新请求，树里是新名字", async () => {
    const listings = flat();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8), fileEntry("later.md")];
        return jsonResponse({ path: "todo.md" });
      },
    });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    expect(within(dialog).getByRole("heading", { name: "重命名" })).toBeTruthy();
    expect(nameInput(dialog).value).toBe("notes.md");
    const since = mark();

    renameTo(dialog, "todo.md");
    await dialogGone();
    // `later.md` 只在重新列出的根里有：树上出现它即重列的结果已经用上。
    await findRow("later.md");
    expect(rowNames()).toStrictEqual(["设计文档", "todo.md", "readme.md", "later.md"]);
    await settle();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`, treeUrl("")]);
  });

  it("R1b 首尾空白去掉后发出，中间的空格原样", async () => {
    const { mark } = openFiles(flat(), { [MOVE]: moved("my todo.md") });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, "  my todo.md ");
    await dialogGone();
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"notes.md","to":"my todo.md"}`,
      treeUrl(""),
    ]);
  });

  it("R2 服务端答 409：显示同名冲突的固定文案（不是信封文案），对话框仍开，可再次提交", async () => {
    const answers = [CONFLICT(), jsonResponse({ path: "todo.md" })];
    const { moves } = openFiles(flat(), { [MOVE]: () => answers.shift() as Response });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");

    renameTo(dialog, "todo.md");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("该目录下已存在同名条目");
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
    expect(submitButton(dialog).disabled).toBe(false);
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
    expect(moves()).toHaveLength(1);

    fireEvent.click(submitButton(dialog));
    await dialogGone();
    expect(moves().map(([, options]) => options?.body)).toStrictEqual([
      '{"from":"notes.md","to":"todo.md"}',
      '{"from":"notes.md","to":"todo.md"}',
    ]);
  });

  it.each([
    ["留空", "", "请输入名称"],
    ["只有空白", " \t ", "请输入名称"],
    ["含 /", "a/b", "名称不能包含路径分隔符"],
    ["以 / 开头", "/etc", "名称不能包含路径分隔符"],
    ["含 ../", "../x", "名称不能包含路径分隔符"],
    ["含 \\", "a\\b", "名称不能包含路径分隔符"],
  ])("R3 名称%s：就地显示文案，对话框不关，没有请求", async (_case, name, message) => {
    const { mark } = openFiles(flat());
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, name);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
    await settle();
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
    expect(since()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
  });

  it.each([
    ["不改就提交", "notes.md"],
    ["只多了首尾空白", " notes.md  "],
  ])("R3 新旧同名（%s）：直接关闭，没有请求", async (_case, name) => {
    const { mark } = openFiles(flat());
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, name);
    await dialogGone();
    await settle();
    expect(since()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
  });

  it("R3c 原名本身含 \\（Linux 上合法的文件名）：不改就提交仍是直接关闭，不报分隔符、不发请求", async () => {
    const name = "back\\slash.md";
    const { mark } = openFiles({ "": [fileEntry(name)] });
    await findRow(name);
    const dialog = await openRename(name);
    expect(nameInput(dialog).value).toBe(name);
    const since = mark();

    fireEvent.click(submitButton(dialog));
    await dialogGone();
    await settle();
    expect(since()).toStrictEqual([]);
  });

  it.each([
    ["根下的文件", "top.md", "..", '{"from":"top.md","to":".."}'],
    ["根下的文件", "top.md", ".", '{"from":"top.md","to":"."}'],
    ["目录里的文件", "b.md", "..", '{"from":"out/b.md","to":"out/.."}'],
  ])(
    "R4 %s %s 改名为 %s：原样发出恰一次 POST，服务端的拒绝文案显示在对话框内",
    async (_case, name, typed, body) => {
      const { mark } = openFiles(nested(), {
        [MOVE]: () =>
          jsonResponse({ error: { code: "forbidden", message: "路径越出工作空间" } }, 403),
      });
      await expand("out");
      const dialog = await openRename(name);
      const since = mark();

      renameTo(dialog, typed);
      expect((await within(dialog).findByRole("alert")).textContent).toBe("路径越出工作空间");
      await settle();
      expect(since()).toStrictEqual([`POST ${MOVE} ${body}`]);
      expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
    },
  );
});

describe("请求中的对话框", () => {
  it("R5 挂起时提交按钮禁用、再提交表单仍只有一次 POST；取消后 signal 已中止、对话框关闭；迟到的成功应答不改树、不发请求", async () => {
    const held = deferredResponse();
    const { mark, moves } = openFiles(flat(), { [MOVE]: () => held.promise });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, "todo.md");
    await waitFor(() => expect(submitButton(dialog).disabled).toBe(true));
    expect(within(dialog).getByRole("status").textContent).toBe(PENDING_NOTE);
    expect(nameInput(dialog).closest("form")?.getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(nameInput(dialog).closest("form") as HTMLFormElement);
    await settle();
    expect(moves()).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await dialogGone();
    expect(moves()[0]?.[1]?.signal?.aborted).toBe(true);

    await act(async () => {
      held.resolve(jsonResponse({ path: "todo.md" }));
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`]);
  });

  it.each([
    ["成功", () => jsonResponse({ path: "todo.md" })],
    ["409", CONFLICT],
    ["500", () => jsonResponse({ error: { code: "internal", message: "服务器出错" } }, 500)],
  ])(
    "R5 取消后重新打开，上一次请求迟到的%s应答：新对话框不关、不显示错误、树不变",
    async (_case, late) => {
      const held = deferredResponse();
      const { mark } = openFiles(flat(), { [MOVE]: () => held.promise });
      await findRow("notes.md");
      const first = await openRename("notes.md");
      const since = mark();
      renameTo(first, "todo.md");
      await waitFor(() => expect(submitButton(first).disabled).toBe(true));
      fireEvent.click(within(first).getByRole("button", { name: "取消" }));
      await dialogGone();

      const second = await openRename("notes.md");
      await act(async () => {
        held.resolve(late());
      });
      await settle();
      expect(screen.getByRole("dialog", { name: "重命名" })).toBe(second);
      expect(within(second).queryByRole("alert")).toBeNull();
      expect(within(second).queryByRole("status")).toBeNull();
      expect(submitButton(second).disabled).toBe(false);
      expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
      expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`]);
    },
  );

  it("R6 挂起期点遮罩：对话框关闭，请求的 signal 已中止，焦点回到该行的更多操作，全程恰一次 POST", async () => {
    const held = deferredResponse();
    const { moves } = openFiles(flat(), { [MOVE]: () => held.promise });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    renameTo(dialog, "todo.md");
    await waitFor(() => expect(submitButton(dialog).disabled).toBe(true));
    expect(moves()).toHaveLength(1);

    await yieldMacrotask();
    pressPointer(overlay());
    await dialogGone();
    expect(moves()[0]?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(() => menuButton("notes.md"));
    await settle();
    expect(moves()).toHaveLength(1);
  });
});

describe("重命名对话框的焦点与模态清理", () => {
  it("R7 初始焦点经受延迟回焦：让出一个宏任务后焦点仍在名称上、原名整段被选中，对话框是 aria-modal", async () => {
    openFiles(flat());
    await findRow("notes.md");
    const dialog = await openRename("notes.md");

    await yieldMacrotask();
    const input = nameInput(dialog);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("notes.md");
    expect([input.selectionStart, input.selectionEnd]).toStrictEqual([0, 8]);
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toStrictEqual(["取消", "重命名", "关闭"]);
  });

  it("R8 四种取消类关闭：焦点回到该行的更多操作，body 没有 pointer-events 残留、容器没有 aria-hidden，没有 POST", async () => {
    const { moves, view } = openFiles(flat());
    await findRow("notes.md");
    const closers: ((dialog: HTMLElement) => void)[] = [
      (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "取消" })),
      (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "关闭" })),
      () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" }),
      () => pressPointer(overlay()),
    ];

    for (const close of closers) {
      const dialog = await openRename("notes.md");
      await yieldMacrotask();
      // 模态期两样都在：下面「没有残留」的断言因此不是空话。
      expect(view.container.getAttribute("aria-hidden")).toBe("true");
      expect(document.body.style.pointerEvents).toBe("none");
      close(dialog);
      await dialogGone();
      await focusedOn(() => menuButton("notes.md"));
      expect(document.body.style.pointerEvents).toBe("");
      expect(view.container.hasAttribute("aria-hidden")).toBe(false);
    }
    expect(moves()).toHaveLength(0);
  });

  it("R14 成功后焦点落在新行的更多操作上", async () => {
    const listings = flat();
    openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "todo.md" });
      },
    });
    await findRow("notes.md");
    renameTo(await openRename("notes.md"), "todo.md");
    await dialogGone();

    await focusedOn(() => menuButton("todo.md"));
    // 对话框卸载后的回焦在下一个宏任务里跑：它之后焦点仍在新行上。
    await settle();
    expect(document.activeElement).toBe(menuButton("todo.md"));
  });

  it("R15 成功、409 与名字校验失败全程不弹 Toast", async () => {
    const listings = flat();
    const answers = [CONFLICT(), jsonResponse({ path: "todo.md" })];
    openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8)];
        return answers.shift() as Response;
      },
    });
    const toasts = await screen.findByRole("region", { name: "通知" });
    const noToast = async () => {
      // 让出一轮：Toast 若有，是在文案之后的一次状态更新里才进通知区的。
      await yieldMacrotask();
      expect(within(toasts).queryByRole("listitem")).toBeNull();
      expect(document.querySelector(".ui-toast")).toBeNull();
    };
    await findRow("notes.md");
    const dialog = await openRename("notes.md");

    renameTo(dialog, "");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请输入名称");
    await noToast();
    renameTo(dialog, "todo.md");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("该目录下已存在同名条目");
    await noToast();
    fireEvent.click(submitButton(dialog));
    await dialogGone();
    await findRow("todo.md");
    await noToast();
  });
});

describe("当前文件随操作变化", () => {
  it("R9 预览 out/a.md 时把 out 改名为 dist：选中项与地址跟到 dist/a.md，dist 仍展开；其后的请求恰为 POST、新路径的 file、根的 tree", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("dist/a.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
          return jsonResponse({ path: "dist" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=dist%2Fa.md");
    expect(row("折叠 dist").getAttribute("aria-expanded")).toBe("true");
    expect(rowsUnder("dist")).toStrictEqual(["sub", "a.md", "b.md"]);
    const selected = row("折叠 dist").closest("li")?.querySelector('[aria-current="true"]');
    expect(selected?.querySelector('[data-slot="tree-name"]')?.textContent).toBe("a.md");
    expect(tree().querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    await settle();
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "dist",
      "sub",
      "a.md",
      "b.md",
      "output",
      "top.md",
    ]);
    // 没有 `tree?path=out`、`tree?path=dist`，也没有为地址的变化另起一次定位。
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      fileUrl("dist/a.md"),
      treeUrl(""),
    ]);
  });

  it("R9b 目录里的当前文件 out/a.md 改名：to 带着父目录，只重新列出 out，选中项与地址跟到新路径", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("out/c.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings.out = [dirEntry("sub"), fileEntry("b.md"), fileEntry("c.md")];
          return jsonResponse({ path: "out/c.md" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("a.md");
    const since = mark();

    renameTo(dialog, "c.md");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=out%2Fc.md");
    await selectedRow("c.md");
    await settle();
    expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "c.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out/a.md","to":"out/c.md"}`,
      fileUrl("out/c.md"),
      treeUrl("out"),
    ]);
  });

  it("R10 随操作更新：当前文件 a.md 改名为 b.md 后地址的 path 是 b.md，ws 不变", async () => {
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    openFiles(listings, {
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [fileUrl("b.md")]: () => textPreviewResponse("乙"),
      [MOVE]: () => {
        listings[""] = [fileEntry("b.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "b.md" });
      },
    });
    fireEvent.click(await findRow("a.md"));
    await expectLocation("/files?ws=workspace-1&path=a.md");
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();

    renameTo(await openRename("a.md"), "b.md");
    await dialogGone();
    await expectLocation("/files?ws=workspace-1&path=b.md");
    await selectedRow("b.md");
    expect(await previewRegion().findByText("乙", { exact: true })).toBeTruthy();
    // 预览头用的是选中条目的名字：它也换成了新名字。
    const download = previewRegion().getByRole("link", { name: "下载 b.md" });
    expect(download.getAttribute("href")).toBe("/api/workspaces/workspace-1/download?path=b.md");
    expect(previewRegion().queryByRole("link", { name: "下载 a.md" })).toBeNull();
  });

  it("R10b 改名的不是当前文件也不是它的祖先：选中项、预览与地址都不动，没有 file 请求", async () => {
    const listings = flat();
    const { mark } = openFiles(listings, {
      [fileUrl("readme.md")]: () => textPreviewResponse("自述正文"),
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "todo.md" });
      },
    });
    fireEvent.click(await findRow("readme.md"));
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, "todo.md");
    await dialogGone();
    await findRow("todo.md");
    await settle();
    await selectedRow("readme.md");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=readme.md");
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`, treeUrl("")]);
  });

  it("R11 已展开的 out/sub 跟到 dist/sub 且不重新请求；名字以 out 开头的同级 output 不动", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    await expand("sub");
    await expand("output");
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("折叠 dist");
    await settle();
    expect(row("折叠 sub").getAttribute("aria-expanded")).toBe("true");
    expect(row("折叠 output").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "dist",
      "sub",
      "x.md",
      "a.md",
      "b.md",
      "output",
      "o.md",
      "top.md",
    ]);
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);
  });

  it("R11b 深一层的 out/sub/x.md 改名：只重新列出 out/sub，不重列根与 out", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings["out/sub"] = [fileEntry("y.md")];
        return jsonResponse({ path: "out/sub/y.md" });
      },
    });
    await expand("out");
    await expand("sub");
    const dialog = await openRename("x.md");
    const since = mark();

    renameTo(dialog, "y.md");
    await dialogGone();
    await findRow("y.md");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out/sub/x.md","to":"out/sub/y.md"}`,
      treeUrl("out/sub"),
    ]);
  });

  it("R18 展开了而列表还在途的 out/sub：改名后旧路径的请求被中止，新路径补请求一次", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { fetchMock, mark } = openFiles(listings, {
      [treeUrl("out/sub")]: () => held.promise,
      [treeUrl("dist/sub")]: () => jsonResponse({ path: "dist/sub", entries: [fileEntry("x.md")] }),
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    fireEvent.click(await findRow("展开 sub"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("x.md");
    await settle();
    const stale = fetchMock.mock.calls.find(([path]) => path === treeUrl("out/sub"));
    expect(stale?.[1]?.signal?.aborted).toBe(true);
    expect(within(tree()).queryByText("正在读取目录", { exact: true })).toBeNull();
    expect(rowsUnder("sub")).toStrictEqual(["x.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      treeUrl(""),
      treeUrl("dist/sub"),
    ]);
  });
  it("R19 读取失败且已折叠的 out/sub：改名后失败文案跟到 dist 之下，刷新重取的是新路径", async () => {
    const listings = nested();
    const failure = () =>
      jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500);
    const { mark } = openFiles(listings, {
      [treeUrl("out/sub")]: failure,
      [treeUrl("dist/sub")]: failure,
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        listings.dist = listings.out as Listings[string];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    fireEvent.click(await findRow("展开 sub"));
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    fireEvent.click(row("折叠 sub"));
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("折叠 dist");
    await settle();
    const alert = within(tree()).getByRole("alert");
    expect(alert.textContent).toBe("目录读取失败");
    expect(row("展开 sub").closest("li")?.contains(alert)).toBe(true);
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await settle();
    expect(since().slice(2).sort()).toStrictEqual(
      [treeUrl(""), treeUrl("dist"), treeUrl("dist/sub")].sort(),
    );
  });

  it("R20 地址的定位还在等 out/sub 的列表时把 out 改名：定位跟到 dist/sub/x.md 并选中，不为旧路径发请求，地址不改", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { mark } = openFiles(
      listings,
      {
        [treeUrl("out/sub")]: () => held.promise,
        [treeUrl("dist/sub")]: () =>
          jsonResponse({ path: "dist/sub", entries: [fileEntry("x.md")] }),
        [fileUrl("dist/sub/x.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
          return jsonResponse({ path: "dist" });
        },
      },
      address("out/sub/x.md"),
    );
    await findRow("折叠 sub");
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await selectedRow("x.md");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      treeUrl(""),
      treeUrl("dist/sub"),
      fileUrl("dist/sub/x.md"),
    ]);
    // 由地址定位到的选中不写地址（「地址定位到文件」）：`path` 仍是进入时的写法。
    await expectLocation("/files?ws=workspace-1&path=out%2Fsub%2Fx.md");
  });
});
