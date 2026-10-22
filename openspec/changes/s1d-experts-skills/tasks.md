# Tasks: s1d-experts-skills

> 跟踪：Stage 5 在 Epic 下建子 issue，十个任务组各一个子 issue、各一个 PR。依赖（真实依赖，不串成线性链）：组 1 依赖 #1647（`server.ts` 启动阶段表：本组在 `state_layout` 阶段加启动清扫）与 #1648（`pool.ts` `sessionRuntimeOpts` 与 `supervisor.ts` 新准入：本组在其上加 `capabilities`）；组 2 依赖 `s1d-model-registry` 组 2（迁移 046，#1645）；组 3 依赖组 2、#1641（`forbidden`）与 #1649（启动记录八个模块、归属身份二十一条——本组在其上加一个模块、两条身份）；组 4 依赖组 3（同一启动模块列表与归属身份计数守卫，先后各加）；组 5 依赖组 4（归属身份计数守卫再加一；创建初值读组 2 的账号缺省）；组 6 依赖组 1、组 5 与 #1648（同改派发前对齐第 1 步与 slot 记录）；组 7 依赖组 3、组 4（专家表单的技能多选读 `GET /api/skills`，`api-skills.ts` 的 `listSkills` 在本组建）、#1643 与 #1651（真 tab 表与普通用户用例）；组 8 依赖组 4 与组 7（同一 `tabs.ts`、`api-skills.ts` 与中心用例）；组 9 依赖组 5 与组 7（`api-experts.ts` 与整页路由表的缺省应答）；组 10 依赖组 9（同一能力行、会话能力 hook 与路由表；`listSkills` 由组 7 建，组 9 已在组 7 之后）。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实，出入先改 design 再继续；产品代码单文件 ≤800 行，`use-chat-session.ts` 不改；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`，并跑 `web/test/functional-checklist.test.ts`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| omp 前提（第二个 `--config` 叠加、`--append-system-prompt` 读文件、`skill:<名>` 停用、`get_state.systemPrompt` 可观察） | 是 | 组 1 官方用例 |
| 两份真相（会话能力 vs 存活进程） | 是 | 组 6 指纹判据 |
| 越权（他人专家、内置专家写入、他人会话能力） | 是 | 组 3、组 5 的 401 / 400 / 403 / 404 矩阵 |
| 迁移与 DB 约束 | 是 | 组 2 |
| 文件泄漏与可读性（会话配置残留、提示词进日志 / 审计、omp uid 读不到会话配置文件） | 是 | 组 1 退出删除、启动清扫与 CI `uid-isolation`、组 3 审计 detail |
| 用户可见回归（`/center` 普通用户、能力行次序、斜杠候选、请求计数） | 是 | 组 7、组 9、组 10 |

## 1. 会话配置文件机制（omp-runtime「子进程 spawn 契约」「OMP_STATE_DIR 托管布局」+ omp-uid-isolation「Linux 隔离证明」+ omp-test-harness「假 omp probe 回报」）

- [ ] 1.1 核对 design Context：`process.ts` argv 段与子进程 exit 观察处、`spawn-env.ts:31`、`state-layout.ts` 的 `LAYOUT` 与 `ensureOmpStateLayout`、`server.ts` 的启动阶段表（#1647 合入后，`state_layout` 阶段）、`pool.ts` `sessionRuntimeOpts` 与 `supervisor.ts` 新准入（#1648 合入后）、`branch-temp.ts:99`、`server/src/core/replace-file.ts:12-26`；`server/test/support/fake-omp.mjs` 的 `probe:` / `rename:` 处理、`server/test/linux/uid-isolation.test.ts` 的托管布局用例、`.github/scripts/ci-uid-isolation.sh` 的官方用例清单与 `scripts/test-ci-harness.sh` 对它的断言；ADR-0010 的布局表；omp 源码的 `--config` 合并、`resolvePromptInput`、`skills.ts:216`、`system-prompt.ts:959-960`（design Context 所列行）。
- [ ] 1.2 测试先行：
  - 新 `server/test/omp-session-config.test.ts`：写出的 `.yml` 字节恰为一行 `disabledExtensions: [<JSON 字符串>, …]` 加换行（去重排序、空为 `[]`）；对抗名 `a: #"b` 的字节恰为 `disabledExtensions: ["skill:a: #\"b", …]` 且以 YAML 解析回原值；有提示词才有 `.md`；两文件 0640；两次调用 key 不同；`remove()` 删两文件且重复调用不抛。
  - `spawnOmp` argv 用例（假 omp 真子进程记录 argv；`fake-omp-argv` 忽略未知参数，官方用例的辅助只碰第一个 `--config`）：宿主 overlay `--config` 之后紧跟会话 `--config`；有提示词时其后 `--append-system-prompt <绝对路径>`；`--resume` 在最后；子进程以正常退出、`SIGKILL` 崩溃、握手失败、空闲回收、服务关停（`shutdown()`）结束后两文件都不在；fork 临时进程完成 `branch` 退出后其两文件不在、存活时内容等于源会话的有效能力；另一存活进程的文件在别的进程 spawn 与退出时字节不变；令 `.md` 写入失败 → 不 spawn、本次 `.yml` 不留下、以目录准备失败结束。
  - `state-layout` 与启动用例：`session-config/` 目录 `2710`、组规则同 `agent/`；每次 spawn 的 `ensureOmpStateLayout` 不清扫（存活进程的文件仍在）；`sweepSessionConfig` 清空残留，其中指向 `<state>` 之外文件的符号链接只删链接、目标字节不变；启动清扫删除失败 → 启动以 `state_layout` 失败（`server_start_failed` 记录）。
  - 同 PR 改断言 argv 尾部或托管目录清单的既有用例（本组 atomic 的原因）：`server/test/omp-spawn-dotenv-pins.test.ts:229-237`、`omp-process.test.ts:510-528`、`omp-spawn-cwd.test.ts:131-149`、`server-assembly.test.ts:745-762`（argv 尾部多 `--config <session-config/<key>.yml>`，按 `<key>` 通配比较）、`omp-state-layout.test.ts:143-149`（目录清单加 `session-config` / `2710`）；启动后状态根顶层的精确清单：`server/test/server-startup-order-helpers.ts:98`（`server-startup-failure-reason.test.ts`、`server-startup-preview.test.ts` 经它断言）、`server-startup-layout.test.ts:132-139`、`server-startup-order.test.ts:135-141`（各加 `session-config`）。
  - 新官方 omp 用例 `server/test/omp-official-session-config.test.ts`（`WORKBUDDY_OMP_TEST=1`，经代理到假上游，沿 `test/support/omp-official-proxied.ts`）：平台技能 `alpha` / `beta` 各带描述哨兵（SKILL.md 不带 `hide: true`；工具集含 `read`），会话配置停用 `skill:alpha`、提示词含 `EXPERT-SENTINEL-1` → 回合后经 RPC `get_state` 读 `systemPrompt`（`omp-official-overlay-pins.test.ts:186-196` 的 `readState` 先例），含 `beta` 哨兵与 `EXPERT-SENTINEL-1`、不含 `alpha` 哨兵；另一例停用列表为空且无提示词 → 两个哨兵都在、无专家哨兵。若 18.12.3 实测不列技能描述，按 design Risks「观察面」改观察面并同 PR 改 skill-switches 场景。
- [ ] 1.3 新 `server/src/sessions/omp/session-config.ts`（`writeSessionConfig` / `remove`，元素以 `JSON.stringify` 写出）；`spawnOmp` 接受 `capabilities: {disabledExtensions, appendSystemPrompt}`，argv 追加，子进程退出时 `remove()`；`state-layout.ts` 表加 `session-config/`（`2710`）、导出 `ompSessionConfigDir` 与独立的 `sweepSessionConfig(stateDir)`（不放进 `ensureOmpStateLayout`）；`server.ts` 的 `state_layout` 启动阶段在 `ensureOmpStateLayout` 之后调 `sweepSessionConfig`；`sessionRuntimeOpts` 必带 `capabilities`，本组两条 spawn 路径都传 `{disabledExtensions: [], appendSystemPrompt: null}`（真实能力由组 6 接入）。`process.ts` 超过 795 行即把 argv 组装抽到 `omp/argv.ts`。
- [ ] 1.4 omp uid 可读性（CI `uid-isolation`）：`server/test/support/fake-omp.mjs` 加 `read:<path>` → `read=<ok|errno>` 与 `list:<path>` → `listed=<ok|errno>`（不回报内容），`server/test/fake-omp.test.ts` 加 omp-test-harness「读取与列举探针」场景；`server/test/linux/uid-isolation.test.ts` 的托管布局用例加 `session-config/`：omp uid `read:` 会话 `.yml` 与测试另放的 `.md` 为 `ok`、`list:` 该目录 `EACCES`、`probe:` 新建 `EACCES`、`rename:` 该 `.yml` `EACCES`，父进程断言字节不变（omp-uid-isolation「会话配置目录只可按路径读取」；其负向对照沿用该 requirement 既有 `agent` 目录 `2770` 负向对照的做法——变异 `ensureOmpStateLayout` 的表值后断言失败）；`.github/scripts/ci-uid-isolation.sh` 的官方用例清单加 `test/omp-official-session-config.test.ts`，`scripts/test-ci-harness.sh` 的期望同 PR 改；PR CI `uid-isolation`（`.github/workflows/ci.yml`）绿。
- [ ] 1.5 `docs/architecture/system.md` 托管布局表加 `session-config/`（`2710`、启动清扫）、spawn 参数段加两项与「有专家时项目层 `APPEND_SYSTEM.md` 不生效」；ADR-0010 的布局表加 `session-config/` 一行（`2710`，组只有执行位、omp uid 按路径读）。

Suggested fixture level: expanded - 改每一次 omp spawn 的 argv、托管布局与服务启动阶段（Critical Path「omp 子进程治理」+ production config 触发项），以官方二进制钉住三个未实测前提，并在 CI `uid-isolation` 证明 omp uid 对新目录的读权限。
Minimal mergeable slice: atomic - 写出器、argv 追加与退出删除是同一份文件的写、用、删：只写不删即泄漏，只加 argv 不写文件 omp 硬错误退出；1.2 列出的既有 argv / 布局用例随 argv 尾部与顶层目录同 PR 改，否则守卫红；`2710` 与 omp uid 读证明同 PR，否则 omp uid 读不到提示词文件时会把路径字面当提示词静默注入；官方前提用例与机制同 PR 否则前提未钉。

## 2. 迁移 047 与专家 / 技能 store（experts「迁移 047」「内置专家」「专家校验与可见性」的 store 部分；skill-switches 的账号缺省与会话两列的 store 部分）

- [ ] 2.1 核对 Context：`server/src/core/db/migrations/` 最后一个迁移（`s1d-model-registry` 合入后为 046）、`server/test/core-db-helpers.ts` 的迁移常量、`chat_sessions` 列（040）、`account_composer_prefs`（041）的写法。
- [ ] 2.2 测试先行：新 `server/test/experts-store.test.ts`（`:memory:` + 真实迁移）：迁移 047 的表、CHECK、级联删除、两列缺省（既有会话读出 NULL / `[]`）；内置四位的 id、次序、`prompt` 码点 300..1500、`skills` 为 `[]`；`create` / `update` / `remove` 与「字段边界」场景的每一类 400 及 8000 码点 `prompt` 的正例；第 51 个 400；可见性（他人专家与不存在同为 `undefined`）；`remove` 同事务清空会话引用；`tags` 去重保序、`skills` 去重排序；`account_skill_prefs` 读写与缺省；会话两列的读写函数（`disabledSkills` 去重排序）。`MIGRATION_047` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 2.3 `047_experts_skills.sql` 按 design D2；`core-db-helpers.ts` 加常量。
- [ ] 2.4 新 `server/src/experts/builtin.ts`（四位内置专家，提示词按 design D3 真实撰写）、`server/src/experts/store.ts`（校验、可见性、CRUD、清空会话引用）、`server/src/skills/store.ts`（账号缺省读写、技能名校验）；会话两列的读写放进既有 sessions store（新文件 `store-capabilities.ts`）。

Suggested fixture level: expanded - 新迁移（persisted schema）与 `chat_sessions` 加列。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者；三处 store 共用同一份技能名校验与同一迁移，拆开只剩无行为的表。

## 3. 专家端点与审计（experts「专家管理端点」+ http-service-skeleton 的 `experts` 模块与两条归属身份）

- [ ] 3.1 核对 Context：`http/errors.ts` 归属集、`http-parser-owners.test.ts` 身份清单（#1649 合入后二十一条）、`server-assembly.test.ts` 与启动用例的模块列表（#1649 合入后八个）、`/api/models` 在 preParsing 里先判管理员与 `id` 的做法、`core/roles` 与 `forbidden` 码（#1641）、`core/audit` 的 `emit`。
- [ ] 3.2 测试先行：新 `server/test/experts-rest.test.ts`（整体挂载）：判定次序 401 → `PUT` / `DELETE` 的 `id` 缺失 / 空 / 多值 400 → 内置 id 的 `PUT` / `DELETE` 403 且无审计 → 他人与不存在 404 → content-parser / 键集 / 「字段边界」400，其中 401、`id` 的 400、403、404 各带 malformed body 一例仍得到同一结果（先于 body 解析）；8000 个 CJK 码点的 `prompt`（body 约 24 KiB）`POST` 201、`PUT` 200，超过 64 KiB 的 body 400；201 / 200 / 204；`GET` 次序（内置在前）；删除清空引用它的会话（能力 `expertId` 为 null）；三种审计 kind 与 detail 不含提示词；每类应答 no-store；http-service-skeleton「专家、技能与会话能力的归属路由」的专家部分；启动记录模块数加一（`experts`）、归属身份二十一 → 二十三。
- [ ] 3.3 新 `server/src/experts/rest.ts`（两个带 body 的路由 body limit 64 KiB；401 / `id` / 403 / 404 在 preParsing 判定）；`app.ts` 注册模块 `experts`；`http/errors.ts` 归属集加两条身份；`server.ts` `STARTUP_MODULES` 加 `experts`；三处模块列表断言与身份清单同步。
- [ ] 3.4 `docs/architecture/system.md` 加「专家与技能」一节的专家端点、判定次序与审计 kind。

Suggested fixture level: expanded - 新的按属主授权的写端点（authorization 触发项）。
Minimal mergeable slice: atomic - 四个方法共用同一套 401 / 400 / 403 / 404 / 键集 / 审计骨架与一个整体挂载用例文件；归属集与模块记录的改动必须与路由同 PR，否则守卫红。

## 4. 技能端点（skill-switches「技能清单与账号缺省」+ http-service-skeleton 的 `skills` 模块与一条归属身份）

- [ ] 4.1 核对 Context：`slash-commands.ts` `listSkills` 与 `/api/commands` 的平台技能次序、归属集（组 3 合入后二十三条）。
- [ ] 4.2 测试先行：新 `server/test/skills-rest.test.ts`（临时 agent 目录放两个平台技能）：`GET` 的 `{skills, disabledSkills}` 与 `enabledByDefault`；列表外的停用名称（未安装的 `ghost`、只作为项目技能存在的名称）出现在 `disabledSkills`、不出现在 `skills`；没有偏好行时 `disabledSkills` 为 `[]`；`PUT /api/skills/defaults` 键集严格、上限 128、名称规则 400、不要求已安装、整体替换；`PUT` 的应答与随后 `GET` 相同，`account_skill_prefs` 行一致（「缺省停用」场景的会话创建部分归组 5）；no-store；content-parser 400；启动记录模块数加一（`skills`）、归属身份二十三 → 二十四。
- [ ] 4.3 新 `server/src/skills/rest.ts`（`PUT /api/skills/defaults` body limit 64 KiB，http-service-skeleton「统一错误信封」）；`app.ts` 注册模块 `skills`（`agentDir` 注入）；归属集加一条身份；`STARTUP_MODULES` 加 `skills`。
- [ ] 4.4 `docs/architecture/system.md`「专家与技能」一节加技能端点（`{skills, disabledSkills}` 形状、账号缺省只影响新会话）。

Suggested fixture level: compact - 账号偏好的读写端点，无权限面差异（只读写自己的行）、不碰 omp。
Minimal mergeable slice: atomic - 一个读端点与一个写端点共用同一份清单与偏好，验证路径是同一个用例文件。

## 5. 会话能力（skill-switches「会话能力端点」+ session-metadata「会话创建与空间绑定」「fork 继承会话元数据」+ http-service-skeleton 的一条归属身份）

- [ ] 5.1 核对 Context：`rest-metadata.ts` 的 `CREATE_KEYS` 与创建流程、`PATCH /api/sessions/:id` 的 owner 预检先于 body 的写法、fork 的最终事务（chat-sessions「会话 REST」fork 段）、归档判定、`session_archived` 码。
- [ ] 5.2 测试先行：新 `server/test/session-capabilities.test.ts`：skill-switches「缺省停用」场景的会话部分（账号缺省停用后新建会话的初值、改缺省不影响已有会话）；`POST /api/sessions` 带 `expertId` / `disabledSkills` 的合法与 400（不可见专家、坏名称）；初值规则（body > 账号缺省 > `[]`；只要给了专家——不论是否同时给 `disabledSkills`——再去掉专家声明的技能：「创建时的专家与停用技能」第三例为 `[]`）；会话视图仍十四键；`GET` / `PUT …/capabilities` 的 owner 401 / 404（先于 body）、`{}` 与多余键 400、归档 409；「并集与清空」四步（第三步 `[]`、第四步只带 `disabledSkills` 才停用专家的技能）；`PUT` 与当前相同的值 200 且行不变；在途回合期间 `PUT` 200 且回合照常结束（supervisor 无动作）；fork 复制两列；`PUT /api/sessions/:id/capabilities` 的 content-parser 400（body limit 64 KiB）；归属身份二十四 → 二十五。
- [ ] 5.3 `POST /api/sessions` 的 body limit 由 16 KiB 改为 64 KiB（`rest-metadata.ts` 的共用常量拆开：`PATCH /api/sessions/:id` 保持 16 KiB，session-metadata「会话元数据修改」）、`PUT …/capabilities` 64 KiB（session-metadata「会话创建与空间绑定」、http-service-skeleton）；`rest-metadata.ts` 创建键与初值；新 `server/src/sessions/rest-capabilities.ts` 注册两个路由；fork 事务复制两列；归属集加一条身份。
- [ ] 5.4 `docs/architecture/system.md`「专家与技能」一节加会话能力端点与并集规则。

Suggested fixture level: expanded - 改会话创建的 body 契约与 fork 事务（persisted state + authorization）。
Minimal mergeable slice: atomic - 创建时的初值与端点的修改共用同一条并集规则与同一用例文件；fork 复制两列只有一行，单独成 PR 没有可验收行为。

## 6. 派发对齐接入会话能力（chat-sessions「派发前按会话设置对齐进程」；experts「专家提示词注入」）

- [ ] 6.1 核对 Context：`supervisor.ts` `#onSlot` / `#onNewSlot`、`composer-align.ts` `reusable()`（#1648 合入后的模型集合判据）、`pool.ts` `Slot` 字段、`store.runtimeState`、`branch-temp.ts` 的源会话读取、regenerate 的派发路径。
- [ ] 6.2 测试先行：`composer-align` 纯函数用例（指纹不同 → 不可复用；有无专家指纹不同）；新 `server/test/session-dispatch-capabilities.test.ts`（假 omp 真子进程）：设专家后下一条 prompt 退役重启、`stream_epoch` 加一、新 argv 带 `--append-system-prompt` 且文件内容为提示词；属主改该专家提示词 → 下一条再重启；改停用列表 → 重启且 yml 内容变化；什么都不改 → 复用；`PUT` 与当前相同的值（专家声明的技能为 `[]`）→ 下一条不 spawn；regenerate 同样按当前能力对齐（`PUT` 后 regenerate 的进程 argv 带新提示词文件）；在途回合期间 `PUT` 不打断回合、下一条才重启；删除使用中的专家（空闲与回合中各一例）→ 回合不受影响、下一条重启且 argv 无 `--append-system-prompt`；fork 临时进程用源会话能力；新官方 omp 用例 `server/test/omp-official-session-capabilities.test.ts`（`WORKBUDDY_OMP_TEST=1`）：experts「提示词进入系统提示词」场景（换专家后下一条的 `get_state.systemPrompt` 只含新哨兵），并加进 `.github/scripts/ci-uid-isolation.sh` 的官方用例清单（`scripts/test-ci-harness.sh` 同 PR 改）。
- [ ] 6.3 supervisor 每次派发（prompt 与 regenerate）由会话行算有效能力（专家可见性经组 2 store）交给 `sessionRuntimeOpts`；slot 记指纹；`reusable()` 加判据；branch-temp 传源会话能力。`supervisor.ts` 超过 800 行即把新准入参数组装移进 `pool.ts`。
- [ ] 6.4 `docs/architecture/system.md`「专家与技能」一节加能力指纹判据（改专家、改提示词、删专家、改停用列表都在下一条消息重启生效）。

Suggested fixture level: expanded - 改派发路径的重启判据（Critical Path「omp 子进程治理」）。
Minimal mergeable slice: atomic - 能力传入 spawn 与指纹判据是同一条判断的写与读：只传不判则改专家后存活进程永远不重启，只判不传则重启后能力仍为空；官方用例是 Verify 行「系统提示词变化可观察」的凭据。

## 7. 中心「专家」tab（experts「中心「专家」tab」+ model-registry「中心页外壳」+ 验收 SH-01、CM-04、新 CE 节）

- [ ] 7.1 核对 Context：`features/center/{page.tsx,tabs.ts}` 与 `center-page.test.tsx`（#1643）、`center-models*.test.tsx` 的普通用户用例（#1651）、#1643 改过的六处经路由打开 `/center` 的用例、`web/test/support.ts` 的整页路由表、`e2e/ui-walk-layout.ts` 的 `/center` 分支、`routes/manifest.ts`、拷入层（`select` 是否已由 #1651 拷入）。
- [ ] 7.2 测试先行：新 `web/test/center-experts*.test.tsx`（假 `ApiClient`）：分类 chip、搜索、`没有匹配的专家`、内置卡无 `编辑` / `删除`、新建 / 编辑 / 删除各恰一次调用且成功后恰一次 `listExperts`、客户端校验文案、Escape 回退、`开始会话` 的 navigate state；表单的技能多选（选项取自 `listSkills` 的 `skills`、提交的 `skills` 为所选名称、`listSkills` 失败时多选为空且仍可提交）；`api-experts.ts` 严格解析与 `id` 编码、`api-skills.ts` 的 `listSkills` 严格解析 `{skills, disabledSkills}`；`center-page.test.tsx` 与 `center-models*.test.tsx` 改真表（管理员裸 `/center` → `?tab=experts`；普通用户 `?tab=models` → replace 为 `?tab=experts`）——本组只追加 `experts` 一项，`技能` 项由组 8 追加，所以本组断言普通用户 tab 条恰为 `专家`；#1643 的六处空态断言改为断言 `专家` tab 选中：`web/test/topbar.test.tsx`、`chat-page-session-meta-support.tsx`（`leaveChatPage`）、`chat-fork-button.test.tsx`、`chat-stop-button.test.tsx`、`chat-undo.test.tsx`、`chat-regenerate-button.test.tsx`；各套件路由表经共享辅助（`web/test/support.ts` 现有 `composerOptionsRoute()` 的同一写法，新增辅助并在各表展开）加缺省应答 `/api/experts`（`{experts: []}`）与 `/api/skills`（`{skills: [], disabledSkills: []}`）；`e2e/ui-walk-layout.ts` 的 `/center` 分支改为断言 `专家` tab 选中与内置卡可见；routeManifest 描述 `专家`。
- [ ] 7.3 新 `web/src/lib/api-experts.ts` 与 `web/src/lib/api-skills.ts`（本组只有 `listSkills`）+ `api.ts` 导出；`web/src/features/center/experts/{list.tsx,form-dialog.tsx,use-experts.ts}`；`tabs.ts` 在 `models` 之前插入 `{experts, 专家, adminOnly:false}`；`routes/manifest.ts` 描述改 `专家`；欢迎态读取 `location.state.expertId` 的入口留给组 9（本组只发出 navigate）。
- [ ] 7.4 验收清单：SH-01 改为「以成员账号登录，中心页显示『专家』tab」、CM-04 改为普通用户不见 `模型` tab（打开 `?tab=models` 落到 `专家`）；新增「中心·专家（CE）」CE-01 浏览与分类、CE-02 搜索、CE-03 新建 / 编辑 / 删除自建专家、CE-04 内置专家不可改（`开始会话` 的 CE 行在组 9 加，带入效果在那里才可见）；结论 `待签`；`IMPLEMENTATION_PLAN.md` F-CTR-EXP 行指向本 change；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 前端页面，权限由服务端端点（组 3）钉住，可见变化限于中心页。
Minimal mergeable slice: atomic - 列表、表单（含读技能清单的多选）、删除与 API 客户端是同一个 tab 的一条组件用例路径；追加 tab 项没有面板就是占位（规格禁止），而追加后普通用户的既有用例、#1643 的六处断言、整页路由表与 e2e 必须同 PR 改。

## 8. 中心「技能」tab（skill-switches「中心「技能」tab」+ 验收 CS 节）

- [ ] 8.1 核对 Context：组 7 合入后的 `tabs.ts`、`api-skills.ts` 与中心用例；拷入层是否有 `switch`。
- [ ] 8.2 测试先行：新 `web/test/center-skills.test.tsx`：列表与开关初值（名称不在 `disabledSkills` 里即开）、切换恰一次 `putSkillDefaults` 且 body 为完整停用列表（`disabledSkills` 含列表外的 `ghost` 时它仍在 body 里）、成功后以应答替换、在途禁用、500 回滚与提示、空态 `尚未安装平台技能`；`putSkillDefaults` 严格解析；中心用例里普通用户 tab 条改为 `专家`、`技能`；routeManifest 描述 `专家与技能`。
- [ ] 8.3 `switch` 不存在则拷入（组 10 先合入时已有）；`api-skills.ts` 加 `putSkillDefaults`（`listSkills` 已由组 7 建）+ `api.ts` 导出；`web/src/features/center/skills/{list.tsx,use-skills.ts}`；`tabs.ts` 在 `experts` 之后插入 `{skills, 技能, adminOnly:false}`；`routes/manifest.ts` 描述改 `专家与技能`。
- [ ] 8.4 验收清单新增「中心·技能（CS）」CS-01 列出平台技能、CS-02 关闭默认启用后新会话该技能停用、CS-03 已有会话不受影响；结论 `待签`；`IMPLEMENTATION_PLAN.md` F-CTR-SKL 行指向本 change；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 账号偏好开关页，无凭证、无权限面差异。
Minimal mergeable slice: atomic - 列表、开关与写方法是同一 tab 的一条用例路径；tab 项、routeManifest 描述与普通用户 tab 条断言同 PR 改。

## 9. 输入框的专家（experts「输入框的专家选择」+ chat-web「输入框与能力栏」+ session-sidebar 三条 + session-permission-tier「权限档位控件」+ F-CHAT-1 / F-CHAT-11c）

- [ ] 9.1 核对 Context：`capability-bar.tsx` 的「+」菜单与左组次序、`welcome-options.ts` `createBody()`、`use-chat-session.ts:550` 的 `picked` 缓存失效、`page.tsx:50` `useSlashMenu`、`api.ts` `ChatSessionCreateInput`、`session-actions.ts` 的请求写法、`conversation-view.tsx` props、`web/test/support.ts` 的路由表、CH-11 / CH-66 两行。
- [ ] 9.2 测试先行：新 `web/test/chat-expert-picker.test.tsx`：「+」菜单 `选择专家…` 的位置与生成中禁用；专家对话框（搜索、`不使用专家`、分组、打开时重取 `listExperts`）；能力行 `专家 · <名称>` 标签与 `移除专家`、次序（`+`、专家、工作空间、权限）；标签名称来自 `listExperts`、清单未取得或失败时只显示 `专家`、每个 client 恰一次 `listExperts`；欢迎态选专家后首次发送 body 含 `expertId`、不选不含；只选专家（不动档位 / 模型 / 强度）的首次发送之后没有第二次 `getComposerOptions`（欢迎态选择不进 `picked`）；中心 `开始会话` 带入的 state 只读一次（刷新或回到欢迎态不再带）；会话中换专家恰一次 `PUT …/capabilities`、失败显示错误并保留原标签；选中的会话 id 每变化一次恰一次 `GET …/capabilities`（同一会话发消息不重取）；新 `api-session-capabilities.ts` 严格解析；`web/test/support.ts` 加按路径匹配的缺省应答 `/api/sessions/<id>/capabilities`（`{expertId: null, disabledSkills: []}`）；改既有用例：`web/test/chat-page-plus-menu.test.tsx`（:140、:159、:162-166、:199，以及按下标或拼接文本断言菜单条目的其余各处——:197-198、:227、:239、:249-250、:257、:278-279、:286、:298-299、:307、:362、:401、:437、:443——菜单多一项 `选择专家…`）与断言「没有专家」的用例；逐个复核会因新读取改变计数的用例：`chat-archive.test.tsx:472`、`chat-page-session-delete.test.tsx:160/531/592`、`chat-page-search.test.tsx:146/167`、`chat-list-events.test.tsx:288`、`chat-page-new-session-wiring.test.tsx:51`、`chat-attachments-first-send.test.tsx:115`、`chat-page-first-send-rejected.test.tsx:256`、`chat-page-slash-support.tsx:222`。
- [ ] 9.3 新 `web/src/lib/api-session-capabilities.ts`；新 `web/src/features/chat/expert-picker.tsx`（对话框）与 `use-session-capabilities.ts`（会话中的 GET / PUT、按会话 id 变化取一次、欢迎态选择与专家清单缓存）；`capability-bar.tsx` 加菜单项与标签；`welcome-options.ts` 的 `createBody()` 带 `expertId`（专家选择存在自己的状态里，不进 `picked`）；`api.ts` 的 `ChatSessionCreateInput` 加 `expertId?`、`disabledSkills?`；`web/src/features/chat/page.tsx` 与 `conversation-view.tsx` props 链。不改 `use-chat-session.ts`。
- [ ] 9.4 验收清单：CH-11 去掉「菜单里没有专家」并加 `选择专家…` 一项的描述、CH-66 的能力行次序加专家标签并去掉「没有专家」；新增 CH 行「欢迎态选专家发送、会话中换专家，下一条回答体现新角色」与 CE 行「中心专家卡 `开始会话` 回到欢迎态并带入该专家」；`IMPLEMENTATION_PLAN.md` F-CHAT-1 行注明「场景决定默认专家」已作废（s1d-experts-skills）、F-CHAT-11 行注明 11c 已交付；结论 `待签`；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 会话页控件与一次 REST 调用，服务端契约由组 5 钉住。
Minimal mergeable slice: atomic - 菜单项、对话框、标签与欢迎态 body 是同一个可见行为（选专家）的一条组件用例路径；会话能力 hook 与路由表缺省应答是本组与组 10 共用的基础，先在本组落地，计数类既有用例随新读取同 PR 复核。

## 10. 输入框「能力」弹层（skill-switches「输入框「能力」弹层」「停用技能对 omp 生效」的客户端过滤 + chat-web「输入框与能力栏」）

- [ ] 10.1 核对 Context：拷入层是否已有 `switch`（组 8 先合入则已有，否则本组拷入）；组 9 合入后的 `capability-bar.tsx` 与 `use-session-capabilities.ts`、`slash-menu.tsx` 的候选来源与 `page.tsx:50` `useSlashMenu`、「+」菜单命令段的来源（`/api/commands`）、`web/test/chat-capability-bar.test.tsx:274-283`、`web/e2e/ui-walk-composer.ts:69-78`。
- [ ] 10.2 测试先行：新 `web/test/chat-capability-popover.test.tsx`：`能力` 按钮位置（权限档位之后）；弹层列出平台与项目技能（项目标记保留，`overrides` 为真时 `项目 · 覆盖平台技能`）；开关初值对平台与项目技能同一规则——名称不在当前停用集合里（欢迎态取 `GET /api/skills` 的 `disabledSkills`，会话中取能力的 `disabledSkills`），含 `overrides` 项目技能的一例；欢迎态第一次打开弹层恰一次 `GET /api/skills`，之后不再取；切换恰一次 `PUT` 且 body 为完整集合（含不在弹层列表里的停用名称）、失败回滚、`暂无可用技能`、底部说明；skill-switches「欢迎态读取账号缺省之前不可切换」（挂起禁用、失败提示、重开重取一次）；欢迎态动过开关才在 `POST /api/sessions` 带 `disabledSkills`（「欢迎态带初值」场景）；斜杠候选与「+」菜单不列停用技能（「会话中停用技能」场景）；改既有用例：`web/test/chat-capability-bar.test.tsx:274-283`（左组多 `能力`）与同文件 `expectOrder` 辅助（:118-124，7 个调用者）、`web/test/chat-page-welcome-scene.test.tsx:299-305`（左组按钮的精确列表）、`web/e2e/ui-walk-composer.ts:69-78`（`rowControls` 加 `能力`，有专家时加专家标签）；复核组 9 列出的计数类用例；`make ui-walk` 通过。
- [ ] 10.3 新 `web/src/features/chat/capability-popover.tsx`；`capability-bar.tsx` 加按钮；`use-session-capabilities.ts` 加停用集合与欢迎态的账号缺省读取；`slash-menu.tsx`、`web/src/features/chat/page.tsx`（`useSlashMenu` 的输入）与「+」菜单命令段按停用集合过滤；`welcome-options.ts` 带 `disabledSkills`；`api.ts` 的 `ChatSessionCreateInput` 已由组 9 加键，本组只用。
- [ ] 10.4 验收清单 CH-66 能力行次序加 `能力`；新增 CH 行「会话中关掉一个技能，斜杠候选里消失，下一条回答不再使用它」；结论 `待签`；`web/test/functional-checklist.test.ts` 通过；`make ui-walk` 通过；`docs/architecture/system.md`「专家与技能」一节补弹层。

Suggested fixture level: compact - 会话页控件与一次 REST 调用；omp 侧效果由组 1、组 6 的官方用例钉住。
Minimal mergeable slice: atomic - 弹层开关与候选过滤读同一个停用集合，拆开则候选列着已停用、omp 不加载的技能；能力行多一个控件后既有次序用例与 ui-walk 的控件表必须同 PR 改。
