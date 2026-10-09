/**
 * Host overlay (issue #708, ADR-0012): omp deep-merges the project settings found under the
 * session cwd, a directory the agent writes without approval, over the global layer. This file is
 * passed to every spawn as `--config` (global < project < overlay < CLI) and pins the keys that
 * would skip an approval or run a command outside one. The values were verified against omp
 * v18.0.10 and are not schema-checked by it: re-verify them on an omp upgrade.
 *
 * `tools.approvalMode: write` sits below argv: omp v18.0.10 writes `--approval-mode` into a runtime
 * override layer above the overlay, so for an `always-ask` or `yolo` session the argv value is the
 * one in effect and that line is only the fallback for a spawn without the flag (every spawn
 * passes it). All sessions and all approval modes share this one file and its bytes never vary
 * with the mode: a session changes mode by being re-spawned, never by rewriting the overlay.
 */
import { basename, dirname } from "node:path";
import { replaceFile } from "../../core/replace-file.js";
import { ompHostOverlayPath } from "./state-layout.js";

const HOST_OVERLAY = [
  "tools:",
  // An array replaces the project's per-tool record as a whole; an object would be deep-merged.
  "  approval: []",
  "  approvalMode: write",
  "bash:",
  "  patterns: []",
  '  direnv: "off"',
  "shellPath: null",
  "python:",
  '  interpreter: ""',
  "ruby:",
  '  interpreter: ""',
  "julia:",
  '  interpreter: ""',
  "mcp:",
  "  enableProjectConfig: false",
  "todo:",
  // No hidden reminder and same-turn continuation for unfinished todos (issue #772).
  "  reminders: false",
  "images:",
  "  urls:",
  "    enabled: false",
  "    command: null",
  "",
].join("\n");

/**
 * Writes the constant overlay to `ompHostOverlayPath(stateDir)` the way the managed `models.yml` is
 * written. The managed agent dir must exist: the state layout creates it, this writer never does.
 */
export async function writeHostOverlay(stateDir: string): Promise<void> {
  const path = ompHostOverlayPath(stateDir);
  await replaceFile(dirname(path), basename(path), HOST_OVERLAY);
}
