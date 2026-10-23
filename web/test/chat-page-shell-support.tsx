// 整页测试里与外壳相关的两件夹具：每个用例收尾的钩子，以及带续期探针的外壳挂载（顶栏按钮只在外壳里
// 才有）。页面搭法来自 chat-page-file-changes-support.tsx 与 chat-page-artifact-card-support.tsx。
import { render, screen } from "@testing-library/react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { ChatPage } from "../src/features/chat/index.js";
import { AppShell } from "../src/routes/shell/app-shell.js";
import { artifactCardFixture } from "./chat-page-artifact-card-support.js";
import { listed, quiesce, type Snapshot, WORKSPACES } from "./chat-page-file-changes-support.js";
import type { ChatAuthProbe } from "./chat-page-lifecycle-support.js";
import { SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { FakeEventSource, resetFakeEventSources, SESSION_ID } from "./chat-stream-support.js";
import {
  authenticatedPrincipal,
  centerRoutes,
  composerOptionsRoute,
  createFetchMock,
  jsonResponse,
  setBrowserPath,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const SESSION_PATH = `/?session=${SESSION_ID}`;

let disposeProbedShell: (() => void) | undefined;

/**
 * Registers the hooks of every case and returns the Blob URL stubs of the current case (see
 * `artifactCardFixture`). A Radix focus scope hands focus back in a timer, so each case lets one
 * macrotask pass before the next one starts; a probed shell's router is disposed.
 */
export function chatShellFixture() {
  const blobs = artifactCardFixture();
  afterEach(async () => {
    await yieldMacrotask();
    disposeProbedShell?.();
    disposeProbedShell = undefined;
  });
  return blobs;
}

let auth: ChatAuthProbe | undefined;

function AuthProbe() {
  const { login, principal, status } = useAuth();
  auth = { login, principal, status };
  return null;
}

/**
 * Opens `snapshot`'s session inside the real shell with an auth probe beside it, for `renewAccount`:
 * `renderChatPageWithAuthProbe` mounts the page bare, so it has no banner and no top-bar button.
 * Logging in again answers as `lisi`; both accounts read the same session, snapshot and workspaces.
 */
export async function openProbedSession(snapshot: Snapshot) {
  auth = undefined;
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    createFetchMock({
      ...composerOptionsRoute(),
      ...centerRoutes(),
      "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
      "/api/auth/login": () => jsonResponse({ id: "user-2", account: "lisi", role: "member" }),
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
    }),
  );
  setBrowserPath(SESSION_PATH);
  const shell = (
    <AuthProvider>
      <AuthProbe />
      <AuthGuard>
        <AppShell />
      </AuthGuard>
    </AuthProvider>
  );
  const router = createBrowserRouter([
    { element: shell, children: [{ path: "/", element: <ChatPage /> }] },
  ]);
  disposeProbedShell = () => router.dispose();
  render(<RouterProvider router={router} />);
  await screen.findAllByRole("article", { name: "助手" });
  await quiesce();
  return () => {
    if (!auth) throw new Error("认证探针尚未渲染");
    return auth;
  };
}
