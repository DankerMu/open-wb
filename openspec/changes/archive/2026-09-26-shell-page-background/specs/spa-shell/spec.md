## ADDED Requirements

### Requirement: 外壳页面底色
已认证外壳的页面底色 SHALL 与 demo 同构：唯一来源是 `body` 的 `--wb-home-bg-secondary`（demo:195；亮色 `#ffffff`、暗色 `#141414`）。`.app-shell`、`.app-content > main` 以及 files 页的 `.files-layout`、`.files-preview`（demo 对应的 `.app-shell`/`.main-column`/`.fs-layout`/`.fs-preview`，demo:210-213、666、702）SHALL NOT 自涂底色，由 body 透出。侧栏（`--wb-sidebar-bg`）、卡片、输入、弹层、用户气泡等表面的既有 token 不变，因此暗色下主区（`#141414`）与侧栏（`#1f1f1f`）、以及主区与用户气泡（`--wb-bg-hover-light`，暗色 `#1f1f1f`，messages.css:33）和 composer 卡片（`--wb-bg-primary`，暗色 `#1f1f1f`）的明度层次与 demo 一致；登录页与认证加载页保留各自的显式底色。

#### Scenario: 暗色主区与侧栏可区分
- **WHEN** 暗色主题下打开 `/`（有会话）、`/files`、`/settings`
- **THEN** `body` 的计算底色为 `rgb(20, 20, 20)`（`#141414`），`.app-content > main` 的计算底色为透明（主区渲染为 body 色），侧栏为 `rgb(31, 31, 31)`，用户气泡与 composer 卡片（均为 `#1f1f1f`）在主区上可辨；亮色下 `body` 计算底色为 `rgb(255, 255, 255)`

#### Scenario: 外壳容器不自涂底色
- **WHEN** 读取 `web/src/styles.css` 与 `web/src/features/files/files.css`
- **THEN** `body` 的 background 为 `var(--wb-home-bg-secondary)`，`.app-shell`、`.app-content > main`、`.files-layout`、`.files-preview` 的规则体不含 background 声明
