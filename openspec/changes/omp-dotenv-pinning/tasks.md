# Tasks: omp-dotenv-pinning（#802）

Fixture level: compact
Risk packs: process-spawn-contract, filesystem-permissions, uid-isolation

## 1. 实现
- [ ] 1.1 `server/src/core/sandbox/dirs.ts`：`ensureOwnedFile(absPath, mode)`。
- [ ] 1.2 `server/src/sessions/omp/state-layout.ts`：布局含 `home/.env`（`0o640`）；冷建时在 `home` 放宽到 `3770` 之前建出；已存在的 `home` 照常校正。
- [ ] 1.3 `server/src/sessions/omp/process.ts`：env 加 `PI_CODING_AGENT_DIR: ompAgentDir(opts.stateDir)`、`PI_CONFIG_FILES: ompHostOverlayPath(opts.stateDir)`；`--preserve-env` 列表按规格顺序。注释同步。
- [ ] 1.4 测试：`server/test/sandbox-dirs.test.ts`、`omp-state-layout.test.ts`、`omp-layout-helpers.ts`、`omp-process.test.ts`（793 行，上限 800：新增用例放到别的文件）、`session-supervisor-helpers.ts`（`sudoPrefix`）、`server-assembly.test.ts`、`omp-spawn-cwd.test.ts`、`fake-omp*.test.ts` 与 `commands-rest.test.ts` 中对 env 键集的断言、`server-startup-*.test.ts`（`home` 目录内容断言）、`linux/uid-isolation.test.ts`（`REQUIRED_CHILD_ENV_KEYS`、两条新探针）。

允许改动的文件：上列源码与 `server/test/**`。不得改 `openspec/**`、`docs/**`、`.github/**`、`scripts/**`、`smoke/**`、假 omp 的 `.mjs`。

## 2. Must preserve
- argv 不变；env 仍是闭集；`HOME`、三个 `XDG_*_HOME`、token 的取值不变。
- `PI_CODING_AGENT_DIR` 的值必须与 `join(HOME 的值, ".omp", "agent")` 字符串相等（否则真实 omp 关闭 XDG 重定向、往只读的 agent 目录写 `agent.db` 而冷启动失败）。
- #706 布局其余各行、冷建顺序、`ensureOwnedDir` 语义；overlay 写入；会话删除。

## 3. 必需证据
- E1 `ensureOwnedFile` 单元：规格两个场景（含 umask `000` 下 `open` 之后、`chmod` 之前不宽于 `0640`）。
- E2 布局：冷建后 `home/.env` 为空、`0640`、属本进程；冷建时它被创建的瞬间 `home` 的 `mode & 0o077 == 0`；已有内容与宽 mode → 内容不变、mode 回正；符号链接 / 目录 → 抛错、不 spawn。
- E3 spawn：env 键集精确（含两个新键）、`PI_CODING_AGENT_DIR === join(env.HOME, ".omp", "agent")`、`PI_CONFIG_FILES === ompHostOverlayPath`；sudo 前缀精确。
- E4 真实 omp v18.0.10 + 编译后的服务 + 假上游（同 uid；可改编 `708/impl/e4/stack.py`，复制到 $D 下）：规格「两个变量不可被 dotenv 改写」的正向与两个负向对照（负向用临时变异 + 重建 dist）。
- E5 `ci-compiled-server.sh smoke`（真实 omp）全绿，结束后 `xdg/data/omp/agent.db` 存在、`home/.omp/agent` 下无 `agent.db`。
- E6 Linux 两 uid（本机 Docker，参照 `708/impl` 里的 docker 脚本）：`uid-isolation.test.ts` 全绿，含 `.env` 的覆写 `EACCES` 与改名 `EPERM`。
- E7 gates：`make lint`、`make typecheck`、`make anti-drift`（≤179）、`bash scripts/size-guard.sh`、`npm test --workspace server`、`openspec validate omp-dotenv-pinning --strict --no-interactive`。

## 4. 负向对照
- N1 env 去掉 `PI_CODING_AGENT_DIR` → E3 失败；E4 中 `agent.db` 出现在 `<cwd>/evil`。
- N2 env 去掉 `PI_CONFIG_FILES` → E3 失败；E4 spawn 失败。
- N3 `PI_CODING_AGENT_DIR` 取 `<state>/agent`（不等于默认）→ E3 相等断言失败；E5 冷启动失败或 `agent.db` 不在 xdg。
- N4 布局去掉 `home/.env` → E2 失败；Linux 探针 `wrote=ok`。
- N5 `ensureOwnedFile` 用 `stat` 代替 `lstat` / 去掉 `O_NOFOLLOW` → 符号链接用例失败。
- N6 `--preserve-env` 漏掉 `PI_CONFIG_FILES` → 前缀断言失败。
