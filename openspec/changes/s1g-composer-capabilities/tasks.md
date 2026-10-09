# Tasks: s1g-composer-capabilities

> 执行顺序：0 → 1 → 2 → 3 → 20 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19。组 20（模型代理白名单，owner S-22）是后加的任务组，编号排在最后以免改动既有组号；它的执行位置在组 3 之后。组 0 的 0.1 在一切之前，0.2 在归档之前。
> 组 1 是其余各组的前提：它的任何一条核对不成立，先按 design 对应决定的「退路」改本 change 的规格，再继续。组 4、10 与组 2 互不依赖，可在组 1 之后并行；组 3 与组 20 都在组 2 的第二刀（2.2 + 2.3，模型白名单）之后，二者彼此并行；组 5 必须早于组 8 与组 12（键集三步走，design D16）；
> 组 6 早于组 7、9；组 8 早于组 9；组 10、11 早于组 12；组 13 在组 8、11、12 之后；组 14–17 在组 13 之后，彼此共改 `composer.tsx` / `capability-bar.tsx` / `use-chat-session.ts`，串行；组 18 在组 14–17 之后；组 19：19.2、19.3 可随时做，19.1 在组 1 之后（它引用组 1 的实机结论），19.4 在组 2、11、20 之后，清单行随各自的功能 PR 落。
> `Depends on change s1f-session-list-temp-space`（下称 C），三处。(1) **条文与合同**：本 change 的规格以 C 的 delta 为底（design D16），实现也以 C 交付的代码为底——十一键会话视图、消息 `undo` 键、临时空间、撤回端点、`supervisor.ts` 腾出的行数。组 1、3、6、20，组 2 的 2.1–2.3 与组 10 的 10.1 不触及 C 所改的合同，可在 C 实施期间提前做。组 2、10 里有三条任务断言的是「C 之后的值加本 change 的增量」，各自等 C 的对应任务合入之后才开工：2.4（十九 → 二十三项应用配置）等 C 的 7.2（四个 `SNAPSHOT_*` 键，十五 → 十九）；10.2（十五 → 十六码）等 C 的 2.1（`session_archived`，十三 → 十四）与 11.1（`undo_conflict`，十四 → 十五）；10.3（content-parser 归属身份十四 → 十五）等 C 的 4.2（promote，十二 → 十三）与 11.1（undo，十三 → 十四）。其余各组（4、5、7、8、9、11–18，以及组 19 的 19.1、19.4、19.5）在 C 的全部任务合入之后开工；19.2、19.3 只写文档（ADR-0013 增补、`CONTEXT.md` 术语），不依赖 C，可随时做。
> (2) **迁移次序**：回执必须是已发现迁移文件的连续前缀，任何持久库先应用了 040 而 037–039 之后才出现就会打不开——组 4 在 C 的迁移 PR（037–039）合入之后才合入。(3) **对底**：组 0。
> 引用 C 的任务号一律按 C 当前的 `tasks.md`（round 1 重编号之后）：1.3（会话视图列集与映射）、1.4（web 会话解析）、2.1（`session_archived` 码）、4.2（promote 路由与归属集）、7.2（`SNAPSHOT_*` 配置键）、10.3（`supervisor.ts` 腾行）、10.6 / 10.7（消息 `undo` 键）、11.1（`undo_conflict` 码与 undo 归属）、11.2–11.5（撤回事务与编排）、13.1（`undoMessage`）、18.1–18.3（web 撤回）。
>
> 通用纪律：
> - 每组按其 `Minimal mergeable slice` 出小 PR；每个 PR 合入后 `make check`、`make test-guardrails` 全绿，触及真栈的 PR 另跑 `make smoke` / `make ui-walk`；主干始终可运行。PR diff 以 400 行为评审目标，超出时再切。
> - **800 行上限**：`server/src/sessions/omp/process.ts`（788）、`store.ts`（797；C 之后 766）、`omp/runtime.ts`（798）、`server/test/support/fake-omp.mjs`（799；C 之后 797）、`server/test/session-rest.test.ts`（789；C 之后 788）、`web/e2e/ui-walk-sessions.spec.ts`（776；C 之后 681）、`web/e2e/ui-walk-layout.ts`（793）
>   都没有余量；`supervisor.ts` 在 C 结束时不超过 792 行（C 的 design D15：C 的任务 10.3 腾行、10.4 与 11.5 各用掉一部分）。新增逻辑写进新文件或有余量的既有文件；必须落在这些文件里的改动，先由本 change 点名的纯搬迁任务腾出行数——7.0（`supervisor.ts`）、7.1 的第一次提交（`runtime.ts`）、8.0（`store.ts`）、6.1（`fake-omp.mjs`）——搬迁与功能改动分两次提交。新文件遵守各「源码模块划分」规格（无环、不新增未引用导出）。
> - **knip 的前提**：`knip.json` 的 server 与 web entry 都含 `test/**/*.test.ts(x)`，所以「先由测试引用」的导出不算未引用；各组契约行里这样写的切片成立。
> - **守卫**：`web/src/features/chat/` 下新增的 `.ts` / `.tsx` 在同一个 PR 里登记进 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 并同步清单断言；已迁移文件不得导入 `useToast`；`web/test/chat-module-layout.test.ts` 的导入方向（`page.tsx → use-chat-session.ts → turn-actions.ts`）不变；knip 无未引用导出；jscpd ≤3%；覆盖率 ≥80%（不得收窄 include）。
> - **拷入层**：`web/src/components/ui` 与 `web/src/components/assistant-ui` 不改。本 change 用到的 dropdown-menu（含单选组）、alert-dialog、button 都已拷入；若实现中发现非改不可，停下来报告，不自行放宽 ADR-0013 的六类修改。`web/src/ui/**` 冻结。
> - **Critical Path（白盒审查）**：组 7、9（omp 子进程治理：审批档位放宽）、组 10、11、12（沙箱与文件边界）、组 20（模型代理是 omp 访问模型的唯一通道，白名单是企业接入了哪些模型的清单（owner 2026-10-07：不是费用边界））。这些组的 PR 在描述里标注请求白盒审查。
> - **TDD 与变异证据**：每个行为任务先写失败测试；PR 描述里给出变异证据（去掉或写反对应实现时哪条测试判红）。写不出变异的防御性条件在偏离记录里说明。
> - **既有断言**：规格条文在本 change 被改的行为，其断言随条文改写并写进 PR 的偏离记录（各任务已点名）；点名之外变红的先查原因。不删除、不削弱仍有意义的断言，不加 skip。
> - **功能验收清单**：用户可见的变化在 `docs/acceptance/functional-checklist.md` 增改对应行，结论一律 `待签`；agent 不把任何行改为 `通过` / `不通过`。行里不写带单位的像素值与点号、井号开头的选择器。
> - 仓库是公开的：任何被跟踪文件里不出现主机绝对路径、用户名、IP 或密钥。官方二进制对照用例只在 `WORKBUDDY_OMP_TEST=1` 时运行，不引用真实上游。

## 0. 与 C 对底（归档顺序 C → 本 change → D）

- [x] 0.1 C 归档之后、本 change 的组 4 开工之前：对 design D16「与 C 重叠的 MODIFIED」表里底本为「C 的 MODIFIED / ADDED」的十九条，逐条把本 change 的 delta 文本与当时 `openspec/specs/**` 里的同名条文做句子级 diff。diff 里只允许出现该表「本 change 的增量」列所列的新增句、新增场景与改写场景；出现别的差异（C 在实现期改过条文、或本 change 漏了 C 的句子）就先改本 change 的 delta 与 D16 的表，再 `openspec validate s1g-composer-capabilities --strict --no-interactive`，以一个只改本 change 目录的 PR 落定。
  场景标题另查一遍：本 change 每条 MODIFIED 的 `#### Scenario:` 标题集合是当时主规格同名条文标题集合的超集（缺一个就在原标题下补回正文，不改名）；两个 openspec CLI（仓库约定的 node 版本下的那个与较新的 1.13.x）的 `validate --strict` 都是 0 个 ERROR。
  同一次核对里确认：C 的 `tasks.md` 任务号与本文件文首所列一致；`supervisor.ts` 的行数不超过 792；会话视图列集与映射的落点（C 的 1.3 留在 `store.ts`，或搬去了 `store-view.ts` / `store-branch.ts`）——结果写进 PR 描述，供 7.0 与 8.0 使用。
  核对记录（#983，2026-10-08，C 归档于 #980 之后）：十九条重叠 MODIFIED 的表头全部命中归档后的主规格，与主规格的差异只有 D16「本 change 的增量」列所列内容，场景标题集合都是主规格的超集；C 在实现期改过的五处（`reason` 枚举的 `name_encoding` / `mount`、启动失败 `reason` 与其场景、未还原文件说明的文案与场景「未还原文件被截断」、冲突对话框「遮罩点击不关闭」）本 change 都已带上；计数（十六码、十五条归属、二十三项配置、十四键、eleven routes、迁移 040–042 为第 14–16 个回执）均为「C 之后的值加本 change 的增量」。delta 无需修改，两个 openspec CLI（1.3.1 与 1.13.2）的 `validate --strict` 都通过。三项事实：C 的任务号与本文件文首所列一致（对照 `openspec/changes/archive/2026-10-08-s1f-session-list-temp-space/tasks.md`）；`supervisor.ts` 779 行；会话视图列集与映射在 `server/src/sessions/store-view.ts`（`SessionView`、`SessionDbRow`、`SESSION_COLUMNS`、`toSessionView`，`store.ts` 再导出），`store.ts` 766 行。组 8 加三键时另有三处手写的视图字面量要改：`store-metadata.ts` 的 `CreatedSessionView` 与 `createSession` 里的 `view()`、`store.ts` 里旧的 `create(ownerId)` 返回字面量、`rest.ts` 的 `PublicSession` 与 `toPublicSession`。
- [ ] 0.2 本 change 归档之前：用当时的主规格把 0.1 再做一遍（C 归档后主规格若又被别的 change 改过，以当时的为准）；并把 D16 的表与「本 change 的增量恰为」一表交给 D 的对底任务（D 以「主规格 → C → 本 change」叠加后的文本为底）。

Suggested fixture level: none - 只核对与修订本 change 目录下的规格文本，不改产品代码与测试
Minimal mergeable slice: 0.1 一刀（如有差异才产生 PR）；0.2 随归档


## 1. omp 实机核对（官方 v18.0.10 二进制对照用例）

- [x] 1.0 扩 `server/test/support/omp-official.ts`（101 行）的 world，三处，既有两个对照用例（`omp-official-skills`、`omp-official-project-config`）原样通过：(a) `openOfficialWorld(plant, options?)` 的 `options.spawnArgs` 让测试指定 `--approval-mode` 的取值与是否带 `--config`（现由 `process.ts:95-96` 写死；组 7 之前经一个只在测试里用的 spawn 包装改写 argv，组 7 之后改为直接传 `approvalMode`，在 7.1 里删掉这个包装）；
  (b) `options.onApproval` 让测试决定审批的应答（缺省仍是 deny，现写死在 `omp-official.ts:96-97`）；(c) `options.modelsYml` 让测试直接给出托管 `models.yml` 的文本（1.4 / 1.5 要两个模型与 `thinking` / `input` 键，而多模型写出器在组 3、组 3 又依赖 1.5 的结论——所以这里手写文件，不经写出器）。world 另暴露受控上游句柄，供 1.4 读请求记录。
  第四处（1.3 需要）：(d) 同一个托管状态目录上能先后开两个 runtime——world 暴露重开入口（或暴露 `stateDir` 并接受 `options.resumePath`），让第二个 runtime 以另一档位加 `--resume <第一个的会话文件>` 启动；`SessionRuntime` 关停后不可复用，`SessionRuntimeOpts` 已有 `spawnImpl` / `onApproval` / `resumePath`，world 的扩展不需要改 `server/src`。
- [x] 1.1 新文件 `server/test/omp-official-approval-modes.test.ts`（`WORKBUDDY_OMP_TEST=1` 开关与受控上游同既有对照用例）：以原样的宿主 overlay 分别用 `--approval-mode always-ask` / `write` / `yolo` 启动，
  各跑一个 bash 回合与一个 `WORKBUDDY_WRITE` 回合，断言 session-permission-tier「档位与 omp 审批模式」三条真实 omp 场景（审批请求的有无、`tool`、`title` 首行、作答 `Approve` 后工具执行）。这是 design D2 核对项 (a)(b)。
- [x] 1.2 同文件：`always-ask` 下 cwd 预置 `.omp/config.yml`（`tools.approval: {write: allow}`）仍对 `write` 发起审批（D2 核对项 (c)）；负向对照：去掉宿主 overlay 时不发起，证明用例能判红。
  「去掉宿主 overlay」要同时去掉两个来源：argv 的 `--config <overlay>` 与 spawn env 里指向同一份 overlay 的 `PI_CONFIG_FILES`（`process.ts` 两处都钉了；主规格 omp-runtime「托管配置位置不可被 dotenv 改写」）。只去掉其中一个时 omp 的实际行为以实测为准，记进 PR 描述；负向对照以「两个来源都去掉时不发起」为判据。
- [x] 1.3 同文件：同一会话文件先以 `write` 跑一个回合，退出后以 `always-ask` 加 `--resume` 重启，`get_branch_messages` 仍含第一回合的 user 条目，且 `WORKBUDDY_WRITE` 回合发起审批（D2 核对项 (d)）。
  **CI（确定要改）**：`.github/scripts/ci-uid-isolation.sh` 的 vitest 命令行是显式文件清单（现为 `test/omp-official-skills.test.ts test/omp-official-project-config.test.ts`），把 `test/omp-official-approval-modes.test.ts` 加进去；`scripts/test-ci-harness.sh` 对这条命令行有逐字断言，同步改；PR 描述标注改了 CI 脚本。验证：CI 的 uid-isolation job 里出现该文件的用例且通过，`make test-guardrails` 绿。
- [x] 1.4 受控上游的请求记录：`server/test/support/fake-upstream.mjs`（518 行）按 omp-test-harness「受控上游请求记录」加 `GET /__control/requests` 与句柄的 `requests()`；测试 `server/test/fake-upstream.test.ts`（或同类新文件）：「记录模型名与消息条数」；既有 fake-upstream 测试原样通过。变异：不鉴权、记录了消息文本 → 判红。
  新文件 `server/test/omp-official-model-commands.test.ts`：托管 `models.yml` 含两个模型（1.0 的 `modelsYml`）；断言 model-selection「真实 omp 上的模型与强度」——`set_model` 后的 `get_state.model`；对 `off`、六个强度档、`auto` 逐一 `set_thinking_level` 后的 `get_state.thinkingLevel`，
  首次运行把结果填成用例内的期望表并冻结；两个命令前后托管 `HOME` 下全局配置文件逐字节不变；换模型后的回合受控上游记录到的 `model` 与消息条数；`--resume` 重启后不发命令的 `get_state`（D8 核对项 (a)–(e)）；整个用例里受控上游记录到的每一个请求的 `model` 都在托管 `models.yml` 的 id 之内（D18 核对项 (f)）。
  (f) 的用例步骤须触发 omp 自己发起的请求，不只是回合的主请求：新会话的第一个回合（v18.0.10 二进制里会话标题生成的时机，按 `tiny` → `commit` → `smol` 角色取模型；宿主 argv 带 `--no-title`——omp-runtime 的 spawn 契约——预期不产生标题请求，这一步用来证实它）、一个工具轮、换模型后的回合，再加**恰一个 `/compact` 回合**（经 RPC 发 `prompt{message:"/compact"}`，排在换模型后的回合结束之后；整个用例只发这一次，它之前不得已有压缩记录，否则 omp 报 `Already compacted`）。**这一步必须真的向上游发出请求**：v18.0.10 的 `compaction.keepRecentTokens` 缺省 20000，历史全部落在保留区时手动压缩不发请求，直接以 `command_output{text:"Compaction failed: Nothing to compact (session too small)"}` 结束，受控上游的短回合远不到这个量。主手段：用例的 `plant` 在 cwd 预置 `.omp/config.yml`，内容恰为 `compaction:` / `  keepRecentTokens: 1` / `  methodOrder: [soft]` 三行（与 1.2 预置 `tools.approval` 同一手法；宿主 overlay 不钉 `compaction.*`，项目层的值生效）——保留区缩到最后一条消息，此前各回合全部进入待总结区；v18.0.10 的手动压缩按 `compaction.methodOrder` 选方法（缺省次序 `remote`、`snapcompact`、`handoff`、`shake`、`soft`）：`snapcompact` 在会话模型的 `input` 含 `image` 时入选且不发 LLM 请求，只有 `soft` 一定走上游，所以预置同时把 `compaction.methodOrder` 钉为 `[soft]`，与 1.5 里哪个模型条目带 `image` 无关。备选（仅当 `keepRecentTokens` 的预置在 RPC 会话里不生效，即这一步仍报 too small 时，在本任务内改用）：预置只留 `compaction:` / `  methodOrder: [soft]` 两行（方法次序在两种手段下都钉住），在 `/compact` 之前、且至少已有一个完成的回合之后，多跑一个回合，其用户消息正文为 200 000 个 ASCII 字符（空格分隔的短词，按任何估算都超过 20000 token，又远小于 `models.yml` 的 `contextWindow: 128000`）；长消息不能是历史的第一条——切点落在它上面，它之前必须有可总结的内容；长消息那一回合若触发了自动压缩（随后的 `/compact` 报 `Already compacted`），断言 (2) 判红，按「两种手段都不能」处理。受控上游的回复正文是固定的，不为此给它加开关。两种手段都不能让这一步发出上游请求 → (f) 判「不成立」（1.6）。二进制里另有 `modelRoles` 的 `smol` / `default` / `slow` 角色（编辑自动修复、提交信息生成、记忆抽取走 `smol`），它们在 RPC 模式与宿主 overlay 下是否发请求无法从二进制确认，不为它们编造触发步骤——以受控上游的请求记录为准：核对期间记录到的全部 `model` 值都须在白名单内。用例按步骤记下 `requests()` 的增量（每步新增几条、各自的 `model`）。对 `/compact` 一步的断言有三条，缺一判红；该步的增量在它的 `command_output` 帧到达之后读取（有界等待；omp 先应答 `prompt`、压缩在后台跑，应答一到就读会漏掉请求）：(1) 该步新增上游请求数 ≥ 1；(2) 该步的 `command_output` 文本不含 `Nothing to compact`，也不含 `Already compacted`（文本原样输出到测试日志）；(3) 该步与整个用例记录到的全部 `model` 值都在白名单内。「第一个回合里主请求之外的请求数」只是观察值，输出到测试日志、不作断言（`--no-title` 下预期为零）。两个数与 `/compact` 的输出文本写进 1.6 的结论。
  **实施注记（fixture 评审补充）**：
  - 请求记录的口径：bearer 通过且 body 解析为 JSON 对象即记录，先于夹具对 `messages` 的校验；非 JSON 对象不记（omp-test-harness「受控上游请求记录」）。`GET /__control/requests` 不在 `/__control/gates/` 前缀下，须在 `handleRequest` 的 POST / 路径检查之前单独分支；`server/test/support/fake-upstream.d.mts` 的句柄类型同步加 `requests()`。应答字节、marker、gate、工具轮规则一处不动。
  - RPC 发送：`SessionRuntime.command` 的联合类型（`server/src/sessions/omp/runtime.ts`）还没有 `set_model` / `set_thinking_level` / `get_available_models`（组 7 才加），对照用例以 `as never` 发送（先例 `server/test/omp-official-skills.test.ts`），**不改 `server/src`**。`success:false` 的应答在这一层表现为 `AgentUnavailableError`，拿不到 omp 的错误文本。
  - world：`support/omp-official.ts` 的 world 写死 `--model deepseek-v4.1-flash`。手写的 `models.yml` 须含 provider `workbuddy`、该 id 为**第一个**模型，格式照 `server/src/model-proxy/models-yml.ts`。
  - 工具轮：受控上游只在请求不含 tool 结果时才以工具调用开场（#1140），请求记录不解决这一点。「一个工具轮」因此必须是新会话的第一个回合；本文件**不用** `freshToolRounds`（它让 forwarder 裁掉历史，D8 (d) 的消息条数证据随之失效）。
  - 期望表：两个模型各一张八行表（`off`、六档、`auto`）。成立口径见 1.6。（`auto` 一行只作记录；它已按 owner 2026-10-07 的决定从取值域移除。）
  - 停下并报告（不改断言换绿）：`/compact` 主手段与备选都零请求；记录到两个 id 之外的 `model`；任一核对项不成立；`omp --version` 不是 `omp/18.0.10`。
- [x] 1.5 同文件：带 `thinking: {mode: effort, efforts: [low, high]}` 与 `input: [text, image]` 的条目被 omp 接受，`get_available_models` 里该模型的这两项与所写一致；只写 `reasoning: true`、不带 `thinking` 的条目在 `get_available_models` 里报出的强度集合记入期望表（D7 核对项）。
  **CI**：把 `test/omp-official-model-commands.test.ts` 加进 `.github/scripts/ci-uid-isolation.sh` 的同一份清单，`scripts/test-ci-harness.sh` 的逐字断言同步。
  **实施注记**：两个模型里一个只写 `reasoning: true`（不带 `thinking`），另一个带 `thinking: {mode: effort, efforts: [low, high]}` 与 `input: [text, image]`。CI 清单的改动点：`.github/scripts/ci-uid-isolation.sh` 的 vitest 命令行，以及 `scripts/test-ci-harness.sh` 里两处逐字串（`contract()` 的期望行与 `grep -F` 一行）；改完跑 `make test-guardrails`。这是 CI 文件改动，PR 里须点明（AGENTS.md）。同一 PR 给 `specs/omp-uid-isolation/spec.md` 补 MODIFIED delta（清单不再逐个枚举）。
- [x] 1.6 把 1.1–1.5 与 1.8 的结论写成本 change `design.md` 末尾的一节「实机核对结果（日期）」：逐项「成立 / 不成立」（1.8 的 (g) 另写明 omp 存下的条目文本与发出文本是否逐字节相等，不等时贴出实际存下的文本的转义形式；(g) 不成立按 D12 的退路先改 delta，再做组 12）；(f) 另写明 1.4 记下的各步上游请求增量、`/compact` 一步用的是主手段还是备选及其输出文本、第一个回合在 `--no-title` 下是否确无标题请求；(f) 成立须三条同时满足：记录到的全部 `model` 在白名单内；`/compact` 一步新增上游请求数 ≥ 1；该步不以 `Nothing to compact` / `Already compacted` 结束。`/compact` 一步零请求即 (f) 不成立——没有观察到压缩请求不算通过。任一项不成立，按 D2 / D7 / D8 / D9 / D12 / D18 写明的退路修改对应的 delta 规格与后续任务，并在 PR 里请 owner 确认后再继续组 7 之后（(f) 不成立时为组 20）的工作。
  **实施注记**：
  - 「实机核对结果」一节目前不存在，本任务新建。来源：D2 的 (a)–(d) 抄 PR #1139 的结论表；(g) 抄 #1128（PR #1151）的交接评论；D8 的 (a)–(e)、D7 两项与 (f) 取自本 PR 的 CI uid-isolation job 输出（写明 run 编号）。
  - 成立口径：D8 (b) / D9——对该模型可选集合里的每个取值 v，`set_thinking_level{v}` 之后 `get_state.thinkingLevel === v` 即成立；集合之外的取值只记录不判定。D7 后半——不带 `thinking` 的推理模型报出的强度集合为空 → 走 D7 已写的退路；非空但不是全部六档 → **停下回 owner**（D9「未声明则全部六档」的前提不成立，退路未写）。D8 (e) 只是观察值。
  - 任一项不成立：本 PR 只提交用例与结论并**停下报告**；对规格、任务与受影响 issue 正文的修订是 owner 确认之后的第二轮，不在同一次提交里。
  - 逐项结论同时回填 Epic #982 的「前置核对结论」。
  **状态（2026-10-07）**：结论节已写；owner 于 2026-10-07 作出四点决定（见 design 「实机核对结果」的「owner 决定」），规格与任务已据此修订。
- [x] 1.7 本地运行方式写进组 1 新增的各个对照测试文件（1.1 与 1.4 的两个；1.8 若另起了 `omp-official-attachment-only.test.ts` 则是三个）的文件头注释与 PR 描述：先 `make omp-fetch`（取官方 v18.0.10 二进制），再在 `server/` 下 `WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" npx vitest run test/omp-official-approval-modes.test.ts test/omp-official-model-commands.test.ts --coverage=false`（`OMP_BIN` 须是**绝对路径**——omp 以临时工作空间为 cwd 启动，仓库相对路径解析不到；1.8 没有另起文件，命令行就是这两个文件）；不带开关时这些文件整体 skip（`make test` 下如此），所以「本地 `make check` 绿」不代表核对被执行过——以 CI uid-isolation job 的输出为准。
- [x] 1.8 以换行开头的文本是否被原样保存（design D12 核对项 (g)；只发附件的消息交给 omp 的文本就是附件后缀本身，以两个 U+000A 开头）。依赖 1.0（world）；写进 1.1 的文件 `server/test/omp-official-approval-modes.test.ts`（已在 1.3 加进 CI 清单，不再改 CI 脚本）或同目录新文件 `server/test/omp-official-attachment-only.test.ts`（新文件则照 1.3 的做法加进 `.github/scripts/ci-uid-isolation.sh` 的清单并同步 `scripts/test-ci-harness.sh` 的逐字断言）。
  用例：`plant` 在 cwd 预置 `uploads/a.txt`；以缺省档位启动，经 RPC 发一条 `prompt`，其 `message` 恰为 message-attachments「后缀的确切字节」对 `["uploads/a.txt"]` 给出的字符串（测试里按规格逐字写出，不依赖组 12 的 `attachmentSuffix`）；回合正常结束后断言：(1) `get_branch_messages` 最后一项的 `text` 与发出的 `message` 逐字节相等（开头两个换行都在）；(2) 对该条目 `branch{entryId}` 的应答 `text` 同样逐字节相等；(3) 该回合确实产生了一个 `user` 条目（列表长度比发之前多一）。对照：再发一条以普通文字开头、后接同一后缀的 prompt，同样三条断言（证明用例能区分「只裁开头」与「整体不保存」）。三条里任何一条不成立即 (g) 不成立，实际存下的文本以 `JSON.stringify` 的形式输出到测试日志，供 1.6 记录。不带 `WORKBUDDY_OMP_TEST=1` 时整体 skip（同 1.7）。

Risk packs（1.4–1.7 一刀，按 expanded 执行）: CI / script entry（清单与逐字断言同步，`make test-guardrails`）、Auth（请求记录端点的 401）、Legacy compatibility（既有 completions 应答字节不变、既有 fake-upstream 用例原样通过）、Error handling（两种 `/compact` 手段与停下条件）、Docs（1.6 的结论节与 Epic 回填）。未选：Schema / migrations、Concurrency、File IO。
Suggested fixture level: compact - 只新增 opt-in 的对照用例与测试夹具的一个只读端点，不改产品代码；结论驱动后续组的规格是否要改
Minimal mergeable slice: 1.0 + 1.1 + 1.2 + 1.3 一刀（world 扩展与档位核对，含 CI 清单加第一个文件——合入即在 CI 里执行）；1.8 一刀（以换行开头的文本核对；依赖第一刀的 world，与下一刀互不依赖，须在 1.6 之前合入）；1.4 + 1.5 + 1.6 一刀（受控上游请求记录、模型与强度核对、CI 清单加第二个文件、结论入 design）；1.7 随各刀各自落


## 2. agent-config — 四个环境变量与模型白名单

- [x] 2.1 `server/src/agent-config.ts`（现 142 行）：`AgentSettings` 增 `approvalMaxMode`、`uploadMaxBytes`、`uploadMaxFiles`；`APPROVAL_MAX_MODE` 只接受 exact 三个字面量（缺省 `yolo`），两个上传键复用 `resolvePositiveInteger`（缺省 524288000 与 10）；错误只点名键。
  测试 `server/test/server-config.test.ts`（或同类新文件）：http-service-skeleton「四个新配置键的取值与非法值」的配置层部分（表驱动）。变异：把缺省 `yolo` 改成 `write`、放宽大小写 → 判红。
- [x] 2.2 新文件 `server/src/model-catalog.ts`（纯函数，不读环境以外的东西）：`resolveModelCatalog(env)` 按 model-selection「模型白名单配置」得出 `{models, defaultModelId}`；`selectableEfforts(model)` / `defaultEffort(model)` 按「推理强度集合」（七个强度名，没有 `auto`；`MODEL_CATALOG` 里 `reasoning: true` 而不带 `efforts` 的元素启动失败并点名 `MODEL_CATALOG`；`MODEL_CATALOG` 未设置时的那一项不带 `efforts`，可选强度为 `off` 加全部六档）。`agent-config.ts` 调用它，`AgentSettings` 以 `modelCatalog` 取代对外的 `modelId` / `modelReasoning` 两个字段
  （既有读者 `pool.ts`、启动装配在组 3、7 改；本任务保留两个字段为白名单缺省模型的派生值，组 7 结束时删除——在任务 7.4 里核对已无读者）。
  测试新文件 `server/test/model-catalog.test.ts`：三条配置场景（未配置等于单模型、多模型与缺省、全部非法情形各点名正确的键且不回显取值）与「可选强度与缺省强度」场景。变异：允许 `efforts` 乱序、允许与 `MODEL_REASONING` 并存、缺省强度恒取 `high`、放行 `MODEL_CATALOG` 里不带 `efforts` 的推理模型（当作全部六档）、给 `MODEL_CATALOG` 未设置时的那一项补上 `efforts`、可选强度里多出 `auto` → 各判红。
- [x] 2.3 同文件再导出纯函数 `effectiveComposer(raw, config)`（session-composer-settings「有效值解析」；档位次序常量也在这里，供组 8、9 共用，不另写第二份）。测试并入 `model-catalog.test.ts`：「夹取与回落」的七组输入。变异：不夹取档位、白名单外的模型不回落 → 判红；强度不在模型的可选强度内时回落到缺省 → `("yolo","m3","xhigh")` 一组判红（期望 `xhigh` 原样保留）；原始强度为 null 时不取缺省 → `(null,"m3",null)` 一组判红。
  **实施注记（2.3，fixture 评审补充）**：
  - 签名：`effectiveComposer(raw: { approvalMode: ApprovalMode | null; modelId: string | null; reasoningEffort: Effort | null }, config: { approvalMaxMode: ApprovalMode; modelCatalog: ModelCatalog }): { approvalMode: ApprovalMode; modelId: string; reasoningEffort: Effort | null }`；`AgentSettings` 在结构上可直接当 `config` 传。
  - 档位次序常量在 `model-catalog.ts` 导出为 `APPROVAL_MODES = ["always-ask", "write", "yolo"] as const` 与类型 `ApprovalMode`；`agent-config.ts` 里的内联联合类型与字面量比较改为引用它（`model-catalog.ts` 不得反向导入 `agent-config.ts`）。
  - 测试除七组输入外再加两例：入参冻结后求值不抛且入参不变；同一份 raw 在「调低再调回」的两份 config 下原始选择重新生效（有效值不回写）。
  Risk packs（2.3）: Legacy compatibility（三列全 NULL 等于今天的行为）、Config（最高档夹取）。
- [x] 2.4 入口级：`server/src/server.ts` 的纯配置 seam（`resolveServerConfig` 上方注释「消费十五项自有 key，agent 十一项」）在 C 之后已是十九项，本任务把注释与实现改到二十三项（agent 侧加四键，经 `resolveAgentSettings`）。
  测试 `server/test/server-config.test.ts`：http-service-skeleton「Pure source and compiled configuration identity」改写后的断言（twenty-three application keys，源码入口与编译入口一致）；`server/test/server-startup-order.test.ts`（或 `server-entry-silent.test.ts`，以既有覆盖「非法配置 nonzero 退出、stderr 恰一行」的那个文件为准）：「四个新配置键的取值与非法值」的非法值一半——四键各自的非法取值都在任何 filesystem / database / listen 副作用之前 nonzero 退出、application stderr 恰一行 generic failure record。
  合法四键启动后 `GET /api/composer/options` 的回报与「托管 models.yml 含三个模型条目」属于同一场景的另一半，分别在 8.5 与 3.2 落（两处各自点名本场景）。变异：某个新键的非法值被当作缺省放行 → 判红。
  **实施注记（2.4，fixture 评审补充）**：
  - 实现已是二十三项（`agent-config.ts` 已解析四个新键）；本任务的产品改动只有 `server.ts` 里 `resolveServerConfig` 上方那段注释（四项自有键 + agent 十九项）。
  - 「非法值在副作用之前退出」落在 `server/test/omp-max-processes-config.test.ts`（`SNAPSHOT_*` 的同类用例在那里，沿用其 `it.each` 形状与既有辅助）；`server-startup-order.test.ts` 已近 800 行，不加；`server-entry-silent.test.ts` 不是目标。
  - 非法值表按规格共 20 例：`APPROVAL_MAX_MODE` 4 个、`UPLOAD_MAX_BYTES` 与 `UPLOAD_MAX_FILES` 各 7 个、`MODEL_CATALOG` 为空串与 `not json`；每例另断言 stderr 不含键名。
  - 身份断言补四键：`server-config.test.ts` 里源码入口与编译入口两例都断言 `modelCatalog`、`approvalMaxMode`、`uploadMaxBytes`、`uploadMaxFiles` 的缺省与覆盖；覆盖例设 `MODEL_CATALOG` 时不得同设 `MODEL_REASONING`。
  Risk packs（2.4）: Startup ordering（副作用之前）、Config。

Suggested fixture level: expanded - 生产配置解析与白名单是其后各组的共同输入；含向后兼容（单模型缺省）
Minimal mergeable slice: 2.1 一刀（三个标量键，尚无读者，knip 以 `AgentSettings` 字段计不报）；2.2 + 2.3 一刀（白名单与两个纯函数，带测试；被 `agent-config.ts` 引用故无未引用导出）；2.4 单独一刀（入口级断言与 seam 注释；等 C 的 7.2 合入，不随第二刀提前）

## 3. model-proxy — 托管 models.yml 多模型

- [x] 3.1 `server/src/model-proxy/models-yml.ts`：`writeManagedModelsYml(agentDir, {proxyBaseUrl, models})` 按 model-proxy delta「托管 models.yml」写出（每模型一条；`thinking` 在 `input` 之前；空数组拒绝且不动既有文件）。先把改动前对 `deepseek-v4.1-flash`、`reasoning` 真 / 假两种输出存成测试夹具，再改实现。
  测试 `server/test/model-proxy-models-yml.test.ts` 与 `model-proxy-reasoning.test.ts`：既有用例改为传单模型白名单（断言不变）；新增「Several models in whitelist order」「Single-model output is unchanged」。变异：模型次序反转、`input` 写在 `thinking` 之前、带 `efforts` 的推理条目（场景里的 `m1`）不写 `thinking`、单模型多写一个键（含给 `MODEL_CATALOG` 未设置时的那一项补 `thinking`）→ 判红。
- [x] 3.2 启动装配（`server/src/server.ts` / `app.ts` 里调用写出器的那一处）：传入 `settings.modelCatalog.models`。测试：`server/test/server-startup-layout.test.ts` 的缺省启动仍恰一个模型条目且字节与夹具相同；新增一例三模型 `MODEL_CATALOG` 启动后文件含三条（http-service-skeleton「四个新配置键的取值与非法值」里「托管 models.yml 含三个模型条目」的一半）。
  （组 1.5 的结论与 owner 2026-10-07 的决定：来自 `MODEL_CATALOG` 的推理模型必带 `efforts`，其条目一律有 `thinking`；`MODEL_CATALOG` 未设置的缺省启动不写 `thinking`，「字节不变」断言保持。三模型一例的 `MODEL_CATALOG` 须给每个推理模型写 `efforts`。）

  **实施注记（3.1 / 3.2，fixture 评审补充）**：
  - 写出器的另外两个调用方随签名一起改，否则类型检查不过：`server/test/linux/uid-isolation.test.ts` 与 `server/test/support/omp-official.ts`。二者今天省略 `reasoning`，改为单模型且 `reasoning: false`，输出字节不变。它们只在 CI 的 uid-isolation job 里运行，本机只有类型检查看得到——PR 里点名。
  - 写出器入参的模型类型用 `import type { CatalogModel } from "../model-catalog.js"`（只导类型，不导解析器，不另写一份结构类型）。
  - 「改动前夹具」已经存在：`model-proxy-reasoning.test.ts` 里的 `plainYaml` / `reasoningYaml`。不另存第二份；启动布局测试要用时搬到共享测试辅助，并把模型 id 参数化。
  - `model-proxy-reasoning.test.ts` 的「`reasoning:false` 与省略 `reasoning` 逐字节相同」一例里「省略」的一半在新签名下不可表达：删去这一半并写进偏离记录（「断言不变」对这一例不成立）。
  - 三模型启动例不得设 `MODEL_REASONING`。`AgentSettings` 的派生字段 `modelId` / `modelReasoning` 本刀不删（组 7）。
  Risk packs（组 3）: Legacy compatibility（单模型字节不变）、File format consumed by omp（键序 `thinking` → `input`）、Atomic write（空数组拒绝且不动既有文件）。

Suggested fixture level: expanded - 改一个被 omp 直接消费的文件格式；单模型输出逐字节不变是兼容性约束
Minimal mergeable slice: atomic - 写出器签名变化必须与其唯一调用点同刀，否则类型检查不过

## 4. core/db — 迁移 040、041、042

- [x] 4.1 `server/src/core/db/migrations/040_chat_session_composer.sql`（session-composer-settings「迁移 040」）。测试新文件 `server/test/core-db-session-composer.test.ts`：新库与存量库、列约束（`reasoning_effort` 的 CHECK 是七个强度名，`auto` 被拒绝）、中途失败原子回滚三条场景；受信任迁移目录计数断言加一（`core-db-catalog.test.ts` 等处）。
  **实施注记（4.1，fixture 评审补充，#993）**：
  - 040 的内容是 `chat_sessions` 上的三条 ADD COLUMN（没有新表；新表是 041），逐字照规格、顺序 `approval_mode`、`model_id`、`reasoning_effort`：都可空、无 DEFAULT；`approval_mode` 带 `CHECK (approval_mode IN ('always-ask','write','yolo'))`，`reasoning_effort` 带 `CHECK (reasoning_effort IN ('off','minimal','low','medium','high','xhigh','max'))`。文件不含事务语句、DEFAULT、索引；头注释照 037 的风格。存量行的 `NULL IN (...)` 求值为 NULL、CHECK 通过，不需要 `IS NULL OR`。
  - 「紧随上一个回执」：`POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_040)`；存量库用 `TRACKED_MIGRATION_FILENAMES.slice(0, POS)` 做种；断言 `ledgerRows(db)[POS]` 等于 `[POS+1, MIGRATION_040]`、前一格是前一个文件、040 的回执恰一条。不用 `.at(-1)`、不写死 `14`。
  - 三条场景照 `core-db-session-archive.test.ts` 与 `core-db-turn-snapshots.test.ts` 的先例：新库（`:memory:` 与新文件各一例）；存量库（种到 039、前后状态相等、三列全 NULL、`PRAGMA foreign_key_check` 为空、重开两次目录不变）；三列各断言 `pragma_table_info` 的 `notnull=0`、`dflt_value=null`；列约束（`''`、`Write`、`High`、`auto` 被拒）。
  - 回滚场景预置的冲突列用 **`reasoning_effort`**（040 的最后一条语句），失败后断言 `approval_mode`、`model_id` 都不在 `chat_sessions` 上、回执与数据不变，`DROP COLUMN reasoning_effort` 后重开 040 恰一次。预置第一列证明不了回滚（规格该场景的括号已随本 PR 改正）。
  - 必须同步的既有断言（以 `make check` 的红项为准，下面是起点）：`server/test/core-db-helpers.ts`（`MIGRATION_040`、`COMPLETE_CATALOG`、计数 13 → 14）、`core-db-session-fixture.ts`（`expectChatSchema` 列尾加三行）、`core-db-chat-schema.test.ts`、`migration-034.test.ts`（列尾、回执列表、排除表、`.at(-1)` 改成钉 039 的下标）、`core-db-chat-step-output.test.ts`（排除表）、`core-db-session-todo.test.ts`、`core-db-turn-snapshots.test.ts`、`core-db-workspace-temporary.test.ts`。凡 `slice(-n)` / `.at(-1)` / 整列相等的写法改成钉住具体下标或前缀比较，免得 041、042 来时再改一遍。不放宽、不删任何断言。
  - 属于 040 的变异（写进 PR；任务号 4.4 在 #995 勾）：去掉任一列的 CHECK → 「列约束」红；把 `auto` 加回强度 CHECK → 红；任一列加 DEFAULT → 「新库与存量库」红。
- [ ] 4.2 `041_account_composer_prefs.sql`（「迁移 041」）。测试并入同文件：建表与约束、随账号级联。
- [ ] 4.3 `042_chat_message_attachments.sql`（message-attachments「迁移 042」）。测试并入同文件：新库与存量库、中途失败原子回滚。
- [ ] 4.4 变异证据：去掉任一 CHECK、给列加缺省值、把 041 写成 `IF NOT EXISTS` → 对应场景判红。三个文件按编号顺序各自独立应用。本组在 C 的 037–039 合入之后才合入（见文首；不得让 040 先于 037–039 进入任何持久库）；测试断言 040「紧随上一个回执」而不是写死序数。

Suggested fixture level: expanded - schema 变更（两处 ADD COLUMN、一张新表），含存量库升级与失败原子性
Minimal mergeable slice: 4.1 + 4.2 一刀（会话设置所需）；4.3 一刀（附件所需）；新列与新表此时无人读写，主干行为不变

## 5. web lib — DTO 解析接受新旧两种键集（三步走的第一步）

- [x] 5.1 `web/src/lib/session-contract.ts`：按 design D16「三步落地」第 1 步列出的过渡接受规则改解析（规格只描述最终形状，过渡规则以 D16 为准）——`parseSession` 接受 C 之后的十一键，或十一键加三键（三键同现同缺；缺时解析为 `write` / 空串 / `null`）；消息解析接受带或不带 `attachments`（缺时 `[]`；助手消息非空拒绝）；`parseSessionFork` 与 C 的 undo 响应解析接受带或不带 `attachments`（缺时 `[]`）。
  `ChatSession`、`ChatMessage`、`ChatSessionFork` 与 undo 结果类型加上新字段。这是合同迁移的过渡分支，不是并行实现（AGENTS「Code Canonicality」）：在该文件顶部注释写明它由任务 13.5 删除，并引用本 change 名。
- [x] 5.2 测试（`web/test/` 里会话合同解析的既有文件，或新文件 `web/test/session-contract-composer.test.ts`）：design D16 第 1 步的每一条——十一键会话通过并解析为 `write` / 空串 / `null`；带齐三键的十四键会话通过；只带 `approvalMode` 的会话整体拒绝；带与不带 `attachments` 的消息都通过（后者为 `[]`）、助手消息非空拒绝；`{session, draft}` 的 fork 响应与 `{session, draft, files}` 的 undo 响应通过且 `attachments` 为 `[]`，带 `attachments` 的同样通过。
  既有的严格解析用例（C 的十一键、`undo` 键）的接受 / 拒绝判定不变；解析输出现在带缺省值，拿输出与输入做等值断言的既有期望经共享夹具升级（见下方实施注记），逐文件写进 PR 偏离记录。变异：允许只带一键、缺 `attachments` 时拒绝 → 判红。
- [x] 5.3 让新字段流到视图状态但不使用：`web/src/features/chat/stream.ts`（753 行，注意余量）/ `types.ts` 里由快照构造视图消息与会话的地方带上 `attachments` 与三键（纯透传）；`runtime-convert.ts` 把 `attachments` 作为应用自有字段透传。既有归约与渲染测试的判定不变（视图等值断言的期望随夹具带上 `attachments`）；本任务不渲染任何新界面。
  **实施注记（5.1–5.3，fixture 评审补充，#996）**：
  - 接受矩阵（会话）：恰十一键 → 通过并补 `approvalMode:"write"`、`modelId:""`、`reasoningEffort:null`；恰十四键 → 通过并逐值保留；只带一键或两键、或多出别的键 → 整体拒绝。写法：两次 `hasExactlyKeys`（十一键表、十四键表），都不中即 `null`。
  - 三键在场时的值域（取规格最终形状）：`approvalMode ∈ {always-ask, write, yolo}`；`modelId` 任意字符串（含空串——「空串非法」是 13.5 的收紧项）；`reasoningEffort ∈ {off, minimal, low, medium, high, xhigh, max}` 或 `null`，`"auto"` 拒绝。
  - 消息：恰九键 → `attachments: []`；九键加 `attachments` → 解析；元素恰 `{path, size}`（`path` 非空字符串，`size` 非负安全整数），`null`、非数组、多键、负数拒绝；`role === "assistant"` 且非空 → 整条消息（即整个快照）拒绝。
  - fork：`{session, draft}` 或加 `attachments`；undo：`{session, draft, files}` 或加 `attachments`；缺 → `[]`；元素规则同上；其它键集拒绝。
  - 类型：新字段一律 required（optional 会让 13.5 多一轮类型改动，等值断言也照样红）。过渡分支集中成一处（一个小 helper 加缺省常量），13.5 可整块删。
  - 顶部注释放在 `session-contract.ts` 第 1 行 import 之前，须含可 grep 的字面量 `s1g-composer-capabilities` 与 `任务 13.5`，并写一句理由（合同迁移的过渡分支，服务端组 8、12 发出新键后由 13.5 删除，不是并行实现）。AGENTS.md 没有成文的例外条款，注释写理由，不写「引用例外」。
  - 5.3 透传（不渲染）：`stream.ts`（现 753 行）的 `ChatMessageView` 加 `attachments`，`chatStateFromSnapshot` 带上，`turn.start` 字面量与 `emptyAssistant` 各加 `attachments: []`；`runtime-convert.ts` 的 `ChatMessageCustom` 的 `Pick` 加 `"attachments"`，`convertMessage` 的 `custom` 带上。会话三键不经 `stream.ts`：它们随 `ChatSession` 类型到达 `ChatListState.sessions` 与历史快照，无需代码。不在 `features/chat/` 下新建文件。
  - 既有测试：解析输出现在比输入多键，拿输出与原始输入做 `toEqual` 的既有用例必然要改期望（`session-contract-metadata`、`session-contract-undo`、`api-undo`、`api-sessions`、`api-turn-control`、`api-sessions-metadata`、`chat-stream` 等）。规则：**接受 / 拒绝的判定不变**；等值断言的期望经共享夹具升级（`web/test/session-meta-fixtures.ts` 的 `NULL_SESSION_META` 直接升到最终十四键、`modelId` 用非空值；消息的带类型字面量与被比较的期望集中在 `chat-stream-support.ts`、`chat-page-ownership-support.ts`、`chat-runtime-convert.test.ts`；线上 JSON 体不必改）。逐文件写进 PR 偏离记录；不得删断言、不得放宽匹配器。`tsc --noEmit` 覆盖 `web/test`，required 字段会逐一点名。
  - 新测试文件 `web/test/session-contract-composer.test.ts`（13.5 整文件删）：design D16 第 1 步逐条，加一条视图透传（带附件的快照经 `chatStateFromSnapshot` 与 `convertMessage`，`custom.attachments` 逐值相等）。
  - 变异：允许只带 `approvalMode` → 「只带一键拒绝」红；缺 `attachments` 时拒绝 → 消息、fork、undo 三条红；去掉助手非空拒绝 → 红；缺省 `write` 改成别的值 → 红。

Suggested fixture level: expanded - 改严格解析的公共合同（会话 / 消息 / fork DTO），是服务端发出新键的前置
Minimal mergeable slice: atomic - 解析放宽、类型与透传必须同刀（类型一变透传处即编译不过）；合入后服务端尚未发出新键，界面无变化

## 6. omp-test-harness — 假 omp 的 approval-write 与模型命令

- [x] 6.1 先腾出行数：把 `server/test/support/fake-omp.mjs`（799 行）里一段既有的纯构建代码原样搬到新模块 `server/test/support/fake-omp-composer.mjs`（或搬到已有的纯构建模块，以不破坏「假 omp 夹具模块划分」为准），只搬不改，既有 fake-omp 测试原样通过。单独一次提交。
- [x] 6.2 `fake-omp-composer.mjs`：`approval-write` 的常量与帧数据构建、`set_model` / `set_thinking_level` 的应答数据构建与两个失败取值的判定（纯函数）。`fake-omp-argv.mjs`：场景表加 `approval-write`。`fake-omp.mjs`：接线——场景分派、两种命令的应答、`get_state` 带上最近一次成功应用的 `model` / `thinkingLevel`（状态在这里）。
- [x] 6.3 测试新文件 `server/test/fake-omp-composer.test.ts`：omp-test-harness delta 的两条新场景（`approval-write` 只在 `always-ask` 下请求确认；两种命令的应答与 `frames=`）；既有十二个场景的帧逐字节不变（跑既有测试即可）。
  `server/test/` 里核对模块划分的用例（导入方向、五个文件 ≤800 行）随规格更新。变异：`approval-write` 在 `write` 档也发 select、失败模型 id 也应答成功 → 判红。

  **实施注记（fixture 评审补充）**：
  - `get_state` 今天就带 `model` 与 `thinkingLevel`（夹具自第一版起如此），规格已改为「首次命令之前保持今天的值」；既有场景的 `get_state` 应答不变。
  - `fake-omp-argv.mjs` 没有场景表（只有取值型 / 布尔型 argv 表），6.2 的「场景表加 `approval-write`」实际落在 `fake-omp.mjs` 的场景集合，写进偏离记录，不为此造一张表。
  - `fake-omp.mjs` 已 774 行：帧构建全部放 `fake-omp-composer.mjs`，主文件只留分派与状态；仍超 800 就先做一次纯搬迁（单独提交）。
  - 核对模块划分的用例是两处，都还没有 composer：`server/test/fake-omp-early-abort.test.ts`（四文件 → 五文件）与 `server/test/fake-omp-metadata-scenarios.test.ts`（`expectNodeOnlyLeaf` 的正则与循环）。`fake-omp-composer.mjs` 没有任何 import，对它放宽「至少一条 import」的断言，不为过断言加假的 `node:` 导入。
  - 「回合在途时到达的命令在该回合终态 `agent_end` 之后应答」须有一例（例如 `approval` 场景、`--approval-mode write`，select 挂起时发 `set_model`，应答排在 `agent_end` 之后）；持有型回合需要显式的在途标记，在终态 `agent_end` 处冲刷。
  - `write` 的 `tool_execution_end` 复用既有的构建函数，夹具不真的写文件。
Risk packs: Test fixture / frame compatibility（既有十二个场景的帧逐字节不变）、Ordering（命令与在途回合的先后）。未选：产品代码、Schema、Auth。
Suggested fixture level: compact - 只改测试夹具；不触产品代码与公共入口
Minimal mergeable slice: 6.1 一刀（纯搬迁）；6.2 + 6.3 一刀（新场景与命令应答，带测试）

## 7. omp-runtime — argv 按会话取值与两种命令帧（Critical Path）

- [x] 7.0 `supervisor.ts` 行数预算（**行为不变的重构，如需则单独一个 PR**）：本 change 在该文件里的改动面只有三处——7.3 的调用点多传 `approvalMode` 与 `modelId`（至多 4 行）、9.1 的「启动档位不同则先退役」调用（至多 10 行）、9.2 的派发前对齐调用（至多 6 行），合计至多 20 行。以 0.1 记下的行数为准：不超过 780 行则本任务无事可做；否则沿用 C 的 10.3 的腾行方式与候选次序（C 的 design D15 第 1 点：`streamCursor` 的取值挪进 `supervisor-subscribers.ts`、`#retain` 挪进 `supervisor-faults.ts`；C 已挪走的跳过），再不足时把 `#retireSlot` 里纯计时的升级阶梯抽成 `pool.ts` 的函数，腾到不超过 780 行即止。验证：`make check`，既有 supervisor 测试原样通过。
  核对记录（#999）：0.1 记下的行数是 779，不超过 780，本任务无事可做，未产生代码改动。
- [ ] 7.1 `server/src/sessions/omp/process.ts`（788 行）与 `omp/runtime.ts`（798 行）：
  第一次提交（纯搬迁）：把 `runtime.ts` 里 `command()` 入参的内联帧联合类型（现 `runtime.ts:259-262`）原样搬到 `omp/commands.ts`（350 行）并具名导出，`runtime.ts` 只引用它（净减约 3 行）；行为不变，既有测试原样通过。
  第二次提交：`SpawnOmpOpts` 增 `approvalMode`，argv 的 `--approval-mode` 取它；不是三个字面量之一时不 spawn（抛出，走既有的准备失败路径）；`--model` 仍取 `opts.modelId`（调用方此后传会话的有效模型）。`OmpProcessOpts extends SpawnOmpOpts`，而 `runtime.ts:426-431` 是逐字段显式构造 `new OmpProcess({…})`——所以 `SessionRuntimeOpts` 同刀增 `approvalMode` 并在该构造处透传（约 +4 行，由第一次提交腾出）。`process.ts` 余量只有十来行：档位校验函数放进 `commands.ts`，不要顶破 800。1.0 留下的测试用 spawn 包装在本任务删除（world 改为直接传 `approvalMode`）。
  测试 `server/test/omp-process.test.ts` / `omp-spawn-cwd.test.ts`：omp-runtime delta「参数与目录」的改写断言、「档位与模型按会话进入 argv」「非法档位不 spawn」。变异：argv 写死 `write`、非法档位回退为 `write`、`runtime.ts` 不透传（`OmpProcess` 收到 undefined）→ 判红。
- [ ] 7.2 `omp/commands.ts` 与 `omp/runtime.ts`：`command()` 的帧联合类型（7.1 已搬到 `commands.ts`）加 `set_model`、`set_thinking_level`，新增的判定辅助也放 `commands.ts`；`runtime.ts` 不加行。
  测试 `server/test/omp-runtime-commands.test.ts`：omp-runtime「模型与推理强度命令」三条场景（假 omp 真子进程，依赖组 6）。变异：命令在回合中不抛 `SessionBusyError`、失败应答不拒绝 → 判红。
- [ ] 7.3 `server/src/sessions/pool.ts`（324 行）：`sessionRuntimeOpts` 的 per-runtime 入参增 `approvalMode` 与 `modelId`，不再读 `base.modelId`；本任务里 supervisor（`supervisor.ts` 的 `sessionRuntimeOpts` 调用处，对象字面量加两个属性，用 7.0 的余量）、branching 与 C 的撤回编排（`undo.ts` 的临时进程）的调用点先一律传 `"write"` 与白名单缺省模型（行为与今天相同，组 9 再换成会话的有效值）。
  测试：既有 dispatch / fork / regenerate 用例原样通过；`omp-host-overlay.test.ts` 加「overlay 不随档位变化」场景（三种档位各 spawn 一次后文件字节不变、`--config` 路径相同）。
- [ ] 7.4 清理：`AgentSettings` / `SessionSupervisorRuntime` 上已无读者的 `modelId`、`modelReasoning` 字段删除（knip 把关）；`omp/host-overlay.ts` 的文件头注释按 omp-runtime delta 改写（argv 压过 overlay、文件不随档位变化），常量字节不动（`omp-host-overlay.test.ts` 的逐字节断言原样通过）。

Suggested fixture level: expanded - omp 子进程 spawn 契约（审批档位）与运行时公共命令面；Critical Path
Minimal mergeable slice: 7.0 一刀（仅当需要腾行）；7.1（搬迁提交 + argv 与透传提交）+ 7.3 一刀（档位从 `pool.ts` 的入参贯通到 argv：`pool.ts` → `SessionRuntimeOpts` → `OmpProcess` → `spawnOmp`，调用点仍传 `write`，行为不变，类型检查通过）；7.2 一刀（两种命令帧）；7.4 随第一刀或单独一刀

## 8. sessions store + REST — 会话的三项输入框设置

- [x] 8.0 `store.ts` 腾行（**纯搬迁，单独一次提交 / PR，行为不变**）：按 0.1 记下的落点——C 的 1.3 若已把 `SessionView` / `SESSION_COLUMNS` / `SessionDbRow` / `toSessionView` 搬出 `store.ts`（到 `store-view.ts` 或 `store-branch.ts`），沿用 C 的落点，本任务只确认 `store.ts` 的余量不少于 15 行，不足时把 `runtimeState` 的行映射也搬到同一个文件；
  C 若把它们留在了 `store.ts`，本任务把这四个符号原样搬到新文件 `server/src/sessions/store-view.ts`（`store.ts` 改为从它导入并照旧再导出，调用方不动）。15 行的用途：8.1 的 `runtimeState` 三列（约 +4）与视图构造多收一个配置参数（约 +3）、12.2 的 `acceptPrompt` 多一个参数与一次调用（约 +4）。验证：`make check`，既有 store 与 REST 测试原样通过。
  核对记录（#1003）：C 的 1.3 已把四个符号搬到 `store-view.ts`，沿用该落点；`store.ts` 766 行，余量 34 行，不少于 15 行，未产生代码改动。
- [ ] 8.1 只读半边——会话视图发出三键：新文件 `server/src/sessions/store-composer.ts`（本任务只放读取：三列的列名常量、行到原始值的映射）；`SESSION_COLUMNS` 加三列、`toSessionView`（在 8.0 确定的文件里）统一经 `effectiveComposer`（组 2.3）加上三键——只有一处构造函数，列表、创建、PATCH、快照、fork、undo 共用；`runtimeState` 增报三个原始列（供组 9）。此时三列恒为 NULL，视图恒为缺省有效值。
  测试新文件 `server/test/session-composer-store.test.ts`：三列为 NULL 的行读成缺省有效值；直接写库的原始值经夹取 / 回落后进入视图（session-composer-settings「夹取与回落」在视图层的两例）；`runtimeState` 报出原始列。chat-sessions「Session views carry the three composer settings」里创建与列表两个出口的键集断言。
- [ ] 8.2 REST 创建：`store-composer.ts` 增写入——创建时三列的取值（请求值 / 最近选择 / NULL）、`account_composer_prefs` 的读取与 upsert（只改所给列）；经 `store.ts` 的既有事务原语组合进创建事务（`store-metadata.ts` 189 行有余量，创建的入口在那里；C 的临时空间创建在同一个事务里，次序不变）。`server/src/sessions/rest-metadata.ts`（209 行）的 `POST /api/sessions` 接受三键并校验（session-metadata「会话创建与空间绑定」、session-composer-settings「创建会话时的设置与继承」；`reasoningEffort` 只校验是七个强度名之一且所对模型支持推理，不校验是否在该模型的可选强度内）；创建时的 `session.permission` 审计只按 session-permission-tier「档位变更审计」的条件（session-metadata 不另述条件）。
  测试新文件 `server/test/session-composer-rest.test.ts`（`session-rest.test.ts` 789 行不加）：「缺省与显式」「新会话沿用最近选择」（含继承 `yolo`：owner S-21）「非法取值」「创建时的审计」两段（含 `APPROVAL_MAX_MODE=always-ask` 下三次创建都不写）；`session-composer-store.test.ts` 加：upsert 只改所给列、事务回滚（审计失败时会话行、空间行与最近选择都不落）。
- [ ] 8.3 REST 修改：`PATCH /api/sessions/:id` 的键集由 C 之后的四键 `{title, scene, pinned, archived}` 扩为七键；三键的校验（`reasoningEffort` 的规则同 8.2，不按可选强度拒绝）、写列、更新最近选择、有效档位变化时的审计（同一事务）；不调用 supervisor、不向 omp 发帧。测试同文件：session-composer-settings「修改并回显有效值」「运行中修改不触及在途回合」（假 omp 真子进程：回合在途时 PATCH，假 omp 没有收到新帧、进程未退出、回合照常结束）「非法取值与越过最高档」「隔离」、session-permission-tier「修改与重复选择」「审计失败则修改不生效」「调低上界后既有会话被夹取」的视图部分。
  既有 `session-metadata-rest.test.ts` 里断言「PATCH 不写审计」的用例按 delta 改写为「除 `session.permission` 外不写审计」（偏离记录）；C 的 `archived` 用例原样通过。
- [ ] 8.4 fork 继承：`server/src/sessions/store-branch.ts`（266 行）的 `copyForkHistory` / fork 事务复制三列原始值；不动最近选择、不写 `session.permission`。测试 `server/test/session-fork-metadata.test.ts`：session-metadata「继承三项设置」与 turn-control「分叉继承三项输入框设置」的存储与视图部分（argv 与帧序在组 9）；C 的「继承临时空间」「分叉共用临时空间且不带快照」原样通过。
- [ ] 8.5 `GET /api/composer/options`：新文件 `server/src/sessions/rest-composer.ts`，由 sessions 模块注册（与 `rest-commands.ts` 同样的接法；装配处把 `modelCatalog`、`approvalMaxMode`、两个上传上限传进来）。测试同 8.2 的文件：「缺省配置」「封顶、白名单与账号各自的缺省」；http-service-skeleton「四个新配置键的取值与非法值」里合法四键启动后 `GET /api/composer/options` 的回报（编译入口，`server-startup-layout.test.ts`）。
- [ ] 8.6 与 8.1 同刀：既有断言会话视图「恰十一键」的服务端测试与 `smoke/*.hurl` 断言改为十四键——session-metadata「会话视图扩展键」的两个改写场景、chat-harness「会话元数据 HTTP 冒烟」第 1、3 步（`count == 14` 与三键的缺省值）、turn-control / session-metadata 的「fork 响应的会话视图与列表一致」、C 的 undo 响应里的 `session`；`make smoke` 通过（web 已由组 5 接受新键）。
- [ ] 8.7 变异证据，按刀分配——8.1 + 8.6：视图直接回显原始列（不夹取）→「调低上界」的视图部分与「夹取与回落」判红；少发一键 → 十四键断言判红。8.2：创建不继承最近选择 →「新会话沿用最近选择」判红；创建时按模型的可选强度校验 `reasoningEffort` →「新会话沿用最近选择」里 `{modelId:"m3", reasoningEffort:"xhigh"}` 的 201 判红；放行 `auto` →「非法取值」判红；继承 `yolo` 的创建不写审计、或上界 `always-ask` 下的缺省创建写了审计 →「创建时的审计」判红。8.3：PATCH 不更新最近选择 →「沿用最近选择」判红；PATCH 时按模型的可选强度校验 `reasoningEffort` →「修改并回显有效值」的 `{reasoningEffort:"xhigh"}` 一步判红；放行 `auto` 或不支持推理的模型下的 `reasoningEffort` →「非法取值与越过最高档」判红；重复选择也写审计 →「修改与重复选择」判红；PATCH 调用了 supervisor 或向 omp 发帧 →「运行中修改不触及在途回合」判红。8.4：fork 不复制三列 →「继承三项设置」判红。

Suggested fixture level: expanded - 公共 API（会话视图键集、POST / PATCH body、新端点）、持久化、审计与账号隔离
Minimal mergeable slice: 8.0 一刀（纯搬迁）；8.1 + 8.6 一刀（视图发出三键必须与全部「恰十一键」断言的改写同刀：键集一变所有会话视图断言同时变；此刀三键恒为缺省值）；8.2 一刀（创建入参、继承与创建审计——新测试文件里的新行为，不触动既有断言）；8.3 一刀（修改入参与修改审计）；8.4 一刀；8.5 一刀。8.7 的变异证据随各自的刀。此时设置可存可读但尚不影响进程（组 9）

## 9. sessions supervisor — 派发前按会话设置对齐进程（Critical Path）

- [ ] 9.1 档位：`pool.ts` 的 `Slot` 增 `approvalMode`（启动档位）；`branching.ts` 的 `Resume` 增三项原始值；`supervisor.ts`（C 结束时不超过 792 行；本任务的行数用 7.0 腾出的余量）的 `#onSlot` 判定「存活 slot 的启动档位 ≠ 有效档位 → 先 `#retireSlot` 再 `fresh()`」。把有效值计算与「是否可复用」的判定写成新文件 `server/src/sessions/composer-align.ts` 里的函数，`supervisor.ts` 只调用（至多 10 行，用 7.0 的余量，行数写进 PR 描述）。regenerate 的取得进程处用同一个判定（turn-control「重新生成 REST」：存活进程的启动档位不同时先退役）。
  组 7.3 留下的调用点改为传会话的有效档位与有效模型（fork 与 C 的撤回的临时进程取该会话的）。
  测试新文件 `server/test/session-composer-dispatch.test.ts`（假 omp 真子进程 + 记录 argv 的 spawn 包装）：chat-sessions「档位不同则以新档位重启」「修改设置本身不动进程」「对齐期间的并发请求」、session-permission-tier「档位进入 argv」「生成中改档位」「未改档位不重启」「调低上界」的 argv 部分；turn-control「档位不同时先退役再重新生成」「分叉继承三项输入框设置」的 argv 部分。
- [ ] 9.2 模型与强度：`Generation`（`pool.ts`）增「已应用的模型与强度」；`composer-align.ts` 里实现 chat-sessions「派发前按会话设置对齐进程」第 2 步（先 `set_model` 后 `set_thinking_level`，成功后才记）。两个调用点：prompt 路径在取得进程之后、`#bindDispatch` 写 `prompt` 之前；regenerate 路径在取得进程之后、`get_branch_messages` 之前（`branching.ts` 的 regenerate 编排里，先于 `branch` 与事务——失败属事务前，行不变）。`supervisor.ts` 至多 6 行。
  测试同文件：model-selection「换模型与强度后的帧序」（逐字核对 `frames=`）、「新进程重新应用」「生成中修改不打断」「命令失败按派发前失败处理」「消息不带模型」（两个模型下各完成一个回合后：快照每条消息的键集恰为 chat-sessions「会话 REST」所列、`PRAGMA table_info(chat_messages)` 没有模型或强度列）；chat-sessions「对齐失败按派发前失败补偿」「regenerate 的对齐失败不动任何行」「regenerate 用当前设置」（帧序：`set_model`、`set_thinking_level` 先于 `get_branch_messages`）；turn-control「模型对齐失败发生在事务之前」；session-metadata「继承三项设置」的 argv 与帧序部分。
  既有经宿主驱动假 omp 并断言完整 `frames=` 序列的宿主测试（`grep -rn "frames=" server/test` 里以 `negotiate_protocol,get_state,prompt` 开头的宿主级断言）按「每个 generation 首次派发多 `set_model` 与 `set_thinking_level`」改写并写进偏离记录；假 omp 夹具自身的单元用例（`fake-omp.test.ts`）不经宿主，不改。
- [ ] 9.3 审批在非 `write` 档下的端到端：`server/test/session-approvals*.test.ts` 新增一例——`always-ask` 会话 + 假 omp `approval-write`：登记、事件、作答、`chat_approvals.tool="write"`、审计（tool-approval delta 场景）；session-permission-tier「每次都问下的超时」（注入时钟 59999 / 60000）。
- [ ] 9.4 变异证据：去掉档位比较 →「以新档位重启」判红；PATCH 时就退役 →「修改设置本身不动进程」「生成中改档位」判红；`set_thinking_level` 先于 `set_model` → 帧序判红；每次派发都无条件发命令 → 帧序第三条 prompt 处判红；新 generation 不重发 →「新进程重新应用」判红；命令失败后仍写 prompt →「命令失败」判红；把 regenerate 的对齐挪到事务之后 →「regenerate 的对齐失败不动任何行」「模型对齐失败发生在事务之前」判红（旧助手行被删）。
  「对齐期间的并发请求」钉的是既有的认领 fence（对齐发生在认领之后），没有独立变异，写进偏离记录。
- [ ] 9.5 `make smoke` 通过（缺省配置下全部会话为 `write`、单模型：除每个 generation 首次派发多一条 `set_model` 加一条 `set_thinking_level` 外行为不变；真 omp 对这两条命令的应答已由组 1 核对）。

Suggested fixture level: expanded - omp 子进程治理（审批策略放宽开始生效）、并发与补偿路径、生成世代；Critical Path
Minimal mergeable slice: 9.1 一刀（档位重启，含 argv 取会话有效值）；9.2 一刀（模型与强度的 RPC）；9.3 随 9.1；9.5 随各刀

## 10. core — 沙箱 `op=write` 与上传错误码

- [x] 10.1 `server/src/core/sandbox/resolve.ts` 与 `index.ts`：`op` 联合类型加 `write`，词法规则与 `mkdir` 相同（共用同一段判定，不复制）。测试 `server/test/sandbox-resolve.test.ts`：sandbox-core delta「合法路径与边界」的 `write` 部分、「写操作的逃逸向量」、「非目录祖先不是越界」的 `write`；`sandbox-facade.test.ts` 加一例 `op=write` 被拒时审计 `detail.op="write"`。
  变异：`write` 不查最后一段反斜杠、`write` 跟随 `uploads` 符号链接 → 判红。
- [x] 10.2 `server/src/core/errors`：新增 `upload_too_large`（413，`文件超过大小上限`）。测试 `server/test/http-typed-errors.test.ts`：http-service-skeleton delta「上传超限码的信封形状」；断言码数的既有用例由 C 之后的十五改为十六。
- [x] 10.3 `server/src/http`（content-parser 归属表）：加入 `POST /api/workspaces/:id/uploads`。测试 `server/test/http-parser-owners.test.ts`：归属身份数由 C 之后的十四改为十五（「产品路由身份在共享映射器中的归属」的路由清单加上传路由）；「上传路由的 parser 归属」的映射层部分用测试路由钉住（真实路由在组 11）。
  **实施注记（10.2 + 10.3，fixture 评审补充；两条同一个 PR）**：
  - 10.2 单靠 `core/errors` 与 `http-typed-errors.test.ts` 过不了：`server/src/http/errors.ts` 的状态表是 `satisfies Record<HttpErrorCode, number>`（须加 413）；`server/test/auth-lifecycle.test.ts` 的穷尽表与 `server/test/http-parser-owners.test.ts` 的码集合断言也要同步（十五 → 十六）。名字里带计数的常量随之改名，逐处记偏离。
  - 「上传超限码的信封形状」另需一条「两种 413 以 code 区分」（`preview_too_large` 仍是它自己的 code / message）；伪造对象与 no-store 两条经既有的新码过滤表自动覆盖。
  - 10.3 的身份恰为 `POST /api/workspaces/:id/uploads`（模板不含查询串）。真实路由在组 11：本刀只在 `handleHttpError` 接缝上证明（身份 × 四种 content-parser 错误 → 400；同模板换方法不在集合内）。「上传路由的 parser 归属」两个 WHEN 的真实 HTTP 一半（400 / 404 / 401、no-store、不落文件与审计；超限是 413 不是 400）归 11.2 / 11.3，届时点名这条场景。
  - 接缝上「真实的 body-too-large 在该身份上映射为 400」只是按身份映射的结果，不等于允许真实路由用框架的 `bodyLimit`；11.3 钉 413。

Suggested fixture level: expanded - 沙箱路径安全（Critical Path）与统一错误信封的定义表
Minimal mergeable slice: 10.1 一刀（`write` 尚无调用方；类型联合的扩大不产生未引用导出）；10.2 + 10.3 一刀（新码与归属身份，组 11 的前置；等 C 的 2.1、4.2、11.1 合入，不随 10.1 提前）

## 11. workspaces — 文件上传端点（Critical Path）

- [x] 11.1 新文件 `server/src/workspaces/upload.ts`：流式落盘的纯 IO 部分——独占创建临时文件（`wx`、mode 精确 `0660`）、带上限的计数管道、失败清理、候选名生成（`<主名> (n)<扩展名>` 规则）与 `link` 定名循环。不依赖 Fastify。
  测试新文件 `server/test/workspace-upload-io.test.ts`（真实临时目录）：编号规则表（`a.pdf`、`README`、`.env`、`archive.tar.gz`）、并发同名各得其名、读取中超限即停并清理、流出错清理、mode 不随 umask（`000` 与 `077` 各一例）、目标已是符号链接时不跟随。
  **实施注记（11.1，fixture 评审补充，#1014）**：
  - 导出面（按 11.2 路由第 7、8 步的用法）：一个函数，如 `storeUpload({ dir, name, source, maxBytes })`，返回 `{ name, size }`。`dir` 是路由已过沙箱并建好的目录的绝对路径，`name` 是路由已校验的单段名字，`source` 是 `Readable`。路由要分得清三种结果：超限（413）、名额用尽（409）、其余原样上抛（500）。`server/src/core/errors/index.ts` 没有任何 import，直接抛 `HttpError("upload_too_large")` 与 `HttpError("conflict")` 不违反「不依赖 Fastify」；用哪种写进模块头注释。只导出测试要 import 的东西，不单独导出候选名生成器，不加 `signal` 参数。
  - 临时文件：`join(dir, ".upload-" + randomBytes(16).toString("hex") + ".part")`，与目标同目录；`fsp.open(temp, "wx", 0o660)` 后立刻 `handle.chmod(0o660)`（规格写的是精确 0660，不照搬还原的「先 0600 再放宽」）。上传期间它在目录列举里可见，design Risks 已接受，不改 `tree.ts`。
  - 计数管道：`pipeline(source, 计数 Transform, handle.createWriteStream())`；判定是 `total > maxBytes`（恰等于上限合法，0 字节合法），越界的那一块不写盘；`pipeline` 销毁 source 即「即停」。
  - 清理：`finally` 里关句柄；任何抛出都 `rm(temp, { force: true })`（超限、流错、写盘失败、`link` 的非 `EEXIST` 错误）。不做 fsync。
  - 候选名：`lastIndexOf(".")` 的结果 `<= 0` 视为无扩展名（不用 `path.extname`）；n 从 1 到 999，连原名共 1000 个候选。`a.pdf` → `a (1).pdf`；`README` → `README (1)`；`.env` → `.env (1)`；`archive.tar.gz` → `archive.tar (1).gz`。
  - `link` 定名循环：`fsp.link(temp, join(dir, 候选))`，`EEXIST` 换下一个，其它错误上抛，成功后 `unlink(temp)`；没有 rename / copy 退路。候选名已是符号链接（含悬空链接）时 `link` 不跟随、报 `EEXIST`，取下一个候选，链接与其目标不变——这就是「不跟随」。
  - 规格没写到的三个分支，按下述处理并写进 PR 偏离记录：编号后名字超长（`ENAMETOOLONG`）按普通写失败（清临时文件，上抛）；1000 个候选全占用 → 名额用尽的错误，补一例测试（预建 1000 个名字，断言错误、临时文件已删、没有 `(1000)`）；定名成功后删临时文件失败 → 上抛，不回删最终名。
  - 归属：逐级 `lstat`、沙箱解析、名字规则都在 11.2 的路由里，不在本模块；本模块只留一条前置断言（`name` 含 `/` 或为空就抛），配一例测试。不引入目录句柄（`resolve` 之后父目录被换成符号链接是已登记残余）。
  - 测试（真实临时目录，先 `realpath`）：umask 的设置与恢复照 `server/test/sandbox-dirs.test.ts` 放在 `try/finally` 里；mode 断言 `lstat.mode & 0o7777 === 0o660`，不断言属组；名字不要只靠大小写区分（APFS）。「即停」用永不结束的 `Readable`：断言 reject、`source.destroyed`、已拉取字节数不超过上限加一两个块。并发：两个同名并行，名字集合恰为原名与 `(1)`，内容各自完整。加一例恰等于上限。
  - 变异：去掉 `chmod` → umask `077` 例红；`open` 用 0666 且无 `chmod` → umask `000` 例红；`>` 写成 `>=` → 恰等于上限例红；先读完再判超限 → 「即停」红；不删临时文件 → 超限、流出错两例红；用 `rename` 定名 → 并发例与符号链接例红；先 `exists` 再写 → 悬空符号链接例红；取第一个 `.` 当扩展名 → `archive.tar.gz` 红；不处理开头的点 → `.env` 红；n 从 0 或 2 起 → 编号表红；上界偏一 → 「占满 1000 个」例红。
  - knip：server entry 含 `test/**/*.test.ts`，只被测试引用的导出不算未引用；若仍报，不加临时调用方，停下报告。
- [ ] 11.2 `server/src/workspaces/rest.ts`（现约 175 行）：注册 `POST /api/workspaces/:id/uploads`——空间归属检查放在 preParsing（先于媒体类型解析），route-local 的 `application/octet-stream` 透传 parser，handler 按 workspaces delta「文件上传」的九步次序；`registerWorkspaces` 的依赖加 `uploadMaxBytes`。
  测试新文件 `server/test/workspace-upload-rest.test.ts`（`createApp` + 真 socket，注入式请求测不出流与中断）：「上传并自动建目录」「同名自动编号不覆盖」「超过大小上限」（声明超限不读体、分块超限、恰等于上限）「越界名字被拒绝并入审计」「名字规则与媒体类型」「他人与不存在的空间」「目录被占与审计失败」「临时空间同样可上传，并随最后一个会话删除」（归属判定走所有者作用域的 `rootOf`，对临时空间不加特例）。
- [ ] 11.3 同文件：「中断与残留清理」（真实客户端发一半后断开；无 `.part`、无审计、无挂起请求）与「不进内存的流式写入」（32 MiB，堆增量阈值 8 MiB）。另加一条断言：应用的 `requestTimeout` 与 `connectionTimeout` 为 0（design D10），以及「超限恰为 413 而不是 400」（框架 body limit 没有抢先）。
- [ ] 11.4 竞态现状记录（design D11 / Risks）：一条测试在 `resolve` 之后、打开之前把 `uploads` 换成指向沙箱内另一目录的符号链接，记录当前结果（预期：独占创建落在链接目标里）；用例标题与注释写明这是已登记的残余、不是保证，PR 描述里点名请白盒审查。
- [ ] 11.5 变异证据：先做名字规则再过沙箱 → `../../etc/passwd` 得到 400 而无审计，「越界」判红；用 `rename` 定名 →「同名不覆盖」判红；不删临时文件 →「超限」「中断」判红；先缓冲再写 →「不进内存」判红；归属检查放在 handler 里 → 他人空间加错误媒体类型得到 400，「他人与不存在的空间」判红。
- [ ] 11.6 `smoke/files.hurl`：chat-harness delta 的上传断言（201、编号、目录树、403、400、404）；`make smoke` 通过。

Suggested fixture level: expanded - 文件写入与路径安全、资源上限与大输入、部分输出清理、账号隔离；Critical Path
Minimal mergeable slice: 11.1 一刀（纯 IO，带测试；导出被 11.2 引用前由其测试引用，knip 配置若报未引用则与 11.2 同刀）；11.2 + 11.3 + 11.5 一刀；11.4 一刀；11.6 随第二刀

## 12. sessions — prompt 携带附件

- [ ] 12.1 `server/src/sessions/slash-commands.ts`（480 行）：导出 `attachmentSuffix(paths)`（message-attachments「交给 omp 的附件后缀」的确切字节）；wire candidates 的计算接受附件并接上后缀（chat-sessions delta 的 Branch alignment）。
  测试 `server/test/session-rest-slash.test.ts` 或新文件：「后缀的确切字节」「与斜杠规则的组合」；`server/test/session-regenerate.test.ts` / `session-fork.test.ts`：「Branch alignment of a message with attachments」三例（经既有的 runtime 替身给条目表）；C 的撤回测试文件：message-attachments「带附件消息的撤回对位」（wire candidates 对 undo 同样生效；条目文本缺后缀时 502）。
  只发附件的消息（`content` 为空串）不另写分支：候选恰一个，即后缀本身。测试并入上述文件：「与斜杠规则的组合」的空文本一段（`classifyPrompt("")` 为 `text`、`toWireText("")` 为空串）；「带附件回合的重新生成」的只有附件一段（条目文本为后缀 → 202；去掉开头两个换行的后缀 → 502）；「分叉拷贝与回填」的只有附件一段（`draft:""`）；「带附件消息的撤回对位」的只有附件一段。组 1 的 (g) 若不成立，本任务按 D12 的退路改过的 delta 实现。
- [ ] 12.2 store：附件列的读写放在新文件 `server/src/sessions/store-attachments.ts`（序列化 `[{path,size}]`、NULL 与坏值读作 `[]` 的解析）；`store.ts` 的 `acceptPrompt`（`store.ts:355`）只多收一个附件参数并在插入用户消息行时带上该列（约 +4 行，用 8.0 的余量；`store.ts` 不得超过 800）；`store-branch.ts`（266 行）的消息列集、视图映射与 fork 拷贝带上该列；fork 结果带分叉点消息的附件。
  首个标题的取材（chat-sessions「会话持久化与回合刷盘」的 MODIFIED）：文本非空时照旧取文本；文本为空串时取第一个附件路径最后一个 `/` 之后的部分，再过同一个 `titlePrefix`（`store-branch.ts`）。取材函数放在 `store-attachments.ts` 或 `store-branch.ts`，`store.ts` 里只改 `titlePrefix(text)` 那一处调用（`store.ts:378`），不为空文本另写落库分支——`content` 就是传进来的空串。
  测试（`server/test/session-store*.test.ts` 里覆盖 admission 的既有文件，或新文件）：chat-sessions「Attachment-only admission titles from the first file name」（四例标题、`content` 为空串而非 NULL、补偿后标题回到 NULL）；既有「Atomic admission and epoch separation」「Rename survives prompt compensation」原样通过。
  测试 `server/test/session-snapshot.test.ts` 与 fork 用例：message-attachments「快照带附件」「补偿与坏值」「分叉拷贝与回填」；chat-sessions「User messages carry an undo state」改写后的消息键集（`…,approvals,undo,attachments,steps`）；turn-control「分叉点消息的附件随响应返回」。
- [ ] 12.3 REST：`server/src/sessions/rest.ts`（444 行）的 prompt 路由接受 `{message, attachments?}`，按 message-attachments「prompt 携带附件」的五条次序校验（第 1 条的个数上限即每条消息的附件总数上限 `UPLOAD_MAX_FILES`，owner S-23）（沙箱 facade 由装配处注入 sessions 模块——与 workspaces 用同一个实例，不另建），受理后把 `toWireText(...) + attachmentSuffix(...)` 交给 supervisor；fork 路由的响应加 `attachments`。
  **只发附件**（owner 2026-10-06 改判）：`rest.ts` 解析 `message` 的那一处（`rest.ts:439-443`，现在对 `trimmed.length === 0` 直接 400）改为——`message` 键缺失或不是字符串仍 400；去掉首尾空白后为空且 `attachments` 缺席或为 `[]` 仍 400；为空而 `attachments` 非空时不在这里拒绝，交给五条附件校验决定（通过即受理，`content` 存空串）。不为空文本另写派发分支。
  测试新文件 `server/test/session-prompt-attachments.test.ts`（含以 `/` 结尾的路径 `uploads/a.pdf/` → 400、无消息行、无审计一例）：「带附件的 prompt 被受理」「附件形状与前提」「越界附件被拒绝并入审计」、chat-sessions delta「Attachments are validated before admission」（含没有 `message` 键、`message:null`、空文本配 `[]`、空白文本配不存在的文件四例 400）「Attachment-only prompt is admitted」（空串与纯空白两种 `message`、`content` 为空串、supervisor 收到的恰为后缀、标题 `a.pdf`、空文本配越界路径 403 加一条审计、补偿后标题回到 NULL）、message-attachments「只带附件的 prompt 被受理」与「附件形状与前提」新增的两段（空文本无附件 400；空文本带附件 202 而 ` /todo` 带附件仍 400）、「越界附件被拒绝并入审计」里 `message:""` 的一遍；chat-sessions「Input boundaries」改写后的断言（空文本的 400 限定为无附件时；既有用例若断言「空 `message` 一律 400」而请求里不带附件则原样通过）；既有断言 prompt body「恰 `message`」与 fork 响应「恰 `{session,draft}`」的用例按 delta 改写（偏离记录；turn-control「正常分叉」的 201 带 `attachments:[]`）。prompt 的 202 仍是 C 的三键 `{userMessageId, assistantMessageId, undo}`，不动。
- [ ] 12.4 变异证据：空文本带附件仍 400 →「只带附件的 prompt 被受理」判红；空文本无附件被放行 →「附件形状与前提」判红；空文本时跳过附件校验 → 空文本配越界路径一例判红；只发附件时标题取了空串或整条路径 → 标题断言判红；空文本存成 NULL 或存了原始空白 → `content` 断言判红；给空文本的 wire 文本去掉开头换行 →「Attachment-only prompt is admitted」的 supervisor 文本断言判红。后缀拼进落库的 `content` →「带附件的 prompt 被受理」判红；候选不接后缀 → 带附件回合的 regenerate 502，判红；跳过沙箱 resolve → 越界一例判红；内建命令带附件被放行 → 判红；读取时重新 `stat` 文件 →「快照带附件」的删除后一例判红。
- [ ] 12.5 `smoke/chat.hurl`：chat-harness delta 的带附件 prompt 断言；既有断言消息键集的 Hurl 断言加上 `attachments`；`make smoke` 通过。
- [ ] 12.6 撤回响应的附件（owner S-24，message-undo「撤回 REST」的 MODIFIED）：在 C 的 `server/src/sessions/undo.ts` / `store-undo.ts` 里——撤回事务删除消息行之前读出被撤回消息所存的附件数组（用 `store-attachments.ts` 的解析）；文件还原（如有）之后逐项判定是否仍存在（`core/sandbox` 的纯 `resolve`，`op=read`，不经会写审计的 facade；再 `lstat` 为普通文件）；200 的 body 加 `attachments`。判定出错按不存在处理，不使撤回失败。
  测试（C 的撤回 REST 测试文件，或新文件 `server/test/session-undo-attachments.test.ts`）：「响应带回仍存在的附件」四例（`keep` 下被删的不带回、`restore` 后被还原的带回、无附件为 `[]`、换成符号链接的不带回；四键 body；无 `sandbox.reject`）与同场景的只有附件一段（`draft` 为 `""`、附件带回、对位成功）；C 的 undo 既有用例里断言响应「恰 `{session, draft, files}`」的改为四键（偏离记录）。
  变异：不做存在性判定 → 第一例判红；在还原之前判定 → 第二例判红；用 facade 判定 → 第四例多出 `sandbox.reject`，判红；在事务之后才读附件 → 全部为 `[]`，判红。

Suggested fixture level: expanded - 公共 API（prompt body、消息与 fork 的键集）、沙箱读解析、与重新生成 / 分叉共享的对齐不变量
Minimal mergeable slice: 12.1 一刀（纯函数与对齐，无附件时字节不变）；12.2 + 12.3 + 12.5 + 12.6 一刀（消息键集、fork 响应与 undo 响应的 `attachments` 是同一批严格键集变化，web 已由组 5 放宽；服务端这三处同刀发出，组 13.5 才能一次收紧）

## 13. web lib — API 方法、上传传输与解析收紧

- [x] 13.1 `web/src/lib/api-sessions.ts` / `api.ts`：`createSession` 与 `patchSession` 的 input 类型加三键；`prompt(id, message, options)` 的 `options.attachments`（非空才进 body）。C 的 `undoMessage`（C 的 13.1）的响应类型带 `attachments`（解析在 5.1 已放宽、13.5 收紧）。`message` 原样进 body：空串不裁剪、不省略键、客户端不因它为空而拒绝。测试（既有 API 客户端测试文件）：chat-web「新输入与两个新方法」的前五个调用（含 `prompt(id, "", {attachments:[…]})` 的 body `{"message":"","attachments":[…]}`）、「回合控制四方法请求与响应」里 `forkSession` 的 201 三键。
  **实施注记（13.1，fixture 评审补充，#1021）**：
  - 现状漂移：issue「Current behavior」称 `undoMessage` 响应类型没有 `attachments`，在 origin/master 不成立——`ChatSessionUndo`（`session-contract.ts:134-139`）与 `ChatSessionFork`（`:108-112`）已由 #996 带上该字段；这两项零产品代码改动，只补客户端层用例，旧句子写进 PR 偏离记录。
  - 产品改动只有两处：`web/src/lib/api.ts`（769 行）的类型，和 `web/src/lib/api-sessions.ts`（284 行）第 177 行的 prompt body；`session-contract.ts` 一行不动。
  - 三键类型在 `api.ts` 内用索引访问派生（同第 117 行 `ChatSessionScene` 的写法，`session-contract.ts:14-15` 的两个类型未导出）：`approvalMode?: ChatSession["approvalMode"]`、`modelId?: string`、`reasoningEffort?: NonNullable<ChatSession["reasoningEffort"]>`，加进 `ChatSessionCreateInput`（119-122）与 `ChatSessionPatch`（124-129）。
  - `prompt` 签名（`api.ts:160-164`）改为 `options?: ApiRequestOptions & { attachments?: string[] }`；`attachments` 是路径字符串数组，不是 `{path,size}`。`api.ts` 合计约 +9 行，到约 778 行。
  - body 写法：`JSON.stringify({ message, ...(options?.attachments?.length ? { attachments: options.attachments } : {}) })`，键序即规格字面量；`message` 不 trim、不判空；路径不在客户端校验。
  - `createSession` / `patchSession` 的实现不改：`createSessionBody`（`api-sessions.ts:44-50`）与 `JSON.stringify(patch)`（`:127`）本来就原样发所给的键。
  - 缺键与 null：规格写「只发送所给的键」「不得为 `null`」。键缺席即不发；`null` 只靠类型排除，不加运行期守卫（服务端对 `null` 回 400）；值为 `undefined` 的键被 `JSON.stringify` 丢掉是既有行为。三点写进偏离记录。
  - 既有断言一条都不改：无 body 创建、`{"workspaceId":…,"scene":"code"}`、`{"title":"周报","pinned":true}`、`{"pinned":true}`、`{"archived":true}`、空 patch `TypeError`、`{"message":…}`（`api-sessions.test.ts:196`）、`{"messageId":-3}`、undo body 全部保持；点名之外变红先查原因。`api-sessions.test.ts` 的 `sessionMethods` 表（`options?: {signal?}`）照常通过类型检查。
  - 新用例 `web/test/api-sessions-metadata.test.ts`（271 行）：`createSession({workspaceId, approvalMode:"always-ask", modelId:"m3", reasoningEffort:"low"})` 的 body 恰为该四键 JSON，201 回带这三值的十四键会话并逐值返回；`patchSession(id, {approvalMode:"yolo"})` 的 body 恰为 `{"approvalMode":"yolo"}`。
  - 新用例 `web/test/api-sessions.test.ts`（683 行，加完约 710，受 size-guard 管）「prompt contract」里三例：`("看看", {attachments:["uploads/a.pdf"]})` → `{"message":"看看","attachments":["uploads/a.pdf"]}`；`{attachments:[]}` → `{"message":"看看"}`；`("", {attachments:[…]})` → `{"message":"","attachments":["uploads/a.pdf"]}`。其中一例同时带 `signal`，断言它进了 fetch 选项而不进 body。
  - 新用例 `web/test/api-turn-control.test.ts`（393 行）：`forkSession` 收到 201 `{session, draft:"x", attachments:[{path:"uploads/a.pdf",size:3}]}` 逐值返回，另一例 `attachments:[]`；既有两键响应期望 `attachments: []` 的用例（`:200-211`）是过渡断言，留给 13.5。
  - 新用例 `web/test/api-undo.test.ts`（225 行）：「撤回与转正方法」的字面量带 `attachments:[{path:"uploads/a.pdf",size:3}]` 逐值返回；既有不带 `attachments` 的两例（`:90-108`）同样留给 13.5。
  - fork / undo 两条是固定用例，不是新行为：`session-contract-composer.test.ts` 在 13.5 整文件删除后，它们是客户端层唯一的正向断言。它们的变异落在 `session-contract.ts`（`parseSessionFork` / `parseSessionUndo` 丢掉 `attachments` → 判红），PR 里注明。
  - 变异：空数组也发 `attachments` → 第二例红；非空时不发 → 第一、三例红；trim 或空串拒绝 / 省略 `message` → 第三例红；从 create / patch body 过滤任一新键 → 四键例与 `{"approvalMode":"yolo"}` 例红。服务端组 8、12 未合入，全部用 fetch 替身，不碰 `make smoke` 断言。
- [x] 13.2 `getComposerOptions()`：方法与严格解析（解析放 `session-contract.ts` 或新文件 `web/src/lib/composer-contract.ts`，视行数）。测试：同场景的 options 部分（合法逐值返回；四种非法响应拒绝（chat-web 场景的 THEN 列了四种；O1 之后加了 `efforts` 含 `auto`））。
  **实施注记（13.2，fixture 评审补充，#1022）**：
  - 计数漂移：任务与 issue 写「三种非法响应」，chat-web「新输入与两个新方法」的 THEN 列了四种——`approvalModes` 为空、`models` 元素缺 `defaultEffort`、`efforts` 含 `auto`（O1 后加）、`upload.maxFiles` 为 0。以场景为准四种全测，偏离记录写明。
  - 服务端 `GET /api/composer/options`（任务 8.5）未合入，`server/src` 搜不到该路径；本刀全部是 fetch 替身，不加 smoke / ui-walk 断言。
  - 方法放 `web/src/lib/api-sessions.ts`（284 行，加完约 300），不新建 `api-composer.ts`：该端点由 sessions 模块注册，`createSessionMethods` 已拿到 `request` / `getRequestOptions` / `requestFailed`，只需在 `Pick<ApiClient, …>`（`:67`）加 `"getComposerOptions"`，`api.ts` 的装配处零改动。
  - 方法体：`request("/api/composer/options", getRequestOptions(options?.signal), onUnauthorized, 200)` → `parseComposerOptions`，失败 `throw requestFailed(200)`。
  - `api.ts`（#1021 之后约 778 行）只加 `import type { ComposerOptions } from "./composer-contract.js"` 与 `ApiClient` 成员 `getComposerOptions(options?: ApiRequestOptions): Promise<ComposerOptions>`，约 +2 行；不从 `api.ts` 再导出该类型（消费者直接从 `lib/composer-contract.js` 取，同 `Command` / `ProjectConfigFile` 的先例）。
  - 解析放新文件 `web/src/lib/composer-contract.ts`（约 90 行）：`session-contract.ts` 现 694 行，放进去会到约 780。导出 `type ComposerOptions` 与 `parseComposerOptions(value: unknown): ComposerOptions | null`。
  - 值域单一来源：把 `session-contract.ts:173` 的 `APPROVAL_MODES` 与 `:178` 的 `REASONING_EFFORTS` 改为 `export const`（只加关键字，行数不变，解析规则不变），新文件值导入它们与 `./api-json.js`；类型用 `ChatSession["approvalMode"]` 与 `NonNullable<ChatSession["reasoningEffort"]>` 派生。
  - 值导入方向：`api.ts → api-sessions.ts → composer-contract.ts → {session-contract.ts, api-json.ts}`，无环；`api-sessions.ts` 对 `./api.js` 仍只有 `import type`。
  - 类型：`ComposerOptions = { approvalModes: Mode[]; models: ComposerModel[]; defaults: { approvalMode: Mode; modelId: string; reasoningEffort: Effort | null }; upload: { maxBytes: number; maxFiles: number } }`；`ComposerModel = { id: string; name: string; reasoning: boolean; vision: boolean; efforts: Effort[]; defaultEffort: Effort | null }`。
  - 规则（各层 `hasExactlyKeys`，无过渡分支）：顶层恰四键；`approvalModes` 非空、不重复、元素为三档之一；`models` 非空，元素恰六键，`efforts` 可为 `[]`、每个元素为七个名字之一，`defaultEffort` 为七名之一或 `null`；`defaults` 恰三键；`upload` 恰两键，均为 `isNonNegativeSafeInteger` 且 `> 0`。
  - 规格未写明、取最简并记偏离：`id` / `name` / `defaults.modelId` 为非空字符串，`reasoning` / `vision` 为布尔。
  - 不做跨字段一致性校验，写成一条偏离记录：缺省档位在 `approvalModes` 内、缺省模型在 `models` 内、`defaultEffort` 在该模型 `efforts` 内、`defaults.reasoningEffort` 在该模型 `efforts` 内、`approvalModes` 与 `efforts` 的次序、`efforts` 不重复、模型 `id` 不重复。规格未列，服务端「有效值解析」保证；其中 `defaults.reasoningEffort` 按 O3 合法地可以在集合之外（如 `m3` + `xhigh`），校验它会误拒。
  - 新测试文件 `web/test/api-composer.test.ts`（`api-sessions.test.ts` 在 #1021 后约 710 行，不再往里加）。合法体用 session-composer-settings「缺省配置」字面量与「封顶、白名单」的三模型体（`m2` 为 `efforts:[]`、`defaultEffort:null`，另加一例 `defaults.reasoningEffort:"xhigh"` 配 `m3`），逐值 `toEqual`。请求恰为 `("/api/composer/options", {method:"GET", credentials:"same-origin", cache:"no-store", signal})`。「缺省配置」体作为共享常量放 `web/test/session-meta-fixtures.ts`，供 13.4 与组 14 复用。
  - 拒绝例（均为 `request_failed`、不泄露响应内容）：场景四种，另加顶层多键 / 缺键、档位重复、未知档位、`models:[]`、模型多键、`defaultEffort:"auto"`、`defaults.reasoningEffort:"auto"`、`defaults` 多键、`maxBytes` 为 0 / 负数 / 非安全整数 / 字符串、201 而非 200、非 JSON；401 用 `unauthorizedResponseCases()`，通知恰一次；非 401 信封保留 `ApiError`。
  - 变异：去掉非空检查 → `approvalModes:[]` 与 `models:[]` 红；去掉去重 → 重复例红；强度集合放进 `auto` → 两条 `auto` 例红；`> 0` 改 `>= 0` → `maxFiles:0` 红；模型改成非恰好键集 → 缺 `defaultEffort` 与多键例红；`getRequestOptions` 换成 `requestOptions` → 请求字面量（`cache`）红；加上「`defaults.reasoningEffort` 须在 `efforts` 内」→ `xhigh` 例红。
  - knip：`getComposerOptions` 是类型成员加对象属性，不是导出，在组 14 之前无调用方也不报——`uploadFile` 同样只出现在 `api.ts:192` 与 `api-upload.ts`；`parseComposerOptions`、`ComposerOptions` 与两个新导出的集合都有 `src` 内引用。
- [x] 13.3 `uploadFile()`：新文件 `web/src/lib/api-upload.ts`（唯一用 `XMLHttpRequest` 的地方；same-origin、信封解析、request_failed 与 401 通知由 `api.ts` 注入，值导入方向 `api.ts → api-upload.ts`，与「API 客户端源码模块划分」对 `api-sessions.ts` 的规则一致）。
  测试新文件 `web/test/api-upload.test.ts`（可控的 `XMLHttpRequest` 替身）：chat-web delta「上传传输」四例。变异：文件名不编码、进度不取整、中止时不调 `abort()`、401 不通知 → 各判红。
  **实施注记（13.3，fixture 评审补充，#1023）**：
  - 模块形状照 `api-sessions.ts`：`web/src/lib/api-upload.ts` 导出 `createUploadMethods(onUnauthorized, { parseJsonResponse, requestFailed, isSuccessfulStatus }): Pick<ApiClient, "uploadFile">`；对 `./api.js` 只 `import type`，值只导入 `./api-json.js`；`api.ts`（现 758 行）在 `createApiClient` 里展开它。`ApiClient` 加 `uploadFile(workspaceId, file: File, options?: { signal?: AbortSignal; onProgress?: (percent: number) => void }): Promise<UploadedFile>`。
  - 请求：`xhr.open("POST", "/api/workspaces/" + encodeURIComponent(id) + "/uploads?name=" + encodeURIComponent(file.name))`（相对 URL 即 same-origin，不设 `withCredentials`）；`setRequestHeader("Content-Type", "application/octet-stream")`；`xhr.send(file)` 传 `File` 本身；不设 `responseType` 与 `timeout`。
  - 进度：只在 `xhr.upload` 的 `progress` 事件里回调；`lengthComputable` 为假或 `total === 0` 时不调；值为 `Math.floor(loaded / total * 100)`；100 只来自 `loaded === total` 的那次事件，`load` 时不补发。
  - 中止：与 fetch 方法同语义，即 `ApiError(0, request_failed)`。调用时已中止 → 不 `open`、不 `send`，直接拒绝；在途中止 → 监听器调 `xhr.abort()`，`abort` 事件 → `requestFailed(0)`，不调 401 通知；结算时移除 signal 监听。
  - 响应（`load`），按此顺序：`status === 0` → `requestFailed(0)`；2xx 且不是 201 → `requestFailed(status)`；其余交给注入的 `parseJsonResponse(new Response(xhr.responseText, { status }), signal, onUnauthorized)`（信封 → `ApiError`、`request_failed`、401 恰一次通知都由它做，不另写一套；包 `Response` 处再加一层 try，抛了就 `requestFailed(status)`）。201 的 body 严格解析为恰 `{path, name, size}`（`path`、`name` 非空字符串，`size` 非负安全整数），不符 → `requestFailed(201)`。`error` 事件 → `requestFailed(0)`。
  - 测试 `web/test/api-upload.test.ts`：`vi.stubGlobal("XMLHttpRequest", FakeXhr)` + `afterEach(vi.unstubAllGlobals)`；`FakeXhr extends EventTarget`，带 `upload = new EventTarget()`、`status`、`responseText`，记录 `open` / `setRequestHeader` / `send` / `abort`；实现一律用 `addEventListener`。四例：成功（`open` 参数、头、`send` 的引用、`onProgress` 序列 `[50, 100]`、返回值；另加 1/3 → 33 一步，否则「不取整」的变异测不出）；413 信封 → `ApiError{ status: 413, code: "upload_too_large" }`；在途中止（替身 `abort` 恰一次、`request_failed`、401 通知未调用；另加已中止的 signal 不 `open`）；401（`unauthorizedResponseCases()` 三种，通知恰一次）。另加 `error` 事件、201 多键或缺键、200 而非 201 各为 `request_failed`。
  - 变异：去掉文件名的 `encodeURIComponent` → 例 1 红；去掉 `Math.floor` → 33 那步红；中止时不调 `xhr.abort()` → 例 3 红；不传 `onUnauthorized` 或跳过 `parseJsonResponse` → 例 4 红。
- [ ] 13.4 假 API 支撑：`web/test/` 里整页测试共用的假 API 构造（如 `chat-page-*-support.tsx`）加上 `getComposerOptions`（缺省返回三档、单模型、缺省上限）与 `uploadFile`，使组 14–17 的整页测试有地方接；既有整页测试原样通过。
- [ ] 13.5 解析收紧（三步走的第三步；在组 8、12 的服务端 PR 都合入之后）：删除任务 5.1 的全部过渡分支与顶部注释，`parseSession` 只接受十四键、消息必须带 `attachments`、fork 响应与 undo 响应必须带 `attachments`、`modelId` 空串为非法。
  测试：chat-web「三键与附件的严格解析」「撤回与转正方法」（缺 `attachments` 的 undo 200 为无效响应）、session-sidebar「十一键接受与其它键集拒绝」（标题沿用 C 的原名，正文为十四键）；删除 5.2 的过渡用例；全仓库搜不到过渡注释里的标记。变异：恢复任一过渡分支 → 判红。`make smoke`、`make ui-walk` 通过。

Suggested fixture level: expanded - 浏览器 API 客户端的公共合同（新方法、新输入、严格键集收紧）
Minimal mergeable slice: 13.1 + 13.2 + 13.4 一刀；13.3 一刀；13.5 一刀（最后，依赖服务端两处键集都已发出）

## 14. web — 能力行布局与权限档位控件

- [ ] 14.1 options 状态：新文件 `web/src/features/chat/composer-options.ts`（hook：每个 client 取一次 `getComposerOptions` 并缓存，失败后在下一次进入欢迎态或选中会话时重取；登记 `MIGRATED_AREAS`）。由 `use-chat-session.ts`（702 行）调用并把结果与欢迎态的三项内存选择交给页面；欢迎态选择的状态放进 `welcome-options.ts`（35 行）或该新文件，不加大 `use-chat-session.ts` 超过必要的几行。
  测试新文件 `web/test/chat-composer-options.test.tsx`（hook 层 + 假 `getComposerOptions`）：同一个 client 下多次挂载、切换会话恰取一次；第一次失败后，切到另一个会话或回到欢迎态触发恰一次重取，重取成功后结果可用且此后不再取；换 client（换账号）重新取。整页层由 chat-web「选项读取失败后重取」钉住（14.2a 的测试文件）。变异：去掉重取 → 两处都判红（失败一次后控件永不出现）；每次切换都取 →「恰两次」判红。
- [ ] 14.2a 能力行重排与改名：`composer.tsx` 与 `capability-bar.tsx`（253 行）按 chat-web delta「输入框与能力栏」——左组次序改为「+」、工作空间、权限；右组容器放模型与强度的插槽（组 15 填）；「+」按钮改名 `添加文件或命令`。验证：改名后的既有用例、「能力行的次序」里不涉及三个新控件的部分、「选项读取失败后重取」的请求次数部分（控件出现的断言在 14.3、15.2 补全）；session-sidebar「无权限元素与无匹配」（标题沿用原名）改写后的断言（既有断言「能力栏无 `权限` 文本、无上传控件」的用例按 delta 改写，偏离记录）；chat-web「会话页」的「欢迎态与静态引导」改写后的 THEN（标题沿用原名）：既有欢迎态用例（`chat-page-welcome-scene.test.tsx` 等）里断言「无权限设置、上传…无附件 / 模型控件」的改为只断言无专家与麦克风控件、未选入文件时没有附件标签区（偏离记录）；三个新控件与 `上传文件` 在欢迎态出现的正向断言随 14.3、15.2、16.2a 落。
- [ ] 14.2b 窄屏：工具行换行、右组整体落行靠右、工作空间与模型按钮的最大宽度与截断（`title` 带完整文字）。验证：类名 / 结构断言（jsdom 不作像素断言），真实布局由 18.3 的走查钉住。
- [ ] 14.2c 「+」菜单的可用性语义：按钮只在锁定时禁用；`上传文件` 菜单项本任务不渲染（它随组 16 的真实行为一起出现，不先摆一个禁用的空壳；规格里「第一项是 `上传文件`」的断言也在组 16 落）；草稿非空时命令条目 `aria-disabled` 与提示行。验证：chat-web delta「「+」菜单写入草稿」改写后的断言；断言「草稿非空时按钮禁用」的既有用例按 delta 改写为「按钮可用、命令条目不可选」（偏离记录）。
  （14.2a 的）改名波及的既有引用一次改完：`web/test/chat-composer.test.tsx`、`chat-page-welcome-scene.test.tsx`、`chat-page-plus-menu.test.tsx`、`chat-capability-bar.test.tsx`、`chat-stop-button.test.tsx`、`web/e2e/ui-walk-sessions.spec.ts`（只改字符串，不加行）。
- [ ] 14.3 权限档位控件：新文件 `web/src/features/chat/permission-tier.tsx`（登记 `MIGRATED_AREAS`）：按钮、单选菜单、说明与底部提示、`全部自动` 的确认框、警示色与 `data-tier`、提交与失败回退、不随输入框锁定禁用。已选会话走 `patchSession`（经 `turn-actions.ts` 或 `session-actions.ts` 里的一个 handler，带既有的所有权 fence：切走会话后迟到的响应不改界面）；欢迎态改内存值并进入首次发送的 `createSession` input。
  测试新文件 `web/test/chat-permission-tier.test.tsx`（整页挂载）：session-permission-tier「权限档位控件」五条场景；chat-web delta「能力行的次序」「锁定时三个控件仍可用」的权限部分。
- [ ] 14.4 变异证据：去掉确认框 →「切换到全部自动要确认」判红；取消后仍提交 → 判红；`yolo` 不带警示标记 → 判红；控件随锁定禁用 →「生成中可改」判红；失败后显示新值 →「失败回退」判红；欢迎态选择发了请求或没进创建 input →「欢迎态的选择进入创建请求」判红；左组次序错 →「能力行的次序」判红。
- [ ] 14.5 功能验收清单「会话（CH）」新增行（`待签`）：能力行的五项与次序；三档的名称与说明；选 `全部自动` 的确认与警示色；生成中改档位、下一条消息起生效（操作步骤：`只问命令` 下让助手执行命令出现确认卡 → 改为 `全部自动` → 再发一条同样的话不再出现确认卡）；`每次都问` 下让助手写文件出现确认卡；新会话沿用上次的档位；管理员封顶后菜单里没有被封的档位（写明需要管理员改配置并重启）。

Suggested fixture level: expanded - 权限控件是审批策略放宽的用户入口（确认、警示、失败回退、所有权 fence）；改一个被测试与走查按名引用的可访问名
Minimal mergeable slice: 14.1 + 14.2a + 14.2b + 14.2c 一刀（options 状态、重排与改名、窄屏、菜单语义；此刀后权限 / 模型控件与 `上传文件` 项都尚未渲染）；14.3 + 14.4 + 14.5 一刀

## 15. web — 模型与推理强度控件

- [ ] 15.1 新文件 `web/src/features/chat/model-picker.tsx`（登记 `MIGRATED_AREAS`）：模型按钮与菜单（能力标签、截断与 `title`、`modelId` 不在 options 里时退为原文）、强度按钮与菜单（七个界面名的映射常量放在同一文件或 `composer-options.ts`，没有 `自动`；当前强度不在当前模型的 `efforts` 里时按钮照常显示其界面名、菜单没有选中项）、提交与失败回退、两个控件互相禁用在途、不随输入框锁定禁用；欢迎态换模型时强度的重算规则。提交的 handler 与组 14 的权限共用一个 `patchComposer(sessionId, patch)`（不写第二份 fence 逻辑）。
- [ ] 15.2 测试新文件 `web/test/chat-model-picker.test.tsx`（整页挂载）：model-selection「模型与推理强度控件」五条场景。
- [ ] 15.3 变异证据：不支持推理时仍渲染强度控件 → 判红；换模型后不以响应为准 →「切换模型与强度」的 `{m3, high}` 一步判红；欢迎态保留新模型不支持的强度 →「欢迎态的选择」判红；当前强度不在 `efforts` 里时按钮退为空或原文、或菜单里有选中项 →「切换模型与强度」的 `{m3, xhigh}` 一例判红；`reasoningEffort` 在不支持推理的模型下仍进创建 input → 判红。
- [ ] 15.4 功能验收清单新增行（`待签`）：输入框下方右侧显示模型名与推理强度；点模型名切换（需要管理员配置多个模型，写明配置前只有一项）；强度的档位列表（缺省单模型配置下七项，没有 `自动`；写明该配置下所选强度可能被 omp 取成相邻的一档，要一致需管理员配置 `MODEL_CATALOG` 的 `efforts`）；不支持推理的模型不显示强度；生成中切换不影响正在生成的回答、下一条消息起生效；重新生成用当前选择；分叉出的会话沿用原会话的选择；新会话沿用上次的选择。

Suggested fixture level: compact - 独立的两个下拉控件，复用组 14 的提交路径与 options；无新的公共入口
Minimal mergeable slice: atomic - 两个控件共用一份提交与强度重算逻辑，拆开会留下半个不可验收的状态；测试与清单行同刀

## 16. web — 附件（输入框侧）

- [ ] 16.1 状态：新文件 `web/src/features/chat/attachments-state.ts`（hook，不渲染 UI；登记 `MIGRATED_AREAS`）：标签列表与四种状态、统一的接收入口（每条消息的附件总数上限与单个大小上限，两句提示文字 `每条消息最多 <N> 个附件`、`「<文件名>」超过大小上限`）、串行上传队列与进度、移除（中止在途 / 撤掉排队 / 已上传不发请求）、清空（切换会话、回到欢迎态、换账号、卸载：在途的中止、排队的撤掉，迟到的结果不改界面）、从 fork / undo 响应恢复（覆盖已有标签）。它不导入 `use-chat-session.ts`；由后者创建并注入 `turn-actions.ts`（保持既有导入方向）。
  测试新文件 `web/test/chat-attachments-state.test.tsx`（hook 层 + 假 `uploadFile`）：队列的串行性、移除三种情形、限制两种情形（提示文字逐字）、清空时在途请求的 `signal` 被中止且排队项从未发出请求、迟到的上传结果不产生标签与错误。
- [ ] 16.2a 标签与菜单入口：新文件 `web/src/features/chat/attachment-chips.tsx`（登记）：附件区列表、每项的名字 / 大小 / 状态 / 进度条 / 移除按钮；`composer.tsx` 在文本框上方渲染它；「+」菜单加入 `上传文件` 项（隐藏的文件输入框、真实的禁用判定与原因文字，message-attachments「没有工作空间的会话」）。大小的格式化复用文件页既有的函数（先 grep `web/src/features/files/`，没有可复用的再在 `web/src/lib/` 加一个并让文件页也用它）。
  测试新文件 `web/test/chat-attachments.test.tsx`（整页挂载）：message-attachments「选择即上传」的标签部分、「数量与大小限制」「失败、移除与取消」「切换会话清空标签」「上传中切换会话」的已选会话一段、「未绑定会话没有上传目标」的菜单部分；chat-web delta「「+」菜单写入草稿」里「第一项是 `上传文件`」。
- [ ] 16.2b 拖拽与粘贴：`composer.tsx` 接上拖拽（`data-drop-active`）与粘贴（只在剪贴板带文件时拦截），都交给 16.1 的统一入口。测试同文件：「拖入与粘贴」四例、「未绑定会话没有上传目标」的拖入与粘贴部分。
- [ ] 16.2c 发送闸：有标签处于 `上传中` 或 `失败` 时 `发送` 禁用、Enter 不提交；启用条件改为「草稿非空，或至少有一个标签且全部处于可发送状态（已上传 / `待上传`）」（message-attachments「输入框附件标签」的**发送**一段、chat-web「输入框与能力栏」）。现有两道闸都要改，只改按钮会留下「按钮亮着、点了不发」：`web/src/features/chat/composer-locks.ts` 的 `sendDisabled`（现为 `draft.trim().length === 0`）与 `use-chat-session.ts` 提交入口对空白草稿的提前返回（`use-chat-session.ts:555` 一带）；判定写成一个纯函数，两处共用。
  测试同文件：「选择即上传」里上传期间与完成后的 `发送` 状态、「失败、移除与取消」里的 `发送` 状态（含「草稿为空白且已没有标签时仍禁用」）、「只有附件时可发送」的启用 / 禁用各段；`web/test/chat-composer.test.tsx`（或覆盖键盘发送的既有文件）：chat-web「输入框键盘发送」改写后的断言（没有附件标签的空草稿 Enter 不提交；带可发送附件的空白草稿 Enter 提交恰一次）。既有断言「空白草稿 `发送` 禁用」的用例在没有附件标签的前提下原样通过。chat-web「会话页」改写后的那一句（空白发送只在没有处于可发送状态的附件标签时禁用）由同一批断言钉住；覆盖「会话页」空白发送的既有整页用例（`web/test/chat-page-*.test.tsx` 里断言欢迎态与已选会话空白草稿不可发送的）核对其前提是「没有附件标签」，原样通过。
- [ ] 16.3 发送：`turn-actions.ts`（431 行）的 prompt 派发带上已上传标签的 `path`；受理后清空标签并把附件放进页面自己呈现的那条用户消息；未受理时与草稿一起恢复。只发附件时 `message` 为原始草稿（空串或用户留下的空白），不在客户端裁剪或补字。测试同文件：「选择即上传」的 prompt body、「发送被拒时恢复」、「只有附件时可发送」的 prompt body 两例（`{"message":"","attachments":[…]}`；三个空格的草稿原样发出）与 409 后草稿仍为空、标签恢复一段。
- [ ] 16.4 欢迎态暂存与首次发送：`turn-actions.ts` 的首次发送路径在 `createSession` 之后、prompt 之前插入「`workspaceId` 为 null 则中止 / 否则逐个上传」；失败的收尾（恢复草稿、标签状态、输入框错误、新会话保持选中并补读历史——复用 `fix-new-session-handoff` 与 `s1f-chat-followups` 定下的首次发送被拒收尾，不另写一套）。
  测试新文件 `web/test/chat-attachments-first-send.test.tsx`：message-attachments「首次发送先建会话再上传再发 prompt」（逐字核对请求次序）、「上传中途失败」两段、「欢迎态首次发送后发现没有空间」两段（第二段是 `temporaryWorkspace` 为 true 的会话照常上传）、「上传中切换会话」的首次发送一段；全程恰一次 `createSession`。另加「首次发送先建会话再上传再发 prompt」的只选文件不输入文字一段（`待上传` 标签使 `发送` 可用；请求次序 `createSession` → `uploadFile` → prompt，body 的 `message` 为 `""`）。
- [ ] 16.5 变异证据：启用条件仍只看草稿 →「只有附件时可发送」判红；只改了按钮没改提交入口（或反之）→ 同场景的「恰一次 prompt」判红；有 `失败` 标签的空白草稿可发送 → 判红；没有标签的空白草稿可发送 →「输入框键盘发送」判红；客户端把空白草稿裁成空串或补了占位文字 → 三个空格一例判红。并行上传 →「选择即上传」里「第二个尚未发出请求」判红；移除已上传的标签发了请求 → 判红；粘贴文字被拦截 →「拖入与粘贴」判红；首次发送先上传后建会话 / 失败后重建会话 / 重复上传已完成的文件 → 首次发送三例分别判红；`workspaceId` 为 null 时仍发 prompt → 判红；切换会话时不中止在途上传、或仍发出排队项 →「上传中切换会话」判红；数量提示仍是旧文案 →「数量与大小限制」判红。
- [ ] 16.6 功能验收清单新增行（`待签`）：从「+」菜单上传文件并看到标签与进度；同名文件再传得到带编号的名字；拖进输入框；粘贴截图；移除标签后文件仍在工作空间里（在绑定了正式工作空间的会话里做：到文件页看该空间的 `uploads` 目录；临时空间不在文件页的列表里，这一步不适用于它）；用临时空间的会话（欢迎页不选工作空间）同样可以上传并让助手读到文件，删除该会话后其临时空间连同上传的文件一起消失；上传中切到别的会话，回来后没有标签、文件没有传完；超过个数（提示 `每条消息最多 N 个附件`）与超过大小的提示（写明缺省上限；大小上限的验证需要管理员调小配置）；
  欢迎页先选文件、发送后才上传；没有工作空间的会话里 `上传文件` 不可用并显示原因；带附件发送后助手能读到文件（让助手说出文件内容，写明「模型未照做就换说法重试」）；不输入文字、只带附件也能发送（`发送` 在附件传完后亮起；没有附件的空输入仍不能发），新会话这样发出的第一条消息使会话标题成为第一个附件的文件名。

Suggested fixture level: expanded - 文件选择 / 拖拽 / 粘贴三入口、上传队列与取消的并发、首次发送的多步交接与失败收尾
Minimal mergeable slice: 16.1 + 16.2a + 16.2c + 16.3 一刀（已选会话里的最小闭环：经菜单选入、上传、发送闸、发送；状态 hook 没有界面就没有入口，拆开会留下无人调用的 hook）；16.2b 一刀（拖拽与粘贴：同一入口函数的另两个调用方，闭环之后独立合入）；16.4 + 16.5 中首次发送部分一刀（欢迎态暂存，改首次发送路径）；16.6 随各刀

## 17. web — 用户气泡附件与分叉回填

- [ ] 17.1 `web/src/features/chat/message-thread.tsx`（284 行）的 `UserMessage`：文本下方渲染名为 `附件` 的列表（文件名取路径最后一段、大小；纯文本、无链接无按钮；带 `role="list"`）；数据来自透传字段（组 5.3）。文本为空（快照里 `content` 为空串；页面自己呈现的那条按发送时的草稿去掉首尾空白后判定）时只渲染附件列表，不渲染文本块；根元素、可访问名与操作行照旧。若文件因此逼近行数或复杂度上限，把列表抽成同目录的新组件文件（登记 `MIGRATED_AREAS`）。
  测试 `web/test/chat-thread-*.test.tsx` 或新文件：message-attachments「受理后与刷新后一致」「无附件不渲染」「只有附件的气泡」（受理后与刷新后两次；含对话内搜索输入文件名不匹配该消息）、chat-web「只有附件的用户消息」；`web/test/chat-module-layout.test.ts` 里 `list-none` 必带 `role="list"` 的静态断言继续通过。
- [ ] 17.2 分叉回填：`turn-actions.ts` 的 fork 成功处把响应的 `attachments` 交给附件状态（已上传状态的标签），与 `draft` 回填同时。测试（既有分叉整页测试文件）：chat-web delta「从用户消息分叉」改写后的断言（附件区恰一个 `a.pdf` 标签、没有上传请求），含在只有附件的消息处分叉一段（`draft:""` → 草稿为空、标签恢复、`发送` 可用）。
- [ ] 17.3 变异证据：气泡渲染了后缀文字或把附件渲染成链接 → 判红；刷新后不显示 →「受理后与刷新后一致」判红；分叉不恢复标签 → 判红；空文本仍渲染一个空文本块、或本地呈现与快照呈现不一致（空白草稿渲染出空白段落）→「只有附件的气泡」判红；空 `draft` 没有覆盖已有草稿 → 分叉 / 撤回的只有附件一段判红。
- [ ] 17.4 功能验收清单新增行（`待签`）：带附件的用户消息下方列出文件名与大小，刷新后仍在；从带附件的那条消息分叉，新会话的输入框里带回文字与附件标签；对带附件的回合点重新生成可以正常重答；只发附件的消息在气泡里只显示附件列表、没有空白的文字块，对它点重新生成、从它分叉（新会话输入框里文字为空、附件标签带回）都正常。
- [ ] 17.5 撤回回填（owner S-24，message-undo「web 撤回」的 MODIFIED）：C 的撤回 handler（C 的 18.1–18.3 所在文件）在 200 时把响应的 `attachments` 交给附件状态（已上传状态的标签，覆盖已有标签），与 `draft` 回填同时；失败与被丢弃的迟到响应不动标签。
  测试（C 的撤回整页测试文件）：「撤回带附件的消息恢复标签」三段（第三段：撤回只有附件的消息，`draft` 为 `""` 覆盖已有草稿、标签恢复、`发送` 可用）；C 的「撤回并回填」「失败就地显示」原样通过。变异：不恢复标签、不覆盖已有标签（`old.txt` 仍在）、恢复时发出了上传请求 → 各判红。功能验收清单新增一行（`待签`）：撤回一条带附件的消息，输入框里带回文字与仍在的附件标签；附件文件已被删掉的不带回。

Suggested fixture level: compact - 用户气泡的只读呈现与两处回填；不涉及新的请求路径
Minimal mergeable slice: 17.1 一刀（气泡附件：`message-thread.tsx`，message-attachments「用户气泡中的附件」）；17.2 一刀（分叉回填：`turn-actions.ts`，chat-web「消息线程」）；17.5 一刀（撤回回填：C 的撤回 handler，message-undo「web 撤回」）——三者分属不同文件与不同规格要求，各自可独立验收；17.3 的变异证据与 17.4 的清单行随各自的刀

## 18. harness — 冒烟与走查

- [ ] 18.1 `smoke/session-meta.hurl`：chat-harness delta 列出的 options、档位修改与审计、最近选择继承、非法值 400，以及结束前把最近选择改回 `write`、把本步骤无 body 新建的会话 `DELETE` → 204（它用的是临时空间；C 的「冒烟与走查不留会话与临时空间」）。（`files.hurl` 与 `chat.hurl` 的附件部分已在 11.6、12.5 落下。）
- [ ] 18.2 `smoke/chat.hurl`：`yolo` 会话的 bash 回合不经作答轮询到 `done`、`approvals` 为 `[]`；该会话与文件里的其它会话一样在退出登录前删除。`make smoke` 通过；AGENTS.md 验证矩阵里「五文件」的表述不变。
- [ ] 18.3 ui-walk：新 helper 文件 `web/e2e/ui-walk-composer.ts`，实现 chat-harness delta 的五个步骤，helper 在包住步骤的 `finally` 里删除它创建的会话（204 或 404 均接受）；由 `web/e2e/ui-walk.spec.ts`（594 行）调用。`ui-walk-sessions.spec.ts` 与 `ui-walk-layout.ts` 不加行。两种视口下通过；error oracle 生效。
- [ ] 18.4 判红证据：按 chat-harness delta「走查对旧实现判红」，本地临时去掉确认框与附件标签渲染各跑一次走查，记录第 2、4 步失败的输出到 PR 描述（不提交这两处临时改动）。
- [ ] 18.5 `IMPLEMENTATION_PLAN.md` S1g 的 Verify 三条对照：各档位下审批是否出现（组 1 的对照用例 + 18.2）；上传的越界 / 超限全拒且入审计（组 11 + 11.6）；双账号互不可见（11.2、12.3、8.3 的隔离用例 + 11.6）。在 Epic 里逐条贴出对应的测试名与最近一次 CI 运行。

Suggested fixture level: compact - 只加真栈断言与走查步骤；发现产品缺陷则停下报告，不在本组修
Minimal mergeable slice: 18.1 + 18.2 一刀（Hurl）；18.3 + 18.4 一刀（ui-walk）；18.5 不产生代码

## 19. 文档

- [x] 19.1 `docs/adr/0012-omp-project-config-host-overlay.md`：加一节「补充（S1g）：审批档位按会话取值」——档位不再钉死 `write`；argv 经 omp 的运行期覆盖层压过 overlay（附组 1 的实机结论与日期）；overlay 文件不随档位变化、其余键在三档下的作用；
  `全部自动` 下 exec 档工具不再请求审批属于有意放宽，由管理员封顶、选择时确认、审计与独立 uid 约束；正文首段「cwd 是 agent 在 `--approval-mode write` 下无需审批即可写的目录」一句补上限定。组 1 若启用了「按档位各写一份 overlay」的退路，这一节按实际写。
- [x] 19.2 `docs/adr/0013-assistant-ui-frontend-rebuild.md`：加一节「增补（S1g）」——能力行五项与次序；「+」按钮改名与草稿非空时的行为；附件是应用层状态，不使用 runtime 的 attachments 适配器；拷入层零改动、六类修改不变；模型与强度按 #906 的 owner 决定。
- [x] 19.3 `CONTEXT.md` 术语表新增两行：**权限档位 permission tier**（会话的工具审批档位，三档对应 omp 的 `always-ask` / `write` / `yolo`；不是账号权限、不是 KB 可见范围）；**附件 attachment**（随一条消息告知助手的工作空间文件路径；文件本身是工作空间里的普通文件：不随消息删除，也不随绑定正式工作空间的会话删除；临时空间随最后一个会话删除时、撤回连文件一起还原时，按工作空间的规则一并变化）。
  「审计」一行的边界说明补上档位变更与上传。`openspec/glossary.md` 若存在同名词条，保持单一来源（指向 `CONTEXT.md`）。
- [ ] 19.4 部署与配置文档（`README.md` 的配置表或 `docs/` 下现行的部署页，先 grep `OMP_MAX_PROCESSES` 找到列环境变量的那一处）：四个新变量的含义、缺省值与示例（`MODEL_CATALOG` 给一个两模型的 JSON 示例，不含真实供应商密钥或地址）；`MODEL_CATALOG` 与 `MODEL_ID` / `MODEL_REASONING` 的关系；`MODEL_CATALOG` 里的推理模型必须写 `efforts`（示例照此）；不设 `MODEL_CATALOG` 的单模型配置下 omp 按模型 id 自定强度集合，界面显示的强度可能与实际使用的不同，要一致就配置 `MODEL_CATALOG` 并给出 `efforts`；
  反向代理须放开请求体大小并关闭请求缓冲；上传没有配额、`uploads/` 可能残留 `.part` 文件；`全部自动` 的安全含义（选过一次之后新会话默认沿用它）与如何用 `APPROVAL_MAX_MODE` 关掉它；模型代理只放行白名单内的模型名（白名单外的请求得到 400，不到达上游；想让某个模型可用就把它写进 `MODEL_CATALOG`）。
- [ ] 19.5 核对功能验收清单：组 14–17 新增的各行都在、ID 不重复、结论均为 `待签`；`web/test/functional-checklist.test.ts` 通过；因「+」按钮改名而失实的既有行（提到 `技能与命令` 按钮名的）改写并回到 `待签`。

Suggested fixture level: none - 只改文档；清单格式由既有守卫检查
Minimal mergeable slice: 19.2 + 19.3 一刀（ADR-0013 增补与术语，可随时合入）；19.1 一刀（ADR-0012 补充，在组 1 的结论写入 design 之后）；19.4 一刀（在组 2、11、20 之后）；19.5 随组 17 之后

## 20. model-proxy — 模型白名单强制（owner S-22；Critical Path）

- [x] 20.1 新文件 `server/src/model-proxy/model-guard.ts`（纯函数，不依赖 Fastify）：`topLevelModel(raw: string)` 对一段已通过 `JSON.parse` 的文本扫描顶层对象的成员键（跟踪嵌套深度与字符串状态，键名按 JSON 字符串解码），返回「不是对象 / 没有 `model` / 多于一个 `model` / 唯一的 `model` 及其原始值文本」；`isAllowedModel(parsed, raw, allowed)` 组合 `JSON.parse` 的结果给出放行与否。
  测试新文件 `server/test/model-proxy-model-guard.test.ts`（表驱动）：model-proxy「Model outside the whitelist is refused」的十二个 body 各自的判定、「Whitelisted model is forwarded untouched」里转义键名与嵌套 `model` 的判定；另加键名含转义引号、值里含 `"model":` 字样的字符串、深层嵌套、顶层为数组 / 标量各一例。
- [x] 20.2 `server/src/model-proxy/index.ts`（436 行）：`ModelProxyOptions` 增必填的 `allowedModels: ReadonlySet<string>`（空集在注册时抛出）；`parseJsonBytes` 在 `JSON.parse` 成功之后调用 20.1 的判定，不放行即 `HttpError("bad_request")`（与语法错误同一条拒绝路径：在 `authenticate()` 的上游配置检查之后、任何上游接触之前；`authenticate()` 与 `onRequest` 的次序不改；不回显模型名）；转发的仍是原始 `raw` 字节。装配处（`createApp` 里调用 `registerModelProxy` 的那一处）传入 `settings.modelCatalog.models` 的 id 集合。
  测试 `server/test/model-proxy-wire.test.ts`（记录型真上游，真实 HTTP）：「Model outside the whitelist is refused」（每个 body 带与不带 `stream` 各一次；零上游请求；响应体不含所给模型名）、「Whitelisted model is forwarded untouched」（字节逐一相等，流式与非流式响应原样到达）；`server/test/server-assembly.test.ts`：「Default single-model whitelist」（缺省配置下 `deepseek-v4.1-flash` 放行、`gpt-x` 400）。
  **实施注记（20.2–20.4，fixture 评审补充）**：
  - 假 omp 的 call-proxy 今天不发 `model`（`server/test/support/fake-omp-proxy.mjs` 的 `postChat` 只发 `{stream, messages}`），校验一接上，经真实代理的整回合测试会得到 400。改法：`fake-omp-proxy.mjs` 取托管 `models.yml` 里 `providers.workbuddy.models` 的第一条 id 随请求发出；改动收在该文件内，`fake-omp.mjs`（已近 800 行）不加行。omp-test-harness delta「真实代理承载」已补这一句，`fake-omp.test.ts` 的对应用例加断言。这三个文件进本 PR。
  - 注入路径：`AssemblyDependencies` 增可选的 `modelCatalog?: ModelCatalog`（8.5 也用它），入口的 `appAssemblyOf` 传 `config.modelCatalog`；`createApp` 省略时取 `{ runtime.modelId }` 的单模型白名单，既有 `createApp` 调用方不动。装配处把 id 集合传给 `registerModelProxy`。
  - 接线：同一个字符串同时喂给解析与扫描——`text = raw.toString("utf8")`、`parsed = JSON.parse(text)`、`isAllowedModel(parsed, text, allowedModels)`；转发的仍是原始字节。空集在 `registerModelProxy` 里同步抛出。
  - 非法 UTF-8 不另做处理：解析器与扫描器看到的是同一个替换后的字符串，转发的是原字节（写进偏离记录）。键名大小写不敏感的规则**不加**（owner 2026-10-07：白名单表达的是企业接入了哪些模型）。
  - 既有测试辅助里要补 `model` 的位置：`model-proxy-helpers.ts` 的 `jsonBodyOfSize`、`postCompletions` 的缺省 body、`rawPostCompletions`，`model-proxy-wire.test.ts` 的 `RAW_JSON`，stream / timeout 两个文件里按 `mode` 分支的 body（确认记录型上游加键后仍能识别）；`createProxyApp` 的所有调用方都给 `allowedModels`。`server-assembly.test.ts` 目前没有配置了上游的用例，「Default single-model whitelist」自己起记录型上游。`server-startup-order.test.ts`（近 800 行）只保持既有用例通过，不加行。
  Risk packs（组 20）: Parser differential（重复键、转义键）、Byte passthrough、Rejection order（401 → 502 → 400）、Test fixture compatibility。
- [x] 20.3 既有代理测试的请求体补上白名单内的 `model`（偏离记录逐个点名）：`model-proxy-auth.test.ts`、`model-proxy-stream.test.ts`、`model-proxy-timeout.test.ts`、`model-proxy-wire.test.ts` 与 `model-proxy-helpers.ts` 里构造请求体的辅助函数，以及任何经代理到达受控上游的 server 集成测试；改写后的「Byte-preserving credential substitution」「Real two-round fake model」「Parser byte limit and sibling isolation」三个场景照旧通过。断言 401 / 无上游 502 的用例不改断言：次序仍是认证 → 上游未配置 502 → body 校验，无上游时不论 body 是否合法、`model` 是否在白名单内都是 502——既有用例 `valid bearer with explicit undefined upstream is 502 before parser errors` 原样通过，并在 `model-proxy-auth.test.ts` 加一例「无上游 + 白名单外 `model` → 502」对应改写后的「Missing configuration after valid authentication」。`make smoke` 通过（真实 omp 只发 `models.yml` 里的 id，已由 1.4 的 (f) 核对）。
- [x] 20.4 变异证据：去掉校验 →「Model outside the whitelist is refused」全部判红；只看 `JSON.parse` 的结果、不数重复键 → 两个重复键的 body 判红；键名不解码 → `"mod\u0065l"` 一例判红；比较时忽略大小写或去空白 → `M1`、` m1` 判红；校验后重新序列化再转发 →「Whitelisted model is forwarded untouched」的字节相等判红；把嵌套的 `model` 也算进去 → 该场景被误拒，判红。

Suggested fixture level: expanded - omp 访问模型的唯一通道上的准入控制：解析器差异（重复键）、与字节透传的共存、拒绝次序、对既有代理测试的波及；Critical Path
Minimal mergeable slice: 20.1 一刀（纯函数与表驱动测试，先由测试引用）；20.2 + 20.3 + 20.4 atomic: `allowedModels` 是必填入参，校验一接上，全部不带 `model` 的既有代理测试同时变红，必须与它们的改写同刀
