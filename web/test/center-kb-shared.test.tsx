// #2035 s2c-kb-visibility 组 9：knowledge-bases「中心「知识库」tab」的非所有者部分——「共享库的只读呈现」
//「所有者没有部门」、列表计数行、四档范围标签文案（自有库为按钮（组 12））、自有库与共享库的按钮差异、
// 共享库检索测试两个数字只读。假 `ApiClient` 经 `KnowledgeBasesPanel({client})` 注入。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BaseView } from "../src/lib/api.js";
import { base, doc, fakeKb, READY, renderPanel, rowOf } from "./center-kb-support.js";

const FROM = "来自 zhangsan · 平台研发部";
const HINT =
  "共享给你的知识库只读：可检索、可在会话中引用，不能增删文档。需要补充内容请联系 zhangsan。";
const SCOPES = ["仅自己可见", "本部门可见", "项目组可见 · 内网落地专项", "全员可见"];

afterEach(() => {
  cleanup();
});

/** u1 zhangsan（平台研发部）共享给当前用户、全员可见、这一次没读到编译状态的库。 */
function shared(id: string, patch: Partial<BaseView> = {}): BaseView {
  return base(id, {
    owned: false,
    owner: { id: "u1", account: "zhangsan", department: "平台研发部" },
    scope: { scope: "all", group: null },
    compile: null,
    ...patch,
  });
}

/** 共享库的行：名称格下一行的 `来自 …` 所在的行。 */
function sharedRow(from: string = FROM): HTMLElement {
  const row = screen.getByText(from, { exact: true }).closest("tr");
  if (!row) throw new Error(`no row for ${from}`);
  return row;
}

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

const buttonNames = (scope: HTMLElement) =>
  within(scope)
    .queryAllByRole("button")
    .map((button) => button.textContent);

/** 点该行，等名为 `<name> · 文档` 的详情出现并读完文档；返回详情区域。 */
async function openRow(row: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.click(row);
  const detail = await screen.findByRole("region", { name: `${name} · 文档` });
  await waitFor(() => expect(within(detail).queryByText("正在读取文档")).toBeNull());
  return detail;
}

/** 列表上方的计数行。 */
const countLine = () => screen.findByText(/^我的 \d+ 个 · 共享给我 \d+ 个$/);

describe("共享库的只读呈现", () => {
  it("列表：计数行、只读与来源、范围列、编译只出标签；详情：没有操作列、来源不显示路径、只读提示、只有检索", async () => {
    const fake = fakeKb(
      [READY],
      [base("a", { name: "我的库" }), shared("k", { name: "规范库", raptor: true, documents: 2 })],
      {
        k: [
          doc("d1", { name: "spec.md", workspaceId: null, path: null, sourceChanged: null }),
          doc("d2", {
            name: "notes.md",
            source: "upload",
            workspaceId: null,
            path: null,
            sourceChanged: null,
          }),
        ],
      },
    );
    renderPanel(fake);

    expect((await countLine()).textContent).toBe("我的 1 个 · 共享给我 1 个");
    const k = sharedRow();
    expect(within(k).getByText("只读", { exact: true })).toBeTruthy();
    const kCells = within(k).getAllByRole("cell");
    expect(kCells[5]?.textContent).toBe("全员可见");
    expect(kCells[2]?.textContent).toBe("RAPTOR");
    expect(within(k).queryAllByRole("button")).toEqual([]);

    const a = rowOf("我的库");
    expect(cellsOf(a)).toEqual(["我的库", "通用", "", "0", "", "仅自己可见", "删除知识库"]);
    expect(buttonNames(a)).toEqual(["仅自己可见", "删除知识库"]);
    expect(within(a).queryByText("只读")).toBeNull();
    expect(within(a).queryByText(/来自/)).toBeNull();
    expect(screen.queryByText("状态未知")).toBeNull();

    const detail = await openRow(k, "规范库");
    expect(
      within(detail)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["名称", "来源", "大小", "状态"]);
    expect(cellsOf(rowOf("spec.md", detail))[1]).toBe("工作空间");
    expect(cellsOf(rowOf("notes.md", detail))[1]).toBe("本地上传");
    expect(within(detail).getByText(HINT, { exact: true })).toBeTruthy();
    expect(buttonNames(detail)).toEqual(["检索"]);
    expect(within(detail).getByText("全员可见", { exact: true })).toBeTruthy();
  });

  it("所有者没有部门：来源只写账号，行里没有 `·`", async () => {
    const fake = fakeKb(
      [READY],
      [shared("k", { owner: { id: "u1", account: "zhangsan", department: null } })],
    );
    renderPanel(fake);

    const from = await screen.findByText("来自 zhangsan", { exact: true });
    const row = from.closest("tr");
    expect(row?.textContent).not.toContain("·");
  });
});

describe("列表计数行", () => {
  it("两个自有：我的 2 个 · 共享给我 0 个", async () => {
    renderPanel(fakeKb([READY], [base("a"), base("b")]));
    expect((await countLine()).textContent).toBe("我的 2 个 · 共享给我 0 个");
  });

  it("两个共享：我的 0 个 · 共享给我 2 个", async () => {
    renderPanel(fakeKb([READY], [shared("k1"), shared("k2")]));
    expect((await countLine()).textContent).toBe("我的 0 个 · 共享给我 2 个");
  });

  it("空列表：只有空态，没有计数行", async () => {
    renderPanel(fakeKb([READY], []));
    expect(await screen.findByText("还没有知识库")).toBeTruthy();
    expect(screen.queryByText(/^我的 \d+ 个/)).toBeNull();
  });

  it("一自有一共享，删掉自有的那个：计数行跟着变，不重取列表", async () => {
    const fake = fakeKb([READY], [base("a", { name: "我的库" }), shared("k", { name: "规范库" })]);
    renderPanel(fake);

    expect((await countLine()).textContent).toBe("我的 1 个 · 共享给我 1 个");
    fireEvent.click(within(rowOf("我的库")).getByRole("button", { name: "删除知识库" }));
    const confirm = await screen.findByRole("alertdialog", { name: "删除知识库 我的库？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(screen.getByText(/^我的 \d+ 个/).textContent).toBe("我的 0 个 · 共享给我 1 个"),
    );
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
  });
});

describe("四档范围标签", () => {
  it("范围列依次为四档文案，自有库为按钮、共享库为纯文本；共享库编译只出标签；自有 group 库详情里的标签是按钮", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("m", { name: "自有仅自己" }),
        shared("d", {
          name: "共享本部门",
          scope: { scope: "dept", group: null },
        }),
        base("g", {
          name: "自有项目组",
          scope: { scope: "group", group: { id: "g1", name: "内网落地专项" } },
        }),
        shared("all", { name: "共享全员", graph: true }),
      ],
    );
    renderPanel(fake);

    await countLine();
    const rows = within(screen.getAllByRole("rowgroup")[1] as HTMLElement).getAllByRole("row");
    expect(rows.map((row) => within(row).getAllByRole("cell")[5]?.textContent)).toEqual(SCOPES);
    expect(
      rows.map((row) => buttonNames(within(row).getAllByRole("cell")[5] as HTMLElement)),
    ).toEqual([["仅自己可见"], [], ["项目组可见 · 内网落地专项"], []]);
    expect(within(rows[3] as HTMLElement).getAllByRole("cell")[2]?.textContent).toBe("知识图谱");

    const detail = await openRow(rowOf("自有项目组"), "自有项目组");
    expect(within(detail).getByRole("button", { name: "项目组可见 · 内网落地专项" })).toBeTruthy();
  });
});

describe("自有库与共享库的按钮差异", () => {
  it("rebuild_failed：自有行有删除、详情有移出；共享行没有按钮，详情没有任何写入口、有只读提示", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("a", { name: "我的库", state: "rebuild_failed", documents: 1 }),
        shared("k", { name: "规范库", state: "rebuild_failed", documents: 1 }),
      ],
      {
        a: [doc("da", { name: "mine.md" })],
        k: [doc("dk", { name: "theirs.md", path: null, workspaceId: null })],
      },
    );
    renderPanel(fake);

    await countLine();
    expect(buttonNames(rowOf("我的库"))).toEqual(["仅自己可见", "删除知识库"]);
    expect(within(sharedRow()).queryAllByRole("button")).toEqual([]);

    const mine = await openRow(rowOf("我的库"), "我的库");
    expect(within(mine).getByRole("button", { name: "移出" })).toBeTruthy();

    const theirs = await openRow(sharedRow(), "规范库");
    for (const name of ["移出", "重新入库", "从工作空间入库", "上传文件"]) {
      expect(within(theirs).queryByRole("button", { name })).toBeNull();
    }
    expect(within(theirs).getByText(HINT, { exact: true })).toBeTruthy();
    expect(within(theirs).queryByRole("region", { name: "检索测试" })).toBeNull();
  });
});

describe("共享库检索测试两个数字只读", () => {
  it("两个数字框只读、不禁用，改值无效；检索带已存值，成功后显示应答值；自有库可改", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("a", { name: "我的库" }),
        shared("k", { name: "规范库", retrieval: { threshold: 0.2, vectorWeight: 0.7 } }),
      ],
    );
    renderPanel(fake);

    await countLine();
    const panel = within(await openRow(sharedRow(), "规范库")).getByRole("region", {
      name: "检索测试",
    });
    const threshold = () =>
      within(panel).getByRole("spinbutton", { name: "相似度阈值" }) as HTMLInputElement;
    const weight = () =>
      within(panel).getByRole("spinbutton", { name: "向量权重" }) as HTMLInputElement;
    for (const field of [threshold(), weight()]) {
      expect(field.readOnly).toBe(true);
      expect(field.disabled).toBe(false);
    }

    fireEvent.change(threshold(), { target: { value: "0.9" } });
    expect(threshold().value).toBe("0.2");
    expect(within(panel).queryByText("填 0 到 1 之间的数字")).toBeNull();

    fake.retrieveFromKnowledgeBase.mockImplementationOnce(async () => ({
      hits: [],
      retrieval: { threshold: 0.3, vectorWeight: 0.6 },
    }));
    fireEvent.change(within(panel).getByRole("textbox", { name: "检索问句" }), {
      target: { value: "销售额" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "检索" }));

    await waitFor(() => expect(threshold().value).toBe("0.3"));
    expect(weight().value).toBe("0.6");
    expect(fake.retrieveFromKnowledgeBase.mock.calls).toEqual([
      ["k", { question: "销售额", threshold: 0.2, vectorWeight: 0.7 }],
    ]);
    expect(threshold().readOnly).toBe(true);
    expect(weight().readOnly).toBe(true);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);

    const own = within(await openRow(rowOf("我的库"), "我的库")).getByRole("region", {
      name: "检索测试",
    });
    for (const name of ["相似度阈值", "向量权重"]) {
      expect((within(own).getByRole("spinbutton", { name }) as HTMLInputElement).readOnly).toBe(
        false,
      );
    }
  });
});
