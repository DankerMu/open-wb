# Proposal: file-changes-candidate-cap（#740，owner 决议 (a)+(b)，上限 100）

## Why
`ownedChanges`（`server/src/sessions/file-changes-ownership.ts`）对每个原始候选做 1–4 次同步 `realpath`/`lstat`（另每条事件 1 次根目录校验），50 项的上限在合并之后才截断。一条 `files.changed` 事件能带多少候选只受 RPC 帧大小（64 MiB）约束，低信任的 omp 子进程发一帧即可长时间占住服务端事件循环。父设计 D6 写的「每步最多 50 个路径 × 2 次同步 realpath，IO 有界」不成立。

## What Changes
- `file-changes-ownership.ts`：只判定事件中前 100 个原始候选，其余不触发任何文件系统调用；同一事件内按规范化后的绝对路径记忆判定结果。
- 新测试文件 `server/test/file-changes-candidate-cap.test.ts`：上限与记忆的用例，以 `node:fs` 调用记录断言（不按耗时）；手法同 `server/test/persist-files-changed.test.ts`。
- 规格：turn-artifacts MODIFIED「文件变更推导与归属」——第 2 步加上限与记忆、第 6 步注明语义、一个新 Scenario。
- 父 change `design.md` D6「为什么」与 Risks 行改为如实表述（编排方改）。

## 语义变化
- 「前 50」变为「前 100 个原始候选中的前 50 个合并项」。一次 edit 的 `perFileResults` 超过 100 个文件时，第 101 个起不进文件变更卡。

## Non-goals
- 不把判定改成异步；不改归约器（原始候选仍全部进入事件，由 supervisor 截断）。
