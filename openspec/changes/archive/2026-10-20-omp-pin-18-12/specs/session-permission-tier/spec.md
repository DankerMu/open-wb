# session-permission-tier Spec Delta

## MODIFIED Requirements

### Requirement: 档位与 omp 审批模式
会话的工具审批档位 SHALL 取 omp 的三个审批模式字面量之一，从存储、API 到 spawn 参数不做任何映射：`always-ask`（界面名 `每次都问`：写文件与执行命令的工具都先请求确认）、`write`（界面名 `只问命令`：只有执行命令一类的工具请求确认，写文件不请求——本 change 之前唯一的行为）、`yolo`（界面名 `全部自动`：工具不因档位请求确认）。严格程度的次序为 `always-ask < write < yolo`。
会话每一次 generation spawn 与以它为源的 fork 临时进程 SHALL 以 `--approval-mode <该会话的有效档位>` 启动（有效档位见 session-composer-settings「有效值解析」；argv 的位置与其余参数见 omp-runtime「子进程 spawn 契约」）。
宿主 SHALL NOT 因档位而自行应答、丢弃或改写任何审批请求：是否请求确认完全由 omp 决定，凡被识别为审批请求的（tool-approval「审批请求识别」）在任何档位下都照常登记、出确认卡、可作答。唯一由宿主自己应答的 `extension_ui_request` 是浏览器 eval prelude 的 `Allow tool: browser` 卡（omp-runtime「RPC IO and child observation」；#1563，owner 2026-10-20）：它不是审批请求，只在 `write` / `always-ask` 档下出现（`yolo` 档不因档位请求确认，prelude 也不问；工具自带的强制提示如 bash 的 `Critical pattern detected` 在 `yolo` 下仍可能出现，按审批处理）、且只出现在已批准的 `eval` 执行过程中，出现即被宿主立即应答 `Approve`，痕迹是三个档位下都写的 `eval` 步骤 `session.browser` 审计。宿主 overlay 的文件内容不随档位变化（omp-runtime「宿主 overlay」）。
三档在真实 omp v18.12.3 上的行为由官方二进制对照用例钉住（见下方场景）；升级 omp 时 SHALL 重跑。v18.12.3 对被档位抬高的提示附带「本会话内放行」选项（`["Approve","Approve <subject> for this session","Deny"]`），宿主只回 `Approve` 或 `Deny`、不暴露该选项。

#### Scenario: 每次都问（真实 omp）
- **WHEN** 官方 omp v18.12.3 以 `--approval-mode always-ask` 与原样的宿主 overlay 启动，受控上游在一个回合里发出 `write` 工具调用（`WORKBUDDY_WRITE`），另一个回合发出 bash 工具调用
- **THEN** 两个回合宿主各收到一条审批请求，`tool` 分别为 `write` 与 `bash`，`title` 首行分别为 `Allow tool: write` 与 `Allow tool: bash`，`options` 分别恰为 `["Approve","Approve write for this session","Deny"]` 与 `["Approve","Approve bash for this session","Deny"]`；作答 `Approve` 后工具执行、回合正常结束
- **WHEN** 同一档位下会话 cwd 预置 `.omp/config.yml`，内容为 `tools.approval: {write: allow}`，再跑一个 `WORKBUDDY_WRITE` 回合
- **THEN** 宿主仍收到 `write` 的审批请求（项目层的逐工具放行被 overlay 的 `tools.approval: null` 整体替换）

#### Scenario: 只问命令（真实 omp，既有行为）
- **WHEN** 官方 omp 以 `--approval-mode write` 启动，分别跑一个 `WORKBUDDY_WRITE` 回合与一个 bash 回合
- **THEN** `write` 回合没有审批请求、文件被写出；bash 回合恰一条 `tool="bash"` 的审批请求

#### Scenario: 全部自动（真实 omp）
- **WHEN** 官方 omp 以 `--approval-mode yolo` 与原样的宿主 overlay（其中仍有 `tools.approvalMode: write`）启动，分别跑一个 bash 回合与一个 `WORKBUDDY_WRITE` 回合
- **THEN** 两个回合都没有审批请求，bash 与 write 都已执行，回合正常结束；`chat_approvals` 没有新行

#### Scenario: 档位进入 argv
- **WHEN** 有效档位分别为 `always-ask`、`write`、`yolo` 的三个会话各发一条 prompt（假 omp 真子进程，测试经注入的 spawn 包装记下 argv 后照常启动）
- **THEN** 三个进程的 argv 里 `--approval-mode` 之后的取值分别为 `always-ask`、`write`、`yolo`，其余参数与同一会话在别的档位下逐字相同
