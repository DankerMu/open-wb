import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { RouterProvider } from "react-router";
import { vi } from "vitest";
import { createAppRouter } from "../src/routes/index.js";
import "./dialog-platform.js";
import { type FetchMock, setBrowserPath } from "./support.js";

export function mountAuthenticatedApp(path: string, fetchMock: FetchMock, strict = false) {
  setBrowserPath(path);
  vi.stubGlobal("fetch", fetchMock);
  const appRouter = createAppRouter();
  const application = <RouterProvider router={appRouter} />;
  const view = render(strict ? <StrictMode>{application}</StrictMode> : application);
  return { fetchMock, router: appRouter, view };
}
