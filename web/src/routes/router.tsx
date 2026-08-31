import { useCallback, useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useMatches,
} from "react-router";
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

type RouteHandle = {
  canonicalPath: RouteDefinition["path"];
};

type MatchedRoute = ReturnType<typeof useMatches>[number];

function hasCanonicalPath(match: MatchedRoute): match is MatchedRoute & { handle: RouteHandle } {
  const { handle } = match;
  return (
    typeof handle === "object" &&
    handle !== null &&
    "canonicalPath" in handle &&
    typeof handle.canonicalPath === "string" &&
    routeManifest.some(({ path }) => path === handle.canonicalPath)
  );
}

function useMatchedCanonicalPath(): RouteDefinition["path"] | null {
  const matches = useMatches();
  for (const match of matches) {
    if (hasCanonicalPath(match)) {
      return match.handle.canonicalPath;
    }
  }

  return null;
}

function ProviderStarted({ onStart }: { onStart: () => void }) {
  useEffect(onStart, [onStart]);
  return null;
}

function ProtectedAppShell() {
  const location = useLocation();
  const canonicalPath = useMatchedCanonicalPath();
  const [providerStarted, setProviderStarted] = useState(false);
  const startProvider = useCallback(() => setProviderStarted(true), []);
  const canonicalize =
    canonicalPath !== null && location.pathname !== canonicalPath ? (
      <Navigate
        replace
        to={{ pathname: canonicalPath, search: location.search, hash: location.hash }}
      />
    ) : null;

  if (canonicalize && !providerStarted) {
    return canonicalize;
  }

  return (
    <AuthProvider>
      <ProviderStarted onStart={startProvider} />
      {canonicalize ?? <AuthGuard>{<AppShell />}</AuthGuard>}
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

export function createAppRouter() {
  return createBrowserRouter([
    {
      Component: ProtectedAppShell,
      children: routeManifest.map(({ description, path, title }) => ({
        path,
        handle: { canonicalPath: path },
        element: <PlaceholderPage description={description} title={title} />,
      })),
    },
  ]);
}
