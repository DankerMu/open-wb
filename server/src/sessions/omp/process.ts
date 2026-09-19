/**
 * omp spawn assembly (Issue #85): argv, allowlisted env, directory preparation.
 * Protocol, idle/reap, models.yml and token issuance live elsewhere.
 */
import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface SpawnOmpOpts {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  ownerId: string;
  modelId: string;
  token: string;
  resumePath: string | null;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

/**
 * Prepare owned directories then spawn the omp child.
 * Await this call: it settles after directory preparation and spawnImpl return.
 * It does not wait for the child to exit.
 */
export async function spawnOmp(
  opts: SpawnOmpOpts,
  spawnImpl: SpawnImpl = spawn as SpawnImpl,
): Promise<ChildProcessWithoutNullStreams> {
  const cwd = join(opts.sandboxRoot, opts.ownerId);
  const sessionDir = join(opts.stateDir, "sessions", opts.ownerId);
  const home = join(opts.stateDir, "home");
  const agent = join(opts.stateDir, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(agent, { recursive: true });

  const args = [
    "--mode",
    "rpc",
    "--cwd",
    cwd,
    "--session-dir",
    sessionDir,
    "--model",
    `workbuddy/${opts.modelId}`,
    "--approval-mode",
    "yolo",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
  ];
  if (opts.resumePath !== null) {
    args.push("--resume", opts.resumePath);
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    PI_CODING_AGENT_DIR: agent,
    WORKBUDDY_MODEL_TOKEN: opts.token,
  };
  if (process.env.LANG !== undefined) {
    env.LANG = process.env.LANG;
  }
  if (process.env.TMPDIR !== undefined) {
    env.TMPDIR = process.env.TMPDIR;
  }

  return spawnImpl(opts.bin, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}
