# Tasks — omp-retry-pattern-18-12 (#1586)

Fixture level: compact. Risk packs: selected — Legacy compatibility（三条正则与 v18.12.3 源码逐字一致）、Documentation（spec :84 基线句、测试头出处）；not selected — Public API / CLI、Config、File IO、Schema、Auth / secrets、Concurrency、Resource limits、Release / packaging、Error handling / rollback（无运行时改动，424 / 502 正文与状态码不动）。

Must preserve: `server/src/` 零改动；用例形状不变（四份 424 文本三条正则都不命中；`param=connect_timeout`、`param=status.504`、502+`statusReply(503,"")` 三条正对照仍命中）；文件内其它用例不动。

- [ ] 1.1 开工核对：v18.12.3 源码 `packages/ai/src/error/flags.ts`（只读，本机 scratchpad `omp-src-18123/`）`:168` `TIMEOUT_PATTERN`、`:229-230` `TRANSIENT_TRANSPORT_PATTERN`、`:231-232` `AUTH_FAILURE_PATTERN`、`:614-616` `isTerminalClientErrorStatus`、`:674-678` 文本判定的 4xx 闸；测试 `server/test/upstream-failure-sanitize.test.ts:6-9`（出处注释）、`:24-28`（三条正则）、`:178-194`（用例）；`server/src/core/upstream-failure.ts:30-44` 四份 424 字面。出入先改本 fixture 再继续。
- [ ] 1.2 改测试：`:24-28` 三条正则替换为 v18.12.3 的逐字拷贝（源码用 tab 缩进、`export const`，测试侧保持 `const` + 两空格，正则体一个字节不差）；`:6-9` 注释改指 v18.12.3 `packages/ai/src/error/flags.ts` `:168` / `:229-230` / `:231-232`，并补一句：v18.12.3 的 `isTerminalClientErrorStatus`（`:614-616`）让 4xx（非 408/429）不进文本分类（`:674-678`），文本不命中是第二层保证。用例 `:178-194` 本体不动。先跑该文件：应绿（issue-scribe 已复核零命中）；再做哨兵核对——把 `gatewayReply(504)` 的正文临时换成含 `temporarily unavailable` 的文本 → 用例红（证明新分支生效），还原。
- [ ] 1.3 验证：`npm test --workspace server -- upstream-failure-sanitize`（绿）；正则体与源码逐字 diff（从两边各提取三条正则的 `/.../i` 体，`diff -u` 为空，输出记入 `.workplans/1586/evidence/`）；typecheck；`make check`；`git diff --stat` 不含 `server/src/`。
- [ ] 1.4 spec（编排方）：`openspec/specs/model-proxy/spec.md:84` 按 model-proxy delta「透传端点与 bearer 鉴权」改为 v18.12.3 基线句。
