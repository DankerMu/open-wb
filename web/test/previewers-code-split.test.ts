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

function staticImportViolations(path: string, code: string): string[] {
  const violations: string[] = [];
  for (const match of code.matchAll(STATIC_SPECIFIER)) {
    const specifier = match[1] as string;
    if (HIGHLIGHT_LIBRARY.test(specifier)) {
      violations.push(`${path}: previewers/ 之外导入高亮库 ${specifier}`);
      continue;
    }
    const target = resolveSpecifier(path, specifier);
    if (target === null) continue;
    const insidePreviewers = target === PREVIEWERS || target.startsWith(`${PREVIEWERS}/`);
    if (insidePreviewers && target !== `${PREVIEWERS}/index.js`) {
      violations.push(`${path}: previewers/ 之外静态导入其内部模块 ${specifier}`);
    }
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
    if (!path.startsWith(`${PREVIEWERS}/`)) {
      violations.push(...staticImportViolations(path, code));
    }
  }
  if (!indexSplits) violations.push(`${INDEX}: 没有动态 import()`);
  return violations;
}

const COMPLIANT_INDEX: SourceFile = {
  path: INDEX,
  source: 'export const load = () => import("./code.js").then((m) => m.CodePreviewer);',
};

describe("预览器按需加载是唯一的代码分割", () => {
  it("web/src 现状：动态 import() 恰在 previewers/index.ts，previewers/ 的内部模块不被外部静态导入，vite.config.ts 无 manualChunks", () => {
    const files = [...listRepoFiles(SRC, (path) => /\.tsx?$/.test(path)), VITE_CONFIG].map(
      (path) => ({ path, source: readRepoFile(path) }),
    );

    expect(files.map((file) => file.path)).toContain(INDEX);
    expect(files.map((file) => file.path)).toContain(`${SRC}/features/files/preview.tsx`);
    expect(codeSplitViolations(files)).toEqual([]);
  });

  it("自证：previewers/index.ts 自身的动态导入、同目录模块之间的静态导入与目录内的高亮库导入都合规", () => {
    expect(
      codeSplitViolations([
        COMPLIANT_INDEX,
        {
          path: `${PREVIEWERS}/markdown.tsx`,
          source: 'import { CodeView } from "./code.js";\nimport { lowlight } from "lowlight";',
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
    ).toEqual([`${INDEX}: 没有动态 import()`]);
  });

  it("自证：previewers/ 之外静态导入 previewers/code 或 previewers/kind 判失败，相对路径、别名与再导出都算", () => {
    const page = `${SRC}/features/files/page.tsx`;
    const preview = `${SRC}/features/files/preview.tsx`;
    const chat = `${SRC}/features/chat/artifacts-panel.tsx`;
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
