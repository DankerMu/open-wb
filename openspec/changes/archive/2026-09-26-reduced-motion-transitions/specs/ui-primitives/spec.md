## ADDED Requirements

### Requirement: 全局 reduced-motion 规则
`web/src/styles.css` 的全局 `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }` 块 SHALL 只声明 `animation-duration`、`animation-iteration-count` 与 `scroll-behavior`，SHALL NOT 声明任何 `transition` 或 `transition-*` 属性。原因：`transition-property` 初值为 `all`，只设时长会给所有元素隐式新建过渡；首帧（亮色）之后切换主题时，继承色文字会在若干帧内保持旧主题颜色（#423）。组件自己声明的过渡 SHALL 由各自 CSS 文件内的 reduce 块置为 `transition: none`：`web/src/**/*.css` 中每条在普通规则里声明非 `none` 的 `transition` 或 `transition-*` 的规则，其每个选择器都 SHALL 在同一文件中、源码顺序位于该规则之后的顶层 reduce 块内有同选择器（分组选择器按逗号拆分）的 `transition: none` 覆盖；只有覆盖、没有声明的 reduce 规则允许存在。`animation-*` 与各组件既有的 reduced-motion 行为保持不变。

#### Scenario: reduce 下切换主题，继承色立即生效
- **WHEN** `make ui-walk` 两个 project 在 `/settings` 的主题步骤中先 `emulateMedia({reducedMotion:"reduce"})`，再在同一次 `page.evaluate` 内确认 `matchMedia("(prefers-reduced-motion: reduce)").matches` 为 true、`data-theme` 不等于目标主题，然后点击目标主题 radio，并立即读取 `.settings-sec-h`（2 个）、`.settings-row-title`（3 个）以及 `desktop-light` 的 `.sidebar-link`（至少 1 个）的计算 `color` 与 `getAnimations()`
- **THEN** 点击后 `data-theme` 等于目标主题；继承色元素的 `color` 等于目标主题的 `--wb-text-primary`（`desktop-light` 切到深色为 `rgb(255, 255, 255)`，`mobile-dark` 切到浅色为 `rgb(0, 0, 0)`）；所读元素的 `getAnimations().length` 均为 0；随后恢复 `no-preference`，既有持久化断言仍成立

#### Scenario: 全局块不新建过渡、组件过渡各有在后的覆盖
- **WHEN** 静态读取 `web/src/styles.css` 与 `web/src/**/*.css`（去注释后按顶层块遍历），并对注入样本执行同一判定
- **THEN** 全局 `*` reduce 块不含 `transition` 前缀的声明，但仍含 `animation-duration`、`animation-iteration-count`、`scroll-behavior`；仓库内声明非 `none` 过渡的规则集合非空，且每条的每个选择器都在其文件中源码顺序靠后的顶层 reduce 块内有 `transition: none`；除 reduce 块外的 `@` 块内出现 `transition` 声明即判失败；注入样本"缺覆盖"与"覆盖位于声明之前"判失败，"分组选择器覆盖位于声明之后"判通过
