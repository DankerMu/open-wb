# Tasks: omp-host-overlay（#708 + #772）

Fixture level: expanded
Risk packs: process-spawn-contract, approval-bypass, filesystem-permissions

归档次序（前提）：本 change 在 `session-delete-trash` 归档之后从主规格生成并先于父 change 归档；父 change `s1c-session-metadata-presentation` 对 omp-runtime 与 http-service-skeleton 的 delta 按 #754 重新生成；omp-uid-isolation 父 change 无 delta。

## 1. 实现
- [ ] 1.1 `server/src/sessions/omp/state-layout.ts`：`ompHostOverlayPath(stateDir)`。
- [ ] 1.2 overlay 写入：常量内容 + 写入函数（新文件 `server/src/sessions/omp/host-overlay.ts` 或并入现有模块，遵守仓库的模块依赖规则）；`replaceFile` 从 `server/src/model-proxy/models-yml.ts` 提为可复用（位置由依赖规则决定，如 `server/src/core/`），不得出现第二份临时文件 + rename 实现。
- [ ] 1.3 `server/src/server.ts`：布局之后写 `models.yml` 与 overlay；任一失败走既有 partial-start failure 路径；`server_started` 在两者都写完之后。
- [ ] 1.4 `server/src/sessions/omp/process.ts`：argv 在 `--no-title` 之后加 `--config`、`ompHostOverlayPath(opts.stateDir)`；`--resume` 仍在最后。
- [ ] 1.5 测试：精确 argv 的全部既有断言同步（`server/test/fake-omp-helpers.ts`、`omp-process.test.ts`、`omp-spawn-cwd.test.ts`、`server-assembly.test.ts` 及其它 grep 到 `--no-title` 的测试）；overlay 写入的单元/启动测试；`server/test/linux/uid-isolation.test.ts` 加 overlay 覆写探针（测试需自行写出 overlay 文件，与它写 `models.yml` 的方式一致）。

允许改动的文件：上列源码、`server/src/core/**` 中承接 `replaceFile` 的一个文件、`server/test/**`。不得改 `openspec/**`、`docs/**`、`.github/**`、`scripts/**`、`smoke/**`、假 omp 三个 `.mjs`。

## 2. Must preserve
- argv 其余部分与顺序、`--resume` 规则、env 闭集、sudo 前缀。
- `models.yml` 的内容、mode、替换语义与失败路径；启动记录时序。
- #706 的布局与权限位；假 omp 行为。
- 无项目配置时的审批行为（bash/eval/task 提示，读写不提示）。

## 3. 必需证据
- E1 单元：overlay 内容逐字节、`0640`、重复写字节不变、无临时文件残留；目标目录缺失时拒绝；`ompHostOverlayPath` 位于 `ompAgentDir` 下。
- E2 argv：冷启动与 resume 的精确 argv（`--config <path>` 紧随 `--no-title`，`--resume` 在最后）；sudo 模式下 `--` 之后同样。
- E3 启动：编译入口冷启动后 overlay 存在；overlay 路径被目录占位时 exit 1、只有 generic 记录、无 `server_started`。
- E4 真实 omp v18.0.10 + 编译后的服务 + 假上游（同 uid；可改编 `708/probe2/stack.py` 与其场景文件，复制到 $D 下使用）：
  - (a) cwd 预置 `tools.approval.bash: allow` + `bash.patterns` 放行 → 仍有审批请求（`chat_approvals` 行 / approvals API）；
  - (b) cwd 预置会写标记文件的项目 MCP stdio server → 回合完成后无标记文件；
  - (c) 无项目配置 → 审批行为与基线一致；
  - 负向对照：临时变异去掉 `--config`（重建 dist）→ (a) 无审批直接执行、(b) 标记文件出现。
- E5 `ci-compiled-server.sh smoke`（真实 omp，同 uid）全绿。
- E6 Linux 两 uid（本机 Docker，参照 `706b/docker-setup.sh`、`docker-uid-test.sh`）：`uid-isolation.test.ts` 全绿，含 overlay 覆写 → `EACCES`。
- E7 gates：`make lint`、`make typecheck`、`make anti-drift`（≤179）、`bash scripts/size-guard.sh`、`npm test --workspace server`、`openspec validate omp-host-overlay --strict --no-interactive`。

## 4. 负向对照
- N1 去掉 argv 的 `--config` → E2 失败；E4 (a)(b) 的负向结果出现。
- N2 overlay 内容去掉 `tools.approval: []` → E1 字节断言失败；E4 (a) 无审批。
- N3 overlay mode 改 `0600` → E1 失败。
- N4 `--config` 放到 `--resume` 之后 → E2 resume 断言失败。
- N5 `server.ts` 不写 overlay → E3 失败；真实 omp 冒烟失败（omp exit 1）。
