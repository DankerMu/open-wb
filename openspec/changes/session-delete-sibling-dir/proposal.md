# Proposal: session-delete-sibling-dir（#758）

## Why
omp 为每个会话在 `<ts>_<uuid>.jsonl` 旁边另建同名目录 `<ts>_<uuid>/`，存放工具完整输出等由会话内容派生的产物（实测：一次 60001 行的 bash 输出写成 `1.bash.log`，会话正文以 `artifact://1` 引用）。`DELETE /api/sessions/:id` 只 unlink `.jsonl`，该目录永久残留：删除语义不完整，且随会话数无界累积。fake-omp 不建该目录，现有测试看不到。

## What Changes
- `server/src/sessions/session-delete.ts`：`.jsonl` 处理之后，在同一校验过的 owner 会话目录下递归移除同名目录（`lstat` 必须是目录，不跟随符号链接；失败走错误通道，响应仍 204）。
- fake-omp：创建会话 `.jsonl` 时同时建同名目录（一个文件 + 一层嵌套子目录）。
- 测试：`session-delete.test.ts`、`session-delete-running.test.ts`、fake-omp harness 测试、`server/test/linux/uid-isolation.test.ts`。
- 规格：session-metadata MODIFIED「会话删除」；omp-test-harness MODIFIED「假 omp 进程契约」。

## 开放问题的结论（真 omp v18.0.10 + 真实模型端点，2026-10-03）
fork 会话不依赖源会话的同名目录：fork 出的新 `.jsonl` 不带同名目录（omp 不复制产物），文件头只以 `parentSession` 记录源 `.jsonl` 路径；在 fork 会话里读取 `artifact://1` 得到 `No artifacts directory found`——此时源目录仍在。omp 只在会话自己的同名目录里解析产物，所以删除源目录不改变 fork 会话的可见行为。方案按 issue 推荐实施，无需「仅在无存活 fork 时删除」或复制。

## 与 #760 的关系
omp 建的同名目录及其内容的 mode 取决于 omp 的 umask：`0002`/`0007` 下组可写，app uid 可递归删除；`0022` 变体（#760 记录的主组配置）下删除以 EACCES 失败、走错误通道、仍 204。#760 把 umask 固定为 `0007`。

## Non-goals
- regenerate/fork 遗留的旧分支 `.jsonl` 及其同名目录（规格已明确不在清理范围）。
- fork/regenerate 之后旧产物引用在 omp 里失效（omp 行为，本应用不补）。
- `sessions/<ownerId>` 组可写带来的 rename-swap **竞态**残余。unlink 一侧是校验到 `unlink` 之间的单次窗口，收益是一个普通文件。**rm 一侧更大（评审第 2 轮，探针实测）**：Node 的递归 `rm` 按路径逐项操作，窗口覆盖整个递归过程——产物目录归 omp 所有，塞多少文件窗口就多长；期间把 `sessions/<ownerId>` rename 走并换成符号链接，其后的删除全部落到 `<链接目标>/<name>/`（2 万文件的布置下换链后目标树被删光且无任何报错）。收益是 app uid 可写的任意同名目录树。本函数内没有廉价缓解（任何基于路径的遍历性质相同）；由 #706 第二刀关闭：`sessions/` 归 app 所有且对 omp 不可写（`<ownerId>` 一级换不掉），同名目录先原子 rename 进 omp 不可达的 app 私有目录再删除。在那之前这是已登记的残留，前提同 ADR-0011 的 #739 补充（受信局域网、账号均为内部成员）。`session-delete.ts` 函数头注释对该残留的描述（「校验与 rm 之间」）偏窄，随第二刀重写该函数时改正。

评审第 1 轮更正：原文把「`sessions` 或 `sessions/<ownerId>` 被换成符号链接」整体归为竞态残余，不成立——静态的符号链接不需要竞态：`realpath(dirname(path))` 与 `realpath(sessionDir)` 都经过该链接、恒等。master 上它让 app uid unlink 链接目标目录里的一个普通文件；本 change 的递归删除会把它放大成删一棵目录树。因此本 change 加一条校验（会话目录的 realpath 必须恰为 `<state realpath>/sessions/<ownerId>`），静态形态对 unlink 与 rm 一并关闭；剩下的才是真正的竞态窗口，由 #706 第二刀收紧 `sessions/` 的归属后进一步缩小。
