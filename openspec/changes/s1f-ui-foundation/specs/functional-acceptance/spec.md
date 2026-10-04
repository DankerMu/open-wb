## ADDED Requirements

### Requirement: 功能验收清单与签收
`docs/acceptance/functional-checklist.md` SHALL 是界面验收的签收对象，按页面分节（登录、外壳、会话、文件、设置……），每行一条可在 1 分钟内判定的功能项，列为 `ID`、`操作`、`期望`、`结论`。`ID` 在文件内唯一（页面前缀 + 序号，如 `SH-01`）。`操作` 与 `期望` 描述用户可见的行为，不引用 demo 行号、像素值、类名或 DOM 结构。`结论` 取 `待签`、`通过`、`不通过：<说明>` 之一；交付时写 `待签`，只有仓库所有者本人可以把它改为 `通过` 或 `不通过`，agent 不得代签。凡交付或改变用户可见功能的 issue SHALL 在同一 PR 里新增或更新对应行（结论置回 `待签`）。文件头 SHALL 写明运行方式：对着一个由调用方启动的真实服务逐项操作，不依赖截图对比。`docs/acceptance/demo-parity-checklist.md` 保留为历史记录，不再更新。

#### Scenario: 行格式可判定
- **WHEN** 读取 `docs/acceptance/functional-checklist.md`
- **THEN** 每个数据行恰有四列且 `ID` 不重复；`结论` 只取三种取值之一；全文不含 `demo:` 行号引用

#### Scenario: 交付时不代签
- **WHEN** 一个实现 PR 新增或修改清单行
- **THEN** 这些行的 `结论` 为 `待签`；PR 不把任何行改为 `通过` 或 `不通过`
