## 1. 读法与确定性用例

- [x] 1.1 先写测试：新增 `server/test/jsonl.test.ts`，覆盖以下三种情形（另加一条「只有一段未结束的行时返回空数组」），先跑出红：
  - 文件不存在时返回空数组；
  - 「完整行 + 未结束的半行」只返回完整行；半行补全并换行之后，再读返回两行；
  - 以 `\n` 结束的非法行抛错。
- [x] 1.2 新增 `server/test/support/jsonl.mjs`（类型在同目录 `jsonl.d.mts`）的 `readCompleteJsonl<T>(file: string): T[]`，语义见 proposal。写成零依赖 `.mjs` 而不是 `.ts`：`fixtures/threadpool-recovery.mjs` 是由 `node` 直接起的子进程脚本，用相对路径 `../support/jsonl.mjs` 就能导入同一份，不必在原地另写一份；`support/` 里已有 `fake-ragflow.mjs` + `.d.mts` 的先例。

## 2. 改读取点

- [x] 2.1 `server/test/mounts-manager-helpers.ts:305-311` 的 `readJsonl` 改为调用 helper。
- [x] 2.2 `server/test/mounts-manager-assembly.test.ts:142-151`、`server/test/server-startup-mounts.test.ts:158-165`、`server/test/mounts-rclone-conf.test.ts:62-71` 改为调用 helper，原有的 `filter` 保留。
- [x] 2.3 `server/test/fixtures/threadpool-recovery.mjs:59-65`：能导入就复用 helper；不能就在原地写同样的逻辑，并加注释指向 helper。（已直接导入 `../support/jsonl.mjs`。）
- [x] 2.4 用 `grep` 确认 `server/test` 下再没有其它「`readFileSync` 读 `.jsonl` → `split("\n")` → `JSON.parse`」的副本；如有，同样改掉，并写进报告。（另找到 3 处，读的都是服务进程里 require 钩子 `appendFileSync(JSON + "\n")` 写的 `.jsonl`，已改用 helper：`server-startup-overlay.test.ts` 的 `spawn.jsonl`、`server-startup-omp-user.test.ts` 的 `spawn.jsonl`、`server-startup-private-state.test.ts` 的 `readModeObservations`（`modes.jsonl`）。）

验证：
- `npm run test:focus --workspace server -- jsonl mounts-manager mounts-rclone-conf server-startup-mounts`，退出码 0。
- `make check`，退出码 0。
