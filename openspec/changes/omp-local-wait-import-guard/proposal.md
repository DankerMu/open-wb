# omp-local-wait-import-guard — G1 导入方向守卫扩到 local-wait.ts（#1626）

## Why

#1600 把本地完成等待拆到 `server/src/sessions/omp/local-wait.ts`。omp-runtime「omp 运行时源码模块划分」规定它对 `./runtime.js` 至多只有 `import type`，但目前没有常驻测试守着这条规则。`runtime.ts:39` 对 `./local-wait.js` 是值导入，所以只要 `local-wait.ts` 反过来值导入、副作用导入、动态导入或 re-export `./runtime.js`，就会形成运行时导入环，而 CI 不会报错。`commands.ts` 的同类规则有 G1 守着（`server/test/omp-runtime-commands.test.ts:786-798`），`local-wait.ts` 没有。#1600 为了证明纯搬迁有意不改测试文件，这条就留作后续。

## What

- `server/test/omp-runtime-commands.test.ts` 的源码边界 describe：在 G1 的检查之外，对 `local-wait.ts` 引用 `./runtime.js` 的全部语句也逐条断言 `^import type`，并断言没有动态 `import("./runtime.js")`。
- `commands.ts` 现有的断言原样保留，包括 `statements.length > 0` 和 `runtime.ts` 里只有一处 `this.#acquire(`。
- `local-wait.ts` 不套用「至少一条」这一条：spec 允许它不导入 `./runtime.js`。
- spec：omp-runtime「omp 运行时源码模块划分」加一个 Scenario，写明常驻守卫覆盖两个文件。
- 不做：
  - 改产品代码；
  - 改造成通用的导入环检测；
  - 把 `process.ts` 等文件纳入这条规则（issue 的备选，超出 spec 当前要求）。

## Triage

```text
Issue type: test (regression guard)
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; XS, p3)
Level rationale: compact — one test file, no product code; the guarded rule already holds on master.
Blast radius: one source-reading test; a wrong regex either misses a value import (guard silently weak) or fails on a valid file (red CI on master)
Selected risk packs: none — Concurrency, Resource limits, Auth / secrets, File IO, Schema, Config, Public API, Error handling, Release / packaging all untouched (test reads two source files as text)
Evidence floor: mutation proof, run locally and not committed — `local-wait.ts` value import, `export … from`, side-effect import, dynamic `import()` of `./runtime.js` each turn the guard red; removing every runtime.js import from `local-wait.ts` stays green; `npx vitest run --root server test/omp-runtime-commands` ×3; `npm test --workspace server`; `make check`; diff only the change dir and `server/test/omp-runtime-commands.test.ts`
```
