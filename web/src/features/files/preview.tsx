/**
 * File preview components ported from resource/workbuddy-live-demo.html:3910-3938
 * (preview shell, code table, CSV table) and 3926 (JSON pretty-print).
 * Blob URLs are caller-owned; this module never allocates or revokes them.
 * Markdown mode is keyed by `path`; callers must remount across workspaces
 * if the same relative path can name different files.
 */
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { EmptyState, Icon } from "../../ui/index.js";
import { parseCsv } from "./csv.js";
import { fileIcon, formatSize } from "./file-meta.js";
import { type MdBlock, type MdInline, parseMarkdown } from "./md-render.js";

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

function preventInertNavigation(
  event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>,
) {
  if ("key" in event && event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
}

type InlineElementNode = Extract<MdInline, { type: "strong" | "link" }>;
type InlineRenderFrame = {
  nodes: MdInline[];
  index: number;
  children: ReactNode[];
  container: InlineElementNode | null;
};

function renderInlineElement(node: InlineElementNode, children: ReactNode[]): ReactNode {
  if (node.type === "strong") {
    return <strong key={node.source}>{children}</strong>;
  }
  return (
    // biome-ignore lint/a11y/useValidAnchor: controlled preview href="#" never navigates; destinations are dropped.
    <a
      href="#"
      key={node.source}
      onClick={preventInertNavigation}
      onKeyDown={preventInertNavigation}
    >
      {children}
    </a>
  );
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  const rendered: ReactNode[] = [];
  const stack: InlineRenderFrame[] = [{ nodes, index: 0, children: rendered, container: null }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as InlineRenderFrame;
    if (frame.index === frame.nodes.length) {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent && frame.container) {
        parent.children.push(renderInlineElement(frame.container, frame.children));
      }
      continue;
    }
    const node = frame.nodes[frame.index] as MdInline;
    frame.index += 1;
    if (node.type === "text") {
      frame.children.push(node.value);
      continue;
    }
    if (node.type === "code") {
      frame.children.push(<code key={node.source}>{node.value}</code>);
      continue;
    }
    stack.push({ nodes: node.children, index: 0, children: [], container: node });
  }
  return rendered;
}

function MarkdownHeading({ level, children }: { level: 1 | 2 | 3 | 4; children: ReactNode }) {
  if (level === 1) {
    return <h1>{children}</h1>;
  }
  if (level === 2) {
    return <h2>{children}</h2>;
  }
  if (level === 3) {
    return <h3>{children}</h3>;
  }
  return <h4>{children}</h4>;
}

function renderBlock(block: MdBlock): ReactNode {
  if (block.type === "heading") {
    return (
      <MarkdownHeading key={block.source} level={block.level}>
        {renderInline(block.children)}
      </MarkdownHeading>
    );
  }
  if (block.type === "paragraph") {
    return <p key={block.source}>{renderInline(block.children)}</p>;
  }
  if (block.type === "blockquote") {
    return <blockquote key={block.source}>{renderInline(block.children)}</blockquote>;
  }
  if (block.type === "rule") {
    return <hr key={block.source} />;
  }
  if (block.type === "code") {
    return (
      <pre key={block.source}>
        <code>{block.value}</code>
      </pre>
    );
  }
  if (block.type === "list") {
    const items = block.items.map((item) => (
      <li key={item.source}>{renderInline(item.children)}</li>
    ));
    if (block.ordered) {
      return <ol key={block.source}>{items}</ol>;
    }
    return <ul key={block.source}>{items}</ul>;
  }
  return (
    <table key={block.source}>
      <thead>
        <tr>
          {block.headers.map((cell) => (
            <th key={cell.source}>{renderInline(cell.children)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row) => (
          <tr key={row[0]?.source ?? block.source}>
            {row.map((cell) => (
              <td key={cell.source}>{renderInline(cell.children)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
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
      {parseMarkdown(text).map(renderBlock)}
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
        <button
          className="ui-button"
          onClick={() => setShowSource((current) => !current)}
          type="button"
        >
          {showSource ? "渲染视图" : "查看源码"}
        </button>
      </div>
      {body}
    </div>
  );
}
