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
const DESTINATION_WHITESPACE = /\s/u;
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

type InlineCodeSpan = {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
};

type InlineFormatSpan = {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
};

type FormatKind = "strong" | "link";
type FormatCursor = {
  type: FormatKind;
  spans: InlineFormatSpan[];
  index: number;
  opening: boolean;
};

type InlineFrame =
  | { type: "strong"; source: number; children: MdInline[] }
  | { type: "link"; source: number; children: MdInline[] }
  | { type: "code"; source: number; value: string };

function collectCodeSpans(value: string): { spans: InlineCodeSpan[]; opaqueFrom: number } {
  const spans: InlineCodeSpan[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "`") {
      index += 1;
      continue;
    }
    const contentStart = index + 1;
    const contentEnd = value.indexOf("`", contentStart);
    if (contentEnd < 0) {
      return { spans, opaqueFrom: index };
    }
    spans.push({ start: index, contentStart, contentEnd, end: contentEnd + 1 });
    index = contentEnd + 1;
  }
  return { spans, opaqueFrom: value.length };
}

function scanStrong(
  value: string,
  index: number,
  codeSpans: InlineCodeSpan[],
  codeIndex: number,
  opaqueFrom: number,
): InlineFormatSpan | null {
  let cursor = index + 2;
  let nextCode = codeIndex;
  while (cursor < opaqueFrom - 1) {
    const code = codeSpans[nextCode];
    if (code && code.start <= cursor && cursor < code.end) {
      cursor = code.end;
      nextCode += 1;
      continue;
    }
    const char = value[cursor];
    if (char === "\n" || char === "*") {
      if (char === "*" && value[cursor + 1] === "*" && cursor > index + 2) {
        return { start: index, contentStart: index + 2, contentEnd: cursor, end: cursor + 2 };
      }
      return null;
    }
    cursor += 1;
  }
  return null;
}

function scanFormat(
  format: FormatKind,
  value: string,
  index: number,
  codeSpans: InlineCodeSpan[],
  codeIndex: number,
  opaqueFrom: number,
  links: LinkLookahead | null,
): InlineFormatSpan | null {
  if (format === "strong") {
    return value[index] === "*" && value[index + 1] === "*"
      ? scanStrong(value, index, codeSpans, codeIndex, opaqueFrom)
      : null;
  }
  return value[index] === "[" ? (links?.scan(index) ?? null) : null;
}

function collectFormatSpans(
  format: FormatKind,
  value: string,
  codeSpans: InlineCodeSpan[],
  opaqueFrom: number,
): InlineFormatSpan[] {
  const spans: InlineFormatSpan[] = [];
  const links = format === "link" ? new LinkLookahead(value, opaqueFrom) : null;
  let codeIndex = 0;
  let index = 0;
  while (index < opaqueFrom) {
    const code = codeSpans[codeIndex];
    if (code?.start === index) {
      index = code.end;
      codeIndex += 1;
      continue;
    }
    const span = scanFormat(format, value, index, codeSpans, codeIndex, opaqueFrom, links);
    if (span) {
      spans.push(span);
      index = span.end;
      while ((codeSpans[codeIndex]?.start ?? opaqueFrom) < index) {
        codeIndex += 1;
      }
      continue;
    }
    index += 1;
  }
  return spans;
}

/**
 * The parser cursor only increases. Label and destination starts therefore only
 * increase too, so each cached closer is reused until passed; exhausted suffixes
 * are never searched again. Label and destination terminators retain the demo's
 * raw punctuation recognition.
 */
class LinkLookahead {
  private readonly value: string;
  private readonly opaqueFrom: number;
  private labelEnd = -1;
  private labelsExhausted = false;
  private terminator = -1;
  private terminatorsExhausted = false;

  constructor(value: string, opaqueFrom: number) {
    this.value = value;
    this.opaqueFrom = opaqueFrom;
  }

  scan(index: number): InlineFormatSpan | null {
    const labelEnd = this.labelAfter(index + 1);
    if (labelEnd < 0 || this.value[labelEnd + 1] !== "(") {
      return null;
    }
    const destinationStart = labelEnd + 2;
    const terminator = this.terminatorAfter(destinationStart);
    if (
      terminator < 0 ||
      this.value[terminator] !== ")" ||
      labelEnd === index + 1 ||
      terminator === destinationStart
    ) {
      return null;
    }
    return { start: index, contentStart: index + 1, contentEnd: labelEnd, end: terminator + 1 };
  }

  private labelAfter(start: number): number {
    if (this.labelsExhausted) {
      return -1;
    }
    if (this.labelEnd >= start) {
      return this.labelEnd;
    }
    for (let index = start; index < this.opaqueFrom; index += 1) {
      if (this.value[index] === "]") {
        this.labelEnd = index;
        return index;
      }
    }
    this.labelsExhausted = true;
    return -1;
  }

  private terminatorAfter(start: number): number {
    if (this.terminatorsExhausted) {
      return -1;
    }
    if (this.terminator >= start) {
      return this.terminator;
    }
    for (let index = start; index < this.opaqueFrom; index += 1) {
      const char = this.value[index] ?? "";
      if (char === ")" || DESTINATION_WHITESPACE.test(char)) {
        this.terminator = index;
        return index;
      }
    }
    this.terminatorsExhausted = true;
    return -1;
  }
}

/**
 * Projects the demo's code, strong, then link replacement order into closed
 * nodes. Crossing strong/link boundaries close intervening frames and lazily
 * reconstruct them when visible content resumes, matching the demo DOM without
 * emitting malformed HTML.
 */
class InlineProjection {
  private readonly value: string;
  private readonly base: number;
  private readonly codeSpans: InlineCodeSpan[];
  private readonly strongCursor: FormatCursor;
  private readonly linkCursor: FormatCursor;
  private readonly nodes: MdInline[] = [];
  private readonly stack: InlineFrame[] = [];
  private pending: FormatKind[] = [];
  private sourceCursor = 0;
  private codeIndex = 0;
  private codeOpening = true;

  constructor(
    value: string,
    base: number,
    codeSpans: InlineCodeSpan[],
    strongSpans: InlineFormatSpan[],
    linkSpans: InlineFormatSpan[],
  ) {
    this.value = value;
    this.base = base;
    this.codeSpans = codeSpans;
    this.strongCursor = { type: "strong", spans: strongSpans, index: 0, opening: true };
    this.linkCursor = { type: "link", spans: linkSpans, index: 0, opening: true };
  }

  run(): MdInline[] {
    while (this.consumeNextBoundary()) {}
    this.appendSourceText(this.sourceCursor, this.value.length);
    this.pending = [];
    for (let frame = this.stack.pop(); frame; frame = this.stack.pop()) {
      this.closeFrame(frame);
    }
    return this.nodes;
  }

  private consumeNextBoundary(): boolean {
    const codePosition = this.codePosition();
    const strongPosition = this.formatPosition(this.strongCursor);
    const linkPosition = this.formatPosition(this.linkCursor);
    if (
      codePosition === Number.POSITIVE_INFINITY &&
      strongPosition === Number.POSITIVE_INFINITY &&
      linkPosition === Number.POSITIVE_INFINITY
    ) {
      return false;
    }
    if (codePosition <= strongPosition && codePosition <= linkPosition) {
      this.consumeCode();
      return true;
    }
    if (strongPosition <= linkPosition) {
      this.consumeFormat(this.strongCursor);
      return true;
    }
    this.consumeFormat(this.linkCursor);
    return true;
  }

  private codePosition(): number {
    const code = this.codeSpans[this.codeIndex];
    return code ? (this.codeOpening ? code.start : code.contentEnd) : Number.POSITIVE_INFINITY;
  }

  private formatPosition(cursor: FormatCursor): number {
    const span = cursor.spans[cursor.index];
    return span ? (cursor.opening ? span.start : span.contentEnd) : Number.POSITIVE_INFINITY;
  }

  private consumeCode() {
    const code = this.codeSpans[this.codeIndex];
    if (!code) {
      return;
    }
    const opening = this.codeOpening;
    const position = opening ? code.start : code.contentEnd;
    if (position >= this.sourceCursor) {
      this.appendSourceText(this.sourceCursor, position);
      if (opening) {
        if (code.contentStart < code.contentEnd) {
          this.ensurePending(this.base + code.start);
        }
        this.stack.push({ type: "code", source: this.base + code.start, value: "" });
        this.sourceCursor = code.contentStart;
      } else {
        this.closeCode();
        this.sourceCursor = code.end;
      }
    }
    this.codeOpening = !opening;
    if (this.codeOpening) {
      this.codeIndex += 1;
    }
  }

  private consumeFormat(cursor: FormatCursor) {
    const span = cursor.spans[cursor.index];
    if (!span) {
      return;
    }
    const opening = cursor.opening;
    const position = opening ? span.start : span.contentEnd;
    if (position >= this.sourceCursor) {
      this.appendSourceText(this.sourceCursor, position);
      if (opening) {
        this.openFormat(cursor.type, this.base + span.start);
        this.sourceCursor = span.contentStart;
      } else {
        this.closeFormat(cursor.type);
        this.sourceCursor = span.end;
      }
    }
    cursor.opening = !opening;
    if (cursor.opening) {
      cursor.index += 1;
    }
  }

  private appendNode(node: MdInline) {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) {
      this.nodes.push(node);
      return;
    }
    if (parent.type !== "code") {
      parent.children.push(node);
    }
  }

  private closeFrame(frame: InlineFrame) {
    if (frame.type === "code") {
      this.appendNode({ type: "code", source: frame.source, value: frame.value });
      return;
    }
    this.appendNode({ type: frame.type, source: frame.source, children: frame.children });
  }

  private ensurePending(source: number) {
    for (let type = this.pending.pop(); type; type = this.pending.pop()) {
      this.stack.push({ type, source, children: [] });
    }
  }

  private appendSourceText(start: number, end: number) {
    if (start === end) {
      return;
    }
    this.ensurePending(this.base + start);
    const text = this.value.slice(start, end);
    const parent = this.stack[this.stack.length - 1];
    if (parent?.type === "code") {
      parent.value += text;
      return;
    }
    appendText(parent?.children ?? this.nodes, text, this.base + start);
  }

  private openFormat(type: FormatKind, source: number) {
    this.ensurePending(source);
    this.stack.push({ type, source, children: [] });
  }

  private closeFormat(type: FormatKind) {
    const target = this.findFormat(type);
    if (target < 0) {
      this.removePendingFormat(type);
      return;
    }
    const displaced = this.closeInterveningFrames(target);
    this.closeFrame(this.stack.pop() as InlineFrame);
    if (displaced.length > 0) {
      this.pending = displaced;
    }
  }

  private findFormat(type: FormatKind): number {
    for (let index = this.stack.length - 1; index >= 0; index -= 1) {
      if (this.stack[index]?.type === type) {
        return index;
      }
    }
    return -1;
  }

  private removePendingFormat(type: FormatKind) {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index] === type) {
        this.pending.splice(index, 1);
        return;
      }
    }
  }

  private closeInterveningFrames(target: number): FormatKind[] {
    const displaced: FormatKind[] = [];
    while (this.stack.length - 1 > target) {
      const frame = this.stack.pop() as InlineFrame;
      this.closeFrame(frame);
      if (frame.type !== "code") {
        displaced.push(frame.type);
      }
    }
    return displaced;
  }

  private closeCode() {
    const frame = this.stack[this.stack.length - 1];
    if (frame?.type !== "code") {
      return;
    }
    this.closeFrame(this.stack.pop() as InlineFrame);
  }
}

function parseInline(value: string, base: number): MdInline[] {
  const { spans: codeSpans, opaqueFrom } = collectCodeSpans(value);
  const strongSpans = collectFormatSpans("strong", value, codeSpans, opaqueFrom);
  const linkSpans = collectFormatSpans("link", value, codeSpans, opaqueFrom);
  return new InlineProjection(value, base, codeSpans, strongSpans, linkSpans).run();
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
