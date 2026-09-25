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
