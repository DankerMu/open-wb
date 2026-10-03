# Proposal: regenerate-dispatch-escape（#711）

## Why
#555 的不变量是「白名单外的 `/…` 文本到达 omp 时一律带前导空格」，但 regenerate 派发把 omp `branch` 返回的文本原样发回（`server/src/sessions/branching.ts` `#regenerate` → `#commit` → `dispatch`）。转义规则落地之前留下的裸 `/…` user 条目（含经 `/force:<tool> <prompt>` 透传留下的裸 `/<builtin> …`）在 regenerate 时会被原样重发：后者会把那个白名单外内建再执行一次；前者在 omp 升级或出现同名命令后会从普通文本变成可执行。

## What Changes
- `branching.ts`：regenerate 派发前，对以 `/` 开头的 branch 文本前置一个 U+0020。
- `server/test/turn-control-slash.test.ts`：派发转义用例；同次评审遗留的三条测试加固（见 tasks 1.3）。
- 规格：turn-control MODIFIED「重新生成 REST」——派发文本规则一句与一个 Scenario。
- 归档 design `openspec/changes/archive/2026-10-01-slash-escape-branch-align/design.md`「残余」条目标注已由 #711 收口（编排方改）。

## Non-goals
- `matches` 的逐字相等候选不动（旧历史对位仍需要它）。
- fork 的对位与 `draft` 不动（fork 不发 `prompt` 帧）。
- 不迁移或改写既有会话文件；omp 认识而宿主未列出的 `/skill:<name>` 残余不在本刀。

## 副作用（如实）
旧历史的裸条目在第一次 regenerate 后，omp 里新写入的 user 条目是转义形，此后按转义候选对位。
