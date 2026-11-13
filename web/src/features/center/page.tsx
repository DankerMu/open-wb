import { useMemo } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/index";
import { useKbEnabled } from "@/lib/kb-status";
import { isAdmin } from "@/lib/roles";
import { CENTER_TABS, type CenterTab } from "./tabs.js";

const EMPTY_TEXT = "中心暂无可用内容";

/** 只改 `tab` 参数的目标地址：其它查询参数（含次序）与页内锚点原样保留。 */
function tabLocation(pathname: string, search: string, hash: string, key: string) {
  const parameters = new URLSearchParams(search);
  parameters.set("tab", key);
  return { hash, pathname, search: `?${parameters}` };
}

/**
 * `/center`：页内 tab 由 `?tab=<key>` 表示。可见 tab 为角色允许的项，带 `requiresKb` 的另须知识库开启。`tab` 缺省、
 * 未知或不可见 → replace 到第一个可见 tab；没有可见 tab → 空态且不改地址。知识库状态在途时，指向带 `requiresKb`
 * 的 tab 的地址不改、只渲染 tab 条，读到之后再按规则重算。页面级 heading 归顶栏。
 */
export function CenterPage({ tabs = CENTER_TABS }: { tabs?: readonly CenterTab[] }) {
  const { createSessionClient, principal } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  const kbEnabled = useKbEnabled(client);
  const admin = principal !== null && isAdmin(principal);
  const permitted = tabs.filter((tab) => admin || !tab.adminOnly);
  const visible = permitted.filter((tab) => !tab.requiresKb || kbEnabled === true);
  const requested = new URLSearchParams(search).get("tab");
  const current = visible.find((tab) => tab.key === requested);
  const waiting =
    kbEnabled === null && permitted.some((tab) => tab.requiresKb && tab.key === requested);
  const first = visible[0];

  if (!current && !waiting) {
    if (!first) {
      return (
        <section className="ui-empty">
          <p>{EMPTY_TEXT}</p>
        </section>
      );
    }
    return <Navigate replace to={tabLocation(pathname, search, hash, first.key)} />;
  }

  return (
    <div className="overflow-auto px-7 pt-6 pb-10 narrow:px-4">
      <Tabs
        onValueChange={(key) => navigate(tabLocation(pathname, search, hash, key))}
        value={current?.key ?? requested ?? ""}
      >
        <TabsList>
          {visible.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {current ? (
          <TabsContent value={current.key}>
            <current.Panel />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
