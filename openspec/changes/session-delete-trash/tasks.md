# Tasks: session-delete-trash（#706 第二刀 2b）

Fixture level: compact
Risk packs: filesystem-race, filesystem-permissions

归档次序（前提）：本 change 在 `managed-omp-state-layout` 归档之后从主规格生成并先于父 change 归档；父 change `s1c-session-metadata-presentation` 对 omp-runtime 与 session-metadata 的 delta 按 #754 重新生成。

## 1. 实现
- [ ] 1.1 `server/src/sessions/omp/state-layout.ts`：`ompTrashDir(stateDir)`；布局加 `trash` `0o700`；`home` 冷建顺序（缺失时先以 `0o700` 建出，`.omp`、`agent` 之后再 `ensureOwnedDir(home, 0o3770)`；已存在的 `home` 不先收窄——运行中的 omp 进程在用它）。
- [ ] 1.2 `server/src/core/sandbox/dirs.ts`：`ensureOwnedDir` 的 `mkdir` 带 `mode & 0o777`（随后的校正照旧）。
- [ ] 1.3 `server/src/sessions/session-delete.ts`：`removeArtifactDir` 改为 lstat → rename 进 trash（名字 `randomBytes(16).toString("hex")`，trash 根取自已算出的 state realpath）→ trash 内 lstat → `rm` 或 `unlink`+报告；函数头注释同步。为「rename 之前被替换」场景提供最小的可注入点（沿用该模块现有的注入方式；没有则以参数默认值注入 `rename`），不得为测试改变生产路径的语义。
- [ ] 1.4 测试：`server/test/session-delete-sibling.test.ts`（或同目录新文件）、`server/test/omp-state-layout.test.ts`、`server/test/omp-layout-helpers.ts`（布局表）、`server/test/sandbox-dirs.test.ts`、`server/test/linux/uid-isolation.test.ts`（见 E4），`server/test/session-delete-helpers.ts`（`ownerSessionDir` 一并建出 `<state>/trash` `0700`，使不经 spawn 的用例也有真实布局）、`server/test/server-startup-layout.test.ts` 与 `server/test/server-startup-order.test.ts`（启动后状态根内容变为 `["home","sessions","trash","xdg"]`）。

允许改动的文件：上列。不得改 `openspec/**`、`docs/**`、`.github/**`、`scripts/**`、假 omp（`fake-omp.mjs` 已 799 行）。

## 2. Must preserve
- #758 的既有行为与用例（a–l）：路径校验、只 unlink 普通文件、名字为空/`.`/`..` 报告不动、预检不是目录的同名项不动只报告、`ENOENT` 为成功、204 不变、错误只经服务错误通道。唯一按本 change 改写的是用例 (e)（含不可清空子目录的部分失败）：新预期为会话目录里已无该产物目录、残余在 `<state>/trash/<随机名>`、报告一次；其 `finally` 须 `readdir` trash 找到残余并 `chmod` 后再清理。
- 2a 的布局表其余各行、`ensureOwnedDir` 的拒绝语义、spawn env/argv。
- regenerate/fork 的旧分支文件不在清理范围。

## 3. 必需证据
- E1 `session-delete` 新场景：经 trash 移除后 trash 为空且外部文件不变；rename 前替换为符号链接 → 只 unlink 链接、目标树不变、报告一次；trash 为文件、trash 缺失 → 产物目录原样、各报告一次；源已不在（`ENOENT` 且复查不存在）→ 无报告；改写后的 (e)。
- E2 布局：`trash` 为 `0700` 且属 app uid；冷建时 `.omp` 创建瞬间 `home` 无组/other 位（spy `mkdirSync` 或等价观测）；已存在的 `3770` `home` 在重复调用中不被收窄（无 chmod）。
- E3 `ensureOwnedDir` 新建目录的 `mkdir` 带目标权限位（umask `000` 下新建 `0o2750` 目录，`mkdir` 返回后、`chmod` 之前不宽于 `0750`）。
- E4 Linux 两 uid（本机 Docker，按 2a 的装配，脚本可参照 `706b/docker-setup.sh`、`docker-uid-test.sh`）：既有删除用例（`.jsonl` 与非空产物目录确由 omp uid 在 umask 007 下建出——断言其 uid 不是 app uid）仍通过且 trash 为空；托管布局用例加一条 `probe:<state>/trash/x` → `wrote=EACCES`。
- E5 真实 omp v18.0.10 同 uid：`ci-compiled-server.sh smoke` 全绿（`session-meta.hurl` 含删除）。
- E6 gates：`make lint`、`make typecheck`、`make anti-drift`（≤179）、`bash scripts/size-guard.sh`、`npm test --workspace server`、`openspec validate session-delete-trash --strict --no-interactive`。

## 4. 负向对照
- N1 去掉 rename、原地 `rm` → 「rename 前替换」场景失败（目标树被删或 trash 断言失败）。
- N2 trash 内不再 `lstat`、直接 `rm recursive` → 同一场景仍应不动目标树（`rm` 不跟随链接）但「只 unlink 并报告一次」的报告断言失败。
- N3 去掉 `ENOENT` 后对原位置的复查 → 「trash 缺失」场景的报告断言失败。布局表去掉 `trash` → E2 失败。
- N4 `trash` 改 `0o2770` → E2 失败；Linux `probe:<state>/trash/x` 断言失败。
- N5 `home` 一开始就 `0o3770` → E2 冷建观测失败。
