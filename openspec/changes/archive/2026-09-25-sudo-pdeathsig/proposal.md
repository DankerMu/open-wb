## Why
#351 — measured on the test VPS (Ubuntu 24.04, sudo 1.9.15p5): with `OMP_USER`, `spawnOmp` launches `sudo -n -u <ompUser> … -- <OMP_BIN> …` (`server/src/sessions/omp/process.ts:91-110`). The sudo parent keeps ruid = app uid, so `kill()` succeeds and sudo relays SIGTERM; but the retire escalation SIGKILL (`server/src/sessions/omp/runtime.ts` #runRetire, TERM@5 s → KILL@8 s) can only kill sudo. omp is reparented to init, keeps running as ompUser, holds the stdio pipes (`'close'` never arrives), and the app uid cannot kill it (`EPERM`). Retirement itself stays bounded (native `'exit'` + `#drainHeld`), but the omp process leaks. Measured fix: `sudo … -- /usr/bin/setpriv --pdeathsig KILL -- <OMP_BIN> …` — the kernel SIGKILLs omp when sudo dies; `'close'` arrived 2 ms after SIGKILL, no residue.

## Triage
Issue type: bug
Fixture level: expanded
Upstream suggested level: absent (expanded: process spawn/lifecycle, sudoers authorization surface, CI provisioning)
Blast radius: production uid-isolation spawn; wrong argv or sudoers breaks every sudo-mode session (agent_unavailable) or widens the authorization surface.
Selected risk packs: Auth / secrets (sudoers scope; no credential in argv); Legacy compatibility (direct-spawn mode unchanged; exact argv spec); Concurrency / ordering (SIGKILL → pdeathsig reaping); Release (CI provisioning + deployment sudoers doc); Documentation (ADR-0010).
Evidence floor: argv tests with a process.ts mutation shown red; precondition tests; CI sudoers allow/deny check; Linux uid-isolation SIGKILL reaping case with positive pre-observation; test-ci-harness contracts + launcher-drop mutation; full suite, lint, typecheck, anti-drift.

## What Changes
- `process.ts`: sudo-mode argv inserts the fixed `'/usr/bin/setpriv','--pdeathsig','KILL','--'` between sudo's `--` and `OMP_BIN`. Direct mode unchanged.
- Precondition (issue AC 3): with `ompUser` present, canonical config (`server/src/agent-config.ts`, next to `assertSafeSudoPath`) and the spawn boundary (`spawnOmp`, next to `assertSafeSudoPath`) require `/usr/bin/setpriv` executable (`accessSync(..., X_OK)`), sharing one helper in `server/src/core/process-path.ts`; failure is the existing generic config failure / spawn rejection before effects. Absent `ompUser` → no check.
- Tests: argv-pinning helper `sudoPrefix()` (`server/test/session-supervisor-helpers.ts:~358`) updated, and at least one `server/test/omp-process.test.ts` case inlines the literal launcher tokens; config/spawn precondition tests (missing launcher → failure; absent ompUser unaffected) using an injectable path or existing seam.
- `.github/scripts/ci-uid-isolation.sh`: one rule generator function emits, for a given user, `<user> ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <escaped bin> *` for the fake omp and `var/omp/omp`, plus the unchanged `/usr/bin/env` rule; used for the runner and for a check-only user (no login, no other rules); `sudo -l -U <check user> -u omp …` asserts allow (launcher + trailing arg) / deny (no launcher; zero trailing args). Escape `=` in argument position too. `scripts/test-ci-harness.sh` contract lines updated; new `cm` mutation dropping the launcher from the generator is caught.
- `server/test/linux/uid-isolation.test.ts`: SIGKILL reaping case (spec 「Linux 隔离证明」).
- `docs/adr/0010-dedicated-omp-uid.md`: supplement — spawn line and sudoers line (:7, :23, :31) with launcher; setpriv runs after sudo's privilege drop as the unprivileged ompUser (not the rejected custom setuid wrapper, :35); pdeathsig survives exec of a non-setuid, capability-free binary (VPS-measured); caveats: `log_output` / tty `use_pty` add a sudo monitor process and void the guarantee; residuals below.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-uid-isolation`: MODIFIED 「OMP_USER 配置与 sudo spawn 前缀」 (launcher in exact argv + setpriv precondition), 「Linux 隔离证明」 (SIGKILL reaping case), 「CI uid-isolation job」 (launcher sudoers rules + allow/deny rule check).

## Impact
`server/src/sessions/omp/process.ts`, `server/src/core/process-path.ts`, `server/src/agent-config.ts`; argv/config tests; `server/test/linux/uid-isolation.test.ts`; `.github/scripts/ci-uid-isolation.sh`; `scripts/test-ci-harness.sh`; ADR-0010. Deployment: sudoers rules must be updated to the new launcher form (existing sudo-mode deployments must update their sudoers line; documented in ADR-0010).
