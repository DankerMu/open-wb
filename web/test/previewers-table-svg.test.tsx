import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { TablePreviewer } from "../src/features/files/previewers/table.js";

afterEach(cleanup);

function renderTable(name: string, content: string) {
  const { container } = render(<TablePreviewer content={content} name={name} />);
  const slot = container.querySelector('[data-slot="preview-table"]');
  return {
    container,
    headers: [...(slot?.querySelectorAll("thead th") ?? [])].map((node) => node.textContent),
    rows: [...(slot?.querySelectorAll("tbody tr") ?? [])].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    ),
    note: slot?.querySelector("p")?.textContent,
  };
}

// file-previewers「Markdown、表格、图片与 SVG」的场景「tsv 与 csv」：分隔符只由扩展名决定。
describe("表格预览器：tsv 与 csv", () => {
  it.each([
    ["t.tsv", "name\tvalue\nalpha\t1\nbeta\t2"],
    ["t.csv", "name,value\nalpha,1\nbeta,2"],
  ])("%s 的第一行是表头，其余两行各占两格，下方注明行数", (name, content) => {
    const table = renderTable(name, content);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "name",
      "value",
    ]);
    expect(table.headers).toEqual(["name", "value"]);
    expect(table.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
    expect(table.note).toBe("共 2 行 · 大文件仅预览前若干行");
  });

  it("扩展名大写的 T.TSV 同样按制表符分列", () => {
    const table = renderTable("T.TSV", "name\tvalue\nalpha\t1\nbeta\t2");

    expect(table.headers).toEqual(["name", "value"]);
    expect(table.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
  });

  it("不看内容猜分隔符：csv 里的制表符与 tsv 里的逗号都留在单元格里", () => {
    const csv = renderTable("t.csv", "a\tb\n1\t2");
    expect(csv.headers).toEqual(["a\tb"]);
    expect(csv.rows).toEqual([["1\t2"]]);
    cleanup();

    const tsv = renderTable("t.tsv", "a,b\n1,2");
    expect(tsv.headers).toEqual(["a,b"]);
    expect(tsv.rows).toEqual([["1,2"]]);
  });

  it("tsv 开头与结尾的空单元格各占一格，表头不相对数据左移", () => {
    // 首尾各一个换行：只去换行，不去紧挨着它的制表符。
    const table = renderTable("t.tsv", "\n\tx\n1\t\n");

    expect(table.headers).toEqual(["", "x"]);
    expect(table.rows).toEqual([["1", ""]]);
  });

  it("tsv 单元格里的标记是文字，不产生元素", () => {
    const table = renderTable("t.tsv", "h\tnote\n<script>alert(1)</script>\tplain");

    expect(table.rows).toEqual([["<script>alert(1)</script>", "plain"]]);
    expect(table.container.querySelector("script")).toBeNull();
  });

  it("经预览面板选中的 tsv 落到表格预览器并按制表符分列", async () => {
    render(
      <PreviewPane
        mtime={1_726_000_000_000}
        name="t.tsv"
        path="t.tsv"
        preview={{
          data: {
            kind: "text",
            size: 26,
            text: "name\tvalue\nalpha\t1\nbeta\t2\n",
            truncated: false,
          },
          status: "success",
        }}
        size={26}
        workspaceId="w1"
      />,
    );

    expect((await screen.findAllByRole("columnheader")).map((node) => node.textContent)).toEqual([
      "name",
      "value",
    ]);
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行")).toBeTruthy();
  });
});
