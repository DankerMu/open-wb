# omp-stdout-tee-guard — 官方测试的 stdout tee 容错非 JSON 行（#1592）

## Why

`server/test/omp-official-overlay-pins.test.ts:104-113` 的 `teeFrames` 在子进程 stdout 的 `data` 监听器里对每一非空行直接 `JSON.parse`。omp 只要写出一行非 JSON（将来的版本、或只在 Linux 上走到的路径），异常就在流回调里抛出，vitest 报 "Unhandled error"，官方套件因与 advisor / ida 钉无关的原因变红；同一 chunk 里坏行之后的合法帧也进不了 sink，后面的断言看到的帧不全。生产解析器 `server/src/sessions/omp/process.ts:529-535` 对同样输入是 try/catch 后跳过，所以这类红只会出在测试的 tee 里，是误报。兄弟副本 `omp-official-rpc-ui.test.ts:103-115`（`teeUiRequests`）先按子串过滤再解析，过滤后的 `JSON.parse` 同样无保护。

## What

- 把 tee 抽成 `server/test/support/omp-official.ts` 的一个导出 helper（按行切分、跨 chunk 拼接半行、每行 `JSON.parse` 包 try/catch、坏行跳过并计数），`omp-official-overlay-pins.test.ts` 与 `omp-official-rpc-ui.test.ts` 的两处 tee 都改用它（rpc-ui 保留「只收 `extension_ui_request`」的过滤，改在解析后按 `type` 过滤）。
- 坏行计数进 `overlay-pins` 既有的 `[overlay-pins]` 读数日志，便于看出 omp 输出的变化。
- 新增一条不依赖官方二进制、默认套件就跑的单测（`server/test/omp-stdout-tee.test.ts`）：用 `PassThrough` 喂含坏行与跨 chunk 半行的数据，断言不抛、合法帧全部按序入 sink、坏行计数正确。
- 不改 `server/src/`、不改 CI 清单（新单测不在官方套件清单里，默认套件按 glob 跑）。

`design.md` 省略：compact 级，只改测试支撑代码，无运行时改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; XS test-support fix, no runtime behavior)
Blast radius: none at runtime; a wrong helper would either drop legitimate frames (caught by the new unit test's order/count assertions and by the official suite's existing frame assertions) or still throw (caught by the unit test's bad-line case)
Selected risk packs: Error handling / rollback (bad line must be skipped, never thrown, the remaining lines of the chunk kept); Concurrency / shared state / ordering (the tee is a second listener on the same stream — frame order and completeness must be preserved); Release / packaging (no new official file, so no CI list change — verified, not assumed)
Evidence floor: npm test --workspace server (default suite incl. the new unit test, green); WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official-overlay-pins.test.ts test/omp-official-rpc-ui.test.ts (green, malformed count 0 in the [overlay-pins] readings); typecheck; make check; git diff --stat has no server/src and no CI scripts
```
