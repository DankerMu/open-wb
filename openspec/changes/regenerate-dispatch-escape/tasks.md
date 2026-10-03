# Tasks: regenerate-dispatch-escape（#711）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 turn-control 与 chat-sessions delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta。

归档时（编排方）：`openspec/specs/turn-control/spec.md` Purpose 里的「重新生成（`branch` 后以原文重发）」手工改为「重新生成（`branch` 后重发该条目文本，以 `/` 开头时先转义）」——delta 改不了 Purpose。

实施顺序：本 issue 在 #704 合入之后实施（同一测试文件）；实现前复核 #704 新增的 regenerate 用例里没有「裸 `/` 条目 + 断言 `prompt` 帧为裸文本」的断言，有则按本规格更新并在报告里列出。

## 1. 实现
- [ ] 1.1 `branching.ts` `Regenerations`：派发文本规则（spec delta 原句）；只此一处派发；注释同步。不改 `matches`/`entryFor`、不改 fork。
- [ ] 1.2 `turn-control-slash.test.ts`：(a) 末条存储 user 为白名单外 `/xxx`、末条条目为逐字相同的裸 `/xxx`（必须用真 fake-omp 的 `branch` 世界，如 `openWorld({entries:[…]})`；scripted FakeChild 的 `branch` 返回固定文本，造不出裸 `/`）→ 202，`prompt` 帧 `message` 恰为 ` /xxx`，存储正文不变；(b) 现有 E7（条目已是转义形）仍恰为该条目文本——补一条「不以两个空格开头」的断言；(c) 不以 `/` 开头的文本派发逐字不变（可在既有用例上补断言）。
- [ ] 1.3 同文件的三条加固：(i) `skills` 端口逐次求值——同一世界内，锚点 `/skill:x …` 在安装前 regenerate 得 502、安装后得 400（第二次请求不能复用断言零 spawn 的 `expectRefused`，自写断言）；(ii) fork 的「命令锚点 400 先于无会话文件 502」——不预置会话文件（不用 `seedTurns`，直接经 store 写入消息），在 `/todo` 处 fork → 400；(iii) E14 补断言临时进程已退出（与其余 fork 用例的 `isLive(...) === false` 同法）。
- [ ] 1.4 除 `server/src/sessions/branching.ts`、`server/test/turn-control-slash.test.ts`（行数逼近上限时可把新用例放进新文件 `server/test/turn-control-slash-dispatch.test.ts`）与本 change 目录外不改其它被跟踪文件。

## Must preserve
- change A 与 #704 既有 regenerate/fork 用例零 diff 通过（`turn-control*.test.ts`、`session-rest-slash.test.ts`）；E10（旧裸条目对位）仍 2xx。
- fork 行为不变（对位、`draft` 取所存正文）。

## Required evidence
- E1 RED→GREEN：1.2(a) 在未改 `branching.ts` 时失败（帧为裸 `/xxx`），改后通过。1.3 三条是 characterization（现代码已是该结果）；各用一次产品变异证明非空：(i) skills 首次调用后缓存、(ii) 交换 fork 两个前检的次序、(iii) 记录是否有可行的变异，没有则如实说明。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate regenerate-dispatch-escape --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉转义 → 1.2(a) 失败。
- N2 无条件前置空格 → 1.2(b)（两个空格）与 (c) 失败。
- N3 改用 `toWireText`（按白名单分类后转义）→ 记录结果：预检已排除白名单锚点，若所有用例仍绿，说明二者在可达输入上等价，如实写进报告（规格选的是「以 `/` 开头即转义」）。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 到达 omp 的 `prompt` 帧文本 → 1.2、N1、N2 |
| Legacy compatibility / examples | yes | 旧历史对位与既有 regenerate 行为 → Must preserve |
| Security-relevant input handling | yes | 裸 `/…` 不到达 omp → 1.2(a) |
| 其它 | no | 无 schema、UI、依赖改动 |
