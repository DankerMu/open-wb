## MODIFIED Requirements

### Requirement: 组件分层
web SHALL 采用两层加一个冻结区：`web/src/components/ui/`（由 shadcn/ui registry 拷入的组件，Radix 版式）与 `web/src/components/assistant-ui/`（由 assistant-ui registry 拷入的组件）是**拷入层**；`web/src` 下除拷入层与 `web/src/ui/` 之外的全部 `.ts`/`.tsx`（features、routes、lib、入口）是**应用层**；`web/src/ui/` 是迁移期间的**冻结区**。`web/components.json` SHALL 入库并记录 registry 配置（Radix 版式 style、别名指向 `@/components`、`@/components/ui`、`@/lib/utils`）。`radix-ui` 与 `@radix-ui/*` 只能在拷入层与冻结区中导入；`lucide-react` 可在拷入层与应用层直接导入。自 s1f-chat-surface 起 `web/src/components/assistant-ui/` 含 assistant-ui registry 的 `thread`、`markdown-text`、`tool-fallback`、`tool-group`、`reasoning`（它们依赖的 shadcn/ui 组件拷入 `web/src/components/ui/`），与 shadcn/ui 组件适用同一组修改限制；会话页的应用层组件（`web/src/features/chat/` 内）组合它们。拷入后的组件只允许六类修改：把颜色字面量换成主题变量、中文化可见文案与 aria 文案、按 Biome 格式化、把 `cn` 的导入归一到 `@/lib/utils`（不引入 npm 包 `cn`）、为本仓严格 TS 选项做纯类型适配（不改运行时行为）、让组件渲染被 registry 原文丢弃的调用方 `children`（只增不改）。冻结区 SHALL 不新增文件，其文件名集合 SHALL 是守卫测试内所列清单（本 change 开始时的 32 个文件）的子集；唯一允许的内容变更是在 `index.ts` 增加 `useEscapeFallback` 的导出。**已迁移区域**由守卫测试内的一份清单定义，条目按路径前缀匹配，可以是目录或单个文件，清单内容被守卫硬断言（s1f-ui-foundation 结束时为 `web/src/routes/**`、`web/src/features/auth/**`、`web/src/features/settings/**`、`web/src/features/theme/**`）：清单内的文件从 `web/src/ui` 只可导入 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`，且清单内的目录下不存在 `.css` 文件。会话页按文件逐个登记：`web/src/features/chat/` 下的一个文件不再从 `web/src/ui` 导入上述四项之外的名字、且不依赖旧类名时，SHALL 在同一个改动里把它的路径加进清单并更新守卫的清单断言；目录 `web/src/features/chat` 本身 SHALL NOT 登记，只要会话列表的文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx`）仍是旧实现；未登记的文件导入 `web/src/ui` 仍然合法。导入白名单不变，因此已登记的文件 MUST NOT 导入 `useToast`（会话页的轻提示退场由这份清单机械保证）。

#### Scenario: 应用层不直接引 Radix
- **WHEN** 扫描 `web/src` 下除 `components/ui`、`components/assistant-ui` 与 `ui` 之外的全部 `.ts`/`.tsx`
- **THEN** 没有文件静态或动态导入 `radix-ui` 或 `@radix-ui/*`

#### Scenario: 已迁移区域不回用旧基元，冻结区不增长
- **WHEN** 扫描守卫清单内的目录与文件，并列出 `web/src/ui` 的文件
- **THEN** 清单内的文件（含逐个登记的会话页文件）从 `web/src/ui` 的导入只出现 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`；清单内的目录下没有 `.css` 文件；清单不含目录 `web/src/features/chat` 本身；`web/src/ui` 的每个文件名都在守卫的冻结清单里；对注入样本（清单内文件导入 `Button`、清单内文件导入 `useToast`、清单内出现 `.css`、冻结区多出一个文件）守卫各判失败
