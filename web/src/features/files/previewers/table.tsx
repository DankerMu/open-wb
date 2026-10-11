/**
 * Table previewer: the CSV table ported from resource/workbuddy-live-demo.html:3910-3938.
 * `preview-table` is a stable hook tests and the UI walk select by.
 */
import { parseCsv } from "../csv.js";
import { CodeView, SCROLL_BODY, WIDE_TABLE } from "./code.js";
import { fileExtension } from "./kind.js";

const CSV_CELL =
  "border border-(--wb-border-default) px-[0.6rem] py-[0.35rem] text-left [overflow-wrap:anywhere]";

function csvCells(
  headers: string[],
  rows: string[][],
): { headers: { source: number; value: string }[]; rows: { source: number; value: string }[][] } {
  let cursor = 0;
  function annotate(values: string[]): { source: number; value: string }[] {
    return values.map((value) => {
      const cell = { source: cursor, value };
      cursor += value.length + 1;
      return cell;
    });
  }
  return { headers: annotate(headers), rows: rows.map(annotate) };
}

export function CsvTable({ text }: { text: string }) {
  const parsed = parseCsv(text);
  const { headers, rows } = csvCells(parsed.headers, parsed.rows);
  return (
    <div className={`${SCROLL_BODY} px-4 pt-3 pb-5`} data-slot="preview-table">
      <table className={`${WIDE_TABLE} text-[0.8rem]`}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th className={CSV_CELL} key={header.source}>
                {header.value}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]?.source ?? headers[0]?.source}>
              {row.map((cell) => (
                <td className={CSV_CELL} key={cell.source}>
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-[0.65rem] text-[0.75rem] text-(--wb-text-tertiary)">{`共 ${parsed.rows.length} 行 · 大文件仅预览前若干行`}</p>
    </div>
  );
}

/** `tsv` 按制表符分列之前先显示源码：按逗号分列会把一行挤进一个单元格。 */
export function TablePreviewer({ name, content }: { name: string; content: string }) {
  return fileExtension(name) === "tsv" ? <CodeView text={content} /> : <CsvTable text={content} />;
}
