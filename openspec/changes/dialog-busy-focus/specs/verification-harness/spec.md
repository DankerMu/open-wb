## MODIFIED Requirements

### Requirement: UI 走查（Playwright）
`make ui-walk` SHALL 只消费由 caller 启动、可从 `UI_WALK_BASE_URL`（缺省 `http://127.0.0.1:3000`）访问的真实服务；目标不得 build、start、stop、安装浏览器或拥有 DB/temp cleanup。目标 SHALL 以 Playwright 管理的全新 Chromium context 串行执行一条生产路径：从 `/files` 登录 dev-stub 账号 → 经真实侧栏逐项访问四个受支持路由 → 在 `/` 完成受控真实回合中的新建/发送/步骤/刷新续流/精确完成/完成后刷新 → 在 `/settings` 切换深色主题并 reload 验证持久化 → 从侧栏页脚确认退出并 reload 验证会话仍为未登录。走查 SHALL 从首个 navigation 前开始收集并最终断言零非预期浏览器 `console.error` 和零 uncaught page error；本 journey 必须同时观测恰两次 `GET /api/auth/me` → 401（初始未登录、退出后 reload），仅与这两次响应同源、location pathname 恰为 `/api/auth/me` 且文本恰为 Chromium 固定 401 transport diagnostic 的 console 事件不计入错误预算，任何额外/不匹配 401 或其他 console error 仍失败。服务端 stderr（包括 `node:sqlite` ExperimentalWarning）不属于该浏览器 oracle。

#### Scenario: 登录、四路由、主题持久与退出全绿
- **GIVEN** caller 以 fresh 临时 DB 和真实 `web/dist` 启动 production server，且 Playwright context 初始无 cookie/localStorage
- **WHEN** 对 `/files` 执行 `make ui-walk`，以 `zhangsan`/`demo` 登录，再依次访问 `/`、`/files`、`/center`、`/settings`
- **THEN** 登录后仍在 `/files`，每一路由显示对应页面标题且恰有一个当前导航项；页脚显示 exact `zhangsan`/`成员`
- **AND** 选择 `深色` 后根元素 `data-theme=dark`、`workbuddy-theme=dark`，reload 后仍选中深色且显示 `当前生效：深色`
- **AND** 点击 `退出登录` 后，在 `alertdialog` 中以键盘 Tab 聚焦 `退出` 并按 Enter，`POST /api/auth/logout` 被 route 挂起期间：活动元素为 `关闭` 按钮；依次按 Tab、Shift+Tab、Tab 后活动元素每次都仍在 `alertdialog` 内，URL 仍为 `/settings`；放行请求后原 `/settings` 显示 `登录 WorkBuddy`，session cookie 被清除，reload 后仍未登录
- **AND** 恰有两次 expected `/api/auth/me` 401；除与其 exact path/text 绑定的 Chromium transport diagnostic 外无 browser console error，且无 page error，Playwright 退出码为 0

#### Scenario: 目标边界与失败传播
- **WHEN** Playwright/Chromium 缺失、`UI_WALK_BASE_URL` 不可达、任一 UI/API/持久化/退出断言失败，或页面产生 console/page error
- **THEN** `make ui-walk` 非零且不得 silent skip、下载依赖、启动/停止服务、创建或清理 caller 的 DB/temp/static root
- **AND** `make test` 不发现或执行 `web/e2e/**`；`make typecheck` 仍检查 Playwright 配置与走查源码

#### Scenario: 真正回合中刷新并持久完成
- **GIVEN** caller使用真实官方omp18.0.10、compiled app和有界隔离gate的原测试上游，gate已arm且固定提示模板携带独立UUID
- **WHEN** 浏览器创建会话并发送，观察bash步骤与非空prefix，真实REST为running；gate保持held时reload，同session新REST和DOM保留prefix并建立native SSE，随后显式release
- **THEN** 完整正文逐字等于`你好，这是 WorkBuddy 的第一条流式回复。`，bash 步骤徽章（`role=status` 名 `bash 已完成`）与会话列表当前项 status 文本均为 `已完成`，恰一user/assistant pair；完成后reload同样完整且done；exact两次auth401及零新增console/pageerror合同不变，finally清理gate
- **AND** 不以浏览器伪造响应、fake EventSource、已完成回合的延迟展示或任意sleep冒充真正回合中刷新；其他canonical CI/HTTP requirements保持不变

After the four-route traversal and before the existing held dialogue, the journey SHALL perform files-harness「走查 /files 步骤」through the real UI. Its caller-owned sandbox SHALL contain the tracked fixture and no walk-out directory. Existing auth/error, dialogue recovery, theme, logout and lifecycle scenarios remain unchanged.

#### Scenario: 文件面预览、创建与同空间恢复
- **WHEN** the authenticated browser selects or creates smoke-fixture, opens the three-file tree, switches Markdown rendered/source views, inspects CSV and creates root walk-out
- **THEN** exact fixture content and the directory are visible; reload preserves the same nonempty ws ID, selected workspace and restored tree, while the full existing journey and browser-error oracle still pass
