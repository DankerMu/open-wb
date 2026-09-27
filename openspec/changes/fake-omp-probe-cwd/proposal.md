# Proposal: fake-omp-probe-cwd（#520）

## Why
父 change `s1c-session-metadata-presentation` tasks 6.2（epic #509）。空间绑定 cwd（2.1 #513、2.2 #521）要在真实 fake-omp 子进程上证明 `--cwd` 的实际效果：spawn 的工作目录是否就是所选空间根。现行 probe 回报止于 A #459 的 `frames=`，不含子进程工作目录，宿主无从断言。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: probe 回报是带标签的一行文本格式，`parseLabeledReport` 是它的解析器；本刀改变其精确串并必然改动两个既有测试的期望值，「file format + parser」触发成立，且允许改动清单需要 design.md 的 Sibling surfaces 承载。先例 #459 `fake-omp-probe-frames` 同样覆写为 expanded)
Blast radius: 2.2 #521 / 4.4 #527 以 probe `cwd=` 断言空间根——字段取值错误（非 `process.cwd()`、非报告时刻）会让它们证明假命题；两处消费方若与 fake 不同步，本地 fake-omp 契约测试或 CI `uid-isolation` job 变红；`startFake` 的 `cwd` 选项若改变缺省行为，全部直接使用 fake-omp 的测试受影响。
Selected risk packs: Schema / columns / units / field names（probe 串格式与标签切分）；Legacy compatibility / examples（前 8 个字段与非 probe 行为不变、`startFake` 缺省不变）；File IO / path safety（含空格与 `=` 的路径、realpath 比较）；Auth / permissions / secrets（uid-isolation job 在异 uid 下保持绿）
Evidence floor: 新建 `server/test/fake-omp-probe-cwd.test.ts`（真实子进程）覆盖 design「Required evidence」；两处既有消费方只按 design 允许清单改动；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR head CI `uid-isolation` job 绿。

## What Changes
- `server/test/support/fake-omp.mjs` `probeReport` 返回模板在 ` frames=…` 之后追加 ` cwd=${process.cwd()}`（报告时刻、原样）。其它出站帧逐字节不变。
- `server/test/fake-omp-helpers.ts`：`StartOptions` 增可选 `cwd?: string`，`startFake` 仅在给出时把 `cwd` 放入 spawn 选项；未给出时 spawn 选项与现状逐字相同。
- `server/test/fake-omp.test.ts`：`expectedProbeReport` 模板末尾追加 ` cwd=<vitest 进程工作目录的 realpath>`（期望值；必要时增 `realpathSync` 导入）。
- `server/test/linux/uid-isolation.test.ts`：`REPORT_LABELS` 以 `"frames", "cwd"` 结尾；`parseLabeledReport` 返回对象随标签类型增 `cwd: requiredValue(values, 8),` 一行。偏离 issue「只改 `REPORT_LABELS`、不增长」：返回类型为 `Record<(typeof REPORT_LABELS)[number], string>`，缺该键 `make typecheck` 失败；先例 #459 为 `frames` 做了同一行。解析循环不改、不导出、不新增断言。
- `fake-omp-frames.test.ts:91`、`fake-omp-slow-ready.test.ts:229`、`omp-approval-requests.test.ts:195`：以串尾 `$` 锚定提取 `frames` 的正则改为以 ` cwd=` 锚定（每处一行，期望值不变）。偏离 issue PR Boundary（只点名两处消费方）：这三处是 change A 在 issue 写成后新增的 `frames=` 消费方，`cwd=` 追加后必然变红。
- 新建 `server/test/fake-omp-probe-cwd.test.ts`，自带与 `parseLabeledReport` 同规则的等价标签解析器（原函数为文件私有）。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp probe 回报」：整段取父 delta。本 issue 交付该 requirement 父 delta 的全部内容。

## Impact
- 仅测试支撑脚本、测试辅助与测试文件；无生产代码改动。

## Non-goals
- `thinking`/`edit-write` 场景（6.1 #518）、fake-upstream 标记（6.3 #528）、宿主侧以 `cwd=` 断言空间根的集成测试（2.2 #521、4.4 #527）、`frames=` 字段本身（A #459）、在 uid-isolation 中新增 `cwd` 值断言（该文件增长例外只对 2.2/4.3b 开放）。
