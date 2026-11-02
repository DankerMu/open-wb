// knowledge-bases「中心「知识库」tab」的详情（s2a-kb-ragflow 任务 16.2，design D12、D19）：点行进入详情、文档表的
// 来源 / 大小 / 七种状态文案与 `已切片 0`、「解析中自动刷新」（假时钟；页面隐藏时停；`unparsed` 不触发）、
// `源文件已变更` 只在 `true` 时显示、`重新入库` 与 `移出`（409 `kb_document_busy` 行内显示信封文案、行仍在）、
// 知识库非 `ready` 时两个行按钮的渲染规则。假 `ApiClient` 经 `KnowledgeBasesPanel({client})` 注入。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type BaseView, type DocumentView } from "../src/lib/api.js";
import { base, doc, type FakeKb, fakeKb, READY, renderPanel, rowOf } from "./center-kb-support.js";
import { deferred } from "./chat-stream-support.js";

const BUSY = "文档正在停止解析，请稍后再试";
const UNREADABLE = "源文件无法读取或已变动，未重新入库";
const CHANGED = "源文件已变更";

let visibility: DocumentVisibilityState = "visible";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

/** jsdom 的 `visibilityState` 是只读 getter：换成可控的值，并派发 `visibilitychange`。 */
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** `files-mount-preview.test.tsx` 的写法：只假 `setTimeout`，并随真实时间推进，`findBy*` 照常可用。 */
function fakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** 一个名为「规范库」的库 `k1`，带给定文档。 */
function withDocuments(documents: readonly DocumentView[], patch: Partial<BaseView> = {}) {
  return fakeKb([READY], [base("k1", { name: "规范库", documents: documents.length, ...patch })], {
    k1: documents,
  });
}

/** 点列表里该名称的行，等详情出现并读完文档；返回详情区域。 */
async function openDetail(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("cell", { name }));
  const detail = await screen.findByRole("region", { name: `${name} · 文档` });
  await waitFor(() => expect(within(detail).queryByText("正在读取文档")).toBeNull());
  return detail;
}

/** 该文档行的第 `index` 列（名称、来源、大小、状态、操作）。 */
function cell(detail: HTMLElement, name: string, index: number): HTMLElement {
  const target = within(rowOf(name, detail)).getAllByRole("cell")[index];
  if (!target) throw new Error(`no cell ${index} for ${name}`);
  return target;
}

const statusOf = (detail: HTMLElement, name: string) => cell(detail, name, 3).textContent;

function listReads(fake: FakeKb): number {
  return fake.listKbDocuments.mock.calls.length;
}

describe("进入详情", () => {
  it("点行进入详情：读一次该库的文档，表里有名称、`<空间名>/<路径>` 或 `本地上传`、大小", async () => {
    const fake = fakeKb(
      [READY],
      [base("k1", { name: "规范库", documents: 2 }), base("k2", { name: "手册库" })],
      {
        k1: [
          doc("d1", { name: "spec.md", path: "docs/spec.md", size: 2048 }),
          doc("d2", {
            name: "upload.pdf",
            source: "upload",
            workspaceId: null,
            path: null,
            size: 512,
            sourceChanged: null,
          }),
        ],
      },
    );
    renderPanel(fake);

    const detail = await openDetail("规范库");

    expect(fake.listKbDocuments).toHaveBeenCalledTimes(1);
    expect(fake.listKbDocuments).toHaveBeenCalledWith("k1");
    expect(
      within(detail)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["名称", "来源", "大小", "状态", "操作"]);
    expect(cell(detail, "spec.md", 1).textContent).toBe("项目空间/docs/spec.md");
    expect(cell(detail, "spec.md", 2).textContent).toBe("2.0 KB");
    expect(cell(detail, "upload.pdf", 1).textContent).toBe("本地上传");
    expect(cell(detail, "upload.pdf", 2).textContent).toBe("512 B");
    expect(rowOf("规范库").getAttribute("data-state")).toBe("selected");
    expect(rowOf("手册库").getAttribute("data-state")).toBeNull();
  });

  it("键盘进入详情：行可聚焦，按 Enter 打开详情；点行里的「删除知识库」不进入详情", async () => {
    const fake = withDocuments([doc("d1", { name: "spec.md" })]);
    renderPanel(fake);
    await screen.findByRole("cell", { name: "规范库" });

    fireEvent.click(within(rowOf("规范库")).getByRole("button", { name: "删除知识库" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByRole("region", { name: "规范库 · 文档" })).toBeNull();
    expect(fake.listKbDocuments).not.toHaveBeenCalled();

    const row = rowOf("规范库");
    expect(row.tabIndex).toBe(0);
    fireEvent.keyDown(row, { key: "Enter" });

    const detail = await screen.findByRole("region", { name: "规范库 · 文档" });
    expect(await within(detail).findByRole("cell", { name: "spec.md" })).toBeTruthy();
    expect(fake.listKbDocuments).toHaveBeenCalledTimes(1);
  });

  it("空间名未知（不在工作空间列表里，或列表读取失败）时来源列只显示路径", async () => {
    const fake = withDocuments([
      doc("gone", { workspaceId: "ws-deleted", path: "old/gone.md" }),
      doc("here", { path: "docs/here.md" }),
    ]);
    renderPanel(fake);
    let detail = await openDetail("规范库");
    expect(cell(detail, "gone.md", 1).textContent).toBe("old/gone.md");
    expect(cell(detail, "here.md", 1).textContent).toBe("项目空间/docs/here.md");

    cleanup();
    fake.listWorkspaces.mockRejectedValueOnce(new ApiError(503, "unavailable", "服务暂不可用"));
    renderPanel(fake);
    detail = await openDetail("规范库");
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledTimes(2));
    await act(async () => undefined);

    expect(cell(detail, "here.md", 1).textContent).toBe("docs/here.md");
    expect(within(detail).queryByRole("alert")).toBeNull();
  });

  it("点另一行换到该库的详情：前一库晚到的文档应答被丢弃", async () => {
    const fake = fakeKb([READY], [base("k1", { name: "规范库" }), base("k2", { name: "手册库" })], {
      k1: [doc("old", { name: "old.md" })],
      k2: [doc("new", { name: "new.md" })],
    });
    const late = deferred<DocumentView[]>();
    fake.listKbDocuments.mockImplementationOnce(() => late.promise);
    renderPanel(fake);

    fireEvent.click(await screen.findByRole("cell", { name: "规范库" }));
    const detail = await openDetail("手册库");
    expect(rowOf("new.md", detail)).toBeTruthy();

    await act(async () => late.resolve([doc("old", { name: "old.md" })]));

    expect(screen.queryByRole("region", { name: "规范库 · 文档" })).toBeNull();
    expect(within(detail).queryByText("old.md")).toBeNull();
    expect(rowOf("new.md", detail)).toBeTruthy();
  });

  it("文档读取失败：详情内 alert 显示信封文案与「重试」，重试后出现文档", async () => {
    const fake = withDocuments([doc("d1", { name: "spec.md" })]);
    fake.listKbDocuments.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", "知识库服务暂时不可用"),
    );
    renderPanel(fake);

    const detail = await openDetail("规范库");
    expect(within(detail).getByRole("alert").textContent).toBe("知识库服务暂时不可用");

    fireEvent.click(within(detail).getByRole("button", { name: "重试" }));

    expect(await within(detail).findByRole("cell", { name: "spec.md" })).toBeTruthy();
    expect(within(detail).queryByRole("alert")).toBeNull();
  });
});

describe("状态文案", () => {
  it("七种状态依次为 排队中 / 解析中 / 已切片 N / 解析失败 / 已取消 / 未解析 / 已丢失", async () => {
    const fake = withDocuments([
      doc("q", { status: "queued", chunkCount: null }),
      doc("p", { status: "parsing", chunkCount: null }),
      doc("d", { status: "done", chunkCount: 12 }),
      doc("f", { status: "failed", chunkCount: null, message: "解析失败" }),
      doc("c", { status: "cancelled", chunkCount: null }),
      doc("u", { status: "unparsed", chunkCount: null }),
      doc("m", { status: "missing", chunkCount: null }),
    ]);
    renderPanel(fake);

    const detail = await openDetail("规范库");

    expect(["q", "p", "d", "f", "c", "u", "m"].map((id) => statusOf(detail, `${id}.md`))).toEqual([
      "排队中",
      "解析中",
      "已切片 12",
      "解析失败",
      "已取消",
      "未解析",
      "已丢失",
    ]);
  });

  it("已切片 0：done 且 chunkCount 为 0 的文档显示「已切片 0」", async () => {
    const fake = withDocuments([doc("zero", { status: "done", chunkCount: 0 })]);
    renderPanel(fake);

    const detail = await openDetail("规范库");

    expect(statusOf(detail, "zero.md")).toBe("已切片 0");
  });
});

describe("解析中自动刷新", () => {
  it("第一次有 parsing、第二次全为 done：3 秒后恰重取一次，之后不再重取；显示 RAGFlow 给的切片数", async () => {
    fakeClock();
    const fake = withDocuments([doc("p", { status: "parsing", chunkCount: null })]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    expect(statusOf(detail, "p.md")).toBe("解析中");
    fake.setDocuments("k1", [doc("p", { status: "done", chunkCount: 7 })]);

    await advance(2_900);
    expect(listReads(fake)).toBe(1);
    await advance(100);
    expect(listReads(fake)).toBe(2);
    await waitFor(() => expect(statusOf(detail, "p.md")).toBe("已切片 7"));

    await advance(30_000);
    expect(listReads(fake)).toBe(2);
  });

  it("页面隐藏时停：queued 文档在页面隐藏期间不重取；恢复可见后 3 秒重取一次", async () => {
    fakeClock();
    const fake = withDocuments([doc("q", { status: "queued", chunkCount: null })]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    expect(statusOf(detail, "q.md")).toBe("排队中");

    setVisibility("hidden");
    await advance(30_000);
    expect(listReads(fake)).toBe(1);

    setVisibility("visible");
    await advance(2_900);
    expect(listReads(fake)).toBe(1);
    await advance(100);
    expect(listReads(fake)).toBe(2);
  });

  it("unparsed 不触发刷新：只有 unparsed 与其它非解析中状态时不重取", async () => {
    fakeClock();
    const fake = withDocuments([
      doc("u", { status: "unparsed", chunkCount: null }),
      doc("d", { status: "done", chunkCount: 2 }),
      doc("f", { status: "failed", chunkCount: null, message: "解析失败" }),
      doc("c", { status: "cancelled", chunkCount: null }),
      doc("m", { status: "missing", chunkCount: null }),
    ]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    expect(statusOf(detail, "u.md")).toBe("未解析");

    await advance(30_000);

    expect(listReads(fake)).toBe(1);
  });
});

describe("源文件已变更与重新入库", () => {
  it("「源文件已变更」只在 sourceChanged 为 true 时显示", async () => {
    const fake = withDocuments([
      doc("t", { sourceChanged: true }),
      doc("f", { sourceChanged: false }),
      doc("n", { sourceChanged: null }),
      doc("up", { source: "upload", workspaceId: null, path: null, sourceChanged: null }),
    ]);
    renderPanel(fake);

    const detail = await openDetail("规范库");

    expect(within(rowOf("t.md", detail)).getByText(CHANGED)).toBeTruthy();
    expect(within(detail).getAllByText(CHANGED)).toHaveLength(1);
  });

  it("每个工作空间来源的行都有「重新入库」，本地上传的行没有；两者都有「移出」", async () => {
    const fake = withDocuments([
      doc("a", { sourceChanged: true }),
      doc("b", { sourceChanged: false }),
      doc("c", { sourceChanged: null, status: "missing", chunkCount: null }),
      doc("up", { source: "upload", workspaceId: null, path: null, sourceChanged: null }),
    ]);
    renderPanel(fake);

    const detail = await openDetail("规范库");

    for (const name of ["a.md", "b.md", "c.md"]) {
      expect(within(rowOf(name, detail)).getByRole("button", { name: "重新入库" })).toBeTruthy();
    }
    const upload = within(rowOf("up.md", detail));
    expect(upload.queryByRole("button", { name: "重新入库" })).toBeNull();
    expect(upload.getByRole("button", { name: "移出" })).toBeTruthy();
    expect(within(detail).getAllByRole("button", { name: "移出" })).toHaveLength(4);
  });

  it("重新入库恰调用一次 reingestKbDocument，成功后重取一次列表，标记消失、显示排队中", async () => {
    const fake = withDocuments([doc("a", { sourceChanged: true })]);
    renderPanel(fake);
    const detail = await openDetail("规范库");

    fireEvent.click(within(rowOf("a.md", detail)).getByRole("button", { name: "重新入库" }));

    await waitFor(() => expect(listReads(fake)).toBe(2));
    expect(fake.reingestKbDocument).toHaveBeenCalledTimes(1);
    expect(fake.reingestKbDocument).toHaveBeenCalledWith("k1", "a");
    await waitFor(() => expect(statusOf(detail, "a.md")).toBe("排队中"));
    expect(within(detail).queryByText(CHANGED)).toBeNull();
    expect(within(rowOf("a.md", detail)).queryByRole("alert")).toBeNull();
  });

  it("重新入库后的重取顶替在途的刷新：刷新晚到的旧应答被丢弃，标记不回来", async () => {
    fakeClock();
    const stale = doc("a", { status: "parsing", chunkCount: null, sourceChanged: true });
    const fake = withDocuments([stale]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    const late = deferred<DocumentView[]>();
    fake.listKbDocuments.mockImplementationOnce(() => late.promise);
    await advance(3_000);
    expect(listReads(fake)).toBe(2);

    fireEvent.click(within(rowOf("a.md", detail)).getByRole("button", { name: "重新入库" }));
    await waitFor(() => expect(listReads(fake)).toBe(3));
    await waitFor(() => expect(statusOf(detail, "a.md")).toBe("排队中"));
    await act(async () => late.resolve([stale]));

    expect(statusOf(detail, "a.md")).toBe("排队中");
    expect(within(detail).queryByText(CHANGED)).toBeNull();
  });

  it("重新入库失败：行内 alert 显示信封文案，行与标记不变，不重取", async () => {
    const fake = withDocuments([doc("a", { sourceChanged: true })]);
    fake.reingestKbDocument.mockRejectedValueOnce(
      new ApiError(409, "kb_source_unreadable", UNREADABLE),
    );
    renderPanel(fake);
    const detail = await openDetail("规范库");

    fireEvent.click(within(rowOf("a.md", detail)).getByRole("button", { name: "重新入库" }));

    const row = rowOf("a.md", detail);
    expect((await within(row).findByRole("alert")).textContent).toBe(UNREADABLE);
    expect(within(row).getByText(CHANGED)).toBeTruthy();
    expect(listReads(fake)).toBe(1);
  });
});

describe("移出", () => {
  it("移出恰调用一次 removeKbDocument：该行消失、其余行仍在，列表的文档数减一，焦点落到详情标题", async () => {
    const fake = withDocuments([doc("a", { name: "a.md" }), doc("b", { name: "b.md" })]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    expect(rowOf("规范库").querySelectorAll("td")[3]?.textContent).toBe("2");

    fireEvent.click(within(rowOf("a.md", detail)).getByRole("button", { name: "移出" }));

    await waitFor(() => expect(within(detail).queryByText("a.md")).toBeNull());
    expect(fake.removeKbDocument).toHaveBeenCalledTimes(1);
    expect(fake.removeKbDocument).toHaveBeenCalledWith("k1", "a");
    expect(rowOf("b.md", detail)).toBeTruthy();
    expect(rowOf("规范库").querySelectorAll("td")[3]?.textContent).toBe("1");
    expect(document.activeElement).toBe(
      within(detail).getByRole("heading", { name: "规范库 · 文档" }),
    );
  });

  it("移出前发出、移出后到达的刷新应答里，已移出的行不回来", async () => {
    fakeClock();
    const parsing = { status: "parsing", chunkCount: null } as const;
    const fake = withDocuments([doc("a", parsing), doc("b", parsing)]);
    renderPanel(fake);
    const detail = await openDetail("规范库");
    const late = deferred<DocumentView[]>();
    fake.listKbDocuments.mockImplementationOnce(() => late.promise);
    await advance(3_000);
    expect(listReads(fake)).toBe(2);

    fireEvent.click(within(rowOf("a.md", detail)).getByRole("button", { name: "移出" }));
    await waitFor(() => expect(within(detail).queryByText("a.md")).toBeNull());
    await act(async () => late.resolve([doc("a", parsing), doc("b", parsing)]));

    expect(within(detail).queryByText("a.md")).toBeNull();
    expect(rowOf("b.md", detail)).toBeTruthy();
  });

  it("409 kb_document_busy：行内 role=alert 显示信封文案，行仍在", async () => {
    const fake = withDocuments([doc("p", { status: "parsing", chunkCount: null })]);
    fake.removeKbDocument.mockRejectedValueOnce(new ApiError(409, "kb_document_busy", BUSY));
    renderPanel(fake);
    const detail = await openDetail("规范库");

    fireEvent.click(within(rowOf("p.md", detail)).getByRole("button", { name: "移出" }));

    const row = rowOf("p.md", detail);
    expect((await within(row).findByRole("alert")).textContent).toBe(BUSY);
    expect(within(row).getByRole("button", { name: "移出" })).toBeTruthy();
    expect(fake.removeKbDocument).toHaveBeenCalledTimes(1);
  });
});

describe("知识库非 ready 时的行按钮", () => {
  it("rebuild_failed：不渲染「重新入库」，「移出」仍渲染", async () => {
    const fake = withDocuments([doc("a", { sourceChanged: true })], { state: "rebuild_failed" });
    renderPanel(fake);

    const detail = await openDetail("规范库");

    const row = within(rowOf("a.md", detail));
    expect(row.getByRole("button", { name: "移出" })).toBeTruthy();
    expect(row.queryByRole("button", { name: "重新入库" })).toBeNull();
  });

  it("rebuilding：「重新入库」与「移出」都不渲染，文档照常列出", async () => {
    const fake = withDocuments([doc("a")], { state: "rebuilding" });
    renderPanel(fake);

    const detail = await openDetail("规范库");

    const row = within(rowOf("a.md", detail));
    expect(statusOf(detail, "a.md")).toBe("已切片 3");
    expect(row.queryByRole("button", { name: "重新入库" })).toBeNull();
    expect(row.queryByRole("button", { name: "移出" })).toBeNull();
  });
});
