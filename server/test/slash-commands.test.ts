/**
 * Issue #551 slash whitelist (parent s1c-session-metadata-presentation tasks 10.4a, design D15):
 * `BUILTIN_COMMANDS`, `classifyPrompt`/`toWireText` and `listSkills` over a real temporary
 * `<agentDir>/skills` tree. Expected values are the literals of chat-sessions「Slash 命令白名单与
 * 命令目录」 and its Scenarios; nothing here is derived from the module under test.
 */
import { execFileSync } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_COMMANDS,
  classifyPrompt,
  listSkills,
  toWireText,
} from "../src/sessions/slash-commands.js";

const SKILLS = [{ name: "weekly-report" }];
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh root holding `agent/` (the agentDir) and room for directories outside of it. */
function makeRoot(): { root: string; agentDir: string; skillsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "slash-commands-"));
  temps.push(root);
  const agentDir = join(root, "agent");
  return { root, agentDir, skillsDir: join(agentDir, "skills") };
}

/** A SKILL.md whose frontmatter is exactly `lines`, followed by a body. */
function skillFile(lines: readonly string[], body = "正文"): string {
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

function writeSkill(skillsDir: string, entry: string, content: string): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(join(skillsDir, entry, "SKILL.md"), content);
}

/** An ASCII-only SKILL.md of exactly `bytes` bytes: a valid frontmatter, then padding. */
function paddedSkill(description: string, bytes: number): string {
  const head = `---\ndescription: ${description}\n---\n`;
  return head + "x".repeat(bytes - head.length);
}

/** `listSkills` over an agentDir whose skills are exactly `entries` (entry name → SKILL.md). */
function listOf(entries: Record<string, string>): Array<{ name: string; description: string }> {
  const { agentDir, skillsDir } = makeRoot();
  for (const [entry, content] of Object.entries(entries)) {
    writeSkill(skillsDir, entry, content);
  }
  return listSkills(agentDir);
}

describe("BUILTIN_COMMANDS", () => {
  it("holds exactly compact then todo with the four literal fields", () => {
    expect(BUILTIN_COMMANDS).toEqual([
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
    ]);
    expect(BUILTIN_COMMANDS.map((command) => Object.keys(command))).toEqual([
      ["name", "label", "description", "hint"],
      ["name", "label", "description", "hint"],
    ]);
  });
});

/** `text` classifies as plain text and its wire form is one U+0020 followed by `text`. */
function expectEscaped(text: string): void {
  expect(classifyPrompt(text, SKILLS)).toEqual({ kind: "text" });
  const wire = toWireText(text, SKILLS);
  expect(wire).toBe(` ${text}`);
  expect(wire.length).toBe(text.length + 1);
  expect(wire.codePointAt(0)).toBe(0x20);
}

describe("classifyPrompt and toWireText", () => {
  it.each([
    ["/todo", { kind: "builtin", name: "todo" }],
    ["/todo append 买菜", { kind: "builtin", name: "todo" }],
    ["/compact:focus 保留结论", { kind: "builtin", name: "compact" }],
    ["/skill:weekly-report 写周报", { kind: "skill", name: "weekly-report" }],
    ["/skill:weekly-report", { kind: "skill", name: "weekly-report" }],
    ["/todo\t制表", { kind: "builtin", name: "todo" }],
    ["/compact\n换行", { kind: "builtin", name: "compact" }],
  ])("whitelisted %j keeps its class and passes through unchanged", (text, expected) => {
    expect(classifyPrompt(text, SKILLS)).toEqual(expected);
    expect(toWireText(text, SKILLS)).toBe(text);
  });

  it.each([
    "/retry",
    "/TODO",
    "/session delete",
    "/skill:weekly-reportx",
    "/skill:",
    "/skill:weekly-report\n写周报",
    "/etc/hosts 是什么",
    "/",
    "/todox",
    "/compactor",
  ])("non-whitelisted %j is text and gains exactly one leading U+0020", expectEscaped);

  // Issue #704, Scenario「todo import and export are not whitelisted」: the eight inputs whose
  // subcommand (omp's cut: trimmed, up to the first whitespace, lower-cased) is import or export.
  it.each([
    "/todo export /abs/x.md",
    "/todo import ../x",
    "/todo export",
    "/todo EXPORT ~/x",
    "/todo  import x",
    "/todo:export /abs/x.md",
    "/todo\nimport x",
    "/todo export\n/abs/x.md",
  ])("todo file subcommand %j is text and gains exactly one leading U+0020", expectEscaped);

  // The other four of that Scenario: no subcommand, another one, a longer word, a later word.
  it.each(["/todo", "/todo append 买菜", "/todo exported", "/todo done import"])(
    "todo input %j stays the builtin and passes through unchanged",
    (text) => {
      expect(classifyPrompt(text, SKILLS)).toEqual({ kind: "builtin", name: "todo" });
      expect(toWireText(text, SKILLS)).toBe(text);
    },
  );

  it("a skill token in the middle of a prompt is text and is returned unchanged", () => {
    const text = "今天 /skill:weekly-report 帮我";
    expect(classifyPrompt(text, SKILLS)).toEqual({ kind: "text" });
    expect(toWireText(text, SKILLS)).toBe(text);
  });

  it("an installed skill is unknown to a caller that passes no skills", () => {
    const text = "/skill:weekly-report 写周报";
    expect(classifyPrompt(text, [])).toEqual({ kind: "text" });
    expect(toWireText(text, [])).toBe(` ${text}`);
  });
});

describe("listSkills", () => {
  it("lists the platform directory under omp's rules, the host name rule and first-path dedupe", () => {
    const { root, agentDir, skillsDir } = makeRoot();
    writeSkill(
      skillsDir,
      "weekly-report",
      skillFile(["name: weekly-report", 'description: "写周报"']),
    );
    writeSkill(skillsDir, "noname", skillFile(["description: x"]));
    writeSkill(skillsDir, "nodesc", skillFile(["name: nodesc"]));
    writeSkill(skillsDir, "off", skillFile(["description: y", "enabled: false"]));
    writeSkill(skillsDir, "bad name", skillFile(["name: has space", "description: z"]));
    writeSkill(skillsDir, ".hidden", skillFile(["name: hidden", "description: h"]));
    mkdirSync(join(skillsDir, "empty"));
    writeSkill(skillsDir, "folded", skillFile(["description: >", "  第一行", "  第二行"]));
    const elsewhere = join(root, "elsewhere");
    writeSkill(elsewhere, "target", skillFile(["description: l"]));
    symlinkSync(join(elsewhere, "target"), join(skillsDir, "linked"), "dir");
    writeSkill(skillsDir, "zz-copy", skillFile(["name: weekly-report", "description: other"]));

    expect(listSkills(agentDir)).toEqual([
      { name: "folded", description: "第一行 第二行" },
      { name: "linked", description: "l" },
      { name: "noname", description: "x" },
      { name: "weekly-report", description: "写周报" },
    ]);
  });

  it("returns [] when the skills path does not exist", () => {
    const { agentDir } = makeRoot();
    expect(listSkills(agentDir)).toEqual([]);
    mkdirSync(agentDir);
    expect(listSkills(agentDir)).toEqual([]);
  });

  it("returns [] when the skills path is a regular file", () => {
    const { agentDir, skillsDir } = makeRoot();
    mkdirSync(agentDir);
    writeFileSync(skillsDir, "not a directory");
    expect(listSkills(agentDir)).toEqual([]);
  });

  it("recomputes on every call: a skill added between two calls is visible", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "first", skillFile(["description: 1"]));
    expect(listSkills(agentDir)).toEqual([{ name: "first", description: "1" }]);
    writeSkill(skillsDir, "second", skillFile(["description: 2"]));
    expect(listSkills(agentDir)).toEqual([
      { name: "first", description: "1" },
      { name: "second", description: "2" },
    ]);
  });

  it("strips one pair of matching single or double quotes and nothing else", () => {
    expect(
      listOf({
        single: skillFile(["name: 'quoted-name'", "description: '单引号'"]),
        double: skillFile(['name: "double-name"', 'description: "it\'s"']),
        unpaired: skillFile(['description: "left only']),
        mixed: skillFile(["description: 'mixed\""]),
      }),
    ).toEqual([
      { name: "double-name", description: "it's" },
      { name: "mixed", description: "'mixed\"" },
      { name: "quoted-name", description: "单引号" },
      { name: "unpaired", description: '"left only' },
    ]);
  });

  it("skips an empty description, bare or quoted", () => {
    expect(
      listOf({
        bare: skillFile(["name: bare", "description:"]),
        blank: skillFile(["name: blank", "description:   "]),
        quoted: skillFile(["name: quoted", 'description: ""']),
        kept: skillFile(["description: kept"]),
      }),
    ).toEqual([{ name: "kept", description: "kept" }]);
  });

  it("falls back to the entry name when name is empty", () => {
    expect(
      listOf({
        "dir-a": skillFile(["name:", "description: a"]),
        "dir-b": skillFile(['name: ""', "description: b"]),
      }),
    ).toEqual([
      { name: "dir-a", description: "a" },
      { name: "dir-b", description: "b" },
    ]);
  });

  it("skips only an unquoted enabled: false", () => {
    expect(
      listOf({
        "off-bare": skillFile(["description: off", "enabled: false"]),
        "on-double": skillFile(["description: d", 'enabled: "false"']),
        "on-single": skillFile(["description: s", "enabled: 'false'"]),
        "on-true": skillFile(["description: t", "enabled: true"]),
      }),
    ).toEqual([
      { name: "on-double", description: "d" },
      { name: "on-single", description: "s" },
      { name: "on-true", description: "t" },
    ]);
  });

  it("reads block scalars: > folds with one space, | joins with newlines, + and - are accepted", () => {
    expect(
      listOf({
        folded: skillFile(["description: >-", "  one", "    two", "name: folded-strip"]),
        keep: skillFile(["description: |+", "  甲", "  乙"]),
        literal: skillFile(["name: literal", "description: |", "  第一行", "  第二行"]),
        "no-lines": skillFile(["description: >", "name: no-lines"]),
      }),
    ).toEqual([
      { name: "folded-strip", description: "one two" },
      { name: "keep", description: "甲\n乙" },
      { name: "literal", description: "第一行\n第二行" },
    ]);
  });

  it("reads a CRLF or CR file exactly like its LF form", () => {
    const lf = skillFile(["name: weekly-report", 'description: "写周报"', "enabled: true"]);
    const folded = skillFile(["description: >", "  第一行", "  第二行"]);
    expect(
      listOf({
        crlf: lf.replaceAll("\n", "\r\n"),
        "crlf-folded": folded.replaceAll("\n", "\r\n"),
      }),
    ).toEqual([
      { name: "crlf-folded", description: "第一行 第二行" },
      { name: "weekly-report", description: "写周报" },
    ]);
    expect(listOf({ cr: lf.replaceAll("\n", "\r") })).toEqual([
      { name: "weekly-report", description: "写周报" },
    ]);
  });

  it("skips a SKILL.md without frontmatter, with an unclosed block or with no content", () => {
    expect(
      listOf({
        plain: "name: plain\ndescription: no frontmatter\n",
        unclosed: "---\nname: unclosed\ndescription: never closed\n",
        late: "\n---\ndescription: not at the start\n---\n",
        blank: "",
        kept: skillFile(["description: kept"]),
      }),
    ).toEqual([{ name: "kept", description: "kept" }]);
  });

  it("reads nothing after the closing line of the frontmatter", () => {
    expect(
      listOf({
        "body-desc": skillFile(["name: body-desc"], "description: from the body"),
        "body-name": skillFile(["description: real"], "name: from-body\ndescription: body"),
        reopened: "---\ndescription: first\n---\n\n---\nname: second-block\n---\n",
      }),
    ).toEqual([
      { name: "body-name", description: "real" },
      { name: "reopened", description: "first" },
    ]);
  });

  it("does not treat an indented key as a top-level key", () => {
    expect(
      listOf({
        nested: skillFile(["metadata:", "  description: nested only"]),
        "nested-name": skillFile(["description: top", "metadata:", "  name: inner"]),
        tabbed: skillFile(["\tdescription: tabbed"]),
      }),
    ).toEqual([{ name: "nested-name", description: "top" }]);
  });

  it("keeps the duplicate whose SKILL.md path sorts first, whatever order the directory lists", () => {
    const { agentDir, skillsDir } = makeRoot();
    const entries = ["weekly-report", "m-copy", "aa-copy", "x-copy", "b-copy"];
    for (const entry of entries) {
      writeSkill(skillsDir, entry, skillFile(["name: weekly-report", `description: ${entry}`]));
    }
    expect(listSkills(agentDir)).toEqual([{ name: "weekly-report", description: "aa-copy" }]);

    // The platform decides readdir order (sorted on APFS, hashed on ext4): pin both extremes.
    const readdir = vi.spyOn(fs, "readdirSync");
    try {
      for (const order of [[...entries].sort().reverse(), entries]) {
        readdir.mockReturnValue(order as unknown as ReturnType<typeof fs.readdirSync>);
        syncBuiltinESMExports();
        expect(listSkills(agentDir)).toEqual([{ name: "weekly-report", description: "aa-copy" }]);
      }
      expect(readdir).toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("sorts by name in code-point order, not by locale or case-folding", () => {
    expect(
      listOf({
        "dir-1": skillFile(["name: alpha", "description: a"]),
        "dir-2": skillFile(["name: Zeta", "description: z"]),
        "dir-3": skillFile(["name: éclair", "description: e"]),
        "dir-4": skillFile(["name: _under", "description: u"]),
      }).map((skill) => skill.name),
    ).toEqual(["Zeta", "_under", "alpha", "éclair"]);
  });

  it("applies the host name rule to the entry name as well", () => {
    expect(
      listOf({
        "has space": skillFile(["description: dir name with a space"]),
        slashed: skillFile(["name: a/b", "description: slash"]),
        colon: skillFile(["name: with:colon", "description: colon is allowed"]),
      }),
    ).toEqual([{ name: "with:colon", description: "colon is allowed" }]);
  });

  it("ignores a regular file sitting under skills", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
    writeFileSync(join(skillsDir, "README.md"), skillFile(["description: a file"]));
    writeFileSync(join(skillsDir, "SKILL.md"), skillFile(["description: skills root"]));
    expect(listSkills(agentDir)).toEqual([{ name: "kept", description: "kept" }]);
  });

  it.skipIf(process.getuid?.() === 0)("skips an unreadable SKILL.md without throwing", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
    writeSkill(skillsDir, "locked", skillFile(["description: locked"]));
    chmodSync(join(skillsDir, "locked", "SKILL.md"), 0o000);
    expect(listSkills(agentDir)).toEqual([{ name: "kept", description: "kept" }]);
  });

  it.skipIf(process.getuid?.() === 0)("returns [] when the skills directory is unreadable", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
    chmodSync(skillsDir, 0o000);
    try {
      expect(listSkills(agentDir)).toEqual([]);
    } finally {
      chmodSync(skillsDir, 0o755);
    }
  });

  it("reads a SKILL.md of exactly 262144 bytes and skips one of 262145 bytes", () => {
    const atCap = paddedSkill("at the cap", 262144);
    const overCap = paddedSkill("over the cap", 262145);
    expect(Buffer.byteLength(atCap)).toBe(262144);
    expect(Buffer.byteLength(overCap)).toBe(262145);

    expect(listOf({ "at-cap": atCap, "over-cap": overCap })).toEqual([
      { name: "at-cap", description: "at the cap" },
    ]);
  });

  // Before the bounded read this case never returned: do not run it against older sources.
  it.skipIf(process.platform === "win32")(
    "skips a SKILL.md that is a FIFO without blocking",
    () => {
      const { agentDir, skillsDir } = makeRoot();
      writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
      mkdirSync(join(skillsDir, "pipe"));
      execFileSync("mkfifo", [join(skillsDir, "pipe", "SKILL.md")]);

      expect(listSkills(agentDir)).toEqual([{ name: "kept", description: "kept" }]);
    },
  );

  // Before the bounded read this case exhausted memory: do not run it against older sources.
  it.skipIf(!existsSync("/dev/zero"))("skips a SKILL.md symlinked to /dev/zero", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
    mkdirSync(join(skillsDir, "zero"));
    symlinkSync("/dev/zero", join(skillsDir, "zero", "SKILL.md"));

    expect(listSkills(agentDir)).toEqual([{ name: "kept", description: "kept" }]);
  });

  it("skips a SKILL.md that is a directory", () => {
    const { agentDir, skillsDir } = makeRoot();
    writeSkill(skillsDir, "kept", skillFile(["description: kept"]));
    mkdirSync(join(skillsDir, "dir", "SKILL.md"), { recursive: true });

    expect(listSkills(agentDir)).toEqual([{ name: "kept", description: "kept" }]);
  });

  it("follows a SKILL.md symlinked to a regular file", () => {
    const { root, agentDir, skillsDir } = makeRoot();
    writeFileSync(join(root, "elsewhere.md"), skillFile(["description: through a link"]));
    mkdirSync(join(skillsDir, "file-link"), { recursive: true });
    symlinkSync(join(root, "elsewhere.md"), join(skillsDir, "file-link", "SKILL.md"));

    expect(listSkills(agentDir)).toEqual([{ name: "file-link", description: "through a link" }]);
  });

  it("keeps the last of several thousand repeated block-scalar names", () => {
    const lines: string[] = [];
    for (let index = 0; index < 5000; index += 1) {
      lines.push("name: >", `  name-${index}`);
    }
    lines.push("description: |", "  甲", "  乙");

    expect(listOf({ repeated: skillFile(lines) })).toEqual([
      { name: "name-4999", description: "甲\n乙" },
    ]);
  });
});
