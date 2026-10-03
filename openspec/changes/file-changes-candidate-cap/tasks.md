# Tasks: file-changes-candidate-cap（#740）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 turn-artifacts delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta（只改父 design.md 的两句）。

## 1. 实现
- [ ] 1.1 `file-changes-ownership.ts`：`MAX_CANDIDATES = 100`，`ownedChanges` 只遍历前 100 个；按 `resolve(root, raw)` 的结果记忆 `ownedCandidate` 的返回值（含 `undefined`）；注释同步。`ownedChanges` 的签名与「不抛、不改入参」的契约不变。
- [ ] 1.2 `server/test/file-changes-ownership.test.ts`：(a) 150 个候选的 Scenario 原样（结果与次序、求和）；(b) 用可观测的方式断言文件系统调用次数——第 101 个起为零、前 100 个等于互不相同的规范化路径数（对 `node:fs` 的 `realpathSync`/`lstatSync` 计数，沿用该测试文件现有的手法；若现有手法做不到，停下报告）；(c) 判定为丢弃的路径（空间外、悬空链接）重复出现时同样只判定一次；(d) 恰 100 个与 101 个候选的边界。文件头注释里过期的描述一并更正。
- [ ] 1.3 不改其它被跟踪文件（父 design 的更正由编排方做）。

## Must preserve
- 既有 ownership 与 files.changed 集成测试全绿、断言不动（含「上限」Scenario：60 个不同路径 → 前 50）。
- `turn-control.ts` 的调用点不变。

## Required evidence
- E1 RED→GREEN：1.2 (a)(b)(c)(d) 在未改实现时失败（至少 (a)(b)），改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate file-changes-candidate-cap --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉上限 → (a)(b)(d) 失败。
- N2 去掉记忆 → (b)(c) 失败。
- N3 记忆键改用原始字符串（未规范化）→ `./a.txt` 与 `a.txt` 的计数断言失败。
- N4 把上限放到合并之后（「攒够 50 个就停」）→ (a) 或 (b) 失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Resource limits / large input / discovery | yes | 单事件同步 IO 上界 → 1.2(b)、N1、N2 |
| File IO / path safety / overwrite | yes | 记忆不得改变归属判定结果 → Must preserve、1.2(c)、N3 |
| Schema / columns / units / field names | yes | `changes` 语义变化（前 100 中的前 50）→ 1.2(a)、spec delta |
| 其它 | no | 无 API、UI、依赖改动 |
