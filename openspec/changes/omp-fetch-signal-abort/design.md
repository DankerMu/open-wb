# Design: omp-fetch-signal-abort

Change surface：`scripts/omp-fetch.sh`（trap 与回退条件）、`scripts/test-omp-fetch.sh`（新用例）。

Must preserve：
- 「二进制供给」与「二进制供给的下载回退」的全部既有行为。具体是：
  - 主地址成功时只调一次 curl。
  - 主地址失败时（curl 退出码小于 128，例如 22、28、56）经 `assets/<id>` 回退，带 `Accept: application/octet-stream`，不带凭证。
  - 摘要不符、两条路径都失败时退出码非零，不留文件。
  - 已存在且校验通过时打印 `omp-fetch: skip download`。
  - 已存在但校验不过时删除文件并非零退出。
  - 不支持的平台打印平台矩阵。
- `scripts/test-omp-fetch.sh` 既有八条用例一字不改，全部保持绿色。
- CI 文件零改动：`git diff --stat origin/master -- .github scripts/test-ci-harness.sh scripts/inspect-ci-workflow.js scripts/fixtures Makefile deploy` 为空。
- 成功路径末尾的 `trap - …` 解除照旧，安装完成后不再触发清理。

Must add/change：
- D1 trap 拆分：
  - 写法为 `trap cleanup EXIT`，另加 `trap 'exit 130' INT`、`trap 'exit 129' HUP`、`trap 'exit 143' TERM`。`cleanup` 保持只做 `rm -f "$tmp"`。
  - 信号 trap 里的 `exit` 会触发 EXIT trap，所以临时文件只在一处清理。
  - bash 会等前台子进程 curl 结束后才执行信号 trap。信号送达整个进程组时（Ctrl-C、CI 取消），curl 与脚本同时收到信号：curl 先结束，trap 随即让脚本退出，不会再执行 `if` 的回退分支。
  - 成功路径末尾的解除改为 `trap - EXIT INT HUP TERM`，范围与现在相同。
- D2 回退条件：
  - 主地址 curl 的退出码先存下来：先写 `rc=0`（`set -u` 下不初始化，成功路径会报 unbound），再写 `curl … || rc=$?`；`set -e` 下这种写法不会触发退出。
  - `rc` 为 0 时继续往下走；`0 < rc < 128` 时照旧回退；`rc >= 128` 时 stderr 打一行 `omp-fetch: primary download interrupted (curl exit ${rc}); not falling back`，然后 `exit "$rc"`，由 EXIT trap 清临时文件。
  - D2 覆盖信号只送到 curl、没送到脚本的情况，例如 `kill -INT <curl pid>`。
  - 回退路径上的第二次 curl 不需要改：它被信号杀掉时退出码非零，`set -e` 会让脚本直接退出。
- D3 不引入新的环境变量旁路，也不改 SHA256、资产 id、URL 与 curl 参数。

Governing invariant：
- 信号中断后，脚本恒以非零退出，curl 恰被调用一次，不进入回退，不留 `var/omp/omp` 与 `var/omp/.omp-fetch.*`。
- 落到 `var/omp/omp` 的文件恒为 SHA256 与固定表一致的 v18.12.3 官方资产。

Sibling surfaces：
- Makefile `omp-fetch` 目标，只调脚本，不改。
- `deploy/app/Dockerfile:10`，调同一脚本。
- CI 三个 job，同上。
- 仓库里没有其它「trap 后接回退」结构的脚本：`git grep -n 'trap ' -- scripts .github/scripts deploy` 逐个核对，结论写进 PR。`.github/scripts/ci-browser-image.sh:33` 的 `trap cleanup EXIT` 后面没有回退结构，不改。

Seams under test：沿用 D4 的 seam，即脚本副本、PATH 前置的假 `curl` 与假 `uname`。
- 假 curl 增加两类模式：一类按给定退出码退出，用来模拟 130 和 143；另一类写一个就绪标记文件后阻塞（有上限的 `sleep 30`），用于真实信号用例。
- 真实信号用例须在独立进程组里起脚本，让信号送达整个组，与 Ctrl-C、CI 取消的投递方式一致。写法固定为：`set -m; ( cd "$c" && exec env … bash ./omp-fetch.sh >out 2>err ) & pgid=$!; set +m`。
  - `set -m` 必需：不开作业控制时，非交互 bash 起的后台作业继承 SIGINT 忽略，脚本对入口已忽略的信号设不了 trap，用例只会挂到超时。
  - `exec` 必需：不 exec 时，子 shell 作为组长收到 TERM 会先退出，这时脚本还在 EXIT trap 里，测试看到的是残留文件和存活进程。
  - macOS bash 3.2 没有 `setsid`，用的就是这套写法。
- 测试代码只等待就绪标记出现，不用 `sleep` 碰运气。等待分两段，各有上限（例如 10 s）：先等就绪标记，然后 `kill -<SIG> -- -"$pgid"`，再轮询 `kill -0 -- -"$pgid"`，直到整组进程消失。超时判 FAIL，并 `kill -KILL -- -"$pgid"`。最后 `wait "$pgid"` 取退出码。
- 假 curl 的阻塞用有上限的 `sleep 30`，泄漏时也会自己结束。
- 真实信号用例开头先跑探针 `bash -c 'trap "exit 7" INT; kill -INT $$; exit 0'`：返回 7 才说明 INT 能 trap；否则打一行诊断（测试进程入口已忽略 INT），判 FAIL。不用 `trap -p INT` 当探针，bash 3.2 下它对入口已忽略的信号输出为空。
- 真实信号用例不断言 `interrupted` 行，也不断言 stderr 为空：bash 在 `|| rc=$?` 之前就执行了 trap，所以这行不会出现；TERM 下 bash 还会往 stderr 打 `Terminated`。

Required evidence（全部写在 `scripts/test-omp-fetch.sh` 里，不发真实网络请求）：
- 假 curl 对主地址返回 130：退出码非零（等于 130），curl 只被调用一次，stderr 没有回退行，有 `interrupted` 行，`no_leftovers` 成立。
- 同样的断言对 143 再测一次。
- 真实信号送达脚本进程组，主地址 curl 阻塞期间，INT、TERM 各跑一次：脚本在上限内退出，退出码分别等于 130、143，curl 只被调用一次，没有回退行，`no_leftovers` 成立，测试结束后整组进程都不在（`kill -0 -- -"$pgid"` 失败）。
- 脚本自身收到信号、curl 未被信号终止（假 curl 吞掉信号后以 0 退出）：分别送 INT、HUP 到进程组，脚本退出码分别等于 130、129，curl 只被调用一次，不进入后续校验与安装，`no_leftovers` 成立，整组进程都不在。这一条区分 D1 与 D2：只有 D2、trap 仍共用 `cleanup` 时，脚本会接着跑校验，并以 1 退出。
- 既有八条用例原样全绿，其中包括退出码 22 的回退。
- 先红：在未改的脚本上，新用例都失败。
- `make test-guardrails`、`make anti-drift`、`make lint` 退出 0。
- 本机已有 `var/omp/omp` 时，`make omp-fetch` 仍打印 `omp-fetch: skip download`。

Non-goals：CI 缓存（#1932）、下载超时与重试参数、SHA256 校验逻辑、任何 CI 文件。

Review focus：
- 信号 trap 的退出码，以及 EXIT 只清理一次。
- `rc >= 128` 的判定不会把普通 curl 错误误判为中断（curl 自己的错误码都小于 100）。
- 真实信号用例确定、有上限、不留进程，在 Linux（CI `guardrails` job）和 macOS 上都能跑。
- 没有测试旁路进入生产脚本。
