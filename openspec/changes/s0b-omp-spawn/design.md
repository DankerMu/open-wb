## Context
S0b task1.3 / issue85 explicitly separates spawn assembly from subsequent JSONL/handshake implementation.
## Goals / Non-Goals
Goal: exact observable argv/env/filesystem contract at spawnOmp(opts, spawnImpl).
Non-goals: protocol reads/writes, ready handling, runtime shutdown/idle timers, token generation, models.yml writes, UID separation, sandbox authorization/path policy.
## Decisions
Change surface: server/src/sessions/omp/process.ts and server/test/omp-process.test.ts only.
Governing invariant: the child receives only explicitly constructed allowlisted environment keys, after all four required directories exist; no parent credential or DB setting is inherited.
Input fields: bin, sandboxRoot, stateDir, ownerId, modelId, token, resumePath:string|null. This internal boundary receives trusted configuration/owner identity and a caller-generated 64-lowercase-hex token; it does not invent another token registry.
Use Node spawn directly by default, injectable at its invocation boundary; return the real child handle with piped stdio, no shell. Directory preparation may be asynchronous; document await semantics in the exported type.
Paths: cwd=<sandboxRoot>/<ownerId>, session-dir=<stateDir>/sessions/<ownerId>, HOME=<stateDir>/home, PI_CODING_AGENT_DIR=<stateDir>/agent.
Create all four directories recursively before invoking spawnImpl; filesystem failure must surface and prevent spawning, without synthetic success or credential logging.
Argv exact order: --mode rpc --cwd <cwd> --session-dir <session-dir> --model workbuddy/<modelId> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title.
Append --resume and resumePath exactly when resumePath !== null; paths containing spaces remain single argv entries, not shell text.
Environment: PATH, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN always constructed; LANG and TMPDIR copied only when defined in parent (including empty strings). PATH copies parent value; absent PATH uses an empty string rather than an implicit search fallback.
Must preserve: official binary supplied by #86 and an absolute OMP_BIN selected/canonicalized by config (#101), exact parent spec ordering and optional-field semantics; no spread of process.env, no persistent global environment mutation. The parent http-service-skeleton delta already requires repo-root-relative config paths; #148 tracks explicit OMP_BIN evidence within #101, not new runtime policy.
Sibling surfaces: null/resumed launches, optional LANG/TMPDIR combinations, parent HOME/agent/token overrides, contaminated credential env, pre-existing directories and mkdir failure, default spawn versus injected capture.
Seams under test: injected spawn receives exact values with real temporary filesystem; a native /usr/bin/env child verifies the raw effective environment without filtering, while a Node diagnostic verifies cwd and argument boundaries under polluted parent environment. Darwin Node self-adds CF metadata (independent empty-env control confirmed), so it is not the raw-env oracle. These probes are diagnostics, not another fake RPC implementation.
Required evidence: cold launch omits resume; resumed launch adds exactly two args; all four dirs exist at spawn call; env key set exact and sentinel MODEL_UPSTREAM_*, OPENAI_API_KEY, ANTHROPIC_API_KEY, DB_PATH and unrelated keys absent.
Required evidence: token retains the caller's 64-hex value; optional parent env presence/absence/empty values preserved; HOME/agent always overridden to owned paths; parent env unchanged.
Required evidence: repeated launch reuses existing dirs; file obstructing a required directory fails before spawn; real child observations agree with capture and child is reaped by test owner.
## Risks / Trade-offs
This closes declared environment inheritance only. Same-uid /proc and filesystem reads remain the documented S0b limit; ADR0010/S1a owns UID separation, not this issue.
Production spawn/credential injection is Critical Path. Agent cross-review and green CI do not replace the REQUIRED human white-box review; hold merge until a human review record covers the final implementation.
## Migration Plan
No persisted-state migration. Later #95 extends the same module and uses this boundary; no second spawn implementation or compatibility wrapper.
