# Proposal: session-delete-trash（#706 第二刀 2b）

## Why
#758 的评审留下一个竞态：会话删除对同名产物目录做按路径的递归 `rm`，而它所在的 `sessions/<ownerId>` 对 omp uid 可写——omp uid 在递归进行期间把产物目录或其下一级换成符号链接，后续删除就落到链接目标之下。2a 之后 `sessions` 与 `<ownerId>` 两级不能再被替换，但 `<ownerId>` 之内仍然可以。

## What Changes
- 托管布局新增 `<state>/trash`（`0700`，app 私有）。
- `removeArtifactDir`：`lstat` 为目录 → `rename` 进 `trash/<随机名>` → 在 trash 里再 `lstat` → 目录则递归删、否则 `unlink` 并报告。递归只发生在 omp uid 按路径到不了的目录里。
- **关闭的是按路径的替换，不是全部**：删除前就把 cwd 或目录 fd 留在该产物目录树内的 omp uid 进程，仍能经相对路径在递归期间替换子目录（Node 没有 `*at` 系调用；改用 `/bin/rm` 才是 fd 级安全，但引入对宿主 `rm` 实现的依赖——busybox 的 `rm` 同样按路径——不取）。作为残余登记。
- 顺带收掉 2a 评审的两条 P3：冷建时 `home` 在 `.omp`/`agent` 就位之前不对组开放；`ensureOwnedDir` 新建目录直接带目标权限位。`omp-state-layout.test.ts` 的 `home/.omp` 符号链接分支补「不 spawn」断言。
- 规格：omp-runtime MODIFIED「OMP_STATE_DIR 托管布局」；session-metadata MODIFIED「会话删除」。`session-delete.ts` 函数头注释同步（残余一段改为现状）。

## 行为变化
- `lstat` 与 `rename` 之间被换成非目录的同名项会被 `unlink`（此前是「不是目录则不动」；预检时就不是目录的仍然不动、只报告）。
- 递归删除部分失败时，残余在 `<state>/trash` 而不在会话目录里。

## Non-goals
- 不自动清理 trash；不改 `.jsonl` 的 unlink 路径（单个 `unlink` 不跟随符号链接，被换成别的东西最多删掉 omp 自己放的那一项）。
- CI 脚本诊断输出的改进（2a 评审 P3）不做。
