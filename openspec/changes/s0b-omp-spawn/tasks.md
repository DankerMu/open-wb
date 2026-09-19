## 1. Spawn contract
- [ ] 1.1 Write failing spawn-contract tests before implementation, including semantic RED against a callable incomplete boundary; retain evidence.
- [ ] 1.2 Implement exact cold/resume argv, explicit env construction and four-directory preparation before spawn; preserve stdio pipes and no shell.
- [ ] 1.3 Prove exact capture plus real child env/cwd/argv, optional env present/absent/empty, 64-hex token, no credentials, parent env unchanged, existing-dir reuse and mkdir failure with no spawn.
- [ ] 1.4 Run focused Vitest, npm test --workspace server (unchanged coverage), make lint, make typecheck, make anti-drift, direct boundary smoke and CI.
- [ ] 1.5 Complete agent cross-review, obtain REQUIRED human white-box review, then merge and archive only this fixture.

## Core risk packs
- Selected Public API / CLI / script entry:1.2-1.4; real spawn and exact argv, no shell.
- Selected Config / project setup:1.2-1.3; explicit bin/roots/model/caller token; no app config assembly here.
- Selected File IO / path safety / overwrite:1.2-1.3; four owned directories and failure-before-spawn; arbitrary owner/path authorization is S1a/caller scope.
- Selected Schema / columns / units / field names:1.3; exact env keys and argv sequence.
- Selected Auth / permissions / secrets:1.3; contaminated parent, real child allowlist, no logs/token argv.
- Selected Concurrency / shared state / ordering:1.2-1.3; mkdir-before-spawn and parent-env immutability; concurrent runtime lifecycle excluded.
- Selected Resource limits / large input / discovery:1.3; test child cleanup; runtime limits/reaping policy excluded to #96.
- Selected Legacy compatibility / examples:1.3; frozen omp v18.0.10 flags and --resume semantics, no PATH-based binary selection.
- Selected Error handling / rollback / partial outputs:1.3; mkdir failure propagates with no spawn; no deletion/rollback of already-existing directories.
- Not selected Release / packaging / dependency compatibility: no dependency or binary supply changes; #86 owns supply.
- Selected Documentation / migration notes:1.5; PR Critical Path marker, human review requirement and declared-environment-only limitation.

## Project domain packs
- Selected process/child-environment isolation:1.2-1.4; production boundary capture plus actual child environment.
- Selected cross-service credential boundary:1.3; gateway/KB secrets never copied to child env; no network request here.
- Not selected tenant/sandbox isolation: trusted owner input, authorization and path policy outside this slice.
- Not selected auth/session lifecycle: no cookie/registry/token-generation changes.
- Not selected SQLite migration/catalog compatibility: no DB access.
- Not selected server/web HTTP-envelope compatibility: no routes.
- Not selected browser runtime/navigation/persistence: no browser.
- Not selected offline deployability: no supply/dependency/deployment changes; Node-only existing toolchain retained.
