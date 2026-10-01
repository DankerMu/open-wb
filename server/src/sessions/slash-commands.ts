/**
 * Slash command whitelist (#551, parent D15). omp runs any text starting with `/` through an exact
 * builtin lookup, so the host decides here, and only here, what a `/`-prefixed prompt is: one of
 * the two whitelisted builtins, a `/skill:<name>` invocation of a platform skill, or plain text.
 * `toWireText` prefixes one U+0020 to plain text so omp's `startsWith("/")` gate is false.
 * `listSkills` reads `<agentDir>/skills/<entry>/SKILL.md` the way omp v18.0.10 discovers user-level
 * skills (`discovery/helpers.ts` scanSkillsFromDir), with a line-based frontmatter reader instead
 * of a YAML library: a skill it cannot read is left out and its `/skill:` stays plain text.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareMigrationFilenames as compareCodePoints } from "../core/db/migration-assets.js";

interface BuiltinCommand {
  name: string;
  label: string;
  description: string;
  hint: string;
}

interface Skill {
  name: string;
  description: string;
}

type PromptClass =
  | { kind: "text" }
  | { kind: "builtin"; name: string }
  | { kind: "skill"; name: string };

/** The only omp builtins a prompt may invoke, in catalogue order. */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: "compact",
    label: "整理上下文",
    description: "压缩较长对话的上下文，保留要点",
    hint: "可选：想保留的重点",
  },
  {
    name: "todo",
    label: "任务清单",
    description: "查看或修改助手的任务清单",
    hint: "可选：append <任务>",
  },
];

const SKILL_PREFIX = "/skill:";
/** Host rule (omp validates nothing): `/skill:<name>` ends at the first U+0020, `/` is a path. */
const SKILL_NAME = /^[^\s/]+$/;
const TOP_LEVEL_KEY = /^(name|description|enabled):(.*)$/;
const BLOCK_SCALAR = /^[>|][+-]?$/;
const QUOTED = /^(["'])(.*)\1$/;

/**
 * The platform skills omp would load from `<agentDir>/skills`, sorted by name in code-point order.
 * Recomputed on every call. Any failure to enumerate the directory yields `[]`; an entry whose
 * SKILL.md cannot be read is skipped (entry types are not inspected: a symlinked directory is
 * followed and a regular file fails the read). Entries sharing a name collapse to the one with the
 * smallest SKILL.md path, omp's first-wins order.
 */
export function listSkills(agentDir: string): Skill[] {
  const skillsDir = join(agentDir, "skills");
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => ({ entry, path: join(skillsDir, entry, "SKILL.md") }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const byName = new Map<string, Skill>();
  for (const { entry, path } of candidates) {
    const skill = readSkill(path, entry);
    if (skill !== null && !byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) => compareCodePoints(left.name, right.name));
}

/**
 * Classifies already-trimmed prompt text. The builtin name ends at the first whitespace or `:`
 * (omp `slash-commands/helpers/parse.ts`); the skill name ends at the first U+0020 only (omp
 * `extensibility/skills.ts` parseSkillInvocation), so a newline belongs to the name.
 */
export function classifyPrompt(text: string, skills: readonly { name: string }[]): PromptClass {
  if (!text.startsWith("/")) {
    return { kind: "text" };
  }
  const body = text.slice(1);
  const separator = body.search(/[\s:]/);
  const command = separator === -1 ? body : body.slice(0, separator);
  if (BUILTIN_COMMANDS.some((builtin) => builtin.name === command)) {
    return { kind: "builtin", name: command };
  }
  if (text.startsWith(SKILL_PREFIX)) {
    const space = text.indexOf(" ");
    const name = text.slice(SKILL_PREFIX.length, space === -1 ? undefined : space);
    if (skills.some((skill) => skill.name === name)) {
      return { kind: "skill", name };
    }
  }
  return { kind: "text" };
}

/** The text to hand omp: whitelisted commands unchanged, any other `/`-prefixed text escaped. */
export function toWireText(text: string, skills: readonly { name: string }[]): string {
  return text.startsWith("/") && classifyPrompt(text, skills).kind === "text" ? ` ${text}` : text;
}

/** omp's drop rules for a user-level skill, plus the host name rule; null when it is not listed. */
function readSkill(path: string, entry: string): Skill | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const frontmatter = readFrontmatter(content);
  // Only YAML's boolean: a quoted "false" is a string and omp loads that skill.
  if (frontmatter.enabled === "false") {
    return null;
  }
  const name = frontmatter.name === "" ? entry : frontmatter.name;
  if (frontmatter.description === "" || !SKILL_NAME.test(name)) {
    return null;
  }
  return { name, description: frontmatter.description };
}

/**
 * The top-level (unindented) `name`, `description` and `enabled` of the leading frontmatter block:
 * the content starts with `---` and the block ends before the first later line starting with
 * `---`; an unclosed block is no frontmatter. A missing key reads `""`. `enabled` stays as written
 * (trimmed, quotes kept); the other two are scalar values.
 */
function readFrontmatter(content: string): { name: string; description: string; enabled: string } {
  const fields = { name: "", description: "", enabled: "" };
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.startsWith("---"));
  if (lines[0]?.startsWith("---") !== true || end === -1) {
    return fields;
  }
  const block = lines.slice(1, end);
  block.forEach((line, index) => {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match === null) {
      return;
    }
    const key = match[1] as keyof typeof fields;
    const raw = (match[2] ?? "").trim();
    fields[key] = key === "enabled" ? raw : scalarValue(block, index + 1, raw);
  });
  return fields;
}

/**
 * A trimmed value loses one pair of matching quotes. A block-scalar indicator (`>` or `|`, with an
 * optional `+`/`-`) instead takes the more-indented lines from `next` on, each trimmed: `>` joins
 * them with one U+0020, `|` with `\n`.
 */
function scalarValue(block: readonly string[], next: number, raw: string): string {
  if (!BLOCK_SCALAR.test(raw)) {
    return QUOTED.exec(raw)?.[2] ?? raw;
  }
  const lines: string[] = [];
  for (const line of block.slice(next)) {
    if (!/^\s+\S/.test(line)) {
      break;
    }
    lines.push(line.trim());
  }
  return lines.join(raw.startsWith(">") ? " " : "\n");
}
