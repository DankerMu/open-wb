/**
 * Issue #1372 过滤视图的行都可选中，已不存在的文件移出列表与预览区（s1-followups-batch 11a.3）：
 * workspace-sidebar 的场景「空集合与已删除的文件」「父目录未加载的改动文件可选中」「过滤开着时助手新
 * 写出的文件」「过滤开着时的定位」「过滤开着时被删除的当前文件」「过滤关着时被删除的当前文件」，以及
 * 「文件已不存在」里列表仍有它而 `file` 答 404 的一例。接缝：真实外壳里的整页（桩掉的 `fetch` 与事件
 * 连接），事件经假的事件连接推入；请求取自 `fetch` 桩的调用记录。期望值是规格里的字面量。
 *
 * 「键盘选中」在这里证到行是没有 `disabled` 的原生按钮、拿得到焦点：jsdom 不把按键合成为 click，真实
 * 浏览器里的那一步在功能验收清单 CH-101。定位没落在文件上（列表里本来就没有它）之后 `在文件页打开`
 * 的地址归 #1380，这里只断言经 404 清掉选中之后的地址。
 */
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Change,
  goLive,
  PROJ,
  toolStep,
  turn,
  write,
} from "./chat-page-file-changes-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import { observeUnhandledRejections } from "./chat-stream-support.js";
import {
  dir,
  file,
  fileOf,
  listing,
  OPEN_IN_FILES,
  openChanges,
  rowNames,
  settled,
  sidebarHead,
  treeOf,
  treeRequests,
} from "./chat-workspace-sidebar-support.js";
import { type FetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { waitMs } from "./ui-support.js";

const MARK = "本会话已改动";
const ONLY = "只看本会话改动";
const NO_CHANGES = "本会话暂无文件改动";
const EMPTY = "未选择文件";
const MISSING = "文件不存在";
/** 服务端 `not_found` 信封的文案。 */
const NOT_FOUND = "请求的资源不存在";
const ROOT = treeOf(PROJ.id);
const OUT = treeOf(PROJ.id, "out");
const FILES_PAGE = `/files?ws=${PROJ.id}`;

afterEach(cleanupSessionMeta);

type Send = Awaited<ReturnType<typeof goLive>>;

const gone = () => envelope(404, "not_found", NOT_FOUND);
const text = (body: string) => () => textPreviewResponse(body);

/** 一条回合（状态 `status`），唯一的已结束步骤（id 1）改了 `changes`。 */
const changed = (status: "done" | "running", ...changes: Change[]) =>
  turn(status, { content: "改好了", steps: [toolStep(1, 0, "write", changes)] });

/** 一个从开始到结束的步骤，`files.changed` 在 `step.end` 之前（服务端的次序）。 */
function endedStep(send: Send, stepId: number, ...files: Change[]) {
  send("step.start", { stepId, name: "write", detail: "write args" });
  send("files.changed", { stepId, files });
  send("step.end", { stepId, status: "done", output: "ok" });
}

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole<HTMLButtonElement>("button", { name });

const pane = (scope: HTMLElement) => within(scope).getByRole("region", { name: "文件预览" });

function previewShows(scope: HTMLElement, body: string) {
  return waitFor(() => expect(pane(scope).textContent).toContain(body));
}

function selectedRows(scope: HTMLElement) {
  return [...scope.querySelectorAll('button[aria-current="true"]')].map(
    (row) => row.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

/** 行按钮经 `aria-describedby` 得到的描述；没有该属性时为 `null`。 */
function description(row: HTMLElement) {
  const id = row.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? "");
}

function fileRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.startsWith(`/api/workspaces/${PROJ.id}/file?`));
}

const openInFiles = (scope: HTMLElement) =>
  within(sidebarHead(scope)).getByRole("link", { name: OPEN_IN_FILES }).getAttribute("href");

/** `path` 那一行的 `查看详情`。 */
function clickDetail(path: string) {
  const opener = screen.getByRole("button", { name: `查看详情 zhangsan/proj/${path}` });
  opener.focus();
  fireEvent.click(opener);
}

/** 打开 `只看本会话改动`。 */
function filterOn(scope: HTMLElement) {
  fireEvent.click(button(scope, ONLY));
  expect(button(scope, ONLY).getAttribute("aria-pressed")).toBe("true");
}

/**
 * 「一律清空」：没有选中的行，预览区是 `未选择文件`、没有预览头；页面上没有 `文件不存在`、没有服务端
 * 的不存在文案、没有任何错误框、没有 Toast。
 */
function expectCleared(scope: HTMLElement) {
  expect(selectedRows(scope)).toStrictEqual([]);
  expect(within(pane(scope)).getByText(EMPTY, { exact: true })).toBeTruthy();
  expect(pane(scope).querySelector('[data-slot="preview-header"]')).toBeNull();
  expect(screen.queryByText(MISSING)).toBeNull();
  expect(screen.queryByText(NOT_FOUND)).toBeNull();
  expect(within(scope).queryByRole("alert")).toBeNull();
  expect(document.querySelector(".ui-toast")).toBeNull();
}

/** 预览头有路径与下载链接，没有大小与修改时间。 */
function expectBareHeader(scope: HTMLElement, path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  expect(pane(scope).querySelector('[data-slot="preview-path"]')?.textContent).toBe(path);
  expect(within(pane(scope)).getByRole("link", { name: `下载 ${name}` })).toBeTruthy();
  expect(pane(scope).querySelector('[data-slot="preview-meta"]')).toBeNull();
}

/** 跑一例并断「没有未处理的拒绝」。 */
async function withoutRejections(run: () => Promise<void>) {
  const rejections = observeUnhandledRejections();
  try {
    await run();
    await settled();
    expect(rejections.unhandled).toStrictEqual([]);
  } finally {
    rejections.stop();
  }
}

describe("空集合与已删除的文件", () => {
  it("F1 gone.md 列表里仍有而 file 答 404、old.md 在打开之前就已删除：打开开关恰列出 gone.md 与 keep.md；选中 gone.md 后恰一次 file，该行消失、没有选中、预览区是 未选择文件、在文件页打开 不带 path，没有任何错误文字；全程没有对 old.md 的请求", () =>
    withoutRejections(async () => {
      const { fetchMock, region } = await openChanges(
        changed("done", write("gone.md"), write("old.md"), write("keep.md")),
        {
          [ROOT]: listing("", [file("gone.md"), file("keep.md"), file("readme.md")]),
          [fileOf(PROJ.id, "gone.md")]: gone,
        },
      );

      filterOn(region);

      expect(rowNames(region)).toStrictEqual(["项目", "gone.md", "keep.md"]);
      expect(button(region, "gone.md").disabled).toBe(false);
      await settled();
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);

      fireEvent.click(button(region, "gone.md"));

      await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "keep.md"]));
      expectCleared(region);
      expect(openInFiles(region)).toBe(FILES_PAGE);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "gone.md")]);
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
      expect(paths(fetchMock).filter((path) => path.includes("old.md"))).toStrictEqual([]);
    }));

  it("F2 改动集合只有打开之前就已删除的 only.md：打开开关后树区是 本会话暂无文件改动，没有任何行，没有 tree 与 file 请求", async () => {
    const { fetchMock, region } = await openChanges(changed("done", write("only.md")), {
      [ROOT]: listing("", [file("readme.md")]),
    });

    filterOn(region);

    expect(within(region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    expect(rowNames(region)).toStrictEqual([]);
    expect(within(region).queryByRole("navigation", { name: "工作空间目录树" })).toBeNull();
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });
});

describe("父目录未加载的改动文件可选中", () => {
  it("F3 deep 从未加载：x.md、y.md 两行都列出、带标记、没有被禁用；选中 x.md 恰一次 file、预览头没有大小；选中已删除的 y.md 恰一次 file 后它消失；x.md 也被删除后点 刷新 恰重取一次，x.md 与 deep 都消失、y.md 不回来；新步骤再报 y.md 后它重新列出并可预览；全程没有 tree 请求", () =>
    withoutRejections(async () => {
      const disk = { x: true, y: false };
      const X = fileOf(PROJ.id, "deep/x.md");
      const Y = fileOf(PROJ.id, "deep/y.md");
      const { fetchMock, region } = await openChanges(
        changed("running", write("deep/x.md"), write("deep/y.md")),
        {
          [ROOT]: listing("", [dir("deep"), file("readme.md")]),
          [X]: () => (disk.x ? textPreviewResponse("甲的正文") : gone()),
          [Y]: () => (disk.y ? textPreviewResponse("乙的正文") : gone()),
        },
      );
      const send = await goLive();

      filterOn(region);

      expect(rowNames(region)).toStrictEqual(["项目", "deep", "x.md", "y.md"]);
      expect(button(region, "折叠 deep").getAttribute("aria-expanded")).toBe("true");
      for (const name of ["x.md", "y.md"]) {
        expect(button(region, name).disabled).toBe(false);
        expect(description(button(region, name))).toBe(MARK);
      }

      button(region, "x.md").focus();
      expect(document.activeElement).toBe(button(region, "x.md"));
      fireEvent.click(button(region, "x.md"));

      await previewShows(region, "甲的正文");
      expect(selectedRows(region)).toStrictEqual(["x.md"]);
      expectBareHeader(region, "deep/x.md");
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([X]);

      fireEvent.click(button(region, "y.md"));

      await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "deep", "x.md"]));
      expectCleared(region);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([X, Y]);

      // 再选中 x.md；它随后也被删除，点树栏的 `刷新`。
      fireEvent.click(button(region, "x.md"));
      await previewShows(region, "甲的正文");
      await settled();
      disk.x = false;
      fireEvent.click(button(region, "刷新"));

      expect(await within(region).findByText(NO_CHANGES, { exact: true })).toBeTruthy();
      expect(rowNames(region)).toStrictEqual([]);
      expectCleared(region);
      expect(openInFiles(region)).toBe(FILES_PAGE);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([X, Y, X, X]);

      // 助手重写了 y.md：新结束的步骤报它，它重新列出（design D14-8）。
      disk.y = true;
      endedStep(send, 2, write("deep/y.md"));

      await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "deep", "y.md"]));
      expect(description(button(region, "y.md"))).toBe(MARK);
      fireEvent.click(button(region, "y.md"));
      await previewShows(region, "乙的正文");
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([X, Y, X, X, Y]);
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    }));
});

describe("过滤开着时助手新写出的文件", () => {
  const NEW = fileOf(PROJ.id, "new.md");

  /** 改动集合里只有早已删除的 `old.md`，根的列表里没有它也没有 `new.md`；回合进行中，开关已打开。 */
  async function opened() {
    const page = await openChanges(changed("running", write("old.md")), {
      [ROOT]: listing("", [file("readme.md")]),
      [NEW]: text("新写的正文"),
    });
    const send = await goLive();
    filterOn(page.region);
    expect(within(page.region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    expect(rowNames(page.region)).toStrictEqual([]);
    return { ...page, send };
  }

  it("F4 步骤结束后 new.md 列出、带标记、没有被禁用，old.md 仍不列出；选中后恰一次 file、预览头没有大小；全程没有 tree 请求", async () => {
    const { fetchMock, region, send } = await opened();

    endedStep(send, 2, write("new.md"));

    await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "new.md"]));
    expect(description(button(region, "new.md"))).toBe(MARK);
    expect(button(region, "new.md").disabled).toBe(false);
    // 等过 300 毫秒的合并窗口再选中：那一轮局部刷新在开关开着时不发 `tree`；在窗口内选中的话，它会把
    // 当前文件重取一次（「随助手改动刷新」），「恰一次 file」就看不出来了。
    await waitMs(350);
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    fireEvent.click(button(region, "new.md"));
    await previewShows(region, "新写的正文");
    expectBareHeader(region, "new.md");
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([NEW]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
  });

  it("F5 步骤结束与回合结束落在同一个 300 毫秒窗口内：new.md 同样列出并可选中，没有 tree 请求", async () => {
    const { fetchMock, region, send } = await opened();

    endedStep(send, 2, write("new.md"));
    send("turn.end", { status: "done" });

    await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "new.md"]));
    expect(button(region, "new.md").disabled).toBe(false);
    fireEvent.click(button(region, "new.md"));
    await previewShows(region, "新写的正文");
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([NEW]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
  });

  it("F6 new.md 列出之后被删除：关掉开关、点 刷新（根的列表重新读到，其中没有它）、再打开开关，它不再列出，也没有对它的任何请求", async () => {
    const { fetchMock, region, send } = await opened();
    endedStep(send, 2, write("new.md"));
    await waitFor(() => expect(rowNames(region)).toStrictEqual(["项目", "new.md"]));
    // 等过合并窗口：那一轮局部刷新在开关开着时不发 `tree`。
    await waitMs(350);
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);

    fireEvent.click(button(region, ONLY));
    fireEvent.click(button(region, "刷新"));
    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, ROOT]));
    await settled();
    filterOn(region);

    expect(within(region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    expect(rowNames(region)).toStrictEqual([]);
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, ROOT]);
  });
});

describe("过滤开着时的定位", () => {
  it("F7 只加载过根：定位到 src/deep/app.ts 选中它并显示预览、预览头没有大小；再定位到已删除的 out/gone.md 恰一次 file，gone.md 连同只剩它的 out 消失、没有选中、预览区是 未选择文件、在文件页打开 不带 path；两次都没有 tree 请求，开关仍开着", () =>
    withoutRejections(async () => {
      const APP = fileOf(PROJ.id, "src/deep/app.ts");
      const GONE = fileOf(PROJ.id, "out/gone.md");
      const { fetchMock, region } = await openChanges(
        changed("done", write("src/deep/app.ts"), write("out/gone.md")),
        {
          [ROOT]: listing("", [dir("out"), dir("src"), file("readme.md")]),
          [APP]: text("export const app = 1;"),
          [GONE]: gone,
        },
      );
      filterOn(region);
      const ALL = ["项目", "out", "gone.md", "src", "deep", "app.ts"];
      expect(rowNames(region)).toStrictEqual(ALL);

      clickDetail("src/deep/app.ts");

      await previewShows(region, "export const app = 1;");
      expect(selectedRows(region)).toStrictEqual(["app.ts"]);
      expectBareHeader(region, "src/deep/app.ts");
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([APP]);

      clickDetail("out/gone.md");

      await waitFor(() =>
        expect(rowNames(region)).toStrictEqual(["项目", "src", "deep", "app.ts"]),
      );
      expectCleared(region);
      expect(openInFiles(region)).toBe(FILES_PAGE);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([APP, GONE]);
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
      expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    }));

  it("F8 根的列表里没有 old.md（打开之前就已删除）：定位到它时开关仍开着、没有它的行、不请求 file 也不请求 tree，先前选中的 readme.md 被清除，预览区是 未选择文件，没有错误文字", async () => {
    const { fetchMock, region } = await openChanges(changed("done", write("old.md")), {
      [ROOT]: listing("", [file("readme.md")]),
    });
    fireEvent.click(button(region, "readme.md"));
    await previewShows(region, "自述正文");
    filterOn(region);
    expect(within(region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    expect(pane(region).textContent).toContain("自述正文");

    clickDetail("old.md");

    await waitFor(() => expect(pane(region).textContent).not.toContain("自述正文"));
    expectCleared(region);
    expect(rowNames(region)).toStrictEqual([]);
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md")]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    // 关掉开关：先前选中的 readme.md 不恢复。
    fireEvent.click(button(region, ONLY));
    expect(selectedRows(region)).toStrictEqual([]);
  });
});

describe("随助手改动刷新：被删除的当前文件", () => {
  const A_MD = fileOf(PROJ.id, "out/a.md");

  /** 根与 `out` 已展开、当前预览 `out/a.md`（它在改动集合里）；回合进行中。`disk` 是磁盘上的现状。 */
  async function previewing() {
    const disk = { exists: true };
    const page = await openChanges(changed("running", write("out/a.md")), {
      [ROOT]: listing("", [dir("out"), file("readme.md")]),
      [OUT]: () =>
        jsonResponse({
          path: "out",
          entries: disk.exists ? [file("a.md"), file("b.md")] : [file("b.md")],
        }),
      [A_MD]: () => (disk.exists ? textPreviewResponse("甲的正文") : gone()),
    });
    const send = await goLive();
    fireEvent.click(button(page.region, "展开 out"));
    fireEvent.click(await within(page.region).findByRole("button", { name: "a.md" }));
    await previewShows(page.region, "甲的正文");
    await settled();
    expect(treeRequests(page.fetchMock)).toStrictEqual([ROOT, OUT]);
    expect(fileRequests(page.fetchMock)).toStrictEqual([A_MD]);
    return { ...page, disk, send };
  }

  it("F9 过滤开着：步骤删除了当前预览的 out/a.md（重取得到 404），它那一行连同 out 从过滤视图消失，没有选中的行，预览区是 未选择文件，没有不存在文案，没有 tree 请求", () =>
    withoutRejections(async () => {
      const { disk, fetchMock, region, send } = await previewing();
      filterOn(region);
      expect(rowNames(region)).toStrictEqual(["项目", "out", "a.md"]);

      disk.exists = false;
      endedStep(send, 2, write("out/a.md"));

      expect(await within(region).findByText(NO_CHANGES, { exact: true })).toBeTruthy();
      expect(rowNames(region)).toStrictEqual([]);
      expectCleared(region);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([A_MD, A_MD]);
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    }));

  it("F10 过滤关着：同样的删除，根与 out 各重列一次、out/a.md 恰重取一次，a.md 不在树里，没有选中的行，预览区是 未选择文件，没有 文件不存在、没有服务端的不存在文案、没有 Toast，在文件页打开 不带 path", () =>
    withoutRejections(async () => {
      const { disk, fetchMock, region, send } = await previewing();
      expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=out%2Fa.md`);

      disk.exists = false;
      endedStep(send, 2, write("out/a.md"));

      await waitFor(() =>
        expect(rowNames(region)).toStrictEqual(["项目", "out", "b.md", "readme.md"]),
      );
      await waitFor(() => expect(selectedRows(region)).toStrictEqual([]));
      expectCleared(region);
      expect(openInFiles(region)).toBe(FILES_PAGE);
      await settled();
      expect(fileRequests(fetchMock)).toStrictEqual([A_MD, A_MD]);
      expect(treeRequests(fetchMock).sort()).toStrictEqual([ROOT, OUT, ROOT, OUT].sort());
    }));
});

describe("文件已不存在（开关关着，列表里仍有它）", () => {
  it("F11 out 的列表里仍有 gone.md 而 file 答 404：点它的 查看详情、再在树里直接点它那一行，两种做法都恰一次 file；应答到达后没有选中的行（readme.md 的选中不恢复），预览区是 未选择文件，没有服务端的不存在文案，gone.md 一行仍在树里", () =>
    withoutRejections(async () => {
      const GONE = fileOf(PROJ.id, "out/gone.md");
      const { fetchMock, region } = await openChanges(changed("done", write("out/gone.md")), {
        [ROOT]: listing("", [dir("out"), file("readme.md")]),
        [OUT]: listing("out", [file("gone.md")]),
        [GONE]: gone,
      });
      fireEvent.click(button(region, "readme.md"));
      await previewShows(region, "自述正文");
      const TREE = ["项目", "out", "gone.md", "readme.md"];

      clickDetail("out/gone.md");

      await waitFor(() => expect(fileRequests(fetchMock)).toContain(GONE));
      await waitFor(() => expect(pane(region).textContent).not.toContain("自述正文"));
      await settled();
      expectCleared(region);
      expect(rowNames(region)).toStrictEqual(TREE);
      expect(openInFiles(region)).toBe(FILES_PAGE);
      expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md"), GONE]);

      fireEvent.click(button(region, "gone.md"));

      await waitFor(() => expect(fileRequests(fetchMock)).toHaveLength(3));
      await settled();
      expectCleared(region);
      expect(rowNames(region)).toStrictEqual(TREE);
      expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md"), GONE, GONE]);
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    }));
});
