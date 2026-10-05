import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { blockBody, listRepoFiles, readRepoFile, stripTsComments } from "./ui-support.js";

/** 拷入层：registry 原样拷入的两个目录（ui-foundation「组件分层」）。 */
const COPIED_DIRS = ["web/src/components/ui", "web/src/components/assistant-ui"];

/**
 * 已迁移区域：目录或单个文件的仓库相对路径。清单内的文件从 `web/src/ui` 只可导入
 * `MIGRATED_ALLOWED_IMPORTS`，清单内不得有 `.css`。外壳、登录页、设置页迁移时各自加入。
 * 条目按前缀匹配（见 `isUnder`），所以不写通配、不以 `/` 结尾——否则一个文件也匹配不到。
 */
const MIGRATED_AREAS: string[] = [
  "web/src/routes",
  "web/src/features/auth",
  "web/src/features/settings",
  "web/src/features/theme",
  // 会话页按文件逐个登记（s1f-chat-surface D3）；目录本身不登记。
  "web/src/features/chat/approval-card.tsx",
  "web/src/features/chat/artifact-card.tsx",
  "web/src/features/chat/artifacts-panel.tsx",
  "web/src/features/chat/capability-bar.tsx",
  "web/src/features/chat/composer-dock.tsx",
  "web/src/features/chat/composer-locks.ts",
  "web/src/features/chat/composer.tsx",
  "web/src/features/chat/copy-feedback.ts",
  "web/src/features/chat/file-changes-card.tsx",
  "web/src/features/chat/markdown-body.tsx",
  "web/src/features/chat/message-action-row.tsx",
  "web/src/features/chat/message-thread.tsx",
  "web/src/features/chat/project-config.tsx",
  "web/src/features/chat/runtime-convert.ts",
  "web/src/features/chat/scene-pills.tsx",
  "web/src/features/chat/slash-menu-state.ts",
  "web/src/features/chat/slash-menu.tsx",
  "web/src/features/chat/step-card.tsx",
  "web/src/features/chat/thinking-fold.tsx",
  "web/src/features/chat/thread-viewport.tsx",
  "web/src/features/chat/tool-call-group.tsx",
  "web/src/features/chat/use-thread-runtime.ts",
  "web/src/features/chat/welcome-content.ts",
  "web/src/features/chat/welcome-options.ts",
  "web/src/features/chat/welcome.tsx",
];
const MIGRATED_ALLOWED_IMPORTS = ["Icon", "IconName", "BrandMark", "useEscapeFallback"];

const FROZEN_DIR = "web/src/ui";
/** 冻结区：`web/src/ui` 的文件名只能是这 32 个的子集（可以删，不能加）。 */
const FROZEN_FILES = [
  "brand-mark.tsx",
  "button.css",
  "button.tsx",
  "chip.css",
  "chip.tsx",
  "confirm-dialog.tsx",
  "dialog.css",
  "dialog.tsx",
  "drawer.tsx",
  "empty-state.css",
  "empty-state.tsx",
  "escape-fallback.ts",
  "icon.tsx",
  "index.ts",
  "input.css",
  "input.tsx",
  "menu.css",
  "menu.tsx",
  "motion.css",
  "popover.css",
  "popover.tsx",
  "segmented-control.css",
  "segmented-control.tsx",
  "switch.css",
  "switch.tsx",
  "tag.css",
  "tag.tsx",
  "toast.css",
  "toast.tsx",
  "tooltip.css",
  "tooltip.tsx",
  "ui.css",
];

type SourceFile = { path: string; text: string };
type LayeringRules = { migrated: string[]; frozen: string[] };

const isUnder = (path: string, area: string) => path === area || path.startsWith(`${area}/`);

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
    ).toEqual([`web/src/routes/shell/sidebar.tsx: 已迁移区域从 ${FROZEN_DIR} 导入 Button`]);
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
    ).toEqual([`${footer}: 已迁移区域从 ${FROZEN_DIR} 导入 MenuItem`]);
    expect(check(footer, 'import { Dialog as D } from "../../ui/dialog.js";')).toHaveLength(1);
    expect(check(footer, 'import * as UI from "../../ui/index.js";')).toHaveLength(1);
    expect(check(footer, 'import "../../ui/button.css";')).toHaveLength(1);
    expect(check(footer, 'const ui = await import("@/ui/index");')).toHaveLength(1);
    expect(check(footer, 'export { Button } from "../../ui/index.js";')).toHaveLength(1);
  });

  it("判定自证：白名单内的导入、拷入层导入、注释与清单外的文件不判失败", () => {
    const allowed = [
      'import { BrandMark as Mark, Icon, type IconName, useEscapeFallback } from "../../ui/index.js";',
      'import type { IconName } from "@/ui/index";',
      'import { Button } from "@/components/ui/button";',
      'import { cn } from "@/lib/utils";',
      '// import { Button } from "../../ui/index.js";',
    ].join("\n");
    expect(check("web/src/routes/shell/sidebar.tsx", allowed)).toEqual([]);
    const legacy = 'import { Button } from "../../ui/index.js";';
    expect(check("web/src/features/chat/session-filter.tsx", legacy)).toEqual([]);
    expect(check("web/src/features/chat/page.tsx", legacy)).toEqual([]);
    expect(check("web/src/features/chat/chat.css")).toEqual([]);
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

  it("冻结清单恰为 32 个互不相同的文件名", () => {
    expect(new Set(FROZEN_FILES).size).toBe(32);
    expect(FROZEN_FILES).toHaveLength(32);
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
      "web/src/features/chat/artifact-card.tsx",
      "web/src/features/chat/artifacts-panel.tsx",
      "web/src/features/chat/capability-bar.tsx",
      "web/src/features/chat/composer-dock.tsx",
      "web/src/features/chat/composer-locks.ts",
      "web/src/features/chat/composer.tsx",
      "web/src/features/chat/copy-feedback.ts",
      "web/src/features/chat/file-changes-card.tsx",
      "web/src/features/chat/markdown-body.tsx",
      "web/src/features/chat/message-action-row.tsx",
      "web/src/features/chat/message-thread.tsx",
      "web/src/features/chat/project-config.tsx",
      "web/src/features/chat/runtime-convert.ts",
      "web/src/features/chat/scene-pills.tsx",
      "web/src/features/chat/slash-menu-state.ts",
      "web/src/features/chat/slash-menu.tsx",
      "web/src/features/chat/step-card.tsx",
      "web/src/features/chat/thinking-fold.tsx",
      "web/src/features/chat/thread-viewport.tsx",
      "web/src/features/chat/tool-call-group.tsx",
      "web/src/features/chat/use-thread-runtime.ts",
      "web/src/features/chat/welcome-content.ts",
      "web/src/features/chat/welcome-options.ts",
      "web/src/features/chat/welcome.tsx",
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

/** 豁免条目指向的目录：去掉结尾的 `/**` 或 `/*`，按配置所在目录补成仓库相对路径。 */
function exemptedDir(entry: string, base: "" | "web/"): string {
  return `${base}${entry.replace(/\/\*\*?$/, "")}`;
}

/** 条目精确：每条去掉结尾通配后恰是一个拷入目录（中间不含通配），且两个目录都被列出。 */
function isPrecise(entries: string[], base: "" | "web/"): boolean {
  const dirs = entries.map((entry) => exemptedDir(entry, base));
  return (
    entries.every((entry) => /\/\*\*?$/.test(entry)) &&
    dirs.length === COPIED_DIRS.length &&
    COPIED_DIRS.every((dir) => dirs.includes(dir))
  );
}

function stringLiterals(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map(([, value = ""]) => value);
}

/** `constraints.yaml` `exemptions.entries` 的各条目原文（按 `- path:` 切开，文本扫描）。 */
function exemptionEntries(yaml: string): { path: string; body: string }[] {
  const start = yaml.indexOf("\nexemptions:\n");
  const end = yaml.indexOf("\n  enforced_by:", start);
  if (start < 0 || end < 0) throw new Error("constraints.yaml 缺 exemptions 段");
  return yaml
    .slice(start, end)
    .split(/\n {4}- path: /)
    .slice(1)
    .map((body) => ({ path: /^"([^"]*)"/.exec(body)?.[1] ?? "", body }));
}

/** `AGENTS.md` 里「阈值与正则…」说明段之后、`### Known blind spots` 之前的各行。 */
function agentsNoteLines(agents: string): string[] {
  const index = agents.indexOf("\n## Enforcement Index\n");
  const blind = agents.indexOf("\n### Known blind spots", index);
  const anchor = agents.indexOf("\n阈值与正则的机器可读权威是 `constraints.yaml`", index);
  if (index < 0 || anchor < 0 || blind < anchor) throw new Error("AGENTS.md 锚点缺失或次序不对");
  return agents
    .slice(anchor + 1, blind)
    .split("\n")
    .slice(1);
}

const namesBothDirsAndAdr = (line: string) =>
  COPIED_DIRS.every((dir) => line.includes(dir)) && line.includes("ADR-0013");

describe("拷入层门槛豁免（ui-foundation「豁免路径精确」）", () => {
  it("判定自证：能匹配到应用层或冻结区的通配、缺目录、多目录都不算精确", () => {
    expect(isPrecise(["src/components/ui/**", "src/components/assistant-ui/**"], "web/")).toBe(
      true,
    );
    expect(isPrecise(["web/src/components/ui/*", "web/src/components/assistant-ui/*"], "")).toBe(
      true,
    );
    expect(isPrecise(["src/components/**"], "web/")).toBe(false);
    expect(isPrecise(["src/components/ui/**"], "web/")).toBe(false);
    expect(isPrecise(["src/components/*ui/**", "src/components/assistant-ui/**"], "web/")).toBe(
      false,
    );
    expect(isPrecise(["**/ui/**", "web/src/components/assistant-ui/**"], "")).toBe(false);
    expect(isPrecise(["web/src/ui/**", "web/src/components/assistant-ui/**"], "")).toBe(false);
    expect(
      isPrecise(
        ["web/src/components/ui/**", "web/src/components/assistant-ui/**", "web/src/lib/**"],
        "",
      ),
    ).toBe(false);
    expect(isPrecise(["web/src/components/ui", "web/src/components/assistant-ui"], "")).toBe(false);
  });

  it("web/vitest.config.ts：coverage.exclude 只有两个拷入目录，根 vitest.shared.mjs 无排除", () => {
    const coverage = blockBody(readRepoFile("web/vitest.config.ts"), /coverage:\s*\{/);
    const exclude = /exclude:\s*\[([^\]]*)\]/.exec(stripTsComments(coverage))?.[1] ?? "";
    expect(exclude.replace(/"[^"]*"/g, "").replace(/[\s,]/g, "")).toBe("");
    expect(isPrecise(stringLiterals(exclude), "web/")).toBe(true);
    expect(readRepoFile("vitest.shared.mjs")).not.toMatch(/exclude/);
  });

  it(".jscpd.json：ignore 在既有四项之外只多出两个拷入目录", () => {
    const existing = ["**/node_modules/**", "**/coverage/**", "**/dist/**", "**/.venv/**"];
    const { ignore } = JSON.parse(readRepoFile(".jscpd.json")) as { ignore: string[] };
    for (const entry of existing) expect(ignore).toContain(entry);
    expect(
      isPrecise(
        ignore.filter((entry) => !existing.includes(entry)),
        "",
      ),
    ).toBe(true);
  });

  it("knip.json：只有 web workspace 有 ignore，且只列两个拷入目录", () => {
    const { workspaces } = JSON.parse(readRepoFile("knip.json")) as {
      workspaces: Record<string, { ignore?: string[] }>;
    };
    expect(isPrecise(workspaces.web?.ignore ?? [], "web/")).toBe(true);
    const others = Object.entries(workspaces).filter(([name]) => name !== "web");
    for (const [, workspace] of others) expect(workspace.ignore).toBeUndefined();
  });

  it("biome.json：唯一的 override 只对两个拷入目录关 linter，formatter 不动", () => {
    const { overrides, formatter } = JSON.parse(readRepoFile("biome.json")) as {
      overrides: Record<string, unknown>[];
      formatter: { enabled: boolean };
    };
    expect(overrides).toHaveLength(1);
    const [override = {}] = overrides;
    expect(Object.keys(override).sort()).toEqual(["includes", "linter"]);
    expect(isPrecise(override.includes as string[], "")).toBe(true);
    expect(override.linter).toEqual({ enabled: false });
    expect(formatter.enabled).toBe(true);
  });

  it("scripts/size-guard.sh：循环内唯一的前缀跳过只列两个拷入目录，带 ./ 的写法先归一", () => {
    const script = readRepoFile("scripts/size-guard.sh");
    const skips = [...script.matchAll(/^\s*case "([^"]+)" in ([^)\n]+)\) continue ;; esac$/gm)];
    expect(skips).toHaveLength(1);
    const [skip = "", subject = "", patterns = ""] = skips[0] ?? [];
    expect(subject).toMatch(/^\$\{f#\.\/\}$/);
    expect(isPrecise(patterns.split("|"), "")).toBe(true);
    // 跳过发生在唯一的逐文件循环里，带参数与无参数两种调用共用。
    const loop = /^for f in "\$\{files\[@\]\}"; do$/m.exec(script)?.index ?? -1;
    expect(loop).toBeGreaterThan(-1);
    expect(script.indexOf(skip)).toBeGreaterThan(loop);
    expect(script.match(/^for /gm)).toHaveLength(1);
  });

  it("constraints.yaml：exemptions.entries 登记两个拷入目录，依据 ADR-0013，web 下无其它豁免", () => {
    const entries = exemptionEntries(readRepoFile("constraints.yaml"));
    const web = entries.filter((entry) => entry.path.startsWith("web/"));
    expect(
      isPrecise(
        web.map((entry) => entry.path),
        "",
      ),
    ).toBe(true);
    for (const entry of web) {
      expect(entry.body).toMatch(/\n {6}rules: \[[^\]]*size_limits[^\]]*\]/);
      expect(entry.body).toMatch(/\n {6}rules: \[[^\]]*testing[^\]]*\]/);
      expect(entry.body).toMatch(/\n {6}rules: \[[^\]]*anti_drift[^\]]*\]/);
      expect(entry.body).not.toMatch(/\n {6}rules: \[[^\]]*\ball\b[^\]]*\]/);
      expect(entry.body).toMatch(/\n {6}reason: "[^"\n]*ADR-0013/);
      expect(entry.body).toMatch(/\n {6}expires: never\n/);
    }
  });

  it("AGENTS.md：说明段之后、Known blind spots 之前恰有一行注记，点名两个目录与 ADR-0013", () => {
    const notes = agentsNoteLines(readRepoFile("AGENTS.md")).filter(namesBothDirsAndAdr);
    expect(notes).toHaveLength(1);
  });

  it("注记判定自证：缺一个目录、缺 ADR、写在说明段之前或 Known blind spots 之后都不算", () => {
    const note = `拷入层豁免：\`${COPIED_DIRS[0]}/\` 与 \`${COPIED_DIRS[1]}/\`（ADR-0013）。`;
    const doc = (before: string, between: string, after: string) =>
      [
        "## Enforcement Index",
        before,
        "阈值与正则的机器可读权威是 `constraints.yaml`；变更先改那里。",
        between,
        "### Known blind spots（交给评审）",
        after,
      ].join("\n\n");
    const count = (text: string) => agentsNoteLines(`\n${text}`).filter(namesBothDirsAndAdr).length;
    expect(count(doc("", note, ""))).toBe(1);
    expect(count(doc(note, "", ""))).toBe(0);
    expect(count(doc("", "", note))).toBe(0);
    expect(count(doc("", note.replace("ADR-0013", "ADR-0011"), ""))).toBe(0);
    expect(count(doc("", note.replace(COPIED_DIRS[1] ?? "", "web/src/ui"), ""))).toBe(0);
    expect(() => agentsNoteLines("## Enforcement Index\n\n### Known blind spots")).toThrow();
  });
});
