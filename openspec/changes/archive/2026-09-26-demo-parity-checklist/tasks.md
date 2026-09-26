# Tasks: demo-parity-checklist（#301）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 revise：1 P1 + 6 P2 已修；r2 pass + 2 P2/Note 吸收，报告 `.workplans/301/review/fixture-r{1,2}.md`）；`openspec validate demo-parity-checklist --strict --no-interactive` exit 0。

## 2. Implementation
- [x] 2.1 `docs/acceptance/demo-parity-checklist.md` 按 D1–D5（S1e 范围内签收格为 `待签`）。
- [x] 2.2 `docs/architecture/system.md` §3.3 按 D6。
- [x] 2.0 为 D3 中"计划遗漏、未归属"的组件经 issue-scribe 开 issue（或引用已有），编号写入清单。
- [x] 2.3 Required evidence 1（逐行范围表）、2、5 的输出。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 docs PR 合并后：`make ui-shots` 实跑一次，产物交签收人，并附"agent 预审"意见（D7）。
- [x] 3.3 签收人以本人发言给出结论后：archive PR（`Closes #301`）照抄签收值并注明出处；Epic #274 贴签收表（不通过项附 issue；记录 ui-shots 实跑 SHA）；本 change 晋升 demo-parity-acceptance「逐页验收清单与签收」，父 delta 该块由 ADDED 改为 MODIFIED 且与晋升文本一致；勾选父 tasks 6.4。

## Risk pack mapping
- Not selected Public API / CLI / script entry：无。
- Not selected Config / project setup：无。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：清单列为文档契约，由 D1 固定。
- Selected Auth / permissions / secrets：公开文档与签收材料纪律。证据：Required evidence 5。
- Not selected Concurrency / shared state / ordering：无。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：`file:line` 必须指向真实代码。证据：Required evidence 2、3。
- Not selected Error handling / rollback / partial outputs：无。
- Not selected Release / packaging / dependency compatibility：无。
- Selected Documentation / migration notes：清单与 system.md。证据：Required evidence 1、3、4。
