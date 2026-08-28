# Docs 模式（领域增强 + 沉淀）

`grill-me` 的可选模式。触发词："grill with docs"、"对着领域模型压测"、"对齐术语"，或压测中发现领域概念多、术语易漂、决策需跨变更追溯时主动升级。默认模式只对话不写文档；本模式在压测的同时统一项目语言、沉淀长期资产。

## 追加铁律（在核心铁律之上）

7. **术语对齐**：对话中浮现的概念，收敛成项目唯一 canonical term。
8. **inline 沉淀**：术语一旦解决就立即写入 `openspec/glossary.md`，不要攒到最后。
9. **ADR 稀疏**：只有"难回退 + 无背景会困惑 + 真实权衡"三条全真，才提议落 ADR。

## 压测时多做的四件事

1. **对照 glossary 挑刺**：用户用词与 `openspec/glossary.md` 已有定义冲突时，立即指出（"glossary 里 'cancellation' 指 X，你这里像是 Y——到底哪个？"）。
2. **收敛模糊语言**：overloaded/含糊术语当场逼成精确 canonical term（"你说的 'account' 是 Customer 还是 User？这是两个东西"）。
3. **具体场景探边界**：发明能触发 edge case 的具体场景，迫使用户说清概念之间的边界。
4. **代码交叉核对**：用户的说法与代码不一致时，引用具体文件/行指出。

## 沉淀落点（本仓库约定，与上游不同）

上游用 `CONTEXT.md` + `docs/adr/`。本仓库改写为：

### 术语表 → `openspec/glossary.md`

项目级 ubiquitous language 的**单一来源**。格式见 [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md)。

- **只放本项目特有术语**，不放通用编程概念（timeout、error type 等）。
- **只做术语定义**，不混实现细节，不当 spec / scratchpad / 决策仓库——那些是 OpenSpec `specs/`、`design.md` 的职责。
- 单 context：`openspec/glossary.md` 一个 `## Language` 段。多 context：同一文件内用 `## Context Map` + 每个 context 一个二级标题，**不分散成多文件**，贴合 OpenSpec 单目录与本仓库的熵治理。
- 与 `openspec/project-profile.md` 的关系：profile 保持 lean，**只引用** glossary，不把术语堆进 profile。
- **懒创建**：第一个术语被解决时才创建 `openspec/glossary.md`。

### 长期决策 → `docs/adr/NNNN-slug.md`

跨变更累积的决策账本。格式与三门槛见 [ADR-FORMAT.md](./ADR-FORMAT.md)。

- **与 OpenSpec `design.md` 的分工**：`design.md` 记**某次 change 的**技术决策，随 change 归档；ADR 记**项目级、跨 change 长期有效**的决策。若某决策已在 `design.md` 充分说明且只作用于该 change，不必再开 ADR。
- 三门槛全真才提议；**懒创建** `docs/adr/`，编号连续递增。

## 流程差异

流程与默认模式一致，仅第 1 步和第 5-6 步不同：

- **锚定靶子**时额外读 `openspec/glossary.md`、`docs/adr/` 建立术语基线。
- **逐分支追问**中执行上面"四件事"；术语一解决就写 glossary，够三门槛的决策当场落 ADR。
- **收敛输出**的小结额外附**本轮新增/修订的 glossary 术语与 ADR 列表**。嵌入 `stage-change-pipeline` Stage 2 时，该小结是 `design.md`/`specs/` 定稿与 Stage 3 审核的输入；用户确认前不进入定稿。

---

改编自 [`mattpocock/skills`](https://github.com/mattpocock/skills) 的 `grill-with-docs`（中文参考 [`vinvcn/mattpocock-skills-zh-CN`](https://github.com/vinvcn/mattpocock-skills-zh-CN)）。沉淀落点由上游的 `CONTEXT.md`/`docs/adr/` 本地化为 `openspec/glossary.md`/`docs/adr/`，保留原作的 ADR 三门槛纪律。
