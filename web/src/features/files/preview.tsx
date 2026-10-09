/**
 * File preview components ported from resource/workbuddy-live-demo.html:3910-3938
 * (preview shell, code table, CSV table) and 3926 (JSON pretty-print).
 * Blob URLs are caller-owned; this module never allocates or revokes them.
 * Markdown mode is keyed by `path`; callers must remount across workspaces
 * if the same relative path can name different files.
 * The `data-slot` names are the stable hooks tests and the UI walk select by.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiClient } from "../../lib/api.js";
import { MarkdownView } from "../../lib/markdown-view.js";
import { Icon } from "../../ui/index.js";
import { parseCsv } from "./csv.js";
import { fileIcon, formatMtime, formatSize } from "./file-meta.js";

type FilePreviewSuccess = Awaited<ReturnType<ApiClient["fetchPreview"]>>;

type PreviewState =
  | { status: "success"; data: FilePreviewSuccess }
  | { status: "error"; message: string }
  | { status: "unsupported" };

type PreviewPaneProps = {
  path: string;
  name: string;
  size: number;
  mtime: number;
  preview: PreviewState;
};

const SCROLL_BODY = "min-h-0 flex-1 overflow-auto";
const WIDE_TABLE = "w-max min-w-full border-collapse";
const CSV_CELL =
  "border border-(--wb-border-default) px-[0.6rem] py-[0.35rem] text-left [overflow-wrap:anywhere]";

/** Markdown typography: preflight strips list markers and heading weight, these put them back. */
const MARKDOWN_BODY = [
  SCROLL_BODY,
  "max-w-[52rem] px-5 pt-4 pb-6 [overflow-wrap:anywhere]",
  "[&_:is(h1,h2,h3,h4)]:mb-[0.6rem] [&_:is(h1,h2,h3,h4)]:leading-[1.35] [&_:is(h1,h2,h3,h4)]:font-bold",
  "[&_h1]:text-[1.35rem] [&_h2]:mt-[1.35rem] [&_h2]:text-[1rem]",
  "[&_:is(h3,h4)]:mt-[1.1rem] [&_:is(h3,h4)]:text-[0.9rem]",
  "[&_:is(p,ul,ol)]:mb-[0.65rem] [&_:is(ul,ol)]:pl-10 [&_ul]:list-disc [&_ol]:list-decimal",
  "[&_li]:my-[0.15rem]",
  "[&_code]:rounded-[4px] [&_code]:bg-(--wb-bg-secondary) [&_code]:px-[0.3rem] [&_code]:py-[0.05rem]",
  "[&_code]:font-(family-name:--wb-mono) [&_code]:text-[0.75rem]",
  "[&_pre]:overflow-auto [&_pre]:rounded-[8px] [&_pre]:border [&_pre]:border-(--wb-border-default)",
  "[&_pre]:bg-(--wb-bg-secondary) [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[0.8rem]",
  "[&_:is(th,td)]:border [&_:is(th,td)]:border-(--wb-border-default)",
  "[&_:is(th,td)]:px-[0.55rem] [&_:is(th,td)]:py-[0.35rem] [&_:is(th,td)]:text-left",
].join(" ");

function fileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

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

function lineDocuments(text: string): { source: number; value: string }[] {
  const lines = text.split("\n");
  let cursor = 0;
  return lines.map((value) => {
    const line = { source: cursor, value };
    cursor += value.length + 1;
    return line;
  });
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

export function CodeView({ text }: { text: string }) {
  return (
    <div className={`${SCROLL_BODY} py-[0.4rem]`} data-slot="preview-code">
      <table className={`${WIDE_TABLE} font-(family-name:--wb-mono) text-[0.75rem] leading-[1.55]`}>
        <tbody>
          {lineDocuments(text).map((line, lineNumber) => (
            <tr key={line.source}>
              <td className="w-[1%] py-0 pr-3 pl-[0.9rem] text-right align-top whitespace-nowrap text-(--wb-text-tertiary) select-none">
                {lineNumber + 1}
              </td>
              <td className="pr-4 whitespace-pre text-(--wb-text-primary)">
                {line.value === "" ? "\u00a0" : line.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function PreviewPane({ path, name, size, mtime, preview }: PreviewPaneProps) {
  const truncatedSize =
    preview.status === "success" && preview.data.truncated ? preview.data.size : null;
  return (
    <article className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header
        className="flex min-w-0 shrink-0 items-center gap-3 border-b border-(--wb-border-default) px-4 py-[0.65rem] narrow:flex-wrap narrow:items-start"
        data-slot="preview-header"
      >
        <span className="inline-flex flex-none text-(--wb-text-secondary)">
          <Icon name={fileIcon(name)} size={16} />
        </span>
        <p
          className="min-w-0 font-(family-name:--wb-mono) text-[0.75rem] [overflow-wrap:anywhere]"
          data-slot="preview-path"
        >
          {path}
        </p>
        <p
          className="ml-auto shrink text-[0.7rem] text-(--wb-text-tertiary) [overflow-wrap:anywhere] narrow:ml-0"
          data-slot="preview-meta"
        >{`${formatSize(size)} · ${formatMtime(mtime)}`}</p>
      </header>
      {truncatedSize === null ? null : (
        <p className="px-4 pt-[0.65rem] text-[13px] text-muted-foreground">{`预览已截断（原始大小 ${truncatedSize} B）`}</p>
      )}
      <PreviewBody key={path} name={name} preview={preview} size={size} />
    </article>
  );
}

function PreviewBody({
  name,
  preview,
  size,
}: {
  name: string;
  preview: PreviewState;
  size: number;
}) {
  if (preview.status === "unsupported") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          className="flex min-w-0 flex-col items-center justify-center gap-2.5 px-5 py-14 text-center text-(--wb-text-secondary)"
          data-slot="empty-state"
        >
          <p className="text-[14px] font-medium">该类型不支持预览</p>
          <p className="text-[12.5px] [overflow-wrap:anywhere]" data-slot="empty-state-desc">
            {`${name} · ${formatSize(size)}\u3000二进制或未识别格式`}
          </p>
        </div>
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <p
        className="rounded-lg bg-(--wb-status-error-soft-bg) px-2.5 py-2 text-[12px] text-(--wb-status-error-text)"
        role="alert"
      >
        {preview.message}
      </p>
    );
  }
  if (preview.data.kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--wb-bg-secondary) p-6">
        <img alt={name} className="max-h-full max-w-full rounded-[8px]" src={preview.data.url} />
      </div>
    );
  }
  const extension = fileExtension(name);
  if (extension === "csv") {
    return <CsvTable text={preview.data.text} />;
  }
  if (extension === "md") {
    return <MarkdownPreview text={preview.data.text} />;
  }
  return (
    <CodeView text={extension === "json" ? prettyJson(preview.data.text) : preview.data.text} />
  );
}

function RenderedMarkdownDocument({ text }: { text: string }) {
  return (
    <div className={MARKDOWN_BODY} data-markdown-body="" data-slot="preview-markdown">
      <MarkdownView source={text} />
    </div>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const [showSource, setShowSource] = useState(false);
  const body = showSource ? (
    <CodeView text={text} />
  ) : (
    // Replacing a content snapshot avoids React's sibling-placement scan on dense inline updates.
    <RenderedMarkdownDocument key={text} text={text} />
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-4 pt-2">
        <Button
          onClick={() => setShowSource((current) => !current)}
          type="button"
          variant="secondary"
        >
          {showSource ? "渲染视图" : "查看源码"}
        </Button>
      </div>
      {body}
    </div>
  );
}
