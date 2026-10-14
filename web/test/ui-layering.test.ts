import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_DIR, COPIED_DIRS, isUnder, type SourceFile } from "./ui-layering-support.js";
import { listRepoFiles, readRepoFile, stripTsComments } from "./ui-support.js";

/** 旧基元层原来的目录：已随 s1f-legacy-layer-removal 整体删除，其下不得再有任何文件，也没有模块从它导入。 */
const RETIRED_DIR = "web/src/ui";
/** `web/src` 下仅有的三个样式文件（ui-foundation「Tailwind 入口与层叠顺序」）；应用代码不新增 `.css`。 */
const STYLE_FILES = ["web/src/styles.css", "web/src/styles/theme.css", "web/src/styles/tokens.css"];
/** 随 Toast 一起删除的两个标识符：`web/src` 的源码里不得再出现（注释不算）。 */
const TOAST_IDENTIFIER = /\b(?:useToast|ToastProvider)\b/g;

/** 把导入说明符解析成仓库相对路径；包名（非 `@/`、非相对路径）返回 `null`。 */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return posix.normalize(`web/src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return posix.join(posix.dirname(from), specifier);
  return null;
}

const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const ANY_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** `{ Icon, type IconName, BrandMark as Mark }` → 导入的原名。 */
function importedNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part !== "")
    .map((part) => part.split(/\s+as\s+/)[0] ?? part);
}

/** 指向旧目录的导入：具名导入逐名报告，其它写法（默认/命名空间/副作用/动态/再导出）各报一条。没有放行的名字。 */
function retiredImportViolations(path: string, code: string): string[] {
  const intoRetired = (specifier: string) => {
    const target = resolveSpecifier(path, specifier);
    return target !== null && isUnder(target, RETIRED_DIR);
  };
  const violations: string[] = [];
  const rest = code.replace(NAMED_IMPORT, (statement, _type, clause: string, specifier: string) => {
    if (!intoRetired(specifier)) return statement;
    for (const name of importedNames(clause)) {
      violations.push(`${path}: 从 ${RETIRED_DIR} 导入 ${name}`);
    }
    return "";
  });
  for (const [, specifier = ""] of rest.matchAll(ANY_SPECIFIER)) {
    if (intoRetired(specifier)) {
      violations.push(`${path}: 以非具名导入引用 ${RETIRED_DIR}（${specifier}）`);
    }
  }
  return violations;
}

function sourceViolations(file: SourceFile): string[] {
  const code = stripTsComments(file.text);
  const toast = [...new Set(Array.from(code.matchAll(TOAST_IDENTIFIER), ([name]) => name))];
  return [
    ...retiredImportViolations(file.path, code),
    ...toast.map((name) => `${file.path}: 出现已删除的 ${name}`),
  ];
}

/**
 * 分层终态（纯函数；ui-foundation「组件分层」）：输入 `web/src` 的全部文件，返回全部违例——
 * 旧目录下有文件；三个样式文件之外有 `.css`；`.ts`/`.tsx` 从旧目录导入，或出现 Toast 的两个标识符。
 * 没有清单：哪个目录、哪个文件都一样受管（拷入层的两个目录也在内）。
 */
function layeringViolations(files: SourceFile[]): string[] {
  return files.flatMap((file) => {
    if (isUnder(file.path, RETIRED_DIR))
      return [`${file.path}: ${RETIRED_DIR} 已删除，不得再有文件`];
    if (file.path.endsWith(".css")) {
      return STYLE_FILES.includes(file.path) ? [] : [`${file.path}: 应用代码不得新增 .css`];
    }
    return /\.tsx?$/.test(file.path) ? sourceViolations(file) : [];
  });
}

const ESCAPE_FALLBACK = "useEscapeFallback";
/** 兜底保留时定义所在的唯一路径（终态：文件已从 `web/src/ui` 搬来）。 */
const ESCAPE_FALLBACK_HOME = "web/src/components/escape-fallback.ts";
/** 搬家之前的位置：无论兜底去留，这个文件都不得再出现。 */
const ESCAPE_FALLBACK_RETIRED = "web/src/ui/escape-fallback.ts";
const ESCAPE_FALLBACK_DEFINITION = /\b(?:function|const|let|var|class)\s+useEscapeFallback\b/g;

/**
 * 兜底的两种合法终态（ui-primitives「覆盖层的 Escape 关闭」场景「兜底只有两种合法终态」）：`files` 的
 * `.ts`/`.tsx` 里（注释不算）要么 `useEscapeFallback` 完全不出现，要么它的定义恰一处、写成
 * `export function useEscapeFallback`、在 `home`。`definitions` 是找到的定义所在路径（一处一条）。
 * 两种终态下 `retired`（搬家前的位置）都不得出现在文件列表里，不管它里面写了什么。
 */
function escapeFallbackState(files: SourceFile[], home: string, retired = ESCAPE_FALLBACK_RETIRED) {
  const sources = files
    .filter((file) => /\.tsx?$/.test(file.path))
    .map((file) => ({ path: file.path, text: stripTsComments(file.text) }))
    .filter((file) => /\buseEscapeFallback\b/.test(file.text));
  const definitions = sources.flatMap((file) =>
    Array.from(file.text.matchAll(ESCAPE_FALLBACK_DEFINITION), () => file.path),
  );
  const violations = definitions
    .filter((path) => path !== home)
    .map((path) => `${path}: ${ESCAPE_FALLBACK} 的定义只能在 ${home}`);
  const atHome = definitions.filter((path) => path === home).length;
  if (atHome > 1) violations.push(`${home}: ${ESCAPE_FALLBACK} 的定义多于一处`);
  if (sources.length > 0 && atHome === 0) {
    violations.push(`${home}: ${ESCAPE_FALLBACK} 仍被提到，却没有在这里定义`);
  }
  const exported = sources.some(
    (file) => file.path === home && file.text.includes(`export function ${ESCAPE_FALLBACK}(`),
  );
  if (atHome === 1 && !exported) violations.push(`${home}: 定义须写成 export function`);
  if (files.some((file) => file.path === retired)) {
    violations.push(`${retired}: 兜底搬走之前的位置不得再有文件`);
  }
  return { definitions, violations };
}

const COMPONENTS_DIR = "web/src/components";
/**
 * 自写共享组件（ui-foundation「组件分层」；s1f-legacy-layer-removal design D1、D2）：本仓自写、直接放在
 * `web/src/components/` 下的三个文件。这不是 `web/src/components/` 的允许清单——别的文件放进来不归这里管。
 */
const SHARED_COMPONENTS = ["brand-mark.tsx", "escape-fallback.ts", "icon.tsx"].map(
  (name) => `${COMPONENTS_DIR}/${name}`,
);

/** 自写共享组件的位置（纯函数）：`shared` 的每个路径都在文件列表里，且不在任一拷入目录之下。 */
function sharedComponentViolations(paths: string[], shared: string[]): string[] {
  return shared.flatMap((path) => [
    ...(paths.includes(path) ? [] : [`${path}: 自写共享组件不在这个路径`]),
    ...(COPIED_DIRS.some((dir) => isUnder(path, dir))
      ? [`${path}: 自写共享组件不得放进拷入目录`]
      : []),
  ]);
}

/** 没有统一出口（纯函数；design D17）：`web/src/components/` 下不得直接放 `index.ts` / `index.tsx`。 */
function barrelViolations(paths: string[]): string[] {
  return paths
    .filter(
      (path) => path === `${COMPONENTS_DIR}/index.ts` || path === `${COMPONENTS_DIR}/index.tsx`,
    )
    .map((path) => `${path}: web/src/components 不设统一出口`);
}

describe("组件分层（ui-foundation「已迁移区域不回用旧基元，冻结区不增长」）", () => {
  const check = (path: string, text = "") => layeringViolations([{ path, text }]);
  const imported = (path: string, name: string) => `${path}: 从 ${RETIRED_DIR} 导入 ${name}`;
  const retired = (path: string) => `${path}: ${RETIRED_DIR} 已删除，不得再有文件`;
  const strayCss = (path: string) => `${path}: 应用代码不得新增 .css`;

  it("判定自证：导入 Button、目录下出现 .css、web/src/ui 下出现文件各判失败", () => {
    const sidebar = "web/src/routes/shell/sidebar.tsx";
    expect(check(sidebar, 'import { Button, Icon } from "../../ui/index.js";')).toEqual([
      imported(sidebar, "Button"),
      imported(sidebar, "Icon"),
    ]);
    expect(check("web/src/routes/shell/sidebar.css")).toEqual([
      strayCss("web/src/routes/shell/sidebar.css"),
    ]);
    // 旧目录下任何文件都算，不看内容：组件、子目录里的文件、原先留到最后的两个样式文件、兜底的旧位置。
    for (const name of ["card.tsx", "extra/button.tsx", "motion.css", "ui.css"]) {
      expect(check(`${RETIRED_DIR}/${name}`)).toEqual([retired(`${RETIRED_DIR}/${name}`)]);
    }
    expect(check(ESCAPE_FALLBACK_RETIRED, "export function useEscapeFallback() {}")).toEqual([
      retired(ESCAPE_FALLBACK_RETIRED),
    ]);
  });

  it("判定自证：别名、多行、type、as 改名与非具名写法都被识别", () => {
    const footer = "web/src/features/auth/footer.tsx";
    expect(check(footer, 'import { ConfirmDialog } from "@/ui";')).toHaveLength(1);
    expect(
      check(footer, 'import {\n  Icon,\n  type MenuItem,\n} from "../../ui/index.js";'),
    ).toEqual([imported(footer, "Icon"), imported(footer, "MenuItem")]);
    expect(check(footer, 'import { Dialog as D } from "../../ui/dialog.js";')).toHaveLength(1);
    expect(check(footer, 'import * as UI from "../../ui/index.js";')).toHaveLength(1);
    expect(check(footer, 'import "../../ui/button.css";')).toHaveLength(1);
    expect(check(footer, 'const ui = await import("@/ui/index");')).toHaveLength(1);
    expect(check(footer, 'export { Button } from "../../ui/index.js";')).toHaveLength(1);
  });

  it("判定自证：没有放行的名字，原白名单的四个各判失败；哪个目录的文件都受管；新位置的导入、拷入层导入与注释不判失败", () => {
    const sidebar = "web/src/routes/shell/sidebar.tsx";
    const former = [
      'import { BrandMark as Mark, Icon, type IconName, useEscapeFallback } from "../../ui/index.js";',
      'import type { IconName } from "@/ui/index";',
    ].join("\n");
    expect(check(sidebar, former)).toEqual(
      ["BrandMark", "Icon", "IconName", "useEscapeFallback", "IconName"].map((name) =>
        imported(sidebar, name),
      ),
    );
    const allowed = [
      'import { BrandMark as Mark } from "../../components/brand-mark.js";',
      'import { Icon, type IconName } from "@/components/icon";',
      'import { useEscapeFallback } from "@/components/escape-fallback";',
      'import { Button } from "@/components/ui/button";',
      'import { cn } from "@/lib/utils";',
      '// import { Button } from "../../ui/index.js";',
      "// useToast 与 ToastProvider 已删除",
    ].join("\n");
    expect(check(sidebar, allowed)).toEqual([]);
    // 没有「已迁移清单」：清单之外的目录同样受管——会话页、lib、入口、拷入层、任何新目录。
    const button = 'import { Button } from "../../ui/index.js";';
    expect(check("web/src/features/chat/page.tsx", button)).toEqual([
      imported("web/src/features/chat/page.tsx", "Button"),
    ]);
    expect(check("web/src/lib/topbar.tsx", 'import "../ui/ui.css";')).toEqual([
      `web/src/lib/topbar.tsx: 以非具名导入引用 ${RETIRED_DIR}（../ui/ui.css）`,
    ]);
    expect(check("web/src/main.tsx", 'import { Button } from "./ui/index.js";')).toHaveLength(1);
    expect(
      check("web/src/components/ui/button.tsx", 'import { Button } from "@/ui/button";'),
    ).toHaveLength(1);
    expect(check("web/src/routes-extra/a.css")).toEqual([strayCss("web/src/routes-extra/a.css")]);
    expect(check("web/src/styles/base.css")).toEqual([strayCss("web/src/styles/base.css")]);
    // 目标按解析后的路径判：拷入目录 `components/ui` 与名字相近的目录不是旧目录。
    expect(check("web/src/components/shell.tsx", 'import { Button } from "./ui/button";')).toEqual(
      [],
    );
    expect(check("web/src/main.tsx", 'import { a } from "./uix/a.js";')).toEqual([]);
    for (const path of STYLE_FILES) expect(check(path)).toEqual([]);
  });

  it("判定自证：真实文件（含会话列表文件）注入 useToast、ToastProvider 或 Menu 导入判失败", () => {
    const composer = `${CHAT_DIR}/composer.tsx`;
    const source = readRepoFile(composer);
    expect(check(composer, source)).toEqual([]);
    const toast = (name: string) => `${composer}: 出现已删除的 ${name}`;
    for (const [injected, expected] of [
      // 标识符本身就判，不看它从哪里导入：旧出口、自写共享组件的位置、或只是一次调用。
      [
        'import { useToast } from "../../ui/index.js";',
        [imported(composer, "useToast"), toast("useToast")],
      ],
      ['import { useToast } from "@/components/toast";', [toast("useToast")]],
      [
        'import { ToastProvider, useToast } from "@/components/toast";',
        [toast("ToastProvider"), toast("useToast")],
      ],
      ["const toast = useToast();", [toast("useToast")]],
      [
        'import { Icon, useToast } from "@/ui";',
        [imported(composer, "Icon"), imported(composer, "useToast"), toast("useToast")],
      ],
      ['import { Icon } from "../../ui/index.js";', [imported(composer, "Icon")]],
    ] as const) {
      expect(check(composer, `${injected}\n${source}`), injected).toEqual(expected);
    }
    // 词边界：名字相近的标识符不误判。
    expect(check(composer, "const useToaster = 1; const MyToastProvider = 2;")).toEqual([]);
    // 会话列表文件同样受管：各自现状守约，注入旧基元即判失败。
    for (const name of ["session-actions.ts", "session-menu.tsx"]) {
      const path = `${CHAT_DIR}/${name}`;
      const own = readRepoFile(path);
      expect(check(path, own)).toEqual([]);
      expect(check(path, `import { Menu } from "../../ui/index.js";\n${own}`)).toEqual([
        imported(path, "Menu"),
      ]);
    }
  });

  it("判定自证：文件页目录下的旧基元导入、.css 与子目录文件各判失败", () => {
    const dir = "web/src/features/files";
    expect(check(`${dir}/tree.tsx`, 'import { Dialog } from "../../ui/index.js";')).toEqual([
      imported(`${dir}/tree.tsx`, "Dialog"),
    ]);
    expect(check(`${dir}/files.css`)).toEqual([strayCss(`${dir}/files.css`)]);
    expect(
      check(`${dir}/previewers/x.tsx`, 'import { Menu } from "../../../ui/index.js";'),
    ).toEqual([imported(`${dir}/previewers/x.tsx`, "Menu")]);
    expect(check(`${dir}/tree.tsx`, 'import { Icon } from "../../ui/index.js";')).toEqual([
      imported(`${dir}/tree.tsx`, "Icon"),
    ]);
    expect(check(`${dir}/tree.tsx`, 'import { Icon } from "../../components/icon.js";')).toEqual(
      [],
    );
  });

  it("web/src 现状：web/src/ui 下没有文件，没有模块从它导入，不出现 useToast 与 ToastProvider，.css 只有三个样式文件", () => {
    const files = listRepoFiles("web/src", () => true).map((path) => ({
      path,
      text: /\.tsx?$/.test(path) ? readRepoFile(path) : "",
    }));
    const paths = files.map((file) => file.path);
    // 扫描没有放空：入口、lib、会话页、文件页、自写共享组件与拷入层的文件都在扫描对象里。
    expect(paths).toEqual(
      expect.arrayContaining([
        "web/src/main.tsx",
        "web/src/lib/topbar.tsx",
        `${CHAT_DIR}/composer.tsx`,
        "web/src/features/files/tree.tsx",
        "web/src/components/icon.tsx",
        "web/src/components/ui/button.tsx",
      ]),
    );
    expect(files.find((file) => file.path === "web/src/main.tsx")?.text).toContain("import ");
    expect(paths.filter((path) => isUnder(path, RETIRED_DIR))).toEqual([]);
    expect(paths.filter((path) => path.endsWith(".css"))).toEqual(STYLE_FILES);
    expect(layeringViolations(files)).toEqual([]);
  });
});

describe("兜底去留（ui-primitives「兜底只有两种合法终态」）", () => {
  const HOME = ESCAPE_FALLBACK_HOME;
  const definition = `export function ${ESCAPE_FALLBACK}() {\n  return {};\n}\n`;
  const caller: SourceFile = {
    path: "web/src/features/chat/delete-dialog.tsx",
    text: `import { ${ESCAPE_FALLBACK} } from "../../components/escape-fallback.js";\nconst fallback = ${ESCAPE_FALLBACK}({});\n`,
  };
  const kept: SourceFile[] = [{ path: HOME, text: definition }, caller];
  const check = (files: SourceFile[]) => escapeFallbackState(files, HOME).violations;

  it("判定自证：两种合法状态各判通过——完全不出现（注释里提到不算），或定义恰一处在指定路径", () => {
    const absent: SourceFile[] = [
      { path: caller.path, text: `// 曾经接过 ${ESCAPE_FALLBACK}\nexport const a = 1;\n` },
      { path: "web/src/features/chat/notes.md", text: ESCAPE_FALLBACK },
    ];
    expect(escapeFallbackState(absent, HOME)).toEqual({ definitions: [], violations: [] });
    expect(escapeFallbackState(kept, HOME)).toEqual({ definitions: [HOME], violations: [] });
  });

  it("判定自证：别处定义同名函数、指定路径之外的第二处定义、没有定义却仍被调用、定义不是导出的函数各判失败", () => {
    const stray = "web/src/features/chat/x.ts";
    const elsewhere = `${stray}: ${ESCAPE_FALLBACK} 的定义只能在 ${HOME}`;
    const missing = `${HOME}: ${ESCAPE_FALLBACK} 仍被提到，却没有在这里定义`;
    // 指定路径上的定义还在，另一个文件又定义了一个同名函数（导出与否、function 还是 const 都算）。
    for (const text of [
      `function ${ESCAPE_FALLBACK}() {}\n`,
      `export const ${ESCAPE_FALLBACK} = () => ({});\n`,
    ]) {
      expect(check([...kept, { path: stray, text }])).toEqual([elsewhere]);
    }
    // 定义只在指定路径之外；删除分支的回退（定义已删，某个文件又调用它）。
    expect(check([{ path: stray, text: definition }, caller])).toEqual([elsewhere, missing]);
    expect(check([caller])).toEqual([missing]);
    expect(check([{ path: HOME, text: `${definition}${definition}` }])).toEqual([
      `${HOME}: ${ESCAPE_FALLBACK} 的定义多于一处`,
    ]);
    expect(check([{ path: HOME, text: `const ${ESCAPE_FALLBACK} = () => ({});\n` }])).toEqual([
      `${HOME}: 定义须写成 export function`,
    ]);
  });

  it("判定自证：搬家前的位置重新出现判失败——带着定义、只是个空文件、或兜底已删除时都一样", () => {
    const RETIRED = ESCAPE_FALLBACK_RETIRED;
    const reappeared = `${RETIRED}: 兜底搬走之前的位置不得再有文件`;
    expect(HOME).toBe("web/src/components/escape-fallback.ts");
    expect(RETIRED).toBe("web/src/ui/escape-fallback.ts");
    // 新位置的文件被复制回旧位置：既是指定路径之外的第二处定义，也是旧位置重现。
    expect(check([...kept, { path: RETIRED, text: definition }])).toEqual([
      `${RETIRED}: ${ESCAPE_FALLBACK} 的定义只能在 ${HOME}`,
      reappeared,
    ]);
    expect(check([...kept, { path: RETIRED, text: "" }])).toEqual([reappeared]);
    expect(check([{ path: RETIRED, text: "export {};\n" }])).toEqual([reappeared]);
    // 只认路径全等：同目录的别的文件、别处的同名文件不归这条管。
    expect(check([...kept, { path: "web/src/ui/escape.ts", text: "" }])).toEqual([]);
    expect(check([...kept, { path: "web/src/features/ui/escape-fallback.ts", text: "" }])).toEqual(
      [],
    );
  });

  // 取的是保留分支（Escape 实测，ADR-0013 增补）：对真实仓库断言后一种状态，不是「两种都行」。
  it("web/src 现状：兜底保留，定义恰一处、在 web/src/components/escape-fallback.ts，旧位置没有文件", () => {
    const files = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path)).map((path) => ({
      path,
      text: readRepoFile(path),
    }));
    expect(escapeFallbackState(files, HOME)).toEqual({ definitions: [HOME], violations: [] });
  });
});

describe("自写共享组件的位置（ui-foundation「组件分层」；design D1、D2 的 (a) 与 D17）", () => {
  const [brand = "", fallback = "", icon = ""] = SHARED_COMPONENTS;
  const present = [...SHARED_COMPONENTS, `${COMPONENTS_DIR}/ui/button.tsx`];

  it("判定自证：缺文件、文件被放进拷入目录或子目录各判失败，三个都在原位判通过", () => {
    expect(sharedComponentViolations(present, SHARED_COMPONENTS)).toEqual([]);
    for (const path of SHARED_COMPONENTS) {
      expect(
        sharedComponentViolations(
          present.filter((entry) => entry !== path),
          SHARED_COMPONENTS,
        ),
      ).toEqual([`${path}: 自写共享组件不在这个路径`]);
    }
    // 文件挪进拷入目录或别的子目录：原位置上没有了。
    for (const [path, name] of [
      [icon, "icon.tsx"],
      [brand, "brand-mark.tsx"],
      [fallback, "escape-fallback.ts"],
    ]) {
      for (const dir of [...COPIED_DIRS, `${COMPONENTS_DIR}/shared`, "web/src/ui"]) {
        const moved = present.map((entry) => (entry === path ? `${dir}/${name}` : entry));
        expect(sharedComponentViolations(moved, SHARED_COMPONENTS)).toEqual([
          `${path}: 自写共享组件不在这个路径`,
        ]);
      }
    }
    // 把清单本身改成指向拷入目录：文件在那里也不算数。
    for (const dir of COPIED_DIRS) {
      for (const name of ["icon.tsx", "brand-mark.tsx", "escape-fallback.ts"]) {
        const inside = `${dir}/${name}`;
        expect(sharedComponentViolations([inside], [inside])).toEqual([
          `${inside}: 自写共享组件不得放进拷入目录`,
        ]);
      }
    }
  });

  it("web/src/components 现状：icon.tsx、brand-mark.tsx 与 escape-fallback.ts 直接放在该目录下，不在拷入目录里", () => {
    expect(SHARED_COMPONENTS).toEqual([
      "web/src/components/brand-mark.tsx",
      "web/src/components/escape-fallback.ts",
      "web/src/components/icon.tsx",
    ]);
    const paths = listRepoFiles(COMPONENTS_DIR, () => true);
    expect(sharedComponentViolations(paths, SHARED_COMPONENTS)).toEqual([]);
  });

  it("判定自证：web/src/components 下直接出现 index.ts 或 index.tsx 判失败，别处的 index 与名字相近的文件不误判", () => {
    for (const name of ["index.ts", "index.tsx"]) {
      const barrel = `${COMPONENTS_DIR}/${name}`;
      expect(barrelViolations([...present, barrel])).toEqual([
        `${barrel}: web/src/components 不设统一出口`,
      ]);
    }
    expect(barrelViolations(present)).toEqual([]);
    expect(
      barrelViolations([
        `${COMPONENTS_DIR}/indexes.ts`,
        `${COMPONENTS_DIR}/index.test.ts`,
        "web/src/features/chat/index.ts",
      ]),
    ).toEqual([]);
  });

  it("web/src/components 现状：没有统一出口（index.ts 与 index.tsx 都不存在）", () => {
    const paths = listRepoFiles(COMPONENTS_DIR, () => true);
    // 扫描没有放空：目录枚举坏掉（空表）时下面的「没有违例」不能悄悄通过。
    expect(paths).toContain(`${COMPONENTS_DIR}/icon.tsx`);
    expect(barrelViolations(paths)).toEqual([]);
  });
});
