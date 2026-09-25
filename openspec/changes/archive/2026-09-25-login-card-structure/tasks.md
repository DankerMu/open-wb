# Tasks: login-card-structure（#284）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate login-card-structure --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新增 `web/test/login-form.test.tsx`（L1–L8 含 L2b）。先红。
- [x] 2.2 `web/src/features/auth/login-form.tsx` 结构对齐：BrandMark 26 + 字标、副标题、`Input` + `label htmlFor`、placeholder/autocomplete、mount 聚焦 effect、`Button` 主按钮换文案、`login-err` 错误行 + Icon；提交逻辑不变。
- [x] 2.3 新 `web/src/features/auth/auth.css`（demo 来源头注释）；`styles.css` `@import` 并删 `.brand-mark*`、`.login-*`、`.login-dialog`、`≤760` 的 `.login-card` 选择器；`brand-mark.tsx:7` 注释同步。2.1 转绿，`web/test` 全绿。
- [x] 2.4 反向注入七项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0；`git diff --stat web/test/auth-router.test.tsx web/e2e` 为空。

## 4. Archive
- [x] 4.1 归档 docs PR 同步父 `s1e-frontend-parity/specs/spa-shell/spec.md` 登录结构句：错误行位于主按钮之上、`textContent` 恰为 message（本刀 oracle 偏差 1）。

## Risk pack mapping
- Selected Public API / CLI / script entry：登录页可访问定位器（heading、label、按钮名、alert）是 8 个 `web/test` 文件（17 处）与 ui-walk（2 处） 的入口。依据：L1/L3/L4 + 既有套件零改动。
- Not selected Config / project setup：不加依赖、不改配置。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：表单字段 `name` 不变。
- Not selected Auth / permissions / secrets：`login()` 调用、锁与密码清空逐行不变，不新增请求（L7）。认证语义面由既有 `auth-router.test.tsx` 覆盖。
- Not selected Concurrency / shared state / ordering：同 tick 锁逻辑不动。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：`auth-router.test.tsx` 与 ui-walk 定位器零改动仍绿；死 CSS 删除不影响他处。依据：L8 + 3.3。
- Selected Error handling / rollback / partial outputs：错误行结构改变（Icon + `login-err`），但 `textContent` 契约与网络失败回退文案不变。依据：L4/L5。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Selected Documentation / migration notes：错误行位置与 `正在登录` 按钮名变化需告知 2.4b（在 `login-btn` 下追加快捷区）。依据：PR 迁移预告。
