/**
 * Markdown subset renderer ported from resource/workbuddy-live-demo.html:1145-1185.
 * Corrections vs demo: parse fences/blocks before inline; escape at emission;
 * recognize blockquotes on raw source. Destinations are dropped; links emit href="#".
 * One canonical parser produces closed nodes; mdRender serializes them.
 */

const ESCAPE_CHARS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export type MdInline =
  | { type: "text"; source: number; value: string }
  | { type: "code"; source: number; value: string }
  | { type: "strong"; source: number; children: MdInline[] }
  | { type: "link"; source: number; children: MdInline[] };

type MdListItem = { source: number; children: MdInline[] };
type MdTableCell = { source: number; children: MdInline[] };

export type MdBlock =
  | { type: "heading"; source: number; level: 1 | 2 | 3 | 4; children: MdInline[] }
  | { type: "paragraph"; source: number; children: MdInline[] }
  | { type: "blockquote"; source: number; children: MdInline[] }
  | { type: "rule"; source: number }
  | { type: "list"; source: number; ordered: boolean; items: MdListItem[] }
  | { type: "code"; source: number; value: string }
  | { type: "table"; source: number; headers: MdTableCell[]; rows: MdTableCell[][] };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE_CHARS[char] ?? char);
}

function isTableRow(line: string | undefined): line is string {
  return line !== undefined && /^\|.*\|$/.test(line);
}

function appendText(nodes: MdInline[], value: string, source: number) {
  if (value === "") {
    return;
  }
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") {
    last.value += value;
    return;
  }
  nodes.push({ type: "text", source, value });
}

function parseDecoratedText(value: string, base: number): MdInline[] {
  const nodes: MdInline[] = [];
  let lastIndex = 0;
  const pattern = /\*\*([^*\n]+)\*\*|\[([^\]]+)\]\((\S+)\)/g;
  for (const match of value.matchAll(pattern)) {
    appendText(nodes, value.slice(lastIndex, match.index), base + lastIndex);
    if (match[1] !== undefined) {
      nodes.push({
        type: "strong",
        source: base + match.index,
        children: [{ type: "text", source: base + match.index + 2, value: match[1] }],
      });
    } else {
      nodes.push({
        type: "link",
        source: base + match.index,
        children: [{ type: "text", source: base + match.index + 1, value: match[2] ?? "" }],
      });
    }
    lastIndex = match.index + match[0].length;
  }
  appendText(nodes, value.slice(lastIndex), base + lastIndex);
  return nodes;
}

function parseInline(value: string, base: number): MdInline[] {
  const nodes: MdInline[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(/`([^`\n]*)`/g)) {
    nodes.push(...parseDecoratedText(value.slice(lastIndex, match.index), base + lastIndex));
    nodes.push({ type: "code", source: base + match.index, value: match[1] ?? "" });
    lastIndex = match.index + match[0].length;
  }
  const leftover = value.slice(lastIndex);
  const leftoverTick = leftover.indexOf("`");
  if (leftoverTick < 0) {
    nodes.push(...parseDecoratedText(leftover, base + lastIndex));
    return nodes;
  }
  nodes.push(...parseDecoratedText(leftover.slice(0, leftoverTick), base + lastIndex));
  appendText(nodes, leftover.slice(leftoverTick), base + lastIndex + leftoverTick);
  return nodes;
}

function parseTableCells(line: string, lineStart: number): MdTableCell[] {
  let cursor = lineStart + 1;
  return line
    .slice(1, -1)
    .split("|")
    .map((part) => {
      const trimStart = part.length - part.trimStart().length;
      const value = part.trim();
      const source = cursor + trimStart;
      cursor += part.length + 1;
      return { source, children: parseInline(value, source) };
    });
}

function tryParseTable(
  lines: string[],
  index: number,
  starts: number[],
): { block: Extract<MdBlock, { type: "table" }>; end: number } | null {
  const line = lines[index];
  const separator = lines[index + 1];
  if (!isTableRow(line) || separator === undefined || !/^\|[\s\-:|]+\|$/.test(separator)) {
    return null;
  }

  const rows: MdTableCell[][] = [];
  let cursor = index + 2;
  let rowLine: string | undefined = lines[cursor];
  while (isTableRow(rowLine)) {
    rows.push(parseTableCells(rowLine, starts[cursor] ?? 0));
    cursor += 1;
    rowLine = lines[cursor];
  }
  return {
    block: {
      type: "table",
      source: starts[index] ?? 0,
      headers: parseTableCells(line, starts[index] ?? 0),
      rows,
    },
    end: cursor - 1,
  };
}

class MarkdownParser {
  private blocks: MdBlock[] = [];
  private list: Extract<MdBlock, { type: "list" }> | null = null;
  private inCode = false;
  private codeBuf: string[] = [];
  private codeStart = 0;
  private lineStart = 0;
  private starts: number[] = [];

  parse(src: string): MdBlock[] {
    const lines = src.split("\n");
    this.starts = lineStarts(lines);
    for (let index = 0; index < lines.length; index += 1) {
      this.lineStart = this.starts[index] ?? 0;
      index = this.consume(lines, index);
    }
    this.closeList();
    this.flushOpenCode();
    return this.blocks;
  }

  private consume(lines: string[], index: number): number {
    const line = lines[index] ?? "";
    if (this.consumeFence(line) || this.consumeCodeLine(line)) {
      return index;
    }
    if (this.consumeHeading(line) || this.consumeQuote(line) || this.consumeRule(line)) {
      return index;
    }
    if (this.consumeUnordered(line) || this.consumeOrdered(line)) {
      return index;
    }
    const tableEnd = this.consumeTable(lines, index);
    if (tableEnd !== null) {
      return tableEnd;
    }
    this.consumeParagraph(line);
    return index;
  }

  private closeList() {
    this.list = null;
  }

  private flushOpenCode() {
    if (!this.inCode) {
      return;
    }
    this.blocks.push({ type: "code", source: this.codeStart, value: this.codeBuf.join("\n") });
    this.inCode = false;
    this.codeBuf = [];
  }

  private consumeFence(line: string): boolean {
    if (!line.trim().startsWith("```")) {
      return false;
    }
    if (this.inCode) {
      this.flushOpenCode();
      return true;
    }
    this.closeList();
    this.inCode = true;
    this.codeStart = this.lineStart;
    this.codeBuf = [];
    return true;
  }

  private consumeCodeLine(line: string): boolean {
    if (!this.inCode) {
      return false;
    }
    this.codeBuf.push(line);
    return true;
  }

  private consumeHeading(line: string): boolean {
    const heading = /^(#{1,4})\s+(.*)/.exec(line);
    if (!heading) {
      return false;
    }
    this.closeList();
    const marker = heading[1] ?? "#";
    const content = heading[2] ?? "";
    const contentStart = this.lineStart + marker.length + 1;
    this.blocks.push({
      type: "heading",
      source: this.lineStart,
      level: marker.length as 1 | 2 | 3 | 4,
      children: parseInline(content, contentStart),
    });
    return true;
  }

  private consumeQuote(line: string): boolean {
    if (!/^>\s?/.test(line)) {
      return false;
    }
    this.closeList();
    const content = line.replace(/^>\s?/, "");
    this.blocks.push({
      type: "blockquote",
      source: this.lineStart,
      children: parseInline(content, this.lineStart + line.length - content.length),
    });
    return true;
  }

  private consumeRule(line: string): boolean {
    if (!/^---+\s*$/.test(line)) {
      return false;
    }
    this.closeList();
    this.blocks.push({ type: "rule", source: this.lineStart });
    return true;
  }

  private consumeUnordered(line: string): boolean {
    return this.consumeListItem(line, /^\s*[-*]\s+(.*)/, false);
  }

  private consumeOrdered(line: string): boolean {
    return this.consumeListItem(line, /^\s*\d+[.、]\s+(.*)/, true);
  }

  private consumeListItem(line: string, pattern: RegExp, ordered: boolean): boolean {
    const item = pattern.exec(line);
    if (!item) {
      return false;
    }
    this.openList(ordered);
    const content = item[1] ?? "";
    this.list?.items.push({
      source: this.lineStart,
      children: parseInline(content, this.lineStart + line.length - content.length),
    });
    return true;
  }

  private consumeTable(lines: string[], index: number): number | null {
    const table = tryParseTable(lines, index, this.starts);
    if (!table) {
      return null;
    }
    this.closeList();
    this.blocks.push(table.block);
    return table.end;
  }

  private consumeParagraph(line: string) {
    this.closeList();
    if (line.trim() === "") {
      return;
    }
    this.blocks.push({
      type: "paragraph",
      source: this.lineStart,
      children: parseInline(line, this.lineStart),
    });
  }

  private openList(ordered: boolean) {
    if (this.list && this.list.ordered === ordered) {
      return;
    }
    this.closeList();
    const next: Extract<MdBlock, { type: "list" }> = {
      type: "list",
      source: this.lineStart,
      ordered,
      items: [],
    };
    this.blocks.push(next);
    this.list = next;
  }
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) {
    starts.push(position);
    position += line.length + 1;
  }
  return starts;
}

export function parseMarkdown(src: string): MdBlock[] {
  return new MarkdownParser().parse(src);
}

function serializeInline(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return escapeHtml(node.value);
      }
      if (node.type === "code") {
        return `<code>${escapeHtml(node.value)}</code>`;
      }
      if (node.type === "strong") {
        return `<strong>${serializeInline(node.children)}</strong>`;
      }
      return `<a href="#">${serializeInline(node.children)}</a>`;
    })
    .join("");
}

function serializeBlock(block: MdBlock): string {
  if (block.type === "heading") {
    return `<h${block.level}>${serializeInline(block.children)}</h${block.level}>`;
  }
  if (block.type === "paragraph") {
    return `<p>${serializeInline(block.children)}</p>`;
  }
  if (block.type === "blockquote") {
    return `<blockquote>${serializeInline(block.children)}</blockquote>`;
  }
  if (block.type === "rule") {
    return "<hr>";
  }
  if (block.type === "code") {
    return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
  }
  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items.map((item) => `<li>${serializeInline(item.children)}</li>`).join("");
    return `<${tag}>${items}</${tag}>`;
  }
  const head = block.headers.map((cell) => `<th>${serializeInline(cell.children)}</th>`).join("");
  const body = block.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${serializeInline(cell.children)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function mdRender(src: string): string {
  return parseMarkdown(src).map(serializeBlock).join("");
}
