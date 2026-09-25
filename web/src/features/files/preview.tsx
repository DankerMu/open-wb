/**
 * File preview components ported from resource/workbuddy-live-demo.html:3910-3938
 * (preview shell, code table, CSV table) and 3926 (JSON pretty-print).
 * Blob URLs are caller-owned; this module never allocates or revokes them.
 * Markdown mode is keyed by `path`; callers must remount across workspaces
 * if the same relative path can name different files.
 */
import { useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { MarkdownView } from "../../lib/markdown-view.js";
import { Button, EmptyState, Icon } from "../../ui/index.js";
import { parseCsv } from "./csv.js";
import { fileIcon, formatSize } from "./file-meta.js";

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
    <div className="files-table">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header.source}>{header.value}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]?.source ?? headers[0]?.source}>
              {row.map((cell) => (
                <td key={cell.source}>{cell.value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="files-table-note">{`共 ${parsed.rows.length} 行 · 大文件仅预览前若干行`}</p>
    </div>
  );
}

export function CodeView({ text }: { text: string }) {
  return (
    <div className="files-code">
      <table>
        <tbody>
          {lineDocuments(text).map((line, lineNumber) => (
            <tr key={line.source}>
              <td className="files-code-ln">{lineNumber + 1}</td>
              <td className="files-code-text">{line.value === "" ? "\u00a0" : line.value}</td>
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
    <article className="files-preview-pane">
      <header className="files-preview-toolbar">
        <span className="files-preview-icon">
          <Icon name={fileIcon(name)} size={16} />
        </span>
        <p className="files-preview-path">{path}</p>
        <p className="files-preview-meta">{`${formatSize(size)} · ${new Date(mtime).toISOString()}`}</p>
      </header>
      {truncatedSize === null ? null : (
        <p className="files-preview-truncation ui-muted">{`预览已截断（原始大小 ${truncatedSize} B）`}</p>
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
      <div className="files-preview-empty">
        <EmptyState
          description={`${name} · ${formatSize(size)}\u3000二进制或未识别格式`}
          title="该类型不支持预览"
        />
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <p className="files-preview-message ui-alert" role="alert">
        {preview.message}
      </p>
    );
  }
  if (preview.data.kind === "image") {
    return (
      <div className="files-image">
        <img alt={name} src={preview.data.url} />
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
    <div className="files-md" data-markdown-body="">
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
    <div className="files-preview-body">
      <div className="files-md-toolbar">
        <Button onClick={() => setShowSource((current) => !current)}>
          {showSource ? "渲染视图" : "查看源码"}
        </Button>
      </div>
      {body}
    </div>
  );
}
