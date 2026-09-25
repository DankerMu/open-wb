import { useCallback, useEffect, useState } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, useMatches } from "react-router";
import { AuthGuard, AuthProvider } from "../features/auth/index.js";
import { ChatPage } from "../features/chat/index.js";
import { FilesPage } from "../features/files/index.js";
import { SettingsPage } from "../features/settings/index.js";
import { ThemeProvider } from "../features/theme/index.js";
import { type RouteDefinition, routeManifest } from "./manifest.js";
import { Sidebar, useSidebarCollapsed } from "./shell/sidebar.js";

function AppShell() {
  const [collapsed, toggle] = useSidebarCollapsed();
  return (
    <div className="app-shell">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
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
