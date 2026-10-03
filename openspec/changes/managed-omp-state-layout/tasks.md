# Tasks: managed-omp-state-layout（#706 第二刀 2a）

Fixture level: expanded
Risk packs: filesystem-permissions, process-spawn-contract, uid-isolation, ci-harness, upgrade-compat

归档次序（前提）：本 change 先归档进主规格。父 change `s1c-session-metadata-presentation` 对 omp-runtime、omp-test-harness、model-proxy、http-service-skeleton、chat-sessions 的 delta 仍是旧文，归档前按 #754 从主规格现文重新生成；sandbox-core 与 omp-uid-isolation 父 change 无 delta。2b（`session-delete-trash`）与 #708 的 fixture 在本 change 归档后再从主规格生成。

## 1. 实现
- [ ] 1.1 `server/src/core/sandbox/dirs.ts`：新增 `ensureOwnedDir(absPath, mode)`（sandbox-core「托管目录权限位」）。`ensureSharedDir` 不动。
- [ ] 1.2 `server/src/sessions/omp/state-layout.ts`（新）：`ompHome`、`ompAgentDir`、`ompXdgHome`、`ompSessionDir`、`ensureOmpStateLayout`（omp-runtime「OMP_STATE_DIR 托管布局」的表，父先于子；`<state>` 缺失的父级 `mkdir` 递归、不 chmod）。
- [ ] 1.3 `server/src/sessions/omp/process.ts`：路径函数改从 1.2 取（可 re-export）；`spawnOmp` 调 `ensureOmpStateLayout` + `ensureOwnedDir(sessionDir, 0o2770)`，所有者根仍 `ensureSharedDir`；env 去 `PI_CODING_AGENT_DIR`、加三个 `XDG_*_HOME`；sudo `--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,WORKBUDDY_MODEL_TOKEN`。argv 不变。
- [ ] 1.4 `server/src/server.ts`：写 `models.yml` 前调 `ensureOmpStateLayout(config.ompStateDir)`，目标目录用 `ompAgentDir(config.ompStateDir)`；失败走既有 partial-start failure 路径。`server/src/model-proxy/models-yml.ts`：去掉 `ensureSharedDir(agentDir)`。
- [ ] 1.5 注释/文档字符串里 `PI_CODING_AGENT_DIR`、`<state>/agent`、「group-writable by the omp uid」的陈述同步（`sessions/index.ts`、`slash-commands.ts`、`session-delete.ts` 文件头等）；`session-delete.ts` 的行为不改（2b）。
- [ ] 1.6 假 omp：`server/test/support/fake-omp.mjs`（probe 回报三个 `xdg*=`；`rename:<path>` 探针）、`fake-omp-proxy.mjs`（`$HOME/.omp/agent/models.yml`）。
- [ ] 1.7 `.github/scripts/ci-uid-isolation.sh` `check_omp_modes` 加两条断言；`scripts/test-ci-harness.sh` 的 `contract()`、变异与行为桩同步（桩需造出 `xdg/data/omp/agent.db`）。
- [ ] 1.8 测试（见「必需证据」）。

允许改动的文件：上列源码与脚本；`server/test/**`（含 `support/`、`linux/uid-isolation.test.ts`、helpers）；`smoke/**` 与 `web/e2e/**` 仅当它们引用了旧路径（当前 grep 无引用）。不得改：`openspec/**`、`docs/**`（编排者负责）、`.github/workflows/ci.yml`、sudoers 规则生成、`Makefile`。

## 2. Must preserve
- argv 精确不变（含顺序、`--resume` 规则）；sudo 前缀形态除 `--preserve-env` 列表外不变；`TMPDIR=` 赋值元素规则不变；`shell:false`、stdio、cwd 规则不变。
- env 仍是闭集；父进程 env 不被修改；上游密钥不进入子进程。
- `SANDBOX_ROOT` 一侧：`ensureSharedDir` 语义、工作空间目录 `2770`、绑定空间根不被创建。
- `models.yml` 内容字节不变、`0640`、临时文件 + rename、失败不留临时文件（第一刀）。
- `listSkills` 的全部第一刀约束（256 上限、kernel realpath、Buffer 路径、`O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`）。
- 启动记录 `server_started` 的时序与内容；启动失败仍只有 generic 记录。
- 会话删除（#758）的现有行为与测试；`sessions/<ownerId>` 仍 `2770`，app 能删 omp 写的文件与目录。
- `#760`：omp uid 写出的文件/目录无 other 位、保留组写位。
- 不 chown、不改进程 umask。

## 3. 必需证据
- E1 单元 `ensureOwnedDir`：新建/校正/幂等（第三次无 chmod）；普通文件、符号链接（目标 mode 不变）、父缺失、root 持有的目录（非 root 时）均抛错且 message 含路径。
- E2 单元布局：冷布局每个目录的 `mode & 0o7777` 精确值与 uid；被改宽后回正；`home/.omp` 为符号链接 / `xdg` 为文件 / `sessions/u1` 为符号链接时抛错、不 spawn、目标不变；遗留 `<state>/agent` 不被读写。
- E3 spawn 契约：子进程实际 env 键集精确（假 omp probe，含三个 XDG 值与 HOME 值）、无 `PI_CODING_AGENT_DIR`；argv 精确；sudo 前缀精确（`session-supervisor-helpers` 的 `sudoPrefix` 与 `omp-process.test.ts`）。
- E4 启动：编译入口冷启动后 `models.yml` 位于 `<state>/home/.omp/agent/`，布局 mode 精确；`<state>/home/.omp` 被文件占位时入口 exit 1、只有 generic 失败记录、无 listener/子进程残留。
- E5 命令目录：`createApp` 下装在 `<state>/home/.omp/agent/skills` 的 skill 出现在 `GET /api/commands`；装在旧 `<state>/agent/skills` 的不出现。
- E6 假 omp：`rename:` 探针两种结果；`fake-omp-proxy` 在 `HOME` 缺席或 `models.yml` 缺失时按配置缺失失败。
- E7 Linux 两 uid（Docker 或 CI；本机无 Linux 时用本机 Docker 的 `ubuntu:24.04` 按 `ci-uid-isolation.sh` 的装配跑 `server/test/linux/uid-isolation.test.ts`）：托管布局用例全绿，既有三个用例全绿。
- E8 真实 omp（官方 v18.0.10，同 uid）：`ci-compiled-server.sh smoke` 全绿；结束后 `<state>/xdg/data/omp/agent.db` 存在。
- E9 旧会话续接（真实 omp + 假上游，同 uid）：基线构建在状态目录 X 建会话并完成一回合 → 停 → 本 change 构建、同一 X → 对该会话再发一回合 → done；X 下旧 `agent/` 未被改动。
- E10 gates：`make lint`、`make typecheck`、`make anti-drift`（jscpd ≤ 179）、`bash scripts/size-guard.sh`、`npm test --workspace server`、`make test-guardrails`、`openspec validate managed-omp-state-layout --strict --no-interactive`。

## 4. 负向对照（临时变异，跑完还原，sha256 前后一致）
- N1 布局表把 `home/.omp/agent` 改回 `0o2770` → E2 的 mode 断言失败；Linux 用例里该目录下新建文件的 `EACCES` 断言失败。
- N2 `home` 去掉粘滞位（`0o2770`）→ E2 失败；Linux 用例 `rename:<state>/home/.omp` 的 `EPERM` 断言失败。
- N3 `ensureOwnedDir` 用 `stat` 代替 `lstat` → 符号链接用例失败。
- N4 `ensureOwnedDir` 去掉 uid 检查 → root 持有目录用例失败（或 Linux 用例里 omp 预建目录被沿用）。
- N5 spawn env 留着 `PI_CODING_AGENT_DIR` → E3 键集断言失败。
- N6 不预建 `xdg/data/omp` → E8 的 `agent.db` 位置断言失败（真实 omp 回落到 `~/.omp/agent`）。
- N7 `--preserve-env` 漏掉 `XDG_STATE_HOME` → 前缀精确断言失败。
- N8 `check_omp_modes` 去掉新断言 → `make test-guardrails` 的合同变异失败。
- N9 `server.ts` 仍写 `join(stateDir,"agent")` → E4 失败。
