import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { listRepoFiles, readRepoFile, stripTsComments } from "./ui-support.js";

/*
 * ui-foundation「预览器按需加载是唯一的代码分割」的静态部分（场景「动态导入只有一处」）。
 * 「构建产物确有按需块」不在这里：`make check` 不构建，那条断言只在 UI 走查里做。
 * 局限随 `stripTsComments`：字符串字面量原样保留，所以写在字符串里的 `import(` 也算命中（宁严勿松）。
 */
const SRC = "web/src";
const PREVIEWERS = `${SRC}/features/files/previewers`;
const INDEX = `${PREVIEWERS}/index.ts`;
const KIND = `${PREVIEWERS}/kind.js`;
const HIGHLIGHT = `${PREVIEWERS}/highlight.ts`;
const HIGHLIGHT_MODULE = `${PREVIEWERS}/highlight.js`;
const VITE_CONFIG = "web/vite.config.ts";

const DYNAMIC_IMPORT = /\bimport\s*\(/;
const STATIC_SPECIFIER = /\b(?:from|import)\s*["']([^"']+)["']/g;
const HIGHLIGHT_LIBRARY = /^(?:lowlight|highlight\.js)(?:\/|$)/;

type SourceFile = { path: string; source: string };

/** 说明符解析成仓库相对路径；包名（非相对、非 `@/`）返回 null。 */
function resolveSpecifier(importer: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return posix.join(SRC, specifier.slice(2));
  if (specifier.startsWith(".")) return posix.join(posix.dirname(importer), specifier);
  return null;
}

/**
 * 只对会进入口包的文件调用：previewers/ 之外的文件，以及 `index.ts` 自己（它被外部静态导入）。
 * 前者只许碰 `index.js`，后者在目录内只许碰 `kind.js`——否则那个预览器连同它的依赖就进了入口包。
 */
function specifierViolation(path: string, specifier: string): string | null {
  const fromIndex = path === INDEX;
  if (HIGHLIGHT_LIBRARY.test(specifier)) {
    return fromIndex
      ? `${path}: 静态导入高亮库 ${specifier}`
      : `${path}: previewers/ 之外导入高亮库 ${specifier}`;
  }
  const target = resolveSpecifier(path, specifier);
  if (target === null) return null;
  if (target !== PREVIEWERS && !target.startsWith(`${PREVIEWERS}/`)) return null;
  if (fromIndex) {
    return target === KIND ? null : `${path}: 只许静态导入 ./kind.js，不得静态导入 ${specifier}`;
  }
  return target === `${PREVIEWERS}/index.js`
    ? null
    : `${path}: previewers/ 之外静态导入其内部模块 ${specifier}`;
}

/**
 * previewers/ 里 `index.ts` 与 `highlight.ts` 之外的模块：高亮库与高亮模块都不许静态导入——
 * 否则高亮器并进那个预览器的块，不再是 `index.ts` 的动态导入单独取的那一块。目录内其余互相导入不管。
 */
function highlightViolation(path: string, specifier: string): string | null {
  const reachesHighlighter =
    HIGHLIGHT_LIBRARY.test(specifier) || resolveSpecifier(path, specifier) === HIGHLIGHT_MODULE;
  return reachesHighlighter
    ? `${path}: 高亮库与高亮模块只许由 highlight.ts 静态导入，不得静态导入 ${specifier}`
    : null;
}

function staticImportViolations(
  path: string,
  code: string,
  check: (path: string, specifier: string) => string | null,
): string[] {
  const violations: string[] = [];
  for (const match of code.matchAll(STATIC_SPECIFIER)) {
    const violation = check(path, match[1] as string);
    if (violation !== null) violations.push(violation);
  }
  return violations;
}

function codeSplitViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  let indexSplits = false;
  for (const { path, source } of files) {
    const code = stripTsComments(source);
    if (DYNAMIC_IMPORT.test(code)) {
      if (path === INDEX) indexSplits = true;
      else violations.push(`${path}: 动态 import() 只许出现在 ${INDEX}`);
    }
    if (path === VITE_CONFIG && code.includes("manualChunks")) {
      violations.push(`${path}: 不得配置 manualChunks`);
    }
    if (path === INDEX || !path.startsWith(`${PREVIEWERS}/`)) {
      violations.push(...staticImportViolations(path, code, specifierViolation));
    } else if (path !== HIGHLIGHT) {
      violations.push(...staticImportViolations(path, code, highlightViolation));
    }
  }
  if (!indexSplits) violations.push(`${INDEX}: 没有动态 import()`);
  return violations;
}

const COMPLIANT_INDEX: SourceFile = {
  path: INDEX,
  source:
    'import type { ReactElement } from "react";\nexport { previewKind, textView } from "./kind.js";\nexport const load = () => import("./code.js").then((m) => m.CodePreviewer);',
};

describe("预览器按需加载是唯一的代码分割", () => {
  it("web/src 现状：动态 import() 恰在 previewers/index.ts，previewers/ 的内部模块不被外部静态导入，高亮库与高亮模块只由 highlight.ts 静态导入，vite.config.ts 无 manualChunks", () => {
    const files = [...listRepoFiles(SRC, (path) => /\.tsx?$/.test(path)), VITE_CONFIG].map(
      (path) => ({ path, source: readRepoFile(path) }),
    );

    expect(files.map((file) => file.path)).toContain(INDEX);
    expect(files.map((file) => file.path)).toContain(HIGHLIGHT);
    expect(files.map((file) => file.path)).toContain(`${SRC}/features/files/preview.tsx`);
    expect(codeSplitViolations(files)).toEqual([]);
  });

  it("自证：previewers/index.ts 自身的动态导入与它对 kind 的静态再导出、同目录其它模块之间的静态导入、highlight.ts 自己对高亮库的导入都合规", () => {
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        {
          path: `${PREVIEWERS}/markdown.tsx`,
          source:
            'import { CodeView } from "./code.js";\nimport { loadHighlighter } from "./index.js";',
        },
        {
          path: HIGHLIGHT,
          source:
            'import xml from "highlight.js/lib/languages/xml";\nimport { createLowlight } from "lowlight";',
        },
        {
          path: `${SRC}/features/files/preview.tsx`,
          source: 'import { loadPreviewer } from "./previewers/index.js";',
        },
        { path: VITE_CONFIG, source: "// manualChunks 只出现在注释里\nexport default {};" },
      ]),
    ).toEqual([]);
  });

  it("自证：会话页的文件写了动态 import() 判失败，注释里的不算", () => {
    const path = `${SRC}/features/chat/page.tsx`;
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        { path, source: 'const later = import ("./welcome.js");' },
      ]),
    ).toEqual([`${path}: 动态 import() 只许出现在 ${INDEX}`]);
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        { path, source: '// import("./welcome.js")\n/* import("./welcome.js") */' },
      ]),
    ).toEqual([]);
  });

  it("自证：previewers/index.ts 的动态导入全改成静态后判失败", () => {
    expect(
      codeSplitViolations([{ path: INDEX, source: 'export { CodePreviewer } from "./code.js";' }]),
    ).toEqual([
      `${INDEX}: 只许静态导入 ./kind.js，不得静态导入 ./code.js`,
      `${INDEX}: 没有动态 import()`,
    ]);
  });

  it("自证：previewers/index.ts 只把一个预览器改成静态导入、其余仍动态时判失败，静态导入高亮库也算", () => {
    expect(
      codeSplitViolations([
        {
          path: INDEX,
          source: [
            'import { CodePreviewer } from "./code.js";',
            'import { common } from "lowlight";',
            'export { previewKind } from "./kind.js";',
            'export const markdown = () => import("./markdown.js");',
            'export const table = () => import("./table.js");',
            'export const image = () => import("./image.js");',
            "export const code = () => Promise.resolve(CodePreviewer);",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      `${INDEX}: 只许静态导入 ./kind.js，不得静态导入 ./code.js`,
      `${INDEX}: 静态导入高亮库 lowlight`,
    ]);
  });

  it("自证：previewers/ 之外静态导入 previewers/code 或 previewers/kind 判失败，相对路径、别名与再导出都算", () => {
    const page = `${SRC}/features/files/page.tsx`;
    const preview = `${SRC}/features/files/preview.tsx`;
    const chat = `${SRC}/features/chat/workspace-sidebar.tsx`;
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        { path: page, source: 'import { CodeView } from "./previewers/code.js";' },
        { path: preview, source: 'import { previewKind } from "./previewers/kind.js";' },
        { path: chat, source: 'export { CsvTable } from "@/features/files/previewers/table.js";' },
      ]),
    ).toEqual([
      `${page}: previewers/ 之外静态导入其内部模块 ./previewers/code.js`,
      `${preview}: previewers/ 之外静态导入其内部模块 ./previewers/kind.js`,
      `${chat}: previewers/ 之外静态导入其内部模块 @/features/files/previewers/table.js`,
    ]);
  });

  it("自证：previewers/ 里 highlight.ts 之外的模块静态导入高亮模块或高亮库判失败，相对路径、别名与只为副作用的导入都算", () => {
    const code = `${PREVIEWERS}/code.tsx`;
    const markdown = `${PREVIEWERS}/markdown.tsx`;
    const svg = `${PREVIEWERS}/svg.tsx`;
    const prefix = "高亮库与高亮模块只许由 highlight.ts 静态导入，不得静态导入";
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        {
          path: code,
          source: 'import "./highlight.js";\nimport { fileExtension } from "./kind.js";',
        },
        {
          path: markdown,
          source:
            'import { createLowlight } from "lowlight";\nimport { highlightLines } from "@/features/files/previewers/highlight.js";',
        },
        { path: svg, source: 'import xml from "highlight.js/lib/languages/xml";' },
      ]),
    ).toEqual([
      `${code}: ${prefix} ./highlight.js`,
      `${markdown}: ${prefix} lowlight`,
      `${markdown}: ${prefix} @/features/files/previewers/highlight.js`,
      `${svg}: ${prefix} highlight.js/lib/languages/xml`,
    ]);
  });

  it("自证：previewers/ 之外导入高亮库、vite.config.ts 配了 manualChunks 各判失败", () => {
    const chat = `${SRC}/features/chat/markdown-body.tsx`;
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        {
          path: chat,
          source: 'import { common } from "lowlight";\nimport "highlight.js/styles/github.css";',
        },
        { path: VITE_CONFIG, source: "export default { build: { manualChunks: {} } };" },
      ]),
    ).toEqual([
      `${chat}: previewers/ 之外导入高亮库 lowlight`,
      `${chat}: previewers/ 之外导入高亮库 highlight.js/styles/github.css`,
      `${VITE_CONFIG}: 不得配置 manualChunks`,
    ]);
  });
});
