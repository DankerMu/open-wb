## MODIFIED Requirements

### Requirement: 自有状态不对组可读
For non-:memory: DB paths, the entry SHALL ensure the SQLite main file mode is0600 before openDb: create a missing file exclusively with wx and0600, close its descriptor, and repair existing main and existing -wal/-shm files to0600 before SQLite opens. Only absent sidecars SHALL be ignored; other preparation failures SHALL fail startup through existing partial-start cleanup. New WAL/SHM SHALL inherit owner-only main permissions from creation. The process SHALL NOT change umask or force DB-parent0700. SANDBOX_ROOT itself SHALL be created at startup and corrected to exactly 3770 (sandbox-core「沙箱根目录」; with OMP_USER configured a root not owned by the app uid fails startup with reason `sandbox_root`); below it, existing directory modes SHALL remain unchanged and every missing component created by the app SHALL use canonical ensureSharedDir2770. Under OMP_STATE_DIR the app SHALL establish and re-assert the exact modes of omp-runtime「OMP_STATE_DIR 托管布局」 through `ensureOwnedDir`: managed configuration (`<state>`, `home/.omp`, `home/.omp/agent`, `xdg` roots, `sessions`) is not writable by the omp uid, and only `home` (sticky), `xdg/{data,state,cache}/omp` and `sessions/<ownerId>` are. Group ownership SHALL remain deployment-controlled, without application chown. No app configuration, DB or upstream secrets SHALL be written by these paths into shared trees; managed models.yml containing only the WORKBUDDY_MODEL_TOKEN environment variable name remains allowed.

#### Scenario: 冷启动与既有数据库权限
- WHEN real compiled entry starts with absent DB or valid existing main/WAL/SHM initially0644
- THEN all existing files are0600 before SQLite open, live main/WAL/SHM are0600, data is retained and startup publishes normally
- WHEN DB_PATH is :memory:
- THEN no private DB files are created or chmodded

#### Scenario: 权限准备失败关闭
- WHEN main or existing sidecar chmod fails, or private-file creation fails
- THEN entry exits1 with generic failure, no success record/listener/models/child leak, closes owned resources and does not delete existing data

#### Scenario: 共享目录创建与兼容
- WHEN startup publishes managed models and a session subsequently spawns in previously absent shared trees
- THEN newly created sandbox path levels are2770 and every OMP_STATE_DIR directory has exactly its managed-layout mode before use; models contain no upstream key and are written to `<state>/home/.omp/agent/models.yml`
- WHEN sandbox directories below the root already exist, or directory preparation fails
- THEN existing modes below the root are unchanged (the root itself is 3770 after startup), process umask is unchanged, and failed preparation prevents spawn/publication through the existing failure path
