# Tasks

Fixture level: lite。Must preserve：键盘、输入法、点击、Tab、拉取时机与 `Esc` 关闭的既有行为；目录变短时回到首项的既有兜底。

- [x] 1. 工作空间 id 变化时把高亮重置到第一项，不清除 `Esc` 的关闭状态。
- [x] 2. 用例：新场景的两例（先红后绿）；负向对照——去掉重置则第一例变红，重置时一并清除关闭状态则第二例变红。
- [x] 3. 门禁：lint、typecheck、anti-drift（jscpd 不增长）、size-guard、`npm test --workspace web`。
