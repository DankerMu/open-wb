# Tasks: s1g-composer-capabilities

> 执行顺序：0 → 1 → 2 → 3 → 20 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19。组 20（模型代理白名单，owner S-22）是后加的任务组，编号排在最后以免改动既有组号；它的执行位置在组 3 之后。组 0 的 0.1 在一切之前，0.2 在归档之前。
> 组 1 是其余各组的前提：它的任何一条核对不成立，先按 design 对应决定的「退路」改本 change 的规格，再继续。组 4、10 与组 2 互不依赖，可在组 1 之后并行；组 3 与组 20 都在组 2 的第二刀（2.2 + 2.3，模型白名单）之后，二者彼此并行；组 5 必须早于组 8 与组 12（键集三步走，design D16）；
> 组 6 早于组 7、9；组 8 早于组 9；组 10、11 早于组 12；组 13 在组 8、11、12 之后；组 14–17 在组 13 之后，彼此共改 `composer.tsx` / `capability-bar.tsx` / `use-chat-session.ts`，串行；组 18 在组 14–17 之后；组 19：19.2、19.3 可随时做，19.1 在组 1 之后（它引用组 1 的实机结论），19.4 在组 2、8、9、11、12、20 之后（它写的沿用最近选择、封顶夹取、换档生效与每条消息的附件数上限分别由组 8、9、12 实现），清单行随各自的功能 PR 落。
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
- [x] 4.2 `041_account_composer_prefs.sql`（「迁移 041」）。测试并入同文件：建表与约束、随账号级联。
  **实施注记（4.2，fixture 评审补充，#994）**：
  - DDL 逐字照规格、风格照 039（列级约束，一条 `CREATE TABLE`）：`account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE`、`approval_mode TEXT NULL CHECK (approval_mode IN ('always-ask','write','yolo'))`、`model_id TEXT NULL`、`reasoning_effort TEXT NULL CHECK (reasoning_effort IN ('off','minimal','low','medium','high','xhigh','max'))`、`updated_at INTEGER NOT NULL CHECK (typeof(updated_at)='integer' AND updated_at >= 0)`。`accounts.id` 是 `TEXT NOT NULL` + `PRIMARY KEY (id)`（`010_auth_schema_seed.sql:5-11`）。
  - 文件不含 `IF NOT EXISTS`、`WITHOUT ROWID`、`STRICT`、索引、DEFAULT、AUTOINCREMENT、事务语句；头注释照 039 / 040，写明「同名冲突必须使本迁移事务失败」。`sqlite_sequence` 不增行。
  - 偏离记录·列序：规格行文是 `approval_mode`、`reasoning_effort`、`model_id`，design D4 是 `approval_mode`、`model_id`、`reasoning_effort`；取 D4 的次序（与 040 一致），写进 PR 偏离记录。
  - 定位照 4.1：`POS_041 = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_041)`、`RECEIPTS_BEFORE_041 = TRACKED_MIGRATION_FILENAMES.slice(0, POS_041)`；断言 `ledgerRows(db)[POS_041 - 1]` 等于 `[POS_041, MIGRATION_040]`、`[POS_041]` 等于 `[POS_041 + 1, MIGRATION_041]`、`countReceipts(db, MIGRATION_041) === 1`。不写死 `15`、不用 `.at(-1)`；文件里既有的 `POS`（040）不改名。
  - 必须手改的既有断言之一 `server/test/core-db-helpers.ts`：加 `MIGRATION_041`，追加进 `TRACKED_MIGRATION_FILENAMES`，`COMPLETE_CATALOG.receipts` 加 `[15, MIGRATION_041]`，`sequenceRows` 14 → 15，`triggerNames` 不变。
  - 之二 `server/test/core-db-session-fixture.ts:299`：`preservedState().indexSql` 的过滤改为 `tbl_name NOT IN ('chat_turn_snapshots','account_composer_prefs')`，同步其上的注释。这是 039 的先例，不是放宽：新表整张由 041 自己的测试覆盖，写进偏离记录。（TEXT 主键带来 `sqlite_autoindex_account_composer_prefs_1`，不改的话 036–040 的 `preservedState` 相等断言会红——按 SQLite 行为推断，先跑一次确认确实红再改。）
  - 之三 `server/test/auth-schema.test.ts:497`：`businessObjectNames(db,"table")` 列表在 `"accounts"` 前插入 `"account_composer_prefs"`。
  - 之四、之五：`core-db-chat-step-output.test.ts:64-73` 与 `migration-034.test.ts:247-257` 的排除表各加 `MIGRATION_041`。
  - 预期不用改、红了先查原因：`core-db-session-todo`、`core-db-turn-snapshots`、`core-db-workspace-temporary`、`core-db-session-metadata`、`core-db-chat-schema`、`audit-schema`、`workspaces-schema`，以及本文件 040 的三组用例。
  - 「建表与约束」形状（并入 `core-db-session-composer.test.ts`，新 `describe("migration 041 …")`）：新库 `:memory:` 与新文件各一例；存量库用 `seedThrough(file, RECEIPTS_BEFORE_041, seedPopulated035)`。断言 `pragma_table_info` 五行字面量（`account_id` TEXT notnull=1 pk=1；三列 TEXT notnull=0 dflt=null pk=0；`updated_at` INTEGER notnull=1 dflt=null pk=0）、`sortedForeignKeys(db,"account_composer_prefs")` 等于 `[{from:"account_id",table:"accounts",to:"id",on_delete:"CASCADE"}]`、`preservedState` 前后相等（`chat_sessions` 的列集含 040 的三列）、`expectFixture035`、`PRAGMA foreign_key_check` 为空、`expectRepeatedOpenStable`。
  - 「建表与约束」取值（`withOpenDb(":memory:")`，账号用 010 种的 `u1`、`u2`）：合法行含三列全 NULL 与全有值、`updated_at` 取 0；同一 `account_id` 再插 → `/UNIQUE constraint failed/`；`approval_mode` 的 `Write`、`auto`、`''` 与 `reasoning_effort` 的 `auto`、`ultra`、`High`、`''` → `/CHECK constraint failed/`；`updated_at` 的 `-1`、`1.5` → CHECK，NULL → `/NOT NULL constraint failed/`；`account_id` NULL → NOT NULL，`'nobody'` → `/FOREIGN KEY constraint failed/`；`model_id` 任意文本接受。每次拒绝后表内行不变。
  - 第三条 `it`（落实条文「不使用 `IF NOT EXISTS`」与「原子建立」，不是新场景）：种到 040 后预置 `CREATE TABLE account_composer_prefs (account_id TEXT PRIMARY KEY)`，`expectOpenDbFailure(file, /table account_composer_prefs already exists/)`。失败后断言回执等于 `RECEIPTS_BEFORE_041`、无 041 回执、`sqlite_master` 里该表的 `sql` 仍是预置原文、`expectFixture035`；`DROP TABLE` 后重开，041 恰一次。
  - 「随账号级联」：`withOpenDb(":memory:")`（`openDb` 已执行 `PRAGMA foreign_keys = ON`，先断言它为 1）。给 `u1`、`u2` 各插一行，`DELETE FROM accounts WHERE id = 'u1'`，断言 `u1` 的行消失、`u2` 的行逐列不变、`foreign_key_check` 为空。
  - 041 的变异（写进 PR；任务号 4.4 在 #995 勾）：去掉任一列 CHECK 或把 `auto` 加回强度 CHECK → 「建表与约束」红；去掉 `updated_at` 的 `typeof` 半句 → `1.5` 用例红；去掉 `account_id` 的 `NOT NULL` → NULL 用例红；去掉 `REFERENCES` → `'nobody'` 用例红；去掉 `ON DELETE CASCADE` → 「随账号级联」红；任一列加 DEFAULT → `pragma_table_info` 字面量红；写成 `IF NOT EXISTS` → 第三条 `it` 红。
  - 守卫：测试文件 281 → 约 430 行，给 042 留余量；取值用 `it.each` 表，不整段抄 `core-db-turn-snapshots.test.ts`（jscpd）。
- [x] 4.3 `042_chat_message_attachments.sql`（message-attachments「迁移 042」）。测试并入同文件：新库与存量库、中途失败原子回滚。
- [x] 4.4 变异证据：去掉任一 CHECK、给列加缺省值、把 041 写成 `IF NOT EXISTS` → 对应场景判红。三个文件按编号顺序各自独立应用。本组在 C 的 037–039 合入之后才合入（见文首；不得让 040 先于 037–039 进入任何持久库）；测试断言 040「紧随上一个回执」而不是写死序数。
  **实施注记（4.3、4.4，fixture 评审补充，#995）**：
  - DDL 逐字照规格，仅一条：`ALTER TABLE chat_messages ADD COLUMN attachments TEXT NULL;`。规格写明「不带 CHECK」，所以不加 `json_valid` / `json_type` 之类约束，内容合法性是 12.1 的应用层职责（D12）；无 DEFAULT、无索引、无事务语句。先例是 `035_chat_session_metadata.sql:12`（`thinking`）与 033（`output`），头注释照 040 / 041 风格。
  - 定位照 4.1 / 4.2：`POS_042 = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_042)`、`RECEIPTS_BEFORE_042 = TRACKED_MIGRATION_FILENAMES.slice(0, POS_042)`。`expect042Applied(db)` 断言 `ledgerRows(db)[POS_042 - 1]` 等于 `[POS_042, MIGRATION_041]`、`[POS_042]` 等于 `[POS_042 + 1, MIGRATION_042]`、`countReceipts === 1`，不写死 `16`、不用 `.at(-1)`；既有的 `POS`、`POS_041` 不改名。
  - `expect042Applied` 的列形状：`pragma_table_info('chat_messages') WHERE name='attachments'` 等于字面量 `{name:"attachments",type:"TEXT",not_null:0,dflt_value:null,pk:0}`；`columnNames(db,"chat_messages")` 的前 7 个等于 `COLUMNS_035.chat_messages`，第 8 个（`slice(7, 8)`）等于 `["attachments"]`；再调 `expectChatSchema(db)`。041 没给被保留的表加列，不需要 `COLUMNS_041`，沿用 `COLUMNS_040`。
  - 必须手改之一 `server/test/core-db-helpers.ts`：加 `MIGRATION_042 = "042_chat_message_attachments.sql"`，追加进 `TRACKED_MIGRATION_FILENAMES`（:23-39）；`COMPLETE_CATALOG.receipts` 加 `[16, MIGRATION_042]`（:99 之后）；`sequenceRows` 15 → 16（:101）；`triggerNames` 不变。这就是「目录计数加一」，`core-db-catalog.test.ts` 经它生效，自身不改。
  - 之二 `server/test/core-db-session-fixture.ts`（陷阱）：`CHAT_TABLE_INFO.chat_messages`（:69-77）尾部加 `["attachments","TEXT",0,null,0]`，同时 **:107 的 `namesBefore035(CHAT_TABLE_INFO.chat_messages, 1)` 改成 `2`**，并同步 :99 的注释。漏改的话 `PRIOR_COLUMNS.chat_messages` 会多出 `thinking`，`insertRows` 拼出 7 列对 6 值，034–041 的升级用例成片变红，原因与 042 无关。
  - 之三至之五，各加一行：`core-db-chat-schema.test.ts:311` 之后加 `["attachments","TEXT",0,null,0,0]`（`table_xinfo` 六元组，776 → 777 行）；`migration-034.test.ts:125` 之后加五元组，:258 的排除表加 `MIGRATION_042`（689 → 691 行）；`core-db-chat-step-output.test.ts:75` 的排除表加 `MIGRATION_042`。不放宽、不删任何断言。
  - 预期不用改、红了先查原因：`auth-schema.test.ts`（没有新表）；`core-db-session-fixture.ts:299` 的 `preservedState().indexSql`（042 不带索引）；`migration-034.test.ts:397-404`（`slice(0,14)` 与固定下标）；`core-db-turn-snapshots.test.ts`（`LEDGER_TAIL` 钉 11–13，ADD COLUMN 不重建表，`chat_turn_snapshots → chat_messages` 的外键与级联用例不受影响）；`core-db-workspace-temporary.test.ts:201`；`core-db-session-metadata.test.ts`（`LEDGER` 由目录派生）。`expectChatSchema` 的全部调用点（`core-db-session-archive` / `-todo` / `-metadata` / `-composer`）都在迁到头的库上。三处 `SELECT * FROM chat_messages`（`session-archive-readonly.test.ts:294`、`session-regenerate-helpers.ts:101`、`session-store-undo-transaction.test.ts:46`）都是同库前后比较。
  - 「新库与存量库」并入 `core-db-session-composer.test.ts`，新 `describe("migration 042 …")`。新库 `:memory:` 与新文件各一例：`expect042Applied` + `expect041Applied` + `expect040Applied`，再断言 `ledgerRows(db).slice(POS, POS + 3)` 恰为 040、041、042 且序数连续（4.4「按编号顺序」）。存量库用 `seedThrough(file, RECEIPTS_BEFORE_042, seedPopulated035)`：升级前 `columnNames(db,"chat_messages")` 等于 `COLUMNS_035.chat_messages`；升级后 `preservedState(db, COLUMNS_040)` 前后相等、`expectFixture035`、`SELECT id, attachments FROM chat_messages ORDER BY id` 为保留的 6 行（id 由 `EXPECTED_ROWS.chat_messages` 派生）全 NULL、`PRAGMA foreign_key_check` 为空、`expectRepeatedOpenStable`。
  - 「不带 CHECK」的落实（不是新场景，`pragma_table_info` 看不到 CHECK）：在 `withOpenDb(":memory:")` 建一个会话，插三条消息，`attachments` 分别取 NULL、`'[{"path":"uploads/a.txt","size":3}]'`、`'not json'`，再把一条 UPDATE 成 `''`，逐条读回 `attachments` 与 `typeof` 原样相等。不要另造「列约束」拒绝用例，042 没有非法值。
  - 「中途失败原子回滚」：`seedThrough(file, RECEIPTS_BEFORE_042, …)` 里 `seedPopulated035` 后执行 `ALTER TABLE chat_messages ADD COLUMN attachments TEXT`，并给消息 5 写入 `'planted'`；`expectOpenDbFailure(file, /duplicate column name: attachments/)`。失败后断言 `ledgerFilenames` 等于 `RECEIPTS_BEFORE_042`、无 042 回执、`sqlite_master` 里 `chat_messages` 的 `sql` 与失败前相同、`'planted'` 仍在、`preservedState` 与 `expectFixture035` 不变；`ALTER TABLE chat_messages DROP COLUMN attachments` 后重开，`expect042Applied`、全 NULL、`expectRepeatedOpenStable` 里回执恰一次。
  - 4.4「各自独立应用」的断言，再加一条 `it`：`seedThrough(file, RECEIPTS_BEFORE, …)`（止于 039）并预置同一冲突列，`expectOpenDbFailure` 之后断言 `ledgerFilenames` 等于 `RECEIPTS_BEFORE_042`。这说明同一次 `openDb` 里 040、041 已各自提交（040 三列在、`account_composer_prefs` 表在），只有 042 被回滚；`DROP COLUMN` 后重开三个回执各一次。依据是 `migration-runner.ts:16-29` 每个文件一个事务。
  - 偏离记录：(1) 单语句文件没有中间态，「原子」证到「失败即无回执、预置列原样」，与 041 同措辞；跨文件的原子性由上一条 `it` 补足。(2) issue 的 PR Boundary 只列了三项，实际另改四个既有测试文件（上面之二至之五），加 `core-db-helpers.ts`。(3) 上一条 `it` 测的是 runner 行为，本 PR 的 diff 里没有能使它单独变红的变异，如实写明。
  - 4.4 在本 PR 还需要的东西（做完即可勾 4.3、4.4）：PR 描述给出 042 的变异表，并写一句「040、041 的条款见 #1233、#1238 的 PR 描述」。变异表：加 `DEFAULT ''` 或 `DEFAULT NULL` → 新库两例、存量库、回滚重试共 4 例红（`dflt_value` 字面量）；加 `CHECK (json_valid(attachments))` → `'not json'` / `''` 用例红；改成 `NOT NULL` → 存量库 ADD COLUMN 直接失败；多加一列或一个索引 → `expectChatSchema` / `preservedState` 红；删掉文件 → 042 全部用例与 `COMPLETE_CATALOG` 红。4.4 原文的「去掉任一 CHECK」「`IF NOT EXISTS`」对 042 不适用（无 CHECK，ADD COLUMN 也没有这个语法）；「040 紧随上一个回执」「037–039 先于 040」主干已满足，无新工作。
  - 守卫：测试留在同一文件，530 行加约 150 行，约 680 行，低于 800，不另开新文件；文件头注释补 #995 一段。jscpd：这是第三段相似的升级 / 冲突用例，`expect042Applied` 复用既有助手，「前后相等」那几行抽成文件内小函数，不整段抄 041。knip：`MIGRATION_042` 由测试引用，成立。`server/src` 只多一个 `.sql`，迁移靠扫描发现，无注册表可改。

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
- [x] 7.1 `server/src/sessions/omp/process.ts`（788 行）与 `omp/runtime.ts`（798 行）：
  第一次提交（纯搬迁）：把 `runtime.ts` 里 `command()` 入参的内联帧联合类型（现 `runtime.ts:259-262`）原样搬到 `omp/commands.ts`（350 行）并具名导出，`runtime.ts` 只引用它（净减约 3 行）；行为不变，既有测试原样通过。
  第二次提交：`SpawnOmpOpts` 增 `approvalMode`，argv 的 `--approval-mode` 取它；不是三个字面量之一时不 spawn（抛出，走既有的准备失败路径）；`--model` 仍取 `opts.modelId`（调用方此后传会话的有效模型）。`OmpProcessOpts extends SpawnOmpOpts`，而 `runtime.ts:426-431` 是逐字段显式构造 `new OmpProcess({…})`——所以 `SessionRuntimeOpts` 同刀增 `approvalMode` 并在该构造处透传（约 +4 行，由第一次提交腾出）。档位校验不新增函数：`process.ts` 从 `../../model-catalog.js` 导入既有的 `APPROVAL_MODES` 与 `type ApprovalMode`，在 `spawnOmp` 入口内联判断（`process.ts` 约 793 行）；不放进 `commands.ts`（它已值导入 `./process.js`，会成环）。1.0 留下的测试用 spawn 包装只删改写 `--approval-mode` 的那一半：world 把 `spawnArgs.approvalMode`（缺省 `write`）直接传给 `SessionRuntime`；`hostOverlay: false` 的那一半（去掉 argv `--config` 与 env `PI_CONFIG_FILES`）保留，它是 1.2 负向对照的唯一手段，产品不提供不带 overlay 的 spawn。
  测试 `server/test/omp-process.test.ts` / `omp-spawn-cwd.test.ts`：omp-runtime delta「参数与目录」的改写断言、「档位与模型按会话进入 argv」「非法档位不 spawn」。变异：argv 写死 `write`、非法档位回退为 `write`、`runtime.ts` 不透传（`OmpProcess` 收到 undefined）→ 判红。
- [x] 7.2 `omp/commands.ts` 与 `omp/runtime.ts`：`command()` 的帧联合类型（7.1 已搬到 `commands.ts`）加 `set_model`、`set_thinking_level`，新增的判定辅助也放 `commands.ts`；`runtime.ts` 不加行。
  测试 `server/test/omp-runtime-commands.test.ts`：omp-runtime「模型与推理强度命令」三条场景（假 omp 真子进程，依赖组 6）。变异：命令在回合中不抛 `SessionBusyError`、失败应答不拒绝 → 判红。
  **实施注记（7.2，fixture 评审补充，#1001）**：
  - 行数现状（origin/master 4e61e91）：`omp/runtime.ts` 799、`omp/commands.ts` 355、`omp/process.ts` 793、`test/support/fake-omp.mjs` 797、`test/omp-runtime-commands.test.ts` 743（issue 写的「新文件」不成立，文件已存在，余量 57 行）。
  - 产品改动只有一处：`commands.ts` 的 `RuntimeCommandFrame` 追加 `| { type: "set_model"; provider: string; modelId: string }` 与 `| { type: "set_thinking_level"; level: string }`（355 → 357）；`runtime.ts` 零改动（仍 799），`command(frame: RuntimeCommandFrame)` 与 `#runCommand(frame: OmpFrame)` 不动。
  - 规则已通用，不写新代码：忙检查在 `runtime.ts:267-268`（`#turn !== undefined || #commanding` 同步抛 `SessionBusyError`，先于任何写帧）；`success !== true` 在 `#runCommand` 抛 `AgentUnavailableError("<type> failed")` 且不回收 generation；返回 `response.data`（`set_thinking_level` 无 data 即 `undefined`）；`stateSessionFile` 只认 `get_state`，两种新帧不改 last-known-good 会话文件。
  - 偏离记录：任务原文的「新增的判定辅助」不新增——没有可判定的东西；`commands.ts` 的导出函数在本刀也没有 src 读者（调用方在 9.2），联合类型成员不受 knip 检查。
  - 帧形状三处一致：design 事实表第 27-28 行、`omp-official-model-commands.test.ts:252-257`（`{type:"set_model",provider,modelId}`、`{type:"set_thinking_level",level}`）、`fake-omp-composer.mjs` 的 `commandAnswer`（成功 data 为 `{provider, id}`；强度成功无 data）。
  - 假 omp 不改（797 行）：`fake-omp.mjs:215-216` 对所有场景无条件接了 `handleCommand`；失败模型 id 是字面量 `workbuddy-missing-model`（`fake-omp-composer.mjs` 的 `MISSING_MODEL` 未导出，测试里写字面量）。
  - 「回合之间设置模型与强度」：`describe("SessionRuntime command()")` 下新增一例，`openReal("normal")`。断言 `set_model`（`workbuddy` / `m3`）resolve 为 `{provider:"workbuddy", id:"m3"}`、`set_thinking_level`（`low`）resolve 为 `undefined`；`written(world, …)` 各恰一帧且除 `id` 外与入参逐键相等；`set_model` 那条 stdin 记录的 `issued === 1`；`runtime.sessionFile` 前后不变。
  - 同例后半：一条 prompt 加 `probeFrames`，等于 `negotiate_protocol,get_state,set_model,set_thinking_level,prompt,prompt`；`world.argv` 与 `tokens.issued` 长度都是 1；自行 `shutdown`（`expectSameGeneration` 会先关停，不能用在 probe 之前）。
  - 「模型不存在」新增一例：`set_model` 带 `workbuddy-missing-model` 以 `AgentUnavailableError` 拒绝；`world.exits` 为空、`sessionFile` 不变；随后 `set_model` 到 `m3` 成功，`expectSameGeneration(world, "hi")` 通过（一次 spawn、一次 issue）。
  - 「回合中不可用」不新开用例，加强既有 C3（`abort-ok`）：回执前后各加 `set_model` 与 `set_thinking_level` 两条 `toThrow(SessionBusyError)`，收尾加 `written(world,"set_model")` 与 `written(world,"set_thinking_level")` 为空；既有的 `untilDeltas(iterator, 2)` 与 abort 收尾即「在途回合不受影响」。不用 `normal` 场景：回执与终态可能同一 chunk 到达，回合是否在途有竞态。
  - 行数：三处合计约 45 行（743 → 约 790）。biome 格式化后超过 800 时，先单独一次纯搬迁提交，把 `RealWorld` / `openReal` / `tapStdin` / `written` / `probeFrames` / `expectSameGeneration` 搬到 `server/test/support/omp-runtime.ts`（264 行），不另建复制 opener 的测试文件。
  - 同刀顺手：`omp-official-model-commands.test.ts:99-102` 的 `rpc()` 去掉 `as never` 与「group 7 adds them」注释，入参类型改为 `RuntimeCommandFrame`。该文件只在 `WORKBUDDY_OMP_TEST=1` 的 CI uid-isolation job 运行，本地只有类型检查，PR 描述写明这一验证缺口。
  - 源码边界用例 G1（`commands.ts` 只以 `import type` 触及 `runtime.js`）不受影响；`fake-omp-early-abort.test.ts:195` 与 `fake-omp-metadata-scenarios.test.ts:637` 的五文件 ≤800 行断言因假 omp 未动而原样通过。
  - 变异 → 判红（变异对象都是既有通用代码，偏离记录写明）：去掉 `command()` 的忙检查 → C3 的新旧断言；去掉 `success !== true` 的抛出 → C5 与「模型不存在」；`#runCommand` 不返回 `response.data` →「回合之间」的 `{provider, id}` 断言；`stateSessionFile` 去掉 `get_state` 限定 → `sessionFile` 不变断言不一定红（假 omp 的 `set_model` data 无 `sessionFile`），记为写不出变异的防御条件；删掉联合成员 → 新用例类型检查失败。
- [x] 7.3 `server/src/sessions/pool.ts`（324 行）：`sessionRuntimeOpts` 的 per-runtime 入参增 `approvalMode` 与 `modelId`，不再读 `base.modelId`；本任务里两个调用点——`supervisor.ts:483`（prompt 与 regenerate 共用的 slot 进程，用 7.0 的余量）与 `branch-temp.ts:82`（fork 与 C 的撤回共用的临时进程；`branching.ts`、`undo.ts` 都经 `BranchTemps.branchAt`，自己不调，不改）——先一律传 `"write"` 与白名单缺省模型（`SessionSupervisorRuntime.modelId`；行为与今天相同，组 9 再换成会话的有效值）。
  测试：既有 dispatch / fork / regenerate 用例原样通过；`omp-host-overlay.test.ts` 加「overlay 不随档位变化」场景（三种档位各 spawn 一次后文件字节不变、`--config` 路径相同）。
  **实施注记（7.1 + 7.3，fixture 评审补充，#1000）**：
  - 行数现状（origin/master 55af070）：`process.ts` 788、`runtime.ts` 798、`commands.ts` 350、`pool.ts` 324、`supervisor.ts` 779、`branch-temp.ts` 203、`branching.ts` 332、`undo.ts` 364；7.1 引的 `runtime.ts:426-431` 实为 `#openProcess` 的 425-441（`modelId` 在 431），`command()` 的内联联合在 258-263。
  - 提交一（纯搬迁，只动两个文件）：`commands.ts` 加 `export type RuntimeCommandFrame = { type: "get_branch_messages" } | { type: "get_state" } | { type: "branch"; entryId: string }`（三个成员逐字取自 `runtime.ts:260-262`）；`runtime.ts` 的 `command(frame: RuntimeCommandFrame)` 收成一行，并在既有 `./commands.js` 导入块加 `type RuntimeCommandFrame`（798 → 794）；`#runCommand(frame: OmpFrame)` 不动，测试零改动。
  - 提交二 `process.ts`：`SpawnOmpOpts` 加必填 `approvalMode: ApprovalMode`；`spawnOmp` 第一条语句 `if (!APPROVAL_MODES.includes(opts.approvalMode)) throw new Error("invalid approval mode")`，先于 `assertSafeSudoPath` 与一切建目录；argv 第 96 行 `"write"` 改 `opts.approvalMode`；`--model` 仍是 `workbuddy/${opts.modelId}`，spawn 不校验模型（组 9 / 白名单负责）。抛出经 `#boot` 的 `sanitizeIo` 变成 `AgentUnavailableError("spawn failed")`，即既有的准备失败路径。
  - 提交二 `runtime.ts`（794 → 799，只剩 1 行，不加注释）：`SessionRuntimeOpts.approvalMode: ApprovalMode`（+1）、`readonly #approvalMode`（+1）、构造函数赋值（+1）、`#openProcess` 字面量 `approvalMode: this.#approvalMode`（+1）、`import type { ApprovalMode } from "../../model-catalog.js"`（+1）。
  - 提交二 `pool.ts`：`PerRuntime` 的 `Pick` 加 `"modelId" | "approvalMode"`；`sessionRuntimeOpts` 返回 `modelId: per.modelId`、`approvalMode: per.approvalMode`，不再读 `base.modelId`。`supervisor.ts:483` 字面量加 `approvalMode: "write", modelId: this.#runtime.modelId`（779 → 781）；`branch-temp.ts:82` 加 `approvalMode: "write", modelId: this.#ports.config.modelId`。`SessionSupervisorRuntime.modelId` 本刀仍有这两个读者，留给 7.4。
  - 类型必填带来的机械改动（`server/tsconfig.json` 的 include 含 `test`，都在提交二，各加一行 `approvalMode: "write"`，超出 issue 原 PR Boundary，写进偏离记录）：`support/omp-rpc.ts:74`（`tempOpts`，覆盖全部 `...harness.tempOpts()` 展开，含 790 行的 `omp-runtime.test.ts`）、`omp-process.test.ts:501`（786 → 787）、`omp-spawn-cwd.test.ts:89,275`、`sudo-launcher.test.ts:49`、`omp-spawn-dotenv-pins.test.ts:70`、`omp-state-layout.test.ts:107,512`、`commands-rest.test.ts:259`、`omp-spawn-gate.test.ts:119`、`omp-approval-requests.test.ts:123,419`、`omp-runtime-commands.test.ts:107`、`omp-runtime-exit-pending.test.ts:99`、`omp-runtime-abort-start.test.ts:78`（后三处是 `...real.runtime` 展开）、`linux/uid-isolation.test.ts:355`、`support/omp-official.ts:255`。`SessionSupervisorRuntime` 形状的字面量（`session-supervisor-helpers.ts`、`server-assembly.test.ts`、`commands-rest-helpers.ts`、`workspaces-http-helpers.ts`、`uid-isolation.test.ts:170` 等）不加。
  - 必须逐字节不变的 argv 期望（「调用点仍传 write 与缺省模型」的证据，任何一处变红先查实现）：`omp-process.test.ts:508-527` 的 `coldArgs` 及全部 `toEqual(coldArgs…)`、`server-assembly.test.ts:739-761` 的 `ompArgs`、`omp-approval-requests.test.ts:132`、`omp-runtime-exit-pending.test.ts:404`；`omp-layout-helpers.ts:31-52` 的 `HOST_OVERLAY_YAML` 与 `omp/host-overlay.ts` 的常量不动。「参数与目录」改写后的断言由 `omp-process.test.ts:127,140,143` 的整份 argv 等值覆盖（`--approval-mode` 恰一次且为 `write`），不必加新断言。
  - 新用例全部放 `omp-spawn-cwd.test.ts`（297 行；`omp-process.test.ts` 与 `omp-runtime.test.ts` 没有余量）：`spawnOpts` 与 `contractArgs(roots, cwd, mode = "write", model = MODEL)` 加带缺省值的参数，既有调用不改；复用 `recorder`（`FakeChild`，不起真进程）。
  - 「档位与模型按会话进入 argv」：（`always-ask`, `m3`）与（`yolo`, `m1`）各冷启动加一次 `resumePath` 非 null，四份 argv 等于 `contractArgs(…, mode, model)`（resume 的末尾多 `--resume <path>`）；`options.env` 与 `write` 档基线 `toEqual`，`--config` 与 `PI_CONFIG_FILES` 都等于 `ompHostOverlayPath(stateDir)`。运行时一例：扩展 `SessionRuntime cwd wiring` 的 `firstSpawn`，以 `always-ask` / `m3` 构造，断言首个 argv 的两处取值。
  - 「非法档位不 spawn」：`it.each(["auto", "", undefined])` 经 `as never` 传入，`spawnOmp` reject、`calls` 为 0、`ownDirs` 四个目录都没被建出；运行时一例（`approvalMode: "auto" as never`）：`prompt().dispatched` 以 `AgentUnavailableError` 拒绝、spawnImpl 调用 0 次、`tokens.revoked` 等于 `tokens.issued` 且 `live` 为空。偏离记录：`tokens.issue` 在 `runtime.ts:368` 先于 `spawnOmp`，「不签发可用 token」按 `expectFailedAcquisition("obstructed-dir")` 的先例落实为签发后同步撤销。
  - `pool.ts` 透传一例（任务原文未列，否则调用点都传 `write` 时没有测试能判红）：放 `omp-spawn-cwd.test.ts`，直接调 `sessionRuntimeOpts({ …, modelId: "base-model" }, shared, { …, approvalMode: "yolo", modelId: "m3" })`，断言返回值的 `approvalMode === "yolo"`、`modelId === "m3"`。
  - 「overlay 不随档位变化」放 `omp-host-overlay.test.ts`（93 行）：`ensureOmpStateLayout` + `writeHostOverlay` 后以三档各调一次 `spawnOmp`（记录型 spawnImpl），每次之后 `expectHostOverlay(state)`、`readdirSync(ompAgentDir(state))` 等于 `["host-overlay.yml"]`，三次的 `--config` 与 `env.PI_CONFIG_FILES` 都等于 `ompHostOverlayPath(state)`。
  - `support/omp-official.ts`：`rewritingSpawn` 去掉 `approvalMode` 分支与入参，只在 `hostOverlay === false` 时装上；`open()` 传 `approvalMode: runtimeOptions.spawnArgs?.approvalMode ?? "write"`；96 行处的注释随之改写。官方对照用例只在 CI 的 uid-isolation job（`WORKBUDDY_OMP_TEST=1`）运行，本地 `make check` 只做类型检查，PR 描述写明这一验证缺口并贴该 job 的结果。
  - 变异 → 判红：argv 写死 `write` →「档位与模型按会话进入 argv」；非法档位回退 `write`（或去掉判断）→「非法档位不 spawn」；`#openProcess` 不透传 → 运行时一例（收到 undefined 即抛，`dispatched` 拒绝）；`sessionRuntimeOpts` 仍读 `base.modelId` 或写死 `write` → `pool.ts` 透传一例；`--config` 按档位取路径 →「overlay 不随档位变化」；`--model` 写死缺省模型 →「档位与模型」的 `m3` / `m1`。supervisor 或 `branch-temp` 调用点传非 `write` → `server-assembly.test.ts` 的 `ompArgs` 与假 omp 的审批门控用例。
- [x] 7.4 清理：`AgentSettings` 上的派生字段 `modelId`、`modelReasoning` 删除——`server.ts` 的 `sessionRuntimeOf` 改读 `config.modelCatalog.defaultModelId`，此后两个字段在 `src` 里没有读者（类型检查把关：knip 不检查 interface 字段）；`SessionSupervisorRuntime.modelId` 本任务不动（7.3 的两个调用点与 `createApp` 的白名单回退仍在读，见 9.1），`SessionSupervisorRuntime` 上没有 `modelReasoning`。`omp/host-overlay.ts` 的文件头注释按 omp-runtime delta 改写（argv 压过 overlay、文件不随档位变化），常量字节不动（`omp-host-overlay.test.ts` 的逐字节断言原样通过）。
  **实施注记（7.4，fixture 评审补充，#1002）**：
  - 读者现状（origin/master 4e61e91）：`AgentSettings.modelReasoning` 定义在 `agent-config.ts:60`、赋值在 `:117-119`，`src` 零读者；`AgentSettings.modelId` 定义在 `:57`、赋值在 `:115`，`src` 唯一读者是 `server.ts:87`；`models.yml` 写出器读的是 `config.modelCatalog.models`（`server.ts:337`），模型代理不读这两个字段。
  - 改动面：`agent-config.ts` 删两个字段、两行注释与两处赋值（231 → 约 223）；`server.ts:87` 改为 `modelId: config.modelCatalog.defaultModelId`（行数不变）；`SessionSupervisorRuntime` / `app.ts` / `supervisor.ts` / `branch-temp.ts` / `pool.ts` 不动。
  - 把关是 `make typecheck`，不是 knip（knip 不报 interface 字段）；PR 描述另贴 `git grep -n 'modelReasoning' -- server web` 为空、`git grep -n 'config\.modelId\|settings\.modelId' -- server` 为空。
  - 必须改写的断言之一，`server/test/model-catalog.test.ts:308-349`：三例里的 `settings.modelId` / `settings.modelReasoning`（321-322、331-332、347-348）改为经 `settings.modelCatalog` 断言（`defaultModelId` 已由同例的 `toStrictEqual` 覆盖，推理位断言该缺省模型条目的 `reasoning`）；标题里的「派生值」「原样进入三处」随之改名。
  - 必须改写的断言之二，`server/test/model-proxy-reasoning.test.ts`：`resolveServerConfig — MODEL_REASONING` 一组（97-118）与编译入口一例（181-185）读 `config.modelReasoning`，`:114` 读 `config.modelId`。改为 `config.modelCatalog.models[0]?.reasoning` 与 `config.modelCatalog.defaultModelId`；`:100` 的 `Object.hasOwn(config,"modelReasoning")` 改为对 `modelCatalog` 的自有字段断言。`MODEL_REASONING` 的解析仍在 `model-catalog.ts`，用例一条不删。
  - 必须改写的断言之三，`server/test/server-config.test.ts`（771 行，原地改不加行）：`:27,38,48` 的本地 `AgentSettings` / `sevenDefaults` 取 `config.modelCatalog.defaultModelId`；`:82,252,278,321` 的 `toMatchObject({ modelId })` 改为 `modelCatalog: { defaultModelId }`（`" custom-model "` 与 `"model-bytes"` 两例钉的是 `MODEL_ID` 字节原样，必须保留）；`:117` 同改。
  - 三个文件的改写都写进偏离记录（读法迁移，强度不变）。
  - 不改的测试：`SessionSupervisorRuntime` 形状的字面量全部保留 `modelId`——`session-supervisor-helpers.ts:37,122,160`、`server-assembly.test.ts:289,583,704`、`commands-rest-helpers.ts:85`、`workspaces-http-helpers.ts:30`、`linux/uid-isolation.test.ts:170`、`omp-max-processes-config.test.ts:99`、`slash-commands-skills-hardening.test.ts:693`；`sessionRuntimeOf` 的输出不变，`server-assembly.test.ts` 的 `ompArgs` 逐字节不变。
  - overlay 注释只改 `host-overlay.ts:1-7` 的文件头 docblock，保留现有五句，补两点：(a) `tools.approvalMode: write` 低于 argv——omp v18.0.10 把 `--approval-mode` 写进高于 overlay 的运行期覆盖层，`always-ask` / `yolo` 会话生效的是 argv 的值，这一行只是 argv 缺席时的兜底（argv 恒在）；(b) 全部会话、全部档位共用这一份文件，字节不随档位变化，档位改变靠重新 spawn 而不是改写它。
  - `HOST_OVERLAY` 数组（12-37 行）与其中两条行内注释一个字符不动。`omp-layout-helpers.ts:31-52` 的 `HOST_OVERLAY_YAML`、`omp-host-overlay.test.ts`（126 行，含 #1000 加的「overlay 不随档位变化」）、`server-startup-layout.test.ts` 零改动且原样通过；ADR-0012 的补充已在 `docs/adr/0012…md:62-65`，本刀不碰（19.1）。
  - 变异证据：字段删除与注释改写没有行为变异，偏离记录写明。可给的一条：`server.ts:87` 误写成 `config.modelCatalog.models[0].id` → `model-catalog.test.ts` 三模型 `MODEL_ID=m2` 一例不红（它不经 `sessionRuntimeOf`），所以在 `omp-max-processes-config.test.ts:99` 所在的 `sessionRuntimeOf` 断言旁补一例 `MODEL_CATALOG` 三模型加 `MODEL_ID=m3` → `modelId === "m3"`，该变异判红。
  - 与兄弟刀的次序：与 #1001 无文件交集。#1004 的分支也改 `server/src/server.ts` 与 `app.ts`，后合入的一方 rebase；若 #1004 的 `createApp` 回退读的是 `runtime.modelId`（不是 `AgentSettings.modelId`），与本刀不冲突。

Suggested fixture level: expanded - omp 子进程 spawn 契约（审批档位）与运行时公共命令面；Critical Path
Minimal mergeable slice: 7.0 一刀（仅当需要腾行）；7.1（搬迁提交 + argv 与透传提交）+ 7.3 一刀（档位从 `pool.ts` 的入参贯通到 argv：`pool.ts` → `SessionRuntimeOpts` → `OmpProcess` → `spawnOmp`，调用点仍传 `write`，行为不变，类型检查通过）；7.2 一刀（两种命令帧）；7.4 随第一刀或单独一刀

## 8. sessions store + REST — 会话的三项输入框设置

- [x] 8.0 `store.ts` 腾行（**纯搬迁，单独一次提交 / PR，行为不变**）：按 0.1 记下的落点——C 的 1.3 若已把 `SessionView` / `SESSION_COLUMNS` / `SessionDbRow` / `toSessionView` 搬出 `store.ts`（到 `store-view.ts` 或 `store-branch.ts`），沿用 C 的落点，本任务只确认 `store.ts` 的余量不少于 15 行，不足时把 `runtimeState` 的行映射也搬到同一个文件；
  C 若把它们留在了 `store.ts`，本任务把这四个符号原样搬到新文件 `server/src/sessions/store-view.ts`（`store.ts` 改为从它导入并照旧再导出，调用方不动）。15 行的用途：8.1 的 `runtimeState` 三列（约 +4）与视图构造多收一个配置参数（约 +3）、12.2 的 `acceptPrompt` 多一个参数与一次调用（约 +4）。验证：`make check`，既有 store 与 REST 测试原样通过。
  核对记录（#1003）：C 的 1.3 已把四个符号搬到 `store-view.ts`，沿用该落点；`store.ts` 766 行，余量 34 行，不少于 15 行，未产生代码改动。
- [x] 8.1 只读半边——会话视图发出三键：新文件 `server/src/sessions/store-composer.ts`（本任务只放读取：三列的列名常量、行到原始值的映射）；`SESSION_COLUMNS` 加三列、`toSessionView`（在 8.0 确定的文件里）统一经 `effectiveComposer`（组 2.3）加上三键——只有一处构造函数，列表、创建、PATCH、快照、fork、undo 共用；`runtimeState` 增报三个原始列（供组 9）。此时三列恒为 NULL，视图恒为缺省有效值。
  测试新文件 `server/test/session-composer-store.test.ts`：三列为 NULL 的行读成缺省有效值；直接写库的原始值经夹取 / 回落后进入视图（session-composer-settings「夹取与回落」在视图层的两例）；`runtimeState` 报出原始列。chat-sessions「Session views carry the three composer settings」里创建与列表两个出口的键集断言。
  **实施注记（8.1 + 8.6，fixture 评审补充，#1004）**：
  - 现状（origin/master 55af070）：`effectiveComposer(raw, config)` 在 `server/src/model-catalog.ts:87-110`，`config` 为 `{ approvalMaxMode, modelCatalog }`；`store-view.ts` 70 行、`store.ts` 766 行、`rest.ts` 521 行、迁移 040 三列已在；`store-metadata.ts` 实为 382 行（8.2 写的 189 已漂移，仍有余量）；`approvalMaxMode` 只到 `ServerConfig`，`AssemblyDependencies`（`app.ts:74`）与 `appAssemblyOf`（`server.ts:105`）都没有它。
  - 配置下传，不读环境：`store-composer.ts` 导出 `type ComposerConfig = Parameters<typeof effectiveComposer>[1]`；`toSessionView(row, decoder, composer)`；`SessionStoreOptions`、`SessionMetadataStoreOptions`、`RegisterSessionsOptions` 各加必填 `composer`，`sessions/index.ts` 传给两个工厂；`AssemblyDependencies` 加可选 `approvalMaxMode`，`appAssemblyOf` 传 `config.approvalMaxMode`。
  - 偏离记录（规格未写的分支）：`createApp` 里 `assembly.modelCatalog` 缺席时取 `resolveModelCatalog({ MODEL_ID: runtime.modelId })`，`approvalMaxMode` 缺席取 `"yolo"`；`app.ts:180` 的代理白名单改用同一份目录；生产路径 `appAssemblyOf` 两项都传，回退只有测试世界走到。
  - `store-composer.ts` 只放读取：三列列名常量（拼进 `SESSION_COLUMNS` 末尾与 `runtimeState` 的 SELECT）、行类型、`rawComposer(row)`；`model_id` 按普通 TEXT 读，不 CAST BLOB（偏离记录：读坏的值不在白名单即回落缺省）。新增值导入方向 `store-view.ts → store-composer.ts → ../model-catalog.ts`，无环；导出全被 `store-view.ts` / `store.ts` 引用，knip 不报。
  - 「只有一处构造函数」现在不成立，要收掉三处手写字面量：`store.ts:261-273`（旧 `create`）与 `store-metadata.ts:169-181`（`view()` 与 `CreatedSessionView`，删掉）改为提交后按 `SESSION_COLUMNS` 读回并走 `toSessionView`。读回与 `store.ts:403-409`、`store-metadata.ts:219-225` 同形，四处抽成 `store-view.ts` 的一个函数，否则 jscpd 会报。
  - `rest.ts:73-85/392-406` 的 `PublicSession` / `toPublicSession` 是出口白名单，必须补三键，否则列表、快照、fork、undo 四个出口静默丢键，而创建与 PATCH（`rest-metadata.ts:96/127` 直接发视图）照发。键序：三键接在 `temporaryWorkspace` 之后，顺序 `approvalMode`、`modelId`、`reasoningEffort`，`toSessionView` 与 `toPublicSession` 一致。
  - `runtimeState`：`SessionRuntimeState` 加一个字段 `composer: { approvalMode, modelId, reasoningEffort }`（原始值，各可 null，可直接当 `effectiveComposer` 的 `raw`）。`store.ts` 净增约 +5 行，再减去 `create` 字面量省下的约 10 行，远低于 800。
  - 本刀三列恒 NULL 时的取值：缺省配置为 `write` / `deepseek-v4.1-flash`（或 `MODEL_ID`）/ `high`（`MODEL_REASONING=off` 时 `null`）。`MODEL_CATALOG` 下 `modelId` 为第一项或 `MODEL_ID` 所指项；强度按 `defaultEffort`。`APPROVAL_MAX_MODE=always-ask` 时档位为 `always-ask`，`write` / `yolo` 时为 `write`。
  - 新文件 `server/test/session-composer-store.test.ts`（store 层，真 SQLite，直接传 `composer`）：(a) NULL 行在缺省配置与 `always-ask` 上界下，`create` 返回值、`list`、`getMessages().session` 三者逐键相等；(b) 直接 UPDATE 三列，「夹取与回落」取两例：`("yolo","m3","xhigh")` / 上界 `write` → `{write,m3,xhigh}`，`("write","gone","medium")` / 上界 `yolo` → `{write,m1,medium}`；(c) 同一库先后以 `yolo`、`write`、`yolo` 三个上界开 store，`approval_mode='yolo'` 的行视图读 `yolo` / `write` / `yolo`，列值不变；(d) `runtimeState().composer` 报原始值（NULL 行三个 null，写库后原样）；(e) REST 层创建 201 与列表项恰十四键且值为 `write` / `deepseek-v4.1-flash` / `high`；(f) `createApp` 带三模型 `modelCatalog` 加 `approvalMaxMode:"always-ask"` 时创建 201 读出目录缺省与 `always-ask`。
  - 共享夹具 `server/test/session-meta-fixtures.ts`：`SESSION_VIEW_KEYS` 改十四键；`NULL_SESSION_META` 加 `approvalMode:"write"`、`modelId:"deepseek-v4.1-flash"`、`reasoningEffort:"high"`；新增 `TEST_COMPOSER`，传给全部直接调用 `createSessionStore` / `createSessionMetadataStore` 的地方（`session-store-helpers.ts`、`session-rest-helpers.ts`、`session-archive.test.ts`、`session-metadata-rest.test.ts`，以及 `core-db-chat-step-output`、`persist-todo`、`session-delete-running`、`session-settlement`、`session-stop`、`session-store-approvals`、`session-store-settlement`、`sqlite-text` 各处）。`session-rest.test.ts`（788 行）只经 `NULL_SESSION_META` 展开，不增行。
  - 各文件自带的键表与整视图字面量逐个改，不得换成 `toMatchObject`：`ELEVEN_KEYS` 在 `session-archive-helpers.ts`、`session-create-temporary.test.ts`、`session-metadata-rest.test.ts`、`session-title-rollback.test.ts`、`session-view-keys.test.ts`；排序键表在 `session-fork.test.ts`；整视图期望在 `session-create-temporary.test.ts`、`session-metadata-rest.test.ts`、`session-snapshot-metadata.test.ts`、`session-view-keys.test.ts`；`runtimeState` 整对象期望在 `session-store.test.ts`；`server-handshake-log.test.ts:141` 旁加 `assembly.approvalMaxMode` 断言。用例标题与注释里的「十一键 / eleven」同步改。
  - `smoke/session-meta.hurl` 四处 `count == 11` 全部改 14：规格只点名第 1、3 步，但第 2、8 步断言的是同一个 DTO。第 1、2、3 步各加三条逐键断言（`write`、`deepseek-v4.1-flash`、`high`），文件头与步骤注释同步。`make smoke` 的三键断言只在缺省单模型配置的服务上成立。
  - web 不改且不会红：会话解析全部经 `parseSession`，`withTransitionalDefaults` 接受十一键或十四键；`web/e2e` 只取字段或断言快照顶层四键。fork / undo 的 `session` 经 `toPublicSession`，列表事件只带 `sessionId`，promote 返回的是空间五键。
  - 本刀测不到的场景（偏离记录）：chat-sessions「carry the three composer settings」只落创建与列表两个出口，PATCH `yolo` 之后的部分在 8.3；「fork 响应的会话视图与列表一致」的「三项设置与源会话相同」在三列全 NULL 时恒真，8.4 才有判别力；「调低上界」只有视图一半（上面的 (c)，直接写库），argv 一半在组 9。
  - 变异：`toSessionView` 回显原始列 → (b)(c) 与全部缺省值断言红；`toSessionView` 少发一键 → 全部十四键断言与 hurl 红；只在 `toPublicSession` 少发一键 → 列表 / 快照 / fork / undo 红而创建绿；创建保留字面量并写死 `"write"` → (a) 的 `always-ask` 例与 (f) 红；`index.ts` 或 `app.ts` 不传 `composer` → (f) 红；`runtimeState` 不读三列 → (d) 红。
- [x] 8.2 REST 创建：`store-composer.ts` 增写入——创建时三列的取值（请求值 / 最近选择 / NULL）、`account_composer_prefs` 的读取与 upsert（只改所给列）；经 `store.ts` 的既有事务原语组合进创建事务（`store-metadata.ts` 189 行有余量，创建的入口在那里；C 的临时空间创建在同一个事务里，次序不变）。`server/src/sessions/rest-metadata.ts`（209 行）的 `POST /api/sessions` 接受三键并校验（session-metadata「会话创建与空间绑定」、session-composer-settings「创建会话时的设置与继承」；`reasoningEffort` 只校验是七个强度名之一且所对模型支持推理，不校验是否在该模型的可选强度内）；创建时的 `session.permission` 审计只按 session-permission-tier「档位变更审计」的条件（session-metadata 不另述条件）。
  测试新文件 `server/test/session-composer-rest.test.ts`（`session-rest.test.ts` 789 行不加）：「缺省与显式」「新会话沿用最近选择」（含继承 `yolo`：owner S-21）「非法取值」「创建时的审计」两段（含 `APPROVAL_MAX_MODE=always-ask` 下三次创建都不写）；`session-composer-store.test.ts` 加：upsert 只改所给列、事务回滚（审计失败时会话行、空间行与最近选择都不落）。
  **实施注记（8.2，fixture 评审补充，#1005）**：
  - 现状（origin/master 5fd0e75）：`store-metadata.ts` 357 行（任务写 189）、`rest-metadata.ts` 234 行（写 209）、`store-composer.ts` 32 行只有读取、`session-composer-store.test.ts` 446 行、`session-rest.test.ts` 788 行；`CREATE_KEYS` 在 `rest-metadata.ts:51` 为 `{workspaceId, scene}`，多余键与非法值统一 `HttpError("bad_request")`；既有测试没有任何一条用三键创建或断言创建键集恰两键，本刀不触动既有断言。
  - 校验分两层，不给路由接配置（`SessionMetadataRouteDependencies` 没有 `composer`，接它要改 `rest.ts` 与 `index.ts`，出 PR 边界）：`parseCreateBody` 只把 `CREATE_KEYS` 扩为五键并要求三键是字符串（`null`、数字即 400）；`SessionCreateInput` 加三个可选 `string`；取值校验在 store 里用 `options.composer` 做。
  - `store-composer.ts` 新增三个函数，全部由 `store-metadata.ts` 引用（knip 不报）：`resolveCreateComposer(db, ownerId, input, config)` 读最近选择行、校验、返回 `{row, given, auditTo}`，不合法抛 `HttpError("bad_request")`；`saveComposerPrefs(db, ownerId, given, now)`；创建审计的判定。七个强度名在本文件声明为 `Record<Effort, true>`（`model-catalog.ts` 的 `EFFORT_LEVELS` 未导出，不改它）；本文件不导入 `store-branch.ts` / `store-view.ts`，避免成环。
  - 校验规则：`approvalMode` 属于 `APPROVAL_MODES` 且序号不高于 `approvalMaxMode`（越界是 400，不是存下再夹取）；`modelId` 与白名单某项 `id` 精确相等；`reasoningEffort` 是七名之一（`auto`、`ultra` 为 400），且所得模型 `reasoning=true`——该模型取 body 的 `modelId`，未给时取 `effectiveComposer({modelId: 最近选择的 model_id}, config).modelId`；不查 `efforts`（`{modelId:"m3", reasoningEffort:"xhigh"}` 是 201）。
  - 取值：body 给出的键写请求值；未给的键逐列照抄最近选择行的原始值，没有行或该列为 NULL 写 NULL。偏离记录：继承值不再校验，照抄原值，即使已不在白名单、高于当前上界、或强度配上了不支持推理的模型（D3：原始选择入库，读时夹取）。
  - 事务次序（两种创建各自仍是一个 `runOwnedTransaction`，C 的步骤次序不变）：① `resolveCreateComposer`（读加校验，先于一切写入与建目录）→ ② 临时空间路径的 `createTemporaryWorkspace` → ③ `INSERT_SESSION` 多写三列 → ④ 绑定路径的 temporary 检查与 `session.bind` → ⑤ body 带任一键时 `saveComposerPrefs` → ⑥ 创建审计。`createInTemporaryWorkspace` 需加一个在 ② 之前执行的回调；提交后仍由 `readSessionView` 读回视图。
  - upsert：`INSERT INTO account_composer_prefs(...) VALUES(...) ON CONFLICT(account_id) DO UPDATE SET <仅所给列>=excluded.<列>, updated_at=excluded.updated_at`；SET 片段由源码常量拼接（同 `patchAssignments`），`updated_at` 用创建的同一个 `now`；body 不带三键时一条语句都不发，`updated_at` 也不动。
  - 审计：`options.emit(db, {kind:"session.permission", actorId: ownerId, title:"修改权限档位", workspaceId: <会话的 workspace_id，临时空间路径即新建临时空间 id>, detail:{sessionId, from:null, to}})`；条件是「原始档位非 NULL，且 `effectiveComposer` 对它算出的档位不等于对 NULL 算出的档位」，`to` 取有效档位。绑定路径上它排在 `session.bind` 之后。
  - 真值表（上界 / 原始 → 结果）：`yolo`/NULL 不写；`yolo`/显式 `yolo` 写；`yolo`/继承 `yolo` 写；`yolo`/显式 `write` 不写；`always-ask`/NULL 不写；`always-ask`/继承 `yolo` 不写——以上六行由「创建时的审计」覆盖。规格未列、测试要补两行：`yolo`/显式 `always-ask` 写 `to:"always-ask"`；`write`/继承 `yolo` 不写（行存 `yolo`，视图 `write`）。「显式 `yolo` 被夹成 `write`」不可达：显式越界是 400。凡写审计时原始值恒等于有效值，「`to` 取原始值」写不出变异（偏离记录）。
  - 偏离记录（规格未写的分支）：取值不合法且 `workspaceId` 属他人或不存在时回 404（路由的 owner 判定先于 store 的取值校验，没有场景覆盖该组合）；旧的 `store.create(ownerId)`（`store.ts:261`，src 内无调用方）不继承、三列仍 NULL；「创建时的审计」末句「对第三个会话 fork 没有新增」在本刀恒真，改由 8.4 的 `session-fork-metadata.test.ts` 断言。
  - 新文件 `server/test/session-composer-rest.test.ts`：世界照 `session-composer-store.test.ts:385-396` 的 `createApp({db, authRuntime, assembly:{runtime, modelCatalog, approvalMaxMode}})`（`withSessionRest` 只有单模型 `TEST_COMPOSER`，不够用）。三模型白名单字面量现在只在 `session-composer-store.test.ts:50-63`，搬到 `session-meta-fixtures.ts` 两处共用，否则 jscpd 会报。账号用 `zhangsan`、`zhaoliu`（成员）与 `lisi`（管理员）。
  - REST 用例：「缺省与显式」「新会话沿用最近选择」（含第三账号 `{m3,xhigh}` 的 201，行为 NULL/`m3`/`xhigh` 且无审计）、「非法取值」九例（每例断言会话行数、`workspaces` 行数、`tmp-*` 目录数、审计行数、最近选择行都不变），另加最近选择模型为 `m2` 时 `{reasoningEffort:"high"}` 为 400、最近选择模型为 `gone` 时同一 body 为 201；「创建时的审计」两段加上面补的两行。上界 `always-ask` 下「最近选择为 `yolo`」的账号无法经 REST 布置，直接 SQL 插入最近选择行。
  - `session-composer-store.test.ts` 加：(g) upsert 只改所给列——先 `{approvalMode, modelId}` 再 `{reasoningEffort}`，前两列不变且 `updated_at` 前进，随后无键创建整行不变；(h) 回滚——注入只对 `session.permission` 抛错的 `emit`，绑定与临时空间两条路径各一例，会话行、`workspaces` 行、`session.bind` 审计、最近选择行都不落，临时目录被移除；(i) 取值不合法时 `createTemporaryWorkspace` 调用零次（spy）。
  - 变异（PR 描述，8.7 的 8.2 条款）：不读最近选择 →「新会话沿用最近选择」红；按 `efforts` 校验 → `{m3,xhigh}` 的 201 红；放行 `auto` →「非法取值」红；越界 `yolo` 存下再夹取 →「非法取值」红；继承 `yolo` 不写审计、或条件改成「原始值非 NULL 即写」→「创建时的审计」（上界 `always-ask` 与显式 `write` 两例）红；upsert 把未给列写成 NULL → (g) 红；upsert 或审计移出事务 → (h) 红；校验放到 `createTemporaryWorkspace` 之后 → (i) 红。
  - 顺带改掉两处文档头：`rest-metadata.ts:2-3` 仍写 `{workspaceId?, scene?}`，`store-composer.ts:2` 仍写 read side only。web 不改：`web/src/lib/api.ts:122-124` 已有三键的类型，唯一调用方 `use-chat-session.ts:523` 的 `welcome.createBody()` 不发它们；`smoke/session-meta.hurl` 不动（三键的冒烟在 #1038）。
- [x] 8.3 REST 修改：`PATCH /api/sessions/:id` 的键集由 C 之后的四键 `{title, scene, pinned, archived}` 扩为七键；三键的校验（`reasoningEffort` 的规则同 8.2，不按可选强度拒绝）、写列、更新最近选择、有效档位变化时的审计（同一事务）；不调用 supervisor、不向 omp 发帧。测试同文件：session-composer-settings「修改并回显有效值」「运行中修改不触及在途回合」（假 omp 真子进程：回合在途时 PATCH，假 omp 没有收到新帧、进程未退出、回合照常结束）「非法取值与越过最高档」「隔离」、session-permission-tier「修改与重复选择」「审计失败则修改不生效」「调低上界后既有会话被夹取」的视图部分。
  既有 `session-metadata-rest.test.ts` 里断言「PATCH 不写审计」的用例按 delta 改写为「除 `session.permission` 外不写审计」（偏离记录）；C 的 `archived` 用例原样通过。
  **实施注记（8.3 + 8.7，fixture 评审补充，#1006）**：
  - 现状（origin/master 1eae5bb）：`rest-metadata.ts` 245 行、`store-metadata.ts` 405 行、`store-composer.ts` 178 行（已含创建写入）、`session-composer-rest.test.ts` 494 行、`session-composer-store.test.ts` 626 行、`session-metadata-rest.test.ts` 739 行；`PATCH_KEYS` 在 `rest-metadata.ts:55` 仍四键，`SessionPatch` 在 `store-metadata.ts:59-64`，`patchSession`（`:233-247`）是一条裸 UPDATE——无事务、无 `emit`、写前不读行。
  - 路由只改 `rest-metadata.ts`：`PATCH_KEYS` 加 `...COMPOSER_KEYS`；`parseCreateBody:171-175` 的三键 `requireString` 循环抽成一个函数，`parsePatchBody` 共用（否则 jscpd 报）；`SessionPatch extends ComposerInput`；处理函数其余不动（`controlHeld` 仍只为 `archived:true` 查，三键不碰 supervisor）；`rest.ts`、`index.ts`、`supervisor.ts` 不改。
  - `store-composer.ts`：把 `resolveCreateComposer:100-123` 的取值校验抽成私有 `checkComposerInput(input, config, fallbackModelId: () => string): Partial<ComposerDbRow>`，创建照旧传「最近选择的有效模型」；新增导出 `resolvePatchComposer(current: ComposerDbRow, input, config): { given; audit: { from; to } | null }`（纯函数，不读库），回退模型取 `effectiveComposer(rawComposer(current), config).modelId`；`from` / `to` 是 `current` 与 `{...current, ...given}` 各自的有效档位，相等即 `null`；仍不导入 `store-view.ts` / `store-branch.ts`。
  - `patchSession` 整个包进 `runOwnedTransaction(db, "session patch rollback failed", …)`，次序：① `SELECT approval_mode, model_id, reasoning_effort, workspace_id … WHERE id = ? AND owner_id = ?`（无行返回 `null`）→ ② `resolvePatchComposer`（不合法抛 `bad_request`，先于一切写入）→ ③ 既有 UPDATE，`patchAssignments` 对 `given` 多拼三段 `<列> = ?`（只给 `modelId` 时不碰 `reasoning_effort`）；0 行照旧返回 `"busy"` / `null`，后两步不执行 → ④ `saveComposerPrefs(db, ownerId, given, now)` → ⑤ `audit` 非 null 时 `emit({kind:"session.permission", actorId: ownerId, title:"修改权限档位", workspaceId: <行的 workspace_id>, detail:{sessionId, from, to}})`；提交后 `readSessionView`；`now` 与 `pinned` 共用一次 `Date.now()`，会话行的 `updated_at` 不动。
  - 既有断言：没有一条必须变红。`session-metadata-rest.test.ts` E1（`:568-604`）只改 title / scene / pinned，`audits` 不变仍成立；issue 说的「一处改写」只落在该用例标题与文件头措辞（「除 `session.permission` 外不写审计」），断言一个字不松。`session-archive.test.ts:318` 的三态用例、`session-list-events-sessions.test.ts:169`、`session-title-rollback.test.ts:235` 原样通过。文档头同步改：`rest-metadata.ts:8`、`store-metadata.ts:13-16`、`store-composer.ts:6-9`。
  - 测试落点（偏离记录：任务写「测试同文件」）：`session-composer-rest.test.ts` 再加七个场景会逼近 800，且 8.5 还要用它。第一次提交纯搬迁，把它的 `openWorld`、`post`、`create`、`createWorkspace`、`composerOf`、`rawOf`、`prefs`、`plantPrefs`、`permissionAudits`、`auditKindsSeenBy`、`footprint`、`expectBadRequest` 搬到新文件 `server/test/session-composer-rest-helpers.ts`（约 170 行）；8.3 的 REST 用例写进新文件 `server/test/session-composer-patch.test.ts`。`session-rest.test.ts`（788）与 `core-db-session-composer.test.ts`（756）一行不加。
  - 「修改并回显有效值」：三模型世界，无 body 创建后 SQL 把 `status` 置 `done`（该世界不起子进程，偏离记录）；六步 PATCH 逐步断言视图、三列原始值、`updatedAt` / `status` / `stream_epoch` 不变。`{modelId:"m2"}` 后列仍 `low`、视图 `null`；`{modelId:"m1"}` 后回到 `low`。末尾：最近选择行为 `yolo` / `m1` / `low` 且 `updated_at` 落在请求前后的时刻之间；`session.permission` 恰一条 `{from:"write", to:"yolo"}`、`workspaceId` 为临时空间 id；**同账号再无 body 创建，视图与行为 `yolo` / `m1` / `low`**，另一账号仍缺省。
  - 「非法取值与越过最高档」：规格六例，其中 `auto` 先把会话 PATCH 到 `m3`、`high` 先 PATCH 到 `m2`；另加 `{approvalMode:null}`、`{reasoningEffort:["high"]}`。每例断言 400 信封、整行（含 `title`）、最近选择、审计行数都不变。正例：`m2` 会话上 `{modelId:"m1", reasoningEffort:"high"}` 为 200；`model_id` 被 SQL 写成 `gone` 的会话上 `{reasoningEffort:"high"}` 为 200。「隔离」：第二账号对他人会话与未知 id，各以 `{approvalMode:"yolo"}` 和 `{approvalMode:"x"}` 请求，四次 404 逐字节相同，会话行、双方最近选择、审计不变。
  - 「修改与重复选择」：绑定 W 的 NULL 行会话，四步之后 owner 的 `GET /api/audit` 恰新增两条（`write→yolo`、`yolo→always-ask`，`workspaceId=W.id`），第二个成员看不到，`title` 已写成 `新名`。「审计失败则修改不生效」：照 `session-metadata-rest.test.ts:431` 给 `audit_events` 挂 `RAISE(ABORT)` 的 TEMP TRIGGER，`{approvalMode:"yolo"}` 为 500 且 `approval_mode` 与最近选择不变；触发器仍在时 `{modelId:"m3"}` 与重复当前档为 200。
  - 「调低上界」的视图部分与规格没写的审计分支（偏离记录）：上界 `write` 的世界，SQL 把行写成 `yolo`——视图 `write`；`{approvalMode:"yolo"}` 为 400；`{approvalMode:"write"}` 为 200、列变 `write`、最近选择更新、不写审计；另一行同样布置后 `{approvalMode:"always-ask"}` 的审计 `from` 为 `"write"`（有效值，不是原始列）。上界 `always-ask`：NULL 行 `{approvalMode:"always-ask"}` 不写审计，`{approvalMode:"write"}` 为 400。`session-composer-store.test.ts` 的 (c) 改为用 `metadata.patchSession("u1", id, {approvalMode:"yolo"})` 写出那一行，换上界重开后列值与审计行数不变。
  - 「运行中修改不触及在途回合」：`openApprovalWorld("approval", { assembly: { modelCatalog: THREE_MODEL_CATALOG } })`（假 omp 真子进程；`openHeldPromptSession` 是进程内假子进程，不合任务要求），`pendingApproval(world)` 把回合停在待决审批上。记下 `spawnedAt(world,0).stdin.length`、`world.rt.calls.length`、`stream_epoch`，PATCH `{approvalMode:"always-ask", modelId:"m3"}` → 200 且 `status="running"`；三者不变、`child.exitCode === null`、审批仍待决；快照 `session` 为 `always-ask` / `m3` / `high`；作答 `allow` 后 stdin 恰多一帧 `extension_ui_response`，`waitForTurn … "done"`。不用「再发一条 probe」取 `frames=`：组 9 合入后那条 prompt 会重启进程。
  - 规格未写的分支（偏离记录）：合法三键加 `archived:true` 打在运行中的会话上 → 409，三列、最近选择、审计都不动（在上一条的世界里加一例）。取值不合法加 `archived:true`：会话 `running` 而占用未被持有 → 400（② 先于 ③）；占用被持有 → 409（路由的 `controlHeld` 先于 store）；两者都零写入。#1005 留下的「非法取值 + 他人 / 未知 `workspaceId`」次序与本刀无共用路径：PATCH 没有 `workspaceId`，404 由 `preParsing` 的 owner 预检给出，恒先于取值校验；POST 的次序维持 #1005 的记录，本刀不动。
  - chat-sessions「Session views carry the three composer settings」里 8.1 让出的 PATCH 部分：缺省单模型世界（`createApp` 不传白名单），创建 201 → PATCH `{approvalMode:"yolo"}` 200 → 列表项 → 快照 `session`，四个出口恰十四键，后三者 `yolo` 且其余两键不变。fork 出口不另起 branch 世界，由 8.4 的用例 1、2 覆盖（偏离记录）。
  - 变异（PR 描述，8.7 的 8.3 条款；本 PR 同时勾 8.3 与 8.7）：去掉 ④ →「修改并回显有效值」末尾的无 body 创建与最近选择行红（8.7 写的「沿用最近选择」落在这一条，既有创建用例从不 PATCH，判不了红）；按 `efforts` 校验 → 同用例 `{reasoningEffort:"xhigh"}` 一步红；放行 `auto`、或不查模型是否支持推理 →「非法取值与越过最高档」红；重复选择也写审计 →「修改与重复选择」的恰两条红；PATCH 里调 supervisor 退役或发帧 →「运行中修改」的 stdin 帧数 / `exitCode` / `calls.length` 红；④ 或 ⑤ 移出事务 →「审计失败」红；② 挪到 ③ 之后且不回滚 → `{title:"好", approvalMode:"x"}` 的 `title` 不变红；`from` 取原始列 → 上界 `write` 的 `from:"write"` 红；回退模型取最近选择而非会话当前模型 → `m2` 会话上 `{reasoningEffort:"high"}` 的 400 红。
- [x] 8.4 fork 继承：`server/src/sessions/store-branch.ts`（266 行）的 `copyForkHistory` / fork 事务复制三列原始值；不动最近选择、不写 `session.permission`。测试 `server/test/session-fork-metadata.test.ts`：session-metadata「继承三项设置」与 turn-control「分叉继承三项输入框设置」的存储与视图部分（argv 与帧序在组 9）；C 的「继承临时空间」「分叉共用临时空间且不带快照」原样通过。
  **实施注记（8.4，fixture 评审补充，#1007）**：
  - 现状（origin/master 5fd0e75）：`store-branch.ts` 266 行（与任务一致），`session-fork-metadata.test.ts` 449 行；新会话行由 `FORK_SESSION`（`store-branch.ts:186-187`）在 `copyForkHistory` 的事务里插入，列表止于 `workspace_id, scene`；fork 响应经 `store.commitFork` → `readSessionView` → `toPublicSession`，视图不用改。
  - 代码改动只有一处，`FORK_SESSION` 换成：`"INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, parent_session_id, created_at, updated_at, workspace_id, scene, approval_mode, model_id, reasoning_effort) SELECT ?, owner_id, title, 'idle', ?, id, ?, ?, workspace_id, scene, approval_mode, model_id, reasoning_effort FROM chat_sessions WHERE id = ?"`。列名写字面量，不从 `store-composer.ts` 导入（`store-view.ts` 已导入 `store-branch.ts`，不添反向边）。
  - `copyForkHistory` 没有 `emit`、不碰 `account_composer_prefs`，「不写审计、不动最近选择」不需要代码，只靠测试断言钉住。
  - 测试世界的缺口：`openForkWorld` → `openRegenWorld` → `openApprovalWorld` → `openRecordingSession` → `openSupervisorApp`（`session-supervisor-helpers.ts:174-187`）不向 `createApp` 传 `modelCatalog` / `approvalMaxMode`，是单模型、上界 `yolo`；#1005 合入后在这个世界 `POST {modelId:"m3"}` 是 400，规格字面的 `yolo`/`m3`/`low` 建不出来。
  - 处理（PR 边界偏离，写进偏离记录）：`OpenSessionOptions`（`session-supervisor-helpers.ts:83-95`）加可选 `assembly`（只含 `modelCatalog`、`approvalMaxMode`），展开进 `createApp` 的 `assembly`；同一个可选项经 `ApprovalWorldOptions`（`session-approval-helpers.ts:59-65`）、`openRegenWorld`、`openForkWorld` 透传。四个 helper 各加两三行（639 / 407 / 371 / 324 行，有余量），缺省行为不变；组 9 断言 fork 临时进程 argv 时用同一个世界。
  - 源会话的布置：确认可经 POST 带三键创建——就是 `forkSource`（`session-fork-metadata.test.ts:181-244`）里 `:207-210` 的 `inject(world,"POST","/api/sessions",…)`，给 `body` 加可选三键与世界配置即可。高于当前上界的原始值 POST 不进去（400），那一例用 SQL `UPDATE chat_sessions SET …` 直接布置（issue 明许）。
  - 用例 1（规格字面）：三模型白名单、上界 `yolo`，POST `{workspaceId, scene, approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"}` 建源后 fork；201 的 `session` 三键为 `yolo`/`m3`/`low` 且与列表同 id 条目逐键相等；新行三列与源行逐值相同。该账号最近选择行在 fork 前后整行相等（含 `updated_at`；源的创建已写出这一行，比「没有行」有判别力）。`session.permission` 行数与 `auditCount` 在 fork 前后相同（源的创建已写一条，fork 后仍是一条）——8.2 让出来的「fork 没有新增」落在这里。
  - 用例 2（原始值不等于有效值）：同一白名单、上界 `write`，源行 SQL 写成 `("yolo","gone","xhigh")`；fork 后新行三列仍是 `yolo`/`gone`/`xhigh`，201 视图为 `write`/`m1`/`xhigh` 且等于源的视图。
  - 用例 3（NULL 不物化）：三列全 NULL 的源 fork 后，新行三列 `typeof` 均为 `null`，视图为缺省有效值。
  - 列的读取另写一个函数，不扩 `sessionMeta()`（`:120-124`）与 `session-fork-helpers.ts:157` 的 `sessionRowOf`：两者都点名列，既有断言不必动。既有 fork 测试的源全是 NULL 三列，结果不变，没有哪条断言必须改；C 的「继承临时空间」「分叉共用临时空间且不带快照」原样通过；`forkedSession` 的 `["session","draft"]` 键集不变（`attachments` 在组 12）。
  - 本刀测不到（偏离记录）：session-metadata「继承三项设置」与 turn-control「分叉继承三项输入框设置」里临时进程 argv 的 `--approval-mode yolo` / `--model workbuddy/m3`、新会话首条 prompt 前的 `set_model` / `set_thinking_level`，属组 9（`branch-temp.ts:86` 与 `supervisor.ts:487` 现仍写死 `approvalMode:"write"`）。
  - 变异（PR 描述，8.7 的 8.4 条款）：`FORK_SESSION` 去掉三列 → 用例 1、2 红；改成写有效值（夹取或回落后的值）→ 用例 2、3 红；只抄 `approval_mode` → 用例 1 红；fork 里 upsert 最近选择 → 用例 1 的整行相等红；fork 里写 `session.permission` → 用例 1 的审计行数红。
- [x] 8.5 `GET /api/composer/options`：新文件 `server/src/sessions/rest-composer.ts`，由 sessions 模块注册（与 `rest-commands.ts` 同样的接法；装配处把 `modelCatalog`、`approvalMaxMode`、两个上传上限传进来）。测试同 8.2 的文件：「缺省配置」「封顶、白名单与账号各自的缺省」；http-service-skeleton「四个新配置键的取值与非法值」里合法四键启动后 `GET /api/composer/options` 的回报（编译入口，`server-startup-layout.test.ts`）。
  **实施注记（8.5，fixture 评审补充，#1008）**：
  - 现状（origin/master 1eae5bb）：`uploadMaxFiles` 只到 `ServerConfig`（`agent-config.ts:62`），没进装配——`AssemblyDependencies`（`app.ts:84-89`）与 `appAssemblyOf`（`server.ts:105-110`）只有 `uploadMaxBytes`，`DEFAULT_UPLOAD_MAX_FILES`（`agent-config.ts:20`）未导出；`RegisterSessionsOptions`（`sessions/index.ts:25-75`）只带 `composer`，两个上传上限都不到 sessions。
  - 装配共改四个文件（超出 issue 的 PR Boundary，写偏离记录）：`agent-config.ts` 导出 `DEFAULT_UPLOAD_MAX_FILES`；`server.ts` 的 `appAssemblyOf` 加 `uploadMaxFiles: config.uploadMaxFiles`；`app.ts` 加可选 `uploadMaxFiles?: number`，并给 `registerSessions` 传 `upload: { maxBytes: assembly?.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES, maxFiles: assembly?.uploadMaxFiles ?? DEFAULT_UPLOAD_MAX_FILES }`；`sessions/index.ts`（226 行）的 `RegisterSessionsOptions` 加必填 `upload: { maxBytes: number; maxFiles: number }`。
  - 注册：`index.ts:159-162` 的 `registerProjectConfigRoutes` 之后调 `registerComposerRoutes(app, { db: options.db, composer: options.composer, upload: options.upload })`；与 `rest-commands.ts` 的差别是要 `db`。`registerSessions` 在 src 只有 `app.ts:197` 一个调用方，`server-assembly.test.ts:556` 的 spy 原样转发 options，不用改。
  - 新文件 `server/src/sessions/rest-composer.ts`（约 60 行）：`app.get("/api/composer/options", { onRequest: noStoreSessionHeaders }, …)`，账号取 `currentPrincipal(request).id`（`rest.ts:145`、`:387`）。只导入 `./rest.js`、`./store-composer.js`、`../model-catalog.js`、`../core/errors`，三者都不回头导入它，无环；不是 content-parser 归属路由，会话路由数仍是十一（design:347）。
  - `store-composer.ts`（178 行）加导出 `readComposerPrefs(db, ownerId): ComposerDbRow`（复用私有的 `SELECT_PREFS` / `NO_CHOICE`，无行返回 `NO_CHOICE`），`resolveCreateComposer` 首行改调它；路由是 src 内调用方，knip 不报。`defaults = effectiveComposer(rawComposer(readComposerPrefs(db, id)), composer)`，单条 SELECT，不开事务。
  - 响应体按规格字面量的键序手写。`approvalModes = APPROVAL_MODES.slice(0, APPROVAL_MODES.indexOf(approvalMaxMode) + 1)`。`models` 逐项写 `{id, name, reasoning, vision, efforts: selectableEfforts(m), defaultEffort: defaultEffort(m)}`，不得 `...m`：`CatalogModel.efforts` 是声明值（不含 `off`，旧式单模型没有这个键），web 的 `parseModel` 要恰六键。`upload` 即 `{maxBytes, maxFiles}`。
  - 与 web 对底（已逐值核对）：缺省配置下回报等于 `web/test/session-meta-fixtures.ts:21-35` 的 `DEFAULT_COMPOSER_OPTIONS`，各层键集等于 `web/src/lib/composer-contract.ts` 的三个 `hasExactlyKeys`；`defaults.reasoningEffort` 可落在该模型 `efforts` 之外（如 `{m3,xhigh}`），解析器允许。
  - 规格未写的分支（偏离记录）：① URL 带 `?`（含空查询串）回 400 `bad_request`，在 handler 里判 `request.raw.url`，与 `rest-commands.ts:103-113` 同序（匿名仍先 401）；GET body 不判。② 最近选择的 `model_id` 不在白名单时回落缺省模型，强度配上不支持推理的模型时为 `null`，都由 `effectiveComposer` 给出，路由不另写。③ `createApp` 不校验注入的 `uploadMaxFiles`（校验在配置层 `resolvePositiveInteger`；`uploadMaxBytes` 的校验在 `workspaces/rest.ts:173`），不对称留给 12.3。④「不读取任何会话」是否定句，不设用例。
  - REST 测试放 `server/test/session-composer-rest.test.ts`（494 行，加约 110 行；#1006 的 8.3 也加在这里，后合入者自查 800）。`openWorld(cap?)`（`:69`）写死 `THREE_MODEL_CATALOG`，改为 `openWorld({cap?, catalog?, upload?})`，`catalog` 缺省仍是三模型，既有调用点只改传参、断言不动；不另开文件（重复世界搭建会让 jscpd 报）。
  - 「缺省配置」：assembly 只给 `{runtime}`（`createControlledRuntime` 的 `modelId` 须是 `deepseek-v4.1-flash`，见 `support/omp-rpc.ts:74`），未做过选择的账号 GET → 200，body `toEqual` 规格字面量，`cache-control` 为 `no-store`。字面量放 `server/test/session-meta-fixtures.ts`（71 行），手写，不经被测函数。
  - 「封顶、白名单与账号各自的缺省」：`{cap:"write", upload:{maxBytes:1048576, maxFiles:3}}` 加三模型；甲的 `yolo/m3/low` 用 `plantPrefs`（`:148`）直接入库（REST 在上界 `write` 下拒绝 `yolo`）。断言甲、乙两份完整 body：三项 `models` 的 `name` 为 `M One` / `M Two` / `M Three`，`m1` 为 `off` 加六档且缺省 `high`，`m2` 为 `[]` / `null`，`m3` 为 `["off","low","high"]` 且缺省 `high`；`defaults` 甲 `{write,m3,low}`、乙 `{write,m1,high}`；匿名 401；`?x=1` 为 400。
  - 编译入口：扩 `server-startup-layout.test.ts:145-186` 那一条（256 行；tasks.md:91 说两半同场景），env 加 `APPROVAL_MAX_MODE=write`、`UPLOAD_MAX_BYTES=1048576`、`UPLOAD_MAX_FILES=3`，`login(port)` 后 GET；models.yml 断言原样保留。该用例白名单不是 `THREE_MODEL_CATALOG`，按它自己的字面量断言：`m1` 名 `通用`、`["off","minimal","low","medium","high"]`、`high`；`m2` 名 `m2`、`[]`、`null`；`m3` 名 `深度`、`vision:true`、`["off","low","high"]`、`high`。`requestJson`（`server-startup-helpers.ts:273`，文件 674 行）未导出，导出一个 `getJson(port, path, cookie)`。
  - 既有测试无一必须改：没有测试钉 `AssemblyDependencies` 或 `RegisterSessionsOptions` 的键集，也没有枚举全部路由的测试。`server-handshake-log.test.ts:129-153` 加一行 `uploadMaxFiles` 身份断言。web 运行时还没有调用方（`getComposerOptions` 只在 `api-sessions.ts:291`），`smoke/*.hurl` 与 ui-walk 不动（冒烟在 18.1）。
  - 变异（PR 描述；8.7 无 8.5 条款）：`approvalModes` 不封顶 →「封顶」与编译入口红；`efforts` 回声明值 →「缺省配置」（少 `off`）与 `m2`（缺键）红；`defaultEffort` 写死 `high` → `m2` 红；`defaults` 回原始值 → 甲的 `write` 红；SELECT 去掉 `WHERE account_id` → 乙红；`appAssemblyOf` 不传 `uploadMaxFiles` → 编译入口 `maxFiles:3` 红；`app.ts` 的 `upload` 写死缺省 →「封顶」红；去掉 `noStoreSessionHeaders` → no-store 红；去掉查询串判定 → `?x=1` 红。
- [x] 8.6 与 8.1 同刀：既有断言会话视图「恰十一键」的服务端测试与 `smoke/*.hurl` 断言改为十四键——session-metadata「会话视图扩展键」的两个改写场景、chat-harness「会话元数据 HTTP 冒烟」第 1、3 步（`count == 14` 与三键的缺省值）、turn-control / session-metadata 的「fork 响应的会话视图与列表一致」、C 的 undo 响应里的 `session`；`make smoke` 通过（web 已由组 5 接受新键）。
- [x] 8.7 变异证据，按刀分配——8.1 + 8.6：视图直接回显原始列（不夹取）→「调低上界」的视图部分与「夹取与回落」判红；少发一键 → 十四键断言判红。8.2：创建不继承最近选择 →「新会话沿用最近选择」判红；创建时按模型的可选强度校验 `reasoningEffort` →「新会话沿用最近选择」里 `{modelId:"m3", reasoningEffort:"xhigh"}` 的 201 判红；放行 `auto` →「非法取值」判红；继承 `yolo` 的创建不写审计、或上界 `always-ask` 下的缺省创建写了审计 →「创建时的审计」判红。8.3：PATCH 不更新最近选择 →「沿用最近选择」判红；PATCH 时按模型的可选强度校验 `reasoningEffort` →「修改并回显有效值」的 `{reasoningEffort:"xhigh"}` 一步判红；放行 `auto` 或不支持推理的模型下的 `reasoningEffort` →「非法取值与越过最高档」判红；重复选择也写审计 →「修改与重复选择」判红；PATCH 调用了 supervisor 或向 omp 发帧 →「运行中修改不触及在途回合」判红。8.4：fork 不复制三列 →「继承三项设置」判红。
  **实施注记（8.7，fixture 评审补充，#1007）**：
  - 8.7 的条款分属四刀：8.1 + 8.6（#1004，PR #1242 描述已给）、8.2（#1005 的 PR）、8.3（#1006 的 PR）、8.4（本刀）；8.5（#1008）在 8.7 里没有条款，不卡它。
  - #1007 不依赖 #1006，先合入时 8.3 的证据还不存在：本 PR 只勾 8.4，8.7 保持 `- [ ]`，由 #1006 与 #1007 中后合入的那一个勾选（#1006 正文「任务号 8.7 在 #1007 勾选」按此读，建议在 #1006 留一条评论）。
  - 本 PR 描述的措辞：「任务 8.7 未勾选：本 PR 给出其中 8.4 条款的变异证据；8.1 + 8.6 与 8.2 的条款见 #1242 与 #1005 的 PR 描述；8.3 条款属 #1006（未合入），由 #1006 的 PR 给出后勾选 8.7。」

Suggested fixture level: expanded - 公共 API（会话视图键集、POST / PATCH body、新端点）、持久化、审计与账号隔离
Minimal mergeable slice: 8.0 一刀（纯搬迁）；8.1 + 8.6 一刀（视图发出三键必须与全部「恰十一键」断言的改写同刀：键集一变所有会话视图断言同时变；此刀三键恒为缺省值）；8.2 一刀（创建入参、继承与创建审计——新测试文件里的新行为，不触动既有断言）；8.3 一刀（修改入参与修改审计）；8.4 一刀；8.5 一刀。8.7 的变异证据随各自的刀。此时设置可存可读但尚不影响进程（组 9）

## 9. sessions supervisor — 派发前按会话设置对齐进程（Critical Path）

- [x] 9.1 档位：`pool.ts` 的 `Slot` 增 `approvalMode`（启动档位）；`branching.ts` 的 `Resume` 增三项原始值；`supervisor.ts`（C 结束时不超过 792 行；本任务的行数用 7.0 腾出的余量）的 `#onSlot` 判定「存活 slot 的启动档位 ≠ 有效档位 → 先 `#retireSlot` 再 `fresh()`」。把有效值计算与「是否可复用」的判定写成新文件 `server/src/sessions/composer-align.ts` 里的函数，`supervisor.ts` 只调用（至多 10 行，用 7.0 的余量，行数写进 PR 描述）。regenerate 的取得进程处用同一个判定（turn-control「重新生成 REST」：存活进程的启动档位不同时先退役）。
  组 7.3 留下的调用点改为传会话的有效档位与有效模型（fork 与 C 的撤回的临时进程取该会话的）。
  同刀核对 `SessionSupervisorRuntime.modelId`：两个调用点不再读它之后，剩下的读者只有 `createApp` 在装配未给 `modelCatalog` 时的单模型回退；回退仍在就保留该字段并把注释改成「未给白名单时的单模型 id」，回退已不存在就删除字段与各测试 helper 里的字面量。结果写进 PR 描述。
  测试新文件 `server/test/session-composer-dispatch.test.ts`（假 omp 真子进程 + 记录 argv 的 spawn 包装）：chat-sessions「档位不同则以新档位重启」「修改设置本身不动进程」「对齐期间的并发请求」、session-permission-tier「档位进入 argv」「生成中改档位」「未改档位不重启」「调低上界」的 argv 部分；turn-control「档位不同时先退役再重新生成」「分叉继承三项输入框设置」的 argv 部分。
  **实施注记（9.1 + 9.3，fixture 评审补充，#1009）**：
  - 行数现状（origin/master 77f1f8c）：`supervisor.ts` 781、`pool.ts` 325、`branching.ts` 351、`branch-temp.ts` 228、`undo.ts` 371、`index.ts` 226、`model-catalog.ts` 223、`omp/runtime.ts` 799、`fake-omp.mjs` 797；写死 `"write"` 的两处实为 `supervisor.ts:487-488` 与 `branch-temp.ts:93-94`（简报的 ~86 已漂移）。
  - 本刀不碰的文件：`omp/runtime.ts`、`omp/process.ts`、`omp-runtime-commands.test.ts`（798 行，`RealWorld` / `openReal` 的纯搬迁是 9.2 的前置）、`fake-omp.mjs`、`fake-omp-composer.mjs`（`approval-write` 已在 `fake-omp.mjs:103-104` 按 `--approval-mode always-ask` 门控）、`host-overlay.ts`。
  - 任务没写的缺口：supervisor 手里没有 `ComposerConfig`（`index.ts:90,118` 只把 `options.composer` 给了两个 store）。处理：`SessionSupervisorOptions` 加必填 `composer`，`index.ts:92` 的构造加一行 `composer: options.composer`；supervisor 存为 `#composer` 并放进 `supervisor.ts:195` 的 `ports`。全仓只有 `index.ts` 构造 `SessionSupervisor`，测试 helper 零改动；`index.ts` 超出 issue 的 PR Boundary，写进偏离记录。
  - 新文件 `server/src/sessions/composer-align.ts`：只导入 `../model-catalog.js` 与 `./store-composer.js`（type），不导入 `branching.js` / `pool.js`。导出 `type RawComposer = Parameters<typeof effectiveComposer>[0]`、`effectiveOf(raw: RawComposer, config: ComposerConfig)`（即 `effectiveComposer`，夹取后的档位与白名单内的模型）、`reusable(slot: { approvalMode: ApprovalMode }, effective): boolean`（只比档位）。读者是 `supervisor.ts`、`branch-temp.ts`、`branching.ts`，knip 不报。
  - 原始值的读取点不新增，每次派发只读一次 `store.runtimeState`：prompt 在 `supervisor.ts:353`，与 `rest.ts:267` 的 `acceptPrompt` 同一同步段（`rest.ts:267-284` 无 await），所以读到的是受理那一刻的值，`before()` 快照与 `existing.retiring` 等待期间到达的 PATCH 归下一次派发；regenerate 在 `branching.ts:86`，fork 在 `:261`，undo 在 `undo.ts:141`。`Resume`（`branching.ts:29`）加 `composer: RawComposer`，`runtimeState` 的返回值已带该字段，结构赋值，无填充代码。
  - `pool.ts`：`Slot` 加 `approvalMode: ApprovalMode`（启动档位）。`SessionRuntime` 的 `#approvalMode` 是构造时定死的 readonly（`runtime.ts:117,151`），同一 slot 的各 generation 档位恒同，所以记在 slot 上、不给 runtime 加 getter。`#onNewSlot` 里用同一个 `effective` 变量既写 slot 字面量又传 `sessionRuntimeOpts`（`approvalMode`、`modelId`），此后不再改写；测试里没有完整的 `Slot` 字面量（`session-supervisor-claims.test.ts` 用自己的 `TestSlot`，`thinking-buffer.test.ts` 是强转），零波及。
  - `#onSlot`：在 `:418-420` 既有的 `return fresh()` 守卫之后、`:421` 的 `#claim(live, claim)` 之前插入 `if (!reusable(live, effective)) { await this.#retireSlot(live); return fresh(); }`。不先认领：等待退役期间到达的 stop 走 `TurnStops.stop(undefined, …)` 留存意图，由新 slot 的 `dispatched` 兑现，与 `:373` 的等待窗口同类。不先等 `live.pump`：受理以终态已持久化为前提，sink 重入时 ring push 先于 observer。regenerate 经 `acquire → #onSlot` 自动得到同一判定，`branching.ts` 不为它加代码。
  - 临时进程：`BranchTempPlan` 加 `approvalMode` 与 `modelId`（有效值）；`ForkPlan`、`UndoPlan` 各加 `composer: RawComposer`（在各自预检里从 `resume` 拷贝），`#fork` / `#undo` 调 `branchAt` 时经 `effectiveOf(plan.composer, ports.composer)` 取两值；`ForkPorts` 与 `BranchTempPorts` 加 `composer`（`UndoPorts` 由后者推出）。`branch-temp.ts` 不在任务原文里，写进偏离记录。临时进程不做对齐第 2 步，不记 slot / generation。
  - `SessionSupervisorRuntime.modelId` 保留：两个 spawn 点不再读它，剩下的读者是 `app.ts:182`（缺省 runtime）与 `:186`（装配未给 `modelCatalog` 时的单模型回退，几乎所有测试世界都走它）。`supervisor.ts:73` 现在没有注释，任务说的「改注释」实为新增，用行尾注释（不占行）写「未给白名单时的单模型 id；spawn 不读」。结果写进 PR 描述。
  - 既有 argv 断言为何零改动：不传 `modelCatalog` 的世界里目录由 `runtime.modelId` 派生，有效模型等于它，`server-assembly.test.ts:739-761` 的 `ompArgs`、`session-fork.test.ts:179`、`session-regenerate.test.ts:155` 逐字节不变；直接调 `registerSessions` 的世界用 `TEST_COMPOSER`，其缺省模型与 `omp-rpc.ts:74` 同为 `deepseek-v4.1-flash`。只有 `THREE_MODEL_CATALOG` 世界的 `--model` 由 `runtime.modelId` 变为 `m1`，没有断言钉旧值。任何一处变红先查实现。
  - `supervisor.ts` 行数：逐项净增约 11–12（import 1、选项 1、`#composer` 字段 / 构造 / ports 3、`#onSlot` 4、`#onNewSlot` 2），超过验收的 10。所以先单独一次纯搬迁提交：`:445-457` 的 `Slot` 字面量搬成 `pool.ts` 的 `emptySlot(sessionId, workspaceRoot)`（781 → 约 771，既有 supervisor 测试原样通过）。功能提交再给它加 `approvalMode` 参数，终值不超过 784，9.2 的 6 行余量不受影响；两次提交的行数写进 PR 描述。
  - 功能改动的两次提交接缝：提交 A 是 `composer-align.ts`、配置下传、`Resume.composer`、`Slot.approvalMode`、两处 spawn 取有效值、三个 plan，加只看 argv 的用例与 9.3 两例；提交 B 是 `#onSlot` 的重启分支加重启类用例。A 单独合入时，存活进程在回收之前仍用旧档位，这个中间态只允许存在于本 PR 内。
  - 新文件 `server/test/session-composer-dispatch.test.ts`，世界一律用带 `assembly` 透传的既有 helper（`openApprovalWorld` / `openRegenWorld` / `openForkWorld`，argv 取 `world.rt.calls[n].args`）。「档位进入 argv」：三个会话绑定同一个工作空间、创建时带 `approvalMode`，各发一条 prompt，三份冷启动 argv 只差 `--approval-mode` 的取值。「调低上界」：上界 `write` 下直接写库 `approval_mode='yolo'`，连发两条 prompt 恰一次 spawn、argv 为 `write`、列值仍 `yolo`、审计不增；上界 `always-ask` 下 NULL 行 argv 为 `always-ask`。
  - 重启类用例：「以新档位重启」在 spawn 包装里记下第二次 spawn 时第一个子进程的 `isLive`（`session-supervisor-pool-helpers.ts` 的 `sampleSpawns` 写法），断言 `--resume` 等于第一回合落库的 `omp_session_file`、`stream_epoch` 加一、活进程数不超过一，第三条 prompt 无新 spawn。「未改档位不重启」含对 NULL 行 PATCH `{approvalMode:"write"}` 一步。「生成中改档位」沿用 `session-composer-patch.test.ts:251` 的世界，再补第二条 prompt（argv `yolo` 加 `--resume`、epoch 加一、无审批行）。
  - 「修改设置本身不动进程」：三模型世界，回合结束后依次 PATCH `yolo`、`m3`；`spawned[0].stdin.length`、`child.exitCode === null`、`stream_epoch` 前后不变，`world.timersDueAt(回合结束时刻 + IDLE_MS)` 前后同为 1，时钟推进到该时刻进程照常被回收。
  - 「对齐期间的并发请求」：把 `session-spawn-gate-helpers.ts:199` 的 `holdExitEvents` 改为导出（不复制，jscpd），扣住第一个子进程的 exit。等待期间第二条 prompt 与 regenerate 都是 409 且行数不变，放开后第一条 202。两个 409 来自 `acceptPrompt` 与 regenerate 预检读到的 `status="running"`，不是 `#claims`，没有独立变异，写进偏离记录。
  - regenerate 与 fork：「档位不同时先退役再重新生成」以 `session-regenerate-rest-real.test.ts` 的 R2 为模板，改成进程存活加 PATCH `always-ask`；本刀新进程的帧序是 `get_branch_messages, branch, get_state, prompt`，规格场景里的 `set_model` 前缀由 9.2 补上，写进偏离记录。「分叉继承」的 argv 加在 `session-fork-metadata.test.ts:548-608` 既有两例上（`calls[0].args` 含 `--approval-mode yolo` 与 `--model workbuddy/m3`；封顶例为 `write` 与 `m1`），并改掉该文件第 19 行「argv 属组 9」的注释。undo 的规格没有 argv 场景，在新文件里补一例（直接写库 `yolo` 后撤回，临时进程 argv 含 `yolo`）。
  - 9.3 放 `session-approvals.test.ts`（421 行）：`openApprovalWorld` 的场景类型加 `"approval-write"`；首条 prompt 之前 PATCH `{approvalMode:"always-ask"}`（它自己写一条 `session.permission`，所以计数用 `approvalAuditCount`）。登记一例：`calls[0].args` 含 `always-ask`，行 `tool="write"`、`request_id="w1"`、`title="Allow tool: write\nPath: workbuddy-report.html"`，`approval.request` 事件，作答 `allow` 后 stdin 恰一帧 `{id:"w1", value:"Approve"}`，回合 `done`，审计 `detail.tool="write"`。超时一例照 `:155-173` 的 `TTL_MS - 1` / `1` 写。对照一步：同场景不 PATCH（`write` 档）时没有审批行。夹具在作答前就发 `tool_execution_start`，不照 bash 断言步骤门控。
  - 必须原样通过的不变量用例：`session-supervisor-pool-exit.test.ts` 的 E1 / E6 / E8、`session-supervisor-pool.test.ts` 的 A1–A8、`session-supervisor-admission.test.ts` 三例、`session-supervisor-claims.test.ts`（含 sink 重入）、`session-supervisor-before-dispatch.test.ts`（#944）、`session-stop*.test.ts`、`session-regenerate-rest-real.test.ts` 的 R2 / R5 / R6、`session-fork.test.ts` 的 R3 / R9 / G1、`session-composer-patch.test.ts:251`、`omp-host-overlay.test.ts`「overlay 不随档位变化」、`server-assembly.test.ts` 的 `ompArgs`。
  - 实机、overlay、冒烟：`host-overlay.ts:8-12` 的「靠重新 spawn 换档」自本刀起成立，文件与常量不动。官方对照用例不加（`omp-official-approval-modes.test.ts` 已钉住 D2 的 (a)–(d)，本刀只改取值来源，不改 spawn 契约；该文件仅 CI uid-isolation job 运行，写明验证缺口）。`smoke/session-meta.hurl`（#1038 之后）在首条 prompt 之前把载体会话 PATCH 到 `yolo` 又改回 `write`、其间没有进程，`yolo` 出生的那个会话未 prompt 即删除，所以没有冒烟步骤在非 `write` 档起进程或触发重启（#1009 评审更正），`chat.hurl` 无 PATCH，ui-walk 不碰档位；`make smoke` 是纯回归，18.1 / 18.2 以后再加档位用例。
  - 变异 → 判红：去掉 `reusable` 判定 →「以新档位重启」「生成中改档位」「先退役再重新生成」；拿原始列比较 →「未改档位不重启」的 PATCH `write` 一步与「调低上界」的恰一次 spawn；`Slot.approvalMode` 写死 `write` → 换回 `write` 时不重启（在「以新档位重启」末尾加一步 PATCH 回 `write` 再发 prompt，断言新 spawn）；PATCH 里调退役 →「修改设置本身不动进程」「生成中改档位」；supervisor 调用点仍传 `write` →「档位进入 argv」与 9.3 登记例；`branch-temp.ts` 仍写死 → 分叉 argv；传原始 `model_id` 而非有效值 → 封顶例的 `m1`；重启不等退役完成 → 第二次 spawn 时旧进程仍存活的断言。
  - 白盒不变量（交 owner 审）：(1) 档位只在 `#onSlot` 比较，位于「存活且持有名额」守卫之后、认领之前，PATCH 路径不调 supervisor；(2) 一个 slot 的启动档位与其 runtime 的 argv 档位出自同一个变量，终生不变；(3) 换档等于 `#retireSlot`（等待完成）加一次普通新准入，名额先释放后申请，同一会话任一时刻至多一个进程；(4) 进入 argv 的只有夹取后的档位与白名单内的模型，原始列与 `runtime.modelId` 都不进；(5) 每次派发只读一次原始值，且与受理或预检同一同步段；(6) 宿主在任何档位下都不自动应答 `extension_ui_request`，60 秒超时规则不变；(7) overlay 字节不变。
- [x] 9.2 模型与强度：`Generation`（`pool.ts`）增「已应用的模型与强度」；`composer-align.ts` 里实现 chat-sessions「派发前按会话设置对齐进程」第 2 步（先 `set_model` 后 `set_thinking_level`，成功后才记）。两个调用点：prompt 路径在取得进程之后、`#bindDispatch` 写 `prompt` 之前；regenerate 路径在取得进程之后、`get_branch_messages` 之前（`branching.ts` 的 regenerate 编排里，先于 `branch` 与事务——失败属事务前，行不变）。`supervisor.ts` 至多 6 行。
  测试同文件：model-selection「换模型与强度后的帧序」（逐字核对 `frames=`）、「新进程重新应用」「生成中修改不打断」「命令失败按派发前失败处理」「消息不带模型」（两个模型下各完成一个回合后：快照每条消息的键集恰为 chat-sessions「会话 REST」所列、`PRAGMA table_info(chat_messages)` 没有模型或强度列）；chat-sessions「对齐失败按派发前失败补偿」「regenerate 的对齐失败不动任何行」「regenerate 用当前设置」（帧序：`set_model`、`set_thinking_level` 先于 `get_branch_messages`）；turn-control「模型对齐失败发生在事务之前」；session-metadata「继承三项设置」的 argv 与帧序部分。
  既有经宿主驱动假 omp 并断言完整 `frames=` 序列的宿主测试（`grep -rn "frames=" server/test` 里以 `negotiate_protocol,get_state,prompt` 开头的宿主级断言）按「每个 generation 首次派发多 `set_model` 与 `set_thinking_level`」改写并写进偏离记录；假 omp 夹具自身的单元用例（`fake-omp.test.ts`）不经宿主，不改。
  **实施注记（9.2 + 9.4 + 9.5，fixture 评审补充，#1010）**：
  - 行数现状：`supervisor.ts` 783、`pool.ts` 353、`composer-align.ts` 30、`branching.ts` 375、`omp/runtime.ts` 799、`fake-omp.mjs` 797、`fake-omp-composer.mjs` 120、`omp-runtime-commands.test.ts` 798、`support/omp-rpc.ts` 518、`session-composer-dispatch.test.ts` 522。本刀不碰 `omp/runtime.ts`、`omp/process.ts`、`omp/commands.ts`、两个 fake-omp 文件、`omp-runtime-commands.test.ts`、`fake-omp*.test.ts`。
  - 不需要 `RealWorld` / `openReal` 的纯搬迁，也不必先加官方对照用例：runtime 级的 C10（`omp-runtime-commands.test.ts:700-722`）与 C11（`:730-738`）已钉住两帧与失败拒绝；实现只看 `command()` 成功或拒绝，不读返回值与错误文案。
  - 首次派发的对齐不能因 argv 已带 `--model` 而省：D8 (e) 实测 `--resume` 后模型以 argv 为准，强度却是会话文件里的旧值；规格写明「每个 generation 第一次派发无条件 `set_model`」，不做「argv 相同就跳过」的优化。
  - `pool.ts`：`Generation` 加 `applied: { modelId: string; effort: Effort | undefined } | undefined`，`generationTokens.issue` 的字面量里初值 `undefined`。临时进程没有 generation，不涉及。
  - `pool.ts` 新增 `commandOn(slot: Slot, frame: RuntimeCommandFrame): Promise<unknown>`，从 `branching.ts:132-146` 的 `#lastEntry` 原样抽出：记 `before = slot.generation`；catch 里取出并清空 `slot.acquisitionFault` 后 `throw fault ?? error`；finally 里 `slot.generation !== before` 则 `releaseDispatch(slot, slot.generation)`。`#lastEntry` 改调它，行为不变。
  - 为什么必须经 `commandOn`：新 slot 上第一条 `command()` 触发获取，`issue()` 生出的 generation 自带 `dispatchCount: 1`，随后 `#bindDispatch`（`supervisor.ts:497-499`）见它已存在再加一，generation 永不封存。`session-supervisor-faults.test.ts:79-84`（`rejects.toBe(tokens.issueFailure)`）与其上的 epoch 触发器例钉着获取故障的原样上抛，现在故障发生在 `set_model` 而不是 `prompt`。
  - `composer-align.ts` 新增 `alignModel(slot: Slot, effective: { modelId: string; reasoningEffort: Effort | null }): Promise<void>`，本地常量 `PROVIDER = "workbuddy"`（`process.ts:99` 是字面量，不为此改它）。它值导入 `./pool.js`（`pool.ts` 对 `supervisor.js` 只有 type 导入，无值环），偏离 9.1 注记「不导入 pool.js」。
  - `alignModel` 算法：`slot.generation?.applied` 为空或 `modelId` 不同 → `commandOn(set_model)`，成功后在当时的 `slot.generation` 上记 `{ modelId, effort: undefined }`；随后 `reasoningEffort !== null` 且与 `applied.effort` 不同 → `commandOn(set_thinking_level)`，成功后记 `effort`。`effort: undefined` 就是「刚发过 `set_model`」；两者都未变时不碰 runtime。
  - 线上取值：`level` 原样发有效强度，`off` 也发（实机表 `off → off`），集合外的值不夹取（O3）。不支持推理的模型有效强度恒为 null，即使原始列有值也不发 `set_thinking_level`，「帧序」第五步（PATCH `m2`）钉这一点。
  - `supervisor.ts` 只改 `#onSlot`（至多 4 行，终值不超过 787）：`const aligned = (slot: Slot) => alignModel(slot, effective).then(() => use(slot));`，`fresh()` 与存活路径都传 `aligned`，import 并入第 11 行。regenerate 经 `acquire → #onSlot` 自动落在 `get_branch_messages` 之前，`branching.ts` 只改 `#lastEntry` 与其注释——偏离任务原文「在 `branching.ts` 的 regenerate 编排里」。
  - 窗口：prompt 路径的认领先于对齐（存活路径 `#claim(live, claim)`、新 slot 在 `admit` 之前认领）；regenerate 路径靠 `controls.during`。池的 `busy()` 两者都看，所以对齐中的 slot 不会被驱逐，`#onProcessExit` 也不会抢先退役。命令应答到 `runtime.prompt()` 之间只有 promise 续体，`alignModel` 与 `aligned` 里不得插入任何 I/O await 或定时器。无命令可发时也多一个微任务，fence 是认领而不是同步性；因此变红的既有用例先查原因。
  - 失败处理不需要新产品代码：`#onSlot` 的 catch（`live.pump === undefined` → `#retireSlot`）与 `#onNewSlot` 的 catch 给出「slot 被退役」；`translateSupervisorError` 把 `AgentUnavailableError` 映射为 `agent_unavailable`，`agent_capacity` 原样透传；prompt 的受理对由 REST 既有路径补偿。「成功后才记」没有独立变异（失败必退役，提前记不可观察），写进偏离记录。
  - 实施更正（#1010）：上一条在一个窗口不成立。新准入的 slot 上，进程成功应答 `set_model` 后原生退出，下一次 runtime 入口取 token 时抛 `ReadmissionRequired`；它不经存活路径那一次重新准入，原样到达 `translateSupervisorError`，REST 成了 500。修法是 `supervisor-faults.ts` 的 `translateSupervisorError` 把它并入 `agent_unavailable` 分支（`supervisor.ts` 不动，不加重试）；`session-composer-align.test.ts` 冷 prompt 与冷 regenerate 各一例（502、已退役、已补偿、下一条 prompt 在新进程上重新对齐），去掉映射时恰这两例红。只在 FakeChild 上构造过；「`set_thinking_level` 之后退出」走同一翻译路径，未单独成例。
  - 逐情形期望：
  - prompt + `set_model` 失败：502；受理对删除，`status` / `updatedAt` 复原（基线取在 PATCH 之后）；该进程无新增 `prompt` 帧并已退役；审计不增；改回可用模型后 202（新 spawn 带 `--resume`）。
  - prompt + `set_thinking_level` 失败：同上。
  - prompt + 进程在对齐中退出：`agent_unavailable`，活进程 0，token 已撤销，下一条 prompt 新 spawn 并重发两命令。
  - prompt 换档后准入满：503 `agent_capacity`，受理对补偿，旧进程已退出，无新 spawn，`session.permission` 只有 PATCH 那一条。
  - regenerate + 失败模型：502；无 `get_branch_messages` / `branch` / `prompt`；a1 及其步骤、审批逐值不变；`status`、`updated_at`、`omp_session_file` 不变；进程已退役、占用释放；改回后 202。
  - regenerate 换档后准入满：503，行同样不变。
  - 冷进程上对齐失败时 `stream_epoch` 已加一（取得进程即 bump，同今天的 `get_branch_messages` 失败），断言不写 epoch 不变。
  - 失败装置：
  - 失败模型：`workbuddy-missing-model` 必须进测试世界的白名单（`THREE_MODEL_CATALOG` 加一项 `reasoning:false`），否则被 `effectiveComposer` 回落成缺省模型，用例测不到失败。
  - 失败强度：`workbuddy-bad-level` 不是七个强度名，REST 与迁移 040 的 CHECK 都拒绝；用 `PRAGMA ignore_check_constraints = ON` 直接写库再关掉（已在 node:sqlite 上验证可行，有效值解析对非 null 原始强度原样透传）。恢复用 PATCH `{reasoningEffort:"high"}`。写进偏离记录。
  - 对齐中进程死亡：FakeChild 脚本世界 `child.onCommand("set_model", () => child.exit(1))`，写法同 `session-fork-faults.test.ts:392`。
  - 503 的造法——prompt：上限 1，A 存活空闲，`holdFirstExit` 扣住 A 的 exit，PATCH A 换档后发 prompt（卡在 `#retireSlot`）；B 发 prompt，它的准入把 A 的旧 slot 当驱逐对象一起等；放开后 B 先入池且已认领，A 的 `fresh()` 无可驱逐 → 503。B 回合结束后 A 再发 202。
  - 503 的造法——regenerate：上限 1 的造法不适用（A 持有控制占用，旧 slot 不可驱逐）。用上限 2 加四个会话：D、A 依次各完成一回合（D 最久未活动，扣住 D 的 exit）；C1 发 prompt（驱逐 D 并等待），C2 发 prompt（排队）；PATCH A 换档后 regenerate（退役 A，其准入排第三）；等 A 的旧进程死后放开 D → C1、C2 入池且都已认领 → A 得 503。
  - 先做一次测试支撑提交：`support/omp-rpc.ts` 的 `FakeChild.replyHandshake`（`:416-424`）加 `set_model`（data `{provider, id: modelId}`）与 `set_thinking_level`（无 data）的成功应答。所有 supervisor 级 FakeChild 世界都经它（`session-supervisor-helpers.ts:157`、`session-delete-helpers.ts:308`、`session-supervisor-pool-exit.test.ts:412`；`scriptChild` 与 `session-fork-faults.test.ts:355` 只覆盖 `get_state`）。不加的话这些世界的每次派发都挂死在 `set_model`。此提交单独全绿。
  - 必须改写的帧序断言（缺省与 `TEST_COMPOSER` 世界都是推理模型、强度 `high`，前缀一律是 `set_model,set_thinking_level`）：
  - `session-stop-intent-helpers.ts:24` 的 `PROBED` → `negotiate_protocol,get_state,set_model,set_thinking_level,prompt,abort,prompt`（八处读者随之）。
  - `session-stop.test.ts:130`、`:209`、`:239`：在 `get_state` 后插两帧。
  - `session-supervisor-before-dispatch.test.ts:92`、`:169-173`：同样插两帧。
  - `session-stop-intent-windows.test.ts:212-216`：同样插两帧。
  - `session-composer-dispatch.test.ts:510-517` → `…get_state,set_model,set_thinking_level,get_branch_messages,branch,get_state,prompt`；同时改 `:15-16`、`:508` 的注释。
  - `turn-control-slash.test.ts:206-211`：冷进程 regenerate，`slice(2)` 之后多两帧，`frames[1]` / `frames[3]` 变 `[3]` / `[5]`。
  - `session-fork.test.ts:227-228`：R2b 是分叉会话自己的冷进程，`frames[1]` 变 `[3]`。
  - 不改且必须原样通过：
  - `session-regenerate.test.ts:96` 与 `session-regenerate-rest-real.test.ts:132`：同一 generation 上的第二次派发，无前缀；它们是「无条件发命令」变异的判红点之一。
  - 临时进程的帧序：`session-fork.test.ts:96,177,208`、`session-fork-rest-real.test.ts:236`、`session-fork-faults.test.ts:404-408`、`session-undo.test.ts:432-433`。
  - runtime / OmpProcess 级：`omp-approval-requests.test.ts:239-317`、`omp-runtime-commands.test.ts:359`。
  - `prompt-snapshot.test.ts:79`（数的是子进程个数）与 `linux/uid-isolation.test.ts`（不断言 `frames`）。
  - 临时进程：fork 不做第 2 步（chat-sessions 明文），`branch-temp.ts` 不动；message-undo delta 对撤回的临时进程未写，按 fork 同样处理，写进偏离记录。
  - 新测试放新文件 `server/test/session-composer-align.test.ts`（原文件加十来例会破 800，偏离「测试同文件」与 issue 的 PR Boundary）；`plant` / `processOf` / `setMode` / `holdFirstExit` 搬进 `session-composer-helpers.ts` 两处共用（jscpd）。
  - 新用例：
  - 「帧序」：三模型世界，`probeFrames` 逐字等于规格那一串；另断言 stdin 帧 `{type:"set_model", provider:"workbuddy", modelId:"m3"}` 与 `level` 依次为 `high,low,high`；`world.rt.calls` 恒为 1。
  - 「新进程重新应用」：接上例，推进 `IDLE_MS` 回收后新进程收到 `set_model,prompt`；改回 `m1` 后收到 `set_model,set_thinking_level,prompt`。
  - 「生成中修改不打断」：`approval` 场景挂起回合。
  - 「消息不带模型」：键集加 `PRAGMA table_info(chat_messages)`；负断言，无变异。
  - 「regenerate 用当前设置」。
  - 「继承三项设置」的帧序加在 `session-fork-metadata.test.ts:576` 既有例上：新会话 prompt 后 argv 为 `yolo`，前缀两帧为 `m3`、`low`。
  - 规格外补一例：`set_model` 应答被扣住时 stop → 202，放开后帧序为 `…set_model,set_thinking_level,prompt,abort`。
  - 9.5：CI 冒烟是官方 omp v18.0.10 加 `fake-upstream.mjs`（只读 `model` / `messages`，`ci.yml` 的 smoke、ui-walk、uid-isolation 三个 job 都用真 omp）；hurl 不数帧；缺省配置下推理开启，所以两条命令都会发；`chat.hurl:87` 的 regenerate 落在已对齐的 generation 上，无额外命令。纯回归。
  - 验证缺口：官方对照用例只在首回合之后的存活进程上发过这两条命令，没覆盖两种情形——「新会话握手后、首条 prompt 之前」（冒烟是唯一证据，本 PR 首次覆盖）；「`--resume` 冷进程上先两命令再 `get_branch_messages`」（对照与冒烟都不覆盖）。建议在 `omp-official-model-commands.test.ts`（327 行）补这两步只断言成功；该文件只在 CI uid-isolation job 运行。
  - 提交接缝：(1) `replyHandshake` 应答；(2) `commandOn` 抽取，行为不变；(3) `Generation.applied`、`alignModel`、`#onSlot` 接线，加帧序断言改写与成功路径新例；(4) 失败与 503 用例，勾 9.2 / 9.4 / 9.5。(3) 单独即可合并。
  - 变异 → 判红：
  - 两命令次序对调 → 「帧序」。
  - 每次派发都发 → 「帧序」第三条 prompt 与 `session-regenerate.test.ts:96`。
  - 新 generation 不重发 → 「新进程重新应用」与 `PROBED`。
  - 强度不同也不发 → 「帧序」第四条。
  - 不支持推理仍发 level → 第五条。
  - provider 写错 → `set_model` 帧断言。
  - 失败后仍 `use` → 「命令失败」两例。
  - 失败不退役 → 「该进程已被 retire」。
  - 对齐挪到 `acceptRegenerate` 之后 → 「regenerate 的对齐失败不动任何行」「模型对齐失败发生在事务之前」。
  - 对齐挪到 `get_branch_messages` 之后 → 「regenerate 用当前设置」。
  - 不上抛 `acquisitionFault` → `session-supervisor-faults.test.ts:79-84`。
  - 去掉 `commandOn` 的 `releaseDispatch` → 先看既有 `session-supervisor-pool-exit` / `session-supervisor-stream` 哪条红；都不红就补「空闲回收的退役窗口内（扣住 exit）快照游标 `seq` 为 null」。
  - 白盒不变量（交 owner 审）：
  - (1) 两命令只在 `#onSlot` 包住的 `use` 之前发，认领或控制占用已在手，PATCH 不通知 supervisor。
  - (2) 次序恒为 `set_model` → `set_thinking_level` → `prompt` / `get_branch_messages`。
  - (3) 已应用值只存在于 generation，新 generation 为空；失败必退役，脏值不会被后续派发读到。
  - (4) 发出的只有白名单内的有效模型与有效强度。
  - (5) 对齐不产生幽灵 `dispatchCount`。
  - (6) regenerate 的对齐先于任何行改动。
  - (7) 临时进程不发这两条命令。
  - (8) `omp/runtime.ts` 字节不变，命令与回合互斥仍由它的 `#turn` / `#commanding` 把关。
- [x] 9.3 审批在非 `write` 档下的端到端：`server/test/session-approvals*.test.ts` 新增一例——`always-ask` 会话 + 假 omp `approval-write`：登记、事件、作答、`chat_approvals.tool="write"`、审计（tool-approval delta 场景）；session-permission-tier「每次都问下的超时」（注入时钟 59999 / 60000）。
- [x] 9.4 变异证据：去掉档位比较 →「以新档位重启」判红；PATCH 时就退役 →「修改设置本身不动进程」「生成中改档位」判红；`set_thinking_level` 先于 `set_model` → 帧序判红；每次派发都无条件发命令 → 帧序第三条 prompt 处判红；新 generation 不重发 →「新进程重新应用」判红；命令失败后仍写 prompt →「命令失败」判红；把 regenerate 的对齐挪到事务之后 →「regenerate 的对齐失败不动任何行」「模型对齐失败发生在事务之前」判红（旧助手行被删）。
  「对齐期间的并发请求」钉的是既有的认领 fence（对齐发生在认领之后），没有独立变异，写进偏离记录。
- [x] 9.5 `make smoke` 通过（缺省配置下全部会话为 `write`、单模型：除每个 generation 首次派发多一条 `set_model` 加一条 `set_thinking_level` 外行为不变；真 omp 对这两条命令的应答已由组 1 核对）。

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
- [x] 11.2 `server/src/workspaces/rest.ts`（现约 175 行）：注册 `POST /api/workspaces/:id/uploads`——空间归属检查放在 preParsing（先于媒体类型解析），route-local 的 `application/octet-stream` 透传 parser，handler 按 workspaces delta「文件上传」的九步次序；`registerWorkspaces` 的依赖加 `uploadMaxBytes`。
  测试新文件 `server/test/workspace-upload-rest.test.ts`（`createApp` + 真 socket，注入式请求测不出流与中断）：「上传并自动建目录」「同名自动编号不覆盖」「超过大小上限」（声明超限不读体、分块超限、恰等于上限）「越界名字被拒绝并入审计」「名字规则与媒体类型」「他人与不存在的空间」「目录被占与审计失败」「临时空间同样可上传，并随最后一个会话删除」（归属判定走所有者作用域的 `rootOf`，对临时空间不加特例）。
- [x] 11.3 同文件：「中断与残留清理」（真实客户端发一半后断开；无 `.part`、无审计、无挂起请求）与「不进内存的流式写入」（32 MiB，`heapUsed + arrayBuffers` 增量阈值 8 MiB）。另加一条断言：应用的 `requestTimeout` 与 `connectionTimeout` 为 0（design D10），以及「超限恰为 413 而不是 400」（框架 body limit 没有抢先）。
- [x] 11.4 竞态现状记录（design D11 / Risks）：一条测试在 `resolve` 之后、打开之前把 `uploads` 换成指向沙箱内另一目录的符号链接，记录当前结果（预期：独占创建落在链接目标里）；用例标题与注释写明这是已登记的残余、不是保证，PR 描述里点名请白盒审查。
  **实施注记（11.4，fixture 评审补充，#1017）**：
  - 新文件 `server/test/workspace-upload-race.test.ts`。不放进 `workspace-upload-rest.test.ts`（766/800 行）。只从 `workspace-upload-helpers.ts` 取 `withUploadWorld`、`createWorkspace`、`upload`、`expectWire`、`auditOf`，不新增导出，不改产品代码。
  - 接缝：`import fsp from "node:fs/promises"`，`vi.spyOn(fsp, "open")` 后调 `syncBuiltinESMExports()`。先例是 `model-proxy-models-yml.test.ts:13-14,360-373`，被测的 `core/replace-file.ts:2` 与 `upload.ts:25` 一样是具名导入。`try/finally` 里 `mockRestore()` 再 `syncBuiltinESMExports()`。
  - spy 的行为：第一个参数是以 `<w.root>/uploads/.upload-` 开头的字符串时，先记下 `lstatSync(uploads).isDirectory()`（应为 true，证明已过路由的 `lstat`），再 `renameSync(uploads, <w.root>/uploads-was)`、`symlinkSync(<w.root>/elsewhere, uploads)`，然后原样转调真 `open`；只触发一次，其余调用直通。
  - 布置：`createWorkspace` 后预建 `<w.root>/uploads`（真目录）与 `<w.root>/elsewhere`。链接目标在同一工作空间内，即沙箱内。然后 `upload(world, w.id, "a.txt", "abc")`。
  - 记录的现状，逐条断言：响应 201 `{path:"uploads/a.txt", name:"a.txt", size:3}`；`readdirSync(elsewhere)` 恰为 `["a.txt"]`，内容 `abc`，没有 `.part`；`readdirSync(uploads-was)` 为 `[]`；`lstatSync(uploads).isSymbolicLink()` 为 true；审计有一条 `file.upload`，`detail.path` 为 `uploads/a.txt`（审计记的是逻辑路径，不是实际落点）；spy 恰触发一次。
  - 不用 `uploadsOf(w)` 当正向判据：它经 `existsSync` / `readdirSync` 跟随链接，会因错误的理由看到 `a.txt`。
  - 沙箱外无落点：`readdirSync(world.sandboxRoot)` 恰为 `["u1"]`，`readdirSync(join(sandboxRoot, "u1"))` 恰为该空间的目录，`readdirSync(w.root).sort()` 恰为 `["elsewhere", "uploads", "uploads-was"]`。另外对 `dirname(world.sandboxRoot)` 下除 `sandbox/` 外的部分做一次递归列举，上传前后相等。
  - 同一用例里先做对照：不装 spy 时同样的上传落在真 `uploads/` 里、`elsewhere` 为空。这样「落在目标里」能归因于替换。
  - W1a 不写用例（要 mock `rest.ts` 的 `lstatSync`，超出「一条测试」），只在文件头注释里分两种情况写明（评审核对代码后更正，#1017）：请求到达前链接已在位的，由 `sandbox.resolve` 的逐分量 `lstat` 以 403 `sandbox_denied` 拒绝并入审计（`workspace-upload-rest.test.ts` 已有用例）；`resolve` 之后、路由 `lstat` 之前放入的，由 `ensureUploadsDir` 以 409 拒绝——这一段**没有用例**（既有的 409 用例是 `uploads` 为普通文件）。
  - 标题与注释：标题写成 `records a registered residual, not a guarantee: uploads swapped for a symlink between the route's lstat and the exclusive create — the file lands in the link target`。文件头引用 design D11 / Risks，并写明：这条变红说明窗口被关上或行为变了，应更新记录与 Risks，不是把断言改回去。
  - 变异不适用（现状记录，没有要守的实现）。PR 描述里用三样代替：对照段；spy 内「此刻仍是目录」加触发次数；一句说明「引入目录句柄 / `O_NOFOLLOW` 式父目录校验后本用例应红」。PR 描述点名请白盒审查。
  - 前提：依赖 vitest 缺省的 forks 池按文件隔离内建模块的改写。除通用纪律外没有别的守卫会碰到。
- [x] 11.5 变异证据：先做名字规则再过沙箱 → `../../etc/passwd` 得到 400 而无审计，「越界」判红；用 `rename` 定名 →「同名不覆盖」判红；不删临时文件 →「超限」「中断」判红；先缓冲再写 →「不进内存」判红；归属检查放在 handler 里 → 他人空间加错误媒体类型得到 400，「他人与不存在的空间」判红。
  **实施注记（11.2 + 11.3 + 11.5，fixture 评审补充，#1015）**：
  - 漂移：`rest.ts` 现 270 行（不是约 175，C 加了 promote 与 `requireOwnedBeforeParse`）；依赖现为 `{store, sandbox, audit, listEvents}`（`rest.ts:19-25`、`app.ts:212`），`registerWorkspaces` 在 `workspaces/index.ts:4`，只转调 `registerWorkspaceRest`；加完上传约 380 行，不拆文件。既有测试没有必须改写的断言，点名之外变红先查原因。
  - 装配：`WorkspaceRestDependencies.uploadMaxBytes: number`（必填）；`AssemblyDependencies.uploadMaxBytes?: number`（`app.ts:74` 起，与 `modelCatalog` 并列）；`appAssemblyOf` 加 `uploadMaxBytes: config.uploadMaxBytes`（`server.ts:105`）；`createApp` 传 `assembly?.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES`，为此导出 `agent-config.ts:19` 的常量（PR 边界外一处，记偏离）。`registerWorkspaceRest` 入口同步校验正的安全整数，否则抛错；校验写在 `app.register` 回调之外，否则到 `ready` 才抛。
  - 路由放进封装作用域（照 `model-proxy/index.ts:72-75`）：`app.register((scope, _o, done) => { scope.removeAllContentTypeParsers(); scope.addContentTypeParser("application/octet-stream", (_req, payload, complete) => complete(null, payload)); scope.post(...); done(); })`；不设 `bodyLimit`。实测：根 hook 与错误处理器被继承，`routeOptions.url` 仍是 `/api/workspaces/:id/uploads`，根上其它路由不受影响，流式 parser 不查 `Content-Length`（`bodyLimit: 16` 加声明 999999 仍进 handler）。
  - 次序与状态码：`onRequest` no-store → 根 preParsing 401 → 路由 preParsing 做完整的第 1 步（`ensureOwnedRoot`：`rootOf` 为 null 或根不是普通目录 → 404）→ parser（非 octet-stream → `FST_ERR_CTP_INVALID_MEDIA_TYPE` → 400）→ handler：(a) `request.body` 不是 `Readable` → 400；(b) `name` 不是恰一个非空字符串 → 400；(c) `Number(content-length) > 上限` → 写 `upload.reject` → 413；(d) 不含 `/` 且超过 255 字节 → 400；(e) `sandbox.resolve(principal, id, "uploads/" + name, "write")` → 403；(f) 含 `/`、含 U+0000–001F 或 U+007F、以 `.upload-` 开头 → 400；(g) `dirname(absPath)` 缺失则 `ensureSharedDir`，存在而非目录 → 409；(h) `storeUpload({dir, name, source: request.body, maxBytes})`：`upload_too_large` 先写 `upload.reject` 再上抛（413），`conflict` 409，其余原样（500）；(i) 写 `file.upload` → 201 `{path, name, size}`。
  - `source` 必须是 `request.body`（即 `request.raw`）本身，不要包 `Readable.from(req.iterator(...))` 或 `PassThrough`：`pipeline` 对 server request 的销毁不连带 socket，413 发得出去（实测）；经迭代器包一层后超限会销毁 socket，客户端收不到任何响应（实测）。
  - 路由级 `onError` 设 `reply.header("Connection", "close")`：否则 413 之后 Node 在 keep-alive 连接上继续读并丢弃剩余请求体，违反「停止读取」；它对 preParsing 的 404 与媒体类型 400 同样生效（实测），`open` / `chmod` 失败时未被销毁的 source 也由此收场。规格写的是「可以关闭」，本刀一律关闭，记偏离。
  - 规格没写的分支（记偏离）：无 `Content-Type` 且无 body 时 parser 不运行，handler 拿到 `undefined` → 400；`.`、`a/` 在沙箱步 403，`./a.txt`、`/a.txt` 过沙箱后按含 `/` → 400（不放进 `storeUpload`，否则 500）；多余的 query 键忽略；`application/octet-stream; x=1` 接受；声明超限加越界名字 → 413 与 `upload.reject`，没有 `sandbox.reject`；`upload.reject` 写失败 → 500；审计失败后文件保留，不回删；分块超限或中断后留下空的 `uploads/`，声明超限不建目录。
  - 测不出先后的两处：parser 的 400 与步骤 (a)(b) 的 400 无从区分；第 1 步「不触及文件系统」只能以没有 `uploads` 目录、没有审计旁证。文件描述符不单独断言，以 `.part` 消失、`app.server.getConnections` 归零、同一 app 上后续上传成功代替（记偏离）。
  - 测试布局（合计会超 800 行，起手就拆；11.3 不在「同文件」，记偏离）：`server/test/workspace-upload-helpers.ts`（world、原始 socket 客户端、审计与目录读取）、`workspace-upload-rest.test.ts`（11.2 的八条场景、http-service-skeleton「上传路由的 parser 归属」的真实路由一半、装配与校验）、`workspace-upload-stream.test.ts`（11.3）。world 用 `withApp({ assembly: { runtime, uploadMaxBytes } })` 加 `app.listen({ host: "127.0.0.1", port: 0 })`；登录、建空间、建会话与删会话走 `inject`，上传一律走真 socket。
  - 客户端一律用 `node:net`，请求头与请求体放在同一次 `socket.write` 里（分两次写时服务端可能带着未读字节关连接，客户端得到 RST）。「不读请求体」与「请求体未被消费」只发头：`raw-http-helpers.ts` 的 `rawHttpRequest` 原样可用；分块超限发一个 2000 字节的块、不发结束块；另一例不带 `Connection: close` 请求头，断言收到 413 后服务端关闭连接。
  - 中断：声明 64 KiB、发一半，轮询到 `uploads/` 里出现 `.upload-*.part` 再 `socket.destroy()`，然后轮询到目录为空；断言没有 `file.upload` / `upload.reject`、连接数为 0。流出错：一个合法块后发非法块长行 `zz\r\n`，只断言服务端一侧（线上是框架自己的 400，不是统一信封）。超时：`app.initialConfig` 的 `requestTimeout` / `connectionTimeout` 与 `app.server.requestTimeout` / `app.server.timeout` 四个值都是 0。
  - 32 MiB：`vitest.shared.mjs` 没有 `--expose-gc`，用 `v8.setFlagsFromString("--expose-gc")` 加 `vm.runInNewContext("gc")`，不改配置。payload 在基线之前分配，基线前与每次采样前都 gc，采样 `heapUsed + arrayBuffers`，按 64 KiB `subarray` 加 `drain` 发送；内容比对在采样结束之后做；用例超时 30 s；依赖 vitest 缺省的 forks 池（同进程里的其它文件会污染读数）。
  - 临时空间：`inject` 无 body 的 `POST /api/sessions` 得到 T（根为 `<sandboxRoot>/u1/tmp-<T>`），删除用 `session-delete-helpers.ts` 的 `sendDelete`，未派发过 prompt 就不会起进程。审计失败照 `workspaces-http-failures.test.ts:264-300` 的 `db.setAuthorizer` 拒绝 `audit_events` 的 INSERT。256 字节名字在 `uploads` 存在与不存在时各一例，另加一例 86 个汉字（258 字节）。
  - 变异（11.5 的五条之外）：`source` 换成迭代器包装 → 分块超限收不到 413；去掉 `Connection: close` → keep-alive 一例超时；改用 `parseAs: "buffer"` → 声明超限、32 MiB 等例红（单加 `bodyLimit` 实测不改变任何行为：透传流的 parser 不查大小，#1015 的 PR 记为不可观测）；不 `removeAllContentTypeParsers` → `application/json` 变 500 或 201；去掉 (a) → 无 body 一例 500；(c) 与 (b) 对调 → 缺 `name` 加超限得 413；去掉 (d) → `uploads` 已存在的 256 字节例得 403；(g) 不判非目录 → 409 例变 500；`>` 写成 `>=` → 恰 1024 例 413；去掉校验 → `NaN` 例不抛；`createApp` 不取 `assembly.uploadMaxBytes` → 1024 上限各例红；`fastify({ requestTimeout: 1 })` → 超时断言红。11.5 里「用 rename 定名」「不删临时文件」两条改的是 `upload.ts`，在 REST 层判红。
- [x] 11.6 `smoke/files.hurl`：chat-harness delta 的上传断言（201、编号、目录树、403、400、404）；`make smoke` 通过。
  **实施注记（11.6，fixture 评审补充，#1016）**：
  - 只改 `smoke/files.hurl`（现 128 行）。它用 zhangsan（`u1`）的正式空间 `smoke-fixture`，id 在第 29 行捕获为 `workspace_id`；不建会话，没有要删的东西。文首第 1–6 行的流程注释同步补上上传步骤。
  - 属主侧五步插在 `notes.csv` 预览（第 96–100 行）之后、zhangsan 登出（第 102 行）之前，次序照 chat-harness delta 第 9 行：201 → 同名 201 → `tree?path=uploads` → 403 → 400。404 一步插在 lisi 登录（第 110–116 行）之后、lisi 登出之前，挨着既有的树 404。
  - 请求体用内联字节 `hex,776f726b6275646479;`（9 字节），请求头显式写 `Content-Type: application/octet-stream`。实测 hurl 8.0.1 发出的就是该媒体类型加 `Content-Length: 9`，不分块。不用 `file,…;` 引夹具，这样 `size == 9` 不随夹具变，`smoke/fixtures/README.md` 不用动。
  - 第一次上传 `POST …/uploads?name=smoke-upload.txt` → `HTTP 201`：捕获 `upload_first: jsonpath "$.name"`；断言 `jsonpath "$.name" matches /^smoke-upload( \(\d+\))?\.txt$/`、`jsonpath "$.path" == "uploads/{{upload_first}}"`、`jsonpath "$.size" == 9`。
  - 第二次同请求 → `HTTP 201`：捕获 `upload_second`；断言 `matches /^smoke-upload \(\d+\)\.txt$/`、`jsonpath "$.name" != "{{upload_first}}"`、`size == 9`。不写死编号：`make smoke` 连跑两遍，第二遍得到 `(2)`、`(3)`。
  - 目录树 `GET …/tree?path=uploads` → 200：两条 `jsonpath "$.entries[?(@.name=='{{upload_first}}' && @.type=='file')]" exists`（第二条换 `upload_second`）。必须用 `exists`：实测单条命中时 `count == 1` 报 `invalid filter input type`。过滤器里的模板与含空格括号的名字实测可用。
  - 403：URL 里字面写 `?name=../escape.txt`，不用 `[QueryStringParams]`，不做百分号编码。实测原样到达服务端，与第 64 行 `tree?path=../..` 同一机制。响应体与第 66 行的 `sandbox_denied` 信封逐字相同。
  - 403 的审计按第 57–78 行的写法加上：前面 `GET /api/audit?limit=1` 捕获 `upload_audit_before`，之后断言 `body != "{{upload_audit_before}}"`、`kind == "sandbox.reject"`、`actorId == "u1"`、`workspaceId == "{{workspace_id}}"`、`detail.op == "write"`、`detail.relPath == "uploads/../escape.txt"`。harness delta 没要求这条，但任务 18.5 把 11.6 列为「越界入审计」的证据；属于加严，记偏离。
  - 400：`?name=smoke-upload.txt` 加 `Content-Type: application/json`、body `{}` → `HTTP 400`，响应体 `{"error":{"code":"bad_request","message":"请求格式不正确"}}`（同 `smoke/session-meta.hurl:93`）。不另加 `name=sub/a.txt` 一类，delta 只点了媒体类型这一条。
  - 404：lisi（`u3`）对 `{{workspace_id}}` 发同样的 octet-stream 上传 → `HTTP 404`，响应体同第 121 行。issue 标题里的「不存在的空间」已由 `workspace-upload-rest.test.ts:587` 起的用例覆盖，冒烟不重复，记偏离。
  - 失败响应都带 `Connection: close`（`rest.ts:62-65`）。实测 hurl 在 403、400 之后自动换新连接继续，`--retry 0` 与 Makefile 第 64 行不用改。请求体保持几个字节，避免服务端带着未读字节关连接。
  - 不清理上传的文件：delta 第 20 行明写正式空间 `uploads/` 里的冒烟文件留着。每跑一遍加两个文件，同一沙箱本地连跑约 500 遍后编号用尽变 409；CI 每次是新沙箱。
  - 守卫都不受影响：`make smoke` 按文件名列五个文件，`scripts/test-ci-harness.sh` 的 contract 不读 `smoke/*.hurl`，AGENTS.md:89 的「五文件」不变。`ci-uid-isolation.sh` 的 `check_snapshots_closed` 只看 `snapshots/` 下的 `manifest.json`，`reap_owned` 查的是进程。`web/e2e/ui-walk.spec.ts:312-316` 只断言三个夹具按钮可见，多一个 `uploads` 目录不碍事。
  - 变异证据（实测，#1016；每条改产品代码 → 重新 build → 按 CI 方式跑冒烟 → 改回）：`size` 字面量写成 8 → 红；`upload.ts` 的 `link` 换成 `rename` → 红，但落在第一次上传（得 500：随后的 `unlink(temp)` 抛 ENOENT），再让临时文件清理容忍不存在才落到第二次的编号正则与 `name != upload_first`；`assertUploadName` 挪到 `sandbox.resolve` 之前 → 403 步红（得 400）。**两条保持绿色，冒烟在 HTTP 层区分不了**：去掉 `removeAllContentTypeParsers`（`{}` 被解析成对象，路由因 body 不是流回同一个 400 信封）、去掉路由 preParsing 的归属检查（`sandbox.resolve` 自己回 404，变的只是先拒绝还是先读 body）。这两道防线只由 `server/test/workspace-upload-rest.test.ts` 钉住；冒烟的 400、404 两步钉的是对外行为，引用 11.6 作证据时（如 18.5）不要把它算作这两道防线的证据。

Suggested fixture level: expanded - 文件写入与路径安全、资源上限与大输入、部分输出清理、账号隔离；Critical Path
Minimal mergeable slice: 11.1 一刀（纯 IO，带测试；导出被 11.2 引用前由其测试引用，knip 配置若报未引用则与 11.2 同刀）；11.2 + 11.3 + 11.5 一刀；11.4 一刀；11.6 随第二刀

## 12. sessions — prompt 携带附件

- [x] 12.1 `server/src/sessions/slash-commands.ts`（480 行）：导出 `attachmentSuffix(paths)`（message-attachments「交给 omp 的附件后缀」的确切字节）；wire candidates 的计算接受附件并接上后缀（chat-sessions delta 的 Branch alignment）。
  测试 `server/test/session-rest-slash.test.ts` 或新文件：「后缀的确切字节」「与斜杠规则的组合」；`server/test/session-regenerate.test.ts` / `session-fork.test.ts`：「Branch alignment of a message with attachments」三例（经既有的 runtime 替身给条目表）；C 的撤回测试文件：message-attachments「带附件消息的撤回对位」（wire candidates 对 undo 同样生效；条目文本缺后缀时 502）。
  只发附件的消息（`content` 为空串）不另写分支：候选恰一个，即后缀本身。测试并入上述文件：「与斜杠规则的组合」的空文本一段（`classifyPrompt("")` 为 `text`、`toWireText("")` 为空串）；「带附件回合的重新生成」的只有附件一段（条目文本为后缀 → 202；去掉开头两个换行的后缀 → 502）；「分叉拷贝与回填」的只有附件一段（`draft:""`）；「带附件消息的撤回对位」的只有附件一段。组 1 的 (g) 若不成立，本任务按 D12 的退路改过的 delta 实现。
  **实施注记（12.1，fixture 评审补充，#1018）**：
  - 位置更正：wire candidates 不在 `slash-commands.ts`（480 行，属实），而在 `server/src/sessions/branch-temp.ts`（205 行）的 `matches`（:162-164）/ `entryFor`（:173）/ `alignBranchEntries`（:185）；调用处是 `branching.ts:124`（regenerate，332 行）和经 `branchAt` 的 fork（`branching.ts:286`）、undo（`undo.ts:178`，364 行）。这三个文件就是 issue PR Boundary 里的「对位调用处取附件的最小改动」。
  - `slash-commands.ts` 紧邻 `toWireText` 导出 `attachmentSuffix(paths: readonly string[]): string`：空数组返回 `""`，否则 `"\n\n" + 固定说明行 + 每项 "\n- " + path`，末尾无换行。只此一份实现，由 `branch-temp.ts` 值导入（新边 `branch-temp → slash-commands`，无环）。
  - `matches(entryText, content, paths)` 先取 `suffix = attachmentSuffix(paths)`，再比 `content + suffix` 与（`content` 以 `/` 开头时）`" " + content + suffix`；不为空串写分支。`entryFor(entry, content, paths)` 的 `paths` 为必填参数，不给缺省值。
  - `StoredUser` 保持 `{id, content}`；`BranchTempPlan` 加 `attachments: ReadonlyMap<number, readonly string[]>`（消息 id → 所存路径，缺席即无附件），`alignBranchEntries` 取 `attachments.get(user.id) ?? []`；`RegeneratePlan` 加 `paths`（最后一条用户消息的）。
  - 读列走独立路径，不碰 `MessageView`、`MESSAGE_COLUMNS`、`toMessageView`：新文件 `server/src/sessions/store-attachments.ts` 仿 `store-todo.ts`，导出 `parseAttachments(text: unknown): {path: string; size: number}[]` 与 `readAttachmentPaths(db, sessionId): Map<number, string[]>`（`SELECT id, attachments … WHERE session_id = ? AND attachments IS NOT NULL`）。`SessionStore` 加一个方法 `attachmentPaths(sessionId)` 委托它，`store.ts` 760 行约 +4；该文件不导入 `store.ts`。
  - 三处 `#precheck`（`branching.ts:77`、`:242`，`undo.ts:133`）在 `store.getMessages` 的同一同步段里调 `store.attachmentPaths`，结果放进 plan；中间不得有 await。
  - 解析规则（偏离记录）：非字符串、JSON 解析失败、不是数组、任一元素不是「`path` 为非空字符串且 `size` 为非负安全整数」的对象 → 整体 `[]`；多余键丢弃不算坏值；不抛错、不改写列。12.2 / 12.6 复用这一份解析，本刀只消费 `path`。
  - 本刀不得接线：`rest.ts` 的 `parsePromptMessage`（现在 :511-527）与 `supervisor.prompt` 入参（:284）、`acceptPrompt` 签名与标题取材、快照 / fork / undo 响应的 `attachments` 键、`store-branch.ts:190-191` 的 `FORK_MESSAGE` 拷贝（按 12.2 原文「fork 拷贝带上该列」归 #1019）、`smoke/chat.hurl`、`fake-omp.mjs`（797 行，无余量；`--branch-entry` 已原样收任意文本）。
  - 无 #1019 时的布置：用 `seedDone` / `seedTwoTurns` / `seedUndoable` 或 REST `turn()` 落行，再 `UPDATE chat_messages SET attachments = ?[, content = ''] WHERE id = ?`（042 已在主干）。只发附件的行只能这样造，REST 现在对空文本 400。共用小助手放 `server/test/session-fork-helpers.ts`（323 行）。
  - 条目表：regenerate 只比末项，用真 fake-omp 的 `openRegenWorld({entries:[<文本+后缀>]})`，并断言 stdin 的 `prompt` 帧 `message` 等于该条目文本（scripted 替身的 `branch` 应答写死 `QUESTION`，证明不了这一条）。fork / undo 是从头 first-fit，前两条被固定条目占住，所以用 `openForkScripted` / `openFilesWorld` 的 `ChildScript.messages` 给自定义表，或把带附件消息放在第三条配 `--branch-entry`。
  - 「缺后缀 → undo u2 与 u1 都 502」一例里 u1、u2 文本必须不同（如 `FIRST` / `QUESTION`）；同文本时 u2 会对到 u1 的条目而 200，该例不会失败。
  - 测试落点：纯函数（「后缀的确切字节」、`toWireText(x, skills) + attachmentSuffix(paths)` 三段含空文本）进 `server/test/slash-commands.test.ts`（482 行）；解析坏值（`not json`、`{}`、`[{"path":1}]`、NULL）进新文件 `server/test/store-attachments.test.ts`；regenerate 四段进 `session-regenerate.test.ts`（448 行）；fork 进 `session-fork.test.ts`（497 行）；undo 进新文件 `server/test/session-undo-attachments.test.ts`（`session-undo.test.ts` 747 行放不下，12.6 接着用这个文件；偏离记录）。
  - 本刀只断言到：regenerate 202 / 502、行不变、`attachments` 列不变；fork 201、`draft` 为原文或 `""`、`branch` 帧的 `entryId`、body 仍恰 `{session, draft}`；undo 200、`draft`、`entryId`、body 仍恰三键。「与斜杠规则的组合」的路由层断言、fork / undo 响应的 `attachments`、被拷贝消息的附件留给 #1019；既有无附件用例一行不改。
  - 变异：后缀少一个换行、多尾换行或缺 `- ` →「后缀的确切字节」红；`matches` 忽略 `paths` → 带附件 regenerate 第一段 502 红；后缀只接裸候选 → ` /etc/hosts 是什么` + 后缀一段红；比较前 `trimStart()` →「去掉开头两个换行 → 502」红、「只有正文 → 502」不红时另查；调用处不传所存路径 → fork / undo 对位 502 红；`draft` 取 branch 文本 → `draft` 断言红；坏值解析抛错 → 坏值例红。
- [x] 12.2 store：附件列的读写放在新文件 `server/src/sessions/store-attachments.ts`（序列化 `[{path,size}]`、NULL 与坏值读作 `[]` 的解析）；`store.ts` 的 `acceptPrompt`（`store.ts:355`）只多收一个附件参数并在插入用户消息行时带上该列（约 +4 行，用 8.0 的余量；`store.ts` 不得超过 800）；`store-branch.ts`（266 行）的消息列集、视图映射与 fork 拷贝带上该列；fork 结果带分叉点消息的附件。
  首个标题的取材（chat-sessions「会话持久化与回合刷盘」的 MODIFIED）：文本非空时照旧取文本；文本为空串时取第一个附件路径最后一个 `/` 之后的部分，再过同一个 `titlePrefix`（`store-branch.ts`）。取材函数放在 `store-attachments.ts` 或 `store-branch.ts`，`store.ts` 里只改 `titlePrefix(text)` 那一处调用（`store.ts:378`），不为空文本另写落库分支——`content` 就是传进来的空串。
  测试（`server/test/session-store*.test.ts` 里覆盖 admission 的既有文件，或新文件）：chat-sessions「Attachment-only admission titles from the first file name」（四例标题、`content` 为空串而非 NULL、补偿后标题回到 NULL）；既有「Atomic admission and epoch separation」「Rename survives prompt compensation」原样通过。
  测试 `server/test/session-snapshot.test.ts` 与 fork 用例：message-attachments「快照带附件」「补偿与坏值」「分叉拷贝与回填」；chat-sessions「User messages carry an undo state」改写后的消息键集（`…,approvals,undo,attachments,steps`）；turn-control「分叉点消息的附件随响应返回」。
  **实施注记（12.2–12.5，fixture 评审补充，#1019）**：
  - 位置更正（origin/master b8d2e8a）：`rest.ts` 527 行（非 444），`parsePromptMessage` 在 :513-527（空文本判定 :522-525，非 439-443），`acceptPrompt` 调用 :267，`toWireText` 调用 :284，fork 响应 :367-370；`store.ts` 765 行，`acceptPrompt` 实现 :339（接口 :175），用户行插入 :355，`titlePrefix(text)` :362（非 378）；`store-branch.ts` 266 行属实（`MESSAGE_COLUMNS` :28、`toMessageView` :53、`FORK_MESSAGE` :190-191）；`ForkResult` 在 `branching.ts:225`，PR Boundary 漏列该文件（偏离记录）。
  - 切分：一个 PR 超 400 行，按 store / REST 缝切两个 PR（或同一 PR 两次提交），A 先合。A = 列的写入器、`acceptPrompt` 第四参、标题取材、`MessageView` / 快照 / fork 响应的 `attachments`、`FORK_MESSAGE` 拷贝、键集断言改写；合入后所有 `attachments` 都是 `[]`，web（组 5）已接受。B = prompt 路由校验、facade 与上限注入、`session-prompt-attachments.test.ts`、`smoke/chat.hurl`。`FORK_MESSAGE` 必须与写入器同在 A，否则分叉出的会话从带附件那条消息起对位全部 502。
  - 写入（A）：`store-attachments.ts`（74 行）加 `serializeAttachments(list?: readonly StoredAttachment[]): string | null`（缺席或空 → `null`，否则 `JSON.stringify(list.map(({path,size}) => ({path,size})))`）与 `titleSource(text, list)`（文本非空取文本，否则取 `list[0].path` 最后一个 `/` 之后、无 `/` 取整条）。`INSERT_MESSAGE` 加第六列 `attachments`，助手行（`store.ts:358`）与 regenerate（`store-branch.ts:166`）传 `null`。`acceptPrompt(sessionId, ownerId, text, attachments?)` 第四参可选，116 处测试调用不动；`store.ts:362` 改为 `titlePrefix(titleSource(text, attachments))`，`rollbackPrompt` 不动。store 层空文本且无附件时标题仍是 `""`（REST 不可达，偏离记录）。
  - 列按裸 TEXT 读是对的（偏离记录写一句）：`JSON.stringify` 把 U+0000–U+001F 与孤立代理都转义成 `\uXXXX`，所以写入值恒为合法 UTF-8、无 NUL，与路径校验无关；带外写入的 BLOB 或坏值经 `parseAttachments` 读成 `[]`。第 1 条另拒绝孤立代理（`Buffer.from(p,"utf8").toString("utf8") !== p` → 400；它没有 UTF-8 编码，且 tsconfig 是 ES2023，没有 `isWellFormed`）。
  - 读取（A）：`MESSAGE_COLUMNS` 加裸列 `attachments`（不 CAST），`MessageDbRow.attachments: unknown`，`toMessageView` 加 `attachments: parseAttachments(row.attachments)`，`MessageView` 加必填 `attachments: StoredAttachment[]`（`store.ts` 约 +3 行）。新值导入边 `store-branch.ts → store-attachments.ts` 无环。`rest.ts` 的 `PublicMessage` / `toPublicHistory` 在 `undo` 与 `steps` 之间发 `attachments`，逐项重投影 `{path,size}`；读取路径不碰文件系统。
  - fork（A）：`FORK_MESSAGE` 两侧列表都加 `attachments`，SQL 列拷贝原值（含 NULL 与坏值，不重新序列化）。`Forks.#precheck` 把分叉点消息的 `user.attachments` 放进 plan（与 `text: user.content` 同一次读；plan 里已有名为 `attachments` 的路径 Map，另起名），`#commit` 返回 `{session, draft, attachments}`；`rest.ts:367` 发三键；不动任何文件。
  - `SessionStore.attachmentPaths` 保留：三处 `#precheck`（`branching.ts:84`、`:266`，`undo.ts:138`）照旧在 `getMessages` 的同一同步段里调它，一行不改。删掉它要改 `undo.ts`（PR Boundary 明令不改）；两条读取路径共用 `parseAttachments`，结果一致。
  - 装配（B）：`RegisterSessionsOptions` 只加一个键 `sandbox`，类型是 sessions 自己声明的窄端口 `{ resolve(principal: {id: string}, workspaceId: string, relPath: string, op: "read"): string }`；sessions 不值导入 `core/sandbox/index.js`，不导入 workspaces。上限读 #1008 的 `options.upload.maxFiles`，不新增 `uploadMaxFiles` 键，不碰 `AssemblyDependencies`；#1008 届时未合入就停下报告。`app.ts:217-218` 的 `audit` 与 `createSandbox` 上移到 `registerSessions`（:197）之前，同一实例再传给 `registerWorkspaces`，路由注册次序不变（偏离记录：主规格没写 facade 进 sessions）。`registerSessionRoutes` 的依赖加 `sandbox`、`uploadMaxFiles`；唯一直接调用方 `session-rest-helpers.ts:96` 补一个被调用即抛错的 `sandbox` 与 `10`。
  - 校验（B）放新文件 `server/src/sessions/prompt-attachments.ts`，`rest.ts` 只做接线：`parsePromptBody(body, maxFiles) → {text, paths}`（键集恰 `{message}` 或 `{message,attachments}`；`message` 必为字符串，trim 一次，≤32768 字节；空文本且 `paths` 为空 → 400；第 1 条形状也在这里，纯词法、零 fs）与 `admitAttachments(...) → StoredAttachment[]`（第 2–5 条）。控制字符判定在本文件自写（`workspaces/rest.ts:112` 的 `hasControlCharacter` 不能跨模块导入）。
  - 次序（偏离记录）：解析体（含第 1 条）→ 归档 409 → `controlHeld` 409 → 第 2 条（缓存树的 `workspaceId` 为 null）→ 第 3 条（`classifyPrompt(text, skills).kind === "builtin"`；`skills` 上提到受理之前算一次，后面 `toWireText` 复用）→ 第 4 条对全部元素 `sandbox.resolve(principal, workspaceId, p, "read")` → 第 5 条对全部解析结果 `lstatSync` → `acceptPrompt` → `supervisor.prompt(id, toWireText(text, skills) + attachmentSuffix(paths), snapshot)`。全程同步，「受理与派发之间无 await」不变。归档或被 claim 的会话先得 409、不碰 fs、不写审计；`status=running` 的 409 在 `acceptPrompt` 内，所以运行中会话带越界路径得到 403。
  - 规格没写的分支（偏离记录）：第 4、5 条是两遍，`["uploads/不存在.pdf","../x"]` → 403 加一条审计；多个越界元素只有第一个抛出，每请求至多一条审计。互不相同按原始字符串比，`a` 与 `./a` 算两个。单段超过 255 字节时沙箱的 lstat 失败，按沙箱自己的结论 403 加审计（与文件读取路由一致，不加预检）。`uploads/a.pdf/x`（中间段是文件）resolve 放行而 `lstatSync` 抛 ENOTDIR：ENOENT / ENOTDIR → 400，其它错误照抛；补一例。`UPLOAD_MAX_FILES` 配得很大时请求体会先撞 Fastify 缺省 1 MiB 包络，同样是 400。
  - 大小与 TOCTOU：`size` 就是第 5 条那次 `lstat` 的 `size`，不另 stat、不打开文件；落库的 `path` 是请求原文。规格只要「校验那一刻」，不加锁。残余窗口写进 PR 描述（同 11.4 的做法）：resolve 逐段 lstat 之后、终点 lstat 之前，别的进程把中间目录换成符号链接，只会记下沙箱外某文件的大小，不读内容、不落绝对路径；与 `workspaces/rest.ts:283-285` 同类。
  - 技能命令带附件是允许的：第 3 条只拒 `builtin`，wire 文本是 `/skill:x 参数` 加后缀。「该回合不留 user 条目」在带后缀时没有实机核对（「实机核对结果」的 (g) 只核了以换行开头的文本），但对位两头都容得下：留了逐字节相等的条目就被消费，没留就跳过。这条消息自身的 regenerate / fork 仍 400，undo 为 `command`。路由层断言放 `session-rest-slash.test.ts`（273 行，现成的 `installSkill` / `openBound`）：`/skill:weekly-report 写周报` 与 `/etc/hosts 是什么` 各带附件 → 202、wire 前缀与后缀、`content` 为原文。
  - 测试落点（B）：新文件 `server/test/session-prompt-attachments.test.ts`，沿用 `session-rest-slash.test.ts` 的 createApp 世界（`openBareSession` + `vi.spyOn(supervisor, "prompt")` + REST 建空间与绑定会话）。文件用 `writeFileSync` 直接写进 `<root>/uploads/`（上传路由自有测试，偏离记录）；审计查审计表新增行的 `detail.op` / `detail.relPath`；未绑定会话用 `seedUnboundSession`。覆盖 12.3 点名的全部场景，外加 ENOTDIR、`[不存在, 越界]`、孤立代理三例，以及「快照带附件」的删文件后再读。404（空间根不可见）若带外也造不出，记为写不出变异的防御性分支。
  - 测试落点（A）：标题四例、`content` 为空串的 `typeof`、补偿回 NULL 放 `session-title-rollback.test.ts`（266 行）。「补偿与坏值」放 `session-snapshot.test.ts`（219 行），用 `store.acceptPrompt(…, [{path,size}])` 加带外 UPDATE。fork 放 `session-fork.test.ts`（596 行，`forked()` 多带出 `attachments`，含只有附件一段）与 `session-fork-metadata.test.ts:436` 旁（副本列原值与 `typeof` 逐值相等，含一条 `not json`）。#1018 用 UPDATE 造行的既有用例不改。
  - 必改的既有断言（偏离记录逐个点名，不得放宽）：`MESSAGE_KEYS` 三处——`message-undo-state.test.ts:39`、`session-snapshot-metadata.test.ts:25`（有序，插在 `undo` 与 `steps` 之间）、`session-approval-snapshot.test.ts:32`（排序）。整条消息字面量加 `attachments: []`：`session-rest-helpers.ts:38` 的 `UNBOUND_USER_VIEW`、`session-rest.test.ts` 四条助手消息（788 → 792 行，新用例一律不进该文件）、`session-snapshot.test.ts`、`session-store.test.ts`、`session-store-stopped.test.ts`。fork 键集 `["session","draft"]` 改三键：`session-fork.test.ts:121`、`:534`，`session-fork-rest.test.ts:166`（及其替身的 `ForkResult`），`session-fork-rest-real.test.ts:131`，`session-fork-metadata.test.ts:346`。`session-rest.test.ts:256/354/364/371` 的边界用例不带 `attachments`，原样通过。
  - 12.5：`smoke/` 里没有消息键集的 Hurl 断言（grep 为空；issue「加键即红」不成立），所以只新增。放在第二会话那条跟进 prompt 上（`chat.hurl:279`，同受 `skip_turn_control` 门控；历史已有 tool result，受控上游不再发工具轮）：建会话时捕获 `$.workspaceId` → `POST /api/workspaces/{{ws}}/uploads?name=smoke-attach.txt` 201 捕获 `path` / `size` → prompt 带 `attachments` 并捕获 `userMessageId` → 既有轮询加三条断言（该用户消息 `attachments` count == 1、`[0].path` 与 `[0].size` 等于捕获值）。临时空间随会话删除，不留文件。规格写的「yolo 会话的同一空间」等 18.2 落地时迁过去（偏离记录）。`fake-omp.mjs` 不改（`size-guard.sh` 只扫 `.ts/.tsx/.py`，797 行是纪律不是守卫）。
  - 白盒审查不变量（Critical Path，PR 描述里列出）：
  - 每条路径只经注入的 facade（与 workspaces 同一实例、同一 `rootOf` 与 emit），`op` 恒为 `"read"`；不用纯 `resolve`，不用 `workspaceRootOf` 加 `join`。
  - principal 是已认证账号，`workspaceId` 取会话自己的绑定值，绝不取自请求体。
  - 只有 `lstatSync` 加 `isFile()`：没有 `stat` / `open` / `read`。
  - 第 1–3 条在任何 fs 调用之前；审计只由 facade 写：403 恰一条，400 / 404 为零。
  - 任一拒绝都没有消息行、没有 supervisor 调用、没有快照步骤、没有 `listEvents.notify`。
  - `absPath` 不进库、响应、wire 文本或审计；后缀由校验过的同一数组按请求次序构造，不进 `content`、标题、`draft`。
  - 上限用注入值，不是字面量 10；校验到 `supervisor.prompt` 调用之间无 await。
  - 读取与 fork 不 stat、不复制、不删除文件。
  - 变异证据：12.4 所列逐条照做。另补：
  - `FORK_MESSAGE` 不拷列 → 副本 `attachments` 断言红。
  - fork 响应取 branch 文本或漏键 → 三键断言红。
  - `toPublicHistory` 漏键或放错次序 → 两处有序 `MESSAGE_KEYS` 红。
  - 路由不把校验结果传给 `acceptPrompt` → 「带附件的 prompt 被受理」列断言红。
  - `lstat` 换成 `stat` 或用 facade 以外的解析 → 符号链接一例的状态码或审计条数红。
  - 第 4、5 条合成一遍 → `[不存在, 越界]` 红；第 3 条挪到第 4 条之后 → `/todo` 带越界路径多出审计，红。
  - 不捕 ENOTDIR → 该例 500，红。
  - 助手行写了附件，或空数组写成 `"[]"` → `attachments` 列为 NULL 的断言红。
- [x] 12.3 REST：`server/src/sessions/rest.ts`（444 行）的 prompt 路由接受 `{message, attachments?}`，按 message-attachments「prompt 携带附件」的五条次序校验（第 1 条的个数上限即每条消息的附件总数上限 `UPLOAD_MAX_FILES`，owner S-23）（沙箱 facade 由装配处注入 sessions 模块——与 workspaces 用同一个实例，不另建），受理后把 `toWireText(...) + attachmentSuffix(...)` 交给 supervisor；fork 路由的响应加 `attachments`。
  **只发附件**（owner 2026-10-06 改判）：`rest.ts` 解析 `message` 的那一处（`rest.ts:439-443`，现在对 `trimmed.length === 0` 直接 400）改为——`message` 键缺失或不是字符串仍 400；去掉首尾空白后为空且 `attachments` 缺席或为 `[]` 仍 400；为空而 `attachments` 非空时不在这里拒绝，交给五条附件校验决定（通过即受理，`content` 存空串）。不为空文本另写派发分支。
  测试新文件 `server/test/session-prompt-attachments.test.ts`（含以 `/` 结尾的路径 `uploads/a.pdf/` → 400、无消息行、无审计一例）：「带附件的 prompt 被受理」「附件形状与前提」「越界附件被拒绝并入审计」、chat-sessions delta「Attachments are validated before admission」（含没有 `message` 键、`message:null`、空文本配 `[]`、空白文本配不存在的文件四例 400）「Attachment-only prompt is admitted」（空串与纯空白两种 `message`、`content` 为空串、supervisor 收到的恰为后缀、标题 `a.pdf`、空文本配越界路径 403 加一条审计、补偿后标题回到 NULL）、message-attachments「只带附件的 prompt 被受理」与「附件形状与前提」新增的两段（空文本无附件 400；空文本带附件 202 而 ` /todo` 带附件仍 400）、「越界附件被拒绝并入审计」里 `message:""` 的一遍；chat-sessions「Input boundaries」改写后的断言（空文本的 400 限定为无附件时；既有用例若断言「空 `message` 一律 400」而请求里不带附件则原样通过）；既有断言 prompt body「恰 `message`」与 fork 响应「恰 `{session,draft}`」的用例按 delta 改写（偏离记录；turn-control「正常分叉」的 201 带 `attachments:[]`）。prompt 的 202 仍是 C 的三键 `{userMessageId, assistantMessageId, undo}`，不动。
- [x] 12.4 变异证据：空文本带附件仍 400 →「只带附件的 prompt 被受理」判红；空文本无附件被放行 →「附件形状与前提」判红；空文本时跳过附件校验 → 空文本配越界路径一例判红；只发附件时标题取了空串或整条路径 → 标题断言判红；空文本存成 NULL 或存了原始空白 → `content` 断言判红；给空文本的 wire 文本去掉开头换行 →「Attachment-only prompt is admitted」的 supervisor 文本断言判红。后缀拼进落库的 `content` →「带附件的 prompt 被受理」判红；候选不接后缀 → 带附件回合的 regenerate 502，判红；跳过沙箱 resolve → 越界一例判红；内建命令带附件被放行 → 判红；读取时重新 `stat` 文件 →「快照带附件」的删除后一例判红。
- [x] 12.5 `smoke/chat.hurl`：chat-harness delta 的带附件 prompt 断言；既有断言消息键集的 Hurl 断言加上 `attachments`；`make smoke` 通过。
- [x] 12.6 撤回响应的附件（owner S-24，message-undo「撤回 REST」的 MODIFIED）：在 C 的 `server/src/sessions/undo.ts` / `store-undo.ts` 里——撤回事务删除消息行之前读出被撤回消息所存的附件数组（用 `store-attachments.ts` 的解析）；文件还原（如有）之后逐项判定是否仍存在（`core/sandbox` 的纯 `resolve`，`op=read`，不经会写审计的 facade；再 `lstat` 为普通文件）；200 的 body 加 `attachments`。判定出错按不存在处理，不使撤回失败。
  测试（C 的撤回 REST 测试文件，或新文件 `server/test/session-undo-attachments.test.ts`）：「响应带回仍存在的附件」四例（`keep` 下被删的不带回、`restore` 后被还原的带回、无附件为 `[]`、换成符号链接的不带回；四键 body；无 `sandbox.reject`）与同场景的只有附件一段（`draft` 为 `""`、附件带回、对位成功）；C 的 undo 既有用例里断言响应「恰 `{session, draft, files}`」的改为四键（偏离记录）。
  变异：不做存在性判定 → 第一例判红；在还原之前判定 → 第二例判红；用 facade 判定 → 第四例多出 `sandbox.reject`，判红；在事务之后才读附件 → 全部为 `[]`，判红。
  **实施注记（12.6，fixture 评审补充，#1020）**：
  - 现状核对（origin/master 3ec1fd1）：`undo.ts` 371 行（`UndoResult` :79、`#precheck` :135、`attachmentPaths` 调用 :140、`cwd` :180、`request.restore` :201、`#commit` :206-219、200 的三键 :343-347）；`store-undo.ts` 364、`rest.ts` 561、`store.ts` 780；`session-undo-attachments.test.ts` 119、`session-undo.test.ts` 747（新用例不进后者）。
  - 读出点：`#precheck` 里 `store.getMessages` 得到的 `user`（:153）已带 `attachments: StoredAttachment[]`（#1019，`toMessageView` 即 `parseAttachments`）；仿 `branching.ts:299` 往 `UndoPlan` 加 `stored: user.attachments`，与 `text: user.content` 同一次读。不新增 store 调用，`store-undo.ts`、`store.ts`、`store-attachments.ts` 一行不改（偏离记录：任务点名 `store-undo.ts` 但无需改动，「用 `store-attachments.ts` 的解析」经 `toMessageView` 满足）。
  - 判定点：`#commit` 里 `request.commit(...)` 成功之后（已在 :201 的 `await request.restore?.()` 之后），同步段内算 `attachments = surviving(root, plan.stored)`，`UndoResult` 加 `attachments: StoredAttachment[]`；commit 抛错时不碰 fs。
  - 判定 API：`undo.ts` 值导入 `resolve`（`../core/sandbox/resolve.js`）与 `lstatSync`；每项 `resolve(root, path, "read")` 为 `ok` 且 `lstatSync(absPath, {throwIfNoEntry:false})?.isFile() === true` 才保留，整段包在 `try/catch`，任何异常按不存在。不用注入的 `SessionSandboxPort`（facade 会写 `sandbox.reject` 并抛 403，`core/sandbox/index.ts:39-46`）。#1019 的不变量「不用纯 `resolve`」只约束 prompt 路由，本任务按 delta 原文反过来，PR 描述里写明。
  - root 与装配：`Undos` 已有 `cwdOf` 端口，绑定会话时它就是 `store.rootOf({id: ownerId}, workspaceId)`，与 facade 同一 root。判定时在 `try` 里重新调一次 `this.#ports.cwdOf(ownerId, plan.workspaceId)`，不复用 :180 的字符串（纯 `resolve` 对 root 做 `realpath`，root 中途被换成符号链接时只有重新走 `rootOf` 才拒绝）；`plan.workspaceId === null` 直接 `[]`。不加端口，`index.ts`、`supervisor.ts`、`app.ts` 不动；`cwdOf` 抛错与 `workspaceId === null` 两支写不出变异，记为防御性分支。
  - 响应：`undo.ts:343` 发 `{session, draft, files, attachments}`，`attachments` 排最后，元素经 `toPublicAttachment`（`rest.ts:459`，加 `export`，行数不变；`undo.ts` 已从 `./rest.js` 导入）。同步改 :78、:275 两处注释。`size` 一律是所存值（D17 第 7 项），不取 `lstat` 的。
  - 各分支（一律 200、该项不带回、无审计，写进偏离记录）：
  - 文件已删：`resolve` 放行，`lstat` 无条目。
  - 换成目录：`isFile()` 为 false。
  - 末段换成符号链接，或中间目录换成符号链接：`resolve` 拒绝。
  - 大小变了：照带回，`size` 为所存值。
  - 空间根在请求中途消失或不可用：`cwdOf` 抛错或 `realpath` 失败，结果为 `[]`。请求开始时就没了的走 :180 既有的 502，不变。
  - 列是坏值：`parseAttachments` 读成 `[]`，结果为 `[]`，对位也按无附件。
  - 所存路径重复或含 `..`（只能带外写入）：逐项独立判定，不去重。
  - `SessionStore.attachmentPaths` / `readAttachmentPaths` 本刀保留：`undo.ts:140`、`branching.ts:86`、`:267` 一行不改，`store-attachments.test.ts:95-137` 与 #1018 的对位用例原样通过。删除要动 `branching.ts`、`branch-temp.ts:56/:210`、`store.ts:21/181/648` 并删两条 #1018 用例，超出 PR Boundary 且无正确性收益；另立 issue。
  - 必改的既有断言（偏离记录）只有一处：`session-undo-helpers.ts:96` 的 `["session","draft","files"]` 改四键，`UndoBody`（:65-69）加 `attachments: unknown`，:92 注释同步。它经 `undoneWithFiles` / `undone` / `restoredBy` 覆盖 `session-undo.test.ts`、`session-undo-files.test.ts`、`session-snapshot-cleanup.test.ts`、`session-undo-attachments.test.ts` 的全部调用点。措辞同步两处：`session-undo.test.ts:383` 的标题、`session-undo-attachments.test.ts:9-10` 的文首注释。`session-rest-helpers.ts:194` 的 `undo()` 替身只 reject，不改。
  - web 不改：`parseSessionUndo`（`web/src/lib/session-contract.ts:649`）经 `withTransitionalDefaults` 三键、四键都接受，`web/test/session-contract-composer.test.ts:162-197` 已覆盖；收紧归 13.5。`smoke/` 无 undo body 断言。
  - 新用例放 `session-undo-attachments.test.ts` 的新 `describe`（约 119 → 260 行），自带 `vi.useFakeTimers({toFake:["Date"]})` 的 before/after（`at()` 需要），不影响文件里 #1018 的用例：
  - 世界：`openFilesWorld(worlds, [{}, {messages:[{entryId:"e-1",text:FIRST},{entryId:"e-2",text:<u2 文本+后缀>}]}])`。
  - 布置走真路由，不用 `attach()` 的 UPDATE：先 `put(world,"uploads/a.pdf","pdf")`、`put(world,"uploads/b.png","p")`（受理要 lstat，受理前的快照要含 `b.png`），`turnAt(world,10,FIRST)`，再 `at(20)` 用 `postPrompt(app, session, cookie, JSON.stringify({message, attachments}))` 发 u2（`sendPrompt` 只发 `{message}`），断言 202 且 `undo:"available"`，然后 `waitForTurn` + `settle`。
  - 后缀：双路径在测试里逐字拼出，`${A_PDF_SUFFIX}\n- uploads/b.png`；只有附件一段 `message:""`，条目文本恰为 `A_PDF_SUFFIX`。
  - 用例与断言：
  - (1) `keep`：删 `b.png`，并把 `a.pdf` 改写成别的长度，结果恰为 `[{path:"uploads/a.pdf",size:3}]`。
  - (2) `restore`：删 `b.png`，结果两项按存储次序，`files.restored` 为 1。
  - (3) 撤回无附件的 u1，结果为 `[]`。
  - (4) `keep`：`a.pdf` 换成指向空间外真实文件的符号链接，结果不含该项。
  - (5) `keep`：把 `uploads` 改名后换成指向它的符号链接（中间段），结果为 `[]`。
  - (6) `keep`：`a.pdf` 换成同名目录，结果不含该项。
  - (7) 只有附件：`draft` 为 `""`，附件带回，`branch` 帧的 `entryId` 为 `e-2`。
  - 每例断言四键，以及 `count(db, "SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'sandbox.reject'")` 为 0。不能用 `observed().audits`：成功的撤回必写一条 `session.undo`。
  - 白盒不变量（PR 描述里列出，请求白盒审查）：
  - 路径只来自被撤回消息所存的列，root 只来自 `cwdOf(已认证 ownerId, 会话自己的绑定)`，都不取自请求体。
  - `op` 恒为 `"read"`；对所存路径的 fs 调用只有 `resolve` 内部的 lstat/realpath 加一次 `lstatSync`，没有 `open` / `read`，不读内容；另有重调 `cwdOf` 时对空间根的一次 `statSync().isDirectory()`（实施时核实，#1020）。
  - `absPath` 不进响应、库或审计；这一步不写任何审计，也不抛错。
  - 所存数组在事务之前、与用户消息同一同步段读出；判定在还原与提交之后。
  - 前置校验的拒绝路径零 fs 调用；`keep` 不读快照。
  - 残余窗口（同 12.3）：`resolve` 之后、终点 `lstat` 之前中间目录被换成链接，只会多带回或少带回一个标签；下一次 prompt 的受理校验兜底。
  - 变异（PR 描述给证据）：
  - 不做存在性判定 → (1)、(4)、(5)、(6) 红。
  - 在 `restore` 之前判定 → (2) 红。
  - 用 facade 判定 → (4)、(5) 多出 `sandbox.reject` 或撤回变 403，红。
  - 事务之后再读附件 → (1)、(2)、(7) 为 `[]`，红。
  - 返回 `lstat` 的 size → (1) 红。
  - 跳过 `resolve` 只 `lstat(join(root, path))` → 只有 (5) 红；末段符号链接本来 `isFile()` 就是 false，任务原列的第四例杀不掉这条。
  - 去掉 `isFile()` → (6) 红；漏发 `attachments` 键 → 四键断言全红；`draft` 取 branch 文本 → (7) 红。
  - `lstat` 换成 `stat` 写不出变异（符号链接已被 `resolve` 拒绝），记入偏离记录。

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
- [x] 13.4 假 API 支撑：`web/test/` 里整页测试共用的假 API 构造（如 `chat-page-*-support.tsx`）加上 `getComposerOptions`（缺省返回三档、单模型、缺省上限）与 `uploadFile`，使组 14–17 的整页测试有地方接；既有整页测试原样通过。
  **实施注记（13.4，fixture 评审补充，#1024）**：
  - 现状漂移：`web/test` 里没有「假 API 构造」，整页测试用真的 `createApiClient` 加 `createFetchMock(routes)`，未登记路径抛 `unexpected request <path>`（`web/test/support.ts:86-99`）。「两个方法」因此落成两件事：路由表的缺省项，和共用的 `XMLHttpRequest` 替身。切片声明里的 13.1、13.2 已合入，本刀只有 13.4。两点写进偏离记录。
  - 路由缺省：`web/test/support.ts`（174 行）导出 `composerOptionsRoute(body: ComposerOptions = DEFAULT_COMPOSER_OPTIONS)`，返回 `{ "/api/composer/options": () => jsonResponse(body) }`。必须是 resolver：`Response` 体只能读一次，14.1 失败后要重取。常量从 `./session-meta-fixtures.js` 取，不另写字面量。
  - 接入四处共用表，都放在 `...routes` 之前：`authenticatedChatRoutes`（`chat-page-support.tsx:17-23`）、`authenticatedChatLifecycleRoutes`（`chat-page-lifecycle-support.tsx:73-80`）、`openProbedSession` 的内联表（`chat-page-artifacts-panel-support.tsx:215-221`）、`allowWorkspaceListFetch`（`support.ts:108-122`，加一个 `if` 分支）。
  - `openProbedSession` 没有 `routes` 形参，它的缺省项不可覆盖（评审补充，#1024）；组 14–17 若要在这条路径上给非缺省或失败的应答，先给它加形参。
  - 覆盖不加新 API：用例在自己的 `routes` 里写同一个键，后展开的赢。可传 `...composerOptionsRoute(封顶体)`，也可直接给 500 信封、`deferredResponse().promise` 或响应数组。`allowWorkspaceListFetch` 与它对 `/api/workspaces` 的既有做法一样无条件应答，要覆盖的用例不用它。
  - 其余支撑文件本刀不动。`chat-page-{welcome-scene,session-meta,session-delete,search,file-changes,artifact-card,ownership}-support`、`chat-approval-support`、`chat-undo-support` 都经 `renderChatPage` 或 lifecycle 的两个挂载，自动带上。`chat-page-slash-support.tsx` 的 `Harness` 是裸 `Composer`，不挂会话页。`files-fixture.tsx`、`settings-support.tsx`、`auth-router-support.ts`、`ui-support.ts`、`render-app-router.tsx` 不建表或不到会话页。
  - 留给 14.1 的清单（本刀不改，写进 PR 描述）：自带内联表且会到 `/` 的测试文件届时各自补 `...composerOptionsRoute()`——`app-shell-responsive.test.tsx:56-66`、`sidebar.test.tsx:115-119`、`topbar.test.tsx:68-72`、`nav-overlay-initial-focus.test.tsx:39-43`、`ui-toast-drawer-escape.test.tsx:120-124`、`login-form.test.tsx:46-51`、`settings-support.tsx:16-22`。
  - 「原样通过」的依据：现在没有产品代码请求该路径，多登记一个键不改变任何调用序列。组 14 之后，整页用例的请求数断言都是前后差值（`requestCount`、`paths(...).toEqual(before)`、`expectNothingSent`，如 `chat-page-new-session.test.tsx:60`、`chat-capability-bar.test.tsx:116-128`、`chat-page-slash-workspace.test.tsx:201-207`），只要 14.1 守住「每个 client 取一次」就不受影响。绝对断言只有三处：`chat-page-slash.test.tsx:486/493/503` 与 `chat-page-slash-workspace.test.tsx:329`（裸 `Harness`，不受影响）、`auth-router.test.tsx:222` 与 `login-form.test.tsx:305`（`expectPaths`，停在登录页）。
  - XHR 替身：新文件 `web/test/upload-support.ts`，把 `api-upload.test.ts:15-63` 的 `FakeXhr` 原样搬过去，不增删成员。导出 `FakeXhr`、`installFakeXhr()`（即 `vi.stubGlobal("XMLHttpRequest", FakeXhr)`）、`lastFakeXhr()`（取 `instances.at(-1)`，没有就抛）、`resetFakeXhr()`（清空 `instances`）。
  - 整页用例的写法：`renderChatPage` 之后调 `installFakeXhr()`；进度 `xhr.progress(loaded, total)`；成功 `xhr.respond(201, JSON.stringify({path, name, size}))`；信封失败 `xhr.respond(413, …)`；网络失败 `xhr.dispatchEvent(new Event("error"))`；中止看 `xhr.aborts`；串行队列看 `FakeXhr.instances.length`。
  - 卸载：`cleanupChatPage`（`chat-page-support.tsx:56-64`）已有 `vi.unstubAllGlobals()`，再加一行 `resetFakeXhr()`。不在 `mountChatPage` 里缺省安装（今天没有调用方，组 16 自己装）。
  - `api-upload.test.ts`（297 行）本刀必须改用共用替身：删本地类，`start()` 与「已中止」一例改调 `installFakeXhr()` / `lastFakeXhr()`，`afterEach` 改调 `resetFakeXhr()`，断言一条不动。留两份是 jscpd 克隆（`.jscpd.json` 的 pattern 含 `web/**/*.ts`）；不改用则新文件的导出没有引用方，knip 会报。
  - knip：`knip.json` 的 web `project` 含 `test/**`，entry 只有 `*.test.ts(x)`，所以支撑文件里没人导入的导出会被报。本刀每个新导出都要有导入方：`composerOptionsRoute` 有三个支撑文件加自测，`FakeXhr` 的四个导出有 `api-upload.test.ts`、`chat-page-support.tsx` 加自测。不预留组 16 才用的 helper。
  - 自测新文件 `web/test/chat-page-composer-support.test.tsx`（没有产品调用方，由用例自己在挂载后经被替换的全局 `fetch` 调 `createApiClient().getComposerOptions()`）。六例：`renderChatPage("/", {})` 连调两次都 `toEqual(DEFAULT_COMPOSER_OPTIONS)`；传 `composerOptionsRoute(封顶体)` 得到封顶体；`renderChatPageWithAuthProbe` 与 `openProbedSession` 各一例得缺省；`allowWorkspaceListFetch()` 包住空表的 `createFetchMock({})` 得缺省；`installFakeXhr()` 后 `uploadFile` 恰建一个 `FakeXhr`，`cleanupChatPage()` 之后 `FakeXhr.instances` 为空且 `globalThis.XMLHttpRequest !== FakeXhr`。
  - 变异：从任一共用表去掉缺省项，对应一例红；把缺省放到 `...routes` 之后，覆盖例红（只钉住 `chat-page-support.tsx` 的表；lifecycle 表的先后没有用例，组 14+ 首个经 `renderChatPageWithAuthProbe` 覆盖的用例会钉住它）；resolver 换成静态 `Response`，连调第二次红；`cleanupChatPage` 去掉 `resetFakeXhr()`，末例红；替身本身由 `api-upload.test.ts` 既有用例钉住（如 `abort()` 不派发事件，在途中止例红）。
  - 行数与边界：`chat-page-support.tsx` 74 行、`support.ts` 174 行、`api-upload.test.ts` 变短，都远离 800。不改 `web/src/**`；新文件在 `web/test`，不涉及 `MIGRATED_AREAS`。
- [x] 13.5 解析收紧（三步走的第三步；在组 8、12 的服务端 PR 都合入之后）：删除任务 5.1 的全部过渡分支与顶部注释，`parseSession` 只接受十四键、消息必须带 `attachments`、fork 响应与 undo 响应必须带 `attachments`、`modelId` 空串为非法。
  测试：chat-web「三键与附件的严格解析」「撤回与转正方法」（缺 `attachments` 的 undo 200 为无效响应）、session-sidebar「十一键接受与其它键集拒绝」（标题沿用 C 的原名，正文为十四键）；删除 5.2 的过渡用例；全仓库搜不到过渡注释里的标记。变异：恢复任一过渡分支 → 判红。`make smoke`、`make ui-walk` 通过。
  **实施注记（13.5，fixture 评审补充，#1025）**：
  - 过渡代码只在 `web/src/lib/session-contract.ts`（694 行，删后约 665）：头注释 `:1-4`、`TRANSITIONAL_SESSION_COMPOSER` 与 `TRANSITIONAL_ATTACHMENTS` `:187-192`、`withTransitionalDefaults` `:204-217`，四个调用点 `parseSession:284`、`parseMessage:388`、`parseSessionFork:581`、`parseSessionUndo:650`；`composer-contract.ts`、`api-sessions.ts`、`api.ts`、`stream.ts`、`runtime-convert.ts` 没有过渡分支，不改。
  - 收紧后一律单次 `hasExactlyKeys`：会话恰十四键（现接受十一或十四）；消息恰十键 `{id,role,content,thinking,status,createdAt,steps,approvals,undo,attachments}`（现九或十）；fork 恰 `{session,draft,attachments}`（现二或三）；undo 恰 `{session,draft,files,attachments}`（现三或四）；`parseSessionComposer:270` 加 `modelId === ""` 拒绝（内联写，`composer-contract.ts` 反向导入本文件，不能从它取 `isNonEmptyString`）。
  - 服务端出口逐一核过，全部恒发新形状：列表 `rest.ts:246`、快照 `rest.ts:473-482`、fork `rest.ts:410-414`、undo `undo.ts:399-403`；创建 `rest-metadata.ts:107` 与 PATCH（含归档）`:138` 直接发 `SessionView`，不经 `toPublicSession`，但视图唯一构造处是 `store-view.ts:71` 的 `toSessionView`（十四字段）。
  - 不含会话视图或消息对象的出口：列表事件 `list-events.ts:11` 只发 `data: {}`；会话 SSE 不带视图与 `attachments`（web 在 `stream.ts:140,214` 本地补 `attachments: []`，不经解析）；prompt 202、regenerate 202、错误信封都不含。
  - `session-contract-composer.test.ts`（217 行）删除前先迁走最终形状断言：`:201-217` 非空附件经 `chatStateFromSnapshot` 与 `convertMessage` 的透传迁到 `chat-runtime-convert.test.ts`（154 行）；`:79-90` 三键值域与十五键、`:102-139` 附件元素规则与助手非空拒绝、`:176-198` fork/undo 拒绝表迁到新文件 `web/test/session-contract-attachments.test.ts`，基底换成十四键与带 `attachments` 的形状。
  - 该文件里只删四条过渡用例 `:62`、`:94`、`:145`、`:161`，各改写成拒绝行；`:70` 的「an empty model id」由接受改为拒绝。
  - `session-contract-metadata.test.ts`（375 行）必须改基底，否则 `:185-215` 与 `:310-328` 的拒绝表全因「十一键」被拒而空转：删 `NULL_ELEVEN_KEY_META` `:52-58` 与 `parsed()` `:69-72`，`metaSession` 补三键，`:177/:213/:223` 的 fork 体加 `attachments: []`，`:301` 改 `toHaveLength(14)`。
  - 同文件补行：`:217-225` 遗留表加十一键；`:310-320` 加「十一键」「`approvalMode:"auto"`」两行，标签 ten-key 改 thirteen、twelve-key 改 fifteen；`:298` 用例名保留「十一键接受」字样（规格标题沿用 C 的原名）。
  - `api-turn-control.test.ts`（403 行）：`:90` 请求用例的 201 体加 `attachments: []`；`:200-211` 两键期望 `[]` 的过渡断言改成拒绝行「a missing attachments」；`:224-229` 六行各加 `attachments: []`，保证每行只有一个缺陷。
  - `api-undo.test.ts`（232 行）：`undoBody` `:51-52` 加 `attachments: []`，`:90-108` 改为 `toEqual(body)`，`:118-131` 的手写体同样补键，新增「missing attachments」行（规格「缺 `attachments` 的 undo 200 为无效响应」）。
  - 整页夹具三处仍是旧形状：`chat-fork-button.test.tsx:99` 的 `forked()`、`chat-page-new-session.test.tsx:413`（N6 断言「迟到 201 不导航」，不补键会因响应非法而空过）、`chat-export.test.tsx:63-104` 的 `user()` / `assistant()`（九键，经 fetch 进解析）；各加 `attachments: []`。
  - 其余夹具已是新形状，不改：会话全经 `session-meta-fixtures.ts` 的 `NULL_SESSION_META`（十四键，`modelId:"m1"`），消息经 `chat-stream-support.ts` 与 `chat-page-ownership-support.ts`，`chat-undo-support.tsx:108-120` 已四键；`chat-export-markdown.test.ts` 与 `search-match.test.ts` 是纯函数用例，不经解析。
  - 守卫：被删 helper 与常量都未导出，knip 无新报；`APPROVAL_MODES` / `REASONING_EFFORTS` 仍被 `composer-contract.ts:2` 引用；改动的测试最大是 `chat-fork-button.test.tsx`（547 行），远离 800；新文件在 `web/test`，不涉及 `MIGRATED_AREAS`；新文件的 `message()` 与 `session-contract-undo.test.ts:25-37` 相近，留意 jscpd。
  - 标记验收命令：`git grep -n -i "withTransitional\|TRANSITIONAL_\|过渡分支\|过渡期\|任务 13\.5" -- . ':!openspec' ':!IMPLEMENTATION_PLAN.md'` 须为空（现命中 `session-contract.ts`、`session-contract-composer.test.ts:2-5`、`session-contract-metadata.test.ts:69`）；顺手把 `api-sessions-metadata.test.ts:94,166` 用例名里的 eleven-key 改成 fourteen-key。
  - 变异（恢复旧形状 → 判红）：`parseSession` 再收十一键 → metadata 遗留表与列表表的十一键行；放行 `modelId:""` → 新文件空串行；`parseMessage` 再收九键 → 新文件「消息缺 attachments」行；fork 再收两键 → `api-turn-control`「a missing attachments」；undo 再收三键 → `api-undo`「missing attachments」。
  - 提交缝与 PR 用句：提交一只补夹具并迁移断言（过渡解析下仍全绿），提交二删过渡代码与旧文件并翻转拒绝行。版本偏斜：web 包由同一 server 进程经 `@fastify/static` 提供（`app.ts:5,263`），无部署次序问题；已打开的旧包仍接受十四键。`web/e2e` 只有 `route-hold.ts:20` 与 `ui-walk-layout.ts:70`（登出）两处拦截，不伪造会话体，`make ui-walk` 走真实出口。

Suggested fixture level: expanded - 浏览器 API 客户端的公共合同（新方法、新输入、严格键集收紧）
Minimal mergeable slice: 13.1 + 13.2 + 13.4 一刀；13.3 一刀；13.5 一刀（最后，依赖服务端两处键集都已发出）

## 14. web — 能力行布局与权限档位控件

- [x] 14.1 options 状态：新文件 `web/src/features/chat/composer-options.ts`（hook：每个 client 取一次 `getComposerOptions` 并缓存，失败后在下一次进入欢迎态或选中会话时重取；登记 `MIGRATED_AREAS`）。由 `use-chat-session.ts`（702 行）调用并把结果与欢迎态的三项内存选择交给页面；欢迎态选择的状态放进 `welcome-options.ts`（35 行）或该新文件，不加大 `use-chat-session.ts` 超过必要的几行。
  测试新文件 `web/test/chat-composer-options.test.tsx`（hook 层 + 假 `getComposerOptions`）：同一个 client 下多次挂载、切换会话恰取一次；第一次失败后，切到另一个会话或回到欢迎态触发恰一次重取，重取成功后结果可用且此后不再取；换 client（换账号）重新取。整页层由 chat-web「选项读取失败后重取」钉住（14.2a 的测试文件）。变异：去掉重取 → 两处都判红（失败一次后控件永不出现）；每次切换都取 →「恰两次」判红。
  实施注记见 `implementation-notes.md`「14.1（#1026）」。
- [x] 14.2a 能力行重排与改名：`composer.tsx` 与 `capability-bar.tsx`（253 行）按 chat-web delta「输入框与能力栏」——左组次序改为「+」、工作空间、权限；右组容器放模型与强度的插槽（组 15 填）；「+」按钮改名 `添加文件或命令`。验证：改名后的既有用例、「能力行的次序」里不涉及三个新控件的部分、「选项读取失败后重取」的请求次数部分（控件出现的断言在 14.3、15.2 补全）；session-sidebar「无权限元素与无匹配」（标题沿用原名）改写后的断言（既有断言「能力栏无 `权限` 文本、无上传控件」的用例按 delta 改写，偏离记录）；chat-web「会话页」的「欢迎态与静态引导」改写后的 THEN（标题沿用原名）：既有欢迎态用例（`chat-page-welcome-scene.test.tsx` 等）里断言「无权限设置、上传…无附件 / 模型控件」的改为只断言无专家与麦克风控件、未选入文件时没有附件标签区（偏离记录）；三个新控件与 `上传文件` 在欢迎态出现的正向断言随 14.3、15.2、16.2a 落。
  实施注记见 `implementation-notes.md`「14.2a + 14.2b（#1027）」。
- [x] 14.2b 窄屏：工具行换行、右组整体落行靠右、工作空间与模型按钮的最大宽度与截断（`title` 带完整文字）。验证：类名 / 结构断言（jsdom 不作像素断言），真实布局由 18.3 的走查钉住。
- [x] 14.2c 「+」菜单的可用性语义：按钮只在锁定时禁用；`上传文件` 菜单项本任务不渲染（它随组 16 的真实行为一起出现，不先摆一个禁用的空壳；规格里「第一项是 `上传文件`」的断言也在组 16 落）；草稿非空时命令条目 `aria-disabled` 与提示行。验证：chat-web delta「「+」菜单写入草稿」改写后的断言；断言「草稿非空时按钮禁用」的既有用例按 delta 改写为「按钮可用、命令条目不可选」（偏离记录）。
  （14.2a 的）改名波及的既有引用一次改完：`web/test/chat-composer.test.tsx`、`chat-page-welcome-scene.test.tsx`、`chat-page-plus-menu.test.tsx`、`chat-capability-bar.test.tsx`、`chat-stop-button.test.tsx`、`web/e2e/ui-walk-sessions.spec.ts`（只改字符串，不加行）。
  实施注记见 `implementation-notes.md`「14.2c（#1028）」。
- [x] 14.3 权限档位控件：新文件 `web/src/features/chat/permission-tier.tsx`（登记 `MIGRATED_AREAS`）：按钮、单选菜单、说明与底部提示、`全部自动` 的确认框、警示色与 `data-tier`、提交与失败回退、不随输入框锁定禁用。已选会话走 `patchSession`（经 `turn-actions.ts` 或 `session-actions.ts` 里的一个 handler，带既有的所有权 fence：切走会话后迟到的响应不改界面）；欢迎态改内存值并进入首次发送的 `createSession` input。
  测试新文件 `web/test/chat-permission-tier.test.tsx`（整页挂载）：session-permission-tier「权限档位控件」五条场景；chat-web delta「能力行的次序」「锁定时三个控件仍可用」的权限部分。
  实施注记见 `implementation-notes.md`「14.3 + 14.4 + 14.5（#1029）」。
- [x] 14.4 变异证据：去掉确认框 →「切换到全部自动要确认」判红；取消后仍提交 → 判红；`yolo` 不带警示标记 → 判红；控件随锁定禁用 →「生成中可改」判红；失败后显示新值 →「失败回退」判红；欢迎态选择发了请求或没进创建 input →「欢迎态的选择进入创建请求」判红；左组次序错 →「能力行的次序」判红。
- [x] 14.5 功能验收清单「会话（CH）」新增行（`待签`）：能力行的五项与次序；三档的名称与说明；选 `全部自动` 的确认与警示色；生成中改档位、下一条消息起生效（操作步骤：`只问命令` 下让助手执行命令出现确认卡 → 改为 `全部自动` → 再发一条同样的话不再出现确认卡）；`每次都问` 下让助手写文件出现确认卡；新会话沿用上次的档位；管理员封顶后菜单里没有被封的档位（写明需要管理员改配置并重启）。

Suggested fixture level: expanded - 权限控件是审批策略放宽的用户入口（确认、警示、失败回退、所有权 fence）；改一个被测试与走查按名引用的可访问名
Minimal mergeable slice: 14.1 + 14.2a + 14.2b + 14.2c 一刀（options 状态、重排与改名、窄屏、菜单语义；此刀后权限 / 模型控件与 `上传文件` 项都尚未渲染）；14.3 + 14.4 + 14.5 一刀

## 15. web — 模型与推理强度控件

- [x] 15.1 新文件 `web/src/features/chat/model-picker.tsx`（登记 `MIGRATED_AREAS`）：模型按钮与菜单（能力标签、截断与 `title`、`modelId` 不在 options 里时退为原文）、强度按钮与菜单（七个界面名的映射常量放在同一文件或 `composer-options.ts`，没有 `自动`；当前强度不在当前模型的 `efforts` 里时按钮照常显示其界面名、菜单没有选中项）、提交与失败回退、两个控件互相禁用在途、不随输入框锁定禁用；欢迎态换模型时强度的重算规则。提交的 handler 与组 14 的权限共用一个 `patchComposer(sessionId, patch)`（不写第二份 fence 逻辑）。
  实施注记见 `implementation-notes.md`「15.1–15.4（#1030）」。
- [x] 15.2 测试新文件 `web/test/chat-model-picker.test.tsx`（整页挂载）：model-selection「模型与推理强度控件」五条场景。
- [x] 15.3 变异证据：不支持推理时仍渲染强度控件 → 判红；换模型后不以响应为准 →「切换模型与强度」的 `{m3, high}` 一步判红；欢迎态保留新模型不支持的强度 →「欢迎态的选择」判红；当前强度不在 `efforts` 里时按钮退为空或原文、或菜单里有选中项 →「切换模型与强度」的 `{m3, xhigh}` 一例判红；`reasoningEffort` 在不支持推理的模型下仍进创建 input → 判红。
- [x] 15.4 功能验收清单新增行（`待签`）：输入框下方右侧显示模型名与推理强度；点模型名切换（需要管理员配置多个模型，写明配置前只有一项）；强度的档位列表（缺省单模型配置下七项，没有 `自动`；写明该配置下所选强度可能被 omp 取成相邻的一档，要一致需管理员配置 `MODEL_CATALOG` 的 `efforts`）；不支持推理的模型不显示强度；生成中切换不影响正在生成的回答、下一条消息起生效；重新生成用当前选择；分叉出的会话沿用原会话的选择；新会话沿用上次的选择。

Suggested fixture level: compact - 独立的两个下拉控件，复用组 14 的提交路径与 options；无新的公共入口
Minimal mergeable slice: atomic - 两个控件共用一份提交与强度重算逻辑，拆开会留下半个不可验收的状态；测试与清单行同刀

## 16. web — 附件（输入框侧）

- [x] 16.1 状态：新文件 `web/src/features/chat/attachments-state.ts`（hook，不渲染 UI；登记 `MIGRATED_AREAS`）：标签列表与四种状态、统一的接收入口（每条消息的附件总数上限与单个大小上限，两句提示文字 `每条消息最多 <N> 个附件`、`「<文件名>」超过大小上限`）、串行上传队列与进度、移除（中止在途 / 撤掉排队 / 已上传不发请求）、清空（切换会话、回到欢迎态、换账号、卸载：在途的中止、排队的撤掉，迟到的结果不改界面）、从 fork / undo 响应恢复（覆盖已有标签）。它不导入 `use-chat-session.ts`；由后者创建并注入 `turn-actions.ts`（保持既有导入方向）。
  测试新文件 `web/test/chat-attachments-state.test.tsx`（hook 层 + 假 `uploadFile`）：队列的串行性、移除三种情形、限制两种情形（提示文字逐字）、清空时在途请求的 `signal` 被中止且排队项从未发出请求、迟到的上传结果不产生标签与错误。
  实施注记见 `implementation-notes.md`「16.1（#1031）」。
- [x] 16.2a 标签与菜单入口：新文件 `web/src/features/chat/attachment-chips.tsx`（登记）：附件区列表、每项的名字 / 大小 / 状态 / 进度条 / 移除按钮；`composer.tsx` 在文本框上方渲染它；「+」菜单加入 `上传文件` 项（隐藏的文件输入框、真实的禁用判定与原因文字，message-attachments「没有工作空间的会话」）。大小的格式化复用文件页既有的函数（先 grep `web/src/features/files/`，没有可复用的再在 `web/src/lib/` 加一个并让文件页也用它）。
  测试新文件 `web/test/chat-attachments.test.tsx`（整页挂载）：message-attachments「选择即上传」的标签部分、「数量与大小限制」「失败、移除与取消」「切换会话清空标签」「上传中切换会话」的已选会话一段、「未绑定会话没有上传目标」的菜单部分；chat-web delta「「+」菜单写入草稿」里「第一项是 `上传文件`」。
  实施注记见 `implementation-notes.md`「16.2a + 16.2c + 16.3（#1032）」。
- [ ] 16.2b 拖拽与粘贴：`composer.tsx` 接上拖拽（`data-drop-active`）与粘贴（只在剪贴板带文件时拦截），都交给 16.1 的统一入口。测试同文件：「拖入与粘贴」四例、「未绑定会话没有上传目标」的拖入与粘贴部分。
- [x] 16.2c 发送闸：有标签处于 `上传中` 或 `失败` 时 `发送` 禁用、Enter 不提交；启用条件改为「草稿非空，或至少有一个标签且全部处于可发送状态（已上传 / `待上传`）」（message-attachments「输入框附件标签」的**发送**一段、chat-web「输入框与能力栏」）。现有两道闸都要改，只改按钮会留下「按钮亮着、点了不发」：`web/src/features/chat/composer-locks.ts` 的 `sendDisabled`（现为 `draft.trim().length === 0`）与 `use-chat-session.ts` 提交入口对空白草稿的提前返回（`use-chat-session.ts:555` 一带）；判定写成一个纯函数，两处共用。
  测试同文件：「选择即上传」里上传期间与完成后的 `发送` 状态、「失败、移除与取消」里的 `发送` 状态（含「草稿为空白且已没有标签时仍禁用」）、「只有附件时可发送」的启用 / 禁用各段；`web/test/chat-composer.test.tsx`（或覆盖键盘发送的既有文件）：chat-web「输入框键盘发送」改写后的断言（没有附件标签的空草稿 Enter 不提交；带可发送附件的空白草稿 Enter 提交恰一次）。既有断言「空白草稿 `发送` 禁用」的用例在没有附件标签的前提下原样通过。chat-web「会话页」改写后的那一句（空白发送只在没有处于可发送状态的附件标签时禁用）由同一批断言钉住；覆盖「会话页」空白发送的既有整页用例（`web/test/chat-page-*.test.tsx` 里断言欢迎态与已选会话空白草稿不可发送的）核对其前提是「没有附件标签」，原样通过。
- [x] 16.3 发送：`turn-actions.ts`（431 行）的 prompt 派发带上已上传标签的 `path`；受理后清空标签并把附件放进页面自己呈现的那条用户消息；未受理时与草稿一起恢复。只发附件时 `message` 为原始草稿（空串或用户留下的空白），不在客户端裁剪或补字。测试同文件：「选择即上传」的 prompt body、「发送被拒时恢复」、「只有附件时可发送」的 prompt body 两例（`{"message":"","attachments":[…]}`；三个空格的草稿原样发出）与 409 后草稿仍为空、标签恢复一段。
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

- [x] 18.1 `smoke/session-meta.hurl`：chat-harness delta 列出的 options、档位修改与审计、最近选择继承、非法值 400，以及结束前把最近选择改回 `write`、把本步骤无 body 新建的会话 `DELETE` → 204（它用的是临时空间；C 的「冒烟与走查不留会话与临时空间」）。（`files.hurl` 与 `chat.hurl` 的附件部分已在 11.6、12.5 落下。）
  **实施注记（18.1，fixture 评审补充，#1038）**：
  - 只改 `smoke/session-meta.hurl`（现 457 行，改后约 560；`scripts/size-guard.sh` 只扫 ts/tsx/py，`scripts/test-ci-harness.sh` 只钉 Makefile 文件序与 AGENTS.md:89，都不读 hurl 内容）。新块「(3c) 输入框设置」插在第 193 行（取消置顶的最后一条断言）之后、第 195 行（(4) 的注释）之前，全程在 zhangsan（`u1`，成员）首次登录态内；(1)–(8) 不重编号，文首第 3–5 行流程注释与第 15–17 行前提同步补写。
  - 载体会话用 `{{session_id}}`（绑定 `smoke-sessions`，审计的 `workspaceId` 可断言为 `{{workspace_id}}`），且在 (4) 的 prompt 之前改回 `write`。本文件不对任何非 `write` 会话发 prompt，不断言进程行为：`supervisor.ts:487` 仍写死 `approvalMode: "write"`，#1009 合入后 (4) 派发时该会话有效档位就是 `write`，审批轮询不变。
  - 步骤 a：`GET /api/composer/options` → 200，body 逐字为 `{"approvalModes":["always-ask","write","yolo"],"models":[{"id":"deepseek-v4.1-flash","name":"deepseek-v4.1-flash","reasoning":true,"vision":false,"efforts":["off","minimal","low","medium","high","xhigh","max"],"defaultEffort":"high"}],"defaults":{"approvalMode":"write","modelId":"deepseek-v4.1-flash","reasoningEffort":"high"},"upload":{"maxBytes":524288000,"maxFiles":10}}`（键序见 `rest-composer.ts:45-60`）。请求不带任何 `?`，路由对任何 query 都回 400。整体字面量依赖 hurl 8.0.1 的 JSON body 比较方式，未实测；首跑若因字节差异判红，改成逐键 jsonpath（`$.*` count == 4、`approvalModes` count == 3 及三值、`models` count == 1 及六键、`defaults` 三键、`upload` 两键），不得只留规格点名的三条。
  - 步骤 b–c：`PATCH /api/sessions/{{session_id}} {"approvalMode":"yolo"}` → 200，`$.*` count == 14，`approvalMode == "yolo"`，`title == "冒烟会话"`、`scene == "design"`、`modelId` / `reasoningEffort` 不变。随后 `GET /api/audit?limit=2`：`events` count == 2；`[0]` 的 `kind == "session.permission"`、`title == "修改权限档位"`、`actorId == "u1"`、`workspaceId == "{{workspace_id}}"`、`detail.sessionId == "{{session_id}}"`、`detail.from == "write"`、`detail.to == "yolo"`；`[1].kind == "session.bind"` 且 `[1].detail.sessionId == "{{session_id}}"`（(1) 之后 u1 没有别的审计——(2) 的无 body 创建与 (3) 的 PATCH 都不写——这一条即「恰新增一条」，比 `files.hurl:75` 的 `body !=` 强）。捕获 `perm_audit_id: jsonpath "$.events[0].id"`。
  - 步骤 d：`GET /api/composer/options` → 200，`jsonpath "$.defaults.approvalMode" == "yolo"`（最近选择已记下）。
  - 步骤 e：无 body `POST /api/sessions` → 201，`$.*` count == 14，`approvalMode == "yolo"`、`temporaryWorkspace == true`、`scene == null`；捕获 `composer_id`、`composer_ws`。随后 `GET /api/audit?limit=2`：`[0]` 为 `session.permission`，`detail.sessionId == "{{composer_id}}"`、`detail.from == null`、`detail.to == "yolo"`、`workspaceId == "{{composer_ws}}"`；`[1].id == {{perm_audit_id}}`；捕获 `create_audit_id`。继承来的非缺省档在创建时写一条 `from:null`（session-permission-tier「创建时的审计」，`store-composer.ts:236-246`）；临时空间创建不写 `workspace.create`（`store-metadata.ts:437-441`）。
  - 步骤 f：`PATCH /api/sessions/{{session_id}} {"approvalMode":"auto"}` → 400，body `{"error":{"code":"bad_request","message":"请求格式不正确"}}`。只含 `approvalMode` 的 body 合法（`parsePatchBody` 只要求非空且键在七键内）；`auto` 在路由层只是字符串，由 `checkComposerInput` 在任何写入之前拒绝。
  - 步骤 g（恢复，紧跟 f，缩短 `yolo` 窗口）：`PATCH /api/sessions/{{session_id}} {"approvalMode":"write"}` → 200，`approvalMode == "write"`。`GET /api/audit?limit=2`：`[0]` 的 `detail.from == "yolo"`、`detail.to == "write"`、`detail.sessionId == "{{session_id}}"`；`[1].id == {{create_audit_id}}`（同时证明 f 的 400 没写审计）。再 `GET /api/composer/options` → body 与步骤 a 逐字相同。CI 每个 job 只跑一遍 `make smoke`（`ci-compiled-server.sh` 调一次 `make "$target"`），所以「已恢复」必须在本遍内由这条断言见证，不能留给第二遍。
  - 步骤 h：`DELETE /api/sessions/{{composer_id}}` → 204、`body == ""`；`GET /api/workspaces/{{composer_ws}}/tree` → 404 `{"error":{"code":"not_found","message":"请求的资源不存在"}}`。该会话以 `yolo` 出生、从未 prompt、未起进程即删。其后 (7) 的 `audit?limit=1` 仍成立：最新一条是 `session_id` 的 `session.delete`。
  - 重跑与跨文件状态：全程只动 u1 的 `account_composer_prefs`，且只动 `approval_mode` 一列；不要 PATCH `modelId` / `reasoningEffort`，否则三键缺省断言失去「NULL 取缺省」的含义。干净库首跑前无行，跑完为 `(write, NULL, NULL)`。第二遍里 chat.hurl:17 / :165 的无 body 创建与本文件 (1)(2) 继承原始 `write`：有效值相同，且 `creationAuditTo` 因有效档等于缺省档返回 null，不写审计，第 72–79 行「最新为 `session.bind`」照旧。lisi（`u3`）的行不碰。
  - CI 配置：`ci.yml` 的 smoke / ui-walk / uid-isolation 三个 job 与 `ci-compiled-server.sh` 都不设 `MODEL_CATALOG`、`MODEL_ID`、`MODEL_REASONING`、`APPROVAL_MAX_MODE`、`UPLOAD_MAX_*`，即上界 `yolo`、单模型、推理开、524288000 / 10，options 的 body 就是步骤 a 的字面量。三个 job 各用独立 `DB_PATH`，互不共享。uid-isolation 以 `OMP_USER=omp` 再跑一遍 `ci-compiled-server.sh smoke`（`ci-uid-isolation.sh:296`），本文件在那里也会执行一遍干净库路径。
  - 审计可见性：`core/audit/index.ts:72-106`——非管理员只见 `actor_id` 为自己的事件，管理员（lisi）见全部；`ORDER BY id DESC`（AUTOINCREMENT）；`limit` 为 1–200 的整数，缺省 50，越界 400。新断言全部在 zhangsan 登录态下，所以别的账号的事件插不进来；不要挪到 lisi 登录态。
  - 变异（均为预测，未运行）。判红：去掉 PATCH 的 `SET_COMPOSER` → 步骤 b；去掉 PATCH 的审计 emit、重复 emit 或 from/to 写反 → 步骤 c；PATCH 不调 `saveComposerPrefs` 或创建不读最近选择 → 步骤 e 的 `approvalMode`；options 的 `defaults` 不读最近选择 → 步骤 d；创建审计去掉 → 步骤 e 的审计（视图仍绿）；枚举校验去掉 → 步骤 f（预计撞迁移 040 的 CHECK 得 500）；临时空间不随末会话删除 → 步骤 h。HTTP 层保持绿：进程 argv 与 supervisor 的任何改动、`APPROVAL_MODES.slice` 封顶与超上界拒绝（缺省上界即 `yolo`）、审计用原始值而非有效值、审计与业务不同事务、`updated_at` 不更新、另一个非管理员账号看不到该事件——这些只有 server 单测能钉，写进 PR 的变异证据时照此如实标注。
  - 偏离记录：块的位置（(3) 与 (4) 之间）与载体会话的选择规格未定；步骤 d、步骤 e 的创建审计、步骤 g 的恢复审计与 options 复核是 delta 所列之外的加断言。既有断言一条不改不删。
- [x] 18.2 `smoke/chat.hurl`：`yolo` 会话的 bash 回合不经作答轮询到 `done`、`approvals` 为 `[]`；该会话与文件里的其它会话一样在退出登录前删除。`make smoke` 通过；AGENTS.md 验证矩阵里「五文件」的表述不变。
  **实施注记（18.2，fixture 评审补充，#1039）**：
  - 只改 `smoke/chat.hurl`（现 392 行，改后约 470；`size-guard.sh` 不扫 hurl，`scripts/test-ci-harness.sh` 只钉 Makefile 配方与 `AGENTS.md:89`）。AGENTS.md 不动：第 89 行「五文件」原样。不新增 Hurl 变量（`test-ci-harness.sh:122` 钉死 `--variable` 列表）。既有 (1)–(4) 的步骤、次序、断言、门控不变，唯一例外是下面点名的附件迁移。
  - 新块「(5) yolo 会话」插在 (4) 末尾轮询（现 :306-318）之后、zhangsan 首次登出（:320）之前，账号 zhangsan（`u1`）。块内每一步（含恢复与删除）都带 `[Options] skip: {{skip_turn_control}}`：`smoke-live` 只跑本文件且主规格场景「smoke-live 跳过回合控制」未被 delta 修改；创建被跳过即无污染。写进偏离记录。
  - 步骤 a（创建）：`POST /api/sessions`，`Content-Type: application/json`，body `{"approvalMode":"yolo"}` → 201；断言 `$.approvalMode == "yolo"`、`$.temporaryWorkspace == true`、`$.status == "idle"`；捕获 `yolo_session_id`、`yolo_workspace_id`。不存在不写最近选择的途径：创建（`store-metadata.ts:205`）与 PATCH（`:384`）都调 `saveComposerPrefs`；不用「无 body 创建再 PATCH」，多一步多一条审计。
  - 步骤 b（恢复最近选择，紧跟 a）：`PATCH /api/sessions/{{session_id}} {"approvalMode":"write"}` → 200，`$.approvalMode == "write"`；再 `GET /api/composer/options` → 200，`$.defaults.approvalMode == "write"`（本遍内见证，CI 每个 job 只跑一遍）。首会话有效档本就是 `write`，`resolvePatchComposer` 的 `from === to` 不写审计，但 `saveComposerPrefs` 在 UPDATE 之后无条件执行（`writePatch`）。yolo 会话自己的列仍是 `yolo`，派发只读会话列。
  - 步骤 b 选首会话而非 yolo 会话的理由：窗口只有一个请求，yolo 轮询即使判红也不把 `yolo` 留在持久库里。备选是回合结束后 `PATCH {{yolo_session_id}}` 回 `write`（多一条 `yolo→write` 审计、窗口约 90 秒）；两者都满足规格，取前者，写进偏离记录。
  - 步骤 c（bash 回合）：`POST /api/sessions/{{yolo_session_id}}/prompt {"message":"你好"}` → 202，捕获 `yolo_assistant_id`。受控上游在历史无 `role:"tool"` 时发 bash `echo workbuddy-smoke`（`fake-upstream.mjs:155-158`、`:421-429`）。不加审批轮询、不 POST approvals，直接照抄 :65-76 的 done 轮询（retry 180 / 500ms）并加一条 `jsonpath "$.messages[?(@.id=={{yolo_assistant_id}})].approvals" count == 0`。该写法在 `session-meta.hurl:396-407` 已用，数的是数组元素；不要改成 `== []`。
  - 步骤 c 的依据：design「实机核对结果」D2 (b) 与 `omp-official-approval-modes.test.ts:60` 的 `{mode:"yolo", tool:"bash", asks:false}`（仅 uid-isolation job 运行）；进程档位来自 `supervisor.ts:453-489`（#1009）。若 CI 里出现待决审批，是产品缺陷，停下报告，不加长重试。
  - 步骤 d（附件迁移，属本刀）：delta 写的是「在同一空间上传一个文件后带 `attachments` 发一条 prompt」，12.5 注记已登记「等 18.2 落地时迁过去」，本刀是 chat.hurl 的最后一刀。把 :279-291 的上传步骤迁来，目标改 `{{yolo_workspace_id}}`；随后 `POST …/{{yolo_session_id}}/prompt {"message":"你好","attachments":["{{attach_path}}"]}` → 202，捕获 `yolo_followup_user_id` / `yolo_followup_assistant_id`；轮询到 done，带 :316-318 的三条附件断言、正文匹配 `content_pattern`、该助手 `approvals` count == 0（历史已有 tool result，无工具轮）。
  - 第二会话的跟进 prompt 必须留下（主规格 `openspec/specs/chat-harness/spec.md:54` 要求它被受理并 done）：把 :293-318 还原成 #1019 之前的形态（`git show 3ec1fd1^1:smoke/chat.hurl` 的 278–298 行：body `{"message":"你好"}`、只捕获 `followup2_assistant_id`、三条断言），并删掉 :171 的 `session2_workspace_id` 捕获。附件断言是换载体不是删除，PR 偏离记录写明「了结 12.5 的偏离」。
  - 步骤 e（删除）：在 :373-378（删第二会话）之后、:380（末次登出）之前加 `DELETE /api/sessions/{{yolo_session_id}}` → 204、`body == ""`，同门控。文首 :1-5 流程注释同步补 (5)，并写明：在 a 与 b 之间失败的一遍会把 zhangsan 的最近选择留在 `yolo`，库若保留，下一遍本文件 :39-51 的审批轮询先判红；恢复办法是对自己任一会话 `PATCH {"approvalMode":"write"}` 或换新库。
  - 审计副作用（逐条核过，均仍成立）：本块只多一条 u1 的 `session.permission {from:null,to:"yolo"}`，删除时照旧一条 `workspace.delete`。`files.hurl:61-81` 与 `:136-159` 用文件内快照加 `body !=` 及本次请求字段，不受影响；该文件不建会话。`session-meta.hurl` 的 `limit=1` / `limit=2` 链都锚在它自己刚写的 `session.bind` 上，chat.hurl 的行全在其前。
  - 重跑与跨文件状态：跑完后 u1 的最近选择为 `(write,NULL,NULL)`，此后无 body 创建继承 `write`，`creationAuditTo` 返回 null 不写审计，`session-meta.hurl:73/:129` 与两处 options 字面量照旧。自本刀起该行在第一遍由 chat.hurl 建出（原先是 session-meta）。lisi 的行不碰。
  - 进程与其它 job：峰值存活进程 3 个（首会话、第二会话、yolo 会话；fork 只用临时进程），上限缺省 16（`agent-config.ts:17`），CI 不设 `OMP_MAX_PROCESSES` / `APPROVAL_MAX_MODE`；三个会话都在文件内 DELETE，进程随之退役。uid-isolation 以 `OMP_USER=omp` 再跑同一遍（`ci-uid-isolation.sh:297`），机制与既有回合相同。ui-walk 独立 `DB_PATH`，不受影响。
  - 变异（均为预测，未运行）。判红：spawn 的档位写死 `write`（`supervisor.ts:489` 或 `process.ts:100-101`）→ 步骤 c 的 `approvals count == 0`（60 秒自动允许后回合仍 done，但留一条审批，90 秒重试耗尽，不是 done 超时）；创建不落 `approval_mode` 列 → 步骤 a 的 `approvalMode`；PATCH 不调 `saveComposerPrefs` → 步骤 b 的 options；prompt 不落附件 → 步骤 d 的三条；DELETE 不删行 → 步骤 e。
  - 保持绿（如实写进 PR）：创建审计去掉、封顶夹取、#1009 的「档位不同则重启」（yolo 会话首次派发就是新进程，本文件不换档后再发）。「全程无审批」的完整证据是官方对照用例，冒烟只是旁证。
- [ ] 18.3 ui-walk：新 helper 文件 `web/e2e/ui-walk-composer.ts`，实现 chat-harness delta 的五个步骤，helper 在包住步骤的 `finally` 里删除它创建的会话（204 或 404 均接受）；由 `web/e2e/ui-walk.spec.ts`（594 行）调用。`ui-walk-sessions.spec.ts` 与 `ui-walk-layout.ts` 不加行。两种视口下通过；error oracle 生效。
- [ ] 18.4 判红证据：按 chat-harness delta「走查对旧实现判红」，本地临时去掉确认框与附件标签渲染各跑一次走查，记录第 2、4 步失败的输出到 PR 描述（不提交这两处临时改动）。
- [x] 18.5 `IMPLEMENTATION_PLAN.md` S1g 的 Verify 三条对照：各档位下审批是否出现（组 1 的对照用例 + 18.2）；上传的越界 / 超限全拒且入审计（组 11 + 11.6）；双账号互不可见（11.2、12.3、8.3 的隔离用例 + 11.6）。在 Epic 里逐条贴出对应的测试名与最近一次 CI 运行。

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
Minimal mergeable slice: 19.2 + 19.3 一刀（ADR-0013 增补与术语，可随时合入）；19.1 一刀（ADR-0012 补充，在组 1 的结论写入 design 之后）；19.4 一刀（在组 2、8、9、11、12、20 之后）；19.5 随组 17 之后

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
