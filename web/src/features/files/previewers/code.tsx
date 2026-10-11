/**
 * Source previewer: the numbered code table ported from resource/workbuddy-live-demo.html:3910-3938
 * and the JSON pretty-print from 3926. `preview-code` is a stable hook tests and the UI walk select by.
 * Colouring (file-previewers「源码视图与语法高亮」) is a later update on top of that table: rows always
 * come from `lineDocuments`, a coloured line only replaces the children of its content cell, and
 * any failure leaves the plain numbered source without a message.
 */
import { type ReactNode, useEffect, useState } from "react";
import { loadHighlighter } from "./index.js";
import { fileExtension } from "./kind.js";

export const SCROLL_BODY = "min-h-0 flex-1 overflow-auto";
export const WIDE_TABLE = "w-max min-w-full border-collapse";

/**
 * Longer text stays uncoloured (still numbered): colouring runs on the main thread and adds an
 * element per token. The figure is a judgement call, not a spec value.
 */
const HIGHLIGHT_LIMIT = 100_000;

// `fileExtension` 对这两个名字返回空串，所以按整名匹配；大小写与后缀不同的写法不算。
const LANGUAGE_BY_FILE_NAME = new Map([
  ["Dockerfile", "dockerfile"],
  ["Makefile", "makefile"],
]);

const LANGUAGE_BY_EXTENSION = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "javascript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["json", "json"],
  ["css", "css"],
  ["scss", "scss"],
  ["html", "xml"],
  ["htm", "xml"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["py", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["sh", "bash"],
  ["sql", "sql"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  // highlight.js 的 ini 语法兼管 TOML（它的别名里有 toml）。
  ["toml", "ini"],
  ["ini", "ini"],
  ["md", "markdown"],
]);

/** 文件名对应的高亮语言；没有对应时为 null（不着色、仍带行号）。 */
export function highlightLanguage(name: string): string | null {
  return LANGUAGE_BY_FILE_NAME.get(name) ?? LANGUAGE_BY_EXTENSION.get(fileExtension(name)) ?? null;
}

/*
 * 语法类别到主题变量（web/src/styles/theme.css）的绑定。内建名的类别带下划线，而任意变体里的
 * 下划线会被当成空格，所以按类名前缀匹配它。
 */
const SYNTAX_COLORS = [
  "[&_:is(.hljs-keyword,.hljs-literal,.hljs-type,.hljs-meta,.hljs-doctag,.hljs-selector-tag,[class^=hljs-built])]:text-(--syntax-keyword)",
  "[&_:is(.hljs-string,.hljs-regexp,.hljs-symbol,.hljs-code,.hljs-link,.hljs-addition)]:text-(--syntax-string)",
  "[&_:is(.hljs-number,.hljs-bullet,.hljs-variable,.hljs-attr,.hljs-attribute,.hljs-deletion)]:text-(--syntax-number)",
  "[&_:is(.hljs-comment,.hljs-quote)]:text-(--syntax-comment)",
  "[&_:is(.hljs-title,.hljs-section,.hljs-name,.hljs-selector-class,.hljs-selector-id)]:text-(--syntax-title)",
  "[&_.hljs-strong]:font-bold [&_.hljs-emphasis]:italic",
].join(" ");

function lineDocuments(text: string): { source: number; value: string }[] {
  const lines = text.split("\n");
  let cursor = 0;
  return lines.map((value) => {
    const line = { source: cursor, value };
    cursor += value.length + 1;
    return line;
  });
}

type Colored = { text: string; language: string; lines: ReactNode[] };

/**
 * The coloured lines of `text`, or null while they are not there (and for good when `language`
 * is null or anything fails). Computed in an effect, so the plain source is committed first —
 * also when the highlighter is already loaded. The result is kept with the input it was made
 * from: after `text` changes, the previous colours are not shown against the new rows.
 */
function useColoredLines(text: string, language: string | null): ReactNode[] | null {
  const [colored, setColored] = useState<Colored | null>(null);
  useEffect(() => {
    if (language === null) return;
    let cancelled = false;
    loadHighlighter()
      .then((highlightLines) => {
        if (cancelled) return;
        const lines = highlightLines(text, language);
        if (lines.length === text.split("\n").length) setColored({ text, language, lines });
      })
      // 加载被拒绝、语言未注册、着色抛错：都保留未着色的源码，不显示错误。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [text, language]);
  return colored !== null && colored.text === text && colored.language === language
    ? colored.lines
    : null;
}

/** `name` 决定着色语言；`language` 给了就直接用它、不看 `name`；两个都不传即不着色。 */
export function CodeView({
  text,
  name,
  language: named,
}: {
  text: string;
  name?: string;
  language?: string;
}) {
  const byName = name === undefined ? null : highlightLanguage(name);
  const language = text.length > HIGHLIGHT_LIMIT ? null : (named ?? byName);
  const colored = useColoredLines(text, language);
  return (
    <div className={`${SCROLL_BODY} py-[0.4rem]`} data-slot="preview-code">
      <table
        className={`${WIDE_TABLE} font-(family-name:--wb-mono) text-[0.75rem] leading-[1.55] ${SYNTAX_COLORS}`}
      >
        <tbody>
          {lineDocuments(text).map((line, lineNumber) => (
            <tr key={line.source}>
              <td className="w-[1%] py-0 pr-3 pl-[0.9rem] text-right align-top whitespace-nowrap text-(--wb-text-tertiary) select-none">
                {lineNumber + 1}
              </td>
              <td className="pr-4 whitespace-pre text-(--wb-text-primary)">
                {line.value === "" ? "\u00a0" : (colored?.[lineNumber] ?? line.value)}
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

export function CodePreviewer({ name, content }: { name: string; content: string }) {
  return (
    <CodeView name={name} text={fileExtension(name) === "json" ? prettyJson(content) : content} />
  );
}
