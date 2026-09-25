/**
 * React renderer for the shared Markdown subset (lib/md-render.ts); moved from
 * features/files/preview.tsx unchanged. Emits React elements only: source HTML stays text,
 * links are inert (href="#", destinations dropped).
 */
import { type KeyboardEvent, type MouseEvent, type ReactNode, useMemo } from "react";
import { type MdBlock, type MdInline, parseMarkdown } from "./md-render.js";

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

export function MarkdownView({ source }: { source: string }) {
  const rendered = useMemo(() => parseMarkdown(source).map(renderBlock), [source]);
  return <>{rendered}</>;
}
