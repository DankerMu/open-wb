import { createBrowserRouter, NavLink, Outlet } from "react-router";

type RouteDefinition = {
  path: "/" | "/files" | "/center" | "/settings";
  label: string;
  subtitle?: string;
  title: string;
  description: string;
};

export const routeManifest: readonly RouteDefinition[] = [
  {
    path: "/",
    label: "会话",
    title: "会话",
    description: "S0b 将接入会话与 Agent 链路",
  },
  {
    path: "/files",
    label: "工作空间",
    subtitle: "文件·预览·挂载",
    title: "工作空间",
    description: "S1a 将接入工作空间与文件",
  },
  {
    path: "/center",
    label: "中心",
    subtitle: "专家·技能·知识库·模型·权限",
    title: "中心",
    description: "S1d 将接入专家、技能、连接器、知识库、模型与权限",
  },
  {
    path: "/settings",
    label: "设置",
    title: "设置",
    description: "S0a 后续任务将接入外观与关于设置",
  },
];

function AppShell() {
  return (
    <div>
      <aside aria-label="侧栏">
        <nav aria-label="主导航">
          <ul>
            {routeManifest.map(({ label, path, subtitle }) => (
              <li key={path}>
                <NavLink end to={path}>
                  <span>{label}</span>
                  {subtitle ? <span>{subtitle}</span> : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function PlaceholderPage({ description, title }: Pick<RouteDefinition, "description" | "title">) {
  return (
    <section>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

export function createAppRouter() {
  return createBrowserRouter([
    {
      Component: AppShell,
      children: routeManifest.map(({ description, path, title }) => ({
        path,
        element: <PlaceholderPage description={description} title={title} />,
      })),
    },
  ]);
}
