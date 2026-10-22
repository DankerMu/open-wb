import { Navigate, useLocation, useNavigate } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/index";
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
 * `/center`：页内 tab 由 `?tab=<key>` 表示。`tab` 缺省、未知或不可见 → replace 到第一个可见 tab；
 * 没有可见 tab → 空态且不改地址。页面级 heading 归顶栏。
 */
export function CenterPage({ tabs = CENTER_TABS }: { tabs?: readonly CenterTab[] }) {
  const { principal } = useAuth();
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  const admin = principal !== null && isAdmin(principal);
  const visible = tabs.filter((tab) => admin || !tab.adminOnly);
  const first = visible[0];

  if (!first) {
    return (
      <section className="ui-empty">
        <p>{EMPTY_TEXT}</p>
      </section>
    );
  }

  const requested = new URLSearchParams(search).get("tab");
  const current = visible.find((tab) => tab.key === requested);
  if (!current) {
    return <Navigate replace to={tabLocation(pathname, search, hash, first.key)} />;
  }

  return (
    <div className="overflow-auto px-7 pt-6 pb-10 narrow:px-4">
      <Tabs
        onValueChange={(key) => navigate(tabLocation(pathname, search, hash, key))}
        value={current.key}
      >
        <TabsList>
          {visible.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={current.key}>
          <current.Panel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
