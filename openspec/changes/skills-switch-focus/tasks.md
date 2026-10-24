# Tasks: skills-switch-focus

> 单 issue 单 PR；本 fixture 随该 PR 合入。owner 2026-10-23「改 spec 解决在途请求期间禁用全部开关，会让刚按下的那个开关失去键盘焦点的问题」。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 是 | `aria-disabled` 的开关仍分派点击，在途重入改由 hook 守卫拦下；1.2 在途用例断言挂起期间再点不发请求、不改状态 |
| Error handling / rollback / partial outputs | 是 | 失败路径同样要求焦点不丢；1.2 给现有 500 回滚用例加断言：应答后两个开关不带 `aria-disabled`、焦点仍在被切换的开关 |
| Documentation / migration notes | 是 | 1.4 CS-02 键盘步骤，格式由 `web/test/functional-checklist.test.ts` 守住 |
| Public API / CLI / script entry | 否 | 不改 API 客户端与路由 |
| Config / project setup | 否 | 无配置项 |
| File IO / path safety / overwrite | 否 | 无文件操作 |
| Schema / columns / units / field names | 否 | 请求与应答形状不变 |
| Auth / permissions / secrets | 否 | 账号偏好写入的鉴权不变 |
| Resource limits / large input / discovery | 否 | 无新增读取 |
| Legacy compatibility / examples | 否 | 只换 DOM 属性；e2e 与其它用例不断言这些开关的 `disabled`（见 Must-preserve） |
| Release / packaging / dependency compatibility | 否 | 不新增依赖，`switch` 已拷入 |

Must-preserve：
- 切换恰一次 `putSkillDefaults`；body 含列表外名称，去重后按 JS 缺省 `.sort()`；失败回滚并 `role="alert"`；成功以应答为准。`center-skills.test.tsx` 中「列表」「失败」「应答替换」各节的断言不改。
- `web/test/center-page.test.tsx:188` 与 `web/e2e/*` 不断言这些开关的 `disabled`（e2e 的 `toBeDisabled` 只在 `ui-walk-approval.ts:129-130` 的审批按钮上）。
- `switchStates()` / `settled()` 改为读 `aria-disabled` 后，现有用例第三列为 `false` 的断言全部仍成立。

## 1. 「技能」tab 开关在途改 `aria-disabled`

- [x] 1.1 核对 Context：`web/src/features/center/skills/list.tsx:78-100`、`web/src/features/center/skills/use-skills.ts:31,54`、`web/src/features/chat/capability-popover.tsx:31-36,166-174`（参照写法）、`web/test/center-skills.test.tsx:112-130,222-283`。
- [x] 1.2 测试先行：改写 `center-skills.test.tsx` 的「在途」用例，覆盖场景「在途期间焦点留在开关上」：先 `focus()` 再点 `默认启用 deploy`；挂起期间两个开关 `aria-disabled="true"` 且 `disabled === false`，`deploy` 显示切换后的状态，`document.activeElement` 仍是 `deploy`；挂起期间再点 `weekly-report` 与 `deploy`，`putSkillDefaults` 仍恰一次且两个开关的 `aria-checked` 不变（这两次点击现在真的派发到 `toggle`，由 hook 守卫拦下）；应答后两个开关都不带 `aria-disabled`，焦点仍在 `deploy`。`switchStates()` / `settled()` 改为读 `aria-disabled`。修复前该用例必须为红（记录输出）。同步文件头注释与「同一帧内连调两次」用例上方的注释（「落在已禁用的开关上，React 不派发」已不成立）。同一文件的 500 回滚用例：切换前 `focus()` 被切换的开关，应答后断言两个开关都不带 `aria-disabled`、`document.activeElement` 仍是它。`web/test/chat-capability-popover.test.tsx` 的「PUT 在途」用例（`:212`）：第一次 settle 时弹层已关闭，所以在重新打开弹层后的那次点击（约 `:253`）前先 `focus()` 该 `deploy` 开关，并在用例末尾 `expertPut` settle 之后（约 `:261`，此时该开关已不带 `aria-disabled`）断言 `document.activeElement` 仍是它。
- [x] 1.3 实现：`list.tsx` 的 `Switch` 去掉 `disabled={pending}`，改为 `aria-disabled={pending ? true : undefined}` 并加与弹层相同的 `aria-disabled:` 样式类；在 `SkillRow` 或 props 注释里写明为何不用 `disabled`。`use-skills.ts` 只把文件头注释（`:8-9`「全部禁用」）改为「全部不可切换（`aria-disabled`）」，代码不改。
- [x] 1.4 验收清单 `docs/acceptance/functional-checklist.md` CS-02：「关闭 weekly-report 的『默认启用』」改为用键盘完成（Tab 到该开关、按空格），预期补「关闭后焦点仍在该开关上（仍有焦点框），再按 Tab 到下一项」。
- [x] 1.5 `npm test --workspace web`（含 coverage）与 `make check` 通过。

Suggested fixture level: compact - 单组件属性替换，守卫已有。
