// knowledge-bases「中心「知识库」tab」详情里的两个入库入口（s2a-kb-ragflow 任务 16.4，design D11、D19）：`从工作空间入库`
// 对话框（选空间、逐级浏览目录、勾选上限 `uploadMaxFiles`、提交恰一次、被拒条目逐条显示 `message`、成功后重取一次、
// `queued` 进入 3 秒刷新）与 `上传文件`（超数、超大在客户端就地拒绝，逐个请求，400 `kb_file_unsupported` 逐个显示信封
// 文案、其余继续）；两个入口共用一个入库结果显示；知识库非 `ready` 时两个入口都不渲染。假 `ApiClient` 经
// `KnowledgeBasesPanel({client})` 注入。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type BaseView, type DocumentView, type KbIngestResult } from "../src/lib/api.js";
import {
  base,
  chooseWorkspace,
  dir,
  doc,
  type FakeKb,
  fakeKb,
  file,
  READY,
  renderPanel,
  rowOf,
} from "./center-kb-support.js";
import { deferred } from "./chat-stream-support.js";

const INGEST = "从工作空间入库";
const UPLOAD = "上传文件";
const SUBMIT = "入库并解析";
/** knowledge-bases「工作空间来源入库」的 `message` 表。 */
const UNSUPPORTED_TYPE = "这个模板不支持这种文件";
const EMPTY = "文件是空的，不能入库";
const DUPLICATE = "已在知识库里";
/** http-service-skeleton 的信封文案。 */
const FILE_UNSUPPORTED = "这个文件不能入库：模板不支持这种类型，或文件是空的";
const REBUILDING = "知识库正在重建，请稍后再试";
const TOO_LARGE = "文件超过大小上限";
const DENIED = "目标路径不在你的沙箱内，操作已拒绝";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 同 `center-kb-detail.test.tsx`：只假 `setTimeout`，随真实时间推进；「尚未重取」在 1.5 秒处判。 */
function fakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** 名为「规范库」的库 `k1`；`limits` 改上传上限。 */
function withBase(
  documents: readonly DocumentView[] = [],
  patch: Partial<BaseView> = {},
  limits: Partial<Pick<typeof READY, "uploadMaxFiles" | "uploadMaxBytes">> = {},
): FakeKb {
  return fakeKb(
    [{ ...READY, ...limits }],
    [base("k1", { name: "规范库", documents: documents.length, ...patch })],
    { k1: documents },
  );
}

async function openDetail(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("cell", { name: "规范库" }));
  const detail = await screen.findByRole("region", { name: "规范库 · 文档" });
  await waitFor(() => expect(within(detail).queryByText("正在读取文档")).toBeNull());
  return detail;
}

/** 点 `从工作空间入库`，等根目录列出；返回对话框。 */
async function openIngest(detail: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(detail).getByRole("button", { name: INGEST }));
  const dialog = await screen.findByRole("dialog", { name: INGEST });
  await waitFor(() => expect(within(dialog).queryByText("正在读取目录")).toBeNull());
  return dialog;
}

const box = (dialog: HTMLElement, name: string) => within(dialog).getByRole("checkbox", { name });

/** 入库结果里逐条的文案。 */
function results(detail: HTMLElement): string[] {
  return within(within(detail).getByRole("alert"))
    .queryAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

function chooseFiles(detail: HTMLElement, files: File[]) {
  const input = detail.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  fireEvent.change(input, { target: { files } });
}

/** `size` 字节的文件。 */
const bytes = (name: string, size: number) => new File(["x".repeat(size)], name);

const listReads = (fake: FakeKb) => fake.listKbDocuments.mock.calls.length;
const statusOf = (detail: HTMLElement, name: string) =>
  within(rowOf(name, detail)).getAllByRole("cell")[3]?.textContent;

describe("入口挂在详情里", () => {
  it("ready：详情里有「从工作空间入库」与「上传文件」", async () => {
    renderPanel(withBase([doc("a")]));
    const detail = await openDetail();

    expect(within(detail).getByRole("button", { name: INGEST })).toBeTruthy();
    expect(within(detail).getByRole("button", { name: UPLOAD })).toBeTruthy();
  });

  it.each(["rebuilding", "rebuild_failed"] as const)(
    "%s：两个入口都不渲染，文档照常列出",
    async (state) => {
      renderPanel(withBase([doc("a")], { state }));
      const detail = await openDetail();

      expect(rowOf("a.md", detail)).toBeTruthy();
      expect(within(detail).queryByRole("button", { name: INGEST })).toBeNull();
      expect(within(detail).queryByRole("button", { name: UPLOAD })).toBeNull();
      expect(detail.querySelector('input[type="file"]')).toBeNull();
    },
  );
});

describe("从工作空间入库", () => {
  it("选空间、逐级浏览目录：展开一层才读一层，再展开不重读；换空间后从新空间的根浏览", async () => {
    const fake = withBase();
    fake.setWorkspaces([
      { id: "ws-1", name: "项目空间", dir: "project", root: "/srv/ws/project", createdAt: 1 },
      { id: "ws-2", name: "资料空间", dir: "notes", root: "/srv/ws/notes", createdAt: 2 },
    ]);
    fake.setTree("ws-1", "", [dir("docs"), file("readme.md")]);
    fake.setTree("ws-1", "docs", [dir("sub"), file("a.md")]);
    fake.setTree("ws-1", "docs/sub", [file("deep.pdf")]);
    fake.setTree("ws-2", "", [dir("notes")]);
    fake.setTree("ws-2", "notes", [file("n.md")]);
    renderPanel(fake);
    const detail = await openDetail();

    const dialog = await openIngest(detail);
    expect(within(dialog).getByRole("combobox", { name: "工作空间" }).textContent).toBe("项目空间");
    expect(fake.listTree.mock.calls).toEqual([["ws-1", "", expect.anything()]]);
    expect(within(dialog).queryByRole("checkbox", { name: "a.md" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "展开 docs" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "展开 sub" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "deep.pdf" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "折叠 docs" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "展开 docs" }));
    expect(
      within(dialog).getByRole("checkbox", { name: "deep.pdf" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(fake.listTree.mock.calls.map(([ws, path]) => [ws, path])).toEqual([
      ["ws-1", ""],
      ["ws-1", "docs"],
      ["ws-1", "docs/sub"],
    ]);

    await chooseWorkspace(dialog, "资料空间");
    fireEvent.click(await within(dialog).findByRole("button", { name: "展开 notes" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "n.md" }));
    expect(within(dialog).queryByRole("checkbox", { name: "deep.pdf" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.ingestFromWorkspace.mock.calls).toEqual([
      ["k1", { workspaceId: "ws-2", paths: ["notes/n.md"] }],
    ]);
  });

  it("勾选上限：勾满 uploadMaxFiles 个后其余文件不可勾，取消一个后恢复；提交恰为勾选的路径", async () => {
    const fake = withBase([], {}, { uploadMaxFiles: 2 });
    fake.setTree("ws-1", "", [file("a.md"), file("b.md"), file("c.md")]);
    renderPanel(fake);
    const detail = await openDetail();
    const dialog = await openIngest(detail);

    expect(within(dialog).getByText("已选 0 / 2")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: SUBMIT }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(box(dialog, "a.md"));
    fireEvent.click(box(dialog, "b.md"));

    expect(within(dialog).getByText("已选 2 / 2")).toBeTruthy();
    expect((box(dialog, "c.md") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box(dialog, "c.md"));
    expect(box(dialog, "c.md").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(box(dialog, "a.md"));
    expect((box(dialog, "c.md") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(box(dialog, "c.md"));
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));

    await waitFor(() => expect(fake.ingestFromWorkspace).toHaveBeenCalledTimes(1));
    expect(fake.ingestFromWorkspace).toHaveBeenCalledWith("k1", {
      workspaceId: "ws-1",
      paths: ["b.md", "c.md"],
    });
  });

  it("提交恰一次：在途时再点、回车提交都不重发，按钮禁用、Escape 关不掉；应答后对话框关闭，焦点回到入口", async () => {
    const fake = withBase();
    fake.setTree("ws-1", "", [file("a.md")]);
    const late = deferred<KbIngestResult>();
    fake.ingestFromWorkspace.mockImplementationOnce(() => late.promise);
    renderPanel(fake);
    const detail = await openDetail();
    const dialog = await openIngest(detail);
    fireEvent.click(box(dialog, "a.md"));

    const submit = within(dialog).getByRole("button", { name: SUBMIT }) as HTMLButtonElement;
    fireEvent.click(submit);
    fireEvent.click(submit);
    const form = dialog.querySelector("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(fake.ingestFromWorkspace).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("dialog", { name: INGEST })).toBeTruthy();

    await act(async () => late.resolve({ documents: [], rejected: [] }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.ingestFromWorkspace).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(detail).getByRole("button", { name: INGEST })),
    );
  });

  it("被拒的条目逐条显示 message（含 unsupported_type 与 empty 的文案），入库的文档出现在表里", async () => {
    const fake = withBase();
    fake.setTree("ws-1", "", [file("a.txt"), file("b.PDF"), file("noext"), file("c.pdf", 0)]);
    fake.ingestFromWorkspace.mockImplementationOnce(async () => {
      const added = doc("b", { name: "b.PDF", path: "b.PDF", status: "queued", chunkCount: null });
      fake.setDocuments("k1", [added]);
      return {
        documents: [added],
        rejected: [
          { path: "a.txt", reason: "unsupported_type", message: UNSUPPORTED_TYPE },
          { path: "noext", reason: "unsupported_type", message: UNSUPPORTED_TYPE },
          { path: "c.pdf", reason: "empty", message: EMPTY },
        ],
      };
    });
    renderPanel(fake);
    const detail = await openDetail();
    const dialog = await openIngest(detail);
    for (const name of ["a.txt", "b.PDF", "noext", "c.pdf"]) fireEvent.click(box(dialog, name));
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(results(detail)).toEqual([
      `a.txt：${UNSUPPORTED_TYPE}`,
      `noext：${UNSUPPORTED_TYPE}`,
      `c.pdf：${EMPTY}`,
    ]);
    expect(await within(detail).findByRole("cell", { name: "b.PDF" })).toBeTruthy();
  });

  it("成功后重取一次文档列表，写端点返回的 queued 由此进入 3 秒刷新", async () => {
    fakeClock();
    const fake = withBase();
    fake.setTree("ws-1", "", [file("a.md")]);
    renderPanel(fake);
    const detail = await openDetail();
    expect(listReads(fake)).toBe(1);
    const dialog = await openIngest(detail);
    fireEvent.click(box(dialog, "a.md"));
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));

    await waitFor(() => expect(statusOf(detail, "a.md")).toBe("排队中"));
    expect(listReads(fake)).toBe(2);
    fake.setDocuments("k1", [doc("a", { status: "done", chunkCount: 4 })]);

    await advance(1_500);
    expect(listReads(fake)).toBe(2);
    await advance(1_500);
    expect(listReads(fake)).toBe(3);
    await waitFor(() => expect(statusOf(detail, "a.md")).toBe("已切片 4"));
    await advance(30_000);
    expect(listReads(fake)).toBe(3);
  });

  it("整个请求失败（409 kb_rebuilding）：对话框不关，框内 alert 显示信封文案，不重取列表", async () => {
    const fake = withBase();
    fake.setTree("ws-1", "", [file("a.md")]);
    fake.ingestFromWorkspace.mockRejectedValueOnce(new ApiError(409, "kb_rebuilding", REBUILDING));
    renderPanel(fake);
    const detail = await openDetail();
    const dialog = await openIngest(detail);
    fireEvent.click(box(dialog, "a.md"));
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(REBUILDING);
    expect(screen.getByRole("dialog", { name: INGEST })).toBeTruthy();
    expect(listReads(fake)).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(detail).queryByRole("alert")).toBeNull();
  });

  it("目录读取失败：该层显示信封文案，其它层照常", async () => {
    const fake = withBase();
    fake.setTree("ws-1", "", [dir("locked"), file("a.md")]);
    renderPanel(fake);
    const detail = await openDetail();
    const dialog = await openIngest(detail);
    fake.listTree.mockRejectedValueOnce(new ApiError(403, "sandbox_denied", DENIED));

    fireEvent.click(within(dialog).getByRole("button", { name: "展开 locked" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(DENIED);
    expect(box(dialog, "a.md")).toBeTruthy();
  });
});

describe("上传文件", () => {
  it("超数：一次选了多于 uploadMaxFiles 个，就地整批拒绝，不发请求、不重取", async () => {
    const fake = withBase([], {}, { uploadMaxFiles: 2 });
    renderPanel(fake);
    const detail = await openDetail();

    chooseFiles(detail, [bytes("a.md", 3), bytes("b.md", 3), bytes("c.md", 3)]);

    expect((await within(detail).findByRole("alert")).textContent).toBe("一次最多上传 2 个文件");
    await act(async () => undefined);
    expect(fake.uploadToKnowledgeBase).not.toHaveBeenCalled();
    expect(listReads(fake)).toBe(1);
  });

  it("超大就地拒绝；其余逐个请求，前一个应答之后才发下一个；成功后重取一次", async () => {
    const fake = withBase([], {}, { uploadMaxBytes: 10 });
    const first = deferred<DocumentView>();
    const original = fake.uploadToKnowledgeBase.getMockImplementation();
    if (!original) throw new Error("no upload implementation");
    fake.uploadToKnowledgeBase.mockImplementationOnce(async (baseId, picked) => {
      await first.promise;
      return original(baseId, picked);
    });
    renderPanel(fake);
    const detail = await openDetail();

    chooseFiles(detail, [bytes("a.md", 5), bytes("big.pdf", 11), bytes("edge.md", 10)]);

    await waitFor(() => expect(fake.uploadToKnowledgeBase).toHaveBeenCalledTimes(1));
    expect(results(detail)).toEqual([`big.pdf：${TOO_LARGE}`]);
    expect(
      (within(detail).getByRole("button", { name: UPLOAD }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => undefined);
    expect(fake.uploadToKnowledgeBase).toHaveBeenCalledTimes(1);
    expect(listReads(fake)).toBe(1);

    await act(async () => first.resolve(doc("ignored")));

    await waitFor(() => expect(listReads(fake)).toBe(2));
    expect(fake.uploadToKnowledgeBase.mock.calls.map(([id, picked]) => [id, picked.name])).toEqual([
      ["k1", "a.md"],
      ["k1", "edge.md"],
    ]);
    expect(await within(detail).findByRole("cell", { name: "edge.md" })).toBeTruthy();
    expect(within(rowOf("a.md", detail)).getAllByRole("cell")[1]?.textContent).toBe("本地上传");
    expect(statusOf(detail, "a.md")).toBe("排队中");
    expect(results(detail)).toEqual([`big.pdf：${TOO_LARGE}`]);
  });

  it("400 kb_file_unsupported：该文件显示信封文案，其余文件继续上传；只有失败时不重取", async () => {
    const fake = withBase();
    fake.uploadToKnowledgeBase.mockImplementation(async (_baseId, picked) => {
      if (picked.name.endsWith(".txt")) {
        throw new ApiError(400, "kb_file_unsupported", FILE_UNSUPPORTED);
      }
      return doc(picked.name, { source: "upload" });
    });
    renderPanel(fake);
    const detail = await openDetail();

    chooseFiles(detail, [bytes("a.txt", 3), bytes("b.pdf", 3), bytes("c.txt", 3)]);

    await waitFor(() => expect(listReads(fake)).toBe(2));
    expect(fake.uploadToKnowledgeBase.mock.calls.map(([, picked]) => picked.name)).toEqual([
      "a.txt",
      "b.pdf",
      "c.txt",
    ]);
    expect(results(detail)).toEqual([`a.txt：${FILE_UNSUPPORTED}`, `c.txt：${FILE_UNSUPPORTED}`]);

    chooseFiles(detail, [bytes("d.txt", 3)]);
    await waitFor(() => expect(results(detail)).toEqual([`d.txt：${FILE_UNSUPPORTED}`]));
    await act(async () => undefined);
    expect(fake.uploadToKnowledgeBase).toHaveBeenCalledTimes(4);
    expect(listReads(fake)).toBe(2);
  });
});

describe("两个入口共用一个入库结果显示", () => {
  it("入库的被拒条目与上传的失败显示在同一处，下一次入库或上传开始时换成新的结果", async () => {
    const fake = withBase([], {}, { uploadMaxBytes: 10 });
    fake.setTree("ws-1", "", [file("a.md")]);
    fake.ingestFromWorkspace.mockResolvedValueOnce({
      documents: [],
      rejected: [{ path: "a.md", reason: "duplicate", message: DUPLICATE }],
    });
    renderPanel(fake);
    const detail = await openDetail();

    const dialog = await openIngest(detail);
    fireEvent.click(box(dialog, "a.md"));
    fireEvent.click(within(dialog).getByRole("button", { name: SUBMIT }));
    await waitFor(() => expect(results(detail)).toEqual([`a.md：${DUPLICATE}`]));

    chooseFiles(detail, [bytes("big.pdf", 11)]);
    await waitFor(() => expect(results(detail)).toEqual([`big.pdf：${TOO_LARGE}`]));
    expect(within(detail).getAllByRole("alert")).toHaveLength(1);

    const again = await openIngest(detail);
    fireEvent.click(box(again, "a.md"));
    fireEvent.click(within(again).getByRole("button", { name: SUBMIT }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(detail).queryByRole("alert")).toBeNull());
  });
});
