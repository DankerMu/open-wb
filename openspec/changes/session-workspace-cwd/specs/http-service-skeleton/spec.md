## MODIFIED Requirements

### Requirement: Shared agent module assembly
createApp SHALL always register model-proxy then sessions then workspaces then accounts after auth and the HTTP guard, before catch-all/static routes, using one shared TokenRegistry. Sessions SHALL reconcile before accepting requests. App close SHALL reuse the existing module preClose cleanup without closing caller-owned DB. No startup process or agent directories SHALL be created by merely configuring/registering modules; lazy runtime spawn retains directory ownership. The seven-module startup record SHALL correspond to the actual composition, not only a hardcoded list. Post-listen model publication and active-runtime signal cleanup belong to the production entry lifecycle above; merely constructing the injectable app SHALL remain free of these startup effects. SSE remains outside this requirement (issue #103).
createApp SHALL create exactly one workspace store with its caller-owned DB, runtime.sandboxRoot, canonical ensureSharedDir and raw emit(db,event). It SHALL bind audit.emit as event=>emit(db,event), create the synchronous sandbox facade with store.rootOf and that audit, registerWorkspaces(app,{store,sandbox,audit}), then registerAccounts(app,{db}). It SHALL NOT introduce a second sandboxRoot setting, optional module-registration bypass, alternate store/audit implementation, or eager owner directories. Existing synchronous onError/onEvent return-value ownership and all #204 sink semantics SHALL remain unchanged. The resolved `OMP_MAX_PROCESSES` value SHALL reach the sessions module as its supervisor process cap through the same runtime settings object as `OMP_IDLE_MS`, without a second configuration path; the resolved `OMP_SPAWN_CONCURRENCY` value SHALL reach it as the supervisor spawn-gate limit through that same object. createApp's assembly SHALL accept an optional synchronous `log` sink forwarded unchanged through registerSessions to the supervisor (omitted → records are discarded); it is not an `onError` fault and SHALL NOT be retained as one. The production entry SHALL supply it (see 服务启动与装配); merely constructing the injectable app without it SHALL write nothing. createApp SHALL create that single workspace store before registerSessions and SHALL pass its owner-scoped `rootOf` to registerSessions, which uses it only to resolve a bound session's omp working directory (chat-sessions「Supervisor dispatch and generation binding」); the module registration order (model-proxy → sessions → workspaces → accounts) and every other wiring rule above are unchanged, and no second workspace store, sandboxRoot setting or root computation SHALL be introduced for sessions.

#### Scenario: Authenticated session and bearer proxy coexist
- **WHEN** a real createApp is created with caller DB and injected trusted runtime/registry settings
- **THEN** session routes use cookie/owner guards, proxy uses the same runtime-issued bearer rather than cookie auth, health/info/static behavior remains unchanged and app.close leaves DB usable
#### Scenario: Missing upstream remains an available app
- **WHEN** either upstream setting is absent
- **THEN** startup and authenticated session CRUD remain available; invalid bearer receives401 before parser/config work, a registered live bearer receives502 and the secret value is absent from startup/failure output
#### Scenario: Pure source and compiled configuration identity
- **WHEN** the existing pure resolver receives defaults/overrides for all fifteen application keys at source and compiled entry URLs from unrelated cwd
- **THEN** each existing default and override (including optional ompUser, the process cap defaulting to 16 and the spawn concurrency defaulting to `os.availableParallelism()`) is observed unchanged, path identity remains rooted at the entry's repository and unknown environment keys are ignored without filesystem/listen/signal side effects

#### Scenario: 同一真实装配贯穿租户与审计
- **WHEN** an owner creates a workspace through the production createApp and lists/tree-reads it, another owner requests the same workspace with a traversal path, then its real owner attempts traversal
- **THEN** the created root is under the injected runtime.sandboxRoot; foreign access returns404 without adding a denial event, owner traversal returns403 only after canonical sandbox.reject audit is committed on the same DB and visible via /api/audit; unauthorized calls return401 before parser effects

#### Scenario: 既有消费者原子切换
- **WHEN** all createApp callers and HTTP contract fixtures use the completed composition
- **THEN** production modules are registered exactly once; test-only stand-ins no longer occupy their paths, no registration bypass is added, real parser/cache/foreign404/native500 coverage is preserved, and app.close leaves caller DB usable

#### Scenario: 会话与工作空间共用同一 store
- **WHEN** an owner creates workspace W through the production createApp, creates a session bound to W and prompts it with the real fake reporting `cwd=`
- **THEN** the reported cwd equals the root W's `GET /api/workspaces` entry resolves to under the injected runtime.sandboxRoot; the startup record still lists the seven modules in the same order and no additional workspace store or directory is created at registration
