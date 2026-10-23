/**
 * s1d-experts-skills group 1 (issue #1656): the per-spawn session config file — omp-runtime「子进程
 * spawn 契约」「会话配置文件」, scenarios「有专家与停用技能时的 argv」「无专家时只有会话 yml」and the
 * write-failure and spawn-failure parts of「子进程结束后会话配置文件被删除」. Expected bytes, paths and
 * modes are the spec's, written out here. The `.md` write failure is injected at the file-system
 * boundary (`node:fs/promises` `open` of the `.md` temporary file).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { type SpawnImpl, type SpawnOmpOpts, spawnOmp } from "../src/sessions/omp/process.js";
import { writeSessionConfig } from "../src/sessions/omp/session-config.js";
import { ensureOmpStateLayout } from "../src/sessions/omp/state-layout.js";
import { FakeChild } from "./support/omp-rpc.js";
import { EMPTY_CAPABILITIES } from "./support/session-config.js";

const OWNER = "u1";
/** An expert prompt with a newline and CJK text. */
const PROMPT = "你是一位测试工程师。\n先写用例，再改代码。";
const ADVERSARIAL = 'skill:a: #"b';

const temps: string[] = [];
const fakes: FakeChild[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const child of fakes.splice(0)) {
    child.destroy();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-session-config-")));
  temps.push(root);
  return root;
}

/** A laid-out state dir; returns it and its `session-config` directory. */
function laidOut(): { root: string; state: string; dir: string } {
  const root = tempRoot();
  const state = join(root, "state");
  ensureOmpStateLayout(state);
  return { root, state, dir: join(state, "session-config") };
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** Makes every exclusive open of a `.md` temporary file fail with EACCES (the replace's first step). */
function failMarkdownWrites(): void {
  const open = fsPromises.open;
  vi.spyOn(fsPromises, "open").mockImplementation(((...args: Parameters<typeof open>) => {
    if (/\.md\.\d+\.[0-9a-f]+\.tmp$/u.test(String(args[0]))) {
      return Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    }
    return open(...args);
  }) as typeof open);
  syncBuiltinESMExports();
}

describe("writeSessionConfig", () => {
  it("writes exactly one disabledExtensions line, deduplicated and sorted, and no .md without a prompt", async () => {
    const { state, dir } = laidOut();

    const config = await writeSessionConfig(state, {
      disabledExtensions: ["skill:weekly-report", "skill:deploy", "skill:deploy"],
      appendSystemPrompt: null,
    });

    expect(config.key).toMatch(/^[0-9a-f]+$/u);
    const yml = join(dir, `${config.key}.yml`);
    expect(config.args).toEqual(["--config", yml]);
    expect(readFileSync(yml, "utf8")).toBe(
      'disabledExtensions: ["skill:deploy", "skill:weekly-report"]\n',
    );
    expect(parse(readFileSync(yml, "utf8"))).toEqual({
      disabledExtensions: ["skill:deploy", "skill:weekly-report"],
    });
    expect(modeOf(yml)).toBe(0o640);
    expect(readdirSync(dir)).toEqual([`${config.key}.yml`]);
  });

  it("writes an empty list as []", async () => {
    const { state, dir } = laidOut();

    const config = await writeSessionConfig(state, EMPTY_CAPABILITIES);

    const text = readFileSync(join(dir, `${config.key}.yml`), "utf8");
    expect(text).toBe("disabledExtensions: []\n");
    expect(parse(text)).toEqual({ disabledExtensions: [] });
  });

  it('writes a name with ":", " ", "#" and a double quote as a JSON string that YAML reads back', async () => {
    const { state, dir } = laidOut();

    const config = await writeSessionConfig(state, {
      disabledExtensions: ["skill:deploy", ADVERSARIAL],
      appendSystemPrompt: null,
    });

    const text = readFileSync(join(dir, `${config.key}.yml`), "utf8");
    expect(text).toBe('disabledExtensions: ["skill:a: #\\"b", "skill:deploy"]\n');
    const parsed = parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["disabledExtensions"]);
    expect(parsed.disabledExtensions).toEqual([ADVERSARIAL, "skill:deploy"]);
  });

  it("writes the prompt's UTF-8 bytes to <key>.md at 0640 and adds --append-system-prompt", async () => {
    const { state, dir } = laidOut();

    const config = await writeSessionConfig(state, {
      disabledExtensions: ["skill:deploy"],
      appendSystemPrompt: PROMPT,
    });

    const yml = join(dir, `${config.key}.yml`);
    const md = join(dir, `${config.key}.md`);
    expect(config.args).toEqual(["--config", yml, "--append-system-prompt", md]);
    expect(readFileSync(md).equals(Buffer.from(PROMPT, "utf8"))).toBe(true);
    expect(modeOf(yml)).toBe(0o640);
    expect(modeOf(md)).toBe(0o640);
  });

  it("uses a new key on every call and remove() deletes both files, twice without throwing", async () => {
    const { state, dir } = laidOut();
    const capabilities = { disabledExtensions: [], appendSystemPrompt: PROMPT };

    const first = await writeSessionConfig(state, capabilities);
    const second = await writeSessionConfig(state, capabilities);

    expect(second.key).not.toBe(first.key);
    first.remove();
    expect(readdirSync(dir).toSorted()).toEqual([`${second.key}.md`, `${second.key}.yml`]);
    expect(() => first.remove()).not.toThrow();
    second.remove();
    second.remove();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves no .yml behind when the .md cannot be written", async () => {
    const { state, dir } = laidOut();
    failMarkdownWrites();

    await expect(
      writeSessionConfig(state, {
        disabledExtensions: ["skill:deploy"],
        appendSystemPrompt: PROMPT,
      }),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(readdirSync(dir)).toEqual([]);
  });
});

interface Seen {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  /** `session-config/` at the moment spawnImpl ran: file name → bytes and mode. */
  files: Record<string, { text: string; mode: number }>;
}

/** A spawnImpl that snapshots `session-config/` when called, then hands out a FakeChild. */
function observing(dir: string, seen: Seen[]): SpawnImpl {
  return (command, args, options) => {
    const files: Seen["files"] = {};
    for (const name of readdirSync(dir)) {
      files[name] = { text: readFileSync(join(dir, name), "utf8"), mode: modeOf(join(dir, name)) };
    }
    seen.push({ args: [...args], env: options.env, files });
    const child = new FakeChild();
    fakes.push(child);
    return child.spawnImpl(command, args, options) as ChildProcessWithoutNullStreams;
  };
}

function spawnOpts(
  root: string,
  state: string,
  capabilities: SpawnOmpOpts["capabilities"],
  resumePath: string | null = null,
): SpawnOmpOpts {
  return {
    bin: join(root, "omp-bin"),
    sandboxRoot: join(root, "sandbox"),
    stateDir: state,
    ownerId: OWNER,
    cwd: join(root, "sandbox", OWNER),
    modelId: "deepseek-v4.1-flash",
    approvalMode: "write",
    token: "a".repeat(64),
    resumePath,
    capabilities,
  };
}

/** argv after the host overlay's `--config <path>`. */
function afterOverlay(args: readonly string[], state: string): string[] {
  const overlay = join(state, "home", ".omp", "agent", "host-overlay.yml");
  const at = args.indexOf("--config");
  expect(args[at + 1]).toBe(overlay);
  return args.slice(at + 2);
}

describe("spawnOmp session config", () => {
  it("passes the session yml, then the expert prompt, then --resume, with files written before spawn", async () => {
    const { root, state, dir } = laidOut();
    const seen: Seen[] = [];
    const resume = join(state, "sessions", OWNER, "s.jsonl");
    const capabilities = { disabledExtensions: ["skill:deploy"], appendSystemPrompt: PROMPT };

    await spawnOmp(spawnOpts(root, state, capabilities, resume), observing(dir, seen));
    await spawnOmp(spawnOpts(root, state, capabilities, resume), observing(dir, seen));

    const [first, second] = seen as [Seen, Seen];
    const tail = afterOverlay(first.args, state);
    expect(tail).toHaveLength(6);
    const key = /([0-9a-f]+)\.yml$/u.exec(String(tail[1]))?.[1] ?? "";
    expect(key).toMatch(/^[0-9a-f]+$/u);
    expect(tail).toEqual([
      "--config",
      join(dir, `${key}.yml`),
      "--append-system-prompt",
      join(dir, `${key}.md`),
      "--resume",
      resume,
    ]);
    expect(parse(first.files[`${key}.yml`]?.text ?? "")).toEqual({
      disabledExtensions: ["skill:deploy"],
    });
    expect(first.files[`${key}.md`]?.text).toBe(PROMPT);
    expect(first.files[`${key}.yml`]?.mode).toBe(0o640);
    expect(first.files[`${key}.md`]?.mode).toBe(0o640);
    expect(first.env?.PI_CONFIG_FILES).toBe(
      join(state, "home", ".omp", "agent", "host-overlay.yml"),
    );
    expect(afterOverlay(second.args, state)[1]).not.toBe(tail[1]);
  });

  it("without an expert passes exactly one session --config and writes no .md", async () => {
    const { root, state, dir } = laidOut();
    const seen: Seen[] = [];

    await spawnOmp(spawnOpts(root, state, EMPTY_CAPABILITIES), observing(dir, seen));

    const [call] = seen as [Seen];
    const tail = afterOverlay(call.args, state);
    expect(tail).toHaveLength(2);
    expect(tail[0]).toBe("--config");
    expect(call.args).not.toContain("--append-system-prompt");
    const names = Object.keys(call.files);
    expect(names).toHaveLength(1);
    expect(join(dir, String(names[0]))).toBe(tail[1]);
    expect(parse(call.files[String(names[0])]?.text ?? "")).toEqual({ disabledExtensions: [] });
  });

  it("does not spawn and leaves no .yml when the .md cannot be written", async () => {
    const { root, state, dir } = laidOut();
    const seen: Seen[] = [];
    failMarkdownWrites();

    await expect(
      spawnOmp(
        spawnOpts(root, state, { disabledExtensions: [], appendSystemPrompt: PROMPT }),
        observing(dir, seen),
      ),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(seen).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes both files when spawnImpl throws synchronously after they were written", async () => {
    const { root, state, dir } = laidOut();
    const present: string[][] = [];
    const throwing: SpawnImpl = () => {
      present.push(readdirSync(dir).toSorted());
      throw new Error("spawn EAGAIN");
    };

    await expect(
      spawnOmp(
        spawnOpts(root, state, {
          disabledExtensions: ["skill:deploy"],
          appendSystemPrompt: PROMPT,
        }),
        throwing,
      ),
    ).rejects.toThrow("spawn EAGAIN");

    expect(present).toHaveLength(1);
    expect(present[0]?.map((name) => name.slice(name.lastIndexOf(".")))).toEqual([".md", ".yml"]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
