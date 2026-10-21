# Tasks — sidecar-settled-claim (#1601)

Fixture level: expanded. Risk packs: selected — Concurrency / state machine（领取条件加内存记忆；每轮按列表修剪；重启语义不变）、Resource limits（集合大小受 `jobs/` 目录数约束）；not selected — Auth / secrets、File IO / path safety、Schema、Config、Public API、Error handling、Release / packaging（见 proposal Triage）。

Must preserve: 领取次序（`request.json` mtime 升序）与并发上限；所有原因码、吞掉的错误与 fatal 路径；每作业恰一行 convert 日志；`SIGTERM` 不写标记；`request.json` 格式；app 侧 `office.ts` 不改；现有 converter-sidecar 用例全绿。

- [x] 1.1 开工核对：`sidecar.mjs` 头注释领取条（`:17-19`）、`settle`（`:159-164`）、`start`（`:302-318`）、`readyJobs`（`:321-344`）、`tick`；`server/test/support/converter-sidecar.ts` 的建作业与等标记辅助、`CONVERTER_POLL_MS` 如何传入；`office.ts:168-174` 的删除。出入先改本 fixture 再继续。
- [x] 1.2 测试先行：在 `server/test/converter-sidecar.test.ts`（或同夹具的新文件；新文件须进 CI 清单则改为放进现有文件）按 office-preview 两个新 Scenario 写用例（哨兵作业作屏障、删除次序先 `in/` 后 `done`，design D6；不用固定 sleep）。先在未改的 `sidecar.mjs` 上跑：只有「删除途中的作业不被重领」应红（第二行日志 `bad-request`、出现 `failed`），「已落定集合有界」在没有集合时本就是绿；记下输出。
- [x] 1.3 实现：已落定集合（design D2、D3：`settle` 加入；`readyJobs` 跳过；修剪对照 `readdir` 的全部条目名，`jobs/` 不存在时清空）。头注释（协议单一真相）同步：领取条（`:17-19`）加「本进程未曾落定」与集合说明；「结果」段（`:31-34`）加「落定之后本进程不再写入该作业目录」。
- [x] 1.4 变异（各自临时、跑完恢复，记下输出）：（a）去掉集合跳过 → 「不被重领」红；（b）保留跳过、去掉修剪 → 「有界」超时红。
- [ ] 1.5 验证：`npx vitest run --root server test/converter-sidecar --coverage=false` ×3；`npm test --workspace server`；`make check`；diff 只含 change 目录、`converter/sidecar.mjs` 与 `server/test/**`。（编排方，PR 之后）CI `office-sidecar` job 在 PR head 上 `gh run rerun --job` 重跑 5 次全绿。
