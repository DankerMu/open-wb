/**
 * Slash command whitelist (#551, parent D15). omp runs any text starting with `/` through an exact
 * builtin lookup, so the host decides here, and only here, what a `/`-prefixed prompt is: one of
 * the two whitelisted builtins, a `/skill:<name>` invocation of a platform skill, or plain text.
 * `/todo import|export` is plain text (#704): omp reads or writes the path argument directly, with
 * no tool frame, step row or `files.changed`, and honours absolute paths, `~` and `..`.
 * `toWireText` prefixes one U+0020 to plain text so omp's `startsWith("/")` gate is false. That
 * stops builtins and templates only: omp's skill dispatch `trimStart()`s first
 * (`extensibility/skills.ts:455`), so a `/skill:<name>` omp knows but the host does not list runs.
 * `listSkills` reads `<agentDir>/skills/<entry>/SKILL.md` the way omp v18.0.10 discovers user-level
 * skills (`discovery/helpers.ts` scanSkillsFromDir), with a line-based frontmatter reader instead
 * of a YAML library: a skill it cannot read is left out and its `/skill:` stays plain text.
 * Host restrictions omp does not have (#706): a link is followed only inside `skills/`, and only
 * the first `MAX_SKILL_ENTRIES` entries are read.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
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

/** `/todo` subcommands that are not whitelisted: omp's file channel (`helpers/todo.ts`). */
const TODO_FILE_SUBCOMMANDS: readonly string[] = ["import", "export"];
const SKILL_PREFIX = "/skill:";
/** SKILL.md read cap: the omp uid can write the agent dir (ADR-0010); real ones stay under 51 KB. */
const SKILL_MD_MAX_BYTES = 262144;
/** Entries read per call, in SKILL.md path order; the rest get no filesystem access at all. */
const MAX_SKILL_ENTRIES = 256;
/** Host rule (omp validates nothing): `/skill:<name>` ends at the first U+0020, `/` is a path. */
const SKILL_NAME = /^[^\s/]+$/;
const TOP_LEVEL_KEY = /^(name|description|enabled):(.*)$/;
const BLOCK_SCALAR = /^[>|][+-]?$/;
const QUOTED = /^(["'])(.*)\1$/;

/**
 * The platform skills omp would load from `<agentDir>/skills`, sorted by name in code-point order.
 * Recomputed on every call. Any failure to enumerate the directory yields `[]`; only the first
 * `MAX_SKILL_ENTRIES` candidates in SKILL.md path order are looked at. An entry whose SKILL.md
 * cannot be read is skipped (entry types are not inspected: a regular file fails the read), and so
 * is a SKILL.md that is not a regular file of at most `SKILL_MD_MAX_BYTES`. A symlink is followed
 * only inside `skills`: an entry whose SKILL.md resolves outside the real path of `skills` is
 * skipped (omp itself would load it). Entries sharing a name collapse to the one with the smallest
 * SKILL.md path, omp's first-wins order.
 */
export function listSkills(agentDir: string): Skill[] {
  const skillsDir = join(agentDir, "skills");
  let entries: string[];
  let inside: string;
  try {
    entries = readdirSync(skillsDir);
    inside = realpathSync(skillsDir) + sep;
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => ({ entry, path: join(skillsDir, entry, "SKILL.md") }))
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .slice(0, MAX_SKILL_ENTRIES);
  const byName = new Map<string, Skill>();
  for (const { entry, path } of candidates) {
    const skill = readSkill(path, entry, inside);
    if (skill !== null && !byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) => compareCodePoints(left.name, right.name));
}

/**
 * Classifies already-trimmed prompt text. The builtin name ends at the first whitespace or `:`
 * (omp `slash-commands/helpers/parse.ts`); the skill name ends at the first U+0020 only (omp
 * `extensibility/skills.ts` parseSkillInvocation), so a newline belongs to the name. `todo` with
 * the subcommand `import` or `export` is text; the subcommand is cut as omp's parseSubcommand cuts
 * it: the text after the name's separator, trimmed, up to its first whitespace, lower-cased. The
 * path is neither parsed nor validated here.
 */
export function classifyPrompt(text: string, skills: readonly { name: string }[]): PromptClass {
  if (!text.startsWith("/")) {
    return { kind: "text" };
  }
  const body = text.slice(1);
  const separator = body.search(/[\s:]/);
  const command = separator === -1 ? body : body.slice(0, separator);
  if (BUILTIN_COMMANDS.some((builtin) => builtin.name === command)) {
    const args = separator === -1 ? "" : body.slice(separator + 1).trim();
    const subcommand = (args.split(/\s/, 1)[0] ?? "").toLowerCase();
    if (command === "todo" && TODO_FILE_SUBCOMMANDS.includes(subcommand)) {
      return { kind: "text" };
    }
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

/**
 * omp's drop rules for a user-level skill, plus the host rules (the name, and a SKILL.md whose
 * real path is not under `inside`, the real path of `skills` with a trailing separator); null
 * when it is not listed.
 */
function readSkill(path: string, entry: string, inside: string): Skill | null {
  let content: string | null;
  try {
    const resolved = realpathSync(path);
    if (!resolved.startsWith(inside)) {
      return null;
    }
    content = readBounded(resolved);
  } catch {
    return null;
  }
  if (content === null) {
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
 * The UTF-8 content of a regular file of at most `SKILL_MD_MAX_BYTES`, else null. `path` is
 * already resolved, so `O_NOFOLLOW` refuses a link swapped in as its last component.
 * `O_NONBLOCK` makes opening a FIFO return at once, `O_NOCTTY` keeps a terminal device from
 * becoming the server's controlling terminal, and the read stops at the size `fstat` reported, so
 * neither a writer-less pipe, a device nor a growing file can hold the event loop.
 */
function readBounded(path: string): string | null {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SKILL_MD_MAX_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) {
        break;
      }
      length += read;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
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
  for (let index = next; index < block.length; index += 1) {
    const line = block[index] ?? "";
    if (!/^\s+\S/.test(line)) {
      break;
    }
    lines.push(line.trim());
  }
  return lines.join(raw.startsWith(">") ? " " : "\n");
}
