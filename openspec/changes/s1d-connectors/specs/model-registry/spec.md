# model-registry Spec Delta

> s1d-connectors：以 `s1d-experts-skills` 对 `s1d-model-registry` 新建规格的 MODIFIED 文本为底，「中心页外壳」的 `CENTER_TABS` 改为 `experts`、`skills`、`connectors`、`models` 四项，routeManifest 描述的连接规则改为「顿号连接、末两项之间用 `与`」，完整 tab 表下为 `专家、技能与连接器`，改写「管理员与普通用户」场景（design D9）。其余逐字沿用该 MODIFIED 文本。

## MODIFIED Requirements

### Requirement: 中心页外壳
`/center` SHALL 由 `web/src/features/center/` 渲染：页内 tab 由查询参数 `?tab=<key>` 表示，tab 表 `CENTER_TABS: readonly {key, label, adminOnly}[]` 在 `tabs.ts`，依次为 `{key:"experts", label:"专家", adminOnly:false}`、`{key:"skills", label:"技能", adminOnly:false}`、`{key:"connectors", label:"连接器", adminOnly:false}`、`{key:"models", label:"模型", adminOnly:true}`（`专家`、`技能` 与 `连接器` 三项见 experts「中心「专家」tab」、skill-switches「中心「技能」tab」与 connectors「中心「连接器」tab」）；可见 tab 为 `adminOnly` 为假或当前 principal 角色为 `管理员` 的项。`tab` 缺省、未知或指向不可见 tab 时 SHALL 以 replace 导航到第一个可见 tab；没有可见 tab 时 SHALL 渲染空态文案 `中心暂无可用内容` 且不渲染 tab 条（按上面的 tab 表不会发生：`专家`、`技能` 与 `连接器` 对所有人可见；规则保留）。tab 条用拷入层 tabs 组件（`role="tablist"`，当前项 `aria-selected="true"`，切换只改 `?tab=`）。页面级 heading 仍归顶栏（spa-shell）。routeManifest 的 `/center` 描述 SHALL 与可见内容一致：按 tab 表次序连接对所有人可见（`adminOnly` 为假）的 tab 的 label——相邻两项之间用顿号 `、`，只有最后两项之间改用 `与`（只有一项时即该 label），仅管理员可见的 tab 不进描述（`模型` tab 只对管理员可见，描述不对普通用户宣传它）——tab 表只有 `专家` 与 `模型` 时为 `专家`，只有 `专家`、`技能` 与 `模型` 时为 `专家与技能`，上面的完整 tab 表下为 `专家、技能与连接器`；不宣传未交付能力。

#### Scenario: 管理员与普通用户
- **WHEN** 管理员打开 `/center`；再打开 `/center?tab=nope`；再打开 `/center?tab=models`；普通用户打开 `/center?tab=models`；普通用户打开 `/center`
- **THEN** 管理员前两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条依次恰为 `专家`、`技能`、`连接器`、`模型` 四项且 `专家` 选中；第三次 URL 保持 `/center?tab=models`、`模型` 选中；普通用户两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条恰为 `专家`、`技能`、`连接器` 三项（没有 `模型`）且 `专家` 选中，页面不出现 `中心暂无可用内容`；routeManifest 的 `/center` 描述为 `专家、技能与连接器`
