## ADDED Requirements

### Requirement: 步骤卡原始输出不做路径改写
按 ADR-0011，步骤卡 `原始输出` 内的完整原始 detail SHALL 原样展示其中出现的绝对沙箱路径，不做前缀替换、隐藏或其它改写；摘要行派生、120 码点截断与折叠默认状态不受影响。files 页、外壳、标题与 aria 属性不渲染 workspace `root` 的呈现规则不因此放宽。

#### Scenario: 含沙箱路径的 detail 原样出现在原始输出
- **WHEN** 会话页渲染一张 detail 为 `{"path":"<SANDBOX_ROOT>/<ownerId>/<dir>/a.md"}` 形态的 done 步骤
- **THEN** 该卡 `原始输出` 的 `<details>` 内文本包含该绝对路径原文，摘要行为 `path: <该路径>`
