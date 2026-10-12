// files-web「文件操作界面」：`重命名` 对话框——名字的检查、发出的请求、请求中的状态、焦点与模态清理。
// 期望值按规格的场景手写；`to` 的写法（父目录 + `/` + 新名）按 `POST …/move` 的请求体约定手写，不经
// `renameTarget` 算。改名之后的跟随在 files-ops-follow.test.tsx。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { findRow, rowNames, settle } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  dialogGone,
  expand,
  fileEntry,
  flat,
  focusedOn,
  MOVE,
  menuButton,
  nameInput,
  nested,
  openFiles,
  openRename,
  renameTo,
  submitButton,
  treeUrl,
} from "./files-ops-support.js";
import { createFetchMock, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const CONFLICT = () =>
  jsonResponse({ error: { code: "conflict", message: "信封里的冲突文案" } }, 409);
const PENDING_NOTE = "正在重命名。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

const moved = (path: string) => () => jsonResponse({ path });

function overlay() {
  const element = document.querySelector('[data-slot="dialog-overlay"]');
  if (!element) throw new Error("expected the dialog overlay");
  return element;
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

  it("R2b 409 之后改成含分隔符的名字再提交：显示的是分隔符的文案而不是上一次的冲突文案，没有第二次 POST", async () => {
    const { moves } = openFiles(flat(), { [MOVE]: CONFLICT });
    await findRow("notes.md");
    const dialog = await openRename("notes.md");
    renameTo(dialog, "todo.md");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("该目录下已存在同名条目");
    expect(moves()).toHaveLength(1);

    renameTo(dialog, "a/b");
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("名称不能包含路径分隔符"),
    );
    await settle();
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
    expect(moves()).toHaveLength(1);
  });

  it("R2c 服务端答 401：对话框里不显示失败文案，停在请求中的样子（登录层接手），再提交不发第二次 POST，取消仍可关闭", async () => {
    // 整页上 401 会先把页面换成登录页、对话框随之卸载；直接渲染组件，看的是对话框自己做了什么。
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [fileEntry("notes.md")] }),
      [MOVE]: () => jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    });
    vi.stubGlobal("fetch", fetchMock);
    const moves = () => fetchMock.mock.calls.filter(([path]) => path === MOVE);
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        onPathChange={() => {}}
        path={null}
        workspaceId="workspace-1"
      />,
    );
    await findRow("notes.md");
    const dialog = await openRename("notes.md");

    renameTo(dialog, "todo.md");
    await waitFor(() => expect(moves()).toHaveLength(1));
    await settle();
    expect(screen.getByRole("dialog", { name: "重命名" })).toBe(dialog);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("status").textContent).toBe(PENDING_NOTE);
    expect(submitButton(dialog).disabled).toBe(true);
    fireEvent.submit(nameInput(dialog).closest("form") as HTMLFormElement);
    await settle();
    expect(moves()).toHaveLength(1);
    expect(rowNames()).toStrictEqual(["工作空间", "notes.md"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await dialogGone();
    await focusedOn(() => menuButton("notes.md"));
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
