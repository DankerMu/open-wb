# Tasks: session-delete-sibling-dir（#758）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 session-metadata 与 omp-test-harness delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta。

## 1. 实现
- [ ] 1.1 `session-delete.ts` `removeSessionFile`：spec delta 第 5 步新增句的行为。目录名取 `basename(path, ".jsonl")`，拼到已校验的 `expected`（owner 会话目录 realpath）下，不再解析 omp 上报字符串的任何分量；`lstat` 判定；`rm(dir, { recursive: true })`（不用 `force`，以便 `ENOENT` 以外的失败可见；`ENOENT` 视为成功）；不抛出。注释注明 TOCTOU 残余与既有 rename-swap 残余同级。
- [ ] 1.2 fake-omp：创建会话 `.jsonl` 的每一处同时建同名目录（一个普通文件 + 一层嵌套子目录内一个普通文件）；harness 测试中对 session-dir 列表的断言（如 `fake-omp-branch.test.ts`）相应更新。
- [ ] 1.3 `session-delete.test.ts`：(a) 空闲删除后 `.jsonl` 与同名目录都不存在；(b) 同名项不存在 → 204、错误通道无报告；(c) 同名项是指向 owner 目录外目录的符号链接 → 链接与目标内容原样、错误通道恰一条、204；(d) `.jsonl` 校验失败（不在 owner 目录 / 非普通文件）→ 同名项仍在；(e) 递归移除失败（注入）→ 204、行已删、错误通道有报告；(f) 同名目录内部含一个指向目录外文件的符号链接 → 目标文件原样（递归不跟随）。
- [ ] 1.4 `session-delete-running.test.ts`：running 路径删除同样移除同名目录。
- [ ] 1.5 `server/test/linux/uid-isolation.test.ts`「deletes a sudo-mode session and the branch file omp wrote」：断言同名目录由 omp uid 所有（与既有的 uid 断言同法）、删除后不存在、`errors` 为空。
- [ ] 1.6 除 `server/src/sessions/session-delete.ts`、fake-omp 源文件及其 harness 测试、上述三个测试文件（及它们共用的测试 helper）与本 change 目录外不改其它被跟踪文件。fake-omp 改动若使其它既有测试的断言需要更新（例如对 session-dir 内容的精确列表断言），逐个列出；涉及文件超出本条范围时停下报告。

## Must preserve
- `.jsonl` 的全部既有校验与错误通道语义不变；`session-delete*.test.ts` 既有断言不动且全绿。
- 既有 fake-omp 场景的帧序列不变（只多建目录）；`npm test --workspace server` 全绿。
- `make smoke`、uid-isolation 既有断言不动。

## Required evidence
- E1 RED→GREEN：1.3(a)(c)(f)、1.4 在未改 `session-delete.ts`（但已改 fake-omp）时失败或不满足，改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 真 omp（官方 v18.0.10，本机 direct 模式，假上游）：一个带步骤的回合后，确认同名目录存在；`DELETE` → 204，`.jsonl` 与同名目录都不存在，server log 无错误记录。
- E4 Linux sudo 模式（omp 专用 uid）下 1.5 通过：本机 docker 的 `ubuntu:24.04` 容器按 `.github/scripts/ci-uid-isolation.sh` 的装配运行；本机做不到时如实说明，由编排方以 CI `uid-isolation` job 的结果为准。
- E5 `make smoke`（CI wrapper）全绿；`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate session-delete-sibling-dir --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉目录移除 → 1.3(a)、1.4、1.5 失败。
- N2 `lstat` 换成 `stat`（跟随符号链接）→ 1.3(c) 失败（目标目录被删）。
- N3 `.jsonl` 校验失败时仍处理同名项 → 1.3(d) 失败。
- N4 移除失败时抛出 → 1.3(e) 失败（非 204 或行未删）。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| File IO / path safety / overwrite | yes | 递归删除 omp 可写位置下的目录 → 1.1、1.3(c)(d)(f)、N2、N3 |
| Permissions / isolation boundary | yes | app uid 删除 omp uid 建的目录 → 1.5、E4 |
| Test harness fidelity | yes | fake-omp 模拟真 omp 的同名目录 → 1.2、E3 |
| Error handling / partial failure | yes | 移除失败不影响 204 与行删除 → 1.3(e)、N4 |
| 其它 | no | 无 REST 契约、schema、UI 改动 |
