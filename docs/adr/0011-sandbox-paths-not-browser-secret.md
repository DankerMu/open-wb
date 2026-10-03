# 绝对沙箱路径不属于对浏览器保密的信息

绝对沙箱路径（`<SANDBOX_ROOT>/<ownerId>/<dir>` 及其子路径）经三条通道到达已登录用户的浏览器：
`GET/POST /api/workspaces` DTO 的 `root`、`workspace.create` 审计的 `detail.root`（`GET /api/audit`，非 admin 仅本人事件）、
对话步骤卡的工具 args/输出（omp 的 cwd 即 `<SANDBOX_ROOT>/<ownerId>`，`server/src/sessions/omp/process.ts:52`）。
模型本身知道 cwd，助手正文也可能复述它，因此任何 API 层删除或脱敏都封不住全部通道。决定：**绝对沙箱路径对本人可见
（admin 在审计中可见全体），不是保密信息**；浏览器可见的 API 与持久化内容对它不做删除或改写。沙箱安全不依赖路径不可知——
边界由 `core/sandbox` 白名单、owner scope 与 uid/权限位（ADR-0010）保证。

界面呈现与保密是两回事：界面以逻辑路径 `<account>/<dir>` 作主要展示（#292），files 页、外壳、标题与 aria 属性中不渲染 `root`；
步骤卡 `原始输出` 原样展示工具 args/输出，其中出现绝对路径属预期。

本 ADR 不放宽真正的保密项：凭证（会话 token、上游密钥、网关/kb 凭证——CONTEXT 不变量 4、ADR-0008）与他人账号的路径和内容（owner scope）。

## Consequences

- workspaces spec 保留 DTO 五字段与审计 `detail.root`，注明 `root` 非保密；chat-stream / chat-web spec 注明步骤 detail/输出可含绝对路径、不做改写（#367 的 args/输出双字段同样适用）。
- ui-shots 的 root 泄漏断言（`web/e2e/ui-shots.mjs:391-406`，demo-parity-acceptance spec 同句）收窄为非 chat 截图：它守的是呈现规则，不是保密边界；chat 截图含工具输出时出现路径是合法的。
- 部署侧：`SANDBOX_ROOT` 会被已登录用户看到，部署文档应选中性目录（如 `/srv/workbuddy/sandbox`），不把宿主用户名等不愿公开的信息编入路径。
- 升级路径：若将来跨组织或公网部署需要隐藏，DTO `root` 可分两步删除（先放宽 web `hasExactlyKeys` 严格解析，再改服务端），步骤 detail 脱敏仍只能尽力而为。

## Considered Options

- 从 DTO 删 `root`、审计改记逻辑路径（#386 选项 B）：步骤通道照样带出路径，收益近零；web 严格解析（`web/src/lib/api.ts:210`）使服务端先行时已打开的旧页面把工作空间列表判非法；ui-shots 失去禁止串来源（`web/e2e/ui-shots.mjs:159`）。
- 服务端对步骤 detail 做路径前缀脱敏（#386 选项 C）：字符串替换对 JSON 转义、截断边界、相对路径与 bash 输出中的变形路径不完备，助手正文无法覆盖——给出一个不存在的保证，弃。

## 补充（2026-10-02，#739）：判定后按路径再操作的竞态——已知残留

- **事实**：工作空间文件接口先经 `core/sandbox` 判定路径（逐分量拒绝符号链接、`lstat` 为普通文件或目录），再**按同一路径**重新打开或操作：
  `GET /api/workspaces/:id/file`（判定后 `createReadStream` 重新解析路径并跟随符号链接）、`GET /api/workspaces/:id/tree`（判定后
  `readdir` 再逐项 `lstat`）、`POST /api/workspaces/:id/dirs`（判定后逐级 `mkdir`，已存在分量以 `stat` 确认）。两步之间，能在空间内写入的
  omp 子进程可以把最后一个分量或某个中间分量换成指向空间外的符号链接；落在这个时间窗里的请求会以服务端 uid 读出空间外的文件 / 目录项，
  或在空间外建目录。时间窗未量测。
- **影响面**：同 uid 运行（macOS 开发机）时不越过任何边界；专用 omp uid（ADR-0010）下，这是让服务端替 omp 读写「omp 不可达」位置的通道，
  对手模型是「已登录用户指挥自己的 agent 配合自己的请求撞时间窗」。
- **决定（owner，2026-10-02）**：不修，登记为已知残留。前提是当前部署形态——受信局域网、账号均为内部成员；「已登录用户恶意撞判定与打开之间的时间窗」
  不在威胁模型内。
- **重开条件**：部署模型变为不受信多租户或公网可达时重开 #739，按「以描述符为准」修（`open` 带 `O_NOFOLLOW`、对已打开的描述符 `fstat`、
  逐分量 `openat`），三个接口一并处理。

