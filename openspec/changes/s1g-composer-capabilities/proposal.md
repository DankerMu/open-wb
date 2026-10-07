# Proposal: s1g-composer-capabilities

## Why

会话页的输入框今天只有工作空间位与「技能与命令」菜单：工具审批档位在服务端钉死为 `write`、文件只能靠助手自己写进工作空间、模型由启动配置决定且界面上看不出是哪一个（#906）。
owner 于 2026-10-06 定下了 S1g 的全部产品决定（权限档位、整文件上传、模型与推理强度；逐条记录见 design「Owner 决定落位」），本 change 把它们一次落到规格、设计与任务上，覆盖 F-CHAT-12、F-CHAT-5a、F-CHAT-11b 与 #906。

## What Changes

- **会话级工具审批档位（F-CHAT-12）**：三档 `always-ask` / `write` / `yolo`，界面名 `每次都问` / `只问命令` / `全部自动`；管理员以 `APPROVAL_MAX_MODE` 配置允许的最高档（缺省三档都开放）；
  缺省 `只问命令`；按会话保存，新会话沿用该账号最近一次的选择；生成中可改，从下一条消息起生效（两个回合之间以 `--resume` 重启该会话的进程）；
  选 `全部自动` 时弹一次确认，该档位以警示色显示；档位每次实际变化都写审计；确认卡 60 秒不答自动允许的规则各档位相同、不改。
  **BREAKING（规格层）**：omp-runtime「`--approval-mode write` 是唯一允许值、不得运行期切换」一句作废，ADR-0012 的相应说明同步修订。
- **整文件上传与消息附件（F-CHAT-5a、F-CHAT-11b）**：`POST /api/workspaces/:id/uploads` 以原始字节流把一个文件写进该工作空间根下的 `uploads/`（任意类型；单个上限 `UPLOAD_MAX_BYTES`，缺省 524288000 字节，即把 owner 说的 500 MB 取为 500 MiB，与既有的 1 MiB / 10 MiB 预览上限同一口径；
  同名自动编号、不覆盖；路径过沙箱 `resolve(op=write)`；越界与超限全部拒绝并记审计；他人或不存在的空间一律 404）。输入框上方出现附件标签（可移除，移除不删已上传的文件），
  发送时 `prompt` 请求带上这些文件的相对路径，服务端随消息落库并以确定的后缀拼进交给 omp 的文本；用户气泡显示这些附件（刷新后仍在）。可以只发附件、不发文字（owner 2026-10-06 改判）：没有文字时只要带着已上传的附件就能发送，新会话这样发出的第一条消息以第一个附件的文件名作标题；没有附件的空消息仍被拒绝。
  欢迎页可先选文件（留在浏览器里），首次发送建好会话后再上传；支持拖进输入框与粘贴剪贴板里的文件或截图；每条消息最多 `UPLOAD_MAX_FILES` 个附件（缺省 10，即 owner 说的「一次最多 10 个」的同一个数；超出时整批不接受并提示 `每条消息最多 N 个附件`）。
  撤回一条带附件的消息时，仍存在的附件随撤回响应返回并恢复为输入框的附件标签（对 C 的 message-undo 的修改）。
- **模型与推理强度（#906）**：服务端模型白名单 `MODEL_CATALOG`（显示名、是否支持推理与看图、可选的强度子集），未配置时由 `MODEL_ID` / `MODEL_REASONING` 构成单模型白名单（托管 `models.yml` 字节不变）；
  输入框下方一行右侧显示模型名与推理强度，各自可点击切换；按会话保存、新会话沿用最近一次的选择；生成中可改、下一条消息起生效（派发前经 RPC `set_model` / `set_thinking_level` 应用，每个新进程重新应用）；
  强度按 omp v18.0.10 的全部档位（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`auto`）列出，缺省 `high`；模型不支持推理时不显示强度项；不按消息记录模型；重新生成与分叉用当前选择。
  **模型代理强制白名单**：代理解析请求体顶层的 `model`，不在白名单内（或缺失、重复、不是字符串）即 400 拒绝、不到达上游；放行的请求仍按原字节转发。
- **输入框能力行布局**：输入框下方一行，左侧依次为「+」菜单、工作空间、权限档位，右侧为模型名、推理强度，其后是既有的 `生成中` / `停止` / `发送`。
  「+」菜单新增 `上传文件`；其触发按钮改名为 `添加文件或命令`，草稿非空时仍可打开（此时只有命令条目不可选）。
  **BREAKING（规格层）**：chat-web「权限设置、上传文件、…模型切换 SHALL NOT 渲染」一句收窄为「专家与麦克风不渲染」。
- **会话数据**：会话视图在 C 之后的十一键之上新增 `approvalMode`、`modelId`、`reasoningEffort` 三键（共十四键）；`POST /api/sessions` 与 `PATCH /api/sessions/:id` 接受这三键；
  消息快照的每条消息新增 `attachments`；fork 响应与 undo 响应新增 `attachments`；新增 `GET /api/composer/options`。迁移 040（会话三列）、041（账号最近选择表）、042（消息附件列）。
- **沙箱**：`core/sandbox` 的 `resolve` 新增 `op=write`，本 change 的上传端点是它唯一的调用方。
- **配置**：新增四个环境变量 `APPROVAL_MAX_MODE`、`MODEL_CATALOG`、`UPLOAD_MAX_BYTES`、`UPLOAD_MAX_FILES`；新增错误码 `upload_too_large`（413）。
- **先行核对**：对官方 omp v18.0.10 二进制的实机核对是第一组任务（档位 argv 对 overlay 的优先级、三档各自的审批行为、`set_model` / `set_thinking_level` / `--resume` 的行为、托管模型条目的强度与看图声明、omp 发往上游的每个请求的模型名是否都在白名单内）；
  每一项都写明了核对不成立时的退路（design D2、D7、D8、D9、D18）。
- **条文底本**：归档次序 C（`s1f-session-list-temp-space`）→ 本 change → D（`s1f-files-page`）。本 change 与 C 同名的每条 MODIFIED 都以 C 的 delta 文本为底（C 的句子、场景与计数全部保留），绝对计数写成「C 之后的值加本 change 的增量」；重叠表与增量清单见 design D16。

## Capabilities

### New Capabilities

- `session-composer-settings`：会话的三项输入框设置（审批档位、模型、推理强度）的存储、有效值解析、创建与修改规则、账号最近选择的继承、fork 继承、`GET /api/composer/options`，以及迁移 040、041。
- `session-permission-tier`：审批档位到 omp 的落地（spawn argv、两个回合之间重启进程、各档位的审批行为与超时规则不变）、档位变更审计，以及输入框的权限档位控件（三档名称、确认框、警示色）。
- `model-selection`：模型白名单配置及其与 `MODEL_ID` / `MODEL_REASONING` 的兼容、派发前的模型与强度应用、输入框的模型与推理强度控件。
- `message-attachments`：消息附件——`prompt` 请求携带附件路径、校验、落库（迁移 042）、交给 omp 的文本后缀与分支对齐、快照与 fork 中的附件，以及输入框的附件标签、选择 / 拖拽 / 粘贴、欢迎页暂存与用户气泡呈现。

### Modified Capabilities

- `chat-web`：「会话页」（空白发送一句限定为没有可发送附件时；欢迎态场景的控件措辞；以 C 的 delta 为底）、「输入框与能力栏」（能力行布局、「+」菜单、不渲染项收窄）、「消息线程」（用户气泡显示附件；分叉与撤回回填附件）、「API 客户端扩展」（会话视图与消息的新键、`prompt` 与 `createSession` / `patchSession` 的新输入、fork 与 undo 响应的 `attachments`、两个新方法 `getComposerOptions` 与 `uploadFile`）。四条都以 C 的 delta 为底。
- `omp-runtime`：「子进程 spawn 契约」（`--approval-mode` 与 `--model` 按会话取值）、「宿主 overlay」（措辞与三档下的实机场景；文件字节不变）；新增「模型与推理强度命令」。
- `tool-approval`：「审批请求识别」（不再假定 `write` 档；`always-ask` 下写文件类工具同样走审批流）。
- `session-metadata`：「会话创建与空间绑定」「会话元数据修改」「fork 继承会话元数据」（三键的输入、校验与继承；以 C 的 delta 为底）、「会话元数据审计」（`session.permission` 只引用 session-permission-tier，不复述条件）、「会话视图扩展键」（C 新增的条文：十一键之上再加三键的括注与场景计数）。
- `chat-sessions`：「会话 REST」（会话视图十四键、消息键集、fork 响应；以 C 的 delta 为底）、「REST prompt 受理与补偿」（`attachments`；`message` 可以为空，只要带通过校验的附件；以 C 的 delta 为底）、「会话持久化与回合刷盘」（只发附件时标题取第一个附件的文件名；底本是主规格）、「Slash 命令白名单与命令目录」（带附件消息的 wire candidates）；新增「派发前按会话设置对齐进程」。
- `turn-control`：「从此处分叉 REST」（响应加 `attachments`、复制三列与消息附件、临时进程的档位与模型；以 C 的 delta 为底）、「重新生成 REST」（档位不同先退役；模型与强度的对齐在 `get_branch_messages` 之前，失败属事务前）。
- `session-sidebar`：「会话 DTO 严格解析」（C 新增的条文：十一键 → 十四键）、「composer footer 工作空间选择」（位置由「能力栏最左侧」改为左组第二项；「权限、上传与专家控件 SHALL NOT 渲染」收窄为专家与麦克风；以 C 的 delta 为底）。
- `message-undo`（C 新增的能力）：「撤回 REST」（200 加 `attachments`：被撤回消息里仍存在的附件）、「web 撤回」（恢复附件标签）。
- `model-proxy`：「托管 models.yml」（多模型条目；单模型时字节不变）、「透传端点与 bearer 鉴权」（顶层 `model` 的白名单校验；放行的请求仍字节透传）。
- `sandbox-core`：「resolve 契约与逃逸向量」（`op=write`）。
- `workspaces`：新增「文件上传」。
- `http-service-skeleton`：「服务启动与装配」（C 之后的十九项加四键，共二十三项）、「统一错误信封」（C 之后的十五码加 `upload_too_large` 共十六码；十四条归属身份加上传路由共十五条）、「Shared agent module assembly」（纯配置 seam 的键数随之为二十三）。三条都以 C 的 delta 为底。
- `omp-test-harness`：「假 omp 进程契约」（`approval-write` 场景、`set_model` / `set_thinking_level` 应答）、「假 omp 夹具模块划分」（新增一个纯构建模块）；新增「受控上游请求记录」（只读端点，供官方二进制对照用例核对 omp 发出的模型名）。
- `chat-harness`：新增「输入框能力的冒烟与走查」；「会话元数据 HTTP 冒烟」（会话 DTO 的键数断言由十一改为十四；以 C 的 delta 为底）。

`audit-core` 不改（审计 kind 不在该规格里枚举，新增 kind 不需要迁移）；`functional-acceptance` 不改（只新增清单行，签收规则不变）。

## Impact

- **服务端代码**：`server/src/agent-config.ts`（四个新键、白名单解析）、`server/src/model-proxy/models-yml.ts`、`server/src/core/sandbox/{resolve,index}.ts`、`server/src/core/errors`（新码）、`server/src/http`（归属身份）、
  `server/src/model-proxy/index.ts`（顶层 `model` 校验，`allowedModels` 由装配处传入）、`server/src/workspaces/`（上传路由，新文件）、`server/src/sessions/`（store 的三列与附件列、账号最近选择、`rest.ts` / `rest-metadata.ts`、新的 options 路由文件、`pool.ts` / `supervisor.ts` / `branching.ts` 的按会话取值与派发前对齐、
  `slash-commands.ts` 的附件后缀与 wire candidates、`rest.ts` 对空文本带附件的受理与 `acceptPrompt` 的标题取材、C 新增的 `undo.ts` / `store-undo.ts` 的撤回响应附件）、`server/src/sessions/omp/{process,runtime,commands}.ts`（argv 取值、两种新命令帧）、`server/src/core/db/migrations/040–042`。
  `process.ts`（788 行）、`store.ts`（797）、`runtime.ts`（798）、`supervisor.ts`（800）都贴着 800 行上限：新增逻辑落在新文件或有余量的既有文件。
- **Web 代码**：`web/src/lib/`（`session-contract.ts` 的键集、`api.ts` / `api-sessions.ts` 的新方法、新的上传传输文件）、`web/src/features/chat/`（`composer.tsx`、`capability-bar.tsx`、`message-thread.tsx`、`turn-actions.ts`、`use-chat-session.ts`，
  以及新的档位、模型、附件组件与状态文件——逐个登记进 `MIGRATED_AREAS`）。拷入层两个目录不改。
- **API**：新增 `POST /api/workspaces/:id/uploads`、`GET /api/composer/options`；`POST /api/sessions`、`PATCH /api/sessions/:id`、`POST /api/sessions/:id/prompt` 的请求体与会话视图、消息快照、fork 响应的键集扩大。
  Web 的 DTO 解析按「恰好键集」校验，键集变化按「web 先接受新旧两种 → 服务端发出新键 → web 收紧」三步落地（tasks 组 5 → 组 8 / 12 → 组 13）。
- **数据库**：迁移 040、041、042（只 `ADD COLUMN` 与建一张新表，无回填）。C `s1f-session-list-temp-space` 占 037–039，D `s1f-files-page` 占 043–045。
- **测试夹具**：假 omp（新场景、两种命令应答、模块拆分）；受控上游新增一个只读的请求记录端点（既有应答不变）；官方二进制对照用例（`WORKBUDDY_OMP_TEST=1`）；`smoke/files.hurl`、`smoke/session-meta.hurl`、ui-walk 新步骤。
- **依赖**：无新增（上传不用 multipart，design D10）。
- **部署**：四个新环境变量；反向代理需放开请求体大小并关闭请求缓冲（文档任务）；`OMP_USER` 模式下上传文件须对 omp uid 可读写（mode `0660`，目录 setgid）。
- **文档**：ADR-0012（档位不再钉死 `write`）、ADR-0013（能力行）、`CONTEXT.md`（术语：权限档位、附件）、`docs/acceptance/functional-checklist.md`（新行，`待签`）、`IMPLEMENTATION_PLAN.md` 不改（2026-10-06 的决定已在其中）。
- **依赖关系**：`Depends on change s1f-session-list-temp-space`，三处。(1) 条文底本：与它同名的 MODIFIED 以它的 delta 为底，它先归档（design D16，任务 0.1）。(2) 行为前提：临时空间（上传目标是「会话的工作空间」，临时空间是以 `workspaceId` 寻址的 `workspaces` 行）、会话视图十一键、消息 `undo` 键、撤回端点都由它交付，本 change 在其上叠加。(3) 迁移 040–042 须在它的 037–039 合入之后才合入（回执须是迁移文件的连续前缀）。
  `s1f-files-page` 在本 change 之后归档，与本 change 共改 sandbox-core「resolve 契约与逃逸向量」、http-service-skeleton 的两条等条文，以本 change 归档后的文本为底；它不使用 `op=write`。#908–#912 是独立 issue，不并入。
