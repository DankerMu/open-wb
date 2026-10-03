# Tasks: file-changes-candidate-cap（#740）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 turn-artifacts delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta（只改父 design.md 的两句）。

## 1. 实现
- [x] 1.1 `file-changes-ownership.ts`：`MAX_CANDIDATES = 100`，`ownedChanges` 只遍历前 100 个原始候选（按位置计：空间外、超长、非字符串等被丢弃的候选同样占名额）；按 `resolve(root, raw)` 的结果记忆 `ownedCandidate` 的返回值，用 `Map.has` 区分已记忆的 `undefined`。记忆键的计算必须在既有的 try 之内（或非字符串候选不进记忆、直接丢弃）——`resolve` 对非字符串抛 TypeError，「不抛」契约不得回归。注释同步。签名与「不抛、不改入参」不变。
- [x] 1.2 新文件 `server/test/file-changes-candidate-cap.test.ts`，用 `server/test/persist-files-changed.test.ts:19-37` 的 `vi.hoisted` + `vi.mock("node:fs", importOriginal)` 透传记录器，记录器同时记下函数名与首参（断言里的「首参」一律比对 `resolve(root, raw)` 后的绝对路径，记录器看到的不是原始相对写法）；每个用例在调用 `ownedChanges` 之前清空记录：
  - (a) spec Scenario 原样：150 个候选（前 100 中 40 个不同的已落盘空间内路径及其重复，含 `./a.txt` 与 `a.txt`；第 101–150 是另外 50 个已落盘空间内路径）→ 结果恰为那 40 项、按首次出现次序、`added`/`removed` 求和；
  - (b) 同一输入的调用记录：`realpathSync` 恰 41 次（根 1 次 + 每个不同路径 1 次）、`lstatSync` 0 次；第 101–150 个路径从未作为任何 fs 调用的首参出现；
  - (c) 被丢弃的路径重复出现时只判定一轮：空间外路径重复 3 次 → 以它为首参的 `realpathSync` 恰 1 次；悬空符号链接重复 3 次 → 以它为首参的 `realpathSync` 与 `lstatSync` 各恰 1 次；
  - (d) 边界与名额：前 100 个候选里 60 个是空间外路径、40 个是不同的空间内路径，第 101 个是一个新的空间内路径 → 结果恰 40 项（第 101 个不在其中，且从未作为 fs 调用首参出现）；把同一输入截到恰 100 个 → 结果相同。
- [x] 1.3 除上述两个文件与本 change 目录外不改其它被跟踪文件（`file-changes-ownership.test.ts` 文件头注释若描述了与新行为矛盾的内容可更正，其断言不动；父 design 的更正由编排方做）。

## Fix pass 1（评审 P1：单个候选的 `realpathSync` 代价无界）
- [x] F1 `ownedCandidate`：`resolve` 之后、任何文件系统访问之前，对规范化路径做纯词法检查——UTF-8 字节数 > 4096 或分量数 > 128 即丢弃（零 fs 调用；是否写入记忆均可，但不得触达 fs）。常量具名，注释说明平方代价与「第 4 步 1024 规则拦不住」的原因。
- [x] F2 `file-changes-candidate-cap.test.ts`：(e) 空间内 `l -> .`，候选 `l/`×200 + `a.txt`、一个规范化后 > 4096 字节的候选、一个普通的 `a.txt`——结果只有 `a.txt`；记录器里没有以前两者为首参的调用（也没有以其 `dirname` 为首参的调用）；(f) 边界：恰 128 个分量且 ≤4096 字节的空间内路径照常判定并进入结果，129 个分量的被丢弃。
- [x] F3 负控：去掉分量上限 → (e) 第一条失败；去掉字节上限 → (e) 第二条失败；把检查挪到 `resolveReal` 之后 → (e) 的「无 fs 调用」失败。
- [x] F4 证据：一次性计时（不入库）——修复前后对 `l/`×8000 的单候选调用 `ownedChanges` 的耗时；`npm test --workspace server` 全绿；lint/typecheck/anti-drift/size-guard/openspec validate exit 0。

## Must preserve
- `server/test/file-changes-ownership.test.ts` 全部用例断言不动且全绿，尤其 O11（非字符串 / NUL / 超长 path 不抛）与 O13（不改入参）、「上限」Scenario（60 个不同路径 → 前 50）。
- `server/test/persist-files-changed.test.ts`（未绑定会话零 IO）与 files.changed 集成测试全绿。
- `turn-control.ts` 的调用点不变。

## Required evidence
- E1 RED→GREEN：1.2 (a)(b)(c)(d) 在未改实现时失败，改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate file-changes-candidate-cap --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉上限 → (a)(b)(d) 失败。
- N5 上限只数幸存候选（被丢弃的不占名额）→ (d) 失败（第 101 个进入结果）。
- N6 记忆键在 try 之外计算 → O11 失败。
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
