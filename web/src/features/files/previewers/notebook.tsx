/**
 * Notebook previewer: a read-only rendering of nbformat 4 JSON, cell by cell, with no notebook
 * library (file-previewers「Notebook」). The file is untrusted, cell outputs included:
 *   - an HTML output is the document of an `iframe` whose `sandbox` attribute is empty, handed
 *     over as the original text with nothing added around it; nothing of it is parsed as markup
 *     of this document;
 *   - images are the `src` of an `img`: a fixed `data:` prefix followed by the content;
 *   - everything else reaches the page as React text nodes.
 * Parsing never throws and neither does rendering what it returns: every value read from the
 * JSON is checked for its shape first, because nothing above this module catches a render error.
 * Not valid JSON, no `cells` array or an `nbformat` other than the number 4 falls back to the
 * numbered source. No execution, no editing, no expanding of outputs.
 * `notebook-prompt` is a stable hook the tests select by; `preview-notebook` is one for the UI
 * walk, which nothing in the repository selects yet.
 */
import { useMemo } from "react";
import { MarkdownView } from "../../../lib/markdown-view.js";
import { CodeView, SCROLL_BODY } from "./code.js";
import { MARKDOWN_TYPOGRAPHY } from "./markdown.js";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** nbformat 的多行文本：一个字符串或字符串数组；数组里不是字符串的项略过，其它形状当空串。 */
function joined(value: unknown, separator = ""): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((part) => typeof part === "string").join(separator);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 未注册的语言名照样交给源码视图：它着色失败时保留未着色的源码。 */
function notebookLanguage(metadata: unknown): string {
  const meta = isRecord(metadata) ? metadata : {};
  const info = isRecord(meta.language_info) ? meta.language_info.name : null;
  const kernel = isRecord(meta.kernelspec) ? meta.kernelspec.language : null;
  return nonEmpty(info) ?? nonEmpty(kernel) ?? "python";
}

type Notebook = { cells: unknown[]; language: string };

function parseNotebook(text: string): Notebook | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(root) || root.nbformat !== 4 || !Array.isArray(root.cells)) return null;
  return { cells: root.cells, language: notebookLanguage(root.metadata) };
}

const ESCAPE = "\u001b";

/**
 * 去掉 ESC 字符；紧跟其后的 CSI 序列（方括号、参数、终结字节）一并去掉，其它序列只去 ESC。
 * 按 ESC 切开再逐段处理：正则字面量里不写控制字符。
 */
function stripAnsi(text: string): string {
  return text
    .split(ESCAPE)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;?]*[ -/]*[@-~]/, "")))
    .join("");
}

function errorText(output: Json): string {
  const traceback = stripAnsi(joined(output.traceback, "\n"));
  if (traceback !== "") return traceback;
  return stripAnsi([nonEmpty(output.ename), nonEmpty(output.evalue)].filter(Boolean).join(": "));
}

/** 媒体类型在第一个逗号之前、由这里写死；内容只去掉空白后接在后面。 */
const BITMAP_PREFIXES = [
  ["image/png", "data:image/png;base64,"],
  ["image/jpeg", "data:image/jpeg;base64,"],
] as const;
const SVG = "image/svg+xml";

/** JSON 里可以有孤立的代理字符，百分号编码遇到它会抛错：那时没有地址。 */
function svgAddress(text: string): string | null {
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  } catch {
    return null;
  }
}

const MONO =
  "m-0 overflow-x-auto font-(family-name:--wb-mono) text-[0.75rem] leading-[1.55] whitespace-pre text-(--wb-text-primary)";

function Mono({ text }: { text: string }) {
  return <pre className={MONO}>{text}</pre>;
}

function Unsupported({ type }: { type: string }) {
  return <p className="text-[13px] text-muted-foreground">{`不支持的输出类型 ${type}`}</p>;
}

function OutputImage({ src }: { src: string }) {
  return <img alt="图片输出" className="max-w-full" src={src} />;
}

/** 一个输出的多种表示里只取一种：图片先于 HTML，HTML 先于纯文本。 */
function RichOutput({ data }: { data: Json }) {
  for (const [type, prefix] of BITMAP_PREFIXES) {
    if (data[type] !== undefined) {
      return <OutputImage src={`${prefix}${joined(data[type]).replace(/\s/g, "")}`} />;
    }
  }
  if (data[SVG] !== undefined) {
    const src = svgAddress(joined(data[SVG]));
    return src === null ? <Unsupported type={SVG} /> : <OutputImage src={src} />;
  }
  if (data["text/html"] !== undefined) {
    // 输出是为白底写的：透明的框在深色主题下会把它默认的深色文字叠在深色底上。高度固定，不量内容。
    return (
      <iframe
        className="block h-[20rem] w-full rounded-[8px] border border-(--wb-border-default) bg-white"
        sandbox=""
        srcDoc={joined(data["text/html"])}
        title="HTML 输出"
      />
    );
  }
  if (data["text/plain"] !== undefined) return <Mono text={joined(data["text/plain"])} />;
  const [first] = Object.keys(data);
  return first === undefined ? null : <Unsupported type={first} />;
}

/** 不是对象、或 `output_type` 不是字符串的输出没有可说的类型名，不显示。 */
function Output({ output }: { output: unknown }) {
  if (!isRecord(output) || typeof output.output_type !== "string") return null;
  switch (output.output_type) {
    case "stream":
      return <Mono text={joined(output.text)} />;
    case "error":
      return <Mono text={errorText(output)} />;
    case "display_data":
    case "execute_result":
      return <RichOutput data={isRecord(output.data) ? output.data : {}} />;
    default:
      return <Unsupported type={output.output_type} />;
  }
}

function CodeCell({ cell, language }: { cell: Json; language: string }) {
  const count = cell.execution_count;
  // 输出没有可当 key 的标识：按位置编号。
  const outputs = (Array.isArray(cell.outputs) ? cell.outputs : []).map((output, position) => ({
    output,
    position,
  }));
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className="w-12 shrink-0 pt-[0.4rem] text-right font-(family-name:--wb-mono) text-[0.75rem] leading-[1.55] whitespace-pre text-(--wb-text-tertiary)"
        data-slot="notebook-prompt"
      >
        {Number.isInteger(count) ? `[${String(count)}]` : "[ ]"}
      </span>
      <div className="min-w-0 flex-1 [&>*+*]:mt-2">
        <div className="flex min-w-0 rounded-[8px] border border-(--wb-border-default) bg-(--wb-bg-secondary)">
          <CodeView language={language} text={joined(cell.source)} />
        </div>
        {outputs.map(({ output, position }) => (
          <Output key={position} output={output} />
        ))}
      </div>
    </div>
  );
}

/** 不是对象、或 `cell_type` 不认识的单元与 raw 单元一样：等宽显示它的 `source`。 */
function Cell({ cell, language }: { cell: unknown; language: string }) {
  const record = isRecord(cell) ? cell : {};
  if (record.cell_type === "code") return <CodeCell cell={record} language={language} />;
  const source = joined(record.source);
  if (record.cell_type === "markdown") {
    return (
      <div className={MARKDOWN_TYPOGRAPHY}>
        <MarkdownView source={source} />
      </div>
    );
  }
  return <Mono text={source} />;
}

export function NotebookPreviewer({
  name,
  content,
  truncated,
}: {
  name: string;
  content: string;
  truncated: boolean;
}) {
  // 被截断的 JSON 不解析（服务端对 Notebook 不截断，超限是 413；这里只是不依赖它）。
  const parsed = useMemo(() => (truncated ? null : parseNotebook(content)), [content, truncated]);
  if (parsed === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <p className="shrink-0 px-4 pt-[0.65rem] text-[13px] text-muted-foreground">
          无法按 Notebook 解析，显示源码
        </p>
        <CodeView name={name} text={content} />
      </div>
    );
  }
  // 单元格没有可靠的标识（`id` 可缺、可重复）：按位置编号。
  const cells = parsed.cells.map((cell, position) => ({ cell, position }));
  return (
    <div className={`${SCROLL_BODY} px-4 pt-3 pb-6 [&>*+*]:mt-4`} data-slot="preview-notebook">
      {cells.map(({ cell, position }) => (
        <Cell cell={cell} key={position} language={parsed.language} />
      ))}
    </div>
  );
}
