# model-registry Spec Delta

> s1d-experts-skills：以 `s1d-model-registry` 新建的规格为底（该 change 先归档），「中心页外壳」的 `CENTER_TABS` 改为 `experts`、`skills`、`models` 三项，routeManifest 描述改为 `专家与技能`，「管理员与普通用户」场景改为普通用户落到 `专家` tab（design D10）；空态规则文字保留。「模型 tab」没有普通用户空态的场景，不改。其余逐字沿用该规格。

## MODIFIED Requirements

### Requirement: 中心页外壳
`/center` SHALL 由 `web/src/features/center/` 渲染：页内 tab 由查询参数 `?tab=<key>` 表示，tab 表 `CENTER_TABS: readonly {key, label, adminOnly}[]` 在 `tabs.ts`，依次为 `{key:"experts", label:"专家", adminOnly:false}`、`{key:"skills", label:"技能", adminOnly:false}`、`{key:"models", label:"模型", adminOnly:true}`（`专家` 与 `技能` 两项见 experts「中心「专家」tab」与 skill-switches「中心「技能」tab」）；可见 tab 为 `adminOnly` 为假或当前 principal 角色为 `管理员` 的项。`tab` 缺省、未知或指向不可见 tab 时 SHALL 以 replace 导航到第一个可见 tab；没有可见 tab 时 SHALL 渲染空态文案 `中心暂无可用内容` 且不渲染 tab 条（按上面的 tab 表不会发生：`专家` 与 `技能` 对所有人可见；规则保留）。tab 条用拷入层 tabs 组件（`role="tablist"`，当前项 `aria-selected="true"`，切换只改 `?tab=`）。页面级 heading 仍归顶栏（spa-shell）。routeManifest 的 `/center` 描述 SHALL 与可见内容一致：为 `专家与技能`（`模型` tab 只对管理员可见，描述不对普通用户宣传它），不宣传未交付能力。

#### Scenario: 管理员与普通用户
- **WHEN** 管理员打开 `/center`；再打开 `/center?tab=nope`；再打开 `/center?tab=models`；普通用户打开 `/center?tab=models`；普通用户打开 `/center`
- **THEN** 管理员前两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条依次恰为 `专家`、`技能`、`模型` 三项且 `专家` 选中；第三次 URL 保持 `/center?tab=models`、`模型` 选中；普通用户两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条恰为 `专家`、`技能` 两项（没有 `模型`）且 `专家` 选中，页面不出现 `中心暂无可用内容`；routeManifest 的 `/center` 描述为 `专家与技能`
