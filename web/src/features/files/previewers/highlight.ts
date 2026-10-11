/**
 * Syntax colouring for the source view (file-previewers「源码视图与语法高亮」). Its own on-demand
 * chunk: only `index.ts` reaches it, through `loadHighlighter`, so the numbered source is on
 * screen before this module and its grammars are fetched. `lowlight` yields a syntax tree; the
 * tree becomes React elements — file content is never handed to an HTML parser.
 * Only the grammars `highlightLanguage` (code.tsx) can name are registered.
 */
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

const lowlight = createLowlight({
  bash,
  c,
  cpp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  makefile,
  markdown,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
});

// hast 的类型从 lowlight 的返回值推导，不直接依赖 `hast` 的类型包。
type Root = ReturnType<typeof lowlight.highlight>;
type RootChild = Root["children"][number];
type ElementNode = Extract<RootChild, { type: "element" }>;
type Child = ElementNode["children"][number];

/**
 * 把一段子节点按换行切成若干行：第一段接在当前行后面，其后每段另起一行。跨行的记号
 * （块注释、模板串、文档串）在每一行各复制一层外壳，所以每行仍带着它的类别。
 */
function splitLines(children: Child[]): Child[][] {
  const lines: Child[][] = [[]];
  for (const child of children) {
    let parts: Child[][];
    if (child.type === "text") {
      parts = child.value
        .split("\n")
        .map((value) => (value === "" ? [] : [{ type: "text", value }]));
    } else if (child.type === "element") {
      parts = splitLines(child.children).map((segment) =>
        segment.length === 0 ? [] : [{ ...child, children: segment }],
      );
    } else {
      parts = [[child]];
    }
    const [head = [], ...rest] = parts;
    lines[lines.length - 1]?.push(...head);
    lines.push(...rest);
  }
  return lines;
}

/** 每行一个节点，行的划分与 `text.split("\n")` 相同；`language` 未注册时抛错（由调用方兜住）。 */
export function highlightLines(text: string, language: string): ReactNode[] {
  const root = lowlight.highlight(language, text);
  const children = root.children.filter((child): child is Child => child.type !== "doctype");
  return splitLines(children).map((line) =>
    toJsxRuntime({ type: "root", children: line }, { Fragment, jsx, jsxs }),
  );
}
