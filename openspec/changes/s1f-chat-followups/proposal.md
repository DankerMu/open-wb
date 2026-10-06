# Proposal: s1f-chat-followups

## Why

change `s1f-chat-surface`（已归档）的各次评审在 #874 里留下约一百条不阻塞合并的备注。逐条对照当前代码后（分诊表贴在 #874），
其中一部分已随后续 PR 解决，一部分是推断性或与旧实现等价的记录，剩下的是确有其事的小缺陷、缺的断言与写不通的验收步骤。
owner 于 2026-10-06 对需要拍板的几条作了决定。本 change 把「确有其事」的那部分与这些决定一次做完，不引入新功能。#872 的三条由 `fix-new-session-handoff` 处理，不在此列。

## What Changes

- **首次发送被拒后显示新会话的状态**（既有缺陷）：欢迎态首次发送时会话已建、prompt 未被受理（400/409/502/503 或网络失败，例如容量已满），
  页面补读这个新会话的历史并显示它的正常状态（零消息空态）；输入框上的错误文案与恢复的草稿不变。此前线程区既无空态也无加载或错误。
- **可访问性**（owner 决定，四项全做）：去掉列表符号的列表补显式 `role="list"`；多张待决提问卡以 `aria-describedby` 关联各自的工具徽章与正文；
  答完一张卡后，若焦点原在该卡内，移到下一张待决卡的 `允许` 或输入框，焦点在别处不夺取；任务清单列表与项目配置列表在被限高裁掉时可由键盘聚焦滚动。
- **代码块复制**（owner 决定）：写入剪贴板的文本去掉末尾恰一个换行。改动在应用层，不动拷入文件。
- **源码整理**：线程渲染函数稳定引用；残留的 `max-[760px]:` 换成 `narrow:`（视口恰为 760 时与外壳断点对齐）；一个不生效的图标尺寸属性；
  一个无人读取的返回值；过期注释；任务清单读侧对坏的存量值降级为 `null`（此前快照请求失败）；走查探针的三处不严。
- **补测试**（不改产品）：流错误恢复后 `生成中` / `停止` 重现、「+」菜单空目录、点菜单外关闭后的焦点、原生跟随开关守卫、走查里真实点击 `回到最新`、
  窄屏外壳不带 gap、`chat.css` 选择器归属断言的漏洞、产物面板跨重同步保持打开、只读工作空间标签的真实点击。
- **文档**：订正功能验收清单里无法执行或无从判定的行；删除 `docs/acceptance/demo-parity-checklist.md` 并改掉现行指向；
  ADR-0013 增补 2026-10-06 的各项决定（含「包体暂不设上限，S1f 全部 change 完成后再定上限与分割」与两条不处理）。

## Capabilities

### Modified Capabilities

- `chat-web`：「会话页」（首次发送被拒后的状态；项目配置列表被裁剪时可键盘聚焦）、「消息线程」（代码块复制的文本）。
- `tool-approval`：「web 审批条」（提问卡的描述关联；卡消失后的焦点）。
- `session-todo`：「任务清单面板」（显式列表语义；列表被裁剪时可键盘聚焦）、「任务清单快照」（存量坏值为 `null`）。
- `functional-acceptance`：「功能验收清单与签收」（旧清单删除）。

## Fixture

- Fixture level（按组）：1 compact；2 expanded；3 compact；4 compact；5 compact；6 compact。
- Risk packs：state-machine（组 1：创建—发送交接的失败收尾与所有权 fence）；a11y-focus（组 2：焦点移动与「不夺取」的反例）；
  public-contract（组 4.6：快照读取从失败变为 `todo: null`）。
- Must preserve：首次发送恰一次创建、恰一次 prompt；既有会话 prompt 被拒不补读历史；`fix-new-session-handoff` 定下的「新建会话」判定；
  提问卡的可访问名 `需要你的确认` 与按钮名 `允许` / `拒绝`（测试与走查按名选择）、400 毫秒防误点、作答与对账规则；任务清单面板只读、展开状态与限高两档；
  项目配置对话框打开时焦点在 `关闭`、唯一按钮是 `关闭`；消息级 `复制` 仍是 Markdown 原文（不裁换行）；拷入层文件零改动；
  清单各行结论不由 agent 改为 `通过` / `不通过`。
- Required evidence：各组任务列出的新测试与变异（去掉实现即判红）；组 2 的焦点规则含「焦点在别处不移动」的反例；
  每个 PR `make check`、`make test-guardrails`、ui-walk 通过；用户可见变化在 `docs/acceptance/functional-checklist.md` 有 `待签` 行。

## Impact

- **代码**：`web/src/features/chat/`（`turn-actions.ts`、`use-chat-session.ts`、`composer-dock.tsx`、`approval-card.tsx`、`todo-panel.tsx`、`project-config.tsx`、
  `capability-bar.tsx`、`welcome.tsx`、`markdown-body.tsx`、`message-thread.tsx`、`composer.tsx`、`conversation-search.tsx`、`conversation-view.tsx`、一个新的测量 hook 文件；
  `session-sidebar.tsx` 只改一行注释）、`web/src/features/settings/page.tsx`、`web/src/features/auth/login-form.tsx`、`server/src/sessions/store-todo.ts`。
- **测试**：`web/test/chat-*.test.tsx` 若干（新增用例为主；改写的既有断言见各任务）、`web/test/ui-layering.test.ts`（登记新文件）、`web/e2e/ui-walk-{steps,scroll,stop,approval}.ts`、一个服务端 store 用例。
- **文档**：`docs/acceptance/functional-checklist.md`、`docs/adr/0013-assistant-ui-frontend-rebuild.md`；删除 `docs/acceptance/demo-parity-checklist.md`。
- **不动**：拷入层两个目录、`web/src/ui/**` 冻结区、外壳文件、文件页、服务端除 `store-todo.ts` 之外的文件、`openspec/changes/archive/**`。
- **依赖**：无新增。
- **次序**：组 1 与组 4 改 `turn-actions.ts` / `use-chat-session.ts`，须在 `fix-new-session-handoff` 的 PR 合入之后开工。
