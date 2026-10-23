/**
 * The omp command line of every spawn (omp-runtime「子进程 spawn 契约」, omp-uid-isolation「OMP_USER
 * 配置与 sudo spawn 前缀」), assembled from values `spawnOmp` already prepared. Paths are the
 * configured ones, not resolved.
 */
import { SETPRIV_PATH } from "../../core/process-path.js";
import type { ApprovalMode } from "../../model-catalog.js";
import { SUDO_PRESERVE_ENV } from "./spawn-env.js";
import { ompHostOverlayPath } from "./state-layout.js";

export interface OmpArgvInput {
  stateDir: string;
  cwd: string;
  sessionDir: string;
  modelId: string;
  approvalMode: ApprovalMode;
  resumePath: string | null;
  /** The session config file's `--config` (and `--append-system-prompt`), `session-config.ts`. */
  sessionConfigArgs: readonly string[];
}

/** omp's own arguments; `--resume` stays last. */
export function ompArgs(input: OmpArgvInput): string[] {
  return [
    // rpc-ui: tool UI (the browser prelude's approval) reaches the protocol; plain rpc fails it.
    "--mode",
    "rpc-ui",
    "--cwd",
    input.cwd,
    "--session-dir",
    input.sessionDir,
    "--model",
    `workbuddy/${input.modelId}`,
    "--approval-mode",
    input.approvalMode,
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
    // Written at startup; omp exits before `ready` when it is missing, and there is no fallback.
    "--config",
    ompHostOverlayPath(input.stateDir),
    // A later `--config` layer: it adds the session's keys over the host overlay.
    ...input.sessionConfigArgs,
    ...(input.resumePath === null ? [] : ["--resume", input.resumePath]),
  ];
}

/** The executable and its argv: omp itself, or omp under `sudo -u <ompUser>` and setpriv. */
export function ompCommand(
  bin: string,
  ompUser: string | undefined,
  args: readonly string[],
  tmpdir: string | undefined,
): { command: string; commandArgs: string[] } {
  if (ompUser === undefined) {
    return { command: bin, commandArgs: [...args] };
  }
  return {
    command: "sudo",
    commandArgs: [
      "-n",
      "-u",
      ompUser,
      SUDO_PRESERVE_ENV,
      ...(tmpdir === undefined ? [] : [`TMPDIR=${tmpdir}`]),
      "--",
      // setpriv execs omp in place; the kernel SIGKILLs omp when sudo dies.
      SETPRIV_PATH,
      "--pdeathsig",
      "KILL",
      "--",
      bin,
      ...args,
    ],
  };
}
