import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_DIR,
  COPIED_DIRS,
  isUnder,
  MIGRATED_AREAS,
  type SourceFile,
} from "./ui-layering-support.js";
import { listRepoFiles, readRepoFile, stripTsComments } from "./ui-support.js";

/**
 * 导入白名单已清空：`Icon`、`IconName`、`BrandMark` 与 `useEscapeFallback` 搬到了 `web/src/components/`，
 * 清单内的文件从 `web/src/ui` 什么都不能导入。
 */
const MIGRATED_ALLOWED_IMPORTS: string[] = [];

const FROZEN_DIR = "web/src/ui";
/** 冻结区：`web/src/ui` 的文件名只能是这 2 个的子集（可以删，不能加）。 */
const FROZEN_FILES = ["motion.css", "ui.css"];

type LayeringRules = { migrated: string[]; frozen: string[] };

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

/** 已迁移文件里指向冻结区的导入：具名导入逐名对照白名单，其它写法（默认/命名空间/副作用/动态/再导出）一律不允许。 */
function frozenImportViolations(file: SourceFile): string[] {
  const code = stripTsComments(file.text);
  const intoFrozen = (specifier: string) => {
    const target = resolveSpecifier(file.path, specifier);
    return target !== null && isUnder(target, FROZEN_DIR);
  };
  const violations: string[] = [];
  const rest = code.replace(NAMED_IMPORT, (statement, _type, clause: string, specifier: string) => {
    if (!intoFrozen(specifier)) return statement;
    for (const name of importedNames(clause)) {
      if (!MIGRATED_ALLOWED_IMPORTS.includes(name)) {
        violations.push(`${file.path}: 已迁移区域从 ${FROZEN_DIR} 导入 ${name}`);
      }
    }
    return "";
  });
  for (const [, specifier = ""] of rest.matchAll(ANY_SPECIFIER)) {
    if (intoFrozen(specifier)) {
      violations.push(`${file.path}: 已迁移区域以非具名导入引用 ${FROZEN_DIR}（${specifier}）`);
    }
  }
  return violations;
}

function migratedViolations(file: SourceFile): string[] {
  if (file.path.endsWith(".css")) return [`${file.path}: 已迁移区域出现 .css`];
  return /\.tsx?$/.test(file.path) ? frozenImportViolations(file) : [];
}

/** 分层判定（纯函数）：输入 `web/src` 的文件与两份清单，返回全部违例。 */
function layeringViolations(files: SourceFile[], rules: LayeringRules): string[] {
  return files.flatMap((file) => {
    if (isUnder(file.path, FROZEN_DIR)) {
      const name = file.path.slice(FROZEN_DIR.length + 1);
      return rules.frozen.includes(name) ? [] : [`${file.path}: 冻结区新增文件`];
    }
    return rules.migrated.some((area) => isUnder(file.path, area)) ? migratedViolations(file) : [];
  });
}

/**
 * 清单条目自检：`isUnder` 只做前缀匹配，写成 `dir/**` 或 `dir/` 的条目匹配不到任何文件，守卫会
 * 在不报错的情况下放空。带通配或以 `/` 结尾的条目、以及匹配不到现存文件的条目都判违例。
 */
function areaEntryViolations(areas: string[], paths: string[]): string[] {
  return areas.flatMap((area) => {
    if (area.includes("*") || area.endsWith("/")) {
      return [`${area}: 已迁移区域条目不得含通配或以 / 结尾`];
    }
    return paths.some((path) => isUnder(path, area))
      ? []
      : [`${area}: 已迁移区域条目未匹配任何文件`];
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
  const rules: LayeringRules = {
    migrated: ["web/src/routes", "web/src/features/auth"],
    frozen: FROZEN_FILES,
  };
  const check = (path: string, text = "") => layeringViolations([{ path, text }], rules);

  it("判定自证：已迁移文件导入 Button、已迁移目录出现 .css、冻结区多出文件各判失败", () => {
    expect(
      check(
        "web/src/routes/shell/sidebar.tsx",
        'import { Button, Icon } from "../../ui/index.js";',
      ),
    ).toEqual([
      `web/src/routes/shell/sidebar.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Button`,
      `web/src/routes/shell/sidebar.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Icon`,
    ]);
    expect(check("web/src/routes/shell/sidebar.css")).toEqual([
      "web/src/routes/shell/sidebar.css: 已迁移区域出现 .css",
    ]);
    expect(check("web/src/ui/card.tsx")).toEqual(["web/src/ui/card.tsx: 冻结区新增文件"]);
    expect(check("web/src/ui/extra/button.tsx")).toEqual([
      "web/src/ui/extra/button.tsx: 冻结区新增文件",
    ]);
  });

  it("判定自证：别名、多行、type、as 改名、单文件清单项与非具名写法都被识别", () => {
    const footer = "web/src/features/auth/footer.tsx";
    expect(check(footer, 'import { ConfirmDialog } from "@/ui";')).toHaveLength(1);
    expect(
      check(footer, 'import {\n  Icon,\n  type MenuItem,\n} from "../../ui/index.js";'),
    ).toEqual([
      `${footer}: 已迁移区域从 ${FROZEN_DIR} 导入 Icon`,
      `${footer}: 已迁移区域从 ${FROZEN_DIR} 导入 MenuItem`,
    ]);
    expect(check(footer, 'import { Dialog as D } from "../../ui/dialog.js";')).toHaveLength(1);
    expect(check(footer, 'import * as UI from "../../ui/index.js";')).toHaveLength(1);
    expect(check(footer, 'import "../../ui/button.css";')).toHaveLength(1);
    expect(check(footer, 'const ui = await import("@/ui/index");')).toHaveLength(1);
    expect(check(footer, 'export { Button } from "../../ui/index.js";')).toHaveLength(1);
  });

  it("判定自证：白名单已清空，原先放行的四个名字各判失败；新位置的导入、拷入层导入、注释与清单外的文件不判失败", () => {
    const sidebar = "web/src/routes/shell/sidebar.tsx";
    const former = [
      'import { BrandMark as Mark, Icon, type IconName, useEscapeFallback } from "../../ui/index.js";',
      'import type { IconName } from "@/ui/index";',
    ].join("\n");
    expect(check(sidebar, former)).toEqual(
      ["BrandMark", "Icon", "IconName", "useEscapeFallback", "IconName"].map(
        (name) => `${sidebar}: 已迁移区域从 ${FROZEN_DIR} 导入 ${name}`,
      ),
    );
    const allowed = [
      'import { BrandMark as Mark } from "../../components/brand-mark.js";',
      'import { Icon, type IconName } from "@/components/icon";',
      'import { useEscapeFallback } from "@/components/escape-fallback";',
      'import { Button } from "@/components/ui/button";',
      'import { cn } from "@/lib/utils";',
      '// import { Button } from "../../ui/index.js";',
    ].join("\n");
    expect(check(sidebar, allowed)).toEqual([]);
    const legacy = 'import { Button } from "../../ui/index.js";';
    expect(check("web/src/features/chat/page.tsx", legacy)).toEqual([]);
    expect(check("web/src/routes-extra/a.css")).toEqual([]);
    for (const name of FROZEN_FILES) expect(check(`web/src/ui/${name}`)).toEqual([]);
  });

  it("判定自证：带通配、以 / 结尾或匹配不到文件的清单条目各判失败", () => {
    const paths = ["web/src/routes/shell/sidebar.tsx", "web/src/features/auth/footer.tsx"];
    expect(areaEntryViolations(["web/src/routes/**"], paths)).toEqual([
      "web/src/routes/**: 已迁移区域条目不得含通配或以 / 结尾",
    ]);
    expect(areaEntryViolations(["web/src/routes/"], paths)).toEqual([
      "web/src/routes/: 已迁移区域条目不得含通配或以 / 结尾",
    ]);
    expect(areaEntryViolations(["web/src/*.tsx"], paths)).toHaveLength(1);
    expect(areaEntryViolations(["web/src/features/settings"], paths)).toEqual([
      "web/src/features/settings: 已迁移区域条目未匹配任何文件",
    ]);
    // 前缀按路径段比较：`web/src/route` 不是 `web/src/routes` 的上级目录。
    expect(areaEntryViolations(["web/src/route"], paths)).toHaveLength(1);
    expect(
      areaEntryViolations(["web/src/routes", "web/src/features/auth/footer.tsx"], paths),
    ).toEqual([]);
    // 被拒的写法确实匹配不到文件：不拦下来的话分层判定会对整个目录放空。
    const button = 'import { Button } from "../../ui/index.js";';
    const file = { path: "web/src/routes/shell/sidebar.tsx", text: button };
    for (const entry of ["web/src/routes/**", "web/src/routes/"]) {
      expect(layeringViolations([file], { migrated: [entry], frozen: FROZEN_FILES })).toEqual([]);
    }
    expect(
      layeringViolations([file], { migrated: ["web/src/routes"], frozen: FROZEN_FILES }),
    ).toHaveLength(1);
  });

  it("判定自证：真实清单内的文件（含会话列表文件）注入 useToast 或 Menu 导入判失败", () => {
    const real: LayeringRules = { migrated: MIGRATED_AREAS, frozen: FROZEN_FILES };
    const composer = `${CHAT_DIR}/composer.tsx`;
    const source = readRepoFile(composer);
    expect(layeringViolations([{ path: composer, text: source }], real)).toEqual([]);
    const message = (name: string) => `${composer}: 已迁移区域从 ${FROZEN_DIR} 导入 ${name}`;
    for (const [injected, names] of [
      ['import { useToast } from "../../ui/index.js";', ["useToast"]],
      ['import { Icon, useToast } from "@/ui";', ["Icon", "useToast"]],
      // 白名单清空之后，旧出口上的 `Icon` 同样不放行。
      ['import { Icon } from "../../ui/index.js";', ["Icon"]],
    ] as const) {
      const text = `${injected}\n${source}`;
      expect(layeringViolations([{ path: composer, text }], real)).toEqual(names.map(message));
    }
    // 已登记的会话列表文件同样受管：各自现状守约，注入旧基元即判失败。
    for (const [name, primitive] of [
      ["session-actions.ts", "useToast"],
      ["session-menu.tsx", "Menu"],
    ]) {
      const path = `${CHAT_DIR}/${name}`;
      const own = readRepoFile(path);
      expect(layeringViolations([{ path, text: own }], real)).toEqual([]);
      const text = `import { ${primitive} } from "../../ui/index.js";\n${own}`;
      expect(layeringViolations([{ path, text }], real)).toEqual([
        `${path}: 已迁移区域从 ${FROZEN_DIR} 导入 ${primitive}`,
      ]);
    }
  });

  it("判定自证：文件页整目录受管，目录下的旧基元导入、.css 与子目录文件各判失败", () => {
    const real: LayeringRules = { migrated: MIGRATED_AREAS, frozen: FROZEN_FILES };
    const dir = "web/src/features/files";
    const check = (path: string, text = "") => layeringViolations([{ path, text }], real);
    expect(check(`${dir}/tree.tsx`, 'import { Dialog } from "../../ui/index.js";')).toEqual([
      `${dir}/tree.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Dialog`,
    ]);
    expect(check(`${dir}/files.css`)).toEqual([`${dir}/files.css: 已迁移区域出现 .css`]);
    // 子目录自动在内：不必逐个文件登记。
    expect(
      check(`${dir}/previewers/x.tsx`, 'import { Menu } from "../../../ui/index.js";'),
    ).toEqual([`${dir}/previewers/x.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Menu`]);
    expect(check(`${dir}/tree.tsx`, 'import { Icon } from "../../ui/index.js";')).toEqual([
      `${dir}/tree.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Icon`,
    ]);
    expect(check(`${dir}/tree.tsx`, 'import { Icon } from "../../components/icon.js";')).toEqual(
      [],
    );
  });

  it("冻结清单恰为 motion.css 与 ui.css 两个文件名，导入白名单为空", () => {
    expect(new Set(FROZEN_FILES).size).toBe(2);
    expect(FROZEN_FILES).toHaveLength(2);
    expect(FROZEN_FILES).toEqual(["motion.css", "ui.css"]);
    expect(MIGRATED_ALLOWED_IMPORTS).toEqual([]);
  });

  it("web/src 现状：已迁移区域守约，web/src/ui 的每个文件都在冻结清单里", () => {
    const files = listRepoFiles("web/src", () => true).map((path) => ({
      path,
      text: /\.tsx?$/.test(path) ? readRepoFile(path) : "",
    }));
    expect(files.some((file) => isUnder(file.path, FROZEN_DIR))).toBe(true);
    expect(MIGRATED_AREAS).toEqual([
      "web/src/routes",
      "web/src/features/auth",
      "web/src/features/settings",
      "web/src/features/theme",
      "web/src/features/chat/approval-card.tsx",
      "web/src/features/chat/archived-notice.tsx",
      "web/src/features/chat/archived-view.tsx",
      "web/src/features/chat/artifact-card.tsx",
      "web/src/features/chat/attachment-chips.tsx",
      "web/src/features/chat/attachments-state.ts",
      "web/src/features/chat/capability-bar.tsx",
      "web/src/features/chat/composer-dock.tsx",
      "web/src/features/chat/composer-locks.ts",
      "web/src/features/chat/composer-options.ts",
      "web/src/features/chat/composer.tsx",
      "web/src/features/chat/conversation-search.tsx",
      "web/src/features/chat/conversation-view.tsx",
      "web/src/features/chat/copy-feedback.ts",
      "web/src/features/chat/delete-dialog.tsx",
      "web/src/features/chat/errors.ts",
      "web/src/features/chat/export-markdown.ts",
      "web/src/features/chat/file-changes-card.tsx",
      "web/src/features/chat/index.ts",
      "web/src/features/chat/markdown-body.tsx",
      "web/src/features/chat/message-action-row.tsx",
      "web/src/features/chat/message-thread.tsx",
      "web/src/features/chat/model-picker.tsx",
      "web/src/features/chat/ownership.ts",
      "web/src/features/chat/page.tsx",
      "web/src/features/chat/permission-tier.tsx",
      "web/src/features/chat/project-config.tsx",
      "web/src/features/chat/promote-dialog.tsx",
      "web/src/features/chat/rename-dialog.tsx",
      "web/src/features/chat/runtime-convert.ts",
      "web/src/features/chat/scene-pills.tsx",
      "web/src/features/chat/search-match.ts",
      "web/src/features/chat/session-actions.ts",
      "web/src/features/chat/session-entry.tsx",
      "web/src/features/chat/session-groups.ts",
      "web/src/features/chat/session-list-prefs.ts",
      "web/src/features/chat/session-menu.tsx",
      "web/src/features/chat/session-path.ts",
      "web/src/features/chat/session-sidebar.tsx",
      "web/src/features/chat/session-status-mark.tsx",
      "web/src/features/chat/slash-menu-state.ts",
      "web/src/features/chat/slash-menu.tsx",
      "web/src/features/chat/status-label.ts",
      "web/src/features/chat/step-card.tsx",
      "web/src/features/chat/step-summary.ts",
      "web/src/features/chat/stream-approvals.ts",
      "web/src/features/chat/stream-artifacts.ts",
      "web/src/features/chat/stream-steps.ts",
      "web/src/features/chat/stream-thinking.ts",
      "web/src/features/chat/stream-todo.ts",
      "web/src/features/chat/stream.ts",
      "web/src/features/chat/thinking-fold.tsx",
      "web/src/features/chat/thread-viewport.tsx",
      "web/src/features/chat/todo-panel.tsx",
      "web/src/features/chat/tool-call-group.tsx",
      "web/src/features/chat/topbar-actions.ts",
      "web/src/features/chat/turn-actions.ts",
      "web/src/features/chat/types.ts",
      "web/src/features/chat/undo-conflict-dialog.tsx",
      "web/src/features/chat/undo-notice.tsx",
      "web/src/features/chat/use-chat-session.ts",
      "web/src/features/chat/use-clipped.ts",
      "web/src/features/chat/use-session-list-events.ts",
      "web/src/features/chat/use-session-list-view.ts",
      "web/src/features/chat/use-thread-runtime.ts",
      "web/src/features/chat/use-workspace-sidebar.ts",
      "web/src/features/chat/welcome-content.ts",
      "web/src/features/chat/welcome-options.ts",
      "web/src/features/chat/welcome.tsx",
      "web/src/features/chat/workspace-list.ts",
      "web/src/features/chat/workspace-sidebar.tsx",
      "web/src/features/files",
    ]);
    expect(MIGRATED_AREAS).not.toContain("web/src/features/chat");
    expect(
      areaEntryViolations(
        MIGRATED_AREAS,
        files.map((file) => file.path),
      ),
    ).toEqual([]);
    expect(layeringViolations(files, { migrated: MIGRATED_AREAS, frozen: FROZEN_FILES })).toEqual(
      [],
    );
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
    expect(barrelViolations(listRepoFiles(COMPONENTS_DIR, () => true))).toEqual([]);
  });
});
