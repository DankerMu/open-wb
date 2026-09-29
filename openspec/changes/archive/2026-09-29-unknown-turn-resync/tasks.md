# Tasks: unknown-turn-resync（#633）

## 1. 实现

- [x] 1.1 `connectSessionEvents` 返回 `{ close, resync }`（design「Must add/change」1）。
- [x] 1.2 纯函数 `isUnknownTurn(view, event)`（design 2）；`stream.ts` ≤800 行，超出则放进邻近纯模块。
- [x] 1.3 `page.tsx` 的 `onEvent` 接线：命中时不归约、向投递该事件的连接请求一次 `resync`；更新函数保持纯（design 3）。

## 2. 测试

- [x] 2.1 新测试 C1、U1、P1–P6、P5′（P1 含续测）（design「Required evidence」），沿用 `chat-page-support.tsx`、`chat-stream-support.ts` 等既有支撑；新 helper 放新文件，不改既有支撑的行为。
- [x] 2.2 红与变异：按 design「Required evidence」末条「红：」所列逐字执行（master 红集合与各变异及其适用条件），结果逐条写入报告。
- [x] 2.3 全部既有 web 测试全绿（重点：`chat-regenerate-button`、`chat-approval-bar`、`chat-page*`、`chat-stream*`）；如有期望改动，只允许加强断言并逐条列出。唯一授权例外：`chat-approval-bar.test.tsx` A13 按 design「Required evidence」改写。

## 3. 验证

- [x] 3.1 `make check`（Node 24.13.1）、`bash scripts/size-guard.sh` 退出 0；`wc -l` 记录 `stream.ts`、`page.tsx`。
- [x] 3.2 `openspec validate unknown-turn-resync --strict --no-interactive` 通过。
- [x] 3.3（编排者）归档 PR：ADDED 需求在两个父 change 中没有同名项，无需同步；归档后确认。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 事件与 202、快照安装、连接替换之间的次序；同一 drain 批次 → P1、P4、P5、C1 |
| Error handling / rollback / partial outputs | yes | 恢复被替代、倒退快照、关闭后调用 → C1 |
| Legacy compatibility / examples | yes | 已知 id 与 running 视图的既有归约、本页 202 先到的零额外 GET → P2、P3、2.3 |
| Documentation / migration notes | yes | chat-web 两条 ADDED → spec delta |
| Public API / CLI / script entry | no | 连接器句柄仅页面内部消费，无外部 API 变更 |
| Resource limits / large input / discovery | no | 每个未知回合至多一次 GET，由次数断言锁定 |
| Config / project setup | no | 无配置 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Auth / permissions / secrets | no | 不涉鉴权 |
| Schema / columns / units / field names | no | 无数据形状变化 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |

## 通用纪律

- [x] 源码边界：`web/src/features/chat/stream.ts`、`page.tsx`（及必要时新建的纯模块）；server、其它 web 模块零 diff。确需改动时先停下上报。
- [x] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
