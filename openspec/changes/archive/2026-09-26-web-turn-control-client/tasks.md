# Tasks: web-turn-control-client（#472）

## 7. chat-web 回合控制客户端（父 tasks 7.1 原文）

- [ ] 7.1 `web/src/lib/api-sessions.ts` + `session-contract.ts` + `stream.ts` + `status-label.ts`：四个新 API 方法（stop 202 解析 JSON `{}`、204 无 body）；会话/消息/步骤 status 联合加 `stopped`、`hasExactlyKeys` 键集更新；`status-label.ts` 穷举 Record 补 `stopped: "已停止"`；归约 `turn.end stopped`；503/409 信封文案透出。验证：新建 web 测试文件断言解析三态（done/failed/stopped）、归约 `turn.end stopped`、`status-label` 穷举

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `ApiClient` 新增四方法（路径/方法/body/凭证/signal） → `api-turn-control.test.ts` 逐项 `toHaveBeenCalledWith` |
| Schema / columns / units / field names | yes | 三个新响应形状 + 单条审批六键 + `stopped` 枚举的严格解析 → 接受/拒绝表（缺键、多键、非安全整数、`decision:null`、未知枚举）与 `toEqual` 原样 |
| Auth / permissions / secrets | yes | `stopSession` 不走 `request()`，自有 401 路径 → `unauthorizedResponseCases()` 三种 401 对 stop/approvals 触发 `onUnauthorized` |
| Concurrency / shared state / ordering | yes | `turn.end stopped` 经同一游标过滤；web-parse-before-server-emit 落刀次序 → 连接器 1:5/1:6/1:7 用例；PR 须先于 #473/#488/#475 合入（proposal Impact） |
| Legacy compatibility / examples | yes | 既有四方法、done/failed 归约、`step.end` 仍 `done|failed`、会话/消息键集不变 → 既有 53 文件 / 1017 例零 diff 全绿 + `step.end stopped` resync 守卫 |
| Error handling / rollback / partial outputs | yes | 503/409/400 信封不改写；非法 2xx 与非 JSON → 不泄露内容的 request_failed → 信封与拒绝用例 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 路径 id 编码归 Public API 包 |
| Resource limits / large input / discovery | no | 行数上限由 `size-guard.sh` 覆盖（design 行数表） |
| Release / packaging / dependency compatibility | no | 无依赖变化；`npm run build --workspace web` 作回归命令 |
| Documentation / migration notes | no | 源码结构说明归 9.1 #486 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建的 `web/test/api-turn-control.test.ts` 与 `web/test/chat-stream-stopped.test.ts`（各 ≤800 行）；既有测试文件（含 `web/test/support.ts`、`web/test/chat-stream-support.ts`）零 diff；允许的既有测试编辑：无。
- [ ] 源码只改 design「Change surface」五个文件；`api.ts` 仅 `import type` 三名 + `ApiClient` 四成员 + 注入三项（proposal 偏离 1），零新增 `export`；`api-sessions.ts` 对 `./api.js` 只有 `import type`；不触碰 `page.tsx`/`composer.tsx`/`conversation-view.tsx`/`session-nav.tsx`、server、Makefile、CI。
- [ ] 红先后绿按 design「Required evidence」：运行时红先项在未改源码时 `npm test --workspace web` 失败；主归约场景的红来自 `make typecheck`（测试字面量 `status:"stopped"`），PR body 记录两份红输出；guards 项始终绿。
- [ ] `npm test --workspace web`（coverage ≥80%）、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0，PR body 给出五个源文件改后实际行数；`openspec validate web-turn-control-client --strict --no-interactive` 通过。
