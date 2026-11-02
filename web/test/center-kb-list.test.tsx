// knowledge-bases「中心「知识库」tab」的状态行、列表、列表行的 `删除知识库` 与 `新建知识库` 对话框（s2a-kb-ragflow
// 任务 15.2）：「不可用与未就绪」「编译开关按对话模型显示」「编译状态文案」，模板恰十一种、建库恰一次请求与失败 alert、
// 空态、删库确认。假 `ApiClient` 经 `KnowledgeBasesPanel({client})` 注入。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type BaseView } from "../src/lib/api.js";
import {
  base,
  checkboxNames,
  chooseTemplate,
  fakeKb,
  openCreate,
  openTemplates,
  pageAlerts,
  READY,
  renderPanel,
  rowOf,
} from "./center-kb-support.js";

const UNAVAILABLE = "知识库服务暂不可用";
const NOT_READY = "管理员尚未配置知识库嵌入模型";
const EMPTY = "还没有知识库";
const PENDING_NOTE = "解析完成后长时间没有变化，可能是知识库对话模型不可用，请联系管理员";

afterEach(() => {
  cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: "创建" });
}

describe("状态行", () => {
  it("不可用与未就绪：先只有「知识库服务暂不可用」与「重试」；重试后嵌入模型未就绪，提示管理员配置，仍没有「新建知识库」", async () => {
    const fake = fakeKb([
      { ...READY, available: false },
      { ...READY, embeddingReady: false },
    ]);
    renderPanel(fake);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    expect(pageAlerts()).toEqual([UNAVAILABLE]);
    expect(screen.queryByRole("button", { name: "新建知识库" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(fake.listKnowledgeBases).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建知识库" })).toBeNull();
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(fake.calls.map(([name]) => name)).toEqual([
      "getKbStatus",
      "getKbStatus",
      "listKnowledgeBases",
    ]);
  });

  it("嵌入模型未就绪时已有的库照常列出，仍可删除", async () => {
    const fake = fakeKb([{ ...READY, embeddingReady: false }], [base("k1", { name: "规范库" })]);
    renderPanel(fake);

    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect(within(rowOf("规范库")).getByRole("button", { name: "删除知识库" })).toBeTruthy();
  });

  it("状态读取失败同不可用：显示「知识库服务暂不可用」与「重试」，重试成功后出现列表与「新建知识库」", async () => {
    const fake = fakeKb([READY]);
    fake.getKbStatus.mockRejectedValueOnce(
      new ApiError(0, "request_failed", "请求失败，请稍后重试"),
    );
    renderPanel(fake);

    expect(await screen.findByText(UNAVAILABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("button", { name: "新建知识库" })).toBeTruthy();
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(pageAlerts()).toEqual([]);
  });

  it("列表读取失败：页内 alert 显示信封文案与「重试」，重试后恢复", async () => {
    const fake = fakeKb([READY], [base("k1", { name: "规范库" })]);
    fake.listKnowledgeBases.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", "知识库服务暂时不可用"),
    );
    renderPanel(fake);

    expect(await screen.findByText("知识库服务暂时不可用")).toBeTruthy();
    expect(pageAlerts()).toEqual(["知识库服务暂时不可用"]);
    expect(screen.queryByRole("button", { name: "新建知识库" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("cell", { name: "规范库" })).toBeTruthy();
    expect(pageAlerts()).toEqual([]);
  });
});

describe("列表", () => {
  it("没有知识库时显示空态「还没有知识库」，有「新建知识库」，没有表", async () => {
    const fake = fakeKb([READY]);
    renderPanel(fake);

    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建知识库" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("每行名称、模板中文名、编译标签、文档数与重建标记；重建中的行没有「删除知识库」，重建失败的行有", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("k1", { name: "规范库", template: "manual", documents: 3 }),
        base("k2", {
          name: "表格库",
          template: "table",
          raptor: true,
          graph: true,
          state: "rebuilding",
          compile: { raptor: "done", graph: "running" },
        }),
        base("k3", { name: "法规库", template: "laws", state: "rebuild_failed", documents: 1 }),
      ],
    );
    renderPanel(fake);

    await screen.findByRole("table");
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "名称",
      "模板",
      "编译",
      "文档",
      "状态",
      "操作",
    ]);
    const cells = (name: string) =>
      within(rowOf(name))
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells("规范库")).toEqual(["规范库", "手册", "", "3", "", "删除知识库"]);
    expect(cells("表格库")).toEqual([
      "表格库",
      "表格",
      "RAPTOR已完成知识图谱编译中",
      "0",
      "重建中",
      "",
    ]);
    expect(cells("法规库")).toEqual(["法规库", "法规", "", "1", "重建失败", "删除知识库"]);
    expect(within(rowOf("表格库")).queryByRole("button")).toBeNull();
  });

  it("删除知识库：先弹确认，取消不发请求；确认后恰一次 deleteKnowledgeBase，行消失", async () => {
    const fake = fakeKb(
      [READY],
      [base("k1", { name: "规范库" }), base("k3", { name: "法规库", state: "rebuild_failed" })],
    );
    renderPanel(fake);

    await screen.findByRole("cell", { name: "法规库" });
    fireEvent.click(within(rowOf("法规库")).getByRole("button", { name: "删除知识库" }));
    let confirm = await screen.findByRole("alertdialog", { name: "删除知识库 法规库？" });
    expect(fake.deleteKnowledgeBase).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteKnowledgeBase).not.toHaveBeenCalled();

    fireEvent.click(within(rowOf("法规库")).getByRole("button", { name: "删除知识库" }));
    confirm = await screen.findByRole("alertdialog", { name: "删除知识库 法规库？" });
    const remove = within(confirm).getByRole("button", { name: "删除" });
    fireEvent.click(remove);
    fireEvent.click(remove);

    await waitFor(() => expect(screen.queryByRole("cell", { name: "法规库" })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.deleteKnowledgeBase.mock.calls).toEqual([["k3"]]);
    expect(screen.getByRole("cell", { name: "规范库" })).toBeTruthy();
    expect(pageAlerts()).toEqual([]);
  });

  it("删库失败：关闭确认框，页顶 alert 显示信封文案，行仍在", async () => {
    const fake = fakeKb([READY], [base("k1", { name: "规范库" })]);
    fake.deleteKnowledgeBase.mockRejectedValueOnce(
      new ApiError(409, "kb_rebuilding", "知识库正在重建，请稍后再试"),
    );
    renderPanel(fake);

    await screen.findByRole("cell", { name: "规范库" });
    fireEvent.click(within(rowOf("规范库")).getByRole("button", { name: "删除知识库" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(pageAlerts()).toEqual(["知识库正在重建，请稍后再试"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("cell", { name: "规范库" })).toBeTruthy();
    expect(fake.deleteKnowledgeBase).toHaveBeenCalledTimes(1);
  });
});

describe("编译状态文案", () => {
  const COMPILES: [string, BaseView["compile"]][] = [
    ["甲", { raptor: "pending", graph: "off" }],
    ["乙", { raptor: "running", graph: "done" }],
    ["丙", { raptor: "failed", graph: "failed" }],
    ["丁", null],
  ];

  it("pending 为「尚未产出」带旁注，running / done 为「编译中」「已完成」，failed 为「有文档失败」，null 为「状态未知」；页面不出现「编译失败」", async () => {
    const fake = fakeKb(
      [READY],
      COMPILES.map(([name, compile], index) =>
        base(`k${index}`, {
          name,
          raptor: true,
          graph: compile?.graph !== "off",
          compile,
        }),
      ),
    );
    renderPanel(fake);

    await screen.findByRole("table");
    const compileCell = (name: string) => within(rowOf(name)).getAllByRole("cell")[2]?.textContent;
    expect(compileCell("甲")).toBe(`RAPTOR尚未产出${PENDING_NOTE}`);
    expect(compileCell("乙")).toBe("RAPTOR编译中知识图谱已完成");
    expect(compileCell("丙")).toBe("RAPTOR有文档失败知识图谱有文档失败");
    expect(compileCell("丁")).toBe("RAPTOR状态未知知识图谱状态未知");
    expect(screen.getAllByText(PENDING_NOTE)).toHaveLength(1);
    expect(document.body.textContent).not.toContain("编译失败");
  });
});

describe("新建知识库对话框", () => {
  it("模板恰十一种，每项带说明文案，没有 Tag；缺省为「通用」", async () => {
    const fake = fakeKb([READY]);
    renderPanel(fake);

    const dialog = await openCreate();
    expect(within(dialog).getByRole("combobox", { name: "模板" }).textContent).toBe("通用");
    const options = await openTemplates(dialog);
    expect(options.map((option) => option.textContent)).toEqual([
      "通用 — 通用文本，按标题与段落切分",
      "问答 — 问答对，一问一答成块",
      "手册 — 手册规范，尊重章节与步骤",
      "论文 — 论文，摘要/方法/结论分块",
      "书籍 — 长文档书籍",
      "法规 — 法规条文，按条款切分",
      "演示文稿 — 演示文稿，按页切分",
      "表格 — 表格，按行列结构解析",
      "整篇 — 整篇文档作为一个块",
      "图片 — 图片，走 OCR 与版面识别",
      "邮件 — 邮件，按往来切分",
    ]);
    expect(options.some((option) => /tag|标签/i.test(option.textContent ?? ""))).toBe(false);
  });

  it("编译开关按对话模型显示：compileReady 为真时选 manual、再选 table 都显示两个复选", async () => {
    const fake = fakeKb([READY]);
    renderPanel(fake);

    const dialog = await openCreate();
    await chooseTemplate(dialog, "手册");
    expect(checkboxNames(dialog)).toEqual(["RAPTOR", "知识图谱"]);
    await chooseTemplate(dialog, "表格");
    expect(checkboxNames(dialog)).toEqual(["RAPTOR", "知识图谱"]);
  });

  it("编译开关按对话模型显示：compileReady 为假时选 manual 两个复选都不显示，提交不带开关", async () => {
    const fake = fakeKb([{ ...READY, compileReady: false }]);
    renderPanel(fake);

    const dialog = await openCreate();
    await chooseTemplate(dialog, "手册");
    expect(checkboxNames(dialog)).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "规范库" } });
    fireEvent.click(createButton(dialog));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createKnowledgeBase.mock.calls).toEqual([[{ name: "规范库", template: "manual" }]]);
  });

  it("建库恰一次请求：在途时「创建」与「取消」禁用、再点不重发；成功后关闭，新库出现在列表末尾", async () => {
    const fake = fakeKb([READY], [base("k0", { name: "旧库" })]);
    const gate = deferred<void>();
    const real = fake.createKnowledgeBase.getMockImplementation();
    fake.createKnowledgeBase.mockImplementationOnce(async (input) => {
      await gate.promise;
      if (!real) throw new Error("missing fake implementation");
      return real(input);
    });
    renderPanel(fake);

    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "规范库" } });
    await chooseTemplate(dialog, "法规");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "知识图谱" }));
    fireEvent.click(createButton(dialog));
    await waitFor(() => expect(createButton(dialog).hasAttribute("disabled")).toBe(true));
    expect(within(dialog).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(createButton(dialog));
    fireEvent.submit(within(dialog).getByLabelText("名称"));
    gate.resolve();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createKnowledgeBase.mock.calls).toEqual([
      [{ name: "规范库", template: "laws", graph: true }],
    ]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "旧库",
      "规范库",
    ]);
    expect(within(rowOf("规范库")).getAllByRole("cell")[2]?.textContent).toBe(
      `知识图谱尚未产出${PENDING_NOTE}`,
    );
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
  });

  it("建库失败：对话框不关，框内 role=alert 显示信封文案，列表不变", async () => {
    const fake = fakeKb([READY]);
    fake.createKnowledgeBase.mockRejectedValueOnce(
      new ApiError(409, "kb_not_ready", "知识库嵌入模型尚未就绪"),
    );
    renderPanel(fake);

    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "规范库" } });
    fireEvent.click(createButton(dialog));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("知识库嵌入模型尚未就绪");
    expect(screen.getByRole("dialog", { name: "新建知识库" })).toBeTruthy();
    expect(createButton(dialog).hasAttribute("disabled")).toBe(false);
    expect(fake.createKnowledgeBase).toHaveBeenCalledTimes(1);
    expect(fake.createKnowledgeBase.mock.calls[0]?.[0]).toEqual({
      name: "规范库",
      template: "naive",
    });
    expect(pageAlerts()).toEqual([]);
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });
});
