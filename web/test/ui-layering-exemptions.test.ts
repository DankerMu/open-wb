import { describe, expect, it } from "vitest";
import { COPIED_DIRS } from "./ui-layering-support.js";
import { blockBody, readRepoFile, stripTsComments } from "./ui-support.js";

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

  it("判定自证：把自写共享组件写进排除项不算精确——整个 components 目录或单个文件，追加还是顶替都一样", () => {
    const copied = ["src/components/ui/**", "src/components/assistant-ui/**"];
    expect(isPrecise(copied, "web/")).toBe(true);
    for (const entry of [
      "src/components/**",
      "src/components/*",
      "src/components/icon.tsx",
      "src/components/brand-mark.tsx",
      "src/components/escape-fallback.ts",
    ]) {
      expect(isPrecise([...copied, entry], "web/"), entry).toBe(false);
      expect(isPrecise([copied[0] ?? "", entry], "web/"), entry).toBe(false);
      // 仓库根相对的写法（.jscpd.json、biome.json、size-guard.sh、constraints.yaml）同样。
      expect(
        isPrecise(
          [...copied, entry].map((item) => `web/${item}`),
          "",
        ),
        entry,
      ).toBe(false);
    }
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
