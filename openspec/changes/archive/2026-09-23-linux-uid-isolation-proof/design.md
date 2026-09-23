## Context

Change surface: 一个 `server/test/linux/uid-isolation.test.ts`，产品代码/CI/配置不变。
Must preserve: canonical OmpProcess PATH 策略、sudo argv/env、SessionRuntime native lifecycle、#121 probe 协议、2770 helper 与既有测试。
Governing invariant: 只有真实不同 uid 的 child、实际拒绝读取 parent proc、父密钥不下传且共享写入可回读，才能使 opt-in Linux 测试通过；未执行只能记 skipped。
Sibling surfaces: SessionRuntime → OmpProcess → sudo/PAM → fake-omp；父 env/fixture ancestors/group → 子写入 → workspaces listOneLevel；异常退出/shutdown/测试清理。

## Goals / Non-Goals

Goals: 验证 uid、白名单 subset、四键缺席、HOME/agent、EACCES、wrote、父 tree 列举，保持可信负向 oracle。
Non-goals: 新 CI job/sudoers 仓内脚本、真实 omp/model upstream、HTTP smoke、src 修复、downgrade 删除或 PAM 键闭集枚举。

## Decisions

- `describe.skipIf(process.platform !== "linux" || process.env.WORKBUDDY_UID_TEST !== "1")`；精确 opt-in 匹配规范，避免 `0`/empty 意外执行。目录、env 修改、getuid 前置验证均在测试体，不在模块顶层。选中后缺 OMP_USER 必须失败。
- 复用 `SessionRuntime`、真实 `TokenRegistry`、`collectPrompt` 与 `server/test/support/fake-omp.mjs` 默认 probe；不注入 spawnImpl/clock，不 mock RPC/uid/proc/fs。已有 fake 文件 git mode100755，可作为固定 sudoers 绝对路径，不新建 launcher/env配置。
- fake shebang 使用 `/usr/bin/env node`：harness 必须确保 sudo secure_path 可发现适用 Node；Main 容器将 Node24 放 `/usr/local/bin`。不通过改 PATH 值断言或改 fixture shebang 回避。
- 自有临时根置于可遍历 tmp base，并显式设2770以继承当前共享组；所有路径在该根下，使用带空格/冒号的名字证明标签解析。不得 chmod/chown 用户既有目录、改全局 umask 或用0777绕过权限。后续目录由 production helper 创建。
- 在父测试进程预置 MODEL_UPSTREAM_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、WORKBUDDY_CANARY_SECRET 的非敏感 sentinel；同时显式设置 LANG/TMPDIR，让白名单期望可重复，结束精确恢复 env。
- 真实 env oracle 是 `{PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN}` ⊆ child keys，四 sentinel 键全部不出现；额外 sudo/PAM 键允许。不得断言闭集或 PATH 值；该 Stage4.5 修订形状由本测试实跑，不降低安全性质。
- prompt 为 `probe:<process.pid>:<sandboxRoot>/u1/<probe filename>`；按 `uid=... env=... home=... agent=... environ=... wrote=...` 标签解析，不能按空白切分。要求格式合法，避免 undefined/NaN 让“不等于 uid”假绿。
- HOME 必须等于 `join(stateDir,"home")`，agent 等于 `join(stateDir,"agent")`；不以 caller 的 host HOME 当期望。文件由 omp 写入后父进程调用 canonical workspaces `listOneLevel` 验证 file/name/内容对应的大小，可读内容 `probe`。
- 使用真实 clock，正常 drain 至 terminal 后 finally `await runtime.shutdown()`；不先 SIGKILL sudo（会跳过转发/遗留孙进程），不吞 cleanup 失败。随后清自有目录/恢复 env；Main 在容器仍存活时检查 omp-owned 进程为0，不拿容器退出强制回收冒充 runtime 清理。
- per-test timeout 用仓内 real-child 15s/30s 先例的有限预算，不改全局阈值。无任意sleep/retry。

## Required evidence / risks

Main-owned Ubuntu24.04 Linux/aarch64 容器，固定镜像digest及Node24.13.1，非root runner与omp两个uid、共同workbuddy组、sg workbuddy、native sudo SETENV/no-password、HOME preflight；无privileged/no-new-privileges绕过，无CAP_SYS_PTRACE赋权。宿主用户/组/文件只读或复制，不做宿主sudo。
Linux GREEN 必须非 skipped；默认 Linux 未 opt-in 与 macOS opt-in/未 opt-in 均 skipped。普通 GitHub unit job 无 opt-in，所以只证明发现/跳过兼容；GitHub-specific sudo/PAM/runner验证仍归 #132。
故障注入在 disposable 源码副本：direct/same-uid，泄漏父sentinel，错误HOME/agent，拒绝写入或假成功报告/缺文件等失败类必须被真实测试拒绝；保留原日志，恢复后再GREEN，不以setup/import错误作semantic RED。
Seams under test: 真实 SessionRuntime/procfs/filesystem/listOneLevel；没有HTTP/authstore替身，也不重复#120 argv形状测试。
Review focus: 非真空 skip gate、open-set oracle、路径/共享组、进程与环境清理、证据环境及负向判别准确性。

## Migration Plan

测试自动discovery，无迁移；rollback为revert单文件。只归档本child Linux证明要求，保留父S0b/S1a与#132job/#134控制面未完成状态。原probe要求引用而非再次定义。
Open Questions: None；CI正式集成依赖及容器/runner差异显式保留，不声称提前满足#132。
