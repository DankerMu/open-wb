# Tasks: s1f-ui-foundation

> 执行顺序：线性链 1a → 1b → 2 → 3 → 4 → 5（design D11；串行原因含共享文件，见各组尾部）。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行。
> - 「行为不变」的证据是既有行为断言（按角色/可访问名）原样通过；只允许删除或改写读源码、读 `.css`、按旧类名选择的断言，不得为通过而放宽行为断言。
> - 不改 `web/src/features/chat/**`、`web/src/features/files/**` 的实现；`web/src/ui/**` 冻结（唯一例外：组 3 在 `index.ts` 加 `useEscapeFallback` 导出）；不改任何 `server/**`。
>   会话页/文件页的**测试**只在点名处改选择器或读取的文件。
> - 拷入层只做四类修改：颜色字面量换主题变量、可见与 aria 文案中文化、Biome 格式化、`cn` 的导入归一到 `@/lib/utils`（registry 下发的是 `import { cn } from "cn"`；不装 `cn` 包）。
> - size-guard：新写的应用层文件 ≤800 行；新测试写进新文件。

## 1a. ui-foundation — Tailwind 接入、层叠顺序与主题映射

- [x] 1a.1 依赖与构建：`web/package.json` 加 `tailwindcss`、`@tailwindcss/vite`、`tw-animate-css`；`web/vite.config.ts` 加 Tailwind 插件；`biome.json` 顶层 `css.parser.tailwindDirectives: true`；
  `knip.json` web `entry` 加 `src/styles.css`（仍报 `tailwindcss` / `tw-animate-css` 未使用时以 `ignoreDependencies` 精确列名）；`ATTRIBUTION.md` 登记 Tailwind CSS。
- [x] 1a.2 样式入口（design D2）：新建 `web/src/styles/legacy.css` 承接原 `styles.css` 的全局规则（全局 reduced-motion 块除外）与全部 `@import`；
  `web/src/styles.css` 改为层声明 + Tailwind 三段导入 + `tw-animate-css` + `tokens.css` + `theme.css` + `legacy.css layer(legacy)` + 原样保留、未分层的全局 reduced-motion 块。
  utilities 导入带 `source("./")`，类名扫描限定在 `web/src`（不扫 `web/test`、`web/e2e`）；`legacy.css` 末尾补三条 `revert` 规则，恢复 preflight 清掉的 `.chat-md` / `.files-md` 列表符号与编号、`.files-md` 列表缩进与标题字重（随两页迁移删除）。
- [x] 1a.3 主题映射（design D3）：新建 `web/src/styles/theme.css`（规格所列语义变量，七项钉死的对应、`[data-theme="dark"]` 的 `--primary` 块、`@theme inline`、`--radius`、`@custom-variant dark`、
  `body` 底色与文字色、reduce 下 `[class*="transition"] { transition: none }`）；`legacy.css` 里 `body` 的底色/文字色声明删除。其余变量的对应表写进 PR 描述。
- [x] 1a.4 随搬家改指的测试（design D6 表）：`chat-steps.test.tsx:145-149`、`app-shell-responsive.test.tsx:551-554`、`topbar.test.tsx:277-278`、`sidebar.test.tsx:410-413`、
  `login-form.test.tsx:279-280`、`settings-page.test.tsx:414,424` 改读 `legacy.css`；`ui-reduced-motion.test.ts` 不改且保持通过；
  `ui-tokens.test.ts` 删除 demo 逐值相等与名集合断言及 `styles.css` 的三条底色断言，`files.css` 的两行保留。
  另有两处读 `styles.css` 的否定断言随搬家补读 `legacy.css`（否则成空断言）：`topbar.test.tsx` 的「不含 `ui-page-heading`」列表、`settings-footer.test.tsx` 的「不含 `.logout-dialog`」。
- [x] 1a.5 守卫（新测试文件）：入口结构（规格「入口结构不可缺失或重排」）与 `theme.css` 结构（规格「映射文件结构」）。
- [x] 1a.6 ui-walk：`/settings` 亮/暗下 `body` 计算底色为 `rgb(255, 255, 255)` / `rgb(20, 20, 20)`、文字色等于 `--wb-text-primary`；`/files` 的 `main` 内第一个 `.ui-btn` 的 `padding-left` 非 `0px`。
  既有 ui-walk 全部用例保持通过；若 preflight 使某功能断言失败，在 `legacy.css` 补最小规则。

Suggested fixture level: expanded - 全局层叠顺序是全部页面的公共契约，其结果（legacy 压过 preflight、未分层压过 utilities）只有真实浏览器能证明
Minimal mergeable slice: atomic - 层声明、`legacy.css`、Tailwind 三段导入与 `theme.css` 必须同刀：只接 Tailwind 不建 `legacy` 层，preflight 直接改坏全部旧页面；`body` 底色从 legacy 挪到 `theme.css` 与入口重排是同一次编辑；读 `styles.css` 的六处测试在搬家那一刻即红，只能同 PR 改指。不含别名、拷入组件与豁免（归 1b）。依赖：无。

## 1b. ui-foundation — 别名、组件分层、门槛豁免与分层守卫

- [x] 1b.1 模块解析与别名（design D1）：`web/tsconfig.json` 覆盖 `module: ESNext`、`moduleResolution: Bundler`、`paths {"@/*": ["./src/*"]}`；`web/vite.config.ts` 加 `resolve.alias`；
  `web/vitest.config.ts` 复用 alias；knip 能解析 `@/`（必要时在 `knip.json` 的 web workspace 加 `paths`）。
- [x] 1b.2 组件分层（design D4）：依赖加 `radix-ui`、`class-variance-authority`、`clsx`、`tailwind-merge`；`web/components.json` 入库；`web/src/lib/utils.ts`（`cn`）；拷入 `button`；
  新增测试文件从 `@/components/ui/button` 导入并渲染（别名在 tsc / vitest / knip 下的证据；Vite 侧证据在组 3）。
- [x] 1b.3 门槛豁免（design D5）：`web/vitest.config.ts` coverage 排除、`.jscpd.json`、`scripts/size-guard.sh` 前缀排除、`biome.json` overrides、`knip.json` ignore，条目只指向两个拷入目录；
  `constraints.yaml` `exemptions.entries` 登记；`scripts/test-guardrails.sh` 加「应用层 801 行被拒 / 拷入层 801 行通过」两例（仓库内相对路径、用后清理）；
  `AGENTS.md` 在「阈值与正则…」说明段之后、`### Known blind spots` 之前加一行豁免注记；`ATTRIBUTION.md` 登记 shadcn/ui 与 `radix-ui`。
- [x] 1b.4 分层守卫（design D6）：Radix 导入扫描范围改为除拷入层与 `web/src/ui` 外的全部 `web/src`，并匹配 `radix-ui`；颜色字面量扫描扩到去掉块注释与 `//` 行注释后的 `.ts`（不改 `features/chat/stream-steps.ts`）；
  已迁移区域清单（此时为空）与冻结区清单（32 个文件名）及注入样本自证；豁免路径精确（读五处配置、`constraints.yaml` 与 `AGENTS.md` 注记）；ATTRIBUTION 登记检查加 `radix-ui`、`tailwindcss`、shadcn/ui。

Suggested fixture level: expanded - 改模块解析（tsc/Vite/vitest/knip 四处）与五个质量门的配置；豁免是否外溢需注入违例自证
Minimal mergeable slice: atomic - 拷入的 `button` 没有豁免即被覆盖率与 Biome linter 拒绝，没有别名即 TS2307，没有消费测试则 `radix-ui` 等依赖与 `lib/utils.ts` 被 knip 报未使用；豁免与守卫若先于首个拷入组件合入则无对象可证。验证路径单一：`make check` + `make test-guardrails`。依赖：1a（`button` 的类依赖主题变量；`AGENTS.md` 无交集）。

## 2. functional-acceptance / verification-harness — demo 一致性 harness 退役与功能验收清单

- [ ] 2.1 删除 `web/e2e/ui-shots.mjs`、`web/package.json` 的 `ui-shots` 脚本；Makefile 去掉 `ui-shots` 目标、`UI_SHOTS_*` 块、`.PHONY` 项与页头注释句（design D10）。
- [ ] 2.2 `constraints.yaml` `verification.surfaces` 去掉 `ui-shots`；`AGENTS.md` Verification Matrix 与 Enforcement Index 各去掉「demo 一致性截图对」一行，并在 1b.3 的注记旁加一行指向功能验收清单与其签收规则的注记。
- [ ] 2.3 `scripts/test-ci-harness.sh`：内嵌 oracle 的八类断言、`:144-145` 的整段锚与 `:155-174` 一带全部含 `ui-shots` 的突变用例同步去掉 `ui-shots`；新增「`web/package.json` 无 `ui-shots` 脚本」断言与
  「重新加入 `ui-shots` surface / target / AGENTS 行被拒」的突变用例。
- [ ] 2.4 新增 `docs/acceptance/functional-checklist.md`：文件头（运行方式、四列格式、三种结论、签收规则）+ 分节骨架（登录、外壳、会话、文件、设置），本任务不写数据行；
  新增其格式守卫测试（四列、ID 唯一、三值、无 `demo:`、无 `<数字>px` 与 `.`/`#` 选择器，含注入样本自证）。

Suggested fixture level: compact - 控制面镜像由既有 source-derived oracle 守护，改动是删除一个 surface 并同步 oracle；无运行时行为
Minimal mergeable slice: atomic - AGENTS.md 行、constraints surface、Makefile 目标与 oracle 期望被 `make test-guardrails` 逐字互相校验，任何子集单独合入都使 oracle 变红；清单骨架与其格式守卫互为对象。验证路径单一：`make test-guardrails` + `make check`。依赖：1b（同改 `AGENTS.md` 的注记位置与 `web/package.json`）。

## 3. spa-shell — 外壳重写

- [ ] 3.1 拷入 `sheet`、`tooltip`、`dropdown-menu`、`alert-dialog`、`separator`（按需）；`routes/shell/{app-shell,sidebar,topbar}.tsx` 按 design D7 重写，删除 `sidebar.css`、`topbar.css` 并从 `legacy.css` 去掉其 `@import`。
  保留 `aside` 的类 `sidebar` 与 `data-variant`；主区布局契约以 Tailwind 等价重现后删除 `legacy.css` 里只服务旧外壳的规则（`.app-shell`、`.app-content*`）；`ui-alert` 等仍被会话页/文件页使用的全局类不删。
- [ ] 3.2 `features/auth/footer.tsx`（用户菜单、退出确认、失败提示）按 D7 重写；`web/src/ui/index.ts` 加 `useEscapeFallback` 导出，外壳把它接到导航覆盖层与退出确认的内容元素上；`footer.tsx` 在应用层重现忙碌期焦点救回（design D7），新增 jsdom 用例「`pending` 上升沿后活动元素为 `关闭`、Tab 不出确认框」，ui-walk 退出段原样通过。
- [ ] 3.3 `lib/topbar.tsx`、`lib/sidebar-slot.tsx`、`lib/viewport.ts` 的导出与语义不变；actions 容器改 `data-slot="topbar-actions"`。
- [ ] 3.4 测试：`sidebar`、`sidebar-slot`、`app-shell-responsive`、`topbar`、`topbar-actions`、`routes`、`settings-footer`、`ui-toast-drawer-escape` 的行为断言原样通过；
  读 `sidebar.css`/`topbar.css`/`legacy.css` 外壳规则/源码的断言删除或改为行为断言（含「`footer.tsx` 含 `ConfirmDialog`」一条，规格已改）；
  会话页测试只改选择器：`chat-page-project-config.test.tsx:177`、`chat-page-welcome-scene.test.tsx:91,649`；`chat-page-sidebar.test.tsx:761` 所钉的 `chat.css` 规则不动且仍生效。
  `web/e2e/ui-walk*`：`.sidebar-link`、`header.topbar h1`、`.topbar-actions` 改为角色/名称或 `data-slot`，侧栏宽度 48/288 断言改为 `data-collapsed`；
  新增 reduce 下菜单/覆盖层 `animation-duration` 与带 `transition*` 类按钮 `transition-property` 的断言（规格「reduce 下拷入组件无动画与过渡」）。
- [ ] 3.5 守卫：把 `web/src/routes/**` 与 `web/src/features/auth/footer.tsx` 加入已迁移区域清单。`functional-checklist.md` 外壳节加行（导航四项、折叠与持久化、窄屏覆盖层、顶栏三态、用户菜单与退出、退出失败提示），结论 `待签`。

Suggested fixture level: expanded - 外壳是全部页面的容器，响应式覆盖层、焦点归还、Escape 兜底与退出锁定态只有真实浏览器 + 视口矩阵能证明
Minimal mergeable slice: atomic - 侧栏、顶栏、覆盖层与用户菜单共用同一组上下文（折叠状态、窄屏判定、槽位），footer 渲染在侧栏内，且共用即将删除的两个 `.css`；先迁一半会让另一半失去样式或需要临时双写。验证路径单一（外壳的 jsdom 行为测试 + ui-walk 外壳段）。依赖：2（往清单加行、守卫清单）。

## 4. spa-shell — 登录页重写

- [ ] 4.1 拷入 `card`、`input`、`label`（按需）；`features/auth/login-form.tsx`、`quick-login.tsx` 按 design D8 重写；删除 `auth.css` 并从 `legacy.css` 去掉其 `@import`；`.auth-loading` 的加载态改用 Tailwind 并删去其旧规则。
- [ ] 4.2 测试：`login-form`、`auth-router`、`auth-session-client` 的行为断言原样通过；读 `auth.css`/`legacy.css`/源码的断言删除或改为行为断言。
  ui-walk 增「登录主按钮计算底色等于 `--primary`，浅色下为 `rgba(0, 0, 0, 0.9)`」。
- [ ] 4.3 守卫：已迁移区域清单把 `features/auth/footer.tsx` 一项换成 `web/src/features/auth/**` 整目录。`functional-checklist.md` 登录节加行（未登录落登录页且 URL 不变、登录成功回原路由、错误提示、快捷登录仅演示环境可见），结论 `待签`。

Suggested fixture level: expanded - 登录页是层叠顺序（utilities 压过旧全局 `button` 规则）与「配色不换」的取证点，计算样式需真实浏览器
Minimal mergeable slice: atomic - 表单与快捷登录卡共用同一提交锁与同一个 `.css`，单页、单一验证路径。依赖：3（`features/auth/**` 整目录登记要求 footer 已迁；共享守卫清单与功能清单文件）。

## 5. spa-shell — 设置页重写

- [ ] 5.1 拷入 `radio-group`；`features/settings/page.tsx` 按 design D9 重写；删除 `settings.css` 并从 `legacy.css` 去掉其 `@import`。
- [ ] 5.2 测试：`settings-page`、`theme-provider`、`theme`、`prepaint-theme` 的行为断言原样通过（含 `getByRole("radiogroup", { name: "主题" })`）；新增「再点已选项不改变主题」用例；
  读 `settings.css`/`ui.css`/源码的断言删除或改为行为断言；`web/e2e/ui-walk-layout.ts` 主题探针里 `.settings-sec-h`、`.settings-row-title` 改为角色/文本定位。
- [ ] 5.3 守卫：把 `web/src/features/settings/**`、`web/src/features/theme/**` 加入已迁移区域清单。`functional-checklist.md` 设置节加行（主题三档即时生效与持久化、跟随系统、关于卡显示服务名与版本、读取失败提示），结论 `待签`。

Suggested fixture level: compact - 单页、无新契约；主题切换的既有 jsdom 与 ui-walk 用例已覆盖行为
Minimal mergeable slice: atomic - 两张卡在同一个文件、同一个 `.css`，单一验证路径。依赖：4（与组 3 共用 `ui-walk-layout.ts` 的同一探针函数，与 3/4 共用守卫清单与功能清单文件；串行避免冲突）。
