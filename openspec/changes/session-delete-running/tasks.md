# Tasks: session-delete-running（#526）

## 4. session-metadata — 删除（running 路径）（父 tasks 4.3c 原文）

- [ ] - [ ] 4.3c 删除（running 路径）：`session-delete.ts` 在已持有占用下置 A 的「停止已在途」标志（并发用户 stop 按 A 自身规则应答，不重复 `abort`、不重复结算），执行与 A stop 相同的停止序列（挂起审批 `deny` 结算 → `abort`，或 prompt 帧未写出时登记停止意图）→ 等待「该回合进入终态（`turn.end` 已落库发布）」或「该次受理被补偿（受理对已移除、停止意图已丢弃）」二者之一 → 按此刻的非 running 状态转入 4.3b 的 retire → 删行 → 删文件；上界由 A 的 `OMP_ABORT_GRACE_MS`/retire 升级与获取失败补偿保证，不另设计时器；第 2–4 步失败 → 通用 5xx、行保留、占用释放；删除 4.3b 的过渡期 running → 409 分支。验证：`session-delete.test.ts` 把过渡期 409 用例替换为：`abort-ok` 场景 running 时 DELETE → 助手与会话先 `stopped` 落库再消失、订阅者见到 `turn.end stopped` 后连接结束；`approval` 场景 pending 审批时 DELETE → 审批 `deny` 结算后删除；`abort-ignored` 场景 → 有界退回 retire 后仍 204，总时长受 A 上界约束；`slow-ready` 场景 prompt 受理后 DELETE 并注入握手失败（`slow-ready` 延迟期间子进程退出或握手超时，A 的获取失败路径 → prompt 502 `agent_unavailable`）→ prompt 502 且受理对已补偿、DELETE 204、之后该 id 404、无残留占用（随后对同 owner 新会话的 prompt 与 DELETE 不 409）；删除期间并发 prompt/regenerate/fork/DELETE 均 409（inject 层），并发 stop 按 A 规则 202/204 且 fake 只收到一次 `abort`

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | DELETE running：停止后 204、失败 5xx → 证据 1、2、4、6 |
| Concurrency / shared state / ordering | yes | 占用下 stop、并发 stop 汇合、(a)/(b) 等待、pump 排空后才封存 → 证据 1、3、4、5 |
| Error handling / rollback / partial outputs | yes | 终态落库失败 5xx、获取失败补偿、faulted 不挂起 → 证据 4、6、8 |
| Legacy compatibility / examples | yes | retire 与 stop/admission 既有行为不变 → 证据 7 |
| Auth / permissions / secrets | no | 鉴权沿用 4.3b，未改 |
| File IO / path safety / overwrite | no | unlink 与校验沿用 4.3b，未改 |
| Resource limits / large input / discovery | no | 不涉 |
| Schema / columns / units / field names | no | 不涉 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试写进 `server/test/session-delete.test.ts`（替换其过渡 409 用例；超 800 行则新建同目录测试文件）；其余既有测试文件零改动。
- [ ] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-delete-running --strict --no-interactive` 通过。
