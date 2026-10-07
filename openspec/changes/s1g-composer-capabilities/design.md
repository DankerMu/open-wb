# Design: s1g-composer-capabilities

## Context

现状（master d7c575c，逐项核对过）：

- **审批档位钉死**。`spawnOmp` 的 argv 写死 `--approval-mode write`（`server/src/sessions/omp/process.ts:94-97`），omp-runtime 规格写明它是唯一允许值、不得运行期切换；
  宿主 overlay 里另有一行 `tools.approvalMode: write`（`server/src/sessions/omp/host-overlay.ts`）。审批识别只看 `extension_ui_request` 的形状（`Allow tool: ` 开头、选项恰为 `Approve` / `Deny`），不关心是哪个工具。
- **进程生命周期**。每个会话一个 slot（`server/src/sessions/pool.ts`），首个 prompt 懒获取进程；`#onSlot`（`supervisor.ts:403-428`）在 slot 存活、未在退役、仍占着名额时复用它，否则走一次新的准入；
  `#retireSlot`（`supervisor.ts:763-786`）关 stdin、必要时 SIGTERM / SIGKILL，释放名额，下一次获取以最后已知的会话文件 `--resume`，`stream_epoch` 加一。prompt 只在该会话没有回合认领、没有控制占用时才走到 `#onSlot`。
- **模型**。`--model workbuddy/<MODEL_ID>` 对所有会话相同（`pool.ts` 的 `sessionRuntimeOpts` 取 `base.modelId`）；托管 `models.yml` 只写一个模型条目（`server/src/model-proxy/models-yml.ts`）；模型代理原样转发请求体，不读 `model`。
  宿主发给 omp 的 RPC 只有 `prompt`、`abort`、`get_state`、`get_branch_messages`、`branch`（`omp/runtime.ts`）。
- **文件**。工作空间 REST 只有列举、新建目录、预览（`server/src/workspaces/rest.ts`），没有写文件的端点；沙箱 `resolve` 的 `op` 只有 `read | list | mkdir`；服务端没有 multipart 依赖（`server/package.json` 只有 `fastify`）。
- **会话数据**。会话视图恰八键，`PATCH` 键集 `{title, scene, pinned}` 且不写审计（`rest-metadata.ts`）；web 的 DTO 解析用 `hasExactlyKeys` 按「恰好键集」校验（`web/src/lib/session-contract.ts`），键集一变就整体拒绝。
- **分支对齐**。重新生成与分叉把 omp 的 `user` 条目文本与库里用户消息的 wire candidates 比对（chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment）；交给 omp 的文本若与落库文本不一致而规则不跟着改，这类回合的重新生成与分叉全部 502。
- **源码体量**。`process.ts` 788 行、`store.ts` 797、`runtime.ts` 798、`supervisor.ts` 800、`server/test/support/fake-omp.mjs` 799，都贴着 800 行上限。

对官方 omp v18.0.10 二进制的只读核对（2026-10-06，`--help` 与二进制内可读的打包源码；**未启动进程、未做实机调用**）：

| 事实 | 依据 |
|---|---|
| `--approval-mode` 接受 `always-ask` / `write` / `yolo`，帮助文本为「Override tools.approvalMode for this session」 | `--help` |
| 启动时 `if (n.approvalMode) settings.override("tools.approvalMode", n.approvalMode)`；`override` 写入独立的运行期覆盖层，高于各配置层 | 打包源码（main 启动段、Settings `override`） |
| 各档位自动放行的最高工具档：`always-ask → read`、`write → write`、`yolo → exec` | 打包源码常量表 |
| 逐工具策略 `tools.approval.<tool>` 在每种档位下都先于档位判定（`deny` 最先）；`yolo` 下结果为「工具自带策略 ?? 用户策略 ?? allow」 | 打包源码策略函数 |
| 需要确认时调用 `ui.select(<标题>, ["Approve","Deny"])`，标题首行 `Allow tool: <name>`，与工具档无关 | 打包源码 |
| RPC `set_model{provider, modelId}`：在可用模型里按 `provider` 与 `id` 精确查找，找不到应答失败 `Model not found: …`；找到则 `setModel`，它向会话文件追加一条模型变更记录、并把推理强度重置为该模型的缺省 | 打包源码 |
| RPC `set_thinking_level{level}`：RPC 层不校验 `level`；`auto` 走单独分支，其余取值按模型支持的强度就近取低；向会话文件追加一条强度变更记录；不写全局设置 | 打包源码 |
| `get_state` 应答含 `model` 与 `thinkingLevel` | 打包源码 |
| 强度序 `minimal < low < medium < high < xhigh < max`；`--thinking` 接受 `off`、这六档与 `auto`；设置项 `defaultThinkingLevel` 缺省 `high` | 打包源码、`--help` |
| 模型支持的强度取自模型条目的 `thinking.efforts`，条目不带它时为空集 | 打包源码 |
| RPC `prompt` 只带 `message` 与 `images`，没有通用附件字段；RPC 命令表里没有任何审批档位相关的命令 | 打包源码 |

以上是读出来的，不是跑出来的；凡设计依赖其中一条的，都在对应决定里写了「先核对」与退路，核对任务是 tasks 组 1。

**条文底本**：归档次序固定为 C（`s1f-session-list-temp-space`）→ 本 change → D（`s1f-files-page`）。上面的「现状」是 master 的代码事实；本 change 的规格 delta 则以「主规格叠加 C 的 delta」为底——会话视图十一键、消息 `undo` 键、临时空间、撤回、十五码 / 十四条归属 / 十九项配置都是既定前提，见 D16 的重叠表。

约束：L3 strict（TDD、覆盖率 80%、文件 ≤800 行、knip、jscpd）；沙箱与 omp 子进程治理是 Critical Path（白盒审查）；ADR-0013 的拷入层只允许六类修改；仓库公开。

### Owner 决定落位（grill 凭证 S1g 的 20 行）

| # | 结论 | 落在 |
|---|---|---|
| 1 | 三档 + 管理员可配最高档 | D1、D3；session-permission-tier、session-composer-settings |
| 2 | 缺省「只问命令」，按会话，新会话沿用最近选择 | D3、D4；session-composer-settings |
| 3 | 60 秒超时自动允许，各档相同 | D2；session-permission-tier「超时规则各档相同」；tool-approval「超时自动允许」不改 |
| 4 | 生成中可改，下一条消息起生效 | D2、D5；chat-sessions「派发前按会话设置对齐进程」 |
| 5 | 「全部自动」确认一次 + 警示色 | D14；session-permission-tier「权限档位控件」 |
| 6 | 每次改档位记审计 | D6；session-permission-tier「档位变更审计」 |
| 7 | `uploads/` + 同名编号不覆盖 | D11；workspaces「文件上传」 |
| 8 | 任意类型、500 MB、一次 10 个、可配 | D10、D11、D7；workspaces「文件上传」、message-attachments |
| 9 | 附件标签、路径随消息、气泡显示 | D12、D15；message-attachments |
| 10 | 欢迎页暂存、拖拽、粘贴、「+」菜单入口 | D13、D15；message-attachments、chat-web「输入框与能力栏」 |
| 11 | 过沙箱、越界 / 超限拒绝并审计、双账号不可见 | D11；sandbox-core、workspaces「文件上传」 |
| 12 | 服务端模型白名单 | D7；model-selection |
| 13 | 模型 / 强度按会话、沿用最近选择 | D3、D4 |
| 14 | 生成中可改、下一条生效、上下文照带 | D8 |
| 15 | 强度按 omp 全部档位、缺省取 omp 缺省、不支持推理不显示 | D9 |
| 16 | 不按消息记录模型 | Non-Goals |
| 17 | 重新生成与分叉用当前选择，分叉继承 | D5、D8；session-metadata「fork 继承会话元数据」 |
| 18 | 布局：左「+」、空间、档位；右模型、强度 | D14；chat-web「输入框与能力栏」 |
| 19 | 换档 = 两个回合之间重启进程 | D2 |
| 20 | 模型 / 强度 = 运行期 RPC | D8 |

### Owner 补充决定落位（Stage 3 之后，2026-10-06，与 grill 同等效力）

| # | 结论 | 落在 |
|---|---|---|
| S-21 | `全部自动` 被新会话继承：与其它两档一样沿用最近选择；警示色 + 创建审计，不再弹确认 | D4、D6；session-composer-settings「创建会话时的设置与继承」、session-permission-tier「档位变更审计」「权限档位控件」；tasks 8.2、14.3、18.1 |
| S-22 | 模型代理强制白名单：解析请求里的模型名，不在白名单即拒绝 | Goals、D18；model-proxy「透传端点与 bearer 鉴权」、model-selection「模型白名单配置」、omp-test-harness「受控上游请求记录」；tasks 组 20、1.4 |
| S-23 | 每条消息附件总数最多 `UPLOAD_MAX_FILES` 个（与「一次最多 10 个」同一个可配的数）；提示文案 `每条消息最多 N 个附件` | D12、D15；message-attachments「prompt 携带附件」「输入框附件标签」、http-service-skeleton「服务启动与装配」；tasks 12.3、16.1 |
| S-24 | 撤回带附件的消息时附件标签也恢复（undo 响应加 `attachments`；文件已不存在的不恢复） | D19；message-undo「撤回 REST」「web 撤回」、message-attachments「重新生成与分叉中的附件」「输入框附件标签」、chat-web「API 客户端扩展」「消息线程」；tasks 12.6、13.1、17.5 |
| 改判（2026-10-06） | **允许只发附件、不发文字**：`message` 去掉首尾空白后为空时，只要 `attachments` 非空且通过全部附件校验就受理；为空且无附件仍拒绝；`message` 键仍须出现且为字符串。改掉的是原 D17 第 4 条（起草者自定的「不支持」） | D12、D15、D17 第 4 条（配套细节 4a–4g 由起草者定）；chat-sessions「REST prompt 受理与补偿」「会话持久化与回合刷盘」「Slash 命令白名单与命令目录」、message-attachments 各条、chat-web「会话页」「输入框与能力栏」「消息线程」「API 客户端扩展」、message-undo「撤回 REST」「web 撤回」；tasks 0.1、1.6–1.8、12.1–12.4、12.6、13.1、14.2a、16.2c、16.3–16.6、17.1–17.5 |

## Goals / Non-Goals

**Goals**

- 用户可为每个会话选择工具审批档位，选择在下一条消息起对 omp 实际生效；管理员能封顶；每次变化可审计。
- 用户能把本机文件整份放进会话的工作空间，并让这条消息带上它们；越界、超限都被拒绝并留痕；另一个账号看不到。
- 用户看得见当前模型与推理强度，并能从管理员配置的清单里切换，下一条消息起生效。
- 白名单不只约束界面：模型代理只放行模型名在白名单内的请求，白名单外的请求不到达上游（owner S-22）。
- 已有部署不改配置就升级：单模型、`write` 档、托管 `models.yml` 字节不变、既有会话行为不变。
- 设计所依赖的每一条未实测的 omp 行为，都有一条先行的实机核对任务与写明的退路。

**Non-Goals**

- 按消息记录所用模型，或在历史消息上标注模型（owner 决定 16）。
- 按用户或按模型的计费、配额、用量展示；多个上游供应商及其密钥管理界面（#906 范围外）。所有白名单模型共用同一个上游（`MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`）。
- 模型代理改写请求体：代理只校验顶层 `model`，放行的请求仍按原字节转发，不重写、不补全、不映射模型名（D18）。
- 按会话限定模型（「这个会话的 bearer 只能请求这个会话当前选的模型」）：代理只认全局白名单，owner S-22 的字面如此；会话级绑定要让代理读会话状态，另议。
- 运行期管理界面：最高档、白名单、上传上限都只由环境变量配置，改动需重启服务。
- 改动 60 秒超时自动允许、审批卡的呈现与作答规则（#911 独立）；消息操作行的悬停呈现与用户消息 `复制`（#908）；上游拒绝时的错误呈现（#909）；等待与思考呈现（#910）；omp 浏览器能力（#912）。
- 临时空间的定义、创建与清理（change `s1f-session-list-temp-space`）；文件页的上传入口、删除、重命名、移动与预览侧边栏（change `s1f-files-page`；附件在气泡里不是可点击的预览入口）。
- 专家（F-CHAT-11c）与麦克风：仍不渲染。
- 上传的断点续传、分片、并行分片、文件夹上传、上传后的病毒或内容扫描、按扩展名的类型限制（owner 决定：任意类型）。
- 已上传文件的删除入口：移除附件标签不删文件（owner 决定 9），本 change 不提供删除。文件随工作空间走——临时空间随最后一个会话删除、撤回连文件还原，都是 C 的既有规则（D13）。
- 进程崩溃留下的 `.upload-….part` 临时文件的启动清扫：要遍历每个空间的 `uploads/`，本 change 不做；残留写进部署文档（任务 19.4）。
- 把图片附件作为 `images` 内联进 RPC `prompt`：附件一律以路径告知，由助手自己读取。
- 每个模型各自的 `contextWindow` / `maxTokens`：沿用现有的固定值 128000 / 8192。
- 审批档位的运行期热切换（不重启进程）：omp 没有这样的命令。
- 对「项目层自定义工具与插件」「子代理以 yolo 运行」等 ADR-0012 已登记残余的任何收紧。

## Decisions

### D1 档位的取值、名称与次序

内部取值就是 omp 的三个字面量 `always-ask` / `write` / `yolo`，从库、API 到 argv 不做映射；严格程度的次序为 `always-ask < write < yolo`（越往右放行越多）。界面名取 owner 的原话：`每次都问`、`只问命令`、`全部自动`。
管理员的 `APPROVAL_MAX_MODE` 是这个次序上的上界，缺省 `yolo`（三档都开放）；它是 `always-ask` 时，缺省档 `write` 也超界，按 D3 的夹取规则落到 `always-ask`。

否决：自造一套档位名再映射到 omp——多一张表、多一处写错的机会，没有换来任何东西。

### D2 档位如何生效：按 argv 启动，档位不同就在两个回合之间重启进程

每次 spawn 的 argv 带 `--approval-mode <该会话的有效档位>`；slot 记下它启动时用的档位。派发 prompt（或重新生成）时，若存活 slot 的启动档位与会话此刻的有效档位不同，先 `#retireSlot` 再走一次普通的新准入：
新进程以最后已知的会话文件 `--resume`，是一个正常的新 generation（`stream_epoch` 加一、新的 ring），与空闲回收后再发消息完全同一条路径。

- **为什么是重启**：omp 的 RPC 没有切换档位的命令；`settings.override` 只在启动时由 argv 写入。
- **为什么安全**：走到这里时该会话没有回合认领、没有控制占用（`#prompt` 的既有前置），也就没有在途回合与待决审批——退役不会打断任何东西；会话历史在会话文件里，`--resume` 无损（分叉先退役源进程用的是同一条依据）。
- **在途回合不受影响**：`PATCH` 只写库，不通知 supervisor。正在跑的这一轮（含已弹出的确认卡）继续用它启动时的档位；下一次派发才读到新值。这正是 owner 决定 4。
- **代价**：换档后的第一条消息多一次进程启动（握手），与空闲回收后的第一条消息相同；订阅该会话事件流的页面按既有的 epoch 变化规则续流。退役最坏要等 stdin 关闭后的 5 秒 + 3 秒信号阶梯，正常情况下 omp 在 stdin 关闭后即退出。
- **overlay 不动**。`host-overlay.yml` 的字节保持不变（仍含 `tools.approvalMode: write`）：argv 经 `settings.override` 写入的层高于 overlay，所以 overlay 那一行只在 argv 缺席时才起作用，作为 `write` 档的兜底留着；
  `tools.approval: []` 与 `bash.patterns: []` 在三档下的作用不变——项目层写的逐工具放行与 bash 放行规则仍被整体清掉。`yolo` 下本来就全部放行，项目层无从再放宽；项目层写的收紧规则被清掉是 ADR-0012 已登记的残余，不因本 change 改变。
- **超时不变**：60 秒自动允许按审批条目计时，与档位无关；`always-ask` 下写文件类工具的确认卡同样会超时自动允许。
- **`yolo` 不等于宿主吞掉请求**：宿主不因档位而自动应答或丢弃 `extension_ui_request`。omp 在 `yolo` 下若仍因工具自带策略请求确认，照常出确认卡。

**先核对**（tasks 1.1–1.3，官方二进制 + 受控上游）：(a) overlay 原样、argv 为 `always-ask` 时，`WORKBUDDY_WRITE` 回合对 `write` 工具发起审批；(b) argv 为 `yolo` 时 bash 回合不发起审批；
(c) `always-ask` 下项目层 `.omp/config.yml` 写 `tools.approval: {write: allow}` 仍然发起审批；(d) 以另一档位 `--resume` 同一会话文件后，历史仍在、新档位生效。
**退路**：(a) 不成立（overlay 压过 argv）→ overlay 改为按档位各写一份（`host-overlay-<mode>.yml`，除 `tools.approvalMode` 一行外逐字节相同），spawn 按档位选 `--config` 与 `PI_CONFIG_FILES`，argv 与 overlay 恒一致；
(c) 不成立 → 停下回到 owner（`always-ask` 在项目层可被绕过，是否仍上线由 owner 定），在那之前不合入组 9；(d) 不成立 → 停下回到 owner（换档需要另寻机制）。退路一旦启用，先改本 change 的规格再实现。

否决：换档时立即重启进程（会打断在途回合，违背决定 4）；每个档位常驻一个进程（三倍进程数，且两个进程写同一个会话文件）；只改 overlay 不传 argv（overlay 是全局一份，做不到按会话）。

### D3 存储与有效值：原始选择入库，读的时候夹取

迁移 040 给 `chat_sessions` 加三列，全部可空、无缺省：`approval_mode`、`model_id`、`reasoning_effort`。列里存的是**用户的原始选择**；对外（会话视图、spawn、RPC）一律用**有效值**，由一个纯函数从「行 + 当前配置」算出：

- `approvalMode` = `min(approval_mode ?? "write", APPROVAL_MAX_MODE)`（按 D1 的次序）。
- `modelId` = `model_id` 在白名单里则取它，否则取缺省模型。
- `reasoningEffort` = 该模型不支持推理时为 `null`；否则 `reasoning_effort` 在该模型的可选强度里则取它，否则取该模型的缺省强度（D9）。

这样：既有会话（三列为 NULL）读成 `write`、缺省模型、缺省强度，行为与今天相同；管理员调低最高档或从白名单里拿掉一个模型，下一次派发就生效，界面显示的也是夹取后的值；不需要回填、不需要「配置变了去改库」的任务。
管理员把上限调回去时，原始选择重新生效——用户确实选过它，这是有意的。

否决：入库时就夹取（配置一变库里的值就成了假话，还得回写）；列带缺省值（既有迁移的先例是可空无缺省，且缺省值会把「没选过」和「选了缺省」混为一谈）。

### D4 「最近一次的选择」：一张按账号的表，不从会话里推

迁移 041 建 `account_composer_prefs(account_id PK, approval_mode, model_id, reasoning_effort, updated_at)`，三列可空。用户每做一次选择（`PATCH` 带这三键之一，或 `POST /api/sessions` 的 body 带这三键之一），在同一个事务里把对应列写进这张表。
新会话创建时，body 没给的键取这张表里的原始值（没有行或该列为 NULL 则会话列也写 NULL）。欢迎页显示的缺省值来自 `GET /api/composer/options` 的 `defaults`——这张表经 D3 同一个纯函数算出的有效值。

为什么不从「最近改过的会话」推：「最近修改的会话」不等于「最近一次选择」（改标题也会动会话；`PATCH` 不改 `updated_at`；会话可以被删）。一张三列的表比任何推断都短。

「全部自动」会被继承（**已定**，owner S-21）：用户选过一次之后，新会话默认就是它（不再弹确认——确认发生在选择那一刻），输入框下方以警示色显示，创建时写一条审计（D6）。依据：grill 第 2 行（新会话沿用最近一次的选择，不分档位）、第 5 行（确认发生在「选中时」）、第 17 行（权限档位同理按会话继承），以及 owner 在 Stage 3 之后的明确确认（S-21）。否决「继承时把 `yolo` 降为 `write`」：那是给三档里的一档单开一条规则，owner 没要。

### D5 派发前对齐：读一次有效值，决定重启与 RPC

`store.runtimeState` 多报三个原始列；supervisor 在每次派发（prompt、重新生成）时算出有效值，按下面的次序做：

1. 存活 slot 的启动档位 ≠ 有效档位 → 退役它，走新准入（D2）。
2. 取得进程后、写 `prompt` 帧之前：这个 generation 还没应用过模型，或上次应用的模型 ≠ 有效模型 → `set_model{provider:"workbuddy", modelId}`；
   随后若该模型支持推理，且（刚发过 `set_model`，或上次应用的强度 ≠ 有效强度）→ `set_thinking_level{level}`（D8）。
3. 写 `prompt` 帧。

任一步失败都按「派发前失败」处理：`agent_unavailable`，受理对被既有路径补偿，slot 退役。
**regenerate 的第 2 步放在哪**：紧接在取得进程之后、`get_branch_messages` 之前。regenerate 有两条结果相反的失败映射——事务前失败（行不变，502）与事务后派发失败（旧助手行已删、新行记 `failed`）。把 `set_model` 放在事务之后，一次白名单与 `models.yml` 不一致就会删掉用户原有的回答；放在 `branch` 之前，失败时什么都没动。代价是对齐成功而随后 `branch` 失败时白发了一两条命令，无害（下次派发按「已应用」跳过或重发）。turn-control「重新生成 REST」的执行序随之 MODIFIED（档位不同先退役、对齐在 `get_branch_messages` 之前）。分叉的临时进程只跑 `get_branch_messages` / `branch` / `get_state`，不发 prompt，所以只需要 argv 正确（源会话的有效档位与模型），不做第 2 步；
分叉出的新会话行复制源会话的三列原始值（owner 决定 17），它自己的第一次派发照常对齐。重新生成走的是源会话自己的进程，照常经过 1–3，即「用当前选择」。

### D6 审计：档位实际变化才记，模型与强度不记

- `PATCH` 使有效档位从 `a` 变为 `b`（`a ≠ b`）：同事务写一条 `session.permission`，`title="修改权限档位"`，`detail={sessionId, from:a, to:b}`。值没变（重复选同一档）不写。
- 创建会话时写入的原始档位（显式给出或继承而来）非 NULL 且其有效档位偏离当前配置下的缺省档：同事务写一条 `session.permission`，`detail={sessionId, from:null, to}`。没有偏离缺省的创建不写（避免每建一个会话一条审计；也避免上界为 `always-ask` 时每次创建都因夹取而记一条没有用户动作的审计）。
- 分叉继承不另写（与 `session.bind` 对分叉的规则一致；源会话的那次选择已有记录）。
- 模型与强度的变化不写审计：owner 只要求档位（决定 6），审计是「权限事件」的记录（CONTEXT）。
- `session.approval`（每次审批结算）不变。

审计 kind 的格式约束由迁移 030 的 CHECK 给出（至少两段的小写点分标识），`session.permission`、`file.upload`、`upload.reject` 都满足，不需要迁移；audit-core 规格不枚举 kind，不改。

### D7 模型白名单：一个 JSON 环境变量，缺席时等于今天

`MODEL_CATALOG` 是一个 JSON 数组（1 到 32 项），每项 `{id, name?, reasoning?, vision?, efforts?}`：`id` 即发给上游的模型名；`name` 是显示名，缺省等于 `id`；`reasoning`、`vision` 缺省 `false`；
`efforts` 只在 `reasoning` 为真时可给，是 `minimal…max` 的一个非空、不重复、按强度升序的子集，表示该模型支持的强度。配置错误（非 JSON、不是数组、空、超过 32 项、多余键、类型不对、`id` 重复）启动失败，错误只点名 `MODEL_CATALOG`。

- **与旧配置的关系**。`MODEL_CATALOG` 未设置：白名单恰一项 `{id: MODEL_ID, name: MODEL_ID, reasoning: MODEL_REASONING, vision: false}`，托管 `models.yml` 与今天逐字节相同。
  `MODEL_CATALOG` 已设置：`MODEL_ID` 若设置须等于某一项的 `id`，表示缺省模型，未设置则第一项是缺省；`MODEL_REASONING` 不得同时设置（每个模型的推理声明已在白名单里，两处都写只会打架），同设即启动失败并点名 `MODEL_REASONING`。
- **为什么是环境变量而不是配置文件**。http-service-skeleton 规定环境变量是唯一配置源；为一张小表引入配置文件要同时引入路径解析、权限与重载语义。JSON 写在环境变量里不好看，但部署用的 `.env` / systemd unit / compose 都放得下，校验一次即可。
- **托管 `models.yml`**。写出器改收模型数组，按白名单次序各写一条；每条仍是 `id`、`name`、`contextWindow: 128000`、`maxTokens: 8192` 与既有的 `reasoning` / `compat` 两键；
  白名单项带 `efforts` 时追加 `thinking: {mode: effort, efforts: […]}`，`vision` 为真时追加 `input: [text, image]`。未带 `efforts`、`vision` 为假的条目不出现这两个键，所以单模型缺省配置的输出不变。
- **代理强制白名单**（owner S-22）：见 D18。白名单因此有三个消费者——界面与会话设置校验、托管 `models.yml`、模型代理——都来自 `resolveModelCatalog` 的同一份结果。

**先核对**（tasks 1.5）：官方二进制读取带 `thinking` 与 `input` 两键的托管条目后，`get_available_models` 里该模型的 `thinking.efforts` 与 `input` 与所写一致；不带 `thinking` 的推理模型条目，`get_available_models` 报出的强度集合是什么。
**退路**：omp 不接受其中某个键 → 该键不写进 `models.yml`（`efforts` 仍用于界面与服务端校验，`vision` 退化为仅展示），先改 model-proxy 的 delta 再实现；不带 `thinking` 的推理模型强度集合为空 → 写出器对每个推理模型都写 `thinking`（未声明 `efforts` 时写全部六档），单模型缺省配置的「字节不变」一句随之改为「多出 `thinking` 块」，同样先改规格。

否决：先看 `get_available_models` 返回什么再决定要不要白名单（#906 评论里的想法）——它返回的就是 `models.yml` 里宿主自己写的条目，绕一圈回到原地；显示名、能力标签也不该靠起一个 omp 进程来查。

### D8 模型与强度如何生效：派发前 RPC，每个新进程重新应用

按 grill 第 20 行，用运行期 RPC：`SessionRuntime.command` 在既有三种帧之外再接受 `set_model{provider, modelId}` 与 `set_thinking_level{level}`，规则同其它相关命令（独立 id、只被匹配的 `response` 结算、与 prompt 互斥、失败为 `AgentUnavailableError`）。

- **次序固定**：先 `set_model` 后 `set_thinking_level`——`setModel` 会把强度重置为新模型的缺省，反过来发强度会被冲掉。
- **每个 generation 的第一次派发总是应用**，不管 argv。spawn 的 `--model` 也改为按会话取值（冷启动总得有个模型，取对的那个），但 `--resume` 时 omp 是以 argv 为准还是以会话文件里的模型变更记录为准没有实测，所以不依赖它：新进程的第一条 prompt 之前无条件发 `set_model`（支持推理的再发 `set_thinking_level`）。同一个 generation 上之后的派发只在有效值变了才发。
- **生成中改选择**：`PATCH` 只写库；`command` 与在途回合互斥，本来也发不出去。下一次派发时对齐——「下一条消息起生效」。历史上下文在 omp 的会话里，换模型不清空。
- **失败**：`set_model` 应答失败（例如白名单与 `models.yml` 不一致）→ 这次派发按 `agent_unavailable` 失败并补偿。
- **不持久到 omp 的全局设置**：RPC 的这两个命令不带持久化参数（读到的实现如此），各会话共用的托管 `HOME` 不被某个会话的选择污染。核对任务里一并确认。

**先核对**（tasks 1.4）：(a) `set_model` 后 `get_state.model` 为所选；(b) `set_thinking_level` 的每个取值后 `get_state.thinkingLevel` 是什么（含模型不支持的取值、`off`、`auto`）；(c) 两个命令后托管 `HOME` 下的全局配置文件没有变化；
(d) 换模型后的下一个回合，受控上游收到的请求体 `model` 为新模型且带着此前的对话历史；(e) 新进程以 `--resume` 启动、未发 RPC 时 `get_state` 报的模型与强度（决定「每个 generation 总是应用」能否放宽——放宽不在本 change）。
**退路**：RPC 在 rpc 模式下不生效或不可用 → 模型与强度并入 D2 的机制：slot 记下启动时的模型与强度，不同就重启，argv 带 `--model` 与 `--thinking`；先改 chat-sessions / omp-runtime 的 delta 再实现。

否决：模型也一律靠重启进程（档位、模型、强度三项统一走 argv）——更少的活动部件，但每次换模型多一次进程启动，且与 grill 第 20 行的事实核对结论相反；作为上面的退路保留。

### D9 强度档位集合与缺省

可选强度（界面列出、服务端接受的集合）按模型算：不支持推理 → 空；支持推理 → `off`，加上白名单项声明的 `efforts`（未声明则全部六档 `minimal, low, medium, high, xhigh, max`），加上 `auto`。这就是「按 omp 支持的全部档位列出」——八个名字都来自二进制；声明了 `efforts` 的模型只列它真支持的，避免选了 `xhigh` 实际被 omp 悄悄降到 `high`。
缺省强度：`high` 在该模型的可选强度里就是 `high`（omp 设置项 `defaultThinkingLevel` 的缺省），否则取声明的 `efforts` 里不高于 `high` 的最高一档，再没有就取声明的第一档（与 omp 就近取低的规则同向）。
界面名：`关闭`、`极低`、`低`、`中`、`高`、`很高`、`最高`、`自动`。

组 1 对强度的核对只看 omp 自己报告的状态（`set_thinking_level` 之后的 `get_state.thinkingLevel`），**不**核对请求体里的 reasoning 字段——那取决于 `compat` 与上游方言，属于 Open Questions 1 的验收期观察。

未实测的部分与核对见 D8 的 (b)：若 omp 对某个取值的实际行为与名字不符（例如 `auto` 在自定义模型上无效），先把该取值从可选集合里拿掉并改规格。

### D10 上传的传输：原始字节流，一次请求一个文件

`POST /api/workspaces/:id/uploads?name=<文件名>`，`Content-Type: application/octet-stream`，请求体就是文件字节。服务端给这条路由注册一个只把请求流原样交给 handler 的 content-type parser，handler 把流接到磁盘上的临时文件，边读边计数。

- **为什么不用 multipart**：要么引入 `@fastify/multipart`（新依赖，依赖政策要求说明现有工具为什么做不到——而现有工具做得到），要么手写边界解析（容易写错的那类代码）。一个请求一个文件时，multipart 提供的只有「文件名」这一个字段，放进 query 就够了；浏览器把 `File` 直接当请求体发送不需要任何封装。
- **不进内存**：流直接进文件，背压由 `pipeline` 传导；任何时刻内存里只有流的缓冲。
- **上限在读取过程中强制**：`Content-Length` 已超过上限 → 不读请求体直接拒绝；没有可信的 `Content-Length`（分块传输）或它撒谎 → 计数到超过上限的那一刻停止读取、销毁流、删掉临时文件、拒绝。两种情况都是 413 `upload_too_large` 并写一条 `upload.reject` 审计。
  这条路由不能让框架的 body limit 抢先把超限变成 400（content-parser 归属集的映射）：流式 parser 不经过框架的缓冲限额，上限完全由 handler 执行；这一点由任务里的测试钉住（超限恰为 413 而不是 400）。
- **半截文件**：客户端中断、流错误、超限、磁盘写失败，都删除临时文件；临时文件名以 `.upload-` 开头、`.part` 结尾，只有成功才以最终名字出现。进程崩溃可能留下 `.part`：不清扫（Non-Goals），写进部署文档。
- **进度与取消**：web 用 `XMLHttpRequest`（`upload.onprogress` 给进度，`abort()` 取消）；`fetch` 没有上传进度。这是 `web/src/lib` 里唯一不走 `fetch` 的请求，放在单独的文件里，错误信封与 401 通知沿用同一套解析。
- **超时与反向代理**：Fastify 的 `requestTimeout` / `connectionTimeout` 缺省为 0（不限），服务端代码里没有改过；任务里以一条断言钉住这两个值，免得日后有人设了一个对 500 MiB 上传不够的值。
  反向代理要放开请求体大小并关闭请求缓冲，否则代理会先把整个文件收完再转发（进度失真、代理磁盘被占）——写进部署文档（tasks 组 19）。

否决：分片上传 / 断点续传（协议与清理复杂度不值，Non-Goals）；先传到沙箱外的暂存区再移入（跨文件系统时 `rename` 退化为复制，且多一个要清理的地方）。

### D11 上传的落盘：沙箱解析、`uploads/`、独占创建、硬链接定名

handler 的次序（每一步失败即止，括号里是结果）：

1. 认证（401）→ 空间归属（他人或不存在一律 404，不读请求体、不写审计）。
2. `name` 必须是 query 里恰一个字符串（缺失或重复 → 400）。
3. `Content-Length` 超限 → 413 + `upload.reject` 审计，不读请求体。
4. `sandbox.resolve(principal, id, "uploads/" + name, "write")`：含 `..` 分量、NUL、`uploads` 或其下已存在分量是符号链接、最后一段含反斜杠等 → 403 `sandbox_denied` + `sandbox.reject` 审计（既有 facade 行为，`op` 记为 `write`）。
   这一步在名字的其它校验之前：`../../x` 这样的名字是越界尝试，必须留痕，不能被「名字里不能有斜杠」的 400 抢先。
5. 名字的其余规则：解析后的目标必须直接位于 `uploads/` 之下（名字里带 `/` 的嵌套路径 → 400）；1 到 255 个 UTF-8 字节；不含 U+0000–U+001F、U+007F；不以 `.upload-` 开头（留给临时文件）。违反 → 400，不写审计（请求体校验层，与工作空间 `dir` 的 400 同一条边界）。
6. `uploads/`：不存在则经 `ensureSharedDir` 建（`0o2770`）；存在但不是普通目录 → 409 `conflict`。
7. 在 `uploads/` 里独占创建临时文件（`wx`，mode 精确 `0660`，不随 umask），流式写入并计数（超限见 D10）。
8. 定名：对候选名依次 `link(临时文件, 候选)`，`EEXIST` 就换下一个——`a.pdf`、`a (1).pdf`、`a (2).pdf` … 到 `(999)`；成功后删除临时文件。全部占用 → 409 `conflict`。
   编号插在最后一个扩展名之前（没有扩展名则接在末尾；以点开头且没有别的点的名字视为没有扩展名）。`link` 是原子的「不存在才创建」，并发上传同名文件各得其名，谁也不覆盖谁——Node 没有不覆盖的 `rename`。它要求所在文件系统支持硬链接：本地沙箱目录满足；S1b 的远程挂载若不支持，届时由 S1b 给出替代的定名方式。
9. 写审计 `file.upload`（`title="上传文件 uploads/<最终名>"`，`detail={path, size}`）→ 201 `{path, name, size}`。审计失败 → 500，文件可能留下（与新建目录的既有规则一致，不承诺文件系统回滚）。

- **mode `0660`**：`OMP_USER` 模式下 omp 以另一个 uid 运行，靠 `uploads/` 的 setgid 组位读写这些文件；托管文件的 `0640` 是给只读配置用的，不适用。
- **竞态**：`resolve` 之后、打开之前，omp 进程可以把 `uploads` 换成符号链接。独占创建不跟随最后一段的符号链接，但挡不住父目录被替换。这与工作空间里其它「先 resolve 后操作」的端点同一类窗口，
  且能利用它的只有会话自己的 omp 进程（它本来就能直接写那个位置）；登记在 Risks，不在本 change 引入 `openat` 式的目录句柄操作。
- **只读挂载、配额**：S1b 未交付，不涉及；磁盘写满按普通写失败处理（500，临时文件删除）。

### D12 附件如何随消息走

- **请求**。`POST /api/sessions/:id/prompt` 的 body 从「恰 `message`」变为 `{message, attachments?}`；`attachments` 是 0 到 `UPLOAD_MAX_FILES` 个互不相同的字符串（**每条消息的附件总数上限就是这个数**，owner S-23：与「一次最多 10 个」同一个可配的数，不设第二个配置项），每个是相对会话工作空间根的路径（上传返回的 `path`）。`[]` 与缺席等价。
  **只发附件、不发文字是允许的**（owner 2026-10-06 改判；原先起草者定的是「不支持」）：`message` 去掉首尾空白后为空时，只要 `attachments` 非空且通过下面的全部校验，就受理（202）。`message` 为空且无附件仍是 400；`message` 键仍必须出现且为字符串。空文本带附件时请求的去留只看附件校验的结果，不因文本为空被拒。
  这件事不引入新的规范化，也不引入新的分支（配套细节由起草者按最小改动定，列在 D17 第 4 条）：
  - **落库**：现有规则是「去掉首尾空白一次，存去掉之后的文本」（chat-sessions「REST prompt 受理与补偿」的 trimmed original text，`rest.ts` 的 `trim()`）。只发附件时照这条规则存下来的就是空串——不是 NULL，也不保留用户留下的空白。主规格里没有「原样保存空白」这回事，所以不存在「纯空白原文」这种落库值。
  - **分类**：`classifyPrompt("")` 不以 `/` 开头，是普通文本；空文本不是命令。「内建命令不得带附件」照旧（` /todo` 去掉空白后仍是内建命令，带附件 400）。
  - **标题**：新会话的第一条消息只有附件时没有文字可取，标题取第一个附件路径的文件名（最后一个 `/` 之后的部分），按现有标题规则的同一截断（前 18 个码点、不加省略号）。有文字时规则不变。规则落在 chat-sessions「会话持久化与回合刷盘」（`acceptPrompt` 定标题的地方），所以本 change 对该条有一条 MODIFIED（底本是主规格，C 未改）。
- **校验（都在受理之前）**。带附件而会话没有工作空间 → 400；每个路径 1 到 1024 字节、不含控制字符、不以 `/` 结尾，否则 400；每个路径经 `sandbox.resolve(op=read)`（越界 → 403 + 审计）；目标须是已存在的普通文件，否则 400；
  文本分类为内建命令（`classifyPrompt` → `builtin`）而带附件 → 400（后缀会变成本地命令的参数）。技能调用可以带附件（后缀成为技能的参数文本）。不限定路径必须在 `uploads/` 下：同一空间里的任何文件都能被这条消息指到，文件页日后要做「引用文件」时不必改合同。
- **落库**。迁移 042 给 `chat_messages` 加 `attachments TEXT NULL`；`acceptPrompt` 把 `[{path, size}]`（`size` 取受理那一刻的文件大小）写进用户消息行，无附件为 NULL。快照的每条消息带 `attachments` 数组（NULL 读成 `[]`，与 `approvals` 同一做法）。
- **给 omp 的文本**。落库的 `content` 仍是用户原文；交给 omp 的是 `toWireText(text, skills)` 再接一个确定的后缀：两个换行、一行固定说明 `用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：`、然后每个路径一行 `- <path>`（请求里的次序）。
  会话绑定工作空间时进程的 cwd 就是空间根，相对路径直接可用。标题仍取用户原文的前缀（只发附件时取文件名，见上）。
  空文本不另写分支：`toWireText("", skills)` 是空串，交给 omp 的就是后缀本身——以两个换行开头的一段文字。
- **分支对齐**。带附件消息的 wire candidates 是原有候选各自接上同一后缀（由落库的 `attachments` 重新算出）。只发附件的消息同理：`content` 为空串，候选恰一个，就是后缀本身。重新生成沿用 branch 返回的文本（已含后缀），用户消息行不动，气泡照旧显示附件。
  分叉把被拷贝消息的 `attachments` 原样拷走；分叉点那条消息不拷贝、其文本作为 `draft` 返回，它的附件随响应的新键 `attachments` 返回，web 用它恢复附件标签（文件在同一个空间里，分叉继承空间绑定）。
- **撤回**（owner S-24）：见 D19。
- **先核对（omp 是否原样保存以换行开头的文本）**。只发附件的消息交给 omp 的文本以两个换行开头。读到的证据只有一条相邻的：v18.0.10 的技能分派对文本做 `trimStart()`（ADR-0012），而用户条目的文本保留开头的一个空格（omp-test-harness 的 ` /help 这是什么` 一例、既有的转义空格候选都依赖它）。这说明不了开头的换行会不会被存下来的条目裁掉，也说明不了 RPC `prompt` 收不收这样的文本——所以不猜，列为实机核对项 (g)（tasks 1.8）：对官方二进制发一条文本恰为附件后缀的 prompt，回合结束后 `get_branch_messages` 最后一项的 `text`、以及对它 `branch` 的应答 `text`，都与发出的文本逐字节相等。
  **退路**：(g) 不成立（omp 裁掉或改写了开头的空白）→ 只发附件的消息的 wire candidates 改为「omp 实际存下的那种形式」——候选集合里把后缀本身换成（或加上）实测得到的裁剪结果，只对 `content` 为空串的带附件消息如此；受理时发出的文本不变。先改 message-attachments「重新生成与分叉中的附件」与 chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment 两处 delta，再做组 12。(g) 若是 omp 根本不收这样的文本（RPC 报错或回合不产生 `user` 条目）→ 停下回到 owner：只发附件需要另一种 wire 形式，那就不是「不另写分支」了。
- **不走事件流**。事件里没有用户消息内容；页面在受理后用自己手里的草稿与附件呈现用户消息，刷新后来自快照。

否决：把路径拼进落库的 `content`（气泡里出现一段机器话，分叉回填的草稿也带着它）；用 RPC `prompt` 的 `images`（只支持图片，且要把文件读进内存转码）；`@path` 写法（omp 的 `@` 文件展开是 CLI 参数层的行为，RPC 里没有，读不到证据）。

### D13 上传目标与「没有工作空间」的情形

上传的目标是「会话的工作空间」，即会话视图的 `workspaceId`。**临时空间的寻址已定**（原开放项关闭）：C 的 temporary-workspaces「临时空间的创建」规定临时空间是一行 `temporary = 1` 的 `workspaces` 记录、`id` 为随机 32 位小写十六进制，「临时空间的可见性」规定 `rootOf` 对所有者自己的临时空间与正式空间同样返回根——所以 `POST /api/workspaces/:id/uploads` 与附件校验的 `resolve` 对临时空间不需要任何特例，web 也不需要知道 `temporaryWorkspace`。

- **已选会话、`workspaceId` 非空**：选完即上传。
- **已选会话、`workspaceId` 为 null**（只剩存量的未绑定会话：C 之后 REST 不再能建出这样的会话）：没有上传目标。`上传文件` 菜单项禁用并显示 `此会话没有工作空间，无法上传文件`；拖入或粘贴文件时在输入框上显示同一句，文件丢弃；不发任何请求。
- **欢迎页**：文件先留在浏览器里（标签状态 `待上传`）。首次发送时先建会话；建出的会话视图 `workspaceId` 非空 → 逐个上传、再带着路径发 prompt；为 null → 不上传、不发 prompt，恢复草稿与标签并显示上面那句，新会话保持选中（零消息）。
  用「建出来的会话有没有空间」判断，而不是「发送前选没选空间」：未选空间的新会话得到临时空间（`workspaceId` 非空），照常上传；`workspaceId` 为 null 的分支在真实服务端上已不可达，保留它只为 web 不对服务端的视图做假定（假 API 下可测）。
- 上传中途失败：不发 prompt，草稿与未传完的标签留着，已传完的标签保持已上传。会话已经建出（零消息），与「首次发送被拒」同一状态。

**文件的去留跟着工作空间走**（原「不随会话删除」的说法加限定）：上传的文件是工作空间里的普通文件。绑定正式空间的会话被删除、消息行被删除或补偿，都不动它；但 C 的两条既有规则照常适用——会话用临时空间且它是最后一个引用者时，删会话即删整个临时空间目录（含 `uploads/`）；撤回并连文件还原时，工作空间回到被撤回消息受理那一刻，其后才上传的文件被移除。发消息之前上传的文件在该消息的快照里（超过 C 的单文件快照上限的记为 `skipped`，还原时不碰），所以撤回一条消息不会删掉它自己的附件。

### D14 能力行布局与三个控件

一行，`data-slot="composer-toolbar"`：左组依次为「+」菜单、工作空间、权限档位；右组为模型、推理强度，其后是既有的 `生成中` / `停止` / `发送`。

- **「+」菜单**。现有规则是草稿非空时整个按钮禁用（因为点选命令会覆盖草稿）。放进 `上传文件` 之后这条规则不能留在按钮上——打了字就不能加附件说不通。改为：按钮只在输入框锁定时禁用；菜单第一项是 `上传文件`，其后是命令目录；
  草稿非空时命令条目不可选并显示一行 `清空输入后可选择命令`（斜杠候选的条件不变）。按钮的可访问名从 `技能与命令` 改为 `添加文件或命令`：菜单里不只有技能与命令了。这个名字被测试、走查与清单行引用，任务里逐处改。
- **权限档位**。按钮文字是当前档位名，可访问名 `权限：<档位名>`；点开是拷入层 dropdown-menu 的单选组（`menuitemradio`），只列 `options.approvalModes`，每项一行说明，底部一行 `更改从下一条消息起生效`。
  选 `全部自动` 先弹确认框（拷入层 alert-dialog）：标题 `切换到全部自动？`，正文 `助手将不经确认直接执行命令与修改文件。`，按钮 `取消` / `确认切换`；确认后才提交，取消则保持原值。当前档位是 `全部自动` 时按钮用警示色（`--wb-status-warning-text` 一组 token）。
  只有一个可选档位时仍显示（只读地告诉用户现在是什么档），菜单里只有那一项。
- **模型与强度**。模型按钮文字是显示名（过长截断，完整名在 `title`），可访问名 `模型：<名>`；菜单每项带能力标签 `推理` / `看图`。强度按钮只在当前模型支持推理时渲染，可访问名 `推理强度：<档位名>`。
- **生成中可改**：三个控件不随输入框锁定而禁用（owner 决定 4、14）；只在自己的提交在途时禁用。提交失败在输入框上显示信封文案，显示值回到服务端的值。
- **已选会话**：选择即 `patchSession`，以响应里的会话视图为准（换模型后强度可能被服务端解析成另一个值）。**欢迎页**：选择只改页面内存里的值，初值取 `options.defaults`；首次发送时只带用户在欢迎页实际改过的键，没碰的键不发、由服务端继承——`defaults` 是夹取后的有效值，原样发回会把账号存着的原始选择覆盖成夹取值，D3「上限调回后原始选择重新生效」就不成立了。
- **options 取不到**：三个控件都不渲染（不摆占位），其余照常；下次进入欢迎态或选中会话时重取。服务端仍按库里的值执行，界面只是暂时看不到。
- **窄屏（≤760px）**：工具行允许换行；左组在第一行，右组（模型、强度、`生成中`、`停止` / `发送`）放不下时整体落到第二行并靠右；工作空间标签与模型名各有最大宽度并截断。
  `发送` / `停止` 始终完整在视口内、文档没有横向滚动（既有走查断言保持）。不改成只有图标：三个中文档位名都只有四个字。

### D15 附件标签与用户气泡

附件标签在输入框的文本框上方、输入框容器之内（不在停靠区里：停靠区是任务清单与确认卡的地方）。每个标签：文件名、大小、状态（`待上传` / `上传中 <百分比>` / 无字样表示已上传 / `失败：<原因>`）、一个 `移除 <文件名>` 按钮。
移除上传中的标签会中止请求（服务端删掉半截文件）；移除已上传的不删文件。任何标签处于 `上传中` 或 `失败` 时不可发送。`发送` 的启用条件从「草稿非空」改为「草稿非空，或至少有一个附件且全部附件处于可发送状态（已上传，或欢迎态的 `待上传`）」；锁定等其余禁用条件不变，Enter 与按钮同一判定（现有代码里有两道闸：`composer-locks.ts` 的 `sendDisabled` 与 `use-chat-session.ts` 提交入口对空白草稿的提前返回，两处都要改）。发送被受理后标签清空；发送被拒时与草稿一起恢复。切换会话或回到欢迎态时标签清空（已上传的文件留在空间里）；此时在途的那个上传被中止、排队的撤掉，与逐个移除同一语义——否则 500 MiB 的文件会在一个已经没有界面可取消的会话里继续传完。欢迎态首次发送的上传阶段中途切走同理，不再发 prompt。
选择、拖入、粘贴走同一个入口函数：一条消息的附件总数超过 `UPLOAD_MAX_FILES`（本次选入连同已有标签）整批拒绝并提示 `每条消息最多 N 个附件`（owner S-23：提示说的就是实际规则）；单个超过 `UPLOAD_MAX_BYTES` 的那一个被拒绝并提示，其余照常。粘贴只在剪贴板带文件时拦截，粘贴文字不受影响。

用户气泡在文本下方列出附件：一个带可访问名 `附件` 的列表，每项是文件名与大小，纯文本、不是链接（预览入口属于 `s1f-files-page` 的侧边栏）。文本为空（只发附件的消息）时气泡只渲染这个列表，不渲染空的文本块；操作行照旧。「空」在快照里就是 `content` 为空串；页面在受理后自己呈现的那条按发送时的草稿去掉首尾空白后判定，两种来源呈现一致。
对话内搜索、复制等以 `content` 为输入的功能不为空文本加特例：conversation-search 的子串判断对空串自然不匹配（附件文件名不参与搜索）；用户消息的 `复制` 是 #908 的事，不在本 change。核对现有条文后有一处要跟着改：chat-web「会话页」的「Empty-whitespace sends SHALL be disabled」与新的启用条件矛盾，本 change 对该条加一条 MODIFIED（以 C 的 delta 为底），只把这句限定为「没有处于可发送状态的附件标签时」；同一条的欢迎态场景里「无权限设置、上传…无附件/模型…控件」与本 change 在欢迎态渲染这些控件矛盾，一并改到与「输入框与能力栏」一致。D 的同名 MODIFIED 随之以本 change 的文本为底。拷入层零改动，都在应用层。

### D16 键集变化分三步落地；与 C 重叠的 MODIFIED

**三步落地**。web 的 DTO 解析是「恰好键集」。服务端先发出新键，已合入的 web 会把整个会话列表判为非法响应，走查与冒烟立刻变红。本 change 开工时的键集是 C 之后的：会话视图十一键、消息含 `undo`、fork 响应 `{session, draft}`、undo 响应 `{session, draft, files}`。次序：

1. **web 先放宽**（组 5）。过渡期的接受规则只写在这里与组 5 的验收描述里，不进规格（规格只描述最终形状）：
   - 会话视图：接受十一键，或十一键加 `approvalMode`、`modelId`、`reasoningEffort` 三键；三键必须同时出现或同时缺席（只带其中一两个 → 整体拒绝）；缺席时解析为 `{approvalMode:"write", modelId:"", reasoningEffort:null}`（`modelId` 空串只在过渡期出现，表示服务端尚未报告）。
   - 消息：接受带或不带 `attachments`；缺席解析为 `[]`；助手消息非空 → 拒绝。
   - fork 响应与 undo 响应：接受带或不带 `attachments`；缺席解析为 `[]`。
2. **服务端发出新键**（组 8：会话三键；组 12：消息、fork、undo 的 `attachments`）。
3. **web 收紧**（组 13）：只接受十四键会话、带 `attachments` 的消息 / fork / undo 响应；`modelId` 空串非法；删掉第 1 步的全部分支及其测试。

过渡分支活不过这个 change；这是合同迁移，不是并行实现（AGENTS「Code Canonicality」的例外理由写在组 5 的任务里）。

**本 change 的增量恰为**（规格里的绝对数字都是「C 之后的值 + 这些增量」）：

| 项 | C 之后 | 本 change 的增量 | 之后 |
|---|---|---|---|
| 会话视图键 | 十一键 | `approvalMode`、`modelId`、`reasoningEffort` | 十四键 |
| 消息视图键 | `…,approvals,undo,steps` | `attachments` | `…,approvals,undo,attachments,steps` |
| fork 响应键 | `{session, draft}` | `attachments` | `{session, draft, attachments}` |
| undo 响应键 | `{session, draft, files}` | `attachments`（S-24） | `{session, draft, files, attachments}` |
| `POST /api/sessions` body 键 | `{workspaceId?, scene?}` | 三键 | 五键的子集 |
| `PATCH /api/sessions/:id` body 键 | `{title, scene, pinned, archived}` | 三键 | 七键的非空子集 |
| prompt body 键 | 恰 `{message}` | 可选 `attachments` | `{message}` 或 `{message, attachments}` |
| typed 错误码 | 十五码 | `upload_too_large`（413） | 十六码 |
| content-parser 归属身份 | 十四条 | `POST /api/workspaces/:id/uploads` | 十五条（其余十四条以 POST 归属） |
| 会话路由数 | eleven | 无（上传是 workspaces 路由，`GET /api/composer/options` 另注册、不计入） | eleven |
| 应用配置项 | 十九项 | `APPROVAL_MAX_MODE`、`MODEL_CATALOG`、`UPLOAD_MAX_BYTES`、`UPLOAD_MAX_FILES` | 二十三项 |
| 迁移 | 037–039 | 040、041、042 | 回执第 14–16 个 |
| 模型代理入参 | `{upstream, tokens}` | `allowedModels` | `{upstream, tokens, allowedModels}` |

**与 C 重叠的 MODIFIED**。OpenSpec 的 MODIFIED 是整条替换。下表每一条的底本都是 C 的 delta 文本（C 的 design D15 重叠表逐行核对过：C 的句子、场景与计数全部原样存活），「增量」列是相对 C 文本的全部差异——归档前的对底（任务 0.1）只允许出现这些。底本为「主规格」的行是 C 没有碰、本 change 独自修改的条文，列在这里是为了让 D 对底时一并看到。

场景标题规则：每条 MODIFIED 都原样保留主规格与 C 该条文现有的全部 `#### Scenario:` 标题——含义变了只改标题下的正文，不改名、不删（较新的 openspec CLI 与归档都拒绝丢标题的 MODIFIED）。因此有几处标题与正文的字面不再一致（如「八键会话…」的正文是十四键、「十一键接受…」的正文是十四键、「无权限元素与无匹配」的正文不再排除权限控件），以正文为准。

| 条文（capability / Requirement） | 底本 | 本 change 的增量 |
|---|---|---|
| chat-sessions / 会话 REST | C 的 MODIFIED | 新增句：创建 body 加三键及其规则引用、创建视图带三键的有效值；消息对象加 `attachments` 及其取值句；会话视图 eleven → fourteen keys 与三键的取值域；fork 事务复制三列原始值与消息 `attachments`；fork 响应 `{session,draft,attachments}`；`GET /api/composer/options` 由 registerSessions 另注册、不计入 eleven routes、不读会话、不是 content-parser 归属方（与 C 对 `/api/sessions/events` 的写法并列）。改写场景：「Stable public history and recent order」（`attachments` 数组、fourteen keys）、「Fork copies history before the chosen user message」（201 三键）、「Snapshot carries the stored task list」（fourteen keys）、「Session views carry the three extension keys」（fourteen keys）、「User messages carry an undo state」（消息键集加 `attachments`）。新增场景：「Session views carry the three composer settings」。路由数不变（eleven） |
| chat-sessions / REST prompt 受理与补偿 | C 的 MODIFIED | 新增句：body 键集 `{message}` 或 `{message,attachments}`；`acceptPrompt(…, attachments)`；派发文本为 `toWireText(…) + attachmentSuffix(paths)`（C 的 `snapshotStep` 第三参数与「无 await」原样保留）。改写句：C 的「trim the string once and require nonempty text of at most32768 UTF-8 bytes」改为「文本不超过 32768 字节；除非带非空 `attachments`，否则须非空」并加 `message` 键必须出现、空文本带附件只由附件校验决定去留两句；括注「persisted user content and the title rule are unchanged」改述为落库空串与标题取材；派发一句加「空文本不另写分支」。改写场景：「Input boundaries」（标题原样保留；WHEN 的「empty after trim」限定为无附件时）。新增场景：「Attachments are validated before admission」「Attachment-only prompt is admitted」 |
| chat-web / API 客户端扩展 | C 的 MODIFIED | 新增句：`createSession` input 加三键、prompt 带附件时的 body（含 `message` 原样发送、空串不省略一句；「新输入与两个新方法」里多一个空文本带附件的调用）、`forkSession` 响应加 `attachments`、「十一键」后的括注（另加三键共十四键）、`undoMessage` 的 200 加 `attachments`（S-24）、整段「S1g 输入框能力」（十四键逐键规则、消息 `attachments`、两个新方法 `getComposerOptions` / `uploadFile`、最终形状与落地次序的指引）。改写场景：「回合控制四方法请求与响应」（`forkSession` 的 201 带 `attachments`）、「撤回与转正方法」（200 body 带 `attachments`；缺 `attachments` 或其元素多键 → 无效响应）、「八键会话与思考、变更字段严格解析」（标题原样保留；WHEN 的会话项在 C 的十一键之后补三键成十四键，`null` 项加 `reasoningEffort`；THEN 的拒绝清单由「五键或八键」改为「五键、八键或十一键」）。新增场景：「三键与附件的严格解析」「新输入与两个新方法」「上传传输」 |
| chat-web / 消息线程 | C 的 MODIFIED | 新增句：气泡在文本下方列出附件；文本为空串的用户消息只渲染附件列表、不渲染空文本块；撤回成功后恢复仍存在的附件标签（S-24）；分叉回填 `attachments` 为附件标签；两处括注（分叉的 `draft`、撤回的原文在只发附件的消息上为空串）；「不提供编辑/分支/附件」一句的「附件」改述为「不使用 runtime 的附件适配器」。改写场景：「从用户消息分叉」（201 带 `attachments`、附件区一个已上传标签、无上传请求；另加在只有附件的消息处分叉一段）。新增场景：「只有附件的用户消息」。C 的 `撤回`、`从此处分叉` 两个按钮与次序、归档只读原样保留 |
| chat-web / 输入框与能力栏 | C 的 MODIFIED | 新增句：附件标签区；能力行分左右两组与次序（「+」、工作空间、权限 / 模型、强度）；三个新控件的数据来源与不随锁定禁用；「+」按钮改名 `添加文件或命令`、只在锁定时禁用、第一项 `上传文件`、草稿非空时命令条目不可选与提示行；「不渲染」一句收窄为专家与麦克风；窄屏规则。改写句：`发送` 的启用条件（草稿非空，或至少一个附件且全部处于可发送状态）；键盘规则末尾「空白草稿与锁定期间不可发送」随之改述。改写场景：「「+」菜单写入草稿」「输入框键盘发送」（标题原样保留；THEN 的「空草稿仍不可发送」限定为没有附件标签时，另加带附件的空白草稿可提交）。新增场景：「能力行的次序」「锁定时三个控件仍可用」「真实浏览器下能力行不挤出发送键」「选项读取失败后重取」。C 的只读标签四种取值（`任务启动于 临时空间` 在最前）与「草稿可被撤回覆盖」原样保留 |
| chat-web / 会话页 | C 的 MODIFIED | 改写句：「Empty-whitespace sends SHALL be disabled」限定为没有处于可发送状态的附件标签时（带可发送附件的空白草稿可以发送）。改写场景：「欢迎态与静态引导」（THEN 里「无权限设置、上传、专家控件」改为「无专家控件；权限档位、模型、推理强度控件与 `上传文件` 按「输入框与能力栏」渲染」，「无附件/模型/麦克风控件」改为「无麦克风控件、未选入文件时不渲染附件标签区」）。C 的其余句子与全部场景标题原样保留 |
| http-service-skeleton / 统一错误信封 | C 的 MODIFIED | 十五码 → 十六码（`upload_too_large` 及其 message、与 `preview_too_large` 共享 413 的一句）；归属身份十四 → 十五（`POST /api/workspaces/:id/uploads`，「其余十四条以 POST 归属」）；新增一段「流式 body 的归属路由」。改写场景：「auth POST 请求 parse/validation 错误稳定映射」（十五条）、「意外错误不伪装」（十六个）、「产品路由身份在共享映射器中的归属」（WHEN 的路由清单增 uploads；fifteen-identity）、「Cache policy remains route-owned」（sixteen typed errors）、「工作空间 parser owner 的真实 HTTP 边界」（fifteen-owner、thirteen other owners）。新增场景：「上传超限码的信封形状」「上传路由的 parser 归属」。C 的「归档与撤回冲突的错误码」「撤回与转正路由属于归属集」与无 body 创建得到临时空间的 THEN 原样保留 |
| http-service-skeleton / 服务启动与装配 | C 的 MODIFIED | 配置项十九 → 二十三（四个键名与缺省值 `yolo`、未配置、`524288000`、`10`）；四键的解析规则一句（含「白名单同时是模型代理放行的取值集合」）。改写场景：「干净启动与一致命令面」（二十三项；恰一个模型条目、档位上界与上传上限的缺省）。新增场景：「四个新配置键的取值与非法值」。C 的四个 `SNAPSHOT_*` 键、缺省值与解析规则原样保留 |
| http-service-skeleton / Shared agent module assembly | C 的 MODIFIED | 改写场景：「Pure source and compiled configuration identity」（nineteen → twenty-three application keys）。无其它差异 |
| session-metadata / 会话创建与空间绑定 | C 的 MODIFIED | 新增句：body 键集加三键及其规则引用；两种创建都写三项设置列；同事务更新最近选择、按 session-permission-tier 决定 `session.permission`（本条不复述条件）；201 视图带三键。改写场景：「无 body 与空对象按默认创建」（主规格的标题原样保留，正文是 C 的临时空间创建；WHEN 限定「账号没有最近选择」；十四键；三项设置为缺省有效值）。「他人与不存在的空间一致 404」同样保留主规格的标题（正文含 C 的临时空间一例）。C 的临时空间创建与其余场景原样保留 |
| session-metadata / 会话元数据修改 | C 的 MODIFIED | body 键集加三键；三键的规则引用一条；「不写审计」改为「除 `session.permission` 外不写审计」并加「不向 omp 发任何帧」。C 的 `archived` 规则与场景原样保留 |
| session-metadata / fork 继承会话元数据 | C 的 MODIFIED | 新增句：复制三列原始值；临时进程以源会话的有效档位与模型启动；不改最近选择、不写 `session.permission`。改写场景：「fork 响应的会话视图与列表一致」（十四键、三项设置与源会话相同）。新增场景：「继承三项设置」。C 的「继承临时空间」原样保留 |
| session-metadata / 会话视图扩展键 | C 的 ADDED | 「共十一键」后加括注（本 change 另加三键，合计十四键）；改写场景：「三键的取值」「各出口一致」（十四键） |
| session-sidebar / 会话 DTO 严格解析 | C 的 ADDED | 十一键 → 十四键与三键的逐键规则；`patchSession` / `createSession` 的输入键集加三键；落地次序一句改述。场景「十一键接受与其它键集拒绝」标题原样保留、正文改写为十四键（十三键、十一键、十五键、`approvalMode:"auto"` 都拒绝） |
| session-sidebar / composer footer 工作空间选择 | C 的 MODIFIED | 首句：由「能力栏最左侧（权限、上传与专家控件 SHALL NOT 渲染）」改为「能力行左组第二项（专家与麦克风 SHALL NOT 渲染）」。场景「无权限元素与无匹配」标题原样保留，THEN 的前半句改写为「无专家与麦克风控件」（权限控件此后由 session-permission-tier 规定为渲染）。其余（含 C 的临时空间各句与场景）原样保留 |
| turn-control / 从此处分叉 REST | C 的 MODIFIED | 新增句：临时进程的 `--approval-mode` / `--model` 取源会话有效值；新会话行复制三列原始值；拷贝消息带 `attachments`；201 加 `attachments`；`session` 带三键的有效值。改写场景：「正常分叉」（201 带 `attachments:[]`）、「fork 响应的会话视图与列表一致」（十四键）。新增场景：「分叉点消息的附件随响应返回」「分叉继承三项输入框设置」。C 的归档 409、不拷贝快照行、共用临时空间原样保留 |
| chat-harness / 会话元数据 HTTP 冒烟 | C 的 MODIFIED | 第 1 步：eleven → fourteen keys（`count == 14`）与三键的缺省值断言；第 3 步的 `eleven-key` → `fourteen-key`。改写场景：「绑定、元数据、思考与删除全链路」（fourteen-key）。C 的临时空间与归档步骤原样保留 |
| message-undo / 撤回 REST | C 的 ADDED | 200 加 `attachments` 及其取值、读出与存在性判定规则（S-24）；`draft` 的括注加「只发附件的消息为空串」。新增场景：「响应带回仍存在的附件」（含只有附件的消息一段） |
| message-undo / web 撤回 | C 的 ADDED | 200 时恢复附件标签一句；失败与丢弃响应两句各加「附件标签」；草稿回填一句加括注（`draft` 为空串时草稿被清空）。新增场景：「撤回带附件的消息恢复标签」（含只有附件的消息一段） |
| turn-control / 重新生成 REST | 主规格（C 未改） | 执行序两处：存活进程的启动档位不同时先退役；取得进程后、`get_branch_messages` 前对齐模型与强度及其失败映射。新增场景：「模型对齐失败发生在事务之前」「档位不同时先退役再重新生成」 |
| chat-sessions / 会话持久化与回合刷盘 | 主规格（C 未改） | `acceptPrompt` 签名加 `attachments`（及其出处的括注）；「Text SHALL be preserved」后加空文本存为空串；标题一句加取材（文本，或文本为空串时第一个附件的文件名）。主规格该条的十个场景标题与正文全部原样保留。新增场景：「Attachment-only admission titles from the first file name」 |
| model-proxy / 透传端点与 bearer 鉴权 | 主规格（C 未改） | `registerModelProxy` 入参加 `allowedModels`；整段 Model whitelist；改写场景：「Byte-preserving credential substitution」「Real two-round fake model」「Parser byte limit and sibling isolation」（请求带白名单内的 `model`）、「Missing configuration after valid authentication」（WHEN 写明不论 body 是否合法、`model` 是否在白名单内，结果不变：502）。新增场景：「Model outside the whitelist is refused」「Whitelisted model is forwarded untouched」「Default single-model whitelist」（D18） |
| session-metadata / 会话元数据审计、chat-sessions / Slash 命令白名单与命令目录、model-proxy / 托管 models.yml、omp-runtime 两条、omp-test-harness 两条、tool-approval / 审批请求识别、sandbox-core / resolve 契约与逃逸向量 | 主规格（C 未改） | 各自的 delta 即全部增量；其中 sandbox-core 一条 D 也改，D 以本 change 归档后的文本为底 |

C 新增而本 change 没有修改的条文（temporary-workspaces、workspace-snapshots、session-list-push、message-undo 的其余五条、session-todo、turn-artifacts、turn-control「stopped 终态」等）不受影响；本 change 的新条文引用它们时用的是 C 的条文名。
**派生的测试改动**：每个 generation 的首次派发多出 `set_model`（与可能的 `set_thinking_level`）两帧，经宿主驱动假 omp 并断言完整 `frames=` 序列的既有宿主测试随之改写（任务 9.2、9.5 点名）；假 omp 夹具自身的单元用例不经宿主，序列不变。

### D17 起草者自定的细节（起草者定，Epic 中列给 owner 知悉，不卡任何任务）

以下各项 owner 没有逐条拍板，由起草者在 grill 结论的范围内定下，规格与任务已按此写死；建 Epic 时列给 owner 知悉，owner 改判时各自只动所注明的一处：

1. **500 MB 取为 500 MiB**：`UPLOAD_MAX_BYTES` 缺省 524288000 字节，与既有的 1 MiB / 10 MiB 预览上限同一口径（D10；改判只改缺省值）。
2. **白名单项的 `efforts` 可把强度列表收窄**：未声明时列全部八项，声明后只列 `off`、所声明的子集与 `auto`（D9；grill 第 15 行「按 omp 支持的全部档位列出」的细化）。
3. **审计的三条边界**：创建时只有「原始档位非 NULL 且有效档位偏离缺省档」才写 `session.permission`；fork 继承不写；模型与强度的变化不写（D6）。
4. **只发附件、不发文字的配套细节**。原先这一条是「只发附件不发字不支持：`message` 仍须非空」；owner 2026-10-06 改判为**允许**（D12，owner 拍板的只有「允许」本身及其边界：空文本带通过校验的附件即受理，空文本无附件仍拒绝，`message` 键仍须出现且为字符串）。随之由起草者按最小改动定下的七点，owner 改判时各自只动所注明的一处：
   - 4a. **落库 `content` 是空串**：沿用现有规则（去掉首尾空白一次，存去掉之后的文本），不发明新的规范化；不存 NULL，也不保留纯空白原文（D12；chat-sessions「REST prompt 受理与补偿」、message-attachments「附件落库与快照」）。
   - 4b. **空文本不是命令**，按普通文本处理；「内建命令不得带附件」不受影响（D12；message-attachments「prompt 携带附件」第 3 条）。
   - 4c. **交给 omp 的文本不为空文本另写分支**：仍是 `toWireText(text, skills)` 加同一份附件后缀，空文本时就是后缀本身（含开头两个换行）；分支对齐的 wire candidates 同理。omp 是否原样保存这种文本未读到证据，列为实机核对项 (g)（D12 的「先核对」与退路；tasks 1.8）。
   - 4d. **新会话首条消息只有附件时的标题**：取第一个附件路径的文件名（最后一个 `/` 之后的部分），按现有标题规则的同一截断（前 18 个码点）；有文字时不变（D12；chat-sessions「会话持久化与回合刷盘」）。
   - 4e. **`发送` 的启用条件**：从「草稿非空」改为「草稿非空，或至少有一个附件且全部附件处于可发送状态」；有失败 / 上传中的标签、锁定等其余禁用条件不变（D15；chat-web「输入框与能力栏」、message-attachments「输入框附件标签」）。
   - 4f. **用户气泡**：文本为空时只渲染附件列表，不渲染空的文本块，操作行照旧；分叉返回的 `draft` 可以是空串、附件随 `attachments` 返回，撤回恢复同理（D15、D19；message-attachments「用户气泡中的附件」、chat-web「消息线程」、message-undo 两条）。
   - 4g. **对话内搜索、复制等以 `content` 为输入的功能不为空文本加特例**：空文本自然不匹配，附件文件名不参与搜索（D15；不改 conversation-search）。
5. **附件路径不限定在 `uploads/` 下**：会话工作空间内任何已存在的普通文件都可作为附件（D12；等于经 API 可以把空间内已有文件指给助手，文件页日后做「引用文件」不必改合同）。
6. **进程崩溃留下的 `.part` 不清扫**（Non-Goals）。
7. **撤回恢复的附件标签沿用所存的 `size`**，不在撤回时重新量文件大小（D19；与 fork 的做法一致）。
8. **代理拒绝白名单外模型用 400 `bad_request`**，不新增错误码、不写审计（D18）。

### D18 模型代理强制白名单（owner S-22）

代理在转发之前校验请求体顶层的 `model`：不在白名单内即拒绝，不到达上游。

- **在哪一步**。现有代理已经为了校验语法把 ≤4 MiB 的 body 完整缓冲并 `JSON.parse` 过一遍（`server/src/model-proxy/index.ts` 的 `parseJsonBytes`），解析结果随后丢弃、转发的是原始字节。白名单校验接在这一步之后，既有次序一处不动：认证（401）→ 上游配置（未配置 → 502，`authenticate()` 在 `onRequest` 里判定，早于任何 body 解析）→ 媒体类型 / 大小 / JSON 语法 → **`model` 校验** → 转发。它与其它 body 拒绝同级，只对已认证、已配置上游的请求生效。未配置上游时零上游请求，白名单校验排在其后没有安全损失；既有用例 `valid bearer with explicit undefined upstream is 502 before parser errors`（`server/test/model-proxy-auth.test.ts`）原样通过。
- **状态码与错误形状**：沿用代理对 body 的既有约定——400 `bad_request` 的统一信封、`no-store`、零上游请求；不回显所给的模型名。不新增错误码：对 omp 来说这就是一次被拒的请求，回合按既有的上游错误路径失败。不写审计：代理手里只有 bearer 对应的运行时，没有 Principal；拒绝次数出现在既有的请求日志里。
- **规则**：顶层必须是对象；恰一个解码后键名等于 `model` 的成员；其值是字符串且与白名单某个 `id` 逐码元相等。不是对象、缺 `model`、`model` 不是字符串、不在白名单 → 400。
- **重复键必须拒绝**。`{"model":"贵的","model":"白名单里的"}` 在 `JSON.parse` 下取后者，而上游的解析器可能取前者；body 又是原样转发的。只看解析结果的校验可以被这样绕过，所以要数顶层成员里键名等于 `model` 的个数（键名先按 JSON 字符串转义解码，`"mod\u0065l"` 也算）。body 已经通过 `JSON.parse`，是良构的，数顶层键只需一个跟踪深度与字符串状态的小扫描器（几十行，纯函数，单测）。
- **与字节透传共存**：校验只读，不改 body；放行的请求仍是原始字节与原 `content-type`。「不解析消息语义」收窄为「除顶层 `model` 的比对外不解析消息语义」：不读 `messages`、`stream`、`tools`，嵌套的 `model` 不看。
- **流式与非流式**：校验发生在请求侧、上游接触之前，与请求体里的 `stream` 无关；响应侧的流式透传一字不动。
- **缺 `model`、body 非 JSON、超大 body**：后两者是既有的 400（语法 / 4 MiB），先于本校验；缺 `model` 是本校验的 400。
- **白名单从哪来**：`registerModelProxy(app, {upstream, tokens, allowedModels})`，由 `createApp` 把 `resolveModelCatalog` 的 id 集合传进去；model-proxy 模块仍不读环境、不导入 sessions。未配置 `MODEL_CATALOG` 时集合恰为 `{MODEL_ID}`。
- **既有测试**：经代理到达上游的既有用例，其请求体要带白名单内的 `model`（任务 20.3 逐个点名改写）。

**先核对**（任务 1.4 的 (f)）：官方 omp v18.0.10 在新会话的第一个回合、一个工具轮、`set_model` 之后的回合、一个确实发出了上游请求的 `/compact` 回合里发往受控上游的**每一个**请求，其 `model` 都是托管 `models.yml` 里的 id。受控上游为此增加一个只读的请求记录端点（omp-test-harness「受控上游请求记录」）。
核对要覆盖 omp 自己发起的请求，不只是回合的主请求。从 v18.0.10 二进制的字符串能确认存在的自发请求路径：上下文压缩（`/compact`，另有 `compactionModel` 设置项）；会话标题生成（`generateSessionTitle`，按 `tiny` → `commit` → `smol` 角色取模型，取不到时回落到会话模型）；`modelRoles` 的 `smol` / `default` / `slow` 三个角色（`tiny` 缺省指向 `smol`、`advisor` 缺省指向 `slow`），其中 `smol` 另被编辑自动修复、提交信息生成、记忆抽取使用。
用例里点名的触发步骤有两个：`/compact` 回合（产品白名单内建命令，真实用户会触发）与新会话的第一个回合（标题生成的时机；宿主 argv 带 `--no-title`，预期不产生标题请求，请求记录用来证实）。其余角色在 RPC 模式与宿主 overlay 下是否发请求、发什么名字，无法从二进制确认，以受控上游的请求记录为准：核对期间记录到的全部 `model` 值都须在白名单内。`/compact` 一步必须真的发出上游请求，零观察不算通过：v18.0.10 的 `compaction.keepRecentTokens` 缺省 20000，历史全部落在保留区时手动压缩直接报 `Nothing to compact (session too small)`，不发任何请求。所以用例在 cwd 预置 `.omp/config.yml` 把 `compaction.keepRecentTokens` 设为 1、把 `compaction.methodOrder` 钉为 `[soft]`（v18.0.10 的手动压缩按 `compaction.methodOrder` 选方法（缺省次序 `remote`、`snapcompact`、`handoff`、`shake`、`soft`）：`snapcompact` 在会话模型的 `input` 含 `image` 时入选且不发 LLM 请求，只有 `soft` 一定走上游；不钉次序时这一步可能零请求结束而与模型名无关；该键在项目层可配：隔离 `HOME` 下 `omp config get compaction.keepRecentTokens` 缺省输出 20000，cwd 预置后输出所设的值；宿主 overlay 不钉 `compaction.*`），`/compact` 排在换模型后的回合之后、只发一次；该预置在 RPC 会话里不生效时，改为在它之前用一条 200 000 字符的用户消息把历史撑过缺省保留区（任务 1.4 的备选；`methodOrder` 的预置保留）。断言：该步新增上游请求数 ≥ 1、输出不是 `Nothing to compact` / `Already compacted`、全部 `model` 在白名单内。用例同时记下每一步各自产生了几条上游请求，写进任务 1.6 的结论，并写明第一个回合是否确无标题请求。
**退路**：(f) 不成立有两种情形，处理相同——停下回到 owner，组 20 不合入。其一，出现 `models.yml` 之外的模型名（例如某个内部角色用了写死的名字）：强制白名单会打断那个角色，是把那些名字也纳入白名单、还是放弃强制，由 owner 定。其二，主手段与备选都没能让 `/compact` 一步发出上游请求：压缩路径用什么模型名没有被观察到，不能据此上线强制白名单。

否决：按会话校验（bearer → 会话 → 该会话的有效模型）——要让代理读会话状态，且 omp 的内部请求未必用会话当前模型，owner 只要白名单；改写 `model` 为缺省模型（悄悄换模型比拒绝更难排查，且破坏字节透传）；403（代理对 body 的拒绝一律是 400，403 在本项目里是沙箱与账号停用的语义）。

### D19 撤回带附件的消息：响应带回仍存在的附件（owner S-24）

仿 fork：C 的 `POST /api/sessions/:id/undo` 的 200 在 `{session, draft, files}` 之外加 `attachments`，web 用它恢复输入框的附件标签。

- **`draft` 可以是空串**：被撤回的是只发附件的消息时，`draft` 为空串（它所存的 `content`），附件照下面的规则带回；web 把草稿清空并恢复标签，此时 `发送` 因有可发送的附件而可用（D15）。
- **取值**：被撤回消息所存的 `[{path, size}]` 里，撤回完成后仍然存在的那些，按存储次序；元素原样（`size` 是受理时的记录）。没有附件或都不存在 → `[]`。
- **何时读、何时判**：所存的数组在撤回事务删除该消息行之前读出；存在性在文件还原（`files` 不是 `keep` 时）之后判——还原可能把助手删掉的附件恢复回来。判据与受理时相同：沙箱 `resolve(op=read)` 通过且 `lstat` 是普通文件。
- **不写审计、不失败**：这是服务端读回它自己受理时校验过的路径，不是用户请求；用不写审计的纯解析函数，被拒或出错都按「不存在」处理，撤回照常 200。
- **分支对位**：带附件消息在 omp 里的条目文本带附件后缀，撤回的对位用与 regenerate / fork 同一份 wire candidates（D12），否则带附件的消息及其之后的消息一律 502。
- **web**：200 时把附件标签设为响应所列各项（已上传状态），覆盖已有标签（在途上传中止），与草稿回填同时；不发上传请求。失败时标签不变。
- **落点**：对 C 的 message-undo「撤回 REST」「web 撤回」的 MODIFIED（以 C 的 ADDED 文本为底）；实现落在 C 的 `sessions/undo.ts` 与 `store-undo.ts`（任务 12.6），web 落在 C 的撤回 handler（任务 17.5）。

## Risks / Trade-offs

- **`全部自动` 是 Critical Path 上的放宽**：助手不经确认执行命令。缓解：管理员可封顶（`APPROVAL_MAX_MODE`）；选择时确认；常驻警示色；每次变化与每个非缺省档的新会话都有审计；omp 以独立 uid 运行（ADR-0010），能触及的范围不变。组 7、9 标注白盒审查。
- **`全部自动` 会被新会话继承**（owner S-21，已定）。缓解：警示色在欢迎页就可见；创建时写审计；管理员可用 `APPROVAL_MAX_MODE` 整体关掉这一档。
- **`always-ask` 下确认很多且 60 秒自动允许**：每次写文件都弹卡，无人值守时等于 60 秒延迟后的全部允许。这是 owner 决定 3 的原意（各档相同），在档位说明文字里不夸大它的保护力。
- **未实测的 omp 行为**（D2、D7、D8、D9、D12 的「先核对」）：若核对不成立，退路都要先改规格。缓解：核对是组 1，其它组在它之后；每条退路已写明。
- **只发附件的消息的 wire 文本以换行开头**（D12）：omp 若不原样保存它，这类消息的重新生成、分叉与撤回对位全部 502。缓解：核对项 (g)（任务 1.8）在组 12 之前跑，退路已写明。
- **只发附件的会话标题是文件名**：`image.png`、`截图.png` 这类名字区分度低。可接受——用户可以改名，且有文字时规则不变。
- **换档后的第一条消息变慢**：多一次进程启动。可接受（与空闲回收后的第一条相同）。
- **每个新进程无条件 `set_model`**：会话文件里每个 generation 多一两条变更记录。无害；核对 (e) 之后可以放宽，但不在本 change。
- **代理强制白名单会拦住 omp 自己发的请求**（D18）：若真实 omp 在某个内部角色上发出 `models.yml` 之外的模型名，该角色的请求会被 400。缓解：任务 1.4 的核对项 (f) 在官方二进制上记录每一个请求的 `model`，其中 `/compact` 一步须确有上游请求（零观察按不成立）；不成立即停下回到 owner，不带着一个会打断 omp 的代理上线。
- **代理的 JSON 解析与上游的不一致**：重复的 `model` 键在不同解析器下取值不同。缓解：重复键一律拒绝（规格与变异证据都钉住）；其余差异（非 UTF-8、超深嵌套）不改变「放行的字节里顶层 `model` 唯一且在白名单内」这一事实。
- **白名单按全局而不按会话**：会话 A 的 bearer 可以请求白名单里会话 A 没选的另一个模型。这是 S-22 字面的范围（Non-Goals），费用边界仍是管理员给出的清单。
- **上传的符号链接竞态**（D11）：窗口内 `uploads` 被本会话的 omp 进程换成符号链接，文件可能写到 omp uid 本来就能写的别处。不扩大该 uid 的能力；app uid 与 omp uid 不同时，app 可能替 omp 写到 app 可写而 omp 不可写的位置——
  `SANDBOX_ROOT` 之外 app 可写的只有它自己的状态目录，部署前提（ADR-0010、ADR-0012）已要求两者分离；组 11 标注白盒审查，并以一条「resolve 后替换为符号链接」的测试记录现状。
- **大文件占满磁盘**：500 MiB × 并发 × 用户数。没有配额（S1b / 后续）。缓解：上限可配；失败即删临时文件；部署文档写明。
- **`.part` 残留**：进程崩溃时留下，出现在文件页的目录列举里。不清扫（Non-Goals），写进部署文档。
- **上传期间文件页可见临时文件**：`uploads/` 列举会看到 `.upload-….part`。可接受；文件页重写（D change）若要隐藏它们，那边加一条过滤。
- **「+」按钮改名**波及既有测试、走查与清单行：一次性改完，任务里列了位置。
- **审计量**：`always-ask` 下 `session.approval` 行数明显增加（每次写文件一条）。审计表只追加、无清理策略——既有事实，不在本 change 处理。
- **键集三步走期间**（组 5 到组 13 之间）web 接受两种形状：过渡分支有测试，组 13 删除时有反向断言。
- **条文底本依赖 C 的归档文本**：本 change 的十九条重叠 MODIFIED 以 C 当前的 delta 为底。C 在实现期若再改这些条文，本 change 的同名条文要跟着改。缓解：任务 0.1 在 C 归档之后、本 change 归档之前用当时的主规格逐条 diff，差异只允许是 D16 表里列的增量。
- **撤回响应的附件存在性是「那一刻」的事实**：判定之后文件仍可能被别的会话或助手删掉，届时带着它发 prompt 会得到 400（附件须是已存在的普通文件），用户移除该标签即可。不为此加锁。

## Migration Plan

数据库迁移（都只在既有 runner 的事务里 `ADD COLUMN` 或建新表，无回填、不重建表）：

- `040_chat_session_composer.sql`：`chat_sessions` 加 `approval_mode`、`model_id`、`reasoning_effort` 三个可空列（两个带 CHECK）。
- `041_account_composer_prefs.sql`：建 `account_composer_prefs`。
- `042_chat_message_attachments.sql`：`chat_messages` 加 `attachments TEXT NULL`。

037–039 属于 C（已先行落地）、043–045 属于 D；回执必须是已发现迁移文件的连续前缀，所以 040–042 排在实施时目录里已有的最后一个文件之后即可，但不得先于 037–039 进入任何持久库：某个库先应用了 040、之后目录里才出现 037–039，它的回执就不再是连续前缀，`openDb` 会失败。所以组 4（连带组 8、12）在 C 的迁移 PR 合入之后才合入——即既定的 C → S1g 次序；其余各组不受此限。

落地次序（每一步合入后主干保持绿）：组 0 对底 → 组 1 核对 → 组 2–4 配置、models.yml、迁移（都不改变行为：缺省配置下输出与今天相同，新列无人读写）→ 组 20 代理白名单（缺省配置下白名单恰为 `MODEL_ID`，真实 omp 只发这个名字，行为不变）→ 组 5 web 解析放宽 → 组 6 假 omp → 组 7 运行时（argv 取值的入参仍由调用方给 `write`）→ 组 8 会话设置的存储与 REST（此刻起键集变化、设置可改但尚未影响进程）→ 组 9 supervisor 对齐（档位与模型开始真正生效）→
组 10–12 沙箱、上传、附件 → 组 13–17 web → 组 18 冒烟与走查 → 组 19 文档。组 8 与组 9 之间有一小段「能改不生效」：界面在组 14 之后才出现，这段时间只有直接调 API 才碰得到，可接受。

回滚：代码回滚到上一版本即可；三个迁移留下的列与表对旧代码不可见（旧代码不读它们），不需要反向迁移。回滚后会话回到 `write` 与单模型；`uploads/` 里的文件留着。

## Open Questions

没有卡住任何 task 或 requirement 的开放项。仅余一条验收期的观察项，不影响实现：

1. **推理强度的 `auto` 与 `off` 在所配上游上的实际效果**。组 1 只核对 omp 报告的状态与发出的请求体，不核对真实模型的行为；由 owner 在验收时对真实上游确认（任务 15.4 的清单行）。结论若是某个取值在该上游无效，改法是管理员在 `MODEL_CATALOG` 里用 `efforts` 收窄，不需要改代码。

原开放项的去向：1（代理是否强制白名单）→ owner S-22，D18；2（临时空间寻址）→ D13，引用 C 的 temporary-workspaces；3（`.part` 清扫）→ Non-Goals；4（`全部自动` 继承）→ owner S-21，D4；5（每条消息的附件数上限）→ owner S-23，D12；6（撤回与附件）→ owner S-24，D19。

## Not yet specified

- 配额与清理：`uploads/` 的总量上限、过期清理、按账号的磁盘配额——要等 S1b（挂载）与部署形态明确后才能说清问题。
- 附件在气泡里点开预览、下载：依赖 `s1f-files-page` 的侧边栏与下载端点落地后才能定入口。
- 管理员在运行期调整最高档、白名单与上限（不重启）：需要先有管理界面与配置存储的方向（P3 账号与治理）。
- 模型切换后旧上下文超出新模型上下文窗口时的表现：取决于 omp 的压缩行为与每个模型的窗口声明（本 change 用固定值），问题还说不精确。
- 读屏下三个下拉控件与附件标签的实际朗读效果：结构按拷入层组件的语义给出，未做真实读屏验证。

## Sketch seams under test

- **服务端 REST 整体挂载**（`createApp` + 真 SQLite + 假 omp 真子进程）：会话设置的创建 / 修改 / 继承 / 夹取 / 审计、`GET /api/composer/options`、带附件的 prompt、快照与 fork 的键集——最高的 seam，一条用例同时钉住路由、store 与事务。
- **supervisor + 假 omp 真子进程**：换档后下一条 prompt 的新 generation（epoch、`--resume`、argv 的档位）、在途回合不受影响、`set_model` / `set_thinking_level` 的帧序（经假 omp 的入站帧记录）、失败补偿。
- **上传路由的真实 HTTP**（真 socket、真文件系统临时目录）：流式落盘、读取中超限、客户端中断后的清理、同名并发、越界与符号链接——必须是真流，注入式请求测不出背压与中断。
- **`resolve` 纯函数**与 **`agent-config` 解析纯函数**、**`models.yml` 写出器**、**代理的顶层 `model` 扫描器**：各自的单元层（表驱动）。
- **模型代理的真实 HTTP**（`createApp` 或单独挂载 + 记录型真上游）：白名单外 / 缺失 / 重复 `model` 的 400 与零上游请求、白名单内请求的字节透传、流式响应不受影响。
- **官方 omp 二进制对照用例**（`WORKBUDDY_OMP_TEST=1`，uid-isolation job）：组 1 的全部核对项，以 omp 自己的 RPC 应答与受控上游收到的请求为准。
- **web 整页挂载**（jsdom、假 API、假 EventSource）：能力行的次序与可达性、档位确认框、模型与强度切换、附件标签的全部状态、欢迎页暂存到首次发送的请求序列、用户气泡。上传传输层以可控的 `XMLHttpRequest` 替身测进度、取消与错误信封。
- **web DTO 解析单元层**：键集的放宽与收紧。
- **冒烟（Hurl，真栈）与 ui-walk（真浏览器）**：上传一个文件并让它出现在目录树、改档位后的会话视图；能力行在两种视口下不挤出发送键、档位确认框、附件标签。

## 实机核对结果（2026-10-07）

官方 omp v18.0.10 二进制对照用例的结论。权威输出是 CI uid-isolation job（linux-x64）：D2 与 (g) 见 PR #1139、PR #1151 各自的 job 输出（(g) 为 run 37577719753）；D7、D8、D18 见 PR #1159 的 run 37604867418（四个对照文件 40 例通过、无 skip；`omp-official-model-commands.test.ts` 的每个观察值以 `[model-commands] ` 行打印）。本机 darwin-arm64 的结果与之逐项相同（`/compact` 输出里的 token 数除外）。

**三项不成立，待 owner 决定；在那之前本节只记结论，规格、任务与受影响 issue 的正文都还没有按退路修订，组 7 之后的 issue 不开工。**（(f) 成立，组 20 的前提不受影响。）

### 逐项结论

| 核对项 | 任务 | 结论 | 观察 |
|---|---|---|---|
| D2 (a) overlay 原样、argv `always-ask` 时 `write` 发起审批 | 1.1 | 成立 | write、bash 回合各恰一条审批 |
| D2 (b) argv `yolo` 时不发起审批 | 1.1 | 成立 | bash、write 回合都是 0 条审批，工具都执行 |
| D2 (c) `always-ask` 下项目层 `tools.approval: {write: allow}` 不绕过 | 1.2 | 成立 | 仍发起 `write` 审批 |
| D2 (d) 换档后 `--resume` 历史仍在、新档位生效 | 1.3 | 成立 | 会话文件不变，新档位下恰一条 `write` 审批 |
| D12 (g) 以换行开头的文本被原样保存 | 1.8 | 成立 | 以两个 U+000A 开头的 prompt 文本逐字节相等：`get_branch_messages` 末项与 `branch{entryId}` 的应答都等于发出的文本，回合多出恰一个条目 |
| D8 (a) `set_model` 后 `get_state.model` 为所选 | 1.4 | 成立 | `provider` `workbuddy`、`id` `workbuddy-second` |
| D8 (b) / D9 每个可选强度 v 之后 `thinkingLevel === v` | 1.4 | **不成立** | 见「强度」 |
| D8 (c) 两个命令前后托管 `HOME` 下全局配置逐字节不变 | 1.4 | 成立 | 比较的是 `HOME` 下全部常规文件：`.env`、`.omp/agent/host-overlay.yml`、`.omp/agent/models.yml`，路径集合与 sha256 全等 |
| D8 (d) 换模型后的回合带新 `model` 与此前的历史 | 1.4 | 成立 | 请求体 `model` 为 `workbuddy-second`，消息 6 条（第一个回合两条请求为 3、5 条） |
| D8 (e) `--resume` 后不发命令的 `get_state`（观察值） | 1.4 | — | 模型回到 argv `--model` 的 `deepseek-v4.1-flash`，强度是会话里最后设的 `low`。模型以 argv 为准（会话里的模型变更不被恢复），强度则是会话文件里的旧值（`PATCH` 只写库，它可能已过时），所以「每个 generation 的第一次派发总是应用」是必要的，不能放宽 |
| D7 带 `thinking` 与 `input` 两键的条目被接受且回显一致 | 1.5 | 成立 | `thinking: {mode: effort, efforts: [low, high]}`、`input: [text, image]` 原样回显 |
| D7 只写 `reasoning: true` 的条目报出的强度集合 | 1.5 | **不成立（退路未写的情形）** | `deepseek-v4.1-flash` 报 `thinking: {mode: effort, efforts: [low, high, max]}`、`input: [text]`：非空，但不是全部六档 |
| D18 (f) 每一个上游请求的 `model` 都在托管 `models.yml` 的 id 之内，且 `/compact` 确实发出请求 | 1.4 | 成立 | 见「上游请求」 |

### 强度（D8 (b)、D9、D7）

托管 `models.yml` 两条：`deepseek-v4.1-flash`（只写 `reasoning: true`）与 `workbuddy-second`（`efforts: [low, high]`、`input: [text, image]`）。`set_thinking_level{v}` 之后的 `get_state.thinkingLevel`：

| v | `deepseek-v4.1-flash`（omp 报的集合 `[low, high, max]`） | `workbuddy-second`（声明 `[low, high]`） |
|---|---|---|
| `off` | `off` | `off` |
| `minimal` | `low` | `low` |
| `low` | `low` | `low` |
| `medium` | `low` | `low` |
| `high` | `high` | `high` |
| `xhigh` | `high` | `high` |
| `max` | `max` | `high` |
| `auto` | `high` | `high` |

- `set_thinking_level` 对这十六次调用没有一次拒绝。omp 报的是「不高于所请求值的最近一档该模型的强度，没有就取最低一档」；`auto` 不作为一个状态保留，报成 `high`。
- 声明了 `efforts` 的模型：可选集合 `{off, low, high, auto}` 里只有 `auto` 不满足 `thinkingLevel === v`。D9 末段已写了这种情形的处理（把该取值从可选集合里拿掉并改规格），是否照办待 owner。
- 未声明 `efforts` 的推理模型：D9「未声明则全部六档」的前提不成立——omp 自己给条目配了强度集合，`minimal`、`medium`、`xhigh` 被夹到相邻档。D7 只写了「集合为空」的退路。
- 仅本机探针、不在 CI 输出里的补充（未入库，不作结论依据）：同样只写 `reasoning: true` 的条目，id 换成一个中性名字时报出的是 `[minimal, low, medium, high, xhigh]` 五档——集合随模型 id 变；未知取值（如 `bogus`）不被拒绝，之后 `thinkingLevel` 缺席。
- 关于 D8 正文「`setModel` 会把强度重置为新模型的缺省」：实测在第一个模型上设 `off` 后 `set_model` 到第二个模型，`get_state.thinkingLevel` 是 `off`——`off` 被带了过去。用例没有记录第二个模型未经设置时的缺省强度，所以这只是与「重置为缺省」不符的迹象，**未判定**；「先 `set_model` 后 `set_thinking_level`」的次序在两种解释下都无害。

### 上游请求（D18 (f)）

| 步骤 | 新增请求数 | `model` | 消息条数 |
|---|---|---|---|
| 新会话的第一个回合（工具轮） | 2 | `deepseek-v4.1-flash` ×2 | 3、5 |
| 十六次 `set_thinking_level` 与一次 `set_model` | 0 | — | — |
| 换模型后的回合 | 1 | `workbuddy-second` | 6 |
| `/compact` | 3 | `workbuddy-second` ×3 | 2、2、2 |
| `--resume` 后的 `get_state` | 0 | — | — |

- 全部 6 条请求的 `model` 都在白名单内。
- `/compact` 用的是**主手段**（cwd 的 `.omp/config.yml`：`keepRecentTokens: 1`、`methodOrder: [soft]`），没有用到备选。`command_output` 原文（CI）：`Compaction complete. Tokens: 13569 -> 13537 (saved 32).`，不含 `Nothing to compact` 与 `Already compacted`。三条断言都通过。Stage 4.5 验证门留下的那条残留（`soft` 方法在 RPC 会话里是否真的发出上游请求）就此核销。
- `--no-title` 下第一个回合确无标题请求：工具轮的两条主请求之外的请求数为 0。
- 观察、不作结论：`set_model` 之后 omp 自己的数据目录（`XDG_DATA_HOME` 下的 `omp/agent.db`，不在托管 `HOME` 的配置里）有写入；本机探针看到的是一张模型使用记录表多了一行，设置表没有变化。它是各会话共用的存储，但不是设置项。

### 待 owner 决定

1. `auto`：照 D9 末段把它从可选集合里拿掉，还是保留并在界面上说明它由 omp 解析成一个具体档位（两个模型上都是 `high`；用例区分不开「缺省档」与「不高于 `high` 的最高档」）？
2. 未声明 `efforts` 的推理模型的可选强度：让写出器对每个推理模型都写 `thinking`（未声明时写全部六档——D7 为「集合为空」写的退路，是否对「非空但不是六档」同样有效，需要再跑一次对照用例确认 omp 接受并照此回显），还是界面与服务端校验改按 omp 为该 id 报的集合？
3. 受影响的规格与 issue 在决定之后改：model-selection「模型与强度从下一条消息起生效」、model-proxy「托管 models.yml」（「单模型时字节不变」一句可能要改）、design D7 / D8 / D9，以及任务组 3、7 与依赖它们的 issue 正文。
