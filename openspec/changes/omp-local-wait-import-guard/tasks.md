# Tasks — omp-local-wait-import-guard (#1626)

Fixture level: compact. Risk packs: none selected (see proposal Triage).

Must preserve: G1 现有对 `commands.ts` 的全部断言（含 `statements.length > 0`、`runtime.ts` 只有一处 `this.#acquire(`）；产品代码不改。

- [ ] 1.1 开工核对：`server/test/omp-runtime-commands.test.ts:782-799`（G1）、`server/src/sessions/omp/local-wait.ts:8`、`runtime.ts:39`；`grep -rln '"./runtime.js"' server/src/sessions/omp/` 只有 `commands.ts` 与 `local-wait.ts`。出入先改本 fixture。
- [ ] 1.2 在 G1 所在 describe 里加上 `local-wait.ts` 的同一组断言：每条引用 `./runtime.js` 的 import/export 语句都匹配 `^import type`，没有动态 `import("./runtime.js")`；不要求至少一条。断言消息里带文件名。
- [ ] 1.3 变异证明（只在本地跑，不提交）：在 `local-wait.ts` 里依次临时加 (a) `import { SessionRuntime } from "./runtime.js";`、(b) `export { SessionRuntime } from "./runtime.js";`、(c) `import "./runtime.js";`、(d) 一处 `import("./runtime.js")`，每种都让守卫变红；(e) 删掉 `local-wait.ts` 对 `./runtime.js` 的全部导入（`SessionClock` 换成本地结构类型或临时 `any`），守卫保持绿。每种变异跑完都要撤销，并把输出存到 `.workplans/1626/evidence/`。
- [ ] 1.4 验证：`npx vitest run --root server test/omp-runtime-commands` ×3；`npm test --workspace server`；`make check`；`git diff --stat` 只包含 change 目录和 `server/test/omp-runtime-commands.test.ts`。
