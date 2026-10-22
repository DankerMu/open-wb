# Tasks: s1d-experts-skills

> 跟踪：Stage 5 在 Epic 下建子 issue，十个任务组各一个子 issue、各一个 PR。依赖（真实依赖，不串成线性链）：组 1 独立（会话配置文件机制，所有 spawn 先写空能力）；组 2 依赖 `s1d-model-registry` 组 2（迁移 046，#1645）；组 3 依赖组 2、#1641（`forbidden`）与 #1649（启动记录八个模块、归属身份清单——本组在其上加一）；组 4 依赖组 3（同一启动模块列表与归属身份计数守卫，先后各加一）；组 5 依赖组 4（归属身份计数守卫再加一；创建初值读组 2 的账号缺省）；组 6 依赖组 1、组 5 与 #1648（同改派发前对齐第 1 步与 slot 记录）；组 7 依赖组 3、#1643 与 #1651（真 tab 表与普通用户用例）；组 8 依赖组 4 与组 7（同一 `tabs.ts` 与中心用例）；组 9 依赖组 5 与组 7（`api-experts.ts`）；组 10 依赖组 8（`api-skills.ts`）与组 9（同一能力行与会话能力 hook）。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实，出入先改 design 再继续；产品代码单文件 ≤800 行，`use-chat-session.ts` 不改；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| omp 前提（第二个 `--config` 叠加、`--append-system-prompt` 读文件、`skill:<名>` 停用、系统提示词可观察） | 是 | 组 1 官方用例 |
| 两份真相（会话能力 vs 存活进程） | 是 | 组 6 指纹判据 |
| 越权（他人专家、内置专家写入、他人会话能力） | 是 | 组 3、组 5 的 403 / 404 矩阵 |
| 迁移与 DB 约束 | 是 | 组 2 |
| 文件泄漏（会话配置残留、提示词进日志 / 审计） | 是 | 组 1 退出删除与启动清扫、组 3 审计 detail |
| 用户可见回归（`/center` 普通用户、能力行次序、斜杠候选） | 是 | 组 7、组 9、组 10 |

## 1. 会话配置文件机制（omp-runtime「子进程 spawn 契约」「OMP_STATE_DIR 托管布局」）

- [ ] 1.1 核对 design Context：`process.ts` argv 段与子进程 exit 观察处、`spawn-env.ts:31`、`state-layout.ts` 的 `LAYOUT` 与 `ensureOmpStateLayout`、`pool.ts:222` `sessionRuntimeOpts`、`branch-temp.ts:99`、`replace-file.ts`；omp 源码的 `--config` 合并与 `resolvePromptInput`（design Context 所列行）。
- [ ] 1.2 测试先行：新 `server/test/omp-session-config.test.ts`（写出内容：`disabledExtensions` 去重排序、空为 `[]`、有提示词才有 `.md`、0640、两次调用 key 不同、`remove()` 删两文件且重复调用不抛）；`spawnOmp` argv 用例（假 omp 记录 argv：宿主 overlay `--config` 之后紧跟会话 `--config`；有提示词时其后 `--append-system-prompt <绝对路径>`；`--resume` 在最后；子进程正常退出、崩溃、握手失败三种退出后两文件都不在）；`state-layout` 用例（`session-config/` 目录 2750 / 组规则同 `agent/`；启动时残留文件被清空）；新官方 omp 用例 `server/test/omp-official-session-config.test.ts`（`WORKBUDDY_OMP_TEST=1`，经代理到假上游，沿 `test/support/omp-official-proxied.ts`）：平台技能 `alpha` / `beta` 各带描述哨兵，会话配置停用 `skill:alpha`、提示词含 `EXPERT-SENTINEL-1` → 假上游收到的请求系统消息含 `beta` 哨兵与 `EXPERT-SENTINEL-1`、不含 `alpha` 哨兵；另一例停用列表为空且无提示词 → 两个哨兵都在、无专家哨兵。若 18.12.3 不把技能描述放进系统提示词，按 design Risks 改观察面并同 PR 改 skill-switches 场景。
- [ ] 1.3 新 `server/src/sessions/omp/session-config.ts`（`writeSessionConfig` / `remove`）；`spawnOmp` 接受 `capabilities: {disabledExtensions, appendSystemPrompt}`，argv 追加，子进程退出时 `remove()`；`state-layout.ts` 建目录并清扫；`sessionRuntimeOpts` 必带 `capabilities`，本组两条 spawn 路径都传 `{disabledExtensions: [], appendSystemPrompt: null}`（真实能力由组 6 接入）。`process.ts` 超过 795 行即把 argv 组装抽到 `omp/argv.ts`。
- [ ] 1.4 `docs/architecture/system.md` 托管布局表加 `session-config/`、spawn 参数段加两项与「有专家时项目层 `APPEND_SYSTEM.md` 不生效」。

Suggested fixture level: expanded - 改每一次 omp spawn 的 argv 与托管布局（Critical Path「omp 子进程治理」+ production config 触发项），并以官方二进制钉住三个未实测前提。
Minimal mergeable slice: atomic - 写出器、argv 追加与退出删除是同一份文件的写、用、删：只写不删即泄漏，只加 argv 不写文件 omp 硬错误退出；官方前提用例与机制同 PR 否则前提未钉。

## 2. 迁移 047 与专家 / 技能 store（experts「迁移 047」「内置专家」「专家校验与可见性」的 store 部分；skill-switches 的账号缺省与会话两列的 store 部分）

- [ ] 2.1 核对 Context：`server/src/core/db/migrations/` 最后一个迁移（`s1d-model-registry` 合入后为 046）、`server/test/core-db-helpers.ts` 的迁移常量、`chat_sessions` 列（040）、`account_composer_prefs`（041）的写法。
- [ ] 2.2 测试先行：新 `server/test/experts-store.test.ts`（`:memory:` + 真实迁移）：迁移 047 的表、CHECK、级联删除、两列缺省（既有会话读出 NULL / `[]`）；内置四位的 id、次序、`prompt` 码点 300..1500、`skills` 为 `[]`；`create` / `update` / `remove` 与「字段边界」场景的每一类 400；第 51 个 400；可见性（他人专家与不存在同为 `undefined`）；`remove` 同事务清空会话引用；`tags` 去重保序、`skills` 去重排序；`account_skill_prefs` 读写与缺省；会话两列的读写函数（`disabledSkills` 去重排序）。`MIGRATION_047` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 2.3 `047_experts_skills.sql` 按 design D2；`core-db-helpers.ts` 加常量。
- [ ] 2.4 新 `server/src/experts/builtin.ts`（四位内置专家，提示词按 design D3 真实撰写）、`server/src/experts/store.ts`（校验、可见性、CRUD、清空会话引用）、`server/src/skills/store.ts`（账号缺省读写、技能名校验）；会话两列的读写放进既有 sessions store（新文件 `store-capabilities.ts`）。

Suggested fixture level: expanded - 新迁移（persisted schema）与 `chat_sessions` 加列。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者；三处 store 共用同一份技能名校验与同一迁移，拆开只剩无行为的表。

## 3. 专家端点与审计（experts「专家管理端点」）

- [ ] 3.1 核对 Context：`http/errors.ts` 归属集、`http-parser-owners.test.ts` 身份清单、`server-assembly.test.ts` 与启动用例的模块列表（`s1d-model-registry` 组 7 合入后为八个）、`core/roles` 与 `forbidden` 码（#1641）、`core/audit` 的 `emit`。
- [ ] 3.2 测试先行：新 `server/test/experts-rest.test.ts`（整体挂载）：未认证 401；内置 id 的 `PUT` / `DELETE`（合法与不合法 body）403 且无审计；`id` 缺失 / 空 / 多值 400；他人与不存在 404；键集严格与「字段边界」400；201 / 200 / 204；`GET` 次序（内置在前）；删除清空引用它的会话（能力 `expertId` 为 null）；三种审计 kind 与 detail 不含提示词；每类应答 no-store；`POST /api/experts`、`PUT /api/experts` 的 content-parser 400；启动记录模块数加一（`experts`）。
- [ ] 3.3 新 `server/src/experts/rest.ts`；`app.ts` 注册模块 `experts`；`http/errors.ts` 归属集加两条身份；`server.ts` `STARTUP_MODULES` 加 `experts`；三处模块列表断言同步。
- [ ] 3.4 `docs/architecture/system.md` 加「专家与技能」一节的专家端点与审计 kind。

Suggested fixture level: expanded - 新的按属主授权的写端点（authorization 触发项）。
Minimal mergeable slice: atomic - 四个方法共用同一套 401 / 403 / 404 / 键集 / 审计骨架与一个整体挂载用例文件；归属集与模块记录的改动必须与路由同 PR，否则守卫红。

## 4. 技能端点（skill-switches「技能清单与账号缺省」）

- [ ] 4.1 核对 Context：`slash-commands.ts` `listSkills` 与 `/api/commands` 的平台技能次序、归属集。
- [ ] 4.2 测试先行：新 `server/test/skills-rest.test.ts`（临时 agent 目录放两个平台技能）：`GET` 列表与 `enabledByDefault`；`PUT /api/skills/defaults` 键集严格、上限 128、名称规则 400、不要求已安装；`PUT` 后 `account_skill_prefs` 行与随后 `GET` 一致（「缺省停用」场景的会话创建部分归组 5）；no-store；content-parser 400；启动记录模块数加一（`skills`）。
- [ ] 4.3 新 `server/src/skills/rest.ts`；`app.ts` 注册模块 `skills`（`agentDir` 注入）；归属集加一条身份；`STARTUP_MODULES` 加 `skills`。

Suggested fixture level: compact - 账号偏好的读写端点，无权限面差异（只读写自己的行）、不碰 omp。
Minimal mergeable slice: atomic - 一个读端点与一个写端点共用同一份清单与偏好，验证路径是同一个用例文件。

## 5. 会话能力（skill-switches「会话能力端点」+ session-metadata「会话创建与空间绑定」「fork 继承会话元数据」）

- [ ] 5.1 核对 Context：`rest-metadata.ts` 的 `CREATE_KEYS` 与创建流程、fork 的最终事务（chat-sessions「会话 REST」fork 段）、归档判定、`session_archived` 码。
- [ ] 5.2 测试先行：新 `server/test/session-capabilities.test.ts`：skill-switches「缺省停用」场景的会话部分（账号缺省停用后新建会话的初值、改缺省不影响已有会话）；`POST /api/sessions` 带 `expertId` / `disabledSkills` 的合法与 400（不可见专家、坏名称）；初值规则（body > 账号缺省 > `[]`；给专家不给停用时去掉专家技能）；会话视图仍十四键；`GET` / `PUT …/capabilities` 的 owner 401 / 404、`{}` 与多余键 400、归档 409、并集与清空两场景；在途回合期间 `PUT` 200 且回合照常结束（supervisor 无动作）；fork 复制两列；`PUT /api/sessions/:id/capabilities` 的 content-parser 400。
- [ ] 5.3 `rest-metadata.ts` 创建键与初值；新 `server/src/sessions/rest-capabilities.ts` 注册两个路由；fork 事务复制两列；归属集加一条身份。

Suggested fixture level: expanded - 改会话创建的 body 契约与 fork 事务（persisted state + authorization）。
Minimal mergeable slice: atomic - 创建时的初值与端点的修改共用同一条并集规则与同一用例文件；fork 复制两列只有一行，单独成 PR 没有可验收行为。

## 6. 派发对齐接入会话能力（chat-sessions「派发前按会话设置对齐进程」；experts「专家提示词注入」）

- [ ] 6.1 核对 Context：`supervisor.ts` `#onSlot` / `#onNewSlot`、`composer-align.ts` `reusable()`（#1648 合入后的模型集合判据）、`pool.ts` `Slot` 字段、`store.runtimeState`、`branch-temp.ts` 的源会话读取。
- [ ] 6.2 测试先行：`composer-align` 纯函数用例（指纹不同 → 不可复用）；新 `server/test/session-dispatch-capabilities.test.ts`（假 omp 真子进程）：设专家后下一条 prompt 退役重启、`stream_epoch` 加一、新 argv 带 `--append-system-prompt` 且文件内容为提示词；属主改该专家提示词 → 下一条再重启；改停用列表 → 重启且 yml 内容变化；什么都不改 → 复用；在途回合期间 `PUT` 不打断回合、下一条才重启；fork 临时进程用源会话能力；官方 omp 用例（`WORKBUDDY_OMP_TEST=1`）：experts「提示词到达上游」场景（换专家后下一条上游请求只含新哨兵）。
- [ ] 6.3 supervisor 每次派发由会话行算有效能力（专家可见性经组 2 store）交给 `sessionRuntimeOpts`；slot 记指纹；`reusable()` 加判据；branch-temp 传源会话能力。`supervisor.ts` 超过 800 行即把新准入参数组装移进 `pool.ts`。

Suggested fixture level: expanded - 改派发路径的重启判据（Critical Path「omp 子进程治理」）。
Minimal mergeable slice: atomic - 能力传入 spawn 与指纹判据是同一条判断的写与读：只传不判则改专家后存活进程永远不重启，只判不传则重启后能力仍为空；官方用例是 Verify 行「系统提示词变化可观察」的凭据。

## 7. 中心「专家」tab（experts「中心「专家」tab」+ model-registry「中心页外壳」+ 验收 SH-01、CM-04、新 CE 节）

- [ ] 7.1 核对 Context：`features/center/{page.tsx,tabs.ts}` 与 `center-page.test.tsx`（#1643）、`center-models*.test.tsx` 的普通用户用例（#1651）、`e2e/ui-walk-layout.ts` 的 `/center` 分支、`routes/manifest.ts`、拷入层（`select` 是否已由 #1651 拷入）。
- [ ] 7.2 测试先行：新 `web/test/center-experts*.test.tsx`（假 `ApiClient`）：分类 chip、搜索、`没有匹配的专家`、内置卡无 `编辑` / `删除`、新建 / 编辑 / 删除各恰一次调用且成功后恰一次 `listExperts`、客户端校验文案、Escape 回退、`开始会话` 的 navigate state；`api-experts.ts` 严格解析与 `id` 编码；`center-page.test.tsx` 与 `center-models*.test.tsx` 改真表（管理员裸 `/center` → `?tab=experts`；普通用户 `?tab=models` → replace 为 `?tab=experts`，tab 条 `专家`、`技能`）——本组只追加 `experts` 一项，`技能` 项由组 8 追加，所以本组断言普通用户 tab 条恰为 `专家`；`e2e/ui-walk-layout.ts` 的 `/center` 分支改为断言 `专家` tab 选中与内置卡可见；routeManifest 描述 `专家与技能`。
- [ ] 7.3 新 `web/src/lib/api-experts.ts` + `api.ts` 导出；`web/src/features/center/experts/{list.tsx,form-dialog.tsx,use-experts.ts}`；`tabs.ts` 在 `models` 之前插入 `{experts, 专家, adminOnly:false}`；欢迎态读取 `location.state.expertId` 的入口留给组 9（本组只发出 navigate）。
- [ ] 7.4 验收清单：SH-01 改为「以成员账号登录，中心页显示『专家』tab」、CM-04 改为普通用户不见 `模型` tab（打开 `?tab=models` 落到 `专家`）；新增「中心·专家（CE）」CE-01 浏览与分类、CE-02 搜索、CE-03 新建 / 编辑 / 删除自建专家、CE-04 内置专家不可改；结论 `待签`；`IMPLEMENTATION_PLAN.md` F-CTR-EXP 行指向本 change；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 前端页面，权限由服务端端点（组 3）钉住，可见变化限于中心页。
Minimal mergeable slice: atomic - 列表、表单、删除与 API 客户端是同一个 tab 的一条组件用例路径；追加 tab 项没有面板就是占位（规格禁止），而追加后普通用户的既有用例与 e2e 必须同 PR 改。

## 8. 中心「技能」tab（skill-switches「中心「技能」tab」+ 验收 CS 节）

- [ ] 8.1 核对 Context：组 7 合入后的 `tabs.ts` 与中心用例；拷入层是否有 `switch`。
- [ ] 8.2 测试先行：新 `web/test/center-skills.test.tsx`：列表与开关初值、切换恰一次 `putSkillDefaults` 且 body 含列表外已停用名称、在途禁用、500 回滚与提示、空态 `尚未安装平台技能`；`api-skills.ts` 严格解析；中心用例里普通用户 tab 条改为 `专家`、`技能`。
- [ ] 8.3 拷入 `switch`；新 `web/src/lib/api-skills.ts` + `api.ts` 导出；`web/src/features/center/skills/{list.tsx,use-skills.ts}`；`tabs.ts` 在 `experts` 之后插入 `{skills, 技能, adminOnly:false}`。
- [ ] 8.4 验收清单新增「中心·技能（CS）」CS-01 列出平台技能、CS-02 关闭默认启用后新会话该技能停用、CS-03 已有会话不受影响；`IMPLEMENTATION_PLAN.md` F-CTR-SKL 行指向本 change。

Suggested fixture level: compact - 账号偏好开关页，无凭证、无权限面差异。
Minimal mergeable slice: atomic - 列表、开关与 API 客户端是同一 tab 的一条用例路径。

## 9. 输入框的专家（experts「输入框的专家选择」+ chat-web「输入框与能力栏」+ session-sidebar 两条 + F-CHAT-1 / F-CHAT-11c）

- [ ] 9.1 核对 Context：`capability-bar.tsx` 的「+」菜单与左组次序、`welcome-options.ts` `createBody()`、`session-actions.ts` 的请求写法、`conversation-view.tsx` props、CH-11 / CH-66 两行。
- [ ] 9.2 测试先行：「+」菜单 `选择专家…` 的位置与生成中禁用；专家对话框（搜索、`不使用专家`、分组）；能力行 `专家 · <名称>` 标签与 `移除专家`、次序（`+`、专家、工作空间、权限）；欢迎态选专家后首次发送 body 含 `expertId`、不选不含；中心 `开始会话` 带入的 state 只读一次（刷新或回到欢迎态不再带）；会话中换专家恰一次 `PUT …/capabilities`、失败显示错误并保留原标签；选中会话恰一次 `GET …/capabilities`；新 `api-session-capabilities.ts` 严格解析；既有断言「没有专家」的用例改写。
- [ ] 9.3 新 `web/src/lib/api-session-capabilities.ts`；新 `web/src/features/chat/expert-picker.tsx`（对话框）与 `use-session-capabilities.ts`（会话中的 GET / PUT 与欢迎态选择）；`capability-bar.tsx` 加菜单项与标签；`welcome-options.ts` 的 `createBody()` 带 `expertId`；`conversation-view.tsx` props 链。不改 `use-chat-session.ts`。
- [ ] 9.4 验收清单：CH-11 去掉「菜单里没有专家」并加 `选择专家…` 一项的描述、CH-66 的能力行次序加专家标签并去掉「没有专家」；新增 CH 行「欢迎态选专家发送、会话中换专家，下一条回答体现新角色」；`IMPLEMENTATION_PLAN.md` F-CHAT-1 行注明「场景决定默认专家」已作废（s1d-experts-skills）、F-CHAT-11 行注明 11c 已交付；结论 `待签`。

Suggested fixture level: compact - 会话页控件与一次 REST 调用，服务端契约由组 5 钉住。
Minimal mergeable slice: atomic - 菜单项、对话框、标签与欢迎态 body 是同一个可见行为（选专家）的一条组件用例路径；会话能力 hook 是本组与组 10 共用的基础，先在本组落地。

## 10. 输入框「能力」弹层（skill-switches「输入框「能力」弹层」「停用技能对 omp 生效」的客户端过滤 + chat-web「输入框与能力栏」）

- [ ] 10.1 核对 Context：组 9 合入后的 `capability-bar.tsx` 与 `use-session-capabilities.ts`、`slash-menu.tsx` 的候选来源、「+」菜单命令段的来源（`/api/commands`）。
- [ ] 10.2 测试先行：`能力` 按钮位置（权限档位之后）；弹层列出平台与项目技能（项目标记保留）、开关初值（欢迎态取账号缺省、会话中取能力）、切换恰一次 `PUT` 且 body 为完整集合、失败回滚、`暂无可用技能`、底部说明；欢迎态动过开关才在 `POST /api/sessions` 带 `disabledSkills`（「欢迎态带初值」场景）；斜杠候选与「+」菜单不列停用技能（「会话中停用技能」场景）。
- [ ] 10.3 新 `web/src/features/chat/capability-popover.tsx`；`capability-bar.tsx` 加按钮；`use-session-capabilities.ts` 加停用集合；`slash-menu.tsx` 与「+」菜单命令段按停用集合过滤；`welcome-options.ts` 带 `disabledSkills`。
- [ ] 10.4 验收清单 CH-66 能力行次序加 `能力`；新增 CH 行「会话中关掉一个技能，斜杠候选里消失，下一条回答不再使用它」；结论 `待签`；`docs/architecture/system.md`「专家与技能」一节补会话能力与弹层。

Suggested fixture level: compact - 会话页控件与一次 REST 调用；omp 侧效果由组 1、组 6 的官方用例钉住。
Minimal mergeable slice: atomic - 弹层开关与候选过滤读同一个停用集合，拆开则候选列着已停用、omp 不加载的技能。
