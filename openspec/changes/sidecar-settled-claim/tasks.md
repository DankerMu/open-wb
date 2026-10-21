# Tasks — sidecar-settled-claim (#1601)

Fixture level: expanded. Risk packs: selected — Concurrency / state machine（领取条件加内存记忆；每轮按列表修剪；重启语义不变）、Resource limits（集合大小受 `jobs/` 目录数约束）；not selected — Auth / secrets、File IO / path safety、Schema、Config、Public API、Error handling、Release / packaging（见 proposal Triage）。

Must preserve: 领取次序（`request.json` mtime 升序）与并发上限；所有原因码、吞掉的错误与 fatal 路径；每作业恰一行 convert 日志；`SIGTERM` 不写标记；`request.json` 格式；app 侧 `office.ts` 不改；现有 converter-sidecar 用例全绿。

- [ ] 1.1 开工核对：`sidecar.mjs` 头注释领取条（`:17-19`）、`settle`（`:159-164`）、`start`（`:301-317`）、`readyJobs`（`:321-344`）、`tick`；`server/test/support/converter-sidecar.ts` 的建作业与等标记辅助、`CONVERTER_POLL_MS` 如何传入；`office.ts:168-174` 的删除。出入先改本 fixture 再继续。
- [ ] 1.2 测试先行：在 `server/test/converter-sidecar.test.ts`（或同夹具的新文件；新文件须进 CI 清单则改为放进现有文件）按 office-preview 两个新 Scenario 写用例；先在未改的 `sidecar.mjs` 上跑红，记下输出（第二行日志 `bad-request`、出现 `failed`）。
- [ ] 1.3 实现：已落定集合（design D2、D3）与头注释领取条。
- [ ] 1.4 变异：临时去掉集合跳过，跑新用例确认红，再恢复；记下输出。
- [ ] 1.5 验证：`npx vitest run --root server test/converter-sidecar --coverage=false` ×3；`npm test --workspace server`；`make check`；diff 只含 change 目录、`converter/sidecar.mjs` 与 `server/test/**`。
