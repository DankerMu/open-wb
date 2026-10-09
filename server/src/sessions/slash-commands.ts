/**
 * Slash command whitelist (#551, parent D15). omp runs any text starting with `/` through an exact
 * builtin lookup, so the host decides here, and only here, what a `/`-prefixed prompt is: one of
 * the two whitelisted builtins, a `/skill:<name>` invocation of a listed skill, or plain text.
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
 * `listProjectSkills` (#773) reads `.omp/skills` of the session cwd and its ancestors inside the
 * sandbox root under the same rules plus three, because those directories are writable by the omp
 * uid; `sessionSkills` is the one set the command directory and the whitelist both use. omp also
 * loads skills the host does not list (other provider directories, the managed `HOME`, above the
 * sandbox root, entries these rules skip): they run and are recorded as text (ADR-0012 residual).
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { compareMigrationFilenames as compareCodePoints } from "../core/db/migration-assets.js";
import { sessionCwdResolver, type WorkspaceRootOf } from "./session-cwd.js";

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

/** One entry of a session's skill set: a platform skill or a project skill of its cwd. */
interface SessionSkill extends Skill {
  source: "skill" | "project";
  /** True only for a project skill that replaces a platform skill of the same name. */
  overrides: boolean;
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
/** SKILL.md read cap: `skills/` is operator-installed and unchecked; real ones stay under 51 KB. */
const SKILL_MD_MAX_BYTES = 262144;
/** Entries read per call, in SKILL.md path order; the rest get no filesystem access at all. */
const MAX_SKILL_ENTRIES = 256;
/** Entries enumerated in one project directory; one holding more is not listed at all. */
const MAX_PROJECT_DIR_ENTRIES = 4096;
/** Code points kept of a project skill's description. */
const MAX_PROJECT_DESCRIPTION = 200;
const PROJECT_SKILLS = "/.omp/skills";
const SLASH = 0x2f;
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
 * skipped (omp itself would load it). Both real paths come from the kernel (`realpathSync.native`):
 * Node's JS `realpathSync` stops resolving at a FIFO or socket and folds `..` as text, so it can
 * name a path inside `skills` that open() then walks, through a link, to a file outside. They
 * stay the kernel's raw bytes (`encoding: "buffer"`) from the containment check to the open: a
 * path decoded to a string has every ill-formed UTF-8 sequence replaced by U+FFFD, and re-encoded
 * for open() it names a different file. Entries sharing a name collapse to the one with the
 * smallest SKILL.md path, omp's first-wins order.
 */
export function listSkills(agentDir: string): Skill[] {
  const skillsDir = join(agentDir, "skills");
  let entries: string[];
  let inside: Buffer;
  try {
    entries = readdirSync(skillsDir);
    inside = Buffer.concat([
      realpathSync.native(skillsDir, { encoding: "buffer" }),
      Buffer.from(sep),
    ]);
  } catch {
    return [];
  }
  return readSkillEntries(skillsDir, entries, inside, false).sort(byName);
}

/**
 * The project skills of a session cwd: `<D>/.omp/skills` for every `D` of the walk of
 * `projectDirs`. Each directory is read by the rules of `listSkills` plus the three of
 * `readProjectDir`; a description is cut to `MAX_PROJECT_DESCRIPTION` code points. A name found
 * in a nearer `D` hides the same name farther up (omp v18.0.10: nearest project skill wins).
 * Sorted by name, recomputed on every call, never throws: a failure for one `D` yields nothing
 * for that `D`.
 */
export function listProjectSkills(cwd: string, sandboxRoot: string): Skill[] {
  const { chain, walk } = projectDirs(cwd, sandboxRoot);
  const byNearest = new Map<string, Skill>();
  for (const dir of chain.slice(0, walk)) {
    for (const skill of readProjectDir(dir)) {
      if (!byNearest.has(skill.name)) {
        byNearest.set(skill.name, skill);
      }
    }
  }
  return [...byNearest.values()].sort(byName);
}

/**
 * The directories of a session cwd the host inspects for project configuration, nearest first:
 * `chain` is `cwd`, its parent, and so on up to `sandboxRoot`; the *walk* is its first `walk`
 * directories, ending with the first one holding a `.git` entry (that one included; omp's
 * `repoRoot`) or with `sandboxRoot`. Everything runs on kernel real paths kept as raw bytes: a
 * resolved `cwd` that is neither the resolved `sandboxRoot` nor below it yields an empty chain
 * (the omp uid can put a link where a cwd is expected), and every directory is a parent of the
 * resolved `cwd`, hence a real directory inside the sandbox. Never throws.
 */
export function projectDirs(cwd: string, sandboxRoot: string): { chain: Buffer[]; walk: number } {
  let root: Buffer;
  let dir: Buffer;
  try {
    root = realpathSync.native(sandboxRoot, { encoding: "buffer" });
    dir = realpathSync.native(cwd, { encoding: "buffer" });
  } catch {
    return { chain: [], walk: 0 };
  }
  const below = Buffer.concat([root, Buffer.from("/")]);
  if (!dir.equals(root) && !dir.subarray(0, below.length).equals(below)) {
    return { chain: [], walk: 0 };
  }
  const chain = [dir];
  while (!dir.equals(root) && dir.lastIndexOf(SLASH) > 0) {
    dir = dir.subarray(0, dir.lastIndexOf(SLASH));
    chain.push(dir);
  }
  const repoRoot = chain.findIndex(hasGitEntry);
  return { chain, walk: repoRoot === -1 ? chain.length : repoRoot + 1 };
}

/**
 * The entry names of a directory given as raw bytes, read through a handle: null once it holds
 * more than `MAX_PROJECT_DIR_ENTRIES` (a directory of the omp uid cannot hold the event loop).
 * Throws what the filesystem throws.
 */
export function readDirBounded(dir: Buffer): string[] | null {
  const entries: string[] = [];
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entries.length === MAX_PROJECT_DIR_ENTRIES) {
        return null;
      }
      entries.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}

/**
 * The skills a session with this cwd can invoke: the platform skills, then the project skills,
 * each group in name order. A project skill replaces the platform skill of the same name (omp runs
 * the project one) and alone carries `overrides: true`. `cwd` is null when the session cwd cannot
 * be resolved: no project skill.
 */
export function sessionSkills(
  agentDir: string,
  cwd: string | null,
  sandboxRoot: string,
): SessionSkill[] {
  const platform = listSkills(agentDir);
  const project = cwd === null ? [] : listProjectSkills(cwd, sandboxRoot);
  const projectNames = new Set(project.map((skill) => skill.name));
  const platformNames = new Set(platform.map((skill) => skill.name));
  return [
    ...platform
      .filter((skill) => !projectNames.has(skill.name))
      .map((skill) => ({ ...skill, source: "skill" as const, overrides: false })),
    ...project.map((skill) => ({
      ...skill,
      source: "project" as const,
      overrides: platformNames.has(skill.name),
    })),
  ];
}

/**
 * `sessionSkills` by session identity, for the prompt route and the branch-family command check:
 * the cwd is the one the session's omp process runs in (session-cwd.ts). A cwd that cannot be
 * resolved contributes no project skill; nothing here throws.
 */
export function sessionSkillsResolver(
  agentDir: string,
  sandboxRoot: string,
  workspaceRootOf: WorkspaceRootOf,
): (ownerId: string, workspaceId: string | null) => SessionSkill[] {
  const cwdOf = sessionCwdResolver(sandboxRoot, workspaceRootOf);
  return (ownerId, workspaceId) => {
    let cwd: string | null;
    try {
      cwd = cwdOf(ownerId, workspaceId);
    } catch {
      cwd = null;
    }
    return sessionSkills(agentDir, cwd, sandboxRoot);
  };
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

/** The line every attachment suffix opens with; the paths follow it one per line. */
const ATTACHMENT_NOTE = "用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：";

/**
 * What follows the wire text of a prompt sent with attachments (#1018): two U+000A, the fixed
 * line, then U+000A and `- ` before each path as given, in order, and no trailing newline; the
 * empty string for no path. The one construction of it: the prompt route and the branch alignment
 * (branch-temp.ts) both come here, so the entry omp stored is matched byte for byte.
 */
export function attachmentSuffix(paths: readonly string[]): string {
  return paths.length === 0
    ? ""
    : `\n\n${ATTACHMENT_NOTE}${paths.map((path) => `\n- ${path}`).join("")}`;
}

function byName(left: Skill, right: Skill): number {
  return compareCodePoints(left.name, right.name);
}

/** Whether `<dir>/.git` exists, by `lstat` only: the directory itself is never enumerated. */
function hasGitEntry(dir: Buffer): boolean {
  try {
    lstatSync(Buffer.concat([dir, Buffer.from("/.git")]));
    return true;
  } catch {
    return false;
  }
}

/**
 * The skills of `<dir>/.omp/skills`, `dir` being a kernel real path. Rules added to those of the
 * platform directory, because this one is writable by the omp uid: the kernel real path of
 * `<dir>/.omp/skills` must be exactly those bytes (neither `.omp` nor `skills` is a link, so the
 * containment boundary stays inside `dir`), checked before anything is enumerated; the directory
 * is read through a handle and yields nothing once it holds more than `MAX_PROJECT_DIR_ENTRIES`;
 * and a hard-linked SKILL.md is skipped (`readBounded`). Any failure yields `[]`.
 */
function readProjectDir(dir: Buffer): Skill[] {
  const skillsDir = Buffer.concat([dir, Buffer.from(PROJECT_SKILLS)]);
  let entries: string[] | null;
  try {
    if (!realpathSync.native(skillsDir, { encoding: "buffer" }).equals(skillsDir)) {
      return [];
    }
    entries = readDirBounded(skillsDir);
  } catch {
    return [];
  }
  if (entries === null) {
    return [];
  }
  const inside = Buffer.concat([skillsDir, Buffer.from("/")]);
  return readSkillEntries(skillsDir, entries, inside, true).map((skill) => ({
    name: skill.name,
    description: firstCodePoints(skill.description, MAX_PROJECT_DESCRIPTION),
  }));
}

function firstCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit).join("") : text;
}

/**
 * The skills of one `skills` directory given its entry names: hidden entries dropped, the first
 * `MAX_SKILL_ENTRIES` in SKILL.md path order read, entries sharing a name collapsed to the first.
 * `inside` is the real path of the directory with a trailing separator. A directory given as bytes
 * (a project one) has every SKILL.md path built from those bytes; its text is the sort key only.
 */
function readSkillEntries(
  skillsDir: string | Buffer,
  entries: readonly string[],
  inside: Buffer,
  project: boolean,
): Skill[] {
  const text = skillsDir.toString();
  const candidates = entries
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => ({ entry, path: join(text, entry, "SKILL.md") }))
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .slice(0, MAX_SKILL_ENTRIES);
  const byName = new Map<string, Skill>();
  for (const { entry, path } of candidates) {
    const target =
      typeof skillsDir === "string"
        ? path
        : Buffer.concat([skillsDir, Buffer.from(`/${entry}/SKILL.md`)]);
    const skill = readSkill(target, entry, inside, project);
    if (skill !== null && !byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

/**
 * omp's drop rules for a user-level skill, plus the host rules (the name, and a SKILL.md whose
 * real path does not start with the bytes of `inside`, the real path of `skills` with a trailing
 * separator); null when it is not listed.
 */
function readSkill(
  path: string | Buffer,
  entry: string,
  inside: Buffer,
  project: boolean,
): Skill | null {
  let content: string | null;
  try {
    const resolved = realpathSync.native(path, { encoding: "buffer" });
    if (!resolved.subarray(0, inside.length).equals(inside)) {
      return null;
    }
    content = readBounded(resolved, project);
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
 * The UTF-8 content of a regular file of at most `SKILL_MD_MAX_BYTES`, else null. `path` is the
 * resolved path as raw bytes, so `O_NOFOLLOW` refuses a link swapped in as its last component.
 * `O_NONBLOCK` makes opening a FIFO return at once, `O_NOCTTY` keeps a terminal device from
 * becoming the server's controlling terminal, and the read stops at the size `fstat` reported, so
 * neither a writer-less pipe, a device nor a growing file can hold the event loop. `singleLink`
 * (project directories) also refuses a link count other than 1: a hard link to a file the server
 * can read would otherwise echo that file's frontmatter.
 */
function readBounded(path: Buffer, singleLink: boolean): string | null {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SKILL_MD_MAX_BYTES || (singleLink && stat.nlink !== 1)) {
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
