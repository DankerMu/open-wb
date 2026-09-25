# Tasks: ui-shots-script（#297）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 revise：2 P1 + 4 P2 已修；r2 pass，报告 `.workplans/297/review/fixture-r{1,2}.md`）；`openspec validate ui-shots-script --strict --no-interactive` exit 0。

## 2. Implementation
- [x] 2.1 `web/e2e/ui-shots.mjs` 按 design D1–D12；`web/package.json` 增 `ui-shots` script。
- [x] 2.2 本地运行面正向实跑：60 张 + `index.html`，exit 0（Required evidence 1）。
- [x] 2.3 反向证据 2–6 各自非零并回退，逐条记入 PR（含失败行，不含 root 值）。

## 3. Verification
- [x] 3.1 `make check` exit 0；docker semgrep `p/default --error web` 零发现；naming-guard 通过。
- [x] 3.2 `make test` 不发现 `web/e2e/**` 的证据（Required evidence 8）。
- [ ] 3.3 archive PR：本 change 晋升为 `demo-parity-acceptance` 新 spec；父 delta「ui-shots 截图对产物」以本 change 全文替换其脚本部分（healthz 预检、不清理 caller 状态、smoke-fixture 选或建、"当前账号首个已完成会话"——父字面"首个已完成"指向 u3 的 `c2`、被 demo `:2053-2058` 拒绝、390 demo 折叠、`UI_SHOTS_OUT` 相对仓库根、`main` 溢出与 `document.title` 泄漏断言、以及相对父文本的一处放宽：未登录 `GET /api/auth/me` 401 资源错误豁免，依据 ui-walk oracle 先例），保留 `make ui-shots` 条款，并把父块由 ADDED 改为 MODIFIED（晋升后同名 ADDED 会撞名；6.3b 以 MODIFIED 针对晋升 spec 补齐 make 条款）；勾选父 tasks 6.3a；关闭 #297。

## Risk pack mapping
- Selected Public API / CLI / script entry：新 npm script、env `UI_SHOTS_BASE_URL`/`UI_SHOTS_OUT`、文件名契约。证据：2.2 文件全集比对、反向 4。
- Selected File IO / path safety / overwrite：输出目录解析（相对仓库根）、只写输出目录。证据：2.2 输出目录打印、D2。
- Not selected Schema / columns / units / field names：只读既有 REST 字段。
- Selected Auth / permissions / secrets：截图进公开 PR；root 泄漏断言。证据：反向 6、样例人工核对。
- Not selected Concurrency / shared state / ordering：单浏览器串行；与 ui-walk 共享 smoke-fixture 选或建语义。
- Not selected Resource limits / large input / discovery：60 张截图 + 一次 60s 上限等待；不进 CI。
- Not selected Legacy compatibility / examples：无既有入口被改。
- Selected Error handling / rollback / partial outputs：逐张继续、汇总、非零、保留产物。证据：反向 2/3/5。
- Not selected Release / packaging / dependency compatibility：复用 `@playwright/test`。
- Not selected Documentation / migration notes：控制面文档归 6.3b。
