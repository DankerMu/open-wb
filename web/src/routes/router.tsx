import { createBrowserRouter, NavLink, Outlet, replace } from "react-router";
import { AuthGuard, AuthProvider } from "../features/auth/index.js";

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

function ProtectedAppShell() {
  return (
    <AuthProvider>
      <AuthGuard>
        <AppShell />
      </AuthGuard>
    </AuthProvider>
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

function canonicalizeRoutePath(request: Request, path: RouteDefinition["path"]) {
  const { pathname, search } = new URL(request.url);

  if (pathname !== path) {
    return replace(`${path}${search}`);
  }
}

export function createAppRouter() {
  return createBrowserRouter([
    {
      Component: ProtectedAppShell,
      children: routeManifest.map(({ description, path, title }) => ({
        path,
        loader: ({ request }) => canonicalizeRoutePath(request, path),
        element: <PlaceholderPage description={description} title={title} />,
      })),
    },
  ]);
}
