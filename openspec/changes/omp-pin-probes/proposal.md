# omp-pin-probes — overlay 固定块 `advisor` / `ida` 两段钉的官方二进制回归（#1583）

## Why

`server/src/sessions/omp/host-overlay.ts` 固定块末尾的 `advisor:\n  enabled: false` 与 `ida:\n  enabled: false`（#1570 加入）只有字面级单测（`omp-host-overlay.test.ts`、`server-startup-overlay.test.ts`），没有真实二进制用例；它们的实测只存在于 git 排除的 `.workplans/1570/evidence/`（一次性探针）。omp 不对 overlay 做整体 schema 校验（`host-overlay.ts:5-7`），下一次升级 omp 时若上游改名 / 挪层 / 改语义，这两段会静默失效而现有测试仍绿，Epic #1563 (f)（项目层 `ida.python` 让 `read` 无审批起进程）与 (i)（advisor 的 WATCHDOG 上溯越过空 `.git` 标记）重新打开。`ask` 钉已有同形的回归与负对照（`omp-official-rpc-ui.test.ts:304-345`），这里补齐另外两段。

## What

只加测试与一句文档：新官方二进制用例文件 `server/test/omp-official-overlay-pins.test.ts`（`WORKBUDDY_OMP_TEST=1` 门下，沿用 `openOfficialWorld` 与 `rpc-ui` 的 overlay 变体负对照手法），四条用例——产品 overlay 下系统提示的 `xd://` 设备列表不含 `ida`；去掉 `ida:` 块的负对照含 `ida`；产品 overlay 下一个 bash 回合恰 2 次上游请求且无 `advisor_yielded`；去掉 `advisor:` 块的负对照请求数 > 2 且出现 `advisor_yielded`。ADR-0012 第四部分「升级 omp 时重验」清单补一句指向该文件。不改任何生产代码；不钉 `task.agentAdvisor`（Epic (k) 待 owner）；固定块其它键的真实二进制回归另议。

`design.md` 省略：compact 级，只加测试，无共享入口 / 格式 / 状态改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; compact — tests only, no runtime behavior)
Blast radius: none at runtime; a wrong test would either be flaky (advisor timing) or an empty assertion (ida device never reachable) — the negative controls exist to rule out the latter
Selected risk packs: Concurrency / shared state / ordering (advisor case waits for the upstream request count to settle, no fixed sleep); Resource limits / large input / discovery (ida discovery needs a platform-named lib file: darwin libidalib.dylib, linux libidalib.so, win32 idalib.dll — omp ida/install.ts:16); Release / packaging / dependency compatibility (the file must be picked up wherever CI runs the official suite); Documentation / migration notes (ADR-0012 re-verify list)
Evidence floor: WORKBUDDY_OMP_TEST=1 OMP_BIN=var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official- (all 11 files green); npm test --workspace server (default: new file skipped, suite green); mutation check — remove the ida: block → case 1 red, remove the advisor: block → case 3 red (recorded in the PR); make check; make test-guardrails
```
