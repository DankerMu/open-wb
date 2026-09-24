import { useCallback, useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useMatches,
} from "react-router";
import { AuthFooter, AuthGuard, AuthProvider } from "../features/auth/index.js";
import { ChatPage } from "../features/chat/index.js";
import { FilesPage } from "../features/files/index.js";
import { SettingsPage } from "../features/settings/index.js";
import { ThemeProvider } from "../features/theme/index.js";

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
    description: "会话列表、消息与输入",
  },
  {
    path: "/files",
    label: "工作空间",
    subtitle: "文件·预览",
    title: "工作空间",
    description: "浏览、预览与管理工作空间文件",
  },
  {
    path: "/center",
    label: "中心",
    title: "中心",
    description: "中心暂不可用",
  },
  {
    path: "/settings",
    label: "设置",
    title: "设置",
    description: "主题与服务信息",
  },
];

function AppShell() {
  return (
    <div className="app-shell">
      <aside aria-label="侧栏" className="sidebar">
        <div className="sidebar-brand">
          <span aria-hidden="true" className="brand-mark" />
          <span className="sidebar-brand-name">WorkBuddy</span>
        </div>
        <nav aria-label="主导航">
          <ul>
            {routeManifest.map(({ label, path, subtitle }) => (
              <li key={path}>
                <NavLink
                  className={({ isActive }) =>
                    isActive ? "sidebar-link is-active" : "sidebar-link"
                  }
                  end
                  to={path}
                >
                  <span className="sidebar-link-copy">
                    <span>{label}</span>
                    {subtitle ? <span className="sidebar-link-sub">{subtitle}</span> : null}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <AuthFooter />
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

  return (
    <ThemeProvider>
      {canonicalize && !providerStarted ? (
        canonicalize
      ) : (
        <AuthProvider>
          <ProviderStarted onStart={startProvider} />
          {canonicalize ?? <AuthGuard>{<AppShell />}</AuthGuard>}
        </AuthProvider>
      )}
    </ThemeProvider>
  );
}

function PlaceholderPage({ description, title }: Pick<RouteDefinition, "description" | "title">) {
  return (
    <section className="ui-empty">
      <h1 className="ui-page-heading">{title}</h1>
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
        element:
          path === "/settings" ? (
            <SettingsPage />
          ) : path === "/files" ? (
            <FilesPage />
          ) : path === "/" ? (
            <ChatPage />
          ) : (
            <PlaceholderPage description={description} title={title} />
          ),
      })),
    },
  ]);
}
